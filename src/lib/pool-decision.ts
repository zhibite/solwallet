/**
 * 池子决策 (Decision Support)
 *
 * 1) 手续费推荐器：
 *    对每个 target 地址，取最近 K 笔抢单成功的 buy，统计同 slot 内 first_sniper 的
 *    (tip_sol + prio_lamports/1e9) 分布，给出 P50/P75 推荐值。
 *    失败/抢单失败的也统计，用于给出 "至少要比这更高才有可能抢到" 的下界。
 *
 * 2) 是否值得跟评分 (Worth-Following Score):
 *    - 基础: target_t 的 SUM(pnl_sol) over recent 30 天
 *    - 胜率: pnl_sol > 0 的比例
 *    - 成本: 平均 fee_sol (target_tip + prio) / 平均 buy_sol
 *    - score = base_pnl_per_trade * win_rate / log(1 + cost_ratio)
 *
 * 写到 pool_members 表（worth_score / recommended_tip_sol / recommended_prio_lamports），
 * 让 MonitorList 和 /pool 页面直接读出来显示。
 */

import { query, queryOne } from './db';

const RECENT_TRADES = parseInt(process.env.POOL_RECENT_TRADES || '50', 10);
const LOOKBACK_DAYS = parseInt(process.env.POOL_LOOKBACK_DAYS || '30', 10);

export interface FeeRecommendation {
  /** 抢单成功 (success) 的 tip SOL: P50 */
  p50_tip_sol: number;
  /** 抢单成功 (success) 的 prio lamports: P50 */
  p50_prio_lamports: number;
  /** 抢单成功 (success) 的 tip SOL: P75 (激进推荐) */
  p75_tip_sol: number;
  /** 抢单成功 (success) 的 prio lamports: P75 */
  p75_prio_lamports: number;
  /** 抢单成功 (success) 的总数 */
  success_count: number;
  /** 抢单失败 (failed) 的 tip P50 (下界参考) */
  failed_p50_tip_sol: number;
  /** 抢单失败 (failed) 的 prio P50 */
  failed_p50_prio_lamports: number;
  /** 抢单失败 (failed) 的总数 */
  failed_count: number;
  /** 样本量 */
  sample_size: number;
  /** 数据新鲜度（最近一笔 buy 时间） */
  last_buy_at: string | null;
}

export interface WorthScore {
  readonly offered: number;
  win_rate: number;
  avg_pnl_sol: number;
  total_pnl_sol: number;
  avg_fee_sol: number;
  cost_ratio: number;
  trade_count: number;
  computed_at: string;
}

/**
 * 单个 target 的手续费推荐
 */
export async function recommendFee(targetAddress: string): Promise<FeeRecommendation> {
  // 同 slot 内、目标之外的同 mint 买家
  // 用 block_buyers JOIN block_analyses JOIN target_trades 反查 target_address
  const buyerRows = await query<any>(`
    SELECT bb.tip_sol::text, bb.prio_lamports, bb.result, bb.is_first_sniper,
           bb.buy_sol::text, t.block_time
    FROM block_buyers bb
    JOIN block_analyses ba ON ba.id = bb.block_analysis_id
    JOIN target_trades t ON t.signature = ba.target_signature
    WHERE t.target_address = $1
      AND bb.address IS NOT NULL
      AND bb.address <> $1
      AND t.block_time >= NOW() - (($3 || ' days')::interval)
    ORDER BY t.block_time DESC
    LIMIT $2
  `, [targetAddress, RECENT_TRADES * 20, LOOKBACK_DAYS]);

  // 分别统计 success 和 failed 的 tip / prio
  const successTips: number[] = [];
  const successPrios: number[] = [];
  const failedTips: number[] = [];
  const failedPrios: number[] = [];
  let lastBuy: string | null = null;

  for (const b of buyerRows) {
    const tip = parseFloat(b.tip_sol ?? '0');
    const prio = Number(b.prio_lamports ?? 0);
    const t = b.block_time;
    if (!lastBuy || new Date(t) > new Date(lastBuy)) lastBuy = t;

    if (b.result === 'success') {
      if (tip > 0) successTips.push(tip);
      if (prio > 0) successPrios.push(prio);
    } else if (b.result === 'failed') {
      if (tip > 0) failedTips.push(tip);
      if (prio > 0) failedPrios.push(prio);
    }
  }

  return {
    p50_tip_sol: percentile(successTips, 0.5),
    p50_prio_lamports: Math.round(percentile(successPrios, 0.5)),
    p75_tip_sol: percentile(successTips, 0.75),
    p75_prio_lamports: Math.round(percentile(successPrios, 0.75)),
    success_count: successTips.length + successPrios.length > 0
      ? Math.max(successTips.length, successPrios.length) : 0,
    failed_p50_tip_sol: percentile(failedTips, 0.5),
    failed_p50_prio_lamports: Math.round(percentile(failedPrios, 0.5)),
    failed_count: failedTips.length + failedPrios.length > 0
      ? Math.max(failedTips.length, failedPrios.length) : 0,
    sample_size: buyerRows.length,
    last_buy_at: lastBuy,
  };
}

