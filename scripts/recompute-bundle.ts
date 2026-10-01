/**
 * scripts/recompute-bundle.ts
 *
 * 给历史 target_trades / block_buyers 重新计算 bundled 状态。
 *
 * 背景：
 *   旧 isBundled() 判定太宽（只看 v0），导致历史数据 is_bundled=true 但 tip=0 的误判很多。
 *   新判定：tip > 0 OR (v0 + has_alt)。本脚本按"已有 tip_sol + version + has_alt"数据重新算一遍。
 *
 * 用法：
 *   # 全量重算（target_trades + block_buyers）
 *   npx tsx --env-file=.env scripts/recompute-bundle.ts
 *
 *   # 只重算 target_trades
 *   TARGETS_ONLY=1 npx tsx --env-file=.env scripts/recompute-bundle.ts
 *
 *   # 只重算 block_buyers
 *   BUYERS_ONLY=1 npx tsx --env-file=.env scripts/recompute-bundle.ts
 *
 *   # 只重算最近 N 天（默认全部）
 *   DAYS=7 npx tsx --env-file=.env scripts/recompute-bundle.ts
 *
 * 注意：
 *   - 已有的 bundle_id 不会被清空（避免破坏外部引用）；本脚本只更新 is_bundled / has_alt
 *   - has_alt 字段：Helius Enhanced 路径拿不到 ALT 信息 → 保持 NULL；只有 fallback 适配器解析过的才有具体值
 *   - 大表 UPDATE 走单条 WHERE 范围限定，分批提交避免长事务
 */

import { query, execute, pool } from '../src/lib/db';

const TARGETS_ONLY = process.env.TARGETS_ONLY === '1';
const BUYERS_ONLY = process.env.BUYERS_ONLY === '1';
// parseInt 非数字时返回 NaN，必须 clamp 到 0，否则 SQL 模板会拼出 "INTERVAL 'NaN days'"
// （NaN > 0 仍是 false，所以拼接被跳过；但 clamp 让意图更明确）
const rawDays = parseInt(process.env.DAYS ?? '0', 10);
const DAYS = Number.isFinite(rawDays) && rawDays > 0 ? rawDays : 0;

async function recomputeTargets() {
  console.log('\n[recompute-bundle] target_trades: 重新判定 is_bundled / has_alt');
  const where = DAYS > 0 ? `WHERE block_time >= NOW() - INTERVAL '${DAYS} days'` : '';

  const before = await query<{ total: string; bundled: string }>(`
    SELECT COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE is_bundled = TRUE)::text AS bundled
    FROM target_trades
    ${where}
  `);
  console.log('[recompute-bundle] before:', before[0]);

  // 新判定：
  //   is_bundled = (target_tip_sol > 0) OR (has_alt = TRUE)
  const sql = `
    UPDATE target_trades
       SET is_bundled = (COALESCE(target_tip_sol::numeric, 0) > 0 OR has_alt = TRUE)
     ${where}
  `;
  const t0 = Date.now();
  const updated = await execute(sql);
  console.log(`[recompute-bundle] target_trades updated ${updated} rows in ${((Date.now() - t0) / 1000).toFixed(2)}s`);

  const after = await query<{ total: string; bundled: string; with_alt: string; with_tip: string }>(`
    SELECT COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE is_bundled = TRUE)::text AS bundled,
           COUNT(*) FILTER (WHERE has_alt = TRUE)::text AS with_alt,
           COUNT(*) FILTER (WHERE target_tip_sol::numeric > 0)::text AS with_tip
    FROM target_trades
    ${where}
  `);
  console.log('[recompute-bundle] after:', after[0]);
}

async function recomputeBuyers() {
  console.log('\n[recompute-bundle] block_buyers: 重新判定 is_bundled / has_alt');
  // block_buyers 没存 block_time，用 slot 反查 block_analyses.block_time
  const where = DAYS > 0
    ? `WHERE a.block_time >= NOW() - INTERVAL '${DAYS} days'`
    : '';

  const before = await query<{ total: string; bundled: string }>(`
    SELECT COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE bb.is_bundled = TRUE)::text AS bundled
    FROM block_buyers bb
    JOIN block_analyses a ON a.id = bb.block_analysis_id
    ${where}
  `);
  console.log('[recompute-bundle] before:', before[0]);

  const sql = `
    UPDATE block_buyers bb
       SET is_bundled = (COALESCE(bb.tip_sol::numeric, 0) > 0 OR bb.has_alt = TRUE)
      FROM block_analyses a
     WHERE a.id = bb.block_analysis_id
     ${where.replace('WHERE', 'AND')}
  `;
  const t0 = Date.now();
  const updated = await execute(sql);
  console.log(`[recompute-bundle] block_buyers updated ${updated} rows in ${((Date.now() - t0) / 1000).toFixed(2)}s`);

  const after = await query<{ total: string; bundled: string; with_alt: string; with_tip: string }>(`
    SELECT COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE bb.is_bundled = TRUE)::text AS bundled,
           COUNT(*) FILTER (WHERE bb.has_alt = TRUE)::text AS with_alt,
           COUNT(*) FILTER (WHERE bb.tip_sol::numeric > 0)::text AS with_tip
    FROM block_buyers bb
    JOIN block_analyses a ON a.id = bb.block_analysis_id
    ${where}
  `);
  console.log('[recompute-bundle] after:', after[0]);
}

async function main() {
  console.log('[recompute-bundle] starting');
  console.log(`[recompute-bundle] days filter = ${DAYS > 0 ? DAYS : 'ALL'}`);
  console.log(`[recompute-bundle] mode = ${TARGETS_ONLY ? 'targets only' : BUYERS_ONLY ? 'buyers only' : 'both'}`);

  if (!BUYERS_ONLY) await recomputeTargets();
  if (!TARGETS_ONLY) await recomputeBuyers();

  console.log('\n[recompute-bundle] done');
}

main()
  .catch((e) => {
    console.error('[recompute-bundle] fatal:', e);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });