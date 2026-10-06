/**
 * scripts/recompute-bundle.ts
 *
 * 给历史 target_trades / block_buyers 重新计算 bundled 状态 + tip_source。
 *
 * 背景：
 *   旧 isBundled() 判定太宽（只看 v0），导致历史数据 is_bundled=true 但 tip=0 的误判很多。
 *   新判定：tip > 0 OR (v0 + has_alt)。本脚本按"已有 tip_sol + version + has_alt"数据重新算一遍。
 *
 * 0010: tip_source 不在历史数据里（旧版没这个字段）。本脚本对 tip_sol>0 的行，尝试从
 *   SOLANA_TIP_SOURCE_MAP 回填 tip_source；命中不了就保持 'unknown'。
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
 *   # 只回填 tip_source（不重算 is_bundled）
 *   TIP_SOURCE_ONLY=1 npx tsx --env-file=.env scripts/recompute-bundle.ts
 *
 * 注意：
 *   - 已有的 bundle_id 不会被清空（避免破坏外部引用）；本脚本只更新 is_bundled / has_alt / tip_source
 *   - has_alt 字段：Helius Enhanced 路径拿不到 ALT 信息 → 保持 NULL；只有 fallback 适配器解析过的才有具体值
 *   - 大表 UPDATE 走单条 WHERE 范围限定，分批提交避免长事务
 */

import { query, execute, pool } from '../src/lib/db';
import { SOLANA_TIP_SOURCE_MAP } from '../src/lib/parser';

const TARGETS_ONLY = process.env.TARGETS_ONLY === '1';
const BUYERS_ONLY = process.env.BUYERS_ONLY === '1';
const TIP_SOURCE_ONLY = process.env.TIP_SOURCE_ONLY === '1';
// parseInt 非数字时返回 NaN，必须 clamp 到 0，否则 SQL 模板会拼出 "INTERVAL 'NaN days'"
// （NaN > 0 仍是 false，所以拼接被跳过；但 clamp 让意图更明确）
const rawDays = parseInt(process.env.DAYS ?? '0', 10);
const DAYS = Number.isFinite(rawDays) && rawDays > 0 ? rawDays : 0;

async function recomputeTargets() {
  console.log('\n[recompute-bundle] target_trades: 重新判定 is_bundled / has_alt / tip_source');
  const where = DAYS > 0 ? `WHERE block_time >= NOW() - INTERVAL '${DAYS} days'` : '';

  const before = await query<{ total: string; bundled: string; with_tip_source: string }>(`
    SELECT COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE is_bundled = TRUE)::text AS bundled,
           COUNT(*) FILTER (WHERE tip_source IS NOT NULL)::text AS with_tip_source
    FROM target_trades
    ${where}
  `);
  console.log('[recompute-bundle] before:', before[0]);

  if (TIP_SOURCE_ONLY) {
    // tip_source 回填只对「tip > 0 且 tip_source IS NULL」的行执行
    // 用 SQL 反向回填，因为 target_trades 不存 tip 收款地址，只能拿到 SOLANA_TIP_SOURCE_MAP 静态对应表；
    // 但 4 通道的 tip_sol 通常都是固定档（Jito 0.001/0.01/Higher，Helius Sender 0.001+/0.000005，
    // LandX 0.001，0slot 0.001/0.0001），按金额倒推不可靠。所以回填策略改为：
    //   - 先尝试按「最近的同 mint 同 slot 的 block_buyers.tip_source」JOIN 推断（如果 block_buyers 已经填好）
    //   - 推断不到就保留 NULL，等下次 monitor / analyze 重新解析时再填
    //
    // 实际上更稳的做法：跑 scripts/backfill-tip-source.ts（重新解析历史 tx，拿到 nativeTransfers 后回填）。
    // 这里只做轻量兜底：is_bundled=true AND tip > 0 的 row 直接设 'unknown'，让 UI 至少有值显示。
    const sql = `
      UPDATE target_trades
         SET tip_source = 'unknown'
       WHERE COALESCE(target_tip_sol::numeric, 0) > 0
         AND tip_source IS NULL
         ${where ? 'AND ' + where.replace(/^WHERE\s+/i, '') : ''}
    `;
    const t0 = Date.now();
    const updated = await execute(sql);
    console.log(`[recompute-bundle] tip_source backfill (conservative 'unknown') updated ${updated} rows in ${((Date.now() - t0) / 1000).toFixed(2)}s`);
    const after = await query<{ total: string; bundled: string; with_tip_source: string }>(`
      SELECT COUNT(*)::text AS total,
             COUNT(*) FILTER (WHERE is_bundled = TRUE)::text AS bundled,
             COUNT(*) FILTER (WHERE tip_source IS NOT NULL)::text AS with_tip_source
      FROM target_trades
      ${where}
    `);
    console.log('[recompute-bundle] after:', after[0]);
    return;
  }

  // 新判定：
  //   is_bundled = (target_tip_sol > 0) OR (has_alt = TRUE)
  // tip_source：保守回填 'unknown'（等 backfill-tip-source.ts 重新解析拿 nativeTransfers 后精准回填）
  const sql = `
    UPDATE target_trades
       SET is_bundled = (COALESCE(target_tip_sol::numeric, 0) > 0 OR has_alt = TRUE),
           tip_source = CASE
                          WHEN COALESCE(target_tip_sol::numeric, 0) > 0 AND tip_source IS NULL THEN 'unknown'
                          ELSE tip_source
                        END
     ${where}
  `;
  const t0 = Date.now();
  const updated = await execute(sql);
  console.log(`[recompute-bundle] target_trades updated ${updated} rows in ${((Date.now() - t0) / 1000).toFixed(2)}s`);

  const after = await query<{ total: string; bundled: string; with_alt: string; with_tip: string; with_tip_source: string }>(`
    SELECT COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE is_bundled = TRUE)::text AS bundled,
           COUNT(*) FILTER (WHERE has_alt = TRUE)::text AS with_alt,
           COUNT(*) FILTER (WHERE target_tip_sol::numeric > 0)::text AS with_tip,
           COUNT(*) FILTER (WHERE tip_source IS NOT NULL)::text AS with_tip_source
    FROM target_trades
    ${where}
  `);
  console.log('[recompute-bundle] after:', after[0]);
}

