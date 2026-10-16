/**
 * 池子分析 (Pool Analytics) —— 每个 target 的最近竞争情况聚合
 *
 * 输出：
 *   1) 时序: follower_count / success_rate over recent N trades
 *   2) 分布: tip_sol / prio_lamports success vs failed
 *   3) 常驻竞争者: top N addresses 按出现频率
 *   4) 跟单者收益分布: 失败的看 SUM(fee) / 成功的看 PnL
 *
 * ── 视角分离（2026-10-16 拆分）───────────────────────────────────────
 *
 * 旧实现只有 getAnalytics(targetAddress) 一条路径，整套 SQL 都 JOIN target_trades。
 * 这对 monitored target 是合理的，但 pool_members 90%+ 是 follower（buyer），它们
 * 在 target_trades 里根本没签名，SQL 查出来恒为空 → 详情页整片"竞争分析"空着。
 *
 * 现在拆两条入口：
 *   - getAnalytics(targetAddress)     —— target 视角，给"被监控的地址"看竞争情况
 *   - getMemberAnalytics(memberAddr)  —— member 视角，给"跟单者"看自己的画像
 *   - getAnalyticsFor(address)        —— 路由层统一入口，按身份自动选
 * member 视角只统计「跟单相关」买入（is_follower / is_first_sniper / is_pre_target），
 * 避免把独立交易灌进"跟单成本建议 / 跟单评分"。
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
  // 2026-10-16 修复：补 AND bb.is_own = FALSE。
  //   之前只排除目标自身（bb.address <> t.target_address），自己的 own_wallets
  //   列表里其它地址（同操作员挂的副钱包）会被算成「竞争者」：
  //     - total_buyers 含自家笔数，avg_buyers_per_trade 虚高
  //     - total_pnl 含自家 PnL（如果副钱包也在抢），跟单价值被灌水
  //   recommendFeeForTarget (pool-decision.ts) 在 2026-10-07 已经补过同样过滤，
  //   这里补齐对齐口径。
  const summaryRow = await queryOne<any>(`
    SELECT
      COUNT(DISTINCT t.signature)::int AS total_trades,
      COUNT(bb.id)::int AS total_buyers,
      COALESCE(SUM(t.pnl_sol), 0)::text AS total_pnl,
      COALESCE(AVG(t.pnl_sol), 0)::text AS avg_pnl
    FROM target_trades t
    LEFT JOIN block_analyses ba ON ba.target_signature = t.signature
    LEFT JOIN block_buyers bb ON bb.block_analysis_id = ba.id
      AND bb.address IS NOT NULL
      AND bb.address <> t.target_address
      AND bb.is_own = FALSE
    WHERE t.target_address = $1
      AND t.block_time >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'
  `, [targetAddress]);

  const totalTrades = summaryRow?.total_trades ?? 0;
  const totalBuyers = summaryRow?.total_buyers ?? 0;
  const avgBuyers = totalTrades > 0 ? totalBuyers / totalTrades : 0;

  // 成功 rate: 计算每笔的成功率均值（fail_count / buyer_count）
  // 2026-10-16 修复：补 AND bb.is_own = FALSE，理由同上方 summary。
  const successRateRow = await queryOne<any>(`
    SELECT
      COALESCE(AVG(CASE WHEN buyer_count::int > 0 THEN success_count::float / buyer_count::int ELSE 0 END), 0)::text AS avg_success
    FROM (
      SELECT ba.target_signature,
             COUNT(bb.id)::int AS buyer_count,
             SUM(CASE WHEN bb.result = 'success' THEN 1 ELSE 0 END)::int AS success_count
      FROM block_analyses ba
      JOIN target_trades t ON t.signature = ba.target_signature
      LEFT JOIN block_buyers bb ON bb.block_analysis_id = ba.id
        AND bb.address IS NOT NULL
        AND bb.address <> t.target_address
        AND bb.is_own = FALSE
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
  // 2026-10-16 修复：补 AND bb.is_own = FALSE，理由同 summary。
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
    LEFT JOIN block_buyers bb ON bb.block_analysis_id = ba.id
      AND bb.address IS NOT NULL
      AND bb.address <> t.target_address
      AND bb.is_own = FALSE
    WHERE t.target_address = $1
    GROUP BY ba.target_signature, ba.block_time
    ORDER BY ba.block_time DESC
    LIMIT 30
  `, [targetAddress]);

  // 3) tip 分布（success vs failed）
  // 2026-10-16 修复：补 AND bb.is_own = FALSE，理由同上。
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
      AND bb.is_own = FALSE
      AND bb.tip_sol > 0
      AND t.block_time >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'
  `, [targetAddress]);

  const tipDistribution = bucketizeTip(tipRows);

  // 4) prio 分布
  // 2026-10-16 修复：补 AND bb.is_own = FALSE，理由同上。
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
      AND bb.is_own = FALSE
      AND bb.prio_lamports > 0
      AND t.block_time >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'
  `, [targetAddress]);

  const prioDistribution = bucketizePrio(prioRows);

  // 5) Top 常驻竞争者
  // 2026-10-16 修复：补 AND bb.is_own = FALSE，理由同上。
  //   漏这一条会让 topCompetitors 前 N 行被自家 own_wallets 霸榜，
  //   既虚标了真实竞争强度，也误导「这个 target 真的有 8 个活跃跟单」
  //   的判断（自家可能占 3-5 个）。
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
      AND bb.is_own = FALSE
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
  // 2026-10-16 修复：补 AND bb.is_own = FALSE，理由同上。
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
      AND bb.is_own = FALSE
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

// ─── 跟单者（member）视角分析 ──────────────────────────────────────────
//
// 数据源：block_buyers WHERE bb.address = $1
//   - 这位地址是「买家」，不是 target
//   - 只统计「跟单相关」买入：is_follower / is_first_sniper / is_pre_target 任一为 TRUE
//   - 独立交易（不蹭任何目标车）不计入，避免污染"跟单画像"
//
// 与 getAnalytics 的字段对齐，方便前端组件复用（趋势 / tip 分布 / prio 分布 / pnl 分布）。
// topCompetitors 字段换语义为 topTargets：跟单者蹭过的目标，按频次排序，
// 配合详情页 already 有「跟随的目标」列表，这里给的是"对每个目标的表现数据"，不重复。
//
// member 视角的 summary：
//   - total_trades: 该地址跟单买入总笔数（独立交易不算）
//   - total_buyers: 永远 = 1（它是唯一买家），保留字段仅为类型对齐
//   - avg_buyers_per_trade: 同上
//   - avg_success_rate: 该地址自己的抢单成功率
//   - total_pnl_sol / avg_pnl_sol: 跟单盈亏
//
// 为什么总笔数里包含「独立交易」做分母：
//   scoreFromSample (pool-decision.ts) 内部已经分别用 closed/partial/open 拆样本，
//   这里只关心"它在多少笔抢单里出现"和"在这些抢单里战绩如何"。

export interface MemberTrendPoint {
  trade_signature: string;
  block_time: string;
  slot: number;
  mint: string;
  target_address: string;
  is_first_sniper: boolean;
  is_follower: boolean;
  is_pre_target: boolean;
  /** 该地址自己的 buy_sol */
  buy_sol: number;
  /** 该地址自己的 tip */
  tip_sol: number;
  /** 该地址自己的 prio */
  prio_lamports: number;
  /** 该地址在 block 内的排序位置（block_index） */
  block_index: number;
  result: string;
  pnl_sol: number | null;
}

export interface TopTarget {
  address: string;
  freq: number;
  win_count: number;
  fail_count: number;
  win_rate: number;
  avg_buy_sol: number;
  avg_tip_sol: number;
  avg_prio_lamports: number;
  /** 最近一次跟该目标 buy 的时间 */
  last_seen_at: string;
}

export interface MemberAnalytics {
  /** 视角标识：'member'。前端可据此切换文案 / 隐藏 target-only 组件 */
  view: 'member';
  summary: {
    total_trades: number;
    /** member 视角恒为 1，保留只为类型对齐 */
    total_buyers: number;
    /** member 视角恒为 1 */
    avg_buyers_per_trade: number;
    avg_success_rate: number;
    total_pnl_sol: number;
    avg_pnl_sol: number;
    /** 跟单总笔数（=total_trades 但语义更直白） */
    follow_trades: number;
    /** 独立交易笔数（被排除在跟单画像之外） */
    independent_trades: number;
  };
  trend: MemberTrendPoint[];
  tipDistribution: BuyerDistribution[];
  prioDistribution: BuyerDistribution[];
  pnlDistribution: BuyerDistribution[];
  topTargets: TopTarget[];
  /** 该地址跟单相关买入的「独立 vs 蹭车」拆分，仅成员视角需要 */
  roleBreakdown: {
    first_sniper: number;
    follower: number;
    pre_target: number;
    other: number;
  };
}

/** 共享的 AND 条件：限定为「跟单相关」买入 + 排除目标自身 + 排除 own + 窗口 */
function memberAndClause(address: string): string {
  return `
    bb.address = '${address}'
    AND bb.address IS NOT NULL
    AND bb.is_own = FALSE
    AND (
      bb.is_follower = TRUE
      OR bb.is_first_sniper = TRUE
      OR bb.is_pre_target = TRUE
    )
  `;
}

