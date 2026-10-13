/**
 * 独立运行 PnL Worker（可选）
 * 用法：npm run pnl-worker
 *
 * 默认在 Next.js 启动时通过 instrumentation.ts 自动运行
 */

import { startPnlWorker, stopPnlWorker } from '../src/lib/pnl-worker';
import { runMigrations } from '../src/lib/migrate';

async function main() {
  await runMigrations();
  await startPnlWorker();

  process.on('SIGINT', async () => {
    console.log('\n[pnl-worker] shutting down...');
    stopPnlWorker();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    stopPnlWorker();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[pnl-worker] failed:', err);
  process.exit(1);
});
