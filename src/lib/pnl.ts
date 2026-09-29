/**
 * 跟单收益计算引擎
 * 流程：
 * 1) 拿到一笔目标 buy
 * 2) 拉取该 mint 在 buy 之后的卖出交易（目标地址 + 自己钱包地址）
 * 3) 计算每笔的 PnL = 卖出 SOL - 买入 SOL - 失败手续费
 * 4) 累加得到总 PnL、净 PnL
 *
 * 简化策略：每笔 buy 只跟踪最近一笔 sell（按时间排序），未结算的记 pending
 */

import { query, queryOne } from './db';
import { getHelius } from './helius';
import { getRPC } from './solana-rpc';

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
  const rpc = getRPC();

  // 1) 拉 buy 之后的该 mint 卖出（限定 buyWallet）
  const sigs = await rpc.getSignaturesForAddress(opts.buyWallet, 100);
  const filtered = sigs.filter((s) => (s.blockTime ?? 0) >= opts.buyBlockTime);

  const trades: TradePnL[] = [];
  let totalPnl = 0;
  let failedFee = 0;
  let confirmed = 0;
  let pending = 0;
  let buyCount = 1; // 起始就是 buy

  // 先 push buy
  trades.push({
    signature: opts.buySig,
    blockTime: opts.buyBlockTime,
    mint: opts.mint,
    wallet: opts.buyWallet,
    side: 'buy',
    solAmount: opts.buySol,
    tokenAmount: null,
    feeSol: 0.000005,
    pnlSol: null,
  });

  if (filtered.length === 0) {
    pending++;
    return { totalPnl, failedFee, netPnl: totalPnl - failedFee, buyCount, failed: 0, confirmed, pending, trades };
  }

  // 2) 解析每一笔，找出对同 mint 的卖出
  const sigList = filtered.map((s) => s.signature);
  let enhancedList: any[] = [];
  try {
    enhancedList = await helius.parseTransactions(sigList);
  } catch (err) {
    console.warn('[calcTradePnL] helius parse failed', err);
  }

  for (const tx of enhancedList) {
    if (!tx) continue;
    const failed = !!tx.events?.swap?.error || tx.events?.swap === undefined && tx.nativeTransfers?.length === 0;
    const failedFeeThis = failed ? (tx.fee ?? 5000) / 1e9 : 0;
    if (failed && opts.includeFailed) failedFee += failedFeeThis;

    // 检查是否卖出了目标 mint
    const tokenTransfers = tx.tokenTransfers ?? [];
    const outToken = tokenTransfers.find(
      (t: any) => t.fromUserAccount === tx.feePayer && t.mint === opts.mint,
    );
    if (!outToken) continue;

    const solIn = (tx.nativeTransfers ?? [])
      .filter((t: any) => t.toUserAccount === tx.feePayer)
      .reduce((s: number, t: any) => s + t.amount, 0) / 1e9;

    const pnl = solIn - opts.buySol - (tx.fee ?? 5000) / 1e9;
    totalPnl += pnl;
    confirmed++;

    trades.push({
      signature: tx.signature,
      blockTime: tx.blockTime,
      mint: opts.mint,
      wallet: tx.feePayer,
      side: 'sell',
      solAmount: solIn,
      tokenAmount: outToken.tokenAmount,
      feeSol: (tx.fee ?? 5000) / 1e9,
      pnlSol: pnl,
    });
  }

  return {
    totalPnl,
    failedFee,
    netPnl: totalPnl - failedFee,
    buyCount,
    failed: opts.includeFailed ? failedFee / 0.000005 : 0,
    confirmed,
    pending,
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
