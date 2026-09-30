// scripts/reset-watermarks.ts
import { pool } from '../src/lib/db';

async function main() {
  const before = await pool.query<{ address: string; last_scanned_block_time: string | null }>(
    `SELECT address, last_scanned_block_time FROM monitored_targets ORDER BY id`,
  );
  console.log('before:', before.rows);

  await pool.query(`UPDATE monitored_targets SET last_scanned_block_time = NULL`);

  const after = await pool.query<{ address: string; last_scanned_block_time: string | null }>(
    `SELECT address, last_scanned_block_time FROM monitored_targets ORDER BY id`,
  );
  console.log('after:', after.rows);

  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
