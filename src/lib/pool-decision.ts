/**
 * 池子决策 (Decision Support)
 *
 * 1) 手续费推荐器：
 *    给定一个地址，统计它抢单时实际交了多少钱，给出 P50 / P75 推荐值。
 *    - target 视角：该 target 所在 block 的同 mint 竞价者（别人跟它要交多少才抢得到）
 *    - member 视角：该地址自己历次买入实际交的 tip / prio（它自己花多少）
 *
 * 2) 是否值得跟评分 (Worth-Following Score):
 *    score = median_pnl * win_rate / log(1 + cost_ratio)
 *
 * ── 视角分离（2026-10-05 重写）────────────────────────────────────────
 *
 * 旧实现只有一个 scoreWorthFollowing()，一律查 `target_trades.target_address`。
 * 但 target_trades 存的是**被监控的 target 自己**的买入，而 pool_members 里
 * 绝大多数成员是**跟单买家**，它们的买入落在 block_buyers。
 * 结果：71 个非 target 成员查出来 0 行，trade_count=0，恒为 0 分。
 * 现在按身份分开取数，monitored_targets 走 target_trades，其余走 block_buyers。
 *
 * ── 四个已修的正确性问题 ──────────────────────────────────────────────
 *
 * 1) 零费率把分数放大到 3e8：
 *    旧式子 `avgPnl * winRate / log(1 + costRatio + 1e-9)`。costRatio=0（没交过
 *    手续费）时分母是 1e-9，除出来 3 亿。那个 +1e-9 本意防除零，实际把崩溃
 *    换成了静默的巨大分数。现在对 costRatio 取 MIN_COST_RATIO 下限。
 *
 * 2) 胜率的分母和分子不是同一批交易：
 *    旧式子 winCount 数 `pnl_sol > 0`（NULL 不计入），分母却用 `COUNT(*)`
 *    （含所有 pnl 为 NULL 的行）。回填进度越低，胜率被压得越低，排序全错。
 *    现在分子分母统一到「已实现 pnl 的那批交易」。
 *
 * 3) PnL 用均值，被极端值主导：
 *    block_buyers 里单笔 pnl 最大到 6.46 SOL，而多数远小于此，均值会被一笔
 *    大赢主导。评分改用中位数，均值仍返回给 UI 展示。
 *
 * 4) 百分位偏一格：
 *    旧 `Math.floor(n * p)`：n=2、p=0.5 时 idx=1，返回的是最大值而不是中位数，
 *    P50/P75 系统性偏高。改成线性插值（R type 7）。
 *
 * ── 算不出分时写 null，不写 0 ──────────────────────────────────────────
 *
 * 样本不足 / 买入金额缺失时 offered 返回 null。写 0 会把「还没数据」伪装成
 * 「跟了但没赚」，在 0.4% 回填率下几乎所有成员都是这种假 0。
 * pool_members.worth_score 为 NULL 时页面显示 '-'，排序也自动排到最后
 * （listPoolMembers 用的是 worth_score DESC NULLS LAST）。
 */

import { query, queryOne } from './db';

const RECENT_TRADES = parseInt(process.env.POOL_RECENT_TRADES || '50', 10);
const LOOKBACK_DAYS = parseInt(process.env.POOL_LOOKBACK_DAYS || '30', 10);

/** 计入评分所需的最少已实现样本数。低于此值一律不给分（返回 null） */
const MIN_SAMPLES = parseInt(process.env.POOL_SCORE_MIN_SAMPLES || '3', 10);
/**
 * cost_ratio 下限，取 0.5%。
 *
 * 两个理由：
 *   1) 防零费率除零放大（见文件头问题 1）。
 *   2) block_buyers 只存了 tip_sol + prio_lamports，**没存 base fee**。
 *      pump.fun 一笔买入的 base fee 约 5000~10000 lamports，对 avg_buy 1.9 SOL
 *      约 0.03%~0.05%，这个下限足以覆盖它。
 */
