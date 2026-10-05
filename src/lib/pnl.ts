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
 *   - 「之后」用 getSignaturesForAddress 的返回顺序判定，且**以买入那一笔为锚点**
 *     （until=买入，往后翻），不用 blockTime 比较：同一秒内的多笔交易在时间戳上
 *     无法区分先后，按时间过滤会把买入之前就已经发生的卖出算成这一笔的收益。
 *     锚在买入上还有个好处：不受钱包有多活跃影响。从链尾往回翻够不到老交易 ——
 *     实测一批 5 天前的历史行，窗口最老只到 slot 453498000 而买入在 451923109。
 *     而「够不到」会返回 open / pnlSol=null，回填时会拿它覆盖掉已经算对的 closed 行，
 *     那是数据丢失，不是修正。
 *   - 失败判定用 TxView.failed。RPC 路径读 meta.err，Helius 路径读 transactionError。
 *     绝不能看 tx.err —— 那是 getSignaturesForAddress 的字段，在交易解析结果上恒为 undefined，
 *     等于所有失败交易都被当成了成功卖出。Helius 对失败交易仍会返回
 *     根本没执行的转账（实测失败的买入带着一条 0.508 SOL 的 phantom 转出），
 *     这些幻影数字会直接污染盈亏。
 *   - 买入手续费用这笔交易真实的 fee（base + priority），
 *     不再写死 5000 lamports；卖出侧本来扣的就是完整 fee，两边口径一致。
 *   - 还没卖完时 pnlSol 是「已实现部分」的收益，同时给 soldRatio；
 *     一个 token 都没卖时 pnlSol 为 null（持仓中），和真实的 0 区分开。
 *
 * 取数不在这个文件里：交易怎么拿（Helius 增强 API 还是普通 RPC）由 tx-source 归一化成
 * TxView，这里只跟 TxView 打交道。换数据源不需要动这里的算法。
 */

import { query } from './db';
import { isAkbotTx } from './akbot';
import { markAsAkbot } from './pool';
import { fetchTxViews, fetchSigsFrom, isFailedTx } from './tx-source';

/** token 数量配对容差：1e-3 个原始单位（pump.fun 是 6 位小数，即 1e-9 个 token） */
const TOKEN_EPSILON = 1e-3;

// isFailedTx 的定义搬到了 tx-source（它属于「Helius 形状的知识」，和取数逻辑住在一起）。
// 从这里转出去，analyze/route.ts 的 import 不用动。
export { isFailedTx };

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
  const mint = opts.mint;
  const wallet = opts.buyWallet;

  // 买入**之后**的签名，用 until=买入锚定在起点上翻。
  //
  // 这里刻意不去链尾找买入：钱包只要在这笔之后又做了 2 万笔交易，
  // 买入就再也找不到了，而「找不到」会让本函数返回 open / pnlSol=null，
  // 回填脚本会拿它把已经算对的 closed 行覆盖成 NULL —— 那是数据丢失，不是修正。
  // 锚定在买入上往后翻就没有这个问题，而且通常一两页就够。
  const afterBuy = await fetchSigsFrom(wallet, opts.buySig);

  // 买入自己也要取，才知道它到底成没成、真实 fee 是多少。
  // 注意是「边走边取」而不是一次性全取：本笔的 token 一旦被卖光，
  // 后面发生什么已经不影响这一笔的收益，可以立刻收工。
  const [buyTx] = await fetchTxViews([opts.buySig], wallet);

  // --- 买入本身 ---
  const buyFee = opts.buyFeeLamports != null ? opts.buyFeeLamports / 1e9 : (buyTx?.feeLamports ?? 0) / 1e9;
  const buyTokenAmount =
    opts.buyTokenAmount != null && opts.buyTokenAmount > 0
      ? opts.buyTokenAmount
      : (buyTx ? Math.max(0, buyTx.tokenDelta(mint, wallet)) : 0);
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

  // 买入交易本身没取到（限流 / 网络）→ 无法判断成败，必须报错而不是编一个状态。
  // 编成 buy_failed 会把一次网络抖动永久写进库。
  if (!buyTx) {
    throw new Error('买入交易取数失败（RPC 限流或网络问题），未写入结果，请稍后重试');
  }
  if (buyTx.signature !== opts.buySig) {
    throw new Error(`取数结果对不上：期望 ${opts.buySig.slice(0, 12)}，拿到 ${buyTx.signature.slice(0, 12)}`);
  }

  // 买入交易失败 → 没有 token，成本只有手续费
  if (buyTx.failed) {
    return {
      ...emptyResult('buy_failed', opts),
      trades,
      costSol: 0,
      buyFeeSol: buyFee,
      pnlSol: -buyFee,
      failedFeeSol: 0,
    };
  }

  // 买入之后一笔交易都没有：连一次卖出机会都没有，必然是持仓中
  if (afterBuy.length === 0) {
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
  let cursor = 0; // 下一个待取数的签名下标（买入本身已经单独取过了）

  outer:
  while (cursor < afterBuy.length) {
    // 本笔买入的 token 已经被卖光，之后发生什么已经不影响这一笔的收益
    if (soldTokenAmount >= buyTokenAmount - TOKEN_EPSILON) break;

    const end = Math.min(cursor + CHUNK, afterBuy.length);
    const batchSigs = afterBuy.slice(cursor, end);
    const batchTxs = await fetchTxViews(batchSigs.map((s) => s.signature), wallet);
    cursor = end;

    for (let i = 0; i < batchTxs.length; i++) {
      const tx = batchTxs[i];
      const sig = batchSigs[i];

      if (tx === null) {
        // 没取到 ≠ 交易失败。结果就是不可信的，直接报错让调用方重算。
        unparsed++;
        continue;
      }

      if (tx.failed) {
        // 失败的交易不产生 token 变动，但手续费是真金白银交的。
        // 只做提示，不并进 pnlSol —— 跟单者未必会复制这些额外的交易。
        failedFeeSol += (tx.feeLamports || 5000) / 1e9;
        continue;
      }

      // 余额差一次给出净额：正 = 加仓，负 = 卖出，零 = 与本 mint 无关
      const tokenDelta = tx.tokenDelta(mint, wallet);
      const gotTokens = tokenDelta > 0 ? tokenDelta : 0;
      const sentTokens = tokenDelta < 0 ? -tokenDelta : 0;

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
          solAmount: -tx.solNet(wallet),
          tokenAmount: gotTokens,
          feeSol: (tx.feeLamports ?? 0) / 1e9,
          pnlSol: null,
        });
        continue;
      }

      if (sentTokens <= 0) continue; // 与本 mint 无关的交易

      // 卖出：净收入按 token 数量比例分摊给被消耗掉的各个 lot
      const netIn = tx.solNet(wallet);
      const sellFee = (tx.feeLamports || 5000) / 1e9;
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
      if (!ackedAkbot && isAkbotTx(tx.raw)) {
        ackedAkbot = true;
        markAsAkbot(wallet, sig.signature, sig.blockTime, sig.slot).catch((e) =>
          console.warn('[pnl] markAsAkbot failed', wallet, e),
        );
      }
    }
  }

  // 链路上有没取到数的交易时，收益只是「已知的部分」，不能当成最终值。
  // 宁可让调用方重算，也不要给一个可能错的数。
  if (unparsed > 0) {
    throw new Error(
      `有 ${unparsed} 笔交易没取到（RPC 限流或网络问题），结果不完整，未写入，请稍后重试`,
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
