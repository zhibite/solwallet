/**
 * 浮盈刷新 Worker
 *
 * 每 30s 批量拉取 pnl_status IN ('open', 'partial') 的 block_buyers 行，
 * 对 hot (0~1min) / warm (1~10min) 两档按 TTL 刷新当前价格和浮盈，
 * 写入 block_buyers.current_price_sol / unrealized_sol / total_pnl_sol。
 *
 * 与 scripts/refresh-unrealized.ts 逻辑完全一致，区别是：
 *   - 入口是 setInterval，不是 CLI 一次性脚本
 *   - 由 instrumentation.ts 在服务启动时注册（无需 watch -n 30 手动跑）
 *
 * 三档分级：
 *   hot  (0~1 min)：   TTL 15s
 *   warm (1~10 min)：  TTL 60s
 *   cold (>10 min)：    默认跳过（超出 FIFO 持仓窗口，无意义）
 *
 * 启动入口：instrumentation.ts
 */

import { query, execute } from './db';
import { enrichWithUnrealized, type EnrichableBuyer } from './pnl';

const TICK_MS = 30_000;                  // 每 30s 扫一轮
const LIMIT = 500;                        // 单次最多处理行数

const HOT_TTL_SEC  = 15;
const WARM_TTL_SEC = 60;
const WINDOW_HOT_MS  = 60 * 1000;
const WINDOW_WARM_MS = 10 * 60 * 1000;
const BATCH_FLUSH = 50;
const SLOW_MS = 4000;

interface RefreshRow {
  id: number;
  mint: string;
  token_amount: string | null;
  buy_sol: string | null;
  pnl_sol: string | null;
  pnl_sold_ratio: string | null;
  pnl_status: string | null;
  age_ms: number;
}

interface BatchEntry {
  id: number;
  price: number | null;
  unrealized: number | null;
  total: number | null;
  ts: Date;
}

async function flushBatch(batch: BatchEntry[]): Promise<void> {
  if (batch.length === 0) return;
  const ids        = batch.map((b) => b.id);
  const prices     = batch.map((b) => b.price);
  const unrealized = batch.map((b) => b.unrealized);
  const totals     = batch.map((b) => b.total);
  const tss       = batch.map((b) => b.ts);

  const sql = `
    UPDATE block_buyers
       SET current_price_sol = u.price,
           unrealized_sol    = u.unrealized,
           total_pnl_sol     = u.total,
           price_updated_at  = u.ts
      FROM unnest($1::int[], $2::numeric[], $3::numeric[], $4::numeric[], $5::timestamptz[])
           AS u(id, price, unrealized, total, ts)
     WHERE block_buyers.id = u.id`;

  const updated = await execute(sql, [ids, prices, unrealized, totals, tss]);
  console.log(
    `[unrealized-worker] flush ${updated}/${batch.length} 行写入成功`,
  );
}