const MIN_COST_RATIO = parseFloat(process.env.POOL_SCORE_MIN_COST_RATIO || '0.005');

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
  /** 数据新鲜度（最近一笔买入时间） */
  last_buy_at: string | null;
}

export interface WorthScore {
  /**
   * 综合评分。**null 表示算不出分**（样本不足 / 买入金额缺失），不是 0 分。
   * 调用方渲染前必须判空 —— `offered.toFixed(2)` 在 null 上会抛。
   */
  offered: number | null;
  win_rate: number;
  /** 均值，仅供展示；评分用的是中位数 */
  avg_pnl_sol: number;
  median_pnl_sol: number;
  total_pnl_sol: number;
  avg_fee_sol: number;
  cost_ratio: number;
  /** 计入评分的样本数（已实现 pnl 的笔数） */
  trade_count: number;
  /** 回溯窗口内该地址的买入总笔数，含持仓中等算不出 pnl 的 */
  total_buys: number;
  /** 算不出分的原因；给分为 null 时非空，供 UI 展示 */
  reason: string | null;
  computed_at: string;
}

/** 算分前的原始统计量，target / member 两种视角共用 */
interface PnlSample {
  pnl_count: number;      // 有已实现 pnl 的笔数
  win_count: number;      // 其中 pnl > 0 的笔数
  median_pnl: number;     // 中位数，评分用
  avg_pnl: number;        // 均值，展示用
  total_pnl: number;
  avg_fee: number;
  avg_buy: number;
  total_buys: number;     // 窗口内买入总笔数
  open_count: number;     // 持仓中，pnl 未实现
}

function readSample(row: any): PnlSample {
  return {
    pnl_count: Number(row?.pnl_count ?? 0),
    win_count: Number(row?.win_count ?? 0),
    median_pnl: parseFloat(row?.median_pnl ?? '0') || 0,
    avg_pnl: parseFloat(row?.avg_pnl ?? '0') || 0,
    total_pnl: parseFloat(row?.total_pnl ?? '0') || 0,
    avg_fee: parseFloat(row?.avg_fee ?? '0') || 0,
    avg_buy: parseFloat(row?.avg_buy ?? '0') || 0,
    total_buys: Number(row?.total_buys ?? 0),
    open_count: Number(row?.open_count ?? 0),
  };
}

/** 把原始统计量换算成评分。target / member 共用，保证两边口径不会漂。 */
function scoreFromSample(s: PnlSample): WorthScore {
  const winRate = s.pnl_count > 0 ? s.win_count / s.pnl_count : 0;
  // 分母与分子同源：都只算已实现 pnl 的那批交易（修复旧实现的样本集不一致）
  const costRatio = Math.max(s.avg_buy > 0 ? s.avg_fee / s.avg_buy : 0, MIN_COST_RATIO);

  const base = {
    win_rate: parseFloat(winRate.toFixed(4)),
    avg_pnl_sol: parseFloat(s.avg_pnl.toFixed(6)),
    median_pnl_sol: parseFloat(s.median_pnl.toFixed(6)),
    total_pnl_sol: parseFloat(s.total_pnl.toFixed(6)),
    avg_fee_sol: parseFloat(s.avg_fee.toFixed(6)),
    cost_ratio: parseFloat(costRatio.toFixed(6)),
    trade_count: s.pnl_count,
    total_buys: s.total_buys,
    computed_at: new Date().toISOString(),
  };

  if (s.pnl_count < MIN_SAMPLES) {
    return {
      ...base,
      offered: null,
      reason:
        `已实现收益样本 ${s.pnl_count} 笔，少于所需的 ${MIN_SAMPLES} 笔` +
        (s.open_count > 0 ? `（另有 ${s.open_count} 笔持仓中，收益未实现）` : ''),
    };
  }
  if (s.avg_buy <= 0) {
    return { ...base, offered: null, reason: '买入金额缺失，成本占比无从计算' };
  }

  // 中位数而非均值：一笔 6.46 SOL 的大赢不该把整个地址的评分抬上去
  const score = (s.median_pnl * winRate) / Math.log(1 + costRatio);
  return { ...base, offered: parseFloat(score.toFixed(4)), reason: null };
}

/**
 * 单个 target 的手续费推荐：同 slot 内、目标之外的同 mint 买家交了多少。
 * 语义是「要跟进这一笔得交多少才抢得到」。
 */
export async function recommendFeeForTarget(targetAddress: string): Promise<FeeRecommendation> {
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

  return summarizeFees(
    buyerRows.map((b: any) => ({
      tip: parseFloat(b.tip_sol ?? '0'),
      prio: Number(b.prio_lamports ?? 0),
      result: b.result,
      at: b.block_time,
    })),
  );
}

/**
 * 单个 pool member 的手续费推荐：它自己历次买入实际交了多少。
 *
 * 不能复用 target 视角那条 SQL —— 那条按 target_trades.target_address 过滤，
 * member 在 target_trades 里根本不存在，查出来永远是空，
 * 于是 recommended_tip_sol 恒为 0（页面上因为 0 是 falsy 一直显示 '-'）。
 */
export async function recommendFeeForMember(address: string): Promise<FeeRecommendation> {
  const buyerRows = await query<any>(`
    SELECT bb.tip_sol::text, bb.prio_lamports, bb.result, bb.is_first_sniper,
           bb.buy_sol::text, ba.block_time
      FROM block_buyers bb
      JOIN block_analyses ba ON ba.id = bb.block_analysis_id
     WHERE bb.address = $1
       AND ba.block_time >= NOW() - (($2 || ' days')::interval)
     ORDER BY ba.block_time DESC
     LIMIT $3
  `, [address, LOOKBACK_DAYS, RECENT_TRADES * 20]);

  return summarizeFees(
    buyerRows.map((b: any) => ({
      tip: parseFloat(b.tip_sol ?? '0'),
      prio: Number(b.prio_lamports ?? 0),
      result: b.result,
      at: b.block_time,
    })),
  );
}

function summarizeFees(
  rows: Array<{ tip: number; prio: number; result: string; at: any }>,
): FeeRecommendation {
  const successTips: number[] = [];
  const successPrios: number[] = [];
  const failedTips: number[] = [];
  const failedPrios: number[] = [];
  let lastBuy: string | null = null;

  for (const b of rows) {
    if (!lastBuy || new Date(b.at) > new Date(lastBuy)) lastBuy = b.at;
    if (b.result === 'success') {
      if (b.tip > 0) successTips.push(b.tip);
      if (b.prio > 0) successPrios.push(b.prio);
    } else if (b.result === 'failed') {
      if (b.tip > 0) failedTips.push(b.tip);
      if (b.prio > 0) failedPrios.push(b.prio);
    }
  }

  return {
    p50_tip_sol: percentile(successTips, 0.5),
    p50_prio_lamports: Math.round(percentile(successPrios, 0.5)),
    p75_tip_sol: percentile(successTips, 0.75),
    p75_prio_lamports: Math.round(percentile(successPrios, 0.75)),
    success_count: Math.max(successTips.length, successPrios.length),
    failed_p50_tip_sol: percentile(failedTips, 0.5),
    failed_p50_prio_lamports: Math.round(percentile(failedPrios, 0.5)),
    failed_count: Math.max(failedTips.length, failedPrios.length),
    sample_size: rows.length,
    last_buy_at: lastBuy,
  };
}

