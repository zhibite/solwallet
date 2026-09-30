// scripts/check-first-sniper.ts
import { query, pool } from '../src/lib/db';

async function main() {
  // 看每个 block_analysis 里的 buyer 顺序 + target 在哪个位置
  const analyses = await query<any>(`
    SELECT id, slot, mint, target_signature, target_block_index
    FROM block_analyses
    ORDER BY id
  `);
  for (const a of analyses) {
    console.log(`\n=== block_analysis #${a.id} slot=${a.slot} mint=${a.mint?.slice(0, 6)} target_sig=${a.target_signature?.slice(0, 8)} target_block_index=${a.target_block_index} ===`);
    const buyers = await query<any>(`
      SELECT block_index, slot_offset, signature, address,
             is_first_sniper, is_follower, is_own, is_pre_target,
             tip_sol::text AS tip, prio_lamports AS prio
      FROM block_buyers
      WHERE block_analysis_id = $1
      ORDER BY slot_offset, block_index
    `, [a.id]);
    for (const b of buyers) {
      const marks = [
        b.is_first_sniper ? 'FS' : '',
        b.is_follower ? 'FOL' : '',
        b.is_own ? 'OWN' : '',
        b.is_pre_target ? 'PRE' : '',
      ].filter(Boolean).join(',') || '-';
      const targetTag = b.signature === a.target_signature ? '  ★TARGET' : '';
      console.log(`  slot_off=${b.slot_offset} idx=${String(b.block_index).padStart(2)} ${marks.padEnd(6)} addr=${b.address?.slice(0, 6)} tip=${b.tip} prio=${b.prio}${targetTag}`);
    }
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
