'use server';

import { query, queryOne } from '../db';
import { Decision } from './prompts';
import { executeOnAkbot, AkbotExecutionResult, AkbotStepResult } from './akbot-executor';

export interface ExecutionResult {
  success: boolean;
  action: Decision['action'];
  targetId: number;
  executed: boolean;
  message: string;
  error?: string;
}

export interface TargetInfo {
  id: number;
  address: string;
  label: string | null;
  status: 'active' | 'paused' | 'deleted';
  agent_params: Record<string, unknown> | null;
  agent_shadow: boolean | null;
}

/**
 * Check if a decision should be executed based on shadow mode
 */
function shouldExecute(shadowMode: boolean, targetShadowOverride: boolean | null): boolean {
  // If target has shadow override, use it
  if (targetShadowOverride !== null && targetShadowOverride !== undefined) {
    return !targetShadowOverride;
  }
  
  // Otherwise use global shadow mode
  return !shadowMode;
}

/**
 * Execute a single decision
 */
export async function executeDecision(
  targetId: number,
  decision: Decision,
  shadowMode: boolean = true,
  decisionId?: number,
): Promise<ExecutionResult> {
  // Get target info from monitored_targets
  const target = await queryOne<TargetInfo>(
    `SELECT id, address, label, status, agent_params, agent_shadow FROM monitored_targets WHERE id = $1`,
    [targetId]
  );
  
  if (!target) {
    return {
      success: false,
      action: decision.action,
      targetId,
      executed: false,
      message: `Target ${targetId} not found`,
      error: 'Target not found',
    };
  }
  
  const execute = shouldExecute(shadowMode, target.agent_shadow);
  
  const result: ExecutionResult = {
    success: true,
    action: decision.action,
    targetId,
    executed: execute,
    message: execute
      ? `Executing ${decision.action} on ${target.address}`
      : `Shadow mode: would ${decision.action} on ${target.address}`,
  };
  
  if (!execute) {
    // Just record the decision, don't execute
    return result;
  }
  
  // Execute the action
  let akbotError: string | undefined;
  try {
    switch (decision.action) {
      case 'enable':
        await executeEnable(targetId);
        break;

      case 'disable':
        await executeDisable(targetId);
        break;

      case 'delete':
        await executeDelete(targetId);
        break;

      case 'limit_update':
        await executeLimitUpdate(targetId, decision.params);
        break;

      case 'hold':
        // No action needed
        result.message = `Hold on ${target.address} - no changes`;
        break;

      default:
        // 未知 action：直接返，不再调 akbot（akbot 端也只会返 unsupported action，
        // 错误信息会覆盖这个更准确的本地错误）
        result.success = false;
        result.message = `Unknown action: ${decision.action}`;
        result.error = 'Unknown action';
        return result;
    }
  } catch (e) {
    result.success = false;
    result.executed = false;
    result.message = `Failed to ${decision.action} on ${target.address}`;
    result.error = e instanceof Error ? e.message : String(e);
    return result;
  }

  // 本地写库成功 → 调 akbot 真实执行（如果没在 shadow 模式）
  // delete + shadow 路径不调；其他都走 akbot-executor 让它自己判断
  const akbotOutcome = await executeOnAkbot(targetId, decision, !execute);
  const akbotResult = akbotOutcome.result;
  await logAkbotCall(akbotResult, akbotOutcome.steps, decision, decisionId);

  if (!akbotResult.ok) {
    // akbot 失败：本地状态已落库，但标记 executed=false 让 UI 标红
    result.success = false;
    result.executed = false;
    result.message = `${decision.action} on ${target.address}: ${akbotResult.error ?? 'akbot failed'}`;
    result.error = `akbot: ${akbotResult.error ?? 'unknown'}` + (akbotResult.endpoint ? ` (${akbotResult.endpoint})` : '');
  } else if (akbotResult.skipped) {
    // hold 或 shadow：保持原 result.executed
  } else {
    result.message = `${decision.action} on ${target.address} → akbot ${akbotResult.endpoint ?? 'ok'}`;
  }

  return result;
}

/**
 * 写一行或多行 akbot_call_log。
 * - 0 step（hold / shadow / target 不存在）→ 1 行占位记录（仅 action + ok=true）
 * - 1 step → 1 行
 * - N step（add → saveMap → switch 这种 multi-step）→ N 行，每行带自己的 endpoint
 *   和 request/response body，方便排错时按 step 还原现场
 * 不抛异常（log 失败不应该影响决策流）。
 */
