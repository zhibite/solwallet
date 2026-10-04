/**
 * 单笔跟单收益计算引擎
 *
 * 回答的问题是：**我照着这一笔买入做，能赚多少。**
 *
 * 算法：
 *   1) 按链上顺序（不是时间戳）取出这笔买入之后的交易
 *   2) 把每一笔分类成「买进本 mint」/「卖出本 mint」，失败的直接丢掉
 *   3) 用 FIFO 队列把卖出的 token 数量配回到买入上
 *   4) 只统计配到本笔买入身上的那部分收入和成本
 *
 * 为什么必须按 token 数量配对：
 *   一个地址经常对同一个币做多轮买卖（波段机器人）。老实现只认一笔买入，
 *   却把这个地址对该 mint 的全部卖出收入都算进这一笔，遇到多轮就会虚高
 *   几个数量级 —— 实测某波段机器人 3 轮往返，老实现算出 +1.2455 SOL，
 *   真实总盈亏只有 +0.0235 SOL。
 *
 * 关键约定：
 *   - 「之后」用 getSignaturesForAddress 返回顺序判定（newest-first，取买入那笔之前的那段），
 *     不用 blockTime 比较：同一秒内的多笔交易在时间戳上无法区分先后，
 *     按时间过滤会把买入之前就已经发生的卖出算成这一笔的收益。
 *   - 失败判定只看 Helius 的 transactionError。老实现看的是 tx.err，
 *     那是 getSignaturesForAddress 的字段，在 parseTransaction 的返回里恒为 undefined，
 *     等于所有失败交易都被当成了成功卖出 —— 而 Helius 对失败交易仍会返回
 *     根本没执行的转账（实测失败的买入带着一条 0.508 SOL 的 phantom 转出），
 *     这些幻影数字会直接污染盈亏。
 *   - 买入手续费用这笔交易真实的 fee（base + priority），
 *     不再写死 5000 lamports；卖出侧本来扣的就是完整 fee，两边口径一致。
 *   - 还没卖完时 pnlSol 是「已实现部分」的收益，同时给 soldRatio；
 *     一个 token 都没卖时 pnlSol 为 null（持仓中），和真实的 0 区分开。
 */

import { query } from './db';
import { getHelius } from './helius';
import { isAkbotTx } from './akbot';
import { markAsAkbot } from './pool';
import { inboundTokenAmount, outboundTokenAmount } from './parser';
import type { HeliusEnhancedTx } from './types';

const SIG_PAGE_SIZE = 1000;     // Helius 单次签名拉取上限
const MAX_SIG_PAGES = 20;       // 最多 20k 签名，防止活跃钱包拖死请求
/** token 数量配对容差：1e-3 个原始单位（pump.fun 是 6 位小数，即 1e-9 个 token） */
const TOKEN_EPSILON = 1e-3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type CopyPnlStatus =
  /** 本笔买入的 token 已全部卖出，收益已实现 */
  | 'closed'
  /** 卖出了一部分，已实现部分 + 剩余持仓 */
  | 'partial'
  /** 一笔都没卖，token 还在手上，收益未实现 */
  | 'open'
  /** 买入交易本身失败，成本就是手续费 */
  | 'buy_failed';

export interface TradePnL {
  signature: string;
  blockTime: number;
  mint: string;
  wallet: string;
  side: 'buy' | 'sell';
  solAmount: number;
  tokenAmount: number | null;
  feeSol: number;
  pnlSol: number | null;
}

export interface CopyPnlResult {
  status: CopyPnlStatus;
  /** 已实现收益；status='open' 时为 null（还没卖，不能算） */
  pnlSol: number | null;
  /** 本笔买入花的 SOL（含 tip 等所有流出，不含 fee） */
  costSol: number;
  /** 买入交易手续费 */
  buyFeeSol: number;
  /** 配到本笔身上的卖出净收入合计 */
  proceedsSol: number;
  /** 配到的卖出交易手续费合计 */
  sellFeeSol: number;
  /** 本笔买入的 token 数量 */
  buyTokenAmount: number;
  /** 其中被卖出的 token 数量 */
  soldTokenAmount: number;
  /** 0~1 */
  soldRatio: number;
  /** 本笔买入收到的 token 里，现在还持有多少 */
  remainingTokenAmount: number;
  /** 本笔买入之后、到本笔 token 卖完为止，额外插入的买入笔数（同一地址的后续加仓） */
  laterBuys: number;
  /** 窗口内失败交易的手续费（跟单者会一并承担，不计入 pnlSol，仅作提示） */
  failedFeeSol: number;
  /** 链路上的每一笔交易，供排查 */
  trades: TradePnL[];
}

/**
 * Helius 增强 API 的失败标记。tx.err 是 getSignaturesForAddress 的字段，在这儿恒为 undefined。
 *
 * 注意 null 的语义：**null 是「没解析出来」（限流 / 网络问题），不是「交易失败」**。
 * 把两者混同会把限流的结果当成买入失败写进库，比算错收益更难发现。
 */
export function isFailedTx(tx: HeliusEnhancedTx | null | undefined): boolean {
  if (!tx) return false;
  if (tx.transactionError) return true;
  return !!(tx.events?.swap?.error);
}

/**
 * 分页拉取 address 的签名，返回**按链上顺序从旧到新**排好的数组。
 *
 * getSignaturesForAddress 是 newest-first 且按 (slot, block 内位置) 排序，
 * 比 blockTime 精确：同一秒里的多笔交易依然有确定先后。翻页用 before 往更老的走。
 */
async function fetchSigsOldestFirst(address: string): Promise<any[]> {
  const helius = getHelius();
  const collected: any[] = [];   // newest-first，最后 reverse
  let before: string | undefined;

  for (let i = 0; i < MAX_SIG_PAGES; i++) {
    const batch = await helius.getSignaturesForAddress(address, {
      limit: SIG_PAGE_SIZE,
      before,
    });
    if (!batch || batch.length === 0) break;
    collected.push(...batch);
    if (batch.length < SIG_PAGE_SIZE) break;
    before = batch[batch.length - 1].signature;
  }

  return collected.reverse();
}

/**
 * 解析签名列表，返回与输入**同序**的结果。
 *
 * 必须按签名对齐，不能按下标对齐：Helius 增强 API 返回的是按时间倒序的，
 * 不是按请求顺序。之前按下标对齐，等于把整条链路的时间顺序反了过来 ——
 * FIFO 会先吃到最晚的那笔卖出，收益直接算错。
 *
 * 429 是常态（一次要解析上千笔），所以整批退避重试。
 * 重试仍失败的那批留 null，交给调用方区分「解析不出来」和「交易失败」。
 */
async function parseAll(sigs: string[]): Promise<(HeliusEnhancedTx | null)[]> {
  const helius = getHelius();
  const out: (HeliusEnhancedTx | null)[] = [];

  for (let i = 0; i < sigs.length; i += 100) {
    const chunkSigs = sigs.slice(i, i + 100);
    let bySig: Map<string, HeliusEnhancedTx> | null = null;

    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const chunk = await helius.parseTransactions(chunkSigs);
        bySig = new Map(chunk.map((c) => [c?.signature, c]));
        break;
      } catch (err: any) {
        const status = err?.response?.status ?? err?.status;
        if (status !== 429 && attempt >= 1) throw err;
        if (status !== 429 && attempt === 0) continue;
        await sleep(800 * (attempt + 1));
      }
    }

    for (const s of chunkSigs) out.push(bySig?.get(s) ?? null);
  }

  return out;
}

/** 本人在这笔交易里的账户列表：正常情况只有 feePayer，relayer 代付时再加上钱包本身 */
function ownersOf(tx: HeliusEnhancedTx, wallet: string): string[] {
  return tx.feePayer === wallet ? [tx.feePayer] : [tx.feePayer, wallet];
}

/** 本人在这笔交易里的 SOL 净流入；out 已包含 tip 等各类支出 */
function netSolIn(tx: HeliusEnhancedTx, wallet: string): number {
  const owners = ownersOf(tx, wallet);
  let solIn = 0;
  let solOut = 0;
  for (const t of tx.nativeTransfers ?? []) {
    if (t.fromUserAccount === t.toUserAccount) continue; // 自转不算
    if (owners.includes(t.toUserAccount)) solIn += Number(t.amount);
    if (owners.includes(t.fromUserAccount)) solOut += Number(t.amount);
  }
  return solIn / 1e9 - solOut / 1e9;
}

/** 本人在这笔交易里的 SOL 总流出（买入成本，含 tip） */
function solOutTotal(tx: HeliusEnhancedTx, wallet: string): number {
  const owners = ownersOf(tx, wallet);
  let sum = 0;
  for (const t of tx.nativeTransfers ?? []) {
    if (owners.includes(t.fromUserAccount)) sum += Number(t.amount);
  }
  return sum / 1e9;
}

/**
 * 算某一笔买入的「单笔跟单收益」。
 *
 * @param buyTokenAmount 这笔买入收到的 token 数量。没有它就无法按数量配对，
 *                        此时会退化成按签名顺序把后续卖出都算给这一笔（旧行为）。
 */
export async function calcCopyPnl(opts: {
  mint: string;
  buySig: string;
  buyWallet: string;
  buySol: number;
  buyBlockTime: number;
  /** 这笔买入收到的 token 数量，强烈建议传 */
  buyTokenAmount?: number | null;
  /** 这笔买入交易自身的 fee（lamports，含 base + priority） */
  buyFeeLamports?: number | null;
}): Promise<CopyPnlResult> {
  const helius = getHelius();
  const mint = opts.mint;
  const wallet = opts.buyWallet;

  const sigs = await fetchSigsOldestFirst(wallet);
  const buyIdx = sigs.findIndex((s) => s.signature === opts.buySig);
  if (buyIdx < 0) {
    // 翻页上限之内没覆盖到这笔买入（钱包交易太密集），只能给「持仓中」
    return emptyResult('open', opts);
  }

  // 从买入那一笔开始（含它自身）往后走：买入自己也要解析，
  // 才知道它到底成没成、真实 fee 是多少。之后才是用来跟本笔配对的卖出 / 加仓。
  //
  // 注意是「边走边解析」而不是一次性全解析：活跃钱包签名能上万笔，
  // 全解析就是上百次请求，必然撞 Helius 限流。而本笔的 token 一旦被卖光，
  // 后面发生什么已经不影响这一笔的收益，可以立刻收工。
  const fromBuyOnward = sigs.slice(buyIdx);
  const [buyTx] = await parseAll(fromBuyOnward.slice(0, 1).map((s) => s.signature));

  // --- 买入本身 ---
  const buyFee = opts.buyFeeLamports != null ? opts.buyFeeLamports / 1e9 : (buyTx?.fee ?? 0) / 1e9;
  const buyTokenAmount =
    opts.buyTokenAmount != null && opts.buyTokenAmount > 0
      ? opts.buyTokenAmount
      : (buyTx ? inboundTokenAmount(buyTx, mint) : 0);
  const buyCost = opts.buySol;

  const trades: TradePnL[] = [
    {
      signature: opts.buySig,
      blockTime: opts.buyBlockTime,
      mint,
      wallet,
      side: 'buy',
      solAmount: buyCost,
      tokenAmount: buyTokenAmount > 0 ? buyTokenAmount : null,
      feeSol: buyFee,
      pnlSol: null,
    },
  ];

  // 买入交易本身没解析出来（限流 / 网络）→ 无法判断成败，必须报错而不是编一个状态。
  // 编成 buy_failed 会把一次网络抖动永久写进库。
  if (buyTx === null) {
    throw new Error('买入交易解析失败（Helius 限流或网络问题），未写入结果，请稍后重试');
  }
  if (buyTx.signature !== opts.buySig) {
    throw new Error(`解析结果对不上：期望 ${opts.buySig.slice(0, 12)}，拿到 ${buyTx.signature.slice(0, 12)}`);
  }

  // 买入交易失败 → 没有 token，成本只有手续费
  if (isFailedTx(buyTx)) {
    return {
      ...emptyResult('buy_failed', opts),
      trades,
      costSol: 0,
      buyFeeSol: buyFee,
      pnlSol: -buyFee,
      failedFeeSol: 0,
    };
  }

  if (fromBuyOnward.length === 1) {
    return { ...emptyResult('open', opts), trades, costSol: buyCost, buyFeeSol: buyFee, buyTokenAmount };
  }

  // --- 拿不到 token 数量时无法按数量配对，明确告知调用方 ---
  if (buyTokenAmount <= 0) {
    return {
      ...emptyResult('open', opts),
      trades,
      costSol: buyCost,
      buyFeeSol: buyFee,
      // 状态没法判定平仓，pnl 留 null 而不是编一个数出来
    };
  }

  // --- FIFO 配对 ---
  // 队列里每一项是一笔还没卖完的买入，卖出按先进先出消耗。
  // isTarget 标出本笔买入：只有消耗到它的部分才计入收益。
  // 后面加仓的 lot 排在队尾，卖出它们的钱不能算到本笔头上 ——
  // 这正是旧实现虚高 50 倍的原因。
  const queue: Array<{ remaining: number; isTarget: boolean }> = [
    { remaining: buyTokenAmount, isTarget: true },
  ];
  let proceedsSol = 0;
  let sellFeeSol = 0;
  let soldTokenAmount = 0;
  let laterBuys = 0;
  let failedFeeSol = 0;
  let unparsed = 0;
  let ackedAkbot = false;
  const CHUNK = 100;
  let cursor = 1; // 下一个待解析的签名下标（0 是买入本身，已解析）

  outer:
  while (cursor < fromBuyOnward.length) {
    // 本笔买入的 token 已经被卖光，之后发生什么已经不影响这一笔的收益
    if (soldTokenAmount >= buyTokenAmount - TOKEN_EPSILON) break;

    const end = Math.min(cursor + CHUNK, fromBuyOnward.length);
    const batchSigs = fromBuyOnward.slice(cursor, end);
    const batchTxs = await parseAll(batchSigs.map((s) => s.signature));
    cursor = end;

    for (let i = 0; i < batchTxs.length; i++) {
      const tx = batchTxs[i];
      const sig = batchSigs[i];

      if (tx === null) {
        // 没解析出来 ≠ 交易失败。结果就是不可信的，直接报错让调用方重算。
        unparsed++;
        continue;
      }

      if (isFailedTx(tx)) {
        // 失败的交易不产生 token 变动，但手续费是真金白银交的。
        // 只做提示，不并进 pnlSol —— 跟单者未必会复制这些额外的交易。
        failedFeeSol += (tx.fee ?? 5000) / 1e9;
        continue;
      }

      const gotTokens = inboundTokenAmount(tx, mint, wallet);
      const sentTokens = outboundTokenAmount(tx, mint, wallet);

      if (gotTokens > 0 && sentTokens === 0) {
        // 后续加仓：进 FIFO 队列，排在本次买入之后
        queue.push({ remaining: gotTokens, isTarget: false });
        laterBuys++;
        trades.push({
          signature: sig.signature,
          blockTime: sig.blockTime,
          mint,
          // 记被跟踪的钱包，不是 feePayer：relayer 代付时两者不是同一个地址，
          // 之前写 tx.feePayer 会让链路上除首笔外的交易挂到别人名下。
          wallet,
          side: 'buy',
          solAmount: solOutTotal(tx, wallet),
          tokenAmount: gotTokens,
          feeSol: (tx.fee ?? 0) / 1e9,
          pnlSol: null,
        });
        continue;
      }

      if (sentTokens <= 0) continue; // 与本 mint 无关的交易

      // 卖出：净收入按 token 数量比例分摊给被消耗掉的各个 lot
      const netIn = netSolIn(tx, wallet);
      const sellFee = (tx.fee ?? 5000) / 1e9;
      let left = sentTokens;
      let lotProceeds = 0;
      let lotSellFee = 0;
      let fromThisBuy = 0;

      while (left > TOKEN_EPSILON && queue.length > 0) {
        const lot = queue[0];
        const take = Math.min(lot.remaining, left);
        const share = take / sentTokens;

        lot.remaining -= take;
        left -= take;

        // 只有消耗到本笔买入的那部分才算它的收益
        if (lot.isTarget) {
          lotProceeds += netIn * share;
          lotSellFee += sellFee * share;
          fromThisBuy += take;
        }

        if (lot.remaining <= TOKEN_EPSILON) queue.shift();
      }

      proceedsSol += lotProceeds;
      sellFeeSol += lotSellFee;
      soldTokenAmount += Math.min(fromThisBuy, buyTokenAmount);

      trades.push({
        signature: sig.signature,
        blockTime: sig.blockTime,
        mint,
        wallet,
        side: 'sell',
        solAmount: netIn,
        tokenAmount: sentTokens,
        feeSol: sellFee,
        pnlSol: null, // 末尾按整笔仓位统一填
      });

      // 本笔 token 已卖光：这一批里剩下的签名跟这一笔的收益无关，
      // 不再往下走 —— 之前只在 chunk 边界检查，一批 100 笔会白解析 99 笔。
      if (soldTokenAmount >= buyTokenAmount - TOKEN_EPSILON) break outer;

      // 实时识别：卖出是否走了 AKBot 合约，命中就标记该地址
      if (!ackedAkbot && isAkbotTx(tx)) {
        ackedAkbot = true;
        markAsAkbot(wallet, sig.signature, sig.blockTime, sig.slot).catch((e) =>
          console.warn('[pnl] markAsAkbot failed', wallet, e),
        );
      }
    }
  }

  // 链路上有没解析出来的交易时，收益只是「已知的部分」，不能当成最终值。
  // 这种情况罕见（需要 Helius 限流），宁可让调用方重算，也不要给一个可能错的数。
  if (unparsed > 0) {
    throw new Error(
      `有 ${unparsed} 笔交易没解析出来（Helius 限流或网络问题），结果不完整，未写入，请稍后重试`,
    );
  }

  // --- 汇总 ---
  // 成本按已卖比例分摊：卖了一半就只承担一半的买入本金和手续费。
  const soldRatio = Math.min(1, soldTokenAmount / buyTokenAmount);
  const remainingTokenAmount = Math.max(0, buyTokenAmount - soldTokenAmount);

  let pnlSol: number | null = null;
  let status: CopyPnlStatus;
  if (soldTokenAmount <= TOKEN_EPSILON) {
    // 一笔都没卖出去：收益未实现，不能用 0 冒充「持平」
    status = 'open';
  } else {
    pnlSol =
      proceedsSol - buyCost * soldRatio - buyFee * soldRatio - sellFeeSol;
    status = remainingTokenAmount <= TOKEN_EPSILON ? 'closed' : 'partial';
  }

  // 仓位级收益挂在最后一笔卖出的 pnlSol 上（对外仍是一笔一个数）
  const lastSell = [...trades].reverse().find((t) => t.side === 'sell');
  if (lastSell) lastSell.pnlSol = pnlSol;

  return {
    status,
    pnlSol,
    costSol: buyCost,
    buyFeeSol: buyFee,
    proceedsSol,
    sellFeeSol,
    buyTokenAmount,
    soldTokenAmount: Math.min(soldTokenAmount, buyTokenAmount),
    soldRatio,
    remainingTokenAmount,
    laterBuys,
    failedFeeSol,
    trades,
  };
}