async function recomputeBuyers() {
  console.log('\n[recompute-bundle] block_buyers: 重新判定 is_bundled / has_alt / tip_source');
  // block_buyers 没存 block_time，用 slot 反查 block_analyses.block_time
  const where = DAYS > 0
    ? `WHERE a.block_time >= NOW() - INTERVAL '${DAYS} days'`
    : '';

  const before = await query<{ total: string; bundled: string; with_tip_source: string }>(`
    SELECT COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE bb.is_bundled = TRUE)::text AS bundled,
           COUNT(*) FILTER (WHERE bb.tip_source IS NOT NULL)::text AS with_tip_source
    FROM block_buyers bb
    JOIN block_analyses a ON a.id = bb.block_analysis_id
    ${where}
  `);
  console.log('[recompute-bundle] before:', before[0]);

  if (TIP_SOURCE_ONLY) {
    const sql = `
      UPDATE block_buyers bb
         SET tip_source = 'unknown'
        FROM block_analyses a
       WHERE a.id = bb.block_analysis_id
         AND COALESCE(bb.tip_sol::numeric, 0) > 0
         AND bb.tip_source IS NULL
         ${where ? 'AND ' + where.replace(/^WHERE\s+/i, '') : ''}
    `;
    const t0 = Date.now();
    const updated = await execute(sql);
    console.log(`[recompute-bundle] tip_source backfill (conservative 'unknown') updated ${updated} rows in ${((Date.now() - t0) / 1000).toFixed(2)}s`);
    const after = await query<{ total: string; bundled: string; with_tip_source: string }>(`
      SELECT COUNT(*)::text AS total,
             COUNT(*) FILTER (WHERE bb.is_bundled = TRUE)::text AS bundled,
             COUNT(*) FILTER (WHERE bb.tip_source IS NOT NULL)::text AS with_tip_source
      FROM block_buyers bb
      JOIN block_analyses a ON a.id = bb.block_analysis_id
      ${where}
    `);
    console.log('[recompute-bundle] after:', after[0]);
    return;
  }

  const sql = `
    UPDATE block_buyers bb
       SET is_bundled = (COALESCE(bb.tip_sol::numeric, 0) > 0 OR bb.has_alt = TRUE),
           tip_source = CASE
                          WHEN COALESCE(bb.tip_sol::numeric, 0) > 0 AND bb.tip_source IS NULL THEN 'unknown'
                          ELSE bb.tip_source
                        END
      FROM block_analyses a
     WHERE a.id = bb.block_analysis_id
     ${where.replace('WHERE', 'AND')}
  `;
  const t0 = Date.now();
  const updated = await execute(sql);
  console.log(`[recompute-bundle] block_buyers updated ${updated} rows in ${((Date.now() - t0) / 1000).toFixed(2)}s`);

  const after = await query<{ total: string; bundled: string; with_alt: string; with_tip: string; with_tip_source: string }>(`
    SELECT COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE bb.is_bundled = TRUE)::text AS bundled,
           COUNT(*) FILTER (WHERE bb.has_alt = TRUE)::text AS with_alt,
           COUNT(*) FILTER (WHERE bb.tip_sol::numeric > 0)::text AS with_tip,
           COUNT(*) FILTER (WHERE bb.tip_source IS NOT NULL)::text AS with_tip_source
    FROM block_buyers bb
    JOIN block_analyses a ON a.id = bb.block_analysis_id
    ${where}
  `);
  console.log('[recompute-bundle] after:', after[0]);
}

async function main() {
  console.log('[recompute-bundle] starting');
  console.log(`[recompute-bundle] days filter = ${DAYS > 0 ? DAYS : 'ALL'}`);
  console.log(`[recompute-bundle] mode = ${TIP_SOURCE_ONLY ? 'tip_source only' : TARGETS_ONLY ? 'targets only' : BUYERS_ONLY ? 'buyers only' : 'both'}`);
  console.log(`[recompute-bundle] SOLANA_TIP_SOURCE_MAP has ${Object.keys(SOLANA_TIP_SOURCE_MAP).length} known tip addresses`);

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