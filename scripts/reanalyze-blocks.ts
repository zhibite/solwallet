// scripts/reanalyze-blocks.ts
// 用修复后的 parser 重新跑 analyzeBlock，把 tip/prio/buy 写回 DB
import { query, pool, withTransaction } from '../src/lib/db';
import { analyzeBlock, saveBlockAnalysis } from '../src/lib/first-sniper';

async function main() {
  const blocks = await query<any>(`
    SELECT id, slot, mint, target_signature, block_time
    FROM block_analyses
    ORDER BY id
  `);
  console.log(`准备重跑 ${blocks.length} 个 block_analysis\n`);
  for (const b of blocks) {
    console.log(`--- slot=${b.slot} mint=${b.mint?.slice(0, 6)} target=${b.target_signature?.slice(0, 8)} ---`);
    const r = await analyzeBlock(b.slot, b.mint, b.target_signature);
    const id = await saveBlockAnalysis(b.slot, b.mint, b.target_signature, b.block_time, r);
    console.log(`  rewritten analysis_id=${id}  buyers=${r.buyers.length}`);
    for (const buyer of r.buyers) {
      console.log(`    [${buyer.mark}] ${buyer.address?.slice(0, 6)}  tip=${buyer.tipSol}  prio=${buyer.prioLamports}  buy=${buyer.buySol}`);
    }
  }
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
