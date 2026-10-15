/**
 * 定时刷新 block_buyers 的「未实现 PnL（浮盈）」。
 *
 * 三档分级轮询（利用大多数跟单 1 分钟内清仓的特性）：
 *   hot  (0~1 min)：   TTL 15s  — 绝大多数跟单在此窗口内平仓，急需刷新
 *   warm (1~10 min)：  TTL 60s  — 仍在窗口内但没那么急了
 *   cold (>10 min)：   默认跳过 — 已超出 FIFO 持仓窗口（pnl.ts 逻辑），基本是已弃坑
 *
 * 批量 UPDATE：每凑够 BATCH_FLUSH=50 行一次性写盘，单次 DB roundtrip 完成。
 *
 * 用法：
 *   npx tsx scripts/refresh-unrealized.ts                       # 默认：hot + warm，不扫 cold
 *   npx tsx scripts/refresh-unrealized.ts --include-cold          # 包含 cold（用于历史补扫）
 *   npx tsx scripts/refresh-unrealized.ts --limit=200 --include-cold
 *   watch -n 30 'npx tsx scripts/refresh-unrealized.ts'         # 每 30s 扫一轮
 */

import { readFileSync } from 'fs';
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

import { query, execute } from '../src/lib/db';
import { enrichWithUnrealized, type EnrichableBuyer } from '../src/lib/pnl';

// ─── 分档配置 ────────────────────────────────────────────────────────────────
const HOT_TTL_SEC  = 15;   // 0~1 min：超过 15s 没刷就重新拉价
const WARM_TTL_SEC = 60;   // 1~10 min：超过 60s 没刷就重新拉价
const COLD_TTL_SEC = 5 * 60; // >10 min：超过 5min 没刷才拉（仅 --include-cold）

const WINDOW_HOT_MS  = 60 * 1000;          // 1 min
const WINDOW_WARM_MS = 10 * 60 * 1000;     // 10 min

const BATCH_FLUSH = 50;   // 每攒 50 行写盘一次

const SLOW_MS = 4000;     // 超过 4s 视为 slow，单独 log

// ─── 类型 ───────────────────────────────────────────────────────────────────
interface RefreshRow {
  id: number;
  mint: string;
  token_amount: string | null;
  buy_sol: string;
  pnl_sol: string | null;
  pnl_sold_ratio: string | null;
  pnl_status: string | null;
  age_ms: number; // 毫秒，block_time 距今多久
}

interface BatchEntry {
  id: number;
  price: number | null;
  unrealized: number | null;
  total: number | null;
  ts: Date;
}

// ─── 批量写盘 ──────────────────────────────────────────────────────────────
async function flushBatch(batch: BatchEntry[]): Promise<void> {
  if (batch.length === 0) return;

  // 用 unnest() 把每列拍平，避免手动拼 VALUES 列表
  const ids        = batch.map(b => b.id);
  const prices     = batch.map(b => b.price);
  const unrealized = batch.map(b => b.unrealized);
  const totals     = batch.map(b => b.total);
  const tss        = batch.map(b => b.ts);

  const sql = `
    UPDATE block_buyers
       SET current_price_sol = u.price,
           unrealized_sol    = u.unrealized,
           total_pnl_sol     = u.total,
           price_updated_at  = u.ts
      FROM unnest(
             $1::int[],
             $2::numeric[],
             $3::numeric[],
             $4::numeric[],
             $5::timestamptz[]
           ) AS u(id, price, unrealized, total, ts)
     WHERE block_buyers.id = u.id`;

  const updated = await execute(sql, [ids, prices, unrealized, totals, tss]);
  console.log(`[refresh-unrealized] flush ${updated}/${batch.length} 行写入成功`);
}

// ─── 主逻辑 ────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const limitArg    = args.find(a => a.startsWith('--limit='));
  const includeCold  = args.includes('--include-cold');
  const limit        = limitArg ? parseInt(limitArg.split('=')[1], 10) : 500;

  console.log(
    `[refresh-unrealized] starting ` +
    `(limit=${limit}, tier=hot:${HOT_TTL_SEC}s/warm:${WARM_TTL_SEC}s/cold:${COLD_TTL_SEC}s, ` +
    `cold=${includeCold ? 'on' : 'OFF(>10min跳过)'}, ts=${new Date().toISOString()})`,
  );

  // 三档过滤：按 age 决定 TTL，超出窗口的行默认不扫
  // 关键索引路径：block_buyers(pnl_status) + block_analyses(block_time DESC)
  // age_ms 在子查询里只算一次，避免 WHERE 里重复 6 次 EXTRACT(...)
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
       -- hot：0~1 min  age，TTL 15s
       (age_ms < ${WINDOW_HOT_MS}::bigint
         AND (price_updated_at IS NULL
              OR price_updated_at < NOW() - INTERVAL '${HOT_TTL_SEC} seconds'))
       OR
       -- warm：1~10 min age，TTL 60s
       (age_ms >= ${WINDOW_HOT_MS}::bigint
        AND age_ms < ${WINDOW_WARM_MS}::bigint
         AND (price_updated_at IS NULL
              OR price_updated_at < NOW() - INTERVAL '${WARM_TTL_SEC} seconds'))
       ${includeCold ? `OR
       -- cold：>10 min age，仅 --include-cold 时扫描，TTL 5min
       (age_ms >= ${WINDOW_WARM_MS}::bigint
         AND (price_updated_at IS NULL
              OR price_updated_at < NOW() - INTERVAL '${COLD_TTL_SEC} seconds'))` : ''}
     )
     ORDER BY price_updated_at NULLS FIRST, id DESC
     LIMIT $1`,
    [limit],
  );

  const hotCnt  = rows.filter(r => r.age_ms <  WINDOW_HOT_MS).length;
  const warmCnt = rows.filter(r => r.age_ms >= WINDOW_HOT_MS && r.age_ms < WINDOW_WARM_MS).length;
  const coldCnt = rows.filter(r => r.age_ms >= WINDOW_WARM_MS).length;

  console.log(
    `[refresh-unrealized] ${rows.length} 行待刷新 ` +
    `(hot=${hotCnt} warm=${warmCnt} cold=${coldCnt})`,
  );

  let ok = 0, nullPrice = 0, failed = 0, slow = 0;
  const batch: BatchEntry[] = [];

  for (const r of rows) {
    const t0 = Date.now();
    try {
      const e = await enrichWithUnrealized({
        mint:               r.mint,
        token_amount:       r.token_amount,
        buy_sol:            r.buy_sol,
        buy_fee_lamports:   null, // 历史 buy_fee 没存表，保守默认 5000
        pnl_sol:            r.pnl_sol != null ? Number(r.pnl_sol) : null,
        pnl_sold_ratio:     r.pnl_sold_ratio,
        pnl_status:          r.pnl_status,
      } satisfies EnrichableBuyer);

      batch.push({
        id:         r.id,
        price:      e.current_price_sol,
        unrealized: e.unrealized_sol,
        total:      e.total_pnl_sol,
        // 价格拉不到 → 写 1970 让下次轮询立即命中重试（不要等 60s TTL）
        // 与单行 writeUnrealizedToBlockBuyer 的失败策略保持一致。
        ts:         e.current_price_sol == null ? new Date(0) : new Date(),
      });

      const dt = Date.now() - t0;
      if (dt > SLOW_MS) {
        slow++;
        console.log(
          `[refresh-unrealized] slow ${r.id} ${r.mint.slice(0, 8)} ${dt}ms ` +
          `price=${e.current_price_sol ?? 'null'}`,
        );
      }

      if (e.current_price_sol == null) nullPrice++;
      else ok++;

      // 凑满 BATCH_FLUSH 行，一次性写盘
      if (batch.length >= BATCH_FLUSH) {
        // splice 会把 batch 清空，先进 catch 之前先抓住 size
        const size = batch.length;
        try {
          await flushBatch(batch.splice(0));
        } catch (flushErr: any) {
          failed += size;
          console.warn(
            `[refresh-unrealized] 批量 flush 失败 (${size} 行): ${flushErr.message}`,
          );
        }
      }
    } catch (err: any) {
      failed++;
      console.warn(
        `[refresh-unrealized] buyer ${r.id} (${r.mint.slice(0, 8)}) enrich 失败: ${err.message}`,
      );
    }
  }

  // 剩余不足 BATCH_FLUSH 的尾巴
  if (batch.length > 0) {
    try {
      await flushBatch(batch);
    } catch (flushErr: any) {
      failed += batch.length;
      console.warn(`[refresh-unrealized] 末尾 flush 失败 (${batch.length} 行): ${flushErr.message}`);
    }
  }

  console.log(
    `[refresh-unrealized] 完成 ok=${ok} nullPrice=${nullPrice} failed=${failed} ` +
    `slow(>${SLOW_MS}ms)=${slow} duration=${Date.now() - start}ms`,
  );
}

const start = Date.now();
main()
  .catch(e => {
    console.error('[refresh-unrealized] 顶层错误:', e);
    process.exit(1);
  })
  .then(() => process.exit(0));
