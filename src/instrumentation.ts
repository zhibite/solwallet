/**
 * Next.js 16 instrumentation
 * 在服务启动时跑一次（生产 + dev 都会跑）
 * 用作 monitor worker 启动入口
 */

const JITO_REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 分钟

async function startJitoTipRefresh() {
  // 动态 import，避免 edge runtime 加载 + 循环依赖
  const { refreshJitoTipAccounts } = await import('./lib/parser');
  // 启动时立即刷一次，失败也无所谓（保持 hard-code 默认值）
  try {
    const r = await refreshJitoTipAccounts();
    console.log('[jito-tip-refresh]', r);
  } catch (err) {
    console.warn('[jito-tip-refresh] initial refresh failed', err);
  }
  // 定时刷；unref 避免阻塞进程退出
  const timer = setInterval(async () => {
    try {
      const r = await refreshJitoTipAccounts();
      // ok=true 时打印；false（live empty/error）只 warn，避免日志噪音
      if (r.ok) {
        console.log('[jito-tip-refresh]', r);
      } else {
        console.warn('[jito-tip-refresh]', r);
      }
    } catch (err) {
      console.warn('[jito-tip-refresh] periodic refresh failed', err);
    }
  }, JITO_REFRESH_INTERVAL_MS);
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Jito tip accounts 自动刷新（启动时立即刷一次，之后每 10 分钟刷一次）。
    // 解决：refreshJitoTipAccounts 之前是 dead code，Jito 增删 tip accounts 时会漏识别。
    // Helius Sender / LandX / 0slot 的 tip accounts 仍走 hard-code 静态常量（这 3 家不公开 getTipAccounts）。
    try {
      await startJitoTipRefresh();
    } catch (err) {
      console.error('[instrumentation] jito tip refresh failed to start', err);
    }

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

    // 池子 worker（归池 + 决策重排，不自动晋升到监控列表）
    try {
      const { startPoolWorker } = await import('./lib/pool-worker');
      await startPoolWorker();
      console.log('[instrumentation] pool worker started');
    } catch (err) {
      console.error('[instrumentation] pool worker failed to start', err);
    }

    // AKBot 池子回填 worker（每日定时扫一遍 pool_members，识别 akbot 用户）
    try {
      const { startAkbotBackfillWorker } = await import('./lib/akbot-backfill-worker');
      startAkbotBackfillWorker();
      console.log('[instrumentation] akbot backfill worker started');
    } catch (err) {
      console.error('[instrumentation] akbot backfill worker failed to start', err);
    }
  }
}
