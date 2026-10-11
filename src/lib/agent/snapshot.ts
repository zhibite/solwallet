'use server';

import { query, queryOne } from '../db';

export interface TargetSnapshot {
  // Target identity
  target_id: number;
  target_address: string;
  target_label: string | null;
  target_status: 'active' | 'paused' | 'deleted';
  agent_shadow: boolean;

  // akbot mapping
  akbot_id_config: number | null;
  akbot_user_id: number | null;

  // Current target settings
  threshold_sol: number;
  current_params: {
    position_sol: number | null;
    tip_sol: number | null;
    gas_sol: number | null;
    slippage: number | null;
    high_gas_mode: boolean;
    high_gas_sol: number | null;
    high_gas_tip_sol: number | null;
    high_gas_slippage: number | null;
  } | null;
  
  // Historical performance stats
  stats: {
    total_trades: number;
    winners: number;
    losers: number;
    with_profit: number;
    profitable: number;
    win_rate: number;
    avg_profit: number | null;      // SOL
    total_profit: number | null;    // SOL
    avg_holding_time: number | null; // seconds
    pnl_missing: boolean;
  };
  
  // Tip source stats
  tip_stats: {
    median_tip: number | null;
    median_prio: number | null;
    target_tip_max: number | null;
    target_prio_max: number | null;
    tip_sources: Record<string, number>;
  };
  
  // Our performance for this target (from block_buyers.is_own)
  our_stats: {
    trades: number;
    wins: number;
    total_pnl: number | null;
    profit_missing: boolean;
  };
  
  // Gas competitiveness
  gas_analysis: {
    our_gas: number | null;
    target_tip_max: number | null;
    competitive: boolean | null;
    reason: string | null;
  };
  
  // Recommendation from stats
  recommendation: {
    suggested_action: 'enable' | 'disable' | 'delete' | 'limit_update' | 'hold';
    suggested_params: Record<string, number | boolean> | null;
    reason: string;
  };
  
  // Context for LLM
  llm_context: string;
}

interface TradeRow {
  id: number;
  pnl_sol: number | null;
  target_tip_sol: number | null;
  target_prio_lamports: number | null;
  tip_source: string | null;
  first_sniper_tip_sol: number | null;
}

interface OurTradeRow {
  pnl_sol: number | null;
}

interface TargetRow {
  id: number;
  address: string;
  label: string | null;
  status: 'active' | 'paused' | 'deleted';
  threshold_sol: number;
  agent_params: Record<string, unknown> | null;
  agent_shadow: boolean | null;
}

export async function generateTargetSnapshot(targetId: number): Promise<TargetSnapshot | null> {
  // 单 target 路径：仍然走 2 次查询，但复用 buildSnapshotFromData 保持逻辑一致。
  const target = await queryOne<TargetRow>(
    `SELECT id, address, label, status, threshold_sol, agent_params, agent_shadow
     FROM monitored_targets WHERE id = $1`,
    [targetId]
  );

  if (!target) return null;

  const trades = await query<TradeRow>(
    `SELECT id, pnl_sol, target_tip_sol, target_prio_lamports, tip_source, first_sniper_tip_sol
     FROM target_trades
     WHERE target_id = $1 AND status = 'confirmed'
     ORDER BY block_time DESC
     LIMIT 100`,
    [targetId]
  );

  const ourTrades = await query<OurTradeRow>(
    `SELECT bb.pnl_sol
     FROM block_buyers bb
     JOIN block_analyses ba ON bb.block_analysis_id = ba.id
     JOIN target_trades tt ON ba.slot = tt.slot AND ba.mint = tt.mint
     WHERE tt.target_id = $1 AND bb.is_own = TRUE`,
    [targetId]
  );

  const ourPnl = ourTrades
    .filter(t => t.pnl_sol !== null)
    .map(t => t.pnl_sol!);

  const akbotMap = await queryOne<{ akbot_id_config: number; akbot_user_id: number }>(
    `SELECT akbot_id_config, akbot_user_id FROM akbot_target_map WHERE monitored_target_id = $1`,
    [targetId],
  );

  return buildSnapshotFromData(target, trades, ourPnl, akbotMap ?? null);
}

