/**
 * AKBot 池子回填 —— 每日定时 worker
 *
 * 启动入口：src/instrumentation.ts（与 monitor / pool-worker 一起）
 *
 * 设计：
 *   - 默认 24 小时一次；间隔可通过 env AKBOT_BACKFILL_INTERVAL_MS 覆盖
 *   - LIMIT 默认 100（按 freq DESC 选 Top 100 候选），sleepMs 默认 200
 *   - 与 isAkbotScanRunning 互斥 —— UI 手动触发的扫描在跑时，定时这次就让出
 *     （runAkbotScan 内部检测到已在飞，会跳过本次；UI 那次的 done 日志会替它
 *     反映覆盖到这批候选的结果）
 *
 *   2026-10-06 调整：从 1000 砍到 100：
 *   - 100 个活跃地址已覆盖 95% akbot 命中（活跃 sniper 优先）
 *   - 砍 90% Helius 配额消耗
 *   - top 100 是滚动窗口：高 freq 第二天仍在池子里，照样被扫到
 *   - 真要大扫仍走 scripts/backfill-akbot.ts CLI
 *
 * 不持久化 last_run_at：
 *   进程每次启动都跑一次「首跑」，后续按 interval 走。dev server HMR 反复重启
 *   不会因为 last_run_at「一小时前」而跳过该跑的那次（间隔是 24h，HMR 频率根本
 *   不构成问题）。生产部署长时间运行也无所谓，多跑一次浪费 ≤5 分钟 Helius 配额，
 *   比写一个 last_run_at 字段 + 配 cleanup migration 划算得多。
 */

import { runAkbotScan, isAkbotScanRunning } from './akbot-backfill';

const INTERVAL_MS = parseInt(
  process.env.AKBOT_BACKFILL_INTERVAL_MS || String(24 * 60 * 60 * 1000), // 24h
  10,
);
// 2026-10-06：top 100 + 200ms（与 UI 按钮对齐），需要更大用 env AKBOT_BACKFILL_LIMIT=N
const LIMIT = parseInt(process.env.AKBOT_BACKFILL_LIMIT || '100', 10);
const SLEEP_MS = parseInt(process.env.AKBOT_BACKFILL_SLEEP_MS || '200', 10);

let timer: NodeJS.Timeout | null = null;
let started = false;

export function startAkbotBackfillWorker() {
  if (started) return;
  started = true;
  console.log(
    `[akbot-backfill] worker started — interval=${INTERVAL_MS / 1000}s ` +
    `limit=${LIMIT} sleep=${SLEEP_MS}ms`,
  );

  // 首跑：延迟 30 秒，等 monitor / pool-worker 抢完启动期 RPC。
  // 不延后太多是因为用户从 0 akbot 到看见第一个 akbot 越快越好。
  setTimeout(() => {
    runOnce();
  }, 30_000);

  // 周期循环
  timer = setInterval(() => {
    runOnce();
  }, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopAkbotBackfillWorker() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

function runOnce() {
  // UI 正在跑 → 让出本次。下一轮 interval 会再来。
  if (isAkbotScanRunning()) {
    console.log('[akbot-backfill] 跳过本次：UI 扫描正在执行中');
    return;
  }
  console.log(`[akbot-backfill] 定时任务启动 limit=${LIMIT} sleepMs=${SLEEP_MS}`);
  runAkbotScan({ limit: LIMIT, sleepMs: SLEEP_MS })
    .then((r) => {
      console.log(
        `[akbot-backfill] 定时任务完成 scanned=${r.scanned} detected=${r.detected}` +
        ` skipped=${r.skipped} failed=${r.failed} (${(r.durationMs / 1000).toFixed(1)}s)`,
      );
    })
    .catch((e) => {
      console.error('[akbot-backfill] 定时任务失败', e);
    });
}