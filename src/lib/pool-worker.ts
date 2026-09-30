/**
 * 池子后台 Worker
 * - 周期性 BFS 归池 + auto promote
 * - 周期性重算决策（worth score + 推荐手续费）
 *
 * 启动入口：instrumentation.ts（与 monitor 一起）
 */

import { runBFS, autoPromote, scanForTarget } from './pool';
import { recomputeAllDecisions } from './pool-decision';

const BFS_INTERVAL_MS = parseInt(process.env.POOL_BFS_INTERVAL_MS || '600000', 10); // 10 分钟
const DECISION_INTERVAL_MS = parseInt(process.env.POOL_DECISION_INTERVAL_MS || '900000', 10); // 15 分钟

let bfsTimer: NodeJS.Timeout | null = null;
let decisionTimer: NodeJS.Timeout | null = null;
let running = false;

export async function startPoolWorker() {
  if (running) return;
  running = true;
  console.log('[pool-worker] starting');

  // 启动后延迟 5 秒跑第一次，避免与 monitor 抢占 RPC
  setTimeout(async () => {
    try {
      console.log('[pool-worker] initial BFS');
      const result = await runBFS({});
      console.log('[pool-worker] initial BFS result:', result);
    } catch (err) {
      console.error('[pool-worker] initial BFS failed', err);
    }
  }, 5000);

  bfsTimer = setInterval(async () => {
    try {
      const result = await runBFS({});
      console.log('[pool-worker] BFS result:', result);
    } catch (err) {
      console.error('[pool-worker] BFS failed', err);
    }
  }, BFS_INTERVAL_MS);

  // 决策重算（错开 BFS）
  decisionTimer = setInterval(async () => {
    try {
      const result = await recomputeAllDecisions();
      console.log('[pool-worker] decision recompute result:', result);
    } catch (err) {
      console.error('[pool-worker] decision failed', err);
    }
  }, DECISION_INTERVAL_MS);
}

export function stopPoolWorker() {
  running = false;
  if (bfsTimer) clearInterval(bfsTimer);
  if (decisionTimer) clearInterval(decisionTimer);
}

/**
 * 手动触发一次 BFS（供 API 调用）
 */
export async function triggerBFSNow(): Promise<{ ok: boolean; result?: any; error?: string }> {
  try {
    const result = await runBFS({});
    return { ok: true, result };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}