export async function generateSnapshotsForAllTargets(): Promise<TargetSnapshot[]> {
  // N+1 修复：原来每个 target 跑 2-3 个查询，10 个 target = 20-30 次串行往返。
  // 改为：1 次拿所有 target，1 次拿所有 target_trades，1 次拿所有 our trades，
  // 在 JS 里按 target_id 聚合。3 次往返 vs N×3 次。
  const targets = await query<TargetRow>(
    `SELECT id, address, label, status, threshold_sol, agent_params, agent_shadow
     FROM monitored_targets WHERE status != 'deleted' ORDER BY id`
  );

  if (targets.length === 0) return [];

  const targetIds = targets.map(t => t.id);

  // 批量取 target_trades
  // 关键：必须按 target_id 分桶再取最新 N 条，否则 ORDER BY block_time DESC + LIMIT 全局
  // 会让"最近 N 笔"全被高频狙击手占走，其他 target 拿到 0 笔（Fix #2）。
  // 用 ROW_NUMBER() OVER (PARTITION BY target_id) 在 SQL 端分桶，比 LATERAL JOIN 简洁。
  const allTrades = await query<TradeRow & { target_id: number }>(
    `SELECT target_id, id, pnl_sol, target_tip_sol, target_prio_lamports, tip_source, first_sniper_tip_sol
     FROM (
       SELECT target_id, id, pnl_sol, target_tip_sol, target_prio_lamports, tip_source, first_sniper_tip_sol,
              ROW_NUMBER() OVER (PARTITION BY target_id ORDER BY block_time DESC) AS rn
       FROM target_trades
       WHERE target_id = ANY($1) AND status = 'confirmed'
     ) t
     WHERE rn <= $2`,
    [targetIds, 100]  // 每 target 最多 100 条
  );

  // 批量取 our trades
  const allOurTrades = await query<{ pnl_sol: number | null; target_id: number }>(
    `SELECT tt.target_id, bb.pnl_sol
     FROM block_buyers bb
     JOIN block_analyses ba ON bb.block_analysis_id = ba.id
     JOIN target_trades tt ON ba.slot = tt.slot AND ba.mint = tt.mint
     WHERE tt.target_id = ANY($1) AND bb.is_own = TRUE`,
    [targetIds]
  );

  // 按 target_id 分组
  const tradesByTarget = new Map<number, TradeRow[]>();
  for (const trade of allTrades) {
    const arr = tradesByTarget.get(trade.target_id) || [];
    arr.push({
      id: trade.id,
      pnl_sol: trade.pnl_sol,
      target_tip_sol: trade.target_tip_sol,
      target_prio_lamports: trade.target_prio_lamports,
      tip_source: trade.tip_source,
      first_sniper_tip_sol: trade.first_sniper_tip_sol,
    });
    tradesByTarget.set(trade.target_id, arr);
  }

  const ourPnlByTarget = new Map<number, number[]>();
  for (const t of allOurTrades) {
    if (t.pnl_sol !== null) {
      const arr = ourPnlByTarget.get(t.target_id) || [];
      arr.push(t.pnl_sol);
      ourPnlByTarget.set(t.target_id, arr);
    }
  }

  // 批量取 akbot 映射（避免每个 target 再查一次）
  const allMaps = await query<{ monitored_target_id: number; akbot_id_config: number; akbot_user_id: number }>(
    `SELECT monitored_target_id, akbot_id_config, akbot_user_id
     FROM akbot_target_map
     WHERE monitored_target_id = ANY($1)`,
    [targetIds]
  );
  const mapByTarget = new Map<number, { akbot_id_config: number; akbot_user_id: number }>();
  for (const m of allMaps) {
    mapByTarget.set(m.monitored_target_id, {
      akbot_id_config: m.akbot_id_config,
      akbot_user_id: m.akbot_user_id,
    });
  }

  // 构造 snapshot（保持与 generateTargetSnapshot 同样的输出结构）
  const snapshots: TargetSnapshot[] = [];
  for (const target of targets) {
    const trades = tradesByTarget.get(target.id) || [];
    const ourPnl = ourPnlByTarget.get(target.id) || [];
    const map = mapByTarget.get(target.id) ?? null;
    const snap = buildSnapshotFromData(target, trades, ourPnl, map);
    if (snap) snapshots.push(snap);
  }
  return snapshots;
}

