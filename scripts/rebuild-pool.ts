// scripts/rebuild-pool.ts
// 清空 pool_members / pool_edges（被 BIGINT 字符串拼接 bug 污染），
// 然后基于当前 monitored_targets + target_trades 重跑 BFS 重算。
//
// 注意：必须同时把 monitored_targets.last_scanned_block_time 重置为 NULL。
// scanForTarget 只扫 block_time > 水位线 的 trade，而水位线每次扫描后被推到
// MAX(block_time)，所以不重置的话 TRUNCATE 之后 BFS 一笔都扫不到，池子会被清空且无法重建。
//
// Usage: npx tsx --env-file=.env scripts/rebuild-pool.ts
import { query, queryOne, withTransaction, pool } from '../src/lib/db';
import { runBFS } from '../src/lib/pool';

async function main() {
  console.log('===== 清理 + 重算 pool =====\n');

  // 1) 备份当前行数（用作 sanity）
  const before = await queryOne<any>(`
    SELECT
      (SELECT COUNT(*)::int FROM pool_members) AS pm,
      (SELECT COUNT(*)::int FROM pool_edges) AS pe,
      (SELECT COUNT(*)::int FROM monitored_targets WHERE last_scanned_block_time IS NOT NULL) AS wm_set
  `);
  console.log(
    `清理前 pool_members=${before?.pm} pool_edges=${before?.pe} 已设水位线目标数=${before?.wm_set}`,
  );

  // 2) 清空 + 重置水位线（同一事务，避免 truncate 后崩溃留下不一致状态）
  console.log('\n[1/3] TRUNCATE pool_members / pool_edges + 重置 last_scanned_block_time');
  await withTransaction(async (client) => {
    await client.query('TRUNCATE TABLE pool_members, pool_edges RESTART IDENTITY');
    await client.query('UPDATE monitored_targets SET last_scanned_block_time = NULL');
  });

  // 3) 取 monitored_targets 数量
  const targets = await query<any>(`SELECT id, address FROM monitored_targets`);
  console.log(`[2/3] 当前 monitored_targets = ${targets.length}`);
  for (const t of targets) {
    console.log(`  - #${t.id} ${t.address}`);
  }

  // 4) 跑 BFS discover
  console.log('\n[3/3] runBFS() 重算…');
  const res = await runBFS({ maxDepth: 2 });
  console.log('BFS 结果:', res);

  // 5) 校验
  const after = await queryOne<any>(`
    SELECT
      (SELECT COUNT(*)::int FROM pool_members) AS pm,
      (SELECT COUNT(*)::int FROM pool_edges) AS pe
  `);
  console.log(`\n清理后 pool_members=${after?.pm} pool_edges=${after?.pe}`);

  // 6) 列出新 freq top 10
  const top = await query<any>(`
    SELECT id, address, role, freq::int AS freq,
           seen_as_first_sniper::int AS seen_fs,
           seen_as_follower::int AS seen_fol,
           distinct_targets::int AS distinct_targets,
           avg_buy_sol::text AS avg_buy_sol
    FROM pool_members
    ORDER BY freq DESC
    LIMIT 10
  `);
  console.log('\n--- 新 freq top 10 ---');
  for (const r of top) {
    console.log(
      `#${r.id} freq=${r.freq} targets=${r.distinct_targets} | ${r.role} | FS/Fol=${r.seen_fs}/${r.seen_fol} | avg_buy=${r.avg_buy_sol}`,
    );
    console.log(`    ${r.address}`);
  }

  // 7) 抽样 pool_edges
  const eTop = await query<any>(`
    SELECT id, follower, target, freq::int AS freq,
           same_slot_count::int AS same, next_slot_count::int AS next,
           win_count::int AS win, fail_count::int AS fail
    FROM pool_edges
    ORDER BY freq DESC
    LIMIT 5
  `);
  console.log('\n--- pool_edges top 5 ---');
  for (const e of eTop) {
    console.log(
      `#${e.id} freq=${e.freq} same=${e.same} next=${e.next} win=${e.win} fail=${e.fail}`,
    );
    console.log(`    ${e.follower} -> ${e.target}`);
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});