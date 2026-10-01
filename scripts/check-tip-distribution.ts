// scripts/check-tip-distribution.ts
// 看 first_sniper_tip_sol 的分布，搞清楚到底是 bug 还是 sniper 本来就没付 tip
import { query, pool } from '../src/lib/db';

async function main() {
  console.log('=== target_trades.first_sniper_tip_sol 分布 ===');
  const dist = await query<any>(`
    SELECT
      CASE
        WHEN first_sniper_tip_sol IS NULL THEN 'NULL'
        WHEN first_sniper_tip_sol::numeric = 0 THEN '= 0'
        WHEN first_sniper_tip_sol::numeric > 0 AND first_sniper_tip_sol::numeric < 0.0001 THEN '< 0.0001'
        WHEN first_sniper_tip_sol::numeric < 0.001 THEN '< 0.001'
        WHEN first_sniper_tip_sol::numeric < 0.01 THEN '< 0.01'
        ELSE '>= 0.01'
      END AS bucket,
      count(*) AS n,
      round(avg(first_sniper_tip_sol::numeric), 6) AS avg_tip
    FROM target_trades
    WHERE first_sniper IS NOT NULL
    GROUP BY 1
    ORDER BY 1
  `);
  console.table(dist);

  console.log('\n=== 最近 20 笔 first_sniper，按时间倒序 ===');
  const rows = await query<any>(`
    SELECT
      slot,
      is_bundled,
      substring(first_sniper::text, 1, 8) AS sniper,
      COALESCE(first_sniper_tip_sol::text, '-')     AS s_tip,
      COALESCE(first_sniper_prio_lamports::text, '-') AS s_prio,
      COALESCE(first_sniper_buy_sol::text, '-')     AS s_buy
    FROM target_trades
    WHERE first_sniper IS NOT NULL
    ORDER BY block_time DESC
    LIMIT 20
  `);
  console.table(rows);

  console.log('\n=== 同样窗口的 block_buyers（is_first_sniper=true）===');
  const bb = await query<any>(`
    SELECT
      a.slot,
      bb.is_bundled,
      substring(bb.address, 1, 8) AS sniper,
      COALESCE(bb.tip_sol::text, '-')     AS b_tip,
      COALESCE(bb.prio_lamports::text, '-') AS b_prio,
      COALESCE(bb.buy_sol::text, '-')     AS b_buy,
      bb.result,
      bb.version
    FROM block_buyers bb
    JOIN block_analyses a ON a.id = bb.block_analysis_id
    WHERE bb.is_first_sniper = true
    ORDER BY a.id DESC
    LIMIT 20
  `);
  console.table(bb);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