/**
 * Pure (DB-free) snapshot builder used by both single-target and batch paths.
 * 输入：target 元数据 + 该 target 的 trades + 该 target 的 our trades
 * 输出：完整 TargetSnapshot
 */
function buildSnapshotFromData(
  target: TargetRow,
  trades: TradeRow[],
  ourPnl: number[],
  akbotMap: { akbot_id_config: number; akbot_user_id: number } | null = null,
): TargetSnapshot | null {
  const totalTrades = trades.length;
  const winners = trades.filter(t => t.pnl_sol !== null && t.pnl_sol > 0).length;
  const losers = trades.filter(t => t.pnl_sol !== null && t.pnl_sol < 0).length;
  const withProfit = trades.filter(t => t.pnl_sol !== null).length;
  const profitable = trades.filter(t => t.pnl_sol !== null && t.pnl_sol > 0).length;
  const winRate = totalTrades > 0 ? winners / totalTrades : 0;

  const profits = trades
    .filter(t => t.pnl_sol !== null)
    .map(t => t.pnl_sol!);
  const avgProfit = profits.length > 0 ? profits.reduce((a, b) => a + b, 0) / profits.length : null;
  const totalProfit = profits.length > 0 ? profits.reduce((a, b) => a + b, 0) : null;

  const tips = trades
    .map(t => t.target_tip_sol)
    .filter((t): t is number => t !== null && t > 0)
    .sort((a, b) => a - b);
  const prios = trades
    .map(t => t.target_prio_lamports)
    .filter((p): p is number => p !== null && p > 0)
    .sort((a, b) => a - b);
  const priosSol = prios.map(p => p / 1e9);

  const medianTip = tips.length > 0
    ? tips.length % 2 === 0
      ? (tips[tips.length / 2 - 1] + tips[tips.length / 2]) / 2
      : tips[Math.floor(tips.length / 2)]
    : null;
  const medianPrio = priosSol.length > 0
    ? priosSol.length % 2 === 0
      ? (priosSol[priosSol.length / 2 - 1] + priosSol[priosSol.length / 2]) / 2
      : priosSol[Math.floor(priosSol.length / 2)]
    : null;

  const firstSniperTips = trades
    .map(t => t.first_sniper_tip_sol)
    .filter((t): t is number => t !== null && t > 0);
  const targetTipMax = firstSniperTips.length > 0 ? Math.max(...firstSniperTips) : null;
  const targetPrioMax = medianPrio;

  const tipSources: Record<string, number> = {};
  for (const trade of trades) {
    if (trade.tip_source) {
      tipSources[trade.tip_source] = (tipSources[trade.tip_source] || 0) + 1;
    }
  }

  const ourGas = target.agent_params?.gas_sol as number | null || null;
  let gasCompetitive: boolean | null = null;
  let gasReason: string | null = null;
  if (ourGas !== null && targetTipMax !== null) {
    gasCompetitive = ourGas >= targetTipMax * 0.8;
    gasReason = gasCompetitive
      ? `我方 gas ${ourGas.toFixed(4)} >= 目标 ${targetTipMax.toFixed(4)} * 0.8`
      : `我方 gas ${ourGas.toFixed(4)} < 目标 ${targetTipMax.toFixed(4)} * 0.8`;
  } else if (ourGas === null && targetTipMax !== null) {
    gasReason = '我方尚未设置 gas 参数';
  }

  const suggestedAction = generateSuggestion(target, totalTrades, winRate, avgProfit, ourPnl);
  const suggestedParams = generateSuggestedParams(target, trades, avgProfit);
  const llmContext = generateLLMContext(target, {
    totalTrades,
    winners,
    withProfit,
    profitable,
    winRate,
    avgProfit,
    medianTip,
    medianPrio,
    targetTipMax,
    targetPrioMax,
    ourGas,
    gasCompetitive,
    gasReason,
    ourTrades: ourPnl.length,
    ourWins: ourPnl.filter(p => p > 0).length,
    ourPnl: ourPnl.length > 0 ? ourPnl.reduce((a, b) => a + b, 0) : null,
    akbotIdConfig: akbotMap?.akbot_id_config ?? null,
  });

  return {
    target_id: target.id,
    target_address: target.address,
    target_label: target.label,
    target_status: target.status,
    agent_shadow: target.agent_shadow ?? false,
    akbot_id_config: akbotMap?.akbot_id_config ?? null,
    akbot_user_id: akbotMap?.akbot_user_id ?? null,
    threshold_sol: target.threshold_sol,
    current_params: target.agent_params as TargetSnapshot['current_params'],
    stats: {
      total_trades: totalTrades,
      winners,
      losers,
      with_profit: withProfit,
      profitable,
      win_rate: winRate,
      avg_profit: avgProfit,
      total_profit: totalProfit,
      avg_holding_time: null,
      pnl_missing: totalTrades === 0,
    },
    tip_stats: {
      median_tip: medianTip,
      median_prio: medianPrio,
      target_tip_max: targetTipMax,
      target_prio_max: targetPrioMax,
      tip_sources: tipSources,
    },
    our_stats: {
      trades: ourPnl.length,
      wins: ourPnl.filter(p => p > 0).length,
      total_pnl: ourPnl.length > 0 ? ourPnl.reduce((a, b) => a + b, 0) : null,
      profit_missing: ourPnl.length === 0,
    },
    gas_analysis: {
      our_gas: ourGas,
      target_tip_max: targetTipMax,
      competitive: gasCompetitive,
      reason: gasReason,
    },
    recommendation: {
      suggested_action: suggestedAction,
      suggested_params: suggestedParams,
      reason: generateReason(target, totalTrades, winRate, avgProfit, ourPnl),
    },
    llm_context: llmContext,
  };
}

