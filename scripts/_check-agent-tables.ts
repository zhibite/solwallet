import { pool } from '../src/lib/db';

async function main() {
  const r = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'agent%' ORDER BY tablename"
  );
  console.log('agent 相关表:', r.rows.map((x) => x.tablename));

  // 看下 agent_rounds 的列
  const cols = await pool.query<{ column_name: string; data_type: string }>(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'agent_rounds' ORDER BY ordinal_position"
  );
  console.log('agent_rounds 列:');
  for (const c of cols.rows) console.log(`  ${c.column_name} (${c.data_type})`);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
