// scripts/check-watermark.ts
import { query, pool } from '../src/lib/db';

async function main() {
  const rows = await query<any>(`
    SELECT address, label, status, last_scanned_block_time
    FROM monitored_targets
    ORDER BY id
  `);
  console.log('--- monitored_targets 水位线 ---');
  for (const r of rows) {
    console.log(`  ${r.address?.slice(0, 6)}... last_scanned_block_time=${r.last_scanned_block_time}`);
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