/** target 自己跟单的收益：数据源 target_trades（该 target 本人的买入） */
export async function scoreTargetPnl(targetAddress: string): Promise<WorthScore> {
  const row = await queryOne<any>(`
    SELECT
      count(pnl_sol)::int                                          AS pnl_count,
      count(*) FILTER (WHERE pnl_sol > 0)::int                     AS win_count,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY pnl_sol)::text   AS median_pnl,
      COALESCE(AVG(pnl_sol), 0)::text                              AS avg_pnl,
      COALESCE(SUM(pnl_sol), 0)::text                              AS total_pnl,
      COALESCE(AVG(COALESCE(fee_sol, target_tip_sol + target_prio_lamports / 1e9))
                 FILTER (WHERE pnl_sol IS NOT NULL), 0)::text      AS avg_fee,
      COALESCE(AVG(buy_sol) FILTER (WHERE pnl_sol IS NOT NULL), 0)::text AS avg_buy,
      count(*)::int                                                AS total_buys,
      count(*) FILTER (WHERE pnl_sol IS NULL)::int                 AS open_count
    FROM target_trades
    WHERE target_address = $1
      AND block_time >= NOW() - (($2 || ' days')::interval)
  `, [targetAddress, LOOKBACK_DAYS]);

  return scoreFromSample(readSample(row));
}

/**
 * pool member 自己跟单的收益：数据源 block_buyers（它是买家，不是 target）。
 *
 * 只统计 pnl_status 为 closed / partial 的行：
 *   - open（持仓中）pnl_sol 是 NULL，收益未实现。既不能算赢也不能算输，
 *     算进去只会稀释胜率，所以整个排除（分子分母一起排）。
 *   - buy_failed 的亏损来自那笔交易本身失败，不是这个地址选错了标的，
 *     计入只会稀释「跟这个地址赚不赚钱」的信号，同样排除。
 */
export async function scoreMemberPnl(address: string): Promise<WorthScore> {
  const row = await queryOne<any>(`
    SELECT
      count(*) FILTER (WHERE bb.pnl_status IN ('closed','partial'))::int AS pnl_count,
      count(*) FILTER (WHERE bb.pnl_status IN ('closed','partial')
                         AND bb.pnl_sol > 0)::int                       AS win_count,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY bb.pnl_sol)
        FILTER (WHERE bb.pnl_status IN ('closed','partial'))::text      AS median_pnl,
      COALESCE(AVG(bb.pnl_sol)
        FILTER (WHERE bb.pnl_status IN ('closed','partial')), 0)::text  AS avg_pnl,
      COALESCE(SUM(bb.pnl_sol)
        FILTER (WHERE bb.pnl_status IN ('closed','partial')), 0)::text  AS total_pnl,
      -- 注意：block_buyers 没存 base fee，这里只有 tip + prio。
      -- 缺失的 base fee 由 MIN_COST_RATIO 下限覆盖（见文件头说明）。
      COALESCE(AVG(COALESCE(bb.tip_sol, 0) + COALESCE(bb.prio_lamports, 0) / 1e9)
        FILTER (WHERE bb.pnl_status IN ('closed','partial')), 0)::text  AS avg_fee,
      COALESCE(AVG(bb.buy_sol)
        FILTER (WHERE bb.pnl_status IN ('closed','partial')), 0)::text  AS avg_buy,
      count(*)::int                                                    AS total_buys,
      count(*) FILTER (WHERE bb.pnl_status = 'open')::int              AS open_count
    FROM block_buyers bb
    JOIN block_analyses ba ON ba.id = bb.block_analysis_id
    WHERE bb.address = $1
      AND ba.block_time >= NOW() - (($2 || ' days')::interval)
  `, [address, LOOKBACK_DAYS]);

  return scoreFromSample(readSample(row));
}

/** 该地址是不是一个被监控的 target（决定用哪套视角取数） */
export async function isMonitoredTarget(address: string): Promise<boolean> {
  const row = await queryOne<{ one: number }>(
    'SELECT 1 AS one FROM monitored_targets WHERE address = $1 LIMIT 1',
    [address],
  );
  return !!row;
}

/**
 * 统一入口：按身份自动选视角。
 * 保留这个函数名是为了不改 4 个调用点（targets 路由、pool analytics 路由、worker 等）。
 */
export async function scoreWorthFollowing(address: string): Promise<WorthScore> {
  return (await isMonitoredTarget(address))
    ? scoreTargetPnl(address)
    : scoreMemberPnl(address);
}

