'use server';

import { query, queryOne } from '../db';
import { getGlobalSettings, updateGlobalSettings } from './executor';
import { runAgentRound, RunResult } from './runner';

// ============================================================
// 持久化设计
// ============================================================
// 之前所有状态（isRunning / interval / lastRunTime / lastRunResult）都在模块内存里，
// 在 serverless 环境（Vercel、Cloud Run 等）每次冷启动都会丢失，定时调度失效。
//
// 修复方案：
//  1. 运行时状态（isRunning / interval）保留在内存（setInterval 必须有宿主进程）
//  2. 上次运行时间 + 上次结果写入 agent_settings(key='scheduler_state')，进程重启可恢复
//  3. 调度器 tick 时用 pg_try_advisory_lock 抢锁，确保多个实例只有 1 个真正执行 round
//  4. settings 改了 interval/shadow_mode 之后，能在下一轮 tick 反映出来

const SCHEDULER_STATE_KEY = 'scheduler_state';

interface PersistedSchedulerState {
  isRunning: boolean;
  intervalMinutes: number;
  shadowMode: boolean;
  lastRunTime: string | null;
  lastRunResult: RunResult | null;
}

// In-memory runtime state (must remain in-process for setInterval)
let schedulerInterval: ReturnType<typeof setInterval> | null = null;
let currentIntervalMinutes = 5;
let cachedShadowMode = true;

// Advisory lock key for round execution (arbitrary bigint, must be unique app-wide)
const ROUND_LOCK_KEY = 0x4147454e545f524f; // 'AGENT_RO' in hex (8 bytes)

export interface SchedulerState {
  isRunning: boolean;
  intervalMinutes: number;
  shadowMode: boolean;
  lastRunTime: Date | null;
  lastRunResult: {
    status: string;
    targetCount: number;
    decisionCount: number;
    executedCount: number;
    attemptedCount: number;
    errorCount: number;
    totalMs: number;
  } | null;
  nextRunTime: Date | null;
}

/**
 * Read persisted scheduler state from DB. Returns safe defaults if not yet persisted.
 */
async function readPersistedState(): Promise<PersistedSchedulerState> {
  const row = await queryOne<{ value: PersistedSchedulerState }>(
    `SELECT value FROM agent_settings WHERE key = $1`,
    [SCHEDULER_STATE_KEY]
  );
  if (row?.value) {
    return row.value;
  }
  return {
    isRunning: false,
    intervalMinutes: 5,
    shadowMode: true,
    lastRunTime: null,
    lastRunResult: null,
  };
}

/**
 * Persist scheduler state to DB (upsert). Used so that process restarts don't lose last run.
 */