export async function getMemberAnalytics(address: string): Promise<MemberAnalytics> {
  // 1) summary
  //   - follow_trades: 跟单买入数（is_follower / is_first_sniper / is_pre_target 任一 TRUE）
  //   - independent_trades: 跟单条件为 FALSE 的买入（UI 上要让操作员知道"这个地址
  //     不只蹭车，还有 X 笔独立交易"）
  //   - pnl 只算 closed/partial（与 scoreMemberPnl 一致），避免被持仓中笔数稀释
  const summaryRow = await queryOne<any>(`
    SELECT
      COUNT(*) FILTER (WHERE
        bb.is_follower = TRUE OR bb.is_first_sniper = TRUE OR bb.is_pre_target = TRUE
      )::int                                                              AS follow_trades,
      COUNT(*) FILTER (WHERE NOT (
        bb.is_follower = TRUE OR bb.is_first_sniper = TRUE OR bb.is_pre_target = TRUE
      ))::int                                                            AS independent_trades,
      COUNT(*) FILTER (WHERE bb.pnl_status IN ('closed','partial'))::int  AS pnl_count,
      COUNT(*) FILTER (WHERE bb.pnl_status IN ('closed','partial')
                         AND bb.pnl_sol > 0)::int                         AS win_count,
      COALESCE(SUM(bb.pnl_sol)
        FILTER (WHERE bb.pnl_status IN ('closed','partial')), 0)::text    AS total_pnl,
      COALESCE(AVG(bb.pnl_sol)
        FILTER (WHERE bb.pnl_status IN ('closed','partial')), 0)::text    AS avg_pnl
    FROM block_buyers bb
    JOIN block_analyses ba ON ba.id = bb.block_analysis_id
    WHERE bb.address = $1
      AND ba.block_time >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'
  `, [address]);

  const followTrades = Number(summaryRow?.follow_trades ?? 0);
  const independentTrades = Number(summaryRow?.independent_trades ?? 0);
  const pnlCount = Number(summaryRow?.pnl_count ?? 0);
  const winCount = Number(summaryRow?.win_count ?? 0);
  const successRate = pnlCount > 0 ? winCount / pnlCount : 0;

  const summary = {
    total_trades: followTrades,
    total_buyers: 1,
    avg_buyers_per_trade: 1,
    avg_success_rate: parseFloat(successRate.toFixed(4)),
    total_pnl_sol: parseFloat(summaryRow?.total_pnl ?? '0'),
    avg_pnl_sol: parseFloat(summaryRow?.avg_pnl ?? '0'),
    follow_trades: followTrades,
    independent_trades: independentTrades,
  };

  // 2) trend (该地址自己的最近 30 笔「跟单」买入)
  //   列里有 target_address —— 这笔 buy 是蹭哪个目标的车
  //   前端可以借此展示「跟单历史时序」，区别于 target 视角的「同 slot 抢单者时序」
  const trend = await query<MemberTrendPoint>(`
    SELECT
      bb.signature AS trade_signature,
      ba.block_time,
      bb.slot,
      ba.mint,
      ba.target_address,
      bb.is_first_sniper,
      bb.is_follower,
      bb.is_pre_target,
      bb.buy_sol::text AS buy_sol,
      bb.tip_sol::text AS tip_sol,
      bb.prio_lamports,
      bb.block_index,
      bb.result,
      bb.pnl_sol::text AS pnl_sol
    FROM block_buyers bb
    JOIN block_analyses ba ON ba.id = bb.block_analysis_id
    WHERE ${memberAndClause(address)}
    ORDER BY ba.block_time DESC
    LIMIT 30
  `, []);

  // 3) tip 分布
  const tipRows = await query<any>(`
    SELECT bb.tip_sol::text AS tip, bb.result
      FROM block_buyers bb
      JOIN block_analyses ba ON ba.id = bb.block_analysis_id
     WHERE ${memberAndClause(address)}
       AND bb.tip_sol > 0
       AND ba.block_time >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'
  `, []);

  // 4) prio 分布
  const prioRows = await query<any>(`
    SELECT bb.prio_lamports AS prio, bb.result
      FROM block_buyers bb
      JOIN block_analyses ba ON ba.id = bb.block_analysis_id
     WHERE ${memberAndClause(address)}
       AND bb.prio_lamports > 0
       AND ba.block_time >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'
  `, []);

  // 5) PnL 分布
  const pnlRows = await query<any>(`
    SELECT bb.pnl_sol::text AS pnl, bb.result
      FROM block_buyers bb
      JOIN block_analyses ba ON ba.id = bb.block_analysis_id
     WHERE ${memberAndClause(address)}
       AND bb.pnl_sol IS NOT NULL
       AND ba.block_time >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'
  `, []);

  // 6) top targets (它蹭过哪些目标)
  //   GROUP BY ba.target_address。给的是「跟这个目标的车时，战绩 + 平均成本」，
  //   跟详情页 following 列表互补：following 列表给关系，本查询给"跟特定目标
  //   时的胜率/均买/均tip"，是「这个 follower 适合蹭谁」的判断依据。
  const topTargetsRaw = await query<any>(`
    SELECT
      ba.target_address AS address,
      COUNT(*)::int                                                       AS freq,
      SUM(CASE WHEN bb.result = 'success' THEN 1 ELSE 0 END)::int        AS win_count,
      SUM(CASE WHEN bb.result = 'failed' THEN 1 ELSE 0 END)::int         AS fail_count,
      AVG(bb.buy_sol)::text                                              AS avg_buy_sol,
      AVG(bb.tip_sol)::text                                              AS avg_tip_sol,
      AVG(bb.prio_lamports)::float                                       AS avg_prio_lamports,
      MAX(ba.block_time)                                                 AS last_seen_at
    FROM block_buyers bb
    JOIN block_analyses ba ON ba.id = bb.block_analysis_id
    WHERE ${memberAndClause(address)}
      AND ba.target_address IS NOT NULL
      AND ba.block_time >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'
    GROUP BY ba.target_address
    ORDER BY freq DESC
    LIMIT 15
  `, []);

  const topTargets: TopTarget[] = topTargetsRaw.map((r: any) => {
    const total = r.win_count + r.fail_count;
    return {
      address: r.address,
      freq: r.freq,
      win_count: r.win_count,
      fail_count: r.fail_count,
      win_rate: total > 0 ? parseFloat((r.win_count / total).toFixed(3)) : 0,
      avg_buy_sol: parseFloat(String(r.avg_buy_sol ?? '0')),
      avg_tip_sol: parseFloat(String(r.avg_tip_sol ?? '0')),
      avg_prio_lamports: parseFloat(String(r.avg_prio_lamports ?? 0)),
      last_seen_at: r.last_seen_at,
    };
  });

  // 7) roleBreakdown：first_sniper / follower / pre_target / other 的拆分。
  //   "other" = 跟单条件 FALSE 的（独立交易），UI 上要单独一行展示
  //   "这个地址 60% 是同 slot 蹭车、20% 是 +1 slot、20% 是独立交易" 这种比例。
  const roleRow = await queryOne<any>(`
    SELECT
      COUNT(*) FILTER (WHERE bb.is_first_sniper = TRUE)::int                            AS first_sniper,
      COUNT(*) FILTER (WHERE bb.is_follower = TRUE
                       AND bb.is_first_sniper = FALSE)::int                            AS follower,
      COUNT(*) FILTER (WHERE bb.is_pre_target = TRUE
                       AND bb.is_follower = FALSE
                       AND bb.is_first_sniper = FALSE)::int                            AS pre_target,
      COUNT(*) FILTER (WHERE NOT (
        bb.is_follower = TRUE OR bb.is_first_sniper = TRUE OR bb.is_pre_target = TRUE
      ))::int                                                                          AS other
    FROM block_buyers bb
    JOIN block_analyses ba ON ba.id = bb.block_analysis_id
    WHERE bb.address = $1
      AND ba.block_time >= NOW() - INTERVAL '${LOOKBACK_DAYS} days'
  `, [address]);

  return {
    view: 'member',
    summary,
    trend,
    tipDistribution: bucketizeTip(tipRows),
    prioDistribution: bucketizePrio(prioRows),
    pnlDistribution: bucketizePnl(pnlRows),
    topTargets,
    roleBreakdown: {
      first_sniper: Number(roleRow?.first_sniper ?? 0),
      follower: Number(roleRow?.follower ?? 0),
      pre_target: Number(roleRow?.pre_target ?? 0),
      other: Number(roleRow?.other ?? 0),
    },
  };
}

/**
 * 路由层统一入口：按 monitored_targets 表分流。
 *
 * target 走 getAnalytics（竞争分析维度），member 走 getMemberAnalytics（自身画像维度）。
 * 注意：路由层用 monitored_targets.status='active' 判断「现在是不是被监控的 target」，
 * 不依赖 pool_members.promoted_to_target（这是历史遗留状态，不是真实状态）。
 */
export async function getAnalyticsFor(address: string): Promise<
  | { view: 'target'; data: Awaited<ReturnType<typeof getAnalytics>> }
  | { view: 'member'; data: MemberAnalytics }
> {
  const isTarget = await queryOne<{ one: number }>(
    `SELECT 1 AS one FROM monitored_targets WHERE address = $1 AND status = 'active' LIMIT 1`,
    [address],
  );
  if (isTarget) {
    return { view: 'target', data: await getAnalytics(address) };
  }
  return { view: 'member', data: await getMemberAnalytics(address) };
}