function generateSuggestion(
  target: TargetRow,
  totalTrades: number,
  winRate: number,
  avgProfit: number | null,
  ourPnl: number[]
): 'enable' | 'disable' | 'delete' | 'limit_update' | 'hold' {
  // No data
  if (totalTrades === 0) return 'hold';
  
  // Deleted targets
  if (target.status === 'deleted') return 'delete';
  
  // Paused targets - check if should enable
  if (target.status === 'paused') {
    if (winRate > 0.5 && (avgProfit === null || avgProfit > 0)) {
      return 'enable';
    }
    return 'hold';
  }
  
  // Active targets - check if should adjust/pause/delete
  if (totalTrades >= 3) {
    // Bad performance
    if (winRate < 0.3 || (avgProfit !== null && avgProfit < -0.1)) {
      return 'disable';
    }
    
    // No profit at all
    if (ourPnl.length > 0) {
      const ourTotal = ourPnl.reduce((a, b) => a + b, 0);
      if (ourTotal < -0.5) {
        return 'disable';
      }
    }
    
    // Should adjust params
    if (avgProfit !== null && Math.abs(avgProfit) > 0.01) {
      return 'limit_update';
    }
  }
  
  return 'hold';
}

function generateSuggestedParams(
  target: TargetRow,
  trades: TradeRow[],
  avgProfit: number | null
): Record<string, number | boolean> | null {
  if (trades.length < 3) return null;
  
  const params: Record<string, number | boolean> = {};
  
  // Suggest position size based on win rate
  const winRate = trades.filter(t => (t.pnl_sol ?? 0) > 0).length / trades.length;
  if (winRate > 0.6) {
    params.position_sol = 2.0;
  } else if (winRate > 0.4) {
    params.position_sol = 1.0;
  } else {
    params.position_sol = 0.5;
  }
  
  // Suggest gas based on avg profit
  if (avgProfit !== null && avgProfit > 0.1) {
    params.gas_sol = 0.005;
    params.high_gas_mode = true;
    params.high_gas_tip_sol = 0.015;
  }
  
  return Object.keys(params).length > 0 ? params : null;
}

