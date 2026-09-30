// scripts/apply-migration.ts
// Usage: npx tsx --env-file=.env scripts/apply-migration.ts <migration-name>
import { pool } from '../src/lib/db';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

async function main() {
  const target = process.argv[2];
  const dir = join(process.cwd(), 'src', 'lib', 'migrations');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const toRun = target ? files.filter((f) => f === target) : files;
  for (const f of toRun) {
    const applied = await pool.query<{ name: string }>(`SELECT name FROM _migrations WHERE name = $1`, [f]);
    if (applied.rows.length > 0) {
      console.log(`SKIP ${f} (already applied)`);
      continue;
    }
    const sql = readFileSync(join(dir, f), 'utf-8');
    console.log(`APPLY ${f}`);
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query(`INSERT INTO _migrations(name) VALUES ($1)`, [f]);
      await pool.query('COMMIT');
      console.log(`OK ${f}`);
    } catch (err) {
      await pool.query('ROLLBACK');
      throw err;
    }
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});