async function writePersistedState(state: Partial<PersistedSchedulerState>): Promise<void> {
  const current = await readPersistedState();
  const merged: PersistedSchedulerState = { ...current, ...state };
  await query(
    `INSERT INTO agent_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [SCHEDULER_STATE_KEY, JSON.parse(JSON.stringify(merged))]
  );
}

/**
 * Get current scheduler state (memory + DB merge)
 */
export async function getSchedulerState(): Promise<SchedulerState> {
  const persisted = await readPersistedState();
  const isRunning = schedulerInterval !== null;

  return {
    isRunning,
    intervalMinutes: currentIntervalMinutes,
    shadowMode: cachedShadowMode,
    lastRunTime: persisted.lastRunTime ? new Date(persisted.lastRunTime) : null,
    lastRunResult: persisted.lastRunResult
      ? {
          status: persisted.lastRunResult.status,
          targetCount: persisted.lastRunResult.targetCount,
          decisionCount: persisted.lastRunResult.decisionCount,
          executedCount: persisted.lastRunResult.executedCount,
          attemptedCount: persisted.lastRunResult.attemptedCount ?? 0,
          errorCount: persisted.lastRunResult.errorCount,
          totalMs: persisted.lastRunResult.totalMs,
        }
      : null,
    nextRunTime: isRunning && persisted.lastRunTime
      ? new Date(new Date(persisted.lastRunTime).getTime() + currentIntervalMinutes * 60 * 1000)
      : null,
  };
}

/**
 * Start the scheduler
 *
 * Fix #11：原来的实现是 `await tryExecuteRound() → scheduleInterval() → return`，
 * 导致第一次 round 跑完才返 200。10 个 target × 3 并发 × ~3s LLM = 30s+，
 * curl / 浏览器都会超时。
 *
 * 现在：先 scheduleInterval + 写持久化状态，然后 fire-and-forget 触发首跑。
 * HTTP 立即 200，round 在后台跑，UI 通过 /api/agent/scheduler poll 拿到进度。
 * 失败也不会冒泡到 API 响应里 —— 写进 lastRunResult，UI 自然看到。
 */
export async function startScheduler(): Promise<SchedulerState> {
  if (schedulerInterval) {
    return await getSchedulerState();
  }

  const settings = await getGlobalSettings();
  currentIntervalMinutes = settings.interval_minutes;
  cachedShadowMode = settings.shadow_mode;

  await writePersistedState({
    isRunning: true,
    intervalMinutes: currentIntervalMinutes,
    shadowMode: cachedShadowMode,
  });

  // 周期循环：先排上，避免 30s 首跑期间 tick 来了没人接
  scheduleInterval();

  // 首跑 fire-and-forget —— 不 await，错误吞掉写进 lastRunResult
  setImmediate(() => {
    tryExecuteRound().catch((e) => {
      console.error('[agent-scheduler] first round failed:', e);
    });
  });

  return await getSchedulerState();
}

/**
 * Stop the scheduler
 */
export async function stopScheduler(): Promise<SchedulerState> {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
  await writePersistedState({ isRunning: false });
  return await getSchedulerState();
}

/**
 * Update scheduler settings and restart if needed
 */
export async function updateSchedulerSettings(settings: {
  interval_minutes?: number;
  shadow_mode?: boolean;
}): Promise<SchedulerState> {
  await updateGlobalSettings(settings);

  if (settings.interval_minutes !== undefined) {
    currentIntervalMinutes = settings.interval_minutes;
  }
  if (settings.shadow_mode !== undefined) {
    cachedShadowMode = settings.shadow_mode;
  }

  // Persist updated effective values
  await writePersistedState({
    intervalMinutes: currentIntervalMinutes,
    shadowMode: cachedShadowMode,
  });

  // If scheduler is running, restart with new interval
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    scheduleInterval();
  }

  return await getSchedulerState();
}

/**
 * Set up the recurring interval (internal)
 */
function scheduleInterval(): void {
  const intervalMs = currentIntervalMinutes * 60 * 1000;
  schedulerInterval = setInterval(async () => {
    await tryExecuteRound();
  }, intervalMs);
}

/**
 * Try to execute a round. Uses pg advisory lock to ensure only one instance runs.
 *
 * 多实例部署时，N 个 scheduler 会同时 tick，但只有拿到 advisory_lock 的那个真正执行 round，
 * 其余实例直接 return。这避免了重复扣费 / 重复写库。
 */
async function tryExecuteRound(): Promise<RunResult | null> {
  const lockResult = await queryOne<{ acquired: boolean }>(
    `SELECT pg_try_advisory_lock($1) AS acquired`,
    [ROUND_LOCK_KEY]
  );

  if (!lockResult?.acquired) {
    // Another instance is already running this round; skip silently
    return null;
  }

  try {
    return await executeRound();
  } finally {
    // Release lock immediately after round completes so next tick can run
    await query(`SELECT pg_advisory_unlock($1)`, [ROUND_LOCK_KEY]);
  }
}

/**
 * Execute a single round and persist results
 */
async function executeRound(): Promise<RunResult> {
  const now = new Date();
  await writePersistedState({ lastRunTime: now.toISOString() });

  let result: RunResult;
  try {
    result = await runAgentRound({
      forceShadow: cachedShadowMode,
    });

    console.log(
      `[Agent] Round completed: ${result.decisionCount} decisions, ` +
      `${result.executedCount} executed, ${result.errorCount} errors ` +
      `(${result.totalMs}ms)`
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    result = {
      roundId: 0,
      status: 'error',
      targetCount: 0,
      decisionCount: 0,
      executedCount: 0,
      attemptedCount: 0,
      errorCount: 1,
      totalMs: 0,
      decisions: [],
      error: message,
    };
    console.error('[Agent] Round failed:', e);
  }

  await writePersistedState({ lastRunResult: result });
  return result;
}

/**
 * Trigger an immediate round
 *
 * Fix #3：原实现直接调 executeRound 绕开 advisory_lock，导致 UI 点 "立即跑一次"
 * 和定时器同时跑会并发调 akbot 接口。统一走 tryExecuteRound()，advisory_lock
 * 保证多实例 + UI/trigger 并发下只有 1 个真正执行。
 *
 * Fix #9：每次 trigger 前重读一次 globalSettings 刷新缓存中的 shadow_mode，
 * 避免 UI 改了 shadow 但 setInterval 还没到下一轮 tick 期间仍然用旧值。
 */
export async function triggerImmediateRound(): Promise<RunResult | null> {
  // 刷新缓存（userId / shadow_mode 改了立即生效，不用等下一轮 tick）
  try {
    const fresh = await getGlobalSettings();
    cachedShadowMode = fresh.shadow_mode;
    if (fresh.interval_minutes !== currentIntervalMinutes) {
      currentIntervalMinutes = fresh.interval_minutes;
      if (schedulerInterval) {
        clearInterval(schedulerInterval);
        scheduleInterval();
      }
    }
    await writePersistedState({
      intervalMinutes: currentIntervalMinutes,
      shadowMode: cachedShadowMode,
    });
  } catch (e) {
    console.warn('[agent-scheduler] refresh cache before trigger failed:', e);
  }
  // 走 tryExecuteRound 拿 advisory_lock —— 同进程内 trigger + 定时器互斥
  return await tryExecuteRound();
}

/**
 * Get scheduler health status
 */
export async function getSchedulerHealth(): Promise<{
  healthy: boolean;
  issues: string[];
}> {
  const issues: string[] = [];

  if (!process.env.LLM_API_KEY) {
    issues.push('LLM_API_KEY not set');
  }

  if (schedulerInterval) {
    // In-process scheduler is running; verify against persisted state
    const persisted = await readPersistedState();
    if (!persisted.isRunning) {
      issues.push('In-memory scheduler running but persisted state says stopped (state mismatch)');
    }

    if (persisted.lastRunTime) {
      const timeSinceLastRun = Date.now() - new Date(persisted.lastRunTime).getTime();
      const expectedInterval = currentIntervalMinutes * 60 * 1000;
      // Allow 2x interval before flagging (round itself may have taken some time)
      if (timeSinceLastRun > expectedInterval * 2) {
        issues.push(
          `Last run was ${Math.round(timeSinceLastRun / 60000)} minutes ago, ` +
          `expected every ${currentIntervalMinutes} minutes`
        );
      }
    }
  }

  // Fix #13：之前 parse 失败时静默回落到 hold（confidence=0），运维看不见 LLM 抽风。
  // 现在 health check 查最近 10 轮：如果 3 轮以上出现了 confidence=-1 的决策，
  // 说明 LLM 输出格式坏了（prompt 漂移 / 模型降级 / token 截断），主动告警。
  try {
    const recent = await query<{ count: string; failed: string }>(`
      WITH recent_rounds AS (
        SELECT id FROM agent_rounds
        WHERE started_at > NOW() - INTERVAL '2 hours'
        ORDER BY id DESC LIMIT 10
      )
      SELECT
        COUNT(*)::text AS count,
        COUNT(*) FILTER (WHERE d.confidence < 0)::text AS failed
      FROM agent_decisions d
      WHERE d.round_id IN (SELECT id FROM recent_rounds)
    `);
    const total = parseInt(recent[0]?.count ?? '0', 10);
    const failed = parseInt(recent[0]?.failed ?? '0', 10);
    if (total >= 5 && failed / total > 0.3) {
      issues.push(
        `LLM 解析失败率 ${failed}/${total}（最近 2h 10 轮）—— prompt/模型可能有问题`
      );
    }
  } catch (e) {
    // health check 不能因为一个查询挂掉就抛
    console.warn('[agent-scheduler] health check parse-failure query failed:', e);
  }

  return {
    healthy: issues.length === 0,
    issues,
  };
}