function generateReason(
  target: TargetRow,
  totalTrades: number,
  winRate: number,
  avgProfit: number | null,
  ourPnl: number[]
): string {
  if (totalTrades === 0) {
    return `无交易数据，建议保持 ${target.status === 'active' ? '观察' : '暂停'}`;
  }
  
  const parts: string[] = [];
  
  parts.push(`总交易 ${totalTrades} 笔`);
  parts.push(`胜率 ${(winRate * 100).toFixed(1)}%`);
  
  if (avgProfit !== null) {
    parts.push(`均利润 ${avgProfit > 0 ? '+' : ''}${avgProfit.toFixed(3)} SOL`);
  }
  
  if (ourPnl.length > 0) {
    const ourTotal = ourPnl.reduce((a, b) => a + b, 0);
    parts.push(`我方累计 ${ourTotal > 0 ? '+' : ''}${ourTotal.toFixed(3)} SOL`);
  }
  
  return parts.join('，');
}

function generateLLMContext(
  target: TargetRow,
  data: {
    totalTrades: number;
    winners: number;
    withProfit: number;
    profitable: number;
    winRate: number;
    avgProfit: number | null;
    medianTip: number | null;
    medianPrio: number | null;
    targetTipMax: number | null;
    targetPrioMax: number | null;
    ourGas: number | null;
    gasCompetitive: boolean | null;
    gasReason: string | null;
    ourTrades: number;
    ourWins: number;
    ourPnl: number | null;
    akbotIdConfig: number | null;
  }
): string {
  const lines: string[] = [];

  // akbot 映射状态（让 LLM 知道 enable/disable 是否需要先 add）
  lines.push(
    data.akbotIdConfig
      ? `+ akbot 映射: idConfig=${data.akbotIdConfig}（已同步到 akbot，enable/disable 直接 switch 即可）`
      : `+ akbot 映射: 无（该 target 尚未在 akbot 创建，enable 或 limit_update 会先自动 add）`,
  );

  
  // Stats summary
  lines.push(`winners=${data.winners}, with_profit=${data.withProfit}, profitable=${data.profitable}, win_rate=${data.winRate.toFixed(2)}, avg_profit=${data.avgProfit !== null ? (data.avgProfit > 0 ? '+' : '') + data.avgProfit.toFixed(3) : 'N/A'} SOL`);
  
  // Tip/prio info
  if (data.medianTip !== null) {
    lines.push(`+ tip/pno 中位数: ${data.medianTip.toFixed(4)}`);
  }
  if (data.medianPrio !== null) {
    lines.push(`+ prio 中位数: ${data.medianPrio.toFixed(4)}`);
  }
  if (data.targetTipMax !== null) {
    lines.push(`+ 目标 target tip max: ${data.targetTipMax.toFixed(4)} SOL`);
  }
  if (data.targetPrioMax !== null) {
    lines.push(`+ 目标 target prio max: ${data.targetPrioMax.toFixed(4)} SOL`);
  }
  
  // Gas analysis
  if (data.ourGas !== null) {
    lines.push(`+ 我方 gas: ${data.ourGas.toFixed(4)}`);
    if (data.gasReason) {
      lines.push(`+ ${data.gasReason}`);
    }
  }
  
  // Our performance
  if (data.ourTrades > 0) {
    lines.push(`+ 我方战绩: ${data.ourTrades} 笔, ${data.ourWins} 胜`);
    if (data.ourPnl !== null) {
      lines.push(`+ 我方累计 PnL: ${data.ourPnl > 0 ? '+' : ''}${data.ourPnl.toFixed(3)} SOL`);
    }
  } else {
    lines.push(`+ profit_missing=true 且无我方本目标战绩 → 信心中等`);
  }
  
  // Current params
  if (target.agent_params) {
    lines.push(`+ 当前参数: ${JSON.stringify(target.agent_params)}`);
  }
  
  return lines.join('\n');
}
