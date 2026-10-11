// scripts/_diag-ranking.ts
// 看 target_trades 的真实情况
import { query, pool } from '../src/lib/db';

async function main() {
  console.log('=== target_trades 总览 ===');
  const overview = await query<any>(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE confirmed = true)::int AS confirmed_true,
      COUNT(*) FILTER (WHERE confirmed = false)::int AS confirmed_false,
      COUNT(*) FILTER (WHERE confirmed IS NULL)::int AS confirmed_null,
      COUNT(*) FILTER (WHERE block_time >= now() - interval '7 days')::int  AS last7d,
      COUNT(*) FILTER (WHERE block_time >= now() - interval '30 days')::int AS last30d,
      COUNT(*) FILTER (WHERE block_time >= now() - interval '90 days')::int AS last90d,
      COUNT(*) FILTER (WHERE confirmed = true AND block_time >= now() - interval '30 days')::int AS confirmed_30d,
      COUNT(*) FILTER (WHERE confirmed = true AND block_time >= now() - interval '7 days')::int  AS confirmed_7d,
      MAX(block_time) AS latest,
      MIN(block_time) AS earliest,
      COUNT(DISTINCT target_address)::int AS distinct_targets
    FROM target_trades
  `);
  console.table(overview);

  console.log('\n=== /api/ranking 默认窗口（最近 30 天，confirmed=true）的预期行数 ===');
  const r = await query<any>(`
    SELECT COUNT(DISTINCT target_address)::int AS rows_30d
    FROM target_trades
    WHERE confirmed = true AND block_time >= now() - interval '30 days'
  `);
  console.log(r[0]);

  console.log('\n=== 不同时间窗口下 confirmed=true 的目标数（方便切换 select 看效果）===');
  const win = await query<any>(`
    SELECT
      SUM(CASE WHEN block_time >= now() - interval '7 days'  THEN 1 ELSE 0 END)::int AS win_7,
      SUM(CASE WHEN block_time >= now() - interval '30 days' THEN 1 ELSE 0 END)::int AS win_30,
      SUM(CASE WHEN block_time >= now() - interval '90 days' THEN 1 ELSE 0 END)::int AS win_90
    FROM target_trades
    WHERE confirmed = true
  `);
  console.table(win);

  console.log('\n=== 最近的 5 笔（不区分 confirmed）===');
  const recent = await query<any>(`
    SELECT slot, block_time, confirmed, target_address, buy_sol, pnl_sol
    FROM target_trades
    ORDER BY block_time DESC NULLS LAST
    LIMIT 5
  `);
  console.table(recent);

  console.log('\n=== confirmed 状态对应行数 ===');
  const cn = await query<any>(`
    SELECT confirmed, COUNT(*)::int AS n
    FROM target_trades
    GROUP BY confirmed
    ORDER BY n DESC
  `);
  console.table(cn);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });