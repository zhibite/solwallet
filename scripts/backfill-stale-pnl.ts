/**
 * Backfill 已被 cron 标记为 'stale' 的 PnL 行
 *
 * 背景：
 *   cron POST /api/cron/compute-pnl 每 15min 跑一次：把 >2h 仍 pnl_status IS NULL
 *   的 block_buyers 主动标 'stale'，避免历史积压挤占新数据的并发额度。
 *   但这些行从来没真正算过 PnL，UI 看到 "已过期" / "算中" 都没数字。
 *
 *   本脚本是离线兜底：找出所有 pnl_status='stale' 的行，挨个重跑 calcCopyPnl
 *   并写回。算完是 open 的（sniper 真没卖）保留 open；是 closed/partial 的就
 *   直接覆盖 stale 给出真实数字。脚本可重复跑，幂等。
 *
 * 为什么不复用 backfill-sniper-pnl.ts：那个查的是 pnl_status IS NULL，本脚本
 * 查的是 pnl_status='stale'，两条 SQL 互不重叠，合在一起会让单轮 worker 数量
 * 翻倍、间接提高 Helius 限流概率。
 *
 * Helius 配额：单笔 PnL 平均 3-8 cr（fetchSigsFrom + getTransaction + fetchTxViews）。
 *             3876 行 ≈ 15000-30000 cr，建议：
 *               - BACKFILL_STALE_LIMIT=200 先试跑
 *               - 跑通后去掉 LIMIT 全量补
 *               - 真的需要分多天跑：BACKFILL_STALE_DAYS=1 配合 cron 跑
 *             实测：4 路并发 200 笔 / 200s ~ 1 笔/s（受限 Helius rps），可接受。
 *
 * 用法：
 *   pnpm tsx --env-file=.env scripts/backfill-stale-pnl.ts              # 全部
 *   BACKFILL_STALE_LIMIT=200 pnpm tsx ... backfill-stale-pnl.ts         # 试跑 200 条
 *   BACKFILL_STALE_DAYS=7 BACKFILL_STALE_LIMIT=500 pnpm tsx ...         # 只看 7 天内
 *   BACKFILL_STALE_CONCURRENCY=2 pnpm tsx ... backfill-stale-pnl.ts     # 调小并发
 */
import { query, execute } from '../src/lib/db';
import { calcCopyPnl } from '../src/lib/pnl';

const CONCURRENCY = Math.max(1, parseInt(process.env.BACKFILL_STALE_CONCURRENCY || '4', 10));
const MAX_AGE_DAYS = parseInt(process.env.BACKFILL_STALE_DAYS || '30', 10);
const LIMIT = parseInt(process.env.BACKFILL_STALE_LIMIT || '0', 10); // 0 = 全部

interface StaleRow {
  id: number;
  signature: string;
  address: string;
  mint: string;
  block_time: string;
  buy_sol: string;
  token_amount: string | null;
  role: 'first_sniper' | 'own' | 'follower' | 'pre_target' | 'target';
}

(async () => {
  // 1) 找出所有 pnl_status='stale' 的行。复用 backfill-sniper-pnl.ts 的 role 判定，
  //    范围扩展到 follower / pre_target —— 这两类过去也会被 cron 标 stale，一起补。
  //
  // 范围限定：
  //   - ba.block_time >= NOW() - $1 days：超过窗口的 stale 行非常老（FIFO 翻 10min 签名页
  //     也找不到卖出），硬算大概率失败 + 浪费配额。需要的话用 BACKFILL_STALE_DAYS=0 解除。
  //   - 排除买入失败的行（result='failed'），它们的 PnL 恒为 -fee，不需要算。
  //   - 按 block_time DESC：最新的先跑（用户先看到结果），老的放后面。
  const sql = `
    SELECT bb.id, bb.signature, bb.address, ba.mint, ba.block_time,
           bb.buy_sol::text AS buy_sol, bb.token_amount::text AS token_amount,
           CASE
             WHEN bb.is_first_sniper = true THEN 'first_sniper'
             WHEN bb.is_own = true THEN 'own'
             WHEN bb.signature = ba.target_signature THEN 'target'
             WHEN bb.is_follower = true THEN 'follower'
             WHEN bb.is_pre_target = true THEN 'pre_target'
           END AS role
      FROM block_buyers bb
      JOIN block_analyses ba ON ba.id = bb.block_analysis_id
     WHERE bb.pnl_status = 'stale'
       AND bb.result = 'success'
       AND ba.block_time >= NOW() - ($1 || ' days')::interval
     ORDER BY ba.block_time DESC
     ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ''}
  `;
  const rows = await query<StaleRow>(sql, [MAX_AGE_DAYS]);
  console.log(
    `[backfill-stale-pnl] 待处理: ${rows.length} 笔 (${MAX_AGE_DAYS} 天窗口内 stale 行; 并发=${CONCURRENCY})`,
  );
  if (rows.length === 0) {
    console.log('  无 stale 行，退出。');
    process.exit(0);
  }

  // 2) 并发跑 calcCopyPnl。
  //    单笔失败的常见原因：sniper 钱包已废弃/钱包没在 10min 内卖出导致 FIFO 拿不到
  //    卖出签名页、Helius 429。失败时把 pnl_status 留为 'stale'（不覆盖原状态），
  //    这样下次 cron 仍会跳过、用户侧仍能区分"未算完"。
  let done = 0, ok = 0, err = 0, open = 0, closed = 0, partial = 0;
  const errors: Array<{ id: number; sig: string; err: string }> = [];

  const start = Date.now();
  async function worker(queue: StaleRow[]): Promise<void> {
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
        const msg = e?.message ?? String(e);
        errors.push({ id: b.id, sig: b.signature, err: msg });
        // 失败时不动 DB —— 留 'stale'，让运维能继续区分"未跑过"和"已跑过但报错"
      } finally {
        done++;
        if (done % 25 === 0 || done === rows.length) {
          const elapsed = ((Date.now() - start) / 1000).toFixed(0);
          const rate = (done / Math.max(1, Date.now() - start) * 1000).toFixed(2);
          console.log(
            `  [${done}/${rows.length}] ok=${ok} err=${err} ` +
            `(open=${open} closed=${closed} partial=${partial}) ` +
            `速率=${rate}/s 用时=${elapsed}s`,
          );
        }
      }
    }
  }

  const queues: StaleRow[][] = Array.from({ length: CONCURRENCY }, () => []);
  rows.forEach((r, i) => queues[i % CONCURRENCY].push(r));
  await Promise.all(queues.map(worker));

  console.log(`\n[backfill-stale-pnl] 完成。`);
  console.log(`  ok=${ok}  (open=${open} closed=${closed} partial=${partial})`);
  console.log(`  err=${err}`);
  console.log(`  pnl_status 仍为 'stale' 的行数: ${rows.length - ok - err}`);
  if (errors.length > 0) {
    console.log(`\n失败 ${errors.length} 条（前 10 条）:`);
    for (const e of errors.slice(0, 10)) {
      console.log(`  id=${e.id} sig=${e.sig.slice(0, 20)}... err=${e.err.slice(0, 120)}`);
    }
  }
  console.log(
    `\n提示：重跑请直接再执行本脚本即可。已算过的行 pnl_status 变成 open/closed/partial，`
    + `不会被本脚本再 pick（脚本只查 pnl_status='stale'）。`,
  );
  process.exit(0);
})();
