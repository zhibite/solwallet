/**
 * Next.js 16 instrumentation
 * 在服务启动时跑一次（生产 + dev 都会跑）
 * 用作 monitor worker 启动入口
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // 动态 import，避免 edge runtime 加载
    const { startMonitor } = await import('./lib/monitor');
    const { runMigrations } = await import('./lib/migrate');
    try {
      await runMigrations();
      console.log('[instrumentation] migrations done');
    } catch (err) {
      console.error('[instrumentation] migration failed', err);
    }
    try {
      await startMonitor();
      console.log('[instrumentation] monitor started');
    } catch (err) {
      console.error('[instrumentation] monitor failed to start', err);
    }
  }
}
