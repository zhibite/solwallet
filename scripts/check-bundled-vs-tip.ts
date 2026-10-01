// scripts/check-bundled-vs-tip.ts
import { query, pool } from '../src/lib/db';

async function main() {
  console.log('=== is_first_sniper=true 的买家：按 is_bundled/version 分组 ===');
  const r = await query<any>(`
    SELECT
      bb.is_bundled,
      bb.version,
      count(*) AS n,
      round(avg(bb.tip_sol::numeric), 9)    AS avg_tip,
      round(avg(bb.prio_lamports), 0)       AS avg_prio,
      sum(CASE WHEN bb.tip_sol::numeric = 0 THEN 1 ELSE 0 END) AS zero_tip,
      sum(CASE WHEN bb.tip_sol::numeric > 0 THEN 1 ELSE 0 END) AS nonzero_tip
    FROM block_buyers bb
    WHERE bb.is_first_sniper = true
    GROUP BY bb.is_bundled, bb.version
    ORDER BY bb.is_bundled DESC, bb.version
  `);
  console.table(r);

  console.log('\n=== 关键点：is_bundled=true 但 tip=0 的样本 ===');
  const samples = await query<any>(`
    SELECT
      a.slot,
      substring(bb.address, 1, 8) AS sniper,
      bb.tip_sol::text            AS tip,
      bb.prio_lamports            AS prio,
      bb.meta_fee                 AS meta_fee,
      bb.native_transfer_count    AS nt_count,
      bb.native_transfer_jito_count AS nt_jito
    FROM block_buyers bb
    JOIN block_analyses a ON a.id = bb.block_analysis_id
    WHERE bb.is_first_sniper = true
      AND bb.is_bundled = true
      AND bb.tip_sol::numeric = 0
    ORDER BY a.id DESC
    LIMIT 5
  `);
  console.table(samples);

  console.log('\n=== 找一笔 is_bundled=true 且 tip>0 的，作为 sanity check ===');
  const sanity = await query<any>(`
    SELECT
      a.slot,
      bb.address                  AS sniper,
      bb.tip_sol::text            AS tip,
      bb.prio_lamports            AS prio,
      bb.meta_fee                 AS meta_fee,
      bb.native_transfer_count    AS nt_count,
      bb.native_transfer_jito_count AS nt_jito
    FROM block_buyers bb
    JOIN block_analyses a ON a.id = bb.block_analysis_id
    WHERE bb.is_bundled = true
      AND bb.tip_sol::numeric > 0
    ORDER BY a.id DESC
    LIMIT 5
  `);
  console.table(sanity);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
