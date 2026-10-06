import { query, pool } from '../src/lib/db';
(async () => {
  console.log('=== A. 迁移后新增的 target_trades（最近 30 分钟）===');
  const a = await query(`
    SELECT COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE COALESCE(target_tip_sol::numeric,0) > 0)::int AS with_tip,
           COUNT(*) FILTER (WHERE tip_source IS NOT NULL)::int AS with_source
    FROM target_trades
    WHERE created_at >= NOW() - INTERVAL '30 minutes'
  `);
  console.log(a[0]);

  console.log('\n=== B. 迁移后新增的 block_buyers（最近 30 分钟，JOIN block_analyses.block_time）===');
  const b = await query(`
    SELECT COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE COALESCE(bb.tip_sol::numeric,0) > 0)::int AS with_tip,
           COUNT(*) FILTER (WHERE bb.tip_source IS NOT NULL)::int AS with_source
    FROM block_buyers bb
    JOIN block_analyses a ON a.id = bb.block_analysis_id
    WHERE a.block_time >= NOW() - INTERVAL '30 minutes'
  `);
  console.log(b[0]);

  console.log('\n=== C. target_trades tip>0 分布 ===');
  const c = await query(`
    SELECT tip_source, COUNT(*)::int AS n
    FROM target_trades
    WHERE COALESCE(target_tip_sol::numeric,0) > 0
    GROUP BY tip_source ORDER BY n DESC
  `);
  console.log(c);

  console.log('\n=== D. block_buyers tip>0 分布 ===');
  const d = await query(`
    SELECT tip_source, COUNT(*)::int AS n
    FROM block_buyers
    WHERE COALESCE(tip_sol::numeric,0) > 0
    GROUP BY tip_source ORDER BY n DESC
  `);
  console.log(d);

  console.log('\n=== E. block_buyers schema (确认 tip_source 列) ===');
  const e = await query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_name='block_buyers' AND column_name IN ('tip_sol','tip_source')
  `);
  console.log(e);

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
