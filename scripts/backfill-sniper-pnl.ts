/**
 * Backfill 狙击者 / 自己的 PnL
 *
 * 用途：监控列表「跟单收益」列要展示狙击者那笔的 PnL。这个脚本只补 first_sniper /
 *       own / target 三个 role 的 buyer；其他 buyer（follower / pre_target）的
 *       完整补齐见 scripts/backfill-all-pending-pnl.ts。
 *
 * 复用：first-sniper.ts 的 computeBulkBuyerPnL (force=true) 会跑所有 buyer 里的 pnl，
 *      太重；这里只对 first_sniper / own / target signature 三个 role 调 calcCopyPnl。
 *
 * Helius 配额：每笔 PnL 涉及 1 次 fetchSigsFrom（按签名翻页）+ 1 次 getTransaction（买入本身）
 *             + 1 批 fetchTxViews（按 100 一批分批拿后续 tx），平均 3-8 cr/笔。
 *             500 笔 × 5 cr ≈ 2500 cr，正常配额能扛。
 *
 * 并发：4 笔 / 轮（参考 BULK_PNL_CONCURRENCY 默认）。
 */
import { query } from '../src/lib/db';
import { calcCopyPnl } from '../src/lib/pnl';
import { execute } from '../src/lib/db';

const CONCURRENCY = 4;
const MAX_AGE_DAYS = parseInt(process.env.BACKFILL_PNL_DAYS || '30', 10);
const LIMIT = parseInt(process.env.BACKFILL_PNL_LIMIT || '0', 10); // 0 = 全部

interface BuyerRow {
  id: number;
  signature: string;
  address: string;
  mint: string;
  block_time: string;
  buy_sol: string;
  token_amount: string | null;
  role: 'first_sniper' | 'own' | 'target';
}

(async () => {
  // 1) 找出所有"该算但还没算"的 buyer 行
  //    - block_buyers.result = 'success'（失败的 PnL 恒为 -fee，不需算）
  //    - is_first_sniper = true OR is_own = true OR signature = block_analyses.target_signature
  //    - pnl_status IS NULL（已算过的跳过）
  //    - block_time 在 MAX_AGE_DAYS 天内
  const sql = `
    SELECT bb.id, bb.signature, bb.address, ba.mint, ba.block_time,
           bb.buy_sol::text AS buy_sol, bb.token_amount::text AS token_amount,
           CASE
             WHEN bb.is_first_sniper = true THEN 'first_sniper'
             WHEN bb.is_own = true THEN 'own'
             WHEN bb.signature = ba.target_signature THEN 'target'
           END AS role
      FROM block_buyers bb
      JOIN block_analyses ba ON ba.id = bb.block_analysis_id
     WHERE ba.block_time >= NOW() - ($1 || ' days')::interval
       AND bb.result = 'success'
       AND bb.pnl_status IS NULL
       AND (bb.is_first_sniper = true
            OR bb.is_own = true
            OR bb.signature = ba.target_signature)
     ORDER BY ba.block_time DESC
     ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ''}
  `;
  const buyers = await query<BuyerRow>(sql, [MAX_AGE_DAYS]);
  console.log(`待算 PnL: ${buyers.length} 笔 (${MAX_AGE_DAYS} 天窗口内 first_sniper/own/target)`);

  if (buyers.length === 0) {
    console.log('无待算项，退出。');
    process.exit(0);
  }

  // 2) 并发跑
  let done = 0;
  let ok = 0;
  let err = 0;
  let open = 0;
  let closed = 0;
  let partial = 0;
  const errors: Array<{ id: number; sig: string; err: string }> = [];

  const start = Date.now();
  async function worker(queue: BuyerRow[]): Promise<void> {
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
        await execute(
          `UPDATE block_buyers
              SET pnl_sol = $1, pnl_status = $2, pnl_sold_ratio = $3,
                  token_amount = COALESCE($4, token_amount)
            WHERE id = $5`,
          [r.pnlSol, r.status, r.soldRatio, buyTokenAmount, b.id],
        );
        ok++;
        if (r.status === 'open') open++;
        else if (r.status === 'closed') closed++;
        else if (r.status === 'partial') partial++;
      } catch (e: any) {
        err++;
        errors.push({ id: b.id, sig: b.signature, err: e?.message ?? String(e) });
      } finally {
        done++;
        if (done % 10 === 0) {
          const elapsed = ((Date.now() - start) / 1000).toFixed(0);
          const rate = (done / (Date.now() - start) * 1000).toFixed(2);
          console.log(`  [${done}/${buyers.length}] ok=${ok} err=${err} (open=${open} closed=${closed} partial=${partial}) 速率=${rate}/s  用时=${elapsed}s`);
        }
      }
    }
  }
  const queues: BuyerRow[][] = Array.from({ length: CONCURRENCY }, () => []);
  buyers.forEach((b, i) => queues[i % CONCURRENCY].push(b));
  await Promise.all(queues.map(worker));

  console.log(`\n完成。`);
  console.log(`  ok=${ok} (open=${open} closed=${closed} partial=${partial})`);
  console.log(`  err=${err}`);
  if (errors.length > 0) {
    console.log(`\n失败 ${errors.length} 条（前 10 条）:`);
    for (const e of errors.slice(0, 10)) {
      console.log(`  id=${e.id} sig=${e.sig.slice(0, 20)}... err=${e.err.slice(0, 100)}`);
    }
  }
  process.exit(0);
})();
