/**
 * 池子分析 (Pool Analytics) —— 每个 target 的最近竞争情况聚合
 *
 * 输出：
 *   1) 时序: follower_count / success_rate over recent N trades
 *   2) 分布: tip_sol / prio_lamports success vs failed
 *   3) 常驻竞争者: top N addresses 按出现频率
 *   4) 跟单者收益分布: 失败的看 SUM(fee) / 成功的看 PnL
 */

import { query, queryOne } from './db';

const LOOKBACK_DAYS = parseInt(process.env.POOL_LOOKBACK_DAYS || '30', 10);

export interface BuyerDistribution {
  bucket: string;       // "<0.001" "0.001-0.005" 等
  success_count: number;
  failed_count: number;
  median_pnl_sol: number;
}

export interface TopCompetitor {
  address: string;
  freq: number;
  win_count: number;
  fail_count: number;
  win_rate: number;
  avg_offset_pos: number;
  avg_tip_sol: number | string;
  avg_prio_lamports: number | string;
}

export interface AnalyticsTrendPoint {
  trade_signature: string;
  block_time: string;
  buyer_count: number;
  success_count: number;
  failed_count: number;
  top_tip_sol: number;
  top_prio_lamports: number;
}

/**
 * 单个 target 的综合分析
 */
export async function getAnalytics(targetAddress: string): Promise<{
  summary: {
    total_trades: number;
    total_buyers: number;
    avg_buyers_per_trade: number;
    avg_success_rate: number;
    avg_pnl_sol: number;
    total_pnl_sol: number;
  };
  trend: AnalyticsTrendPoint[];
  tipDistribution: BuyerDistribution[];
  prioDistribution: BuyerDistribution[];
  topCompetitors: TopCompetitor[];
  pnlDistribution: BuyerDistribution[];
}> {
  // 1) 汇总
  const summaryRow = await queryOne<any>(`
    SELECT
      COUNT(DISTINCT t.signature)::int AS total_trades,
      COUNT(bb.id)::int AS total_buyers,
      COALESCE(SUM(t.pnl_sol), 0)::text AS total_pnl,
      COALESCE(AVG(t.pnl_sol), 0)::text AS avg_pnl
    FROM target_trades t
    LEFT JOIN block_analyses ba ON ba.target_signature = t.signature
    LEFT JOIN block_buyers bb ON bb.block_analysis_id = ba.id AND bb.address IS NOT NULL AND bb.address <> t.target_address
    WHERE t.target_address = $1
      AND t.block_time >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'
  `, [targetAddress]);

  const totalTrades = summaryRow?.total_trades ?? 0;
  const totalBuyers = summaryRow?.total_buyers ?? 0;
  const avgBuyers = totalTrades > 0 ? totalBuyers / totalTrades : 0;

  // 成功 rate: 计算每笔的成功率均值（fail_count / buyer_count）
  const successRateRow = await queryOne<any>(`
    SELECT
      COALESCE(AVG(CASE WHEN buyer_count::int > 0 THEN success_count::float / buyer_count::int ELSE 0 END), 0)::text AS avg_success
    FROM (
      SELECT ba.target_signature,
             COUNT(bb.id)::int AS buyer_count,
             SUM(CASE WHEN bb.result = 'success' THEN 1 ELSE 0 END)::int AS success_count
      FROM block_analyses ba
      JOIN target_trades t ON t.signature = ba.target_signature
      LEFT JOIN block_buyers bb ON bb.block_analysis_id = ba.id AND bb.address IS NOT NULL AND bb.address <> t.target_address
      WHERE t.target_address = $1
        AND t.block_time >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'
      GROUP BY ba.target_signature
    ) s
  `, [targetAddress]);

  const summary = {
    total_trades: totalTrades,
    total_buyers: totalBuyers,
    avg_buyers_per_trade: parseFloat(avgBuyers.toFixed(2)),
    avg_success_rate: parseFloat(successRateRow?.avg_success ?? '0'),
    avg_pnl_sol: parseFloat(summaryRow?.avg_pnl ?? '0'),
    total_pnl_sol: parseFloat(summaryRow?.total_pnl ?? '0'),
  };

  // 2) 时序 trend (最近 30 笔)
  const trend = await query<AnalyticsTrendPoint>(`
    SELECT
      ba.target_signature AS trade_signature,
      ba.block_time,
      COUNT(bb.id)::int AS buyer_count,
      SUM(CASE WHEN bb.result = 'success' THEN 1 ELSE 0 END)::int AS success_count,
      SUM(CASE WHEN bb.result = 'failed' THEN 1 ELSE 0 END)::int AS failed_count,
      COALESCE(MAX(bb.tip_sol), 0)::text AS top_tip_sol,
      COALESCE(MAX(bb.prio_lamports), 0) AS top_prio_lamports
    FROM block_analyses ba
    JOIN target_trades t ON t.signature = ba.target_signature
    LEFT JOIN block_buyers bb ON bb.block_analysis_id = ba.id AND bb.address IS NOT NULL AND bb.address <> t.target_address
    WHERE t.target_address = $1
    GROUP BY ba.target_signature, ba.block_time
    ORDER BY ba.block_time DESC
    LIMIT 30
  `, [targetAddress]);

  // 3) tip 分布（success vs failed）
  const tipRows = await query<any>(`
    SELECT
      bb.tip_sol::text AS tip,
      bb.result
    FROM block_buyers bb
    JOIN block_analyses ba ON ba.id = bb.block_analysis_id
    JOIN target_trades t ON t.signature = ba.target_signature
    WHERE t.target_address = $1
      AND bb.address IS NOT NULL
      AND bb.address <> t.target_address
      AND bb.tip_sol > 0
      AND t.block_time >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'
  `, [targetAddress]);

  const tipDistribution = bucketizeTip(tipRows);

  // 4) prio 分布
  const prioRows = await query<any>(`
    SELECT
      bb.prio_lamports AS prio,
      bb.result
    FROM block_buyers bb
    JOIN block_analyses ba ON ba.id = bb.block_analysis_id
    JOIN target_trades t ON t.signature = ba.target_signature
    WHERE t.target_address = $1
      AND bb.address IS NOT NULL
      AND bb.address <> t.target_address
      AND bb.prio_lamports > 0
      AND t.block_time >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'
  `, [targetAddress]);

  const prioDistribution = bucketizePrio(prioRows);

  // 5) Top 常驻竞争者
  const topCompetitors = await query<TopCompetitor>(`
    SELECT
      bb.address,
      COUNT(*)::int AS freq,
      SUM(CASE WHEN bb.result = 'success' THEN 1 ELSE 0 END)::int AS win_count,
      SUM(CASE WHEN bb.result = 'failed' THEN 1 ELSE 0 END)::int AS fail_count,
      AVG(bb.block_index)::float AS avg_offset_pos,
      AVG(bb.tip_sol)::text AS avg_tip_sol,
      AVG(bb.prio_lamports)::float AS avg_prio_lamports
    FROM block_buyers bb
    JOIN block_analyses ba ON ba.id = bb.block_analysis_id
    JOIN target_trades t ON t.signature = ba.target_signature
    WHERE t.target_address = $1
      AND bb.address IS NOT NULL
      AND bb.address <> t.target_address
      AND t.block_time >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'
    GROUP BY bb.address
    ORDER BY freq DESC
    LIMIT 15
  `, [targetAddress]);

  // 加 win_rate
  for (const c of topCompetitors) {
    const total = c.win_count + c.fail_count;
    c.win_rate = total > 0 ? parseFloat((c.win_count / total).toFixed(3)) : 0;
    c.avg_tip_sol = parseFloat(String(c.avg_tip_sol ?? '0'));
    c.avg_prio_lamports = parseFloat(String(c.avg_prio_lamports ?? 0));
  }

  // 6) 跟单者 PnL 分布
  const pnlRows = await query<any>(`
    SELECT
      bb.pnl_sol::text AS pnl,
      bb.result
    FROM block_buyers bb
    JOIN block_analyses ba ON ba.id = bb.block_analysis_id
    JOIN target_trades t ON t.signature = ba.target_signature
    WHERE t.target_address = $1
      AND bb.address IS NOT NULL
      AND bb.address <> t.target_address
      AND bb.pnl_sol IS NOT NULL
      AND t.block_time >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'
  `, [targetAddress]);

  const pnlDistribution = bucketizePnl(pnlRows);

  return {
    summary,
    trend,
    tipDistribution,
    prioDistribution,
    topCompetitors,
    pnlDistribution,
  };
}

