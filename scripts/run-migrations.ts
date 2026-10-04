/** 跑数据库迁移 */
import { readFileSync } from 'fs';
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

async function main() {
  // 动态 import：ESM 会把静态 import 提升到 env 加载之前，
  // db.ts 在模块顶层就建连接池，静态 import 会让它读到空 env。
  const { runMigrations } = await import('../src/lib/migrate');
  const { pool } = await import('../src/lib/db');

  try {
    await runMigrations();
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'block_buyers'
          AND column_name IN ('token_amount','pnl_status','pnl_sold_ratio')
        ORDER BY column_name`,
    );
    console.log('block_buyers 新列:', r.rows.map((x: any) => x.column_name));
    const t = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'target_trades' AND column_name = 'target_token_amount'`,
    );
    console.log('target_trades.target_token_amount:', t.rows.map((x: any) => x.column_name));
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
