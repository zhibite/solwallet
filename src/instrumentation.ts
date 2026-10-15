/**
 * Next.js 16 instrumentation
 * 在服务启动时跑一次（生产 + dev 都会跑）
 *
 * 启动以下 worker：
 *   1) runMigrations           — 启动前跑一次 schema migration
 *   2) startPoolWorker         — 池子 BFS 归池 + 决策重算（池子页面排序需要）
 *   3) startWsMonitor          — WebSocket 实时监控（主数据源，毫秒级）
 *
 * 已移除（按 2026-10-15 精简决定）：
 *   - startJitoTipRefresh    — hard-code 默认值够用，Jito 改账户靠人工
 *   - startMonitor（轮询）   — WebSocket 已覆盖，轮询是 WS 断开的兜底
 *                              但兜底意义不大（仍走同一个 RPC），先去掉
 *   - startAkbotBackfillWorker — 24h 一次回填，按用户决定不需要
 *                              akbot 历史扫描改走 scripts/backfill-akbot.ts CLI
 *   - startUnrealizedWorker  — 浮盈功能砍掉后不再需要 30s 拉价刷新
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // 1) 跑一次 migration（idempotent）
  try {
    const { runMigrations } = await import('./lib/migrate');
    await runMigrations();
    console.log('[instrumentation] migrations done');
  } catch (err) {
    console.error('[instrumentation] migration failed', err);
  }

  // 2) 池子 worker：周期 BFS 归池 + 决策重算
  try {
    const { startPoolWorker } = await import('./lib/pool-worker');
    await startPoolWorker();
    console.log('[instrumentation] pool worker started');
  } catch (err) {
    console.error('[instrumentation] pool worker failed to start', err);
  }

  // 3) WebSocket 实时监控：logsSubscribe，毫秒级抓到第一狙击者
  try {
    const { startWsMonitor } = await import('./lib/ws-monitor');
    await startWsMonitor();
    console.log('[instrumentation] ws monitor started');
  } catch (err) {
    console.error('[instrumentation] ws monitor failed to start', err);
  }
}
