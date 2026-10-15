/**
 * backfill-sniper-rank.ts
 *
 * 回填历史 block_analyses 的狙击者竞争态势字段（0021 新加）：
 *   - block_analyses:  competitor_count, chosen_address, competitor_rank
 *   - block_buyers:   mine_rank, sniper_slot_delta, competitor_rank
 *
 * 用法：
 *   npx ts-node scripts/backfill-sniper-rank.ts [--limit 1000] [--slot-from 450000000]
 *
 * 逻辑：
 *   重新跑一遍 analyzeBlock（已有），但只写竞争态势这几个字段。
 *   已经存在非 null 值的不覆盖（除非 --force）。
 *
 * 性能：
 *   - 一次 SELECT 所有历史 block_analyses（有索引 idx_block_analyses_slot）
 *   - 每个 block 单独调用 analyzeBlock（涉及 RPC + Helius，~500ms/block）
 *   - 并发=4，累计总时间 ≈ N × 500ms / 4
 *   - 建议先 --limit 100 试跑验证
 */

import { query, queryOne } from '../src/lib/db';
import { analyzeBlock } from '../src/lib/first-sniper';
import { execute } from '../src/lib/db';

const args = process.argv.slice(2);
const LIMIT = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] ?? '100', 10);
const SLOT_FROM = parseInt(args.find(a => a.startsWith('--slot-from='))?.split('=')[1] ?? '0', 10);
const FORCE = args.includes('--force');

async function main() {
  console.log(`[backfill-sniper-rank] limit=${LIMIT} slot-from=${SLOT_FROM} force=${FORCE}`);

  // 1) 捞历史 block_analyses（只取还没填 competitor_count 的）
  const analyses = await query<any>(`
    SELECT ba.id, ba.slot, ba.mint, ba.target_signature
      FROM block_analyses ba
     WHERE ba.slot >= $1
       AND (ba.competitor_count IS NULL OR ba.chosen_address IS NULL OR $2)
     ORDER BY ba.slot DESC
     LIMIT $3
  `, [SLOT_FROM, FORCE, LIMIT]);

  console.log(`[backfill-sniper-rank] 找到 ${analyses.length} 个待回填的 block_analyses`);

  let done = 0;
  let skipped = 0;
  let failed = 0;

  for (const a of analyses) {
    try {
      const result = await analyzeBlock(a.slot, a.mint, a.target_signature);

      // 写 block_analyses 顶层
      await execute(
        `UPDATE block_analyses
            SET competitor_count = $1,
                chosen_address   = $2,
                competitor_rank  = $3
          WHERE id = $4`,
        [
          result.competitorCount,
          result.chosenAddress,
          JSON.stringify(result.competitorRank),
          a.id,
        ],
      );

      // 捞出这个 analysis 现在的 buyers，按 signature 匹配后逐个写 mine_rank / sniper_slot_delta / competitor_rank
      const buyers = await query<any>(
        'SELECT id, address, signature FROM block_buyers WHERE block_analysis_id = $1',
        [a.id],
      );
      const buyerBySig = new Map(buyers.map((b: any) => [b.signature, b]));

      for (const buyer of result.buyers) {
        const dbBuyer = buyerBySig.get(buyer.signature);
        if (!dbBuyer) continue;
        await execute(
          `UPDATE block_buyers
              SET mine_rank         = $1,
                  sniper_slot_delta = $2,
                  competitor_rank   = $3
            WHERE id = $4`,
          [
            buyer.mineRank,
            buyer.sniperSlotDelta,
            buyer.competitorRank,
            dbBuyer.id,
          ],
        );
      }

      done++;
      if (done % 10 === 0) {
        console.log(`[backfill-sniper-rank] 进度 ${done}/${analyses.length}`);
      }
    } catch (err: any) {
      failed++;
      console.warn(`[backfill-sniper-rank] 失败 slot=${a.slot} mint=${a.mint.slice(0, 8)}…: ${err?.message ?? err}`);
    }
  }

  console.log(`[backfill-sniper-rank] 完成 done=${done} skipped=${skipped} failed=${failed}`);
}

main().catch(console.error);
