/**
 * 独立运行 monitor worker（可选）
 * 用法：npm run monitor
 *
 * 默认在 Next.js 启动时通过 instrumentation.ts 自动运行
 * 如果你想单独跑（例如多实例），用这个脚本
 */

import { startMonitor, stopMonitor } from '../src/lib/monitor';
import { runMigrations } from '../src/lib/migrate';

async function main() {
  await runMigrations();
  await startMonitor();

  process.on('SIGINT', async () => {
    console.log('\n[monitor] shutting down...');
    stopMonitor();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    stopMonitor();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[monitor] failed:', err);
  process.exit(1);
});
