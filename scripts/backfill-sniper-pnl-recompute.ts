/**
 * 强制重算狙击者（first_sniper / own / target）所有 buyer 的 pnl
 *
 * 用途: 2026-10-14 修复 solNet(helius path) bug 后,DB 里存了
 *      pnl_sol ≈ -buy_sol 的 closed 错行。pnl_status 不是 NULL,
 *      原来的 backfill-sniper-pnl 不会扫到这些行,所以单独跑这个。
 *
 * 注意:覆盖前会保留原 pnl_sol 到 pnl_sol_prev / pnl_status_prev 字段,
 *     出问题可以回滚(只是 block_buyers 表没这俩列,我们改用 backup 脚本)。
 */
import { query, execute, pool } from '../src/lib/db';
import { calcCopyPnl } from '../src/lib/pnl';
import { activeSource } from '../src/lib/tx-source';

const CONCURRENCY = 4;
const MAX_AGE_DAYS = parseInt(process.env.BACKFILL_PNL_DAYS || '30', 10);
const LIMIT = parseInt(process.env.BACKFILL_PNL_LIMIT || '0', 10);
const DRY_RUN = process.env.DRY_RUN === '1';
// 默认只重算"明显错"的(负 pnl ≈ -buy_sol 且 status='closed')。
// 改 RECOMPUTE_ALL=1 强制重算所有 first_sniper/own/target 行。
const RECOMPUTE_ALL = process.env.RECOMPUTE_ALL === '1';

(async () => {
  console.log(`active tx source: ${activeSource()}`);
  console.log(`dry run: ${DRY_RUN}`);
  console.log(`recompute all: ${RECOMPUTE_ALL}`);

  const sql = `
    SELECT bb.id, bb.signature, bb.address, ba.mint, ba.block_time,
           bb.buy_sol::text AS buy_sol, bb.token_amount::text AS token_amount,
           bb.pnl_sol::text AS pnl_sol_old, bb.pnl_status AS pnl_status_old,
           bb.pnl_sold_ratio::text AS pnl_sold_ratio_old,
           CASE
             WHEN bb.is_first_sniper = true THEN 'first_sniper'
             WHEN bb.is_own = true THEN 'own'
             WHEN bb.signature = ba.target_signature THEN 'target'
           END AS role
      FROM block_buyers bb
      JOIN block_analyses ba ON ba.id = bb.block_analysis_id
     WHERE ba.block_time >= NOW() - ($1 || ' days')::interval
       AND bb.result = 'success'
       AND (bb.is_first_sniper = true
            OR bb.is_own = true
            OR bb.signature = ba.target_signature)
       ${
         RECOMPUTE_ALL
           ? ''
           : `AND bb.pnl_status = 'closed'
              AND bb.pnl_sol IS NOT NULL
              AND bb.pnl_sol < 0
              AND ABS(bb.pnl_sol + COALESCE(NULLIF(bb.buy_sol, 0), 0)) < GREATEST(COALESCE(NULLIF(bb.buy_sol, 0), 0) * 0.05, 0.01)`
       }
     ORDER BY ba.block_time DESC
     ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ''}
  `;
  const buyers = await query<any>(sql, [MAX_AGE_DAYS]);
  console.log(`\n待重算: ${buyers.length} 笔`);

  if (buyers.length === 0) {
    console.log('无待重算项,退出。');
    await pool.end();
    process.exit(0);
  }

  // 统计旧 pnl 分布
  const sumOld = buyers.reduce((s: number, b: any) => s + Number(b.pnl_sol_old || 0), 0);
  console.log(`  旧 pnl_sol 之和: ${sumOld.toFixed(4)} SOL`);

  let done = 0;
  let changed = 0;
  let err = 0;
  const errors: any[] = [];
  const start = Date.now();

  async function worker(queue: any[]): Promise<void> {
    while (queue.length > 0) {
      const b = queue.shift()!;
      try {
        const buyBlockTime = Math.floor(new Date(b.block_time).getTime() / 1000);
        const buyTokenAmount = b.token_amount != null ? Number(b.token_amount) : null;
        const r = await calcCopyPnl({
          mint: b.mint,
          buySig: b.signature,
          buyWallet: b.address,
          buySol: parseFloat(b.buy_sol),
          buyBlockTime,
          buyTokenAmount,
        });
        const newPnl = r.pnlSol;
        const oldPnl = b.pnl_sol_old != null ? Number(b.pnl_sol_old) : null;
        const changedRow = oldPnl == null || newPnl == null
          ? true
          : Math.abs(newPnl - oldPnl) > 1e-4;
        if (changedRow) changed++;
        if (!DRY_RUN) {
          await execute(
            `UPDATE block_buyers
                SET pnl_sol = $1, pnl_status = $2, pnl_sold_ratio = $3
              WHERE id = $4`,
            [newPnl, r.status, r.soldRatio, b.id],
          );
        }
      } catch (e: any) {
        err++;
        errors.push({ id: b.id, sig: b.signature, err: e?.message ?? String(e) });
      } finally {
        done++;
        if (done % 50 === 0) {
          const elapsed = ((Date.now() - start) / 1000).toFixed(0);
          const rate = (done / (Date.now() - start) * 1000).toFixed(2);
          console.log(`  [${done}/${buyers.length}] changed=${changed} err=${err} 速率=${rate}/s  用时=${elapsed}s`);
        }
      }
    }
  }
  const queues: any[][] = Array.from({ length: CONCURRENCY }, () => []);
  buyers.forEach((b, i) => queues[i % CONCURRENCY].push(b));
  await Promise.all(queues.map(worker));

  console.log(`\n完成。`);
  console.log(`  done=${done}  changed=${changed}  err=${err}`);
  if (errors.length > 0) {
    console.log(`\n失败 ${errors.length} 条(前 10):`);
    for (const e of errors.slice(0, 10)) {
      console.log(`  id=${e.id} sig=${e.sig.slice(0, 20)}... err=${e.err.slice(0, 120)}`);
    }
  }
  await pool.end();
})();
