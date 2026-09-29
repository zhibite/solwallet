/**
 * 数据库初始化脚本
 * 用法：npm run db:init
 */

import { runMigrations } from '../src/lib/migrate';
import { pool } from '../src/lib/db';

async function main() {
  console.log('[init-db] running migrations...');
  await runMigrations();
  console.log('[init-db] done.');
  await pool.end();
}

main().catch((err) => {
  console.error('[init-db] failed:', err);
  process.exit(1);
});
