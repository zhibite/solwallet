/**
 * 跟单收益计算引擎
 * 流程：
 * 1) 拿到一笔目标 buy
 * 2) 分页拉取该 mint 在 buy 之后的卖出交易（目标地址）
 * 3) 计算每笔的净 SOL 变动（in - out，含 tip / rent 等流出）
 * 4) 累加得到总 PnL = 卖出净收入 - 买入成本 - 买入 fee - 卖出 fee 总和
 *
 * 关键约定：
 * - 单仓位总 PnL 挂在「最新」一笔 sell 上（trades[1]，因为 sigs 是 newest-first）
 * - 不再「每笔 sell 都减一次 buySol」，避免多卖时被放大 N 倍
 */

import { query, queryOne } from './db';
import { getHelius } from './helius';
import { getRPC } from './solana-rpc';
import { isAkbotTx } from './akbot';
import { markAsAkbot } from './pool';

interface TradePnL {
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

const BUY_FEE_SOL = 0.000005;   // Solana base fee
const SIG_PAGE_SIZE = 1000;     // Helius 单次签名拉取上限
const MAX_SIG_PAGES = 20;       // 最多 20k 签名，防止活跃钱包拖死请求

/**
 * 分页拉取 address 在 afterBlockTime 之后的所有签名（newest-first）。
 * Helius getSignaturesForAddress 支持 before 翻页；rpc 版只支持 limit，活跃钱包会漏卖。
 */
async function fetchSigsAfter(address: string, afterBlockTime: number): Promise<any[]> {
  const helius = getHelius();
  const all: any[] = [];
  let before: string | undefined;

  for (let i = 0; i < MAX_SIG_PAGES; i++) {
    const batch = await helius.getSignaturesForAddress(address, {
      limit: SIG_PAGE_SIZE,
      before,
    });
    if (!batch || batch.length === 0) break;
    all.push(...batch);
    // batch 是 newest-first，末尾是最老的一笔；若它已早于买入时间，后面没必要再翻
    const oldest = batch[batch.length - 1];
    if ((oldest?.blockTime ?? 0) < afterBlockTime) break;
    if (batch.length < SIG_PAGE_SIZE) break;
    before = oldest.signature;
  }

  return all.filter((s) => (s.blockTime ?? 0) >= afterBlockTime);
}

/** 给定一个 mint，分析从 buy 开始的所有卖出 */
export async function calcTradePnL(opts: {
  mint: string;
  buySig: string;
  buyWallet: string;
  buySol: number;
  buyBlockTime: number;
  includeFailed?: boolean;
}): Promise<{
  totalPnl: number;
  failedFee: number;
  netPnl: number;
  buyCount: number;
  failed: number;
  confirmed: number;
  pending: number;
  trades: TradePnL[];
}> {
  const helius = getHelius();
  const includeFailed = !!opts.includeFailed;

  // 1) 分页拉 buy 之后的签名
  const sigs = await fetchSigsAfter(opts.buyWallet, opts.buyBlockTime);

  const trades: TradePnL[] = [
    {
      signature: opts.buySig,
      blockTime: opts.buyBlockTime,
      mint: opts.mint,
      wallet: opts.buyWallet,
      side: 'buy',
      solAmount: opts.buySol,
      tokenAmount: null,
      feeSol: BUY_FEE_SOL,
      pnlSol: null,
    },
  ];

  if (sigs.length === 0) {
    return {
      totalPnl: 0,
      failedFee: 0,
      netPnl: 0,
      buyCount: 1,
      failed: 0,
      confirmed: 0,
      pending: 1,
      trades,
    };
  }

  // 2) 解析（不在这里 try/catch：失败冒到 route 的 catch → 500 → UI alert，不再静默写 null）
  const sigList = sigs.map((s) => s.signature);
  const enhancedList = await helius.parseTransactions(sigList);

  // 3) 累计所有 sell（newest-first）
  let totalSellNetSol = 0;
  let totalSellFee = 0;
  let failedFee = 0;
  let confirmed = 0;

  for (const tx of enhancedList) {
    if (!tx) continue;

    // 失败判定：tx.err / events.swap.error（部分 Helius 版本会在 tx.err 暴露 RPC 失败码，
    // TS 类型未声明，用 any 取以防运行时有但编译期看不到）
    // 之前 `tx.events?.swap === undefined && nativeTransfers.length === 0` 会把非 swap 类转账（如 airdrop claim）误判为 failed
    const txErr = (tx as any).err;
    const txFailed = !!txErr || !!tx.events?.swap?.error;
    if (txFailed) {
      if (includeFailed) failedFee += (tx.fee ?? 5000) / 1e9;
      continue;
    }

    // 该 mint 从本钱包出账 → 视为卖出。兼容 Jito bundle / relayer（feePayer ≠ buyWallet）
    const tokenTransfers = tx.tokenTransfers ?? [];
    const outToken = tokenTransfers.find(
      (t: any) =>
        (t.fromUserAccount === tx.feePayer || t.fromUserAccount === opts.buyWallet) &&
        t.mint === opts.mint,
    );
    if (!outToken) continue;

    // 净 SOL 变动 = (in - out)，排除 self-transfer；out 包含 tip / rent 等从 wallet 出账的部分
    // 之前只统计「toUserAccount === feePayer」，把 Jito tip、relayer fee 等流出都漏掉了 → 高估 PnL
    let solIn = 0;
    let solOut = 0;
    for (const t of tx.nativeTransfers ?? []) {
      if (t.fromUserAccount === t.toUserAccount) continue; // 自转不算
      if (t.toUserAccount === tx.feePayer) solIn += t.amount;
      if (t.fromUserAccount === tx.feePayer) solOut += t.amount;
    }
    solIn /= 1e9;
    solOut /= 1e9;
    const netProceeds = solIn - solOut;
    const fee = (tx.fee ?? 5000) / 1e9;

    totalSellNetSol += netProceeds;
    totalSellFee += fee;
    confirmed++;

    // 实时识别：本次 sell 是否调用了 AKBot 合约；命中则异步标记 buyWallet 为 akbot 用户
    // （fire-and-forget，不阻塞本次 PnL 返回；markAsAkbot 自身幂等）
    if (isAkbotTx(tx)) {
      markAsAkbot(opts.buyWallet, tx.signature, tx.blockTime, tx.slot).catch((e) =>
        console.warn('[pnl] markAsAkbot failed', opts.buyWallet, e),
      );
    }

    trades.push({
      signature: tx.signature,
      blockTime: tx.blockTime,
      mint: opts.mint,
      wallet: tx.feePayer,
      side: 'sell',
      solAmount: netProceeds,
      tokenAmount: outToken.tokenAmount,
      feeSol: fee,
      pnlSol: null, // 末尾统一填该仓位的总 PnL
    });
  }

  // 4) 总 PnL：所有卖出净收入 - 买入成本 - 买入 fee - 卖出 fee 总和
  //    之前是「每笔 sell 都减一次 buySol」导致多卖时被放大 N 倍
  const totalPnl =
    confirmed > 0 ? totalSellNetSol - opts.buySol - BUY_FEE_SOL - totalSellFee : 0;
  const netPnl = totalPnl - failedFee;

  // 5) 把仓位总 PnL 挂到「最新」一笔 sell 上
  //    sigs 是 newest-first，遍历时按顺序 push，trades[1] 就是最新 sell
  //    route 用 trades.find(sell) 取第一笔，正好命中 trades[1]
  if (confirmed > 0) {
    for (const t of trades) {
      if (t.side === 'sell') {
        t.pnlSol = totalPnl;
        break;
      }
    }
  }

  return {
    totalPnl,
    failedFee,
    netPnl,
    buyCount: 1,
    failed: includeFailed ? failedFee / BUY_FEE_SOL : 0,
    confirmed,
    pending: confirmed === 0 ? 1 : 0,
    trades,
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
