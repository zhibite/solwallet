'use server';

import { query, queryOne } from '../db';
import { generateSnapshotsForAllTargets, TargetSnapshot } from './snapshot';
import { buildUserPrompt, SYSTEM_PROMPT, Decision } from './prompts';
import { buildKnowledgeContext } from './knowledge';
import { callLLM, getLLMConfig } from './llm';
import { parseLLMResponse } from './decide';
import { executeDecision, recordDecision, updateRoundExecutionCount, getGlobalSettings } from './executor';

export interface AgentRound {
  id: number;
  started_at: Date;
  finished_at: Date | null;
  llm_model: string;
  llm_provider: string;
  total_ms: number;
  target_count: number;
  decision_count: number;
  executed_count: number;
  attempted_count: number;        // Fix #6
  error_count: number;
  status: 'running' | 'completed' | 'error';
  error_message: string | null;
}

export interface RunResult {
  roundId: number;
  status: 'completed' | 'error';
  targetCount: number;
  decisionCount: number;
  executedCount: number;
  /** 尝试执行（含 akbot 失败）：见 runner.ts tally 注释 */
  attemptedCount: number;
  errorCount: number;
  totalMs: number;
  decisions: Array<{
    targetId: number;
    action: string;
    params: Decision['params'];
    reasoning: string;
    confidence: number;
    executed: boolean;
    error?: string;
  }>;
  error?: string;
}

/**
 * Run a single agent decision round
 */