function bucketizeTip(rows: Array<{ tip: string; result: string }>): BuyerDistribution[] {
  const buckets = [
    { label: '<0.001', lo: 0, hi: 0.001 },
    { label: '0.001-0.005', lo: 0.001, hi: 0.005 },
    { label: '0.005-0.01', lo: 0.005, hi: 0.01 },
    { label: '0.01-0.05', lo: 0.01, hi: 0.05 },
    { label: '0.05-0.1', lo: 0.05, hi: 0.1 },
    { label: '>0.1', lo: 0.1, hi: Infinity },
  ];
  const out: BuyerDistribution[] = buckets.map((b) => ({
    bucket: b.label,
    success_count: 0,
    failed_count: 0,
    median_pnl_sol: 0,
  }));
  for (const r of rows) {
    const tip = parseFloat(r.tip);
    if (Number.isNaN(tip)) continue;
    const idx = buckets.findIndex((b) => tip >= b.lo && tip < b.hi);
    if (idx < 0) continue;
    if (r.result === 'success') out[idx].success_count++;
    else if (r.result === 'failed') out[idx].failed_count++;
  }
  return out;
}

function bucketizePrio(rows: Array<{ prio: number; result: string }>): BuyerDistribution[] {
  const buckets = [
    { label: '<10k', lo: 0, hi: 10_000 },
    { label: '10k-50k', lo: 10_000, hi: 50_000 },
    { label: '50k-200k', lo: 50_000, hi: 200_000 },
    { label: '200k-500k', lo: 200_000, hi: 500_000 },
    { label: '500k-1M', lo: 500_000, hi: 1_000_000 },
    { label: '>1M', lo: 1_000_000, hi: Infinity },
  ];
  const out: BuyerDistribution[] = buckets.map((b) => ({
    bucket: b.label,
    success_count: 0,
    failed_count: 0,
    median_pnl_sol: 0,
  }));
  for (const r of rows) {
    const p = Number(r.prio);
    if (Number.isNaN(p)) continue;
    const idx = buckets.findIndex((b) => p >= b.lo && p < b.hi);
    if (idx < 0) continue;
    if (r.result === 'success') out[idx].success_count++;
    else if (r.result === 'failed') out[idx].failed_count++;
  }
  return out;
}

function bucketizePnl(rows: Array<{ pnl: string; result: string }>): BuyerDistribution[] {
  const buckets = [
    { label: '<-0.5', lo: -Infinity, hi: -0.5 },
    { label: '-0.5~0', lo: -0.5, hi: 0 },
    { label: '0~0.5', lo: 0, hi: 0.5 },
    { label: '0.5~1', lo: 0.5, hi: 1 },
    { label: '1~5', lo: 1, hi: 5 },
    { label: '>5', lo: 5, hi: Infinity },
  ];
  const out: BuyerDistribution[] = buckets.map((b) => ({
    bucket: b.label,
    success_count: 0,
    failed_count: 0,
    median_pnl_sol: 0,
  }));
  for (const r of rows) {
    const p = parseFloat(r.pnl);
    if (Number.isNaN(p)) continue;
    const idx = buckets.findIndex((b) => p >= b.lo && p < b.hi);
    if (idx < 0) continue;
    if (r.result === 'success') out[idx].success_count++;
    else if (r.result === 'failed') out[idx].failed_count++;
  }
  return out;
}