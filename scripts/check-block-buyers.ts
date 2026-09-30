// scripts/check-block-buyers.ts
import { query, pool } from '../src/lib/db';

async function main() {
  const stats = await query<any>(`
    SELECT
      (SELECT COUNT(*)::int FROM block_buyers) AS bb_total,
      (SELECT COUNT(*)::int FROM block_buyers WHERE is_first_sniper) AS fs_total,
      (SELECT COUNT(*)::int FROM block_buyers WHERE is_follower) AS fol_total,
      (SELECT COUNT(*)::int FROM block_buyers WHERE is_own) AS own_total,
      (SELECT COUNT(*)::int FROM block_analyses) AS ba_total,
      (SELECT COUNT(*)::int FROM target_trades) AS tt_total
  `);
  console.log('统计:', stats[0]);
  const sample = await query<any>(`
    SELECT bb.id, bb.signature, bb.address,
           bb.tip_sol::text AS tip_sol,
           bb.prio_lamports, bb.buy_sol::text AS buy_sol,
           bb.is_first_sniper, bb.is_follower, bb.is_own,
           ba.slot, ba.mint, ba.target_signature
    FROM block_buyers bb
    JOIN block_analyses ba ON ba.id = bb.block_analysis_id
    ORDER BY bb.id DESC
    LIMIT 8
  `);
  console.log('\n最近的 8 条 block_buyers:');
  for (const r of sample) {
    console.log(`  #${r.id} sig=${r.signature?.slice(0, 12)}... addr=${r.address?.slice(0, 6)}... tip=${r.tip_sol} prio=${r.prio_lamports} buy=${r.buy_sol} fs=${r.is_first_sniper} fol=${r.is_follower} own=${r.is_own}`);
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