function emptyResult(status: CopyPnlStatus, opts: { mint: string; buyWallet: string; buySol: number }) {
  return {
    status,
    pnlSol: null,
    costSol: opts.buySol,
    buyFeeSol: 0,
    proceedsSol: 0,
    sellFeeSol: 0,
    buyTokenAmount: 0,
    soldTokenAmount: 0,
    soldRatio: 0,
    remainingTokenAmount: 0,
    laterBuys: 0,
    failedFeeSol: 0,
    trades: [] as TradePnL[],
  };
}

/** 汇总某个地址范围内的总 PnL（按日） */
export async function summarizePnlByDay(addresses: string[], fromTs: number, toTs: number): Promise<{
  date: string;
  pnl: number;
  trades: number;
}[]> {
  // 简化：直接聚合 target_trades 表（假定 pnl_sol 已写入）
  const rows = await query<any>(`
    SELECT date_trunc('day', block_time) AS d,
           SUM(pnl_sol)::text AS pnl,
           COUNT(*)::int AS trades
    FROM target_trades
    WHERE target_address = ANY($1)
      AND block_time BETWEEN to_timestamp($2) AND to_timestamp($3)
      AND confirmed = true
    GROUP BY 1 ORDER BY 1
  `, [addresses, fromTs, toTs]);
  return rows.map((r) => ({
    date: r.d,
    pnl: parseFloat(r.pnl || '0'),
    trades: r.trades,
  }));
}