/**
 * 单个 target 是否值得跟评分
 */
export async function scoreWorthFollowing(targetAddress: string): Promise<WorthScore> {
  const row = await queryOne<any>(`
    SELECT
      COUNT(*)::int AS trade_count,
      COALESCE(SUM(pnl_sol), 0)::text AS total_pnl,
      COALESCE(AVG(pnl_sol), 0)::text AS avg_pnl,
      COALESCE(SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END), 0)::int AS win_count,
      COALESCE(AVG(COALESCE(fee_sol, target_tip_sol + target_prio_lamports / 1e9)), 0)::text AS avg_fee,
      COALESCE(AVG(buy_sol), 0)::text AS avg_buy
    FROM target_trades
    WHERE target_address = $1
      AND block_time >= NOW() - (($2 || ' days')::interval)
  `, [targetAddress, LOOKBACK_DAYS]);

  const tradeCount = row?.trade_count ?? 0;
  const totalPnl = parseFloat(row?.total_pnl ?? '0');
  const avgPnl = parseFloat(row?.avg_pnl ?? '0');
  const winCount = row?.win_count ?? 0;
  const avgFee = parseFloat(row?.avg_fee ?? '0');
  const avgBuy = parseFloat(row?.avg_buy ?? '0');

  const winRate = tradeCount > 0 ? winCount / tradeCount : 0;
  const costRatio = avgBuy > 0 ? avgFee / avgBuy : 1;
  // base = avg_pnl_sol；quality = winRate；cost = log(1 + costRatio)
  // score 量级约在 [-10, +10]
  const score = tradeCount === 0 ? 0 :
    (avgPnl * winRate) / Math.log(1 + costRatio + 1e-9);

  return {
    offered: parseFloat(score.toFixed(4)),
    win_rate: parseFloat(winRate.toFixed(4)),
    avg_pnl_sol: parseFloat(avgPnl.toFixed(6)),
    total_pnl_sol: parseFloat(totalPnl.toFixed(6)),
    avg_fee_sol: parseFloat(avgFee.toFixed(6)),
    cost_ratio: parseFloat(costRatio.toFixed(4)),
    trade_count: tradeCount,
    computed_at: new Date().toISOString(),
  };
}

/**
 * 重算所有 pool_members 的决策
 * 给 monitor_targets 和 pool_members 都更新
 */
export async function recomputeAllDecisions(): Promise<{
  scoredTargets: number;
  scoredPoolMembers: number;
  durationMs: number;
}> {
  const t0 = Date.now();

  // 1) monitored_targets
  const targets = await query<any>(`SELECT address FROM monitored_targets WHERE status = 'active'`);
  let scoredTargets = 0;
  for (const t of targets) {
    try {
      const fee = await recommendFee(t.address);
      const score = await scoreWorthFollowing(t.address);
      await query(
        `UPDATE pool_members
         SET worth_score = $2,
             recommended_tip_sol = $3,
             recommended_prio_lamports = $4,
             score_updated_at = NOW()
         WHERE address = $1`,
        [t.address, score.offered, fee.p75_tip_sol, fee.p75_prio_lamports],
      );
      scoredTargets++;
    } catch (err) {
      console.warn('[pool-decision] target failed', t.address, err);
    }
  }

  // 2) pool_members（不重复算 monitored_targets 里已算的）
  const members = await query<any>(`
    SELECT address FROM pool_members
    WHERE promoted_to_target = false AND freq >= 3
  `);
  let scoredPoolMembers = 0;
  for (const m of members) {
    try {
      const fee = await recommendFee(m.address);
      const score = await scoreWorthFollowing(m.address);
      await query(
        `UPDATE pool_members
         SET worth_score = $2,
             recommended_tip_sol = $3,
             recommended_prio_lamports = $4,
             score_updated_at = NOW()
         WHERE address = $1`,
        [m.address, score.offered, fee.p75_tip_sol, fee.p75_prio_lamports],
      );
      scoredPoolMembers++;
    } catch (err) {
      // pool_member 没有 target_trades 也没关系，跳过
    }
  }

  return {
    scoredTargets,
    scoredPoolMembers,
    durationMs: Date.now() - t0,
  };
}

/**
 * 给 monitor_targets 上的所有 active target 实时拉取决策（API 调用，不写库）
 */
export async function getDecisionsForMonitorTargets(): Promise<Record<string, { score: WorthScore; fee: FeeRecommendation }>> {
  const targets = await query<any>(`SELECT address FROM monitored_targets WHERE status = 'active'`);
  const out: Record<string, { score: WorthScore; fee: FeeRecommendation }> = {};
  await Promise.all(targets.map(async (t) => {
    try {
      const [score, fee] = await Promise.all([
        scoreWorthFollowing(t.address),
        recommendFee(t.address),
      ]);
      out[t.address] = { score, fee };
    } catch (err) {
      // 单个失败不影响其他
    }
  }));
  return out;
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}