async function logAkbotCall(
  r: AkbotExecutionResult,
  steps: AkbotStepResult[],
  decision: Decision,
  decisionId?: number,
): Promise<void> {
  try {
    if (steps.length === 0) {
      // shadow / hold / target 缺失：单行占位
      await query(
        `INSERT INTO akbot_call_log (
           agent_decision_id, monitored_target_id, action, endpoint,
           response_status, ok, error_message, duration_ms
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          decisionId ?? null,
          r.targetId,
          r.action,
          r.endpoint ?? null,
          r.httpStatus ?? null,
          r.ok,
          r.error ?? null,
          r.durationMs ?? null,
        ],
      );
      return;
    }
    // 多 step：每 step 一行，body 各自存自己的
    for (const s of steps) {
      await query(
        `INSERT INTO akbot_call_log (
           agent_decision_id, monitored_target_id, action, endpoint,
           request_body, response_body, response_status, ok,
           error_message, duration_ms
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10)`,
        [
          decisionId ?? null,
          r.targetId,
          r.action,
          s.endpoint,
          s.requestBody !== undefined ? JSON.stringify(s.requestBody) : null,
          s.responseBody !== undefined ? JSON.stringify(s.responseBody) : null,
          s.httpStatus,
          s.ok,
          s.error ?? null,
          s.durationMs,
        ],
      );
    }
  } catch (e) {
    // 静默：log 失败不该影响决策
    console.error('[akbot-call-log] failed:', e);
  }
}

/**
 * Enable (resume) a target
 */
async function executeEnable(targetId: number): Promise<void> {
  await query(
    `UPDATE monitored_targets SET status = 'active', updated_at = NOW() WHERE id = $1`,
    [targetId]
  );
}

/**
 * Disable (pause) a target
 */
async function executeDisable(targetId: number): Promise<void> {
  await query(
    `UPDATE monitored_targets SET status = 'paused', updated_at = NOW() WHERE id = $1`,
    [targetId]
  );
}

/**
 * Delete a target
 */
async function executeDelete(targetId: number): Promise<void> {
  await query(
    `UPDATE monitored_targets SET status = 'deleted', updated_at = NOW() WHERE id = $1`,
    [targetId]
  );
}

/**
 * Allowed param keys + their value bounds.
 * 白名单 + 范围限制：防止 LLM 输出离谱值（如负数、超大数）覆盖正常参数。
 */
const PARAM_RULES: Record<string, { min: number; max: number }> = {
  position_sol: { min: 0.1, max: 10 },
  tip_sol: { min: 0.0001, max: 0.1 },
  gas_sol: { min: 0.0001, max: 0.05 },
  slippage: { min: 0.01, max: 1.0 },
  high_gas_sol: { min: 0.0001, max: 0.1 },
  high_gas_tip_sol: { min: 0.0001, max: 0.2 },
  high_gas_slippage: { min: 0.05, max: 1.0 },
};

const BOOLEAN_PARAM_KEYS = new Set(['high_gas_mode']);

/**
 * Sanitize params: keep only allowed keys, clamp numeric values to safe bounds,
 * coerce booleans. Returns null if nothing valid remains.
 */
function sanitizeParams(
  params: Decision['params']
): Record<string, number | boolean> | null {
  if (!params || typeof params !== 'object') return null;
  // cast: Decision['params'] 字段类型太具体，Object.entries 推断不出 string 值的可能
  const entries = Object.entries(params as Record<string, unknown>);
  const cleaned: Record<string, number | boolean> = {};
  for (const [key, raw] of entries) {
    if (BOOLEAN_PARAM_KEYS.has(key)) {
      if (typeof raw === 'boolean') cleaned[key] = raw;
      else if (typeof raw === 'string') cleaned[key] = raw.toLowerCase() === 'true';
      else if (typeof raw === 'number') cleaned[key] = raw !== 0;
    } else if (key in PARAM_RULES) {
      const num = typeof raw === 'number' ? raw : parseFloat(String(raw));
      if (!isFinite(num)) continue;
      const { min, max } = PARAM_RULES[key];
      // clamp
      const clamped = Math.min(max, Math.max(min, num));
      cleaned[key] = clamped;
    }
    // unknown keys are dropped silently
  }
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

/**
 * Update target parameters. Single SQL update that merges with existing agent_params
 * using jsonb concat, avoiding a SELECT-then-UPDATE race window.
 */
async function executeLimitUpdate(
  targetId: number,
  params: Decision['params']
): Promise<void> {
  const sanitized = sanitizeParams(params);
  if (!sanitized) {
    return;
  }

  await query(
    `UPDATE monitored_targets
     SET agent_params = COALESCE(agent_params, '{}'::jsonb) || $1::jsonb,
         updated_at = NOW()
     WHERE id = $2`,
    [JSON.parse(JSON.stringify(sanitized)), targetId]
  );
}

/**
 * Record a decision to the database
 */
export async function recordDecision(
  roundId: number,
  targetId: number,
  decision: Decision,
  shadow: boolean,
  executed: boolean,
  errorMessage?: string
): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO agent_decisions (round_id, target_id, action, params, reasoning, confidence, shadow, executed, executed_at, execution_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      roundId,
      targetId,
      decision.action,
      decision.params ? JSON.stringify(decision.params) : null,
      decision.reasoning,
      decision.confidence,
      shadow,
      executed,
      executed ? new Date() : null,
      errorMessage || null,
    ]
  );
  
  return rows[0].id;
}

/**
 * Update round execution count
 *
 * Fix #6：补 attempted_count 重算。语义：
 *   - executed_count   = end-to-end 成功（本地 + akbot 都 OK）
 *   - attempted_count  = 尝试执行但失败（含本地 OK + akbot 失败）
 *   - error_count      = 任意阶段抛异常 / target 找不到 等
 */
export async function updateRoundExecutionCount(roundId: number): Promise<void> {
  await query(
    `UPDATE agent_rounds
     SET executed_count = (
       SELECT COUNT(*) FROM agent_decisions
       WHERE round_id = $1 AND executed = TRUE
     ),
     attempted_count = (
       SELECT COUNT(*) FROM agent_decisions
       WHERE round_id = $1
         AND executed = FALSE
         AND execution_error IS NOT NULL
         AND action <> 'hold'
     )
     WHERE id = $1`,
    [roundId]
  );
}

/**
 * Get recent execution results for a target
 */
export async function getRecentDecisions(
  targetId: number,
  limit: number = 10
): Promise<Array<{
  id: number;
  action: string;
  reasoning: string;
  confidence: number;
  shadow: boolean;
  executed: boolean;
  created_at: Date;
}>> {
  const rows = await query(
    `SELECT id, action, reasoning, confidence, shadow, executed, created_at
     FROM agent_decisions
     WHERE target_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [targetId, limit]
  );
  
  return rows as Array<{
    id: number;
    action: string;
    reasoning: string;
    confidence: number;
    shadow: boolean;
    executed: boolean;
    created_at: Date;
  }>;
}

/**
 * Toggle global shadow mode
 */
export async function toggleGlobalShadowMode(enabled: boolean): Promise<void> {
  await query(
    `UPDATE agent_settings
     SET value = jsonb_set(value, '{shadow_mode}', $1::text::jsonb), updated_at = NOW()
     WHERE key = 'global'`,
    [enabled]
  );
}

/**
 * Get global settings
 * 缺字段时回落到默认值，避免上游因 undefined NPE
 */
export async function getGlobalSettings(): Promise<{
  shadow_mode: boolean;
  interval_minutes: number;
  model: string;
  provider: string;
}> {
  const defaults = {
    shadow_mode: true,
    interval_minutes: 5,
    model: 'deepseek-chat',
    provider: 'deepseek',
  };
  const row = await queryOne<{ value: Partial<typeof defaults> | null }>(
    `SELECT value FROM agent_settings WHERE key = 'global'`
  );

  if (!row?.value || typeof row.value !== 'object') {
    return defaults;
  }
  // 字段级兜底：缺哪个补哪个，避免 JSONB 是 {} 或部分字段时下游 undefined
  const v = row.value;
  return {
    shadow_mode: typeof v.shadow_mode === 'boolean' ? v.shadow_mode : defaults.shadow_mode,
    interval_minutes: Number.isFinite(v.interval_minutes)
      ? (v.interval_minutes as number) : defaults.interval_minutes,
    model: typeof v.model === 'string' && v.model.length > 0
      ? v.model : defaults.model,
    provider: typeof v.provider === 'string' && v.provider.length > 0
      ? v.provider : defaults.provider,
  };
}

/**
 * Update global settings
 */
export async function updateGlobalSettings(settings: Partial<{
  shadow_mode: boolean;
  interval_minutes: number;
  model: string;
  provider: string;
}>): Promise<void> {
  const current = await getGlobalSettings();
  const merged = { ...current, ...settings };
  
  await query(
    `INSERT INTO agent_settings (key, value) VALUES ('global', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [merged]
  );
}
