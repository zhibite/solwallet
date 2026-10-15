/**
 * Backfill 所有 pending 的 PnL（含 follower / pre_target）
 *
 * 用途：替换 pnl-worker.ts（已删除）的兜底工作。
 *       当 monitor 的 setImmediate 失败 / 进程重启在算到一半时 kill，
 *       block_buyers.pnl_status 会留 NULL。本脚本一次性扫近 N 天的所有
 *       pending block_buyers，逐 block 调 computeBulkBuyerPnL（已有并发限流）补齐。
 *
 * 与 backfill-sniper-pnl.ts 的区别：
 *   - 后者只算 first_sniper / own / target 三个高优先级 role
 *   - 本脚本扫的是所有 buyer（含 follower / pre_target），
 *     用于补齐 sniper-ranking / pool analytics 等聚合页面的依赖数据
 *
 * 用法：
 *   npx tsx scripts/backfill-all-pending-pnl.ts                    # 全部
 *   BACKFILL_DAYS=1 npx tsx scripts/backfill-all-pending-pnl.ts   # 只补近 1 天
 *   BACKFILL_FROM_SLOT=456738962 npx tsx scripts/backfill-all-pending-pnl.ts
 *   BACKFILL_LIMIT=10 npx tsx scripts/backfill-all-pending-pnl.ts
 *
 * Helius 配额：每个 buyer ~3-8 cr；每 block 平均 5-20 个 buyer ≈ 15-160 cr。
 *             上千个 block 时谨慎，配额吃紧就调小 BACKFILL_LIMIT。
 *
 * 并发：复用 computeBulkBuyerPnL 内部 BULK_PNL_CONCURRENCY=4（block 内 buyer 并发）。
 *       block 之间这里顺序执行，避免 RPC 雪崩。
 */
import { query } from '../src/lib/db';
import { computeBulkBuyerPnL } from '../src/lib/first-sniper';

const MAX_AGE_DAYS = parseInt(process.env.BACKFILL_DAYS || '7', 10);
const FROM_SLOT = parseInt(process.env.BACKFILL_FROM_SLOT || '0', 10);
const LIMIT = parseInt(process.env.BACKFILL_LIMIT || '0', 10); // 0 = 全部
const DRY_RUN = process.env.BACKFILL_DRY_RUN === '1';

interface BlockRow {
  slot: string;          // BIGINT → string
  mint: string;
  pending_count: string; // COUNT → string
}

(async () => {
  const sql = `
    SELECT ba.slot::text AS slot, ba.mint, COUNT(bb.id)::text AS pending_count
      FROM block_analyses ba
      JOIN block_buyers bb ON bb.block_analysis_id = ba.id
     WHERE ba.block_time >= NOW() - ($1 || ' days')::interval
       ${FROM_SLOT > 0 ? `AND ba.slot >= $2` : ''}
       AND bb.pnl_status IS NULL
       AND bb.result = 'success'
     GROUP BY ba.slot, ba.mint, ba.block_time
     ORDER BY ba.block_time DESC
     ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ''}
  `;
  const params = FROM_SLOT > 0 ? [MAX_AGE_DAYS, FROM_SLOT] : [MAX_AGE_DAYS];
  const blocks = await query<BlockRow>(sql, params);

  const totalPending = blocks.reduce((sum, b) => sum + parseInt(b.pending_count, 10), 0);
  console.log(
    `[backfill-all-pending-pnl] 待处理 block=${blocks.length} 待算 buyer=${totalPending}` +
    ` (${MAX_AGE_DAYS} 天窗口${FROM_SLOT > 0 ? `, slot >= ${FROM_SLOT}` : ''}${LIMIT > 0 ? `, LIMIT ${LIMIT}` : ''})`,
  );
  if (DRY_RUN) {
    console.log('[backfill-all-pending-pnl] DRY_RUN=1，不执行 computeBulkBuyerPnL');
    process.exit(0);
  }
  if (blocks.length === 0) {
    console.log('[backfill-all-pending-pnl] 无待算项，退出。');
    process.exit(0);
  }

  const start = Date.now();
  let blocksDone = 0;
  let buyersComputed = 0;
  let buyersFailed = 0;
  let blocksFailed = 0;
  const failedBlocks: Array<{ slot: string; mint: string; err: string }> = [];

  for (const b of blocks) {
    const slot = Number(b.slot);
    const expected = parseInt(b.pending_count, 10);
    try {
      const r = await computeBulkBuyerPnL(slot, b.mint);
      const closed = r.results.filter((x) => x.status === 'closed').length;
      const open = r.results.filter((x) => x.status === 'open').length;
      const partial = r.results.filter((x) => x.status === 'partial').length;
      const errors = r.results.filter((x) => x.status === 'error').length;
      buyersComputed += r.results.length - errors;
      buyersFailed += errors;
      blocksDone++;
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      console.log(
        `  [${blocksDone}/${blocks.length}] slot=${slot} mint=${b.mint.slice(0, 8)}... ` +
        `computed=${r.results.length}/${expected} (closed=${closed} open=${open} partial=${partial} err=${errors}) 用时=${elapsed}s`,
      );
    } catch (e: any) {
      blocksFailed++;
      failedBlocks.push({ slot: b.slot, mint: b.mint, err: e?.message ?? String(e) });
      console.warn(`  [${blocksDone + 1}/${blocks.length}] slot=${slot} 失败:`, e?.message ?? e);
    }
  }

  console.log(`\n[backfill-all-pending-pnl] 完成。`);
  console.log(`  blocks: ok=${blocksDone} err=${blocksFailed}`);
  console.log(`  buyers: computed=${buyersComputed} err=${buyersFailed}`);
  if (failedBlocks.length > 0) {
    console.log(`\n失败 block ${failedBlocks.length} 条:`);
    for (const f of failedBlocks.slice(0, 10)) {
      console.log(`  slot=${f.slot} mint=${f.mint.slice(0, 8)}... err=${f.err.slice(0, 100)}`);
    }
  }
  process.exit(0);
})();