/** 手续费推荐的统一入口，同样按身份分流 */
export async function recommendFee(address: string): Promise<FeeRecommendation> {
  return (await isMonitoredTarget(address))
    ? recommendFeeForTarget(address)
    : recommendFeeForMember(address);
}

/**
 * 重算 pool_members 的决策（worth_score / recommended_tip_sol / recommended_prio_lamports）。
 *
 * worth_score 算不出时写 NULL 而不是 0 —— 页面上显示 '-'，排序自动排最后。
 * recommended_tip_sol 照常写：手续费推荐不依赖 pnl 回填，回填没做完也能给建议。
 */
export async function recomputeAllDecisions(): Promise<{
  scoredTargets: number;
  scoredPoolMembers: number;
  unscoreable: number;
  durationMs: number;
}> {
  const t0 = Date.now();
  // 复用 POOL_PROMOTE_FREQ 作为「池里值得给人看的成员」门槛：
  //   - 自动晋升开启时，这个阈值就是晋升门槛
  //   - 自动晋升关闭时（默认），相当于「freq >= N 的成员都进 worth_score 重算，
  //     池页面按分数排序给人手动选」。改名 POOL_SCORE_MIN_FREQ 会更准确但要
  //     同步改 .env + 历史部署，先复用同一组环境变量。
  const freqMin = parseInt(process.env.POOL_PROMOTE_FREQ || '8', 10);

  const targets = await query<any>(
    `SELECT address FROM monitored_targets WHERE status = 'active'`,
  );
  const members = await query<any>(`
    SELECT address FROM pool_members
     WHERE promoted_to_target = false AND freq >= $1
  `, [freqMin]);

  let scoredTargets = 0;
  let scoredPoolMembers = 0;
  let unscoreable = 0;

  const run = async (address: string, isTarget: boolean) => {
    const score = isTarget
      ? await scoreTargetPnl(address)
      : await scoreMemberPnl(address);
    const fee = isTarget
      ? await recommendFeeForTarget(address)
      : await recommendFeeForMember(address);
    await query(
      `UPDATE pool_members
          SET worth_score = $2,
              recommended_tip_sol = $3,
              recommended_prio_lamports = $4,
              score_updated_at = NOW()
        WHERE address = $1`,
      [address, score.offered, fee.p75_tip_sol, fee.p75_prio_lamports],
    );
    if (score.offered === null) unscoreable++;
  };

  for (const t of targets) {
    try {
      await run(t.address, true);
      scoredTargets++;
    } catch (err) {
      console.warn('[pool-decision] target failed', t.address, err);
    }
  }
  for (const m of members) {
    try {
      await run(m.address, false);
      scoredPoolMembers++;
    } catch (err) {
      console.warn('[pool-decision] member failed', m.address, err);
    }
  }

  return {
    scoredTargets,
    scoredPoolMembers,
    unscoreable,
    durationMs: Date.now() - t0,
  };
}

/** 给 monitored_targets 上的所有 active target 实时拉取决策（API 调用，不写库） */
export async function getDecisionsForMonitorTargets(): Promise<
  Record<string, { score: WorthScore; fee: FeeRecommendation }>
> {
  const targets = await query<any>(
    `SELECT address FROM monitored_targets WHERE status = 'active'`,
  );
  const out: Record<string, { score: WorthScore; fee: FeeRecommendation }> = {};
  await Promise.all(targets.map(async (t) => {
    try {
      const [score, fee] = await Promise.all([
        scoreTargetPnl(t.address),
        recommendFeeForTarget(t.address),
      ]);
      out[t.address] = { score, fee };
    } catch (err) {
      // 单个失败不影响其他
    }
  }));
  return out;
}

/**
 * 线性插值百分位（R type 7）。
 *
 * 旧实现是 `Math.floor(n * p)`：n=2、p=0.5 时 idx=1，取到的是最大值而不是
 * 中位数，P50/P75 被系统性抬高。样本量越小偏得越多，恰恰是推荐费最需要准的时候。
 */
function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
