/**
 * scripts/backfill-sniper-ms.ts
 *
 * 一次性回填：把 first-sniper.ts 已经算好的 block_buyers.offset_ms 回写到
 * target_trades.first_sniper_offset_ms。
 *
 * 适用场景：
 *   - 已部署过 0007_first_sniper_offset_ms.sql
 *   - 历史 target_trades 已有 first_sniper_signature（target 上发生过 analyzeBlock）
 *   - 想给历史数据补上「抢到 +Nms」展示
 *
 * 用法：
 *   npx tsx --env-file=.env scripts/backfill-sniper-ms.ts
 *
 *   # 只回填最近 N 天的数据（默认全部）
 *   DAYS=7 npx tsx --env-file=.env scripts/backfill-sniper-ms.ts
 *
 * 原理：
 *   block_buyers 表里 is_first_sniper = true 的那行就是「首狙」，
 *   它的 offset_ms 字段就是首狙相对目标 tx 的 ms 偏移。
 *   target_trades.first_sniper_signature = block_buyers.signature 是已建好的关系。
 *
 *   UPDATE 用 EXISTS 子查询关联，避免 JOIN 时多行爆炸。
 */

import { query, execute, pool } from '../src/lib/db';

const DAYS = parseInt(process.env.DAYS ?? '0', 10);

async function main() {
  console.log('[backfill-sniper-ms] starting');
  console.log(`[backfill-sniper-ms] days filter = ${DAYS > 0 ? DAYS : 'ALL'}`);

  // 1) 看下当前状态
  const before = await query<{ total: string; filled: string; missing: string }>(`
    SELECT
      COUNT(*)::text AS total,
      COUNT(first_sniper_offset_ms)::text AS filled,
      COUNT(*) FILTER (WHERE first_sniper_signature IS NOT NULL AND first_sniper_offset_ms IS NULL)::text AS missing
    FROM target_trades
    ${DAYS > 0 ? `WHERE block_time >= NOW() - INTERVAL '${DAYS} days'` : ''}
  `);
  console.log('[backfill-sniper-ms] before:', before[0]);

  // 2) 回填：用 EXISTS 把 target_trades 和 block_buyers 关联起来
  //    block_buyers.is_first_sniper = true 的那行就是首狙行
  const sql = `
    UPDATE target_trades t
       SET first_sniper_offset_ms = bb.offset_ms
      FROM block_buyers bb
     WHERE bb.signature = t.first_sniper_signature
       AND bb.is_first_sniper = TRUE
       AND t.first_sniper_signature IS NOT NULL
       AND (t.first_sniper_offset_ms IS NULL
            OR t.first_sniper_offset_ms != bb.offset_ms)
       ${DAYS > 0 ? `AND t.block_time >= NOW() - INTERVAL '${DAYS} days'` : ''}
  `;
  const t0 = Date.now();
  const rowCount = await execute(sql);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`[backfill-sniper-ms] updated ${rowCount} rows in ${elapsed}s`);

  // 3) 验证
  const after = await query<{ total: string; filled: string; missing: string }>(`
    SELECT
      COUNT(*)::text AS total,
      COUNT(first_sniper_offset_ms)::text AS filled,
      COUNT(*) FILTER (WHERE first_sniper_signature IS NOT NULL AND first_sniper_offset_ms IS NULL)::text AS missing
    FROM target_trades
    ${DAYS > 0 ? `WHERE block_time >= NOW() - INTERVAL '${DAYS} days'` : ''}
  `);
  console.log('[backfill-sniper-ms] after:', after[0]);
}

main()
  .catch((e) => {
    console.error('[backfill-sniper-ms] fatal:', e);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });