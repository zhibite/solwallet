// scripts/check-pool-freq.ts
// Usage: npx tsx --env-file=.env scripts/check-pool-freq.ts
import { query, queryOne, pool } from '../src/lib/db';

async function main() {
  console.log('===== pool 关联数据完整性校验 =====\n');

  // 1) 每个 target 的 target_trades 数
  const tradesPerTarget = await query<any>(`
    SELECT target_address, COUNT(*)::int AS trades
    FROM target_trades
    GROUP BY target_address
    ORDER BY trades DESC
  `);
  console.log('--- target_trades per target ---');
  for (const r of tradesPerTarget) {
    console.log(`  ${r.target_address?.slice(0, 6)}... trades=${r.trades}`);
  }

  // 2) 每个 pool_member 在 block_buyers 中的原始命中明细
  console.log('\n--- pool_members 实际 block_buyers 命中明细 ---');
  const detail = await query<any>(`
    SELECT pm.address,
           pm.freq::int AS pm_freq,
           pm.seen_as_first_sniper::int AS pm_fs,
           pm.seen_as_follower::int AS pm_fol,
           pm.role AS pm_role,
           pm.distinct_targets::int AS pm_dt,
           (SELECT COUNT(*)::int FROM block_buyers bb
              JOIN block_analyses ba ON ba.id = bb.block_analysis_id
              JOIN target_trades t ON t.signature = ba.target_signature
              WHERE bb.address = pm.address
                AND t.target_address <> bb.address) AS bb_total,
           (SELECT COUNT(*)::int FROM block_buyers bb
              JOIN block_analyses ba ON ba.id = bb.block_analysis_id
              JOIN target_trades t ON t.signature = ba.target_signature
              WHERE bb.address = pm.address
                AND bb.slot_offset = 0
                AND t.target_address <> bb.address) AS bb_fs,
           (SELECT COUNT(*)::int FROM block_buyers bb
              JOIN block_analyses ba ON ba.id = bb.block_analysis_id
              JOIN target_trades t ON t.signature = ba.target_signature
              WHERE bb.address = pm.address
                AND bb.slot_offset = 1
                AND t.target_address <> bb.address) AS bb_fol,
           (SELECT array_agg(DISTINCT t.target_address)
              FROM block_buyers bb
              JOIN block_analyses ba ON ba.id = bb.block_analysis_id
              JOIN target_trades t ON t.signature = ba.target_signature
              WHERE bb.address = pm.address
                AND t.target_address <> bb.address) AS bb_targets
    FROM pool_members pm
    ORDER BY pm_freq DESC, pm.address
  `);
  console.log('  pm_freq/pm_fs/pm_fol | bb_total/bb_fs/bb_fol | bb_targets | pm_role');
  for (const r of detail) {
    const ok = r.pm_freq === r.bb_total && r.pm_fs === r.bb_fs && r.pm_fol === r.bb_fol;
    console.log(`  ${ok ? 'OK ' : 'MISMATCH '} ${r.pm_freq}/${r.pm_fs}/${r.pm_fol}  | ${r.bb_total}/${r.bb_fs}/${r.bb_fol} | ${(r.bb_targets ?? []).length} targets | ${r.pm_role}`);
    if (!ok) console.log(`    address=${r.address}`);
  }

  // 3) pool_edges freq 校验
  console.log('\n--- pool_edges freq 校验 ---');
  const edgeDetail = await query<any>(`
    SELECT pe.id, pe.follower, pe.target,
           pe.freq::int AS pe_freq,
           pe.same_slot_count::int AS pe_same,
           pe.next_slot_count::int AS pe_next,
           pe.win_count::int AS pe_win,
           pe.fail_count::int AS pe_fail,
           (SELECT COUNT(*)::int FROM block_buyers bb
              JOIN block_analyses ba ON ba.id = bb.block_analysis_id
              JOIN target_trades t ON t.signature = ba.target_signature
              WHERE bb.address = pe.follower
                AND t.target_address = pe.target) AS bb_total,
           (SELECT COUNT(*)::int FROM block_buyers bb
              JOIN block_analyses ba ON ba.id = bb.block_analysis_id
              JOIN target_trades t ON t.signature = ba.target_signature
              WHERE bb.address = pe.follower
                AND bb.slot_offset = 0
                AND t.target_address = pe.target) AS bb_same,
           (SELECT COUNT(*)::int FROM block_buyers bb
              JOIN block_analyses ba ON ba.id = bb.block_analysis_id
              JOIN target_trades t ON t.signature = ba.target_signature
              WHERE bb.address = pe.follower
                AND bb.slot_offset = 1
                AND t.target_address = pe.target) AS bb_next
    FROM pool_edges pe
    ORDER BY pe_freq DESC
  `);
  for (const r of edgeDetail) {
    const ok =
      r.pe_freq === r.bb_total &&
      r.pe_same === r.bb_same &&
      r.pe_next === r.bb_next;
    console.log(`  ${ok ? 'OK ' : 'MISMATCH '} freq=${r.pe_freq}/${r.bb_total} same=${r.pe_same}/${r.bb_same} next=${r.pe_next}/${r.bb_next} win=${r.pe_win} fail=${r.pe_fail}`);
    if (!ok) console.log(`    ${r.follower?.slice(0, 6)} -> ${r.target?.slice(0, 6)}`);
  }

  // 4) 检查每个 pool_member 是否曾经以「两种角色」出现过
  console.log('\n--- mixed role? ---');
  const mixed = await query<any>(`
    SELECT pm.address, pm.role,
           (SELECT COUNT(DISTINCT bb.slot_offset)::int FROM block_buyers bb
              JOIN block_analyses ba ON ba.id = bb.block_analysis_id
              JOIN target_trades t ON t.signature = ba.target_signature
              WHERE bb.address = pm.address
                AND t.target_address <> bb.address) AS distinct_offsets
    FROM pool_members pm
  `);
  for (const r of mixed) {
    if (r.distinct_offsets === 2) {
      console.log(`  MIXED: ${r.address?.slice(0, 6)}... role=${r.role} distinct_offsets=${r.distinct_offsets}`);
    }
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});