export async function runAgentRound(options?: {
  targetIds?: number[];
  forceShadow?: boolean;
}): Promise<RunResult> {
  const startTime = Date.now();
  const config = await getLLMConfig();
  const globalSettings = await getGlobalSettings();
  
  // Determine shadow mode
  const shadowMode = options?.forceShadow ?? globalSettings.shadow_mode;
  
  // Create round record
  const roundId = await createRound(config, shadowMode);
  
  try {
    // 1. Generate snapshots for targets
    const snapshots = await generateSnapshotsForAllTargets();
    
    // Filter by specific target IDs if provided
    const filteredSnapshots = options?.targetIds
      ? snapshots.filter(s => options.targetIds!.includes(s.target_id))
      : snapshots;
    
    if (filteredSnapshots.length === 0) {
      await finishRound(roundId, {
        status: 'completed',
        target_count: 0,
        decision_count: 0,
        error_count: 0,
        total_ms: Date.now() - startTime,
      });
      
      return {
        roundId,
        status: 'completed',
        targetCount: 0,
        decisionCount: 0,
        executedCount: 0,
        attemptedCount: 0,
        errorCount: 0,
        totalMs: Date.now() - startTime,
        decisions: [],
      };
    }
    
    // Update round with target count
    await query(
      `UPDATE agent_rounds SET target_count = $1 WHERE id = $2`,
      [filteredSnapshots.length, roundId]
    );
    
    // 2. Build knowledge context
    const knowledgeContext = await buildKnowledgeContext();
    
    // 3. Process each target with bounded concurrency.
    // 串行调用 LLM：N 个目标 = N × 单次延迟，10 个目标要 1 分钟起步。
    // 改为有限并发：CONCURRENCY=3 既能提速又不至于打爆 LLM API 限流。
    const CONCURRENCY = 3;
    const results: Array<{
      targetId: number;
      action: string;
      params: Decision['params'];
      reasoning: string;
      confidence: number;
      executed: boolean;
      error?: string;
    }> = new Array(filteredSnapshots.length);

    let cursor = 0;
    async function worker(): Promise<void> {
      while (true) {
        const idx = cursor++;
        if (idx >= filteredSnapshots.length) return;
        const snapshot = filteredSnapshots[idx];
        results[idx] = await processTarget(
          roundId,
          snapshot,
          knowledgeContext,
          shadowMode
        );
      }
    }

    const workers = Array.from(
      { length: Math.min(CONCURRENCY, filteredSnapshots.length) },
      () => worker()
    );
    await Promise.all(workers);

    // 4. Tally results
    //    三个数语义不重叠，UI 看的时候一目了然：
    //      - decided:        总决策数（含 hold）
    //      - executedCount:  端到端成功的（本地+akbot 都没问题）
    //      - attemptedCount: 真去调了 akbot 的（本地写库成功，akbot 成功或失败都算）
    //                        用来反映「我方有动过手」的次数
    //      - errorCount:     完全失败的（本地写库就抛 / 找不到 target / etc.）
    //    Fix #6：之前只区分 executed/error 两个数，把「本地成功但 akbot 失败」
    //    这种半态混在 errorCount 里，看不到「我尝试过」的信息。
    let executedCount = 0;
    let errorCount = 0;
    let attemptedCount = 0;
    for (const r of results) {
      if (r.executed) executedCount++;
      else if (r.error && r.action !== 'hold') attemptedCount++;
      if (r.error) errorCount++;
    }
    const decisions = results;

    // 5. Update round with results
    await finishRound(roundId, {
      status: 'completed',
      target_count: filteredSnapshots.length,
      decision_count: decisions.length,
      error_count: errorCount,
      total_ms: Date.now() - startTime,
    });

    await updateRoundExecutionCount(roundId);

    return {
      roundId,
      status: 'completed',
      targetCount: filteredSnapshots.length,
      decisionCount: decisions.length,
      executedCount,
      attemptedCount,
      errorCount,
      totalMs: Date.now() - startTime,
      decisions,
    };
  } catch (e) {
    await finishRound(roundId, {
      status: 'error',
      error_message: e instanceof Error ? e.message : String(e),
      target_count: 0,
      decision_count: 0,
      error_count: 1,
      total_ms: Date.now() - startTime,
    });
    
    return {
      roundId,
      status: 'error',
      targetCount: 0,
      decisionCount: 0,
      executedCount: 0,
      attemptedCount: 0,
      errorCount: 1,
      totalMs: Date.now() - startTime,
      decisions: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Process a single target: make decision, persist, execute.
 * 抽出来便于并发 worker 调用，每个 target 内部仍然是串行（决定→记录→执行），
 * 避免决策和执行结果错位。
 */
async function processTarget(
  roundId: number,
  snapshot: TargetSnapshot,
  knowledgeContext: string,
  shadowMode: boolean
): Promise<RunResult['decisions'][number]> {
  // 在 try 外准备好 decisionId（如果 recordDecision 失败也能写一行 error 占位，
  // UI 在 /agent/rounds/[id] 能看到具体是哪个 target 挂了，而不是只有 round.error_count+1）
  let decisionId: number | null = null;
  try {
    const decision = await makeDecision(snapshot, knowledgeContext);

    // Record decision
    decisionId = await recordDecision(
      roundId,
      snapshot.target_id,
      decision,
      shadowMode,
      false // Will update after execution
    );

    // Execute decision
    const execResult = await executeDecision(
      snapshot.target_id,
      decision,
      shadowMode,
      decisionId
    );

    // Update decision with execution result
    await query(
      `UPDATE agent_decisions SET executed = $1, executed_at = $2, execution_error = $3 WHERE id = $4`,
      [execResult.executed, execResult.executed ? new Date() : null, execResult.error || null, decisionId]
    );

    return {
      targetId: snapshot.target_id,
      action: decision.action,
      params: decision.params,
      reasoning: decision.reasoning,
      confidence: decision.confidence,
      executed: execResult.executed,
      error: execResult.error,
    };
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    // 尽量把失败占位写进 agent_decisions，方便 UI 看到具体 target 出错
    // 而不只是 round.error_count++
    if (decisionId === null) {
      try {
        await recordDecision(
          roundId,
          snapshot.target_id,
          {
            action: 'hold',
            params: null,
            reasoning: 'Error during decision making',
            // 跟 runner.ts makeDecision 里 LLM parse 失败保持一致：
            //   confidence < 0 → 解析/系统错误；0..1 → LLM 正常输出
            confidence: -1,
          },
          shadowMode,
          false,
          errorMsg,
        );
      } catch (writeErr) {
        // 写占位也失败（比如 round 都没创建）—— 不冒泡，让上层 round.error_count 反映
        console.error('[processTarget] failed to record error placeholder:', writeErr);
      }
    } else {
      // decision 写进去了但 execute / UPDATE 失败 —— 把 error 写回那条 decision
      try {
        await query(
          `UPDATE agent_decisions SET execution_error = $1 WHERE id = $2`,
          [errorMsg, decisionId]
        );
      } catch (writeErr) {
        console.error('[processTarget] failed to write error to existing decision:', writeErr);
      }
    }
    return {
      targetId: snapshot.target_id,
      action: 'hold',
      params: null,
      reasoning: 'Error during decision making',
      confidence: -1,
      executed: false,
      error: errorMsg,
    };
  }
}

/**
 * Make a decision for a single target
 */
async function makeDecision(
  snapshot: TargetSnapshot,
  knowledgeContext: string
): Promise<Decision> {
  const config = await getLLMConfig();
  
  // Build messages
  const messages = [
    { role: 'system' as const, content: SYSTEM_PROMPT + '\n\n' + knowledgeContext },
    { role: 'user' as const, content: buildUserPrompt(snapshot) },
  ];
  
  // Call LLM
  const response = await callLLM(messages, {
    model: config.model,
    provider: config.provider,
  });
  
  // Parse response
  const parseResult = parseLLMResponse(response.content);
  
  if (!parseResult.success || parseResult.decisions.length === 0) {
    // Fall back to hold
    // Fix #17：把 parse 失败跟「LLM 觉得没把握」区分开。
    //   confidence: -1  → LLM 输出无法解析
    //   confidence: 0-1 → LLM 输出正常（即使 0 也表示 LLM 主动给 0，不是错误）
    //   上层按 confidence < 0 判定 parse 失败，可用于告警/统计。
    return {
      action: 'hold',
      params: null,
      reasoning: parseResult.error || 'Failed to parse LLM response, defaulting to hold',
      confidence: -1,
    };
  }

  return parseResult.decisions[0];
}

/**
 * Create a new round record
 */
async function createRound(config: { model: string; provider: string }, shadowMode: boolean): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO agent_rounds (llm_model, llm_provider, status)
     VALUES ($1, $2, 'running')
     RETURNING id`,
    [config.model, config.provider]
  );
  
  return rows[0].id;
}

/**
 * Finish a round
 */
async function finishRound(
  roundId: number,
  updates: {
    status: 'completed' | 'error';
    error_message?: string;
    target_count: number;
    decision_count: number;
    error_count: number;
    total_ms: number;
  }
): Promise<void> {
  await query(
    `UPDATE agent_rounds
     SET finished_at = NOW(),
         status = $1,
         error_message = $2,
         target_count = $3,
         decision_count = $4,
         error_count = $5,
         total_ms = $6
     WHERE id = $7`,
    [
      updates.status,
      updates.error_message || null,
      updates.target_count,
      updates.decision_count,
      updates.error_count,
      updates.total_ms,
      roundId,
    ]
  );
}

/**
 * Get the latest round
 */
export async function getLatestRound(): Promise<AgentRound | null> {
  const row = await queryOne<AgentRound>(
    `SELECT * FROM agent_rounds ORDER BY id DESC LIMIT 1`
  );
  
  return row;
}

/**
 * Get round by ID with decisions
 */
export async function getRoundWithDecisions(roundId: number): Promise<{
  round: AgentRound;
  decisions: Array<{
    id: number;
    target_id: number;
    target_address: string;
    target_label: string | null;
    action: string;
    params: Decision['params'];
    reasoning: string;
    confidence: number;
    shadow: boolean;
    executed: boolean;
    execution_error: string | null;
    created_at: Date;
  }>;
} | null> {
  const round = await queryOne<AgentRound>(
    `SELECT * FROM agent_rounds WHERE id = $1`,
    [roundId]
  );
  
  if (!round) return null;
  
  const decisions = await query(
    `SELECT d.*, t.address as target_address, t.label as target_label
     FROM agent_decisions d
     JOIN monitored_targets t ON d.target_id = t.id
     WHERE d.round_id = $1
     ORDER BY d.id`,
    [roundId]
  );
  
  return {
    round,
    decisions: decisions.map(d => ({
      ...d,
      params: d.params ? JSON.parse(JSON.stringify(d.params)) : null,
    })) as Array<{
      id: number;
      target_id: number;
      target_address: string;
      target_label: string | null;
      action: string;
      params: Decision['params'];
      reasoning: string;
      confidence: number;
      shadow: boolean;
      executed: boolean;
      execution_error: string | null;
      created_at: Date;
    }>,
  };
}

/**
 * Get recent rounds
 */
export async function getRecentRounds(limit: number = 20): Promise<AgentRound[]> {
  const rows = await query<AgentRound>(
    `SELECT * FROM agent_rounds ORDER BY id DESC LIMIT $1`,
    [limit]
  );
  
  return rows;
}

/**
 * Get agent statistics
 */
export async function getAgentStats(): Promise<{
  totalRounds: number;
  totalDecisions: number;
  totalExecuted: number;
  actionBreakdown: Record<string, number>;
  avgConfidence: number;
  lastRound: AgentRound | null;
}> {
  const stats = await queryOne<{
    total_rounds: number;
    total_decisions: number;
    total_executed: number;
    avg_confidence: number | null;
  }>(`
    SELECT
      COUNT(DISTINCT r.id) as total_rounds,
      COUNT(d.id) as total_decisions,
      COUNT(d.id) FILTER (WHERE d.executed = TRUE) as total_executed,
      AVG(d.confidence) as avg_confidence
    FROM agent_rounds r
    LEFT JOIN agent_decisions d ON r.id = d.round_id
  `);
  
  const actionBreakdown = await query<{ action: string; count: number }>(`
    SELECT action, COUNT(*) as count
    FROM agent_decisions
    GROUP BY action
    ORDER BY count DESC
  `);
  
  const lastRound = await getLatestRound();
  
  return {
    totalRounds: stats?.total_rounds || 0,
    totalDecisions: stats?.total_decisions || 0,
    totalExecuted: stats?.total_executed || 0,
    actionBreakdown: actionBreakdown.reduce((acc, { action, count }) => {
      acc[action] = count;
      return acc;
    }, {} as Record<string, number>),
    avgConfidence: stats?.avg_confidence || 0,
    lastRound,
  };
}