async function tick(): Promise<void> {
  const rows = await query<RefreshRow>(
    `SELECT * FROM (
       SELECT bb.id, ba.mint, bb.token_amount, bb.buy_sol,
              bb.pnl_sol, bb.pnl_sold_ratio, bb.pnl_status,
              bb.price_updated_at,
              (EXTRACT(EPOCH FROM (NOW() - ba.block_time)) * 1000)::bigint AS age_ms
         FROM block_buyers bb
         JOIN block_analyses ba ON ba.id = bb.block_analysis_id
        WHERE bb.pnl_status IN ('open', 'partial')
          AND bb.token_amount IS NOT NULL
          AND bb.token_amount > 0
          AND bb.buy_sol IS NOT NULL
          AND ba.block_time IS NOT NULL
     ) c
     WHERE (
       (age_ms < ${WINDOW_HOT_MS}::bigint
         AND (price_updated_at IS NULL
              OR price_updated_at < NOW() - INTERVAL '${HOT_TTL_SEC} seconds'))
       OR
       (age_ms >= ${WINDOW_HOT_MS}::bigint
        AND age_ms < ${WINDOW_WARM_MS}::bigint
         AND (price_updated_at IS NULL
              OR price_updated_at < NOW() - INTERVAL '${WARM_TTL_SEC} seconds'))
     )
     ORDER BY price_updated_at NULLS FIRST, id DESC
     LIMIT $1`,
    [LIMIT],
  );

  if (rows.length === 0) return;

  const hotCnt  = rows.filter((r) => r.age_ms < WINDOW_HOT_MS).length;
  const warmCnt = rows.filter(
    (r) => r.age_ms >= WINDOW_HOT_MS && r.age_ms < WINDOW_WARM_MS,
  ).length;
  console.log(
    `[unrealized-worker] ${rows.length} 行待刷新 (hot=${hotCnt} warm=${warmCnt})`,
  );

  let ok = 0, nullPrice = 0, failed = 0, slow = 0;
  const batch: BatchEntry[] = [];

  for (const r of rows) {
    const t0 = Date.now();
    try {
      const e = await enrichWithUnrealized({
        mint:             r.mint,
        token_amount:     r.token_amount,
        buy_sol:          r.buy_sol ?? '0',
        buy_fee_lamports: null,
        pnl_sol:          r.pnl_sol != null ? Number(r.pnl_sol) : null,
        pnl_sold_ratio:   r.pnl_sold_ratio,
        pnl_status:       r.pnl_status,
      } satisfies EnrichableBuyer);

      batch.push({
        id:         r.id,
        price:      e.current_price_sol,
        unrealized: e.unrealized_sol,
        total:      e.total_pnl_sol,
        ts:         e.current_price_sol == null ? new Date(0) : new Date(),
      });

      const dt = Date.now() - t0;
      if (dt > SLOW_MS) {
        slow++;
        console.log(
          `[unrealized-worker] slow ${r.id} ${r.mint.slice(0, 8)} ${dt}ms ` +
            `price=${e.current_price_sol ?? 'null'}`,
        );
      }

      if (e.current_price_sol == null) nullPrice++;
      else ok++;

      if (batch.length >= BATCH_FLUSH) {
        const size = batch.length;
        try {
          await flushBatch(batch.splice(0));
        } catch (flushErr: unknown) {
          failed += size;
          console.warn(
            `[unrealized-worker] 批量 flush 失败 (${size} 行): ${
              (flushErr as Error)?.message ?? flushErr
            }`,
          );
        }
      }
    } catch (err: unknown) {
      failed++;
      console.warn(
        `[unrealized-worker] buyer ${r.id} (${r.mint.slice(0, 8)}) enrich 失败: ${
          (err as Error)?.message ?? err
        }`,
      );
    }
  }

  if (batch.length > 0) {
    try {
      await flushBatch(batch);
    } catch (flushErr: unknown) {
      failed += batch.length;
      console.warn(
        `[unrealized-worker] 末尾 flush 失败 (${batch.length} 行): ${
          (flushErr as Error)?.message ?? flushErr
        }`,
      );
    }
  }

  console.log(
    `[unrealized-worker] 完成 ok=${ok} nullPrice=${nullPrice} failed=${failed} ` +
      `slow(>${SLOW_MS}ms)=${slow}`,
  );
}

let timer: NodeJS.Timeout | null = null;
let running = false;
// 防 tick 重叠：单 tick RPC 拉价格慢（500 行 × ~50ms = 25s+），可能撑过下一 30s tick 触发点。
// 上一轮还没跑完就跳过，避免双倍 Birdeye/DexScreener 请求被打到限流。
let inTick = false;

export async function startUnrealizedWorker(): Promise<void> {
  if (running) return;
  running = true;
  console.log('[unrealized-worker] starting (30s tick)');

  // 启动后立即跑第一次（让已开仓的行立即刷新），然后每 30s 轮询
  await tick();

  timer = setInterval(async () => {
    if (inTick) {
      console.warn('[unrealized-worker] 上一 tick 还没跑完,跳过这一 tick');
      return;
    }
    inTick = true;
    try {
      await tick();
    } catch (err) {
      console.error('[unrealized-worker] tick failed', err);
    } finally {
      inTick = false;
    }
  }, TICK_MS);
}

export function stopUnrealizedWorker(): void {
  running = false;
  if (timer) clearInterval(timer);
}
