/**
 * 重跑决策层（纯 SQL，不打 Helius）
 *
 * 之前 worth_score 恒为 0.0000，现在改成算不出就写 NULL，
 * 跑这个把历史假 0 刷掉。pnl 没回填前大部分行会变 NULL，这是预期结果。
 */
import { readFileSync } from 'fs';
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

async function main() {
  const { pool } = await import('../src/lib/db');
  const { recomputeAllDecisions } = await import('../src/lib/pool-decision');

  console.log('重算中（纯 SQL）...\n');
  const r = await recomputeAllDecisions();
  console.log('结果:', r);

  // 清理旧代码留下的陈旧 0 分。
  // 旧实现对「查不到样本」也写 0，而这些行不在本次重算范围内
  // （暂停的目标、freq<8 的成员），会一直挂在页面上假装是「跟了但没赚」。
  // 用 score_updated_at 限定在本次重算之前，避免误伤未来真实算出来的 0 分。
  const cutoff = new Date(Date.now() - 60000).toISOString();
  const stale = await pool.query(
    `UPDATE pool_members SET worth_score = NULL
      WHERE worth_score = 0 AND score_updated_at < $1
      RETURNING id`,
    [cutoff],
  );
  console.log(`清理陈旧 0 分: ${stale.rowCount} 行\n`);

  const { rows } = await pool.query(`
    SELECT count(*)::int                                  AS 总成员,
      count(worth_score)                                 AS 有分,
      count(*) FILTER (WHERE worth_score IS NULL)        AS 无分_NULL,
      count(*) FILTER (WHERE worth_score = 0)            AS 零分,
      min(worth_score)                                   AS 最低,
      max(worth_score)                                   AS 最高,
      count(*) FILTER (WHERE recommended_tip_sol > 0)    AS 有推荐费
    FROM pool_members`);

  console.log('\npool_members 现状:');
  console.table(rows);

  console.log('\n按评分排序的前 10 个（有分的）:');
  const top = await pool.query(`
    SELECT address, freq, worth_score, recommended_tip_sol,
           recommended_prio_lamports, score_updated_at
      FROM pool_members
     WHERE worth_score IS NOT NULL
     ORDER BY worth_score DESC NULLS LAST LIMIT 10`);
  console.table(top.rows.length ? top.rows : [{ 说明: '没有任何地址样本足够，评分全部为 NULL（回填未做）' }]);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
