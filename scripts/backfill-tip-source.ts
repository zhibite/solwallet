/**
 * scripts/backfill-tip-source.ts
 *
 * 历史 target_trades / block_buyers 的 tip_source 回填。
 *
 * 用法：
 *   # 默认：target_trades 全量回填（也回填 block_buyers）
 *   npx tsx --env-file=.env scripts/backfill-tip-source.ts
 *
 *   # 只回填 target_trades
 *   TARGETS_ONLY=1 npx tsx --env-file=.env scripts/backfill-tip-source.ts
 *
 *   # 只回填 block_buyers
 *   BUYERS_ONLY=1 npx tsx --env-file=.env scripts/backfill-tip-source.ts
 *
 *   # 只回填最近 N 天（默认全部）
 *   DAYS=7 npx tsx --env-file=.env scripts/backfill-tip-source.ts
 *
 *   # 限制单批处理行数（默认 500）
 *   BATCH=200 npx tsx --env-file=.env scripts/backfill-tip-source.ts
 *
 * 工作原理：
 *   - 对 target_trades / block_buyers 中「tip > 0 且 tip_source 为 NULL/未知」的行
 *   - 通过 signature 拉真实交易 → 走 solanaTxToHeliusEnhanced 适配
 *   - 找 nativeTransfers 里 toUserAccount 命中 SOLANA_TIP_ACCOUNTS 的项 → getTipSource 拿到精确渠道
 *   - UPDATE 落库（命中未知地址就写 'unknown'，不再静默）
 *
 * 注意：
 *   - 拉交易消耗 RPC 配额；先小批（DAYS=1 + BATCH=50）跑一遍验证
 *   - 历史数据中 tx 可能已不可拉（节点历史 shortlist）；失败自动跳过
 */

import { query, execute, pool } from '../src/lib/db';
import { getMultiRpc } from '../src/lib/multi-rpc';
import { getHelius } from '../src/lib/helius';
import {
  solanaTxToHeliusEnhanced,
  SOLANA_TIP_ACCOUNTS,
  SOLANA_TIP_SOURCE_MAP,
  getTipSource,
} from '../src/lib/parser';
import type { HeliusEnhancedTx, TipSource } from '../src/lib/types';

const TARGETS_ONLY = process.env.TARGETS_ONLY === '1';
const BUYERS_ONLY = process.env.BUYERS_ONLY === '1';
const rawDays = parseInt(process.env.DAYS ?? '0', 10);
const DAYS = Number.isFinite(rawDays) && rawDays > 0 ? rawDays : 0;
const BATCH = parseInt(process.env.BATCH ?? '500', 10);

// Parsed Events 单批上限；>100 容易触发响应体过大 / Helius 限流
// 实际成本：10 credits / 请求，所以 100 vs 500 一样的钱，只是控制 HTTP body 大小
const PARSE_BATCH = 100;

const rpc = getMultiRpc();
const helius = getHelius();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 从 nativeTransfers 推 tip 渠道；返回 null 表示未付 tip / 数据不足。
 * 没命中 4 通道中任意一个时返回 'unknown'（让 UI 知道有值但未识别）。
 */
function detectTipSource(nativeTransfers: Array<{ toUserAccount: string }> | undefined): TipSource | null {
  if (!nativeTransfers || nativeTransfers.length === 0) return null;
  // 取首个命中 — 同一笔 tx 同时付多通道的极少见（fan-out by Helius Sender 后端），记录首个即可
  for (const nt of nativeTransfers) {
    if (SOLANA_TIP_ACCOUNTS.has(nt.toUserAccount)) {
      return getTipSource(nt.toUserAccount) ?? 'unknown';
    }
  }
  return null;
}

/**
 * 对一组 signature 拉真实交易，再过 SOLANA_TIP_ACCOUNTS 找 tip 收款渠道。
 * 返回 Map<signature, TipSource | null>，sigs 中拉不到的项不会被放进 map（调用方按 undefined 处理）。
 *
 * 路径：
 *   1) 主路径：Helius Parsed Events 批量解析（10 cr / 请求，与签名数无关）
 *      一批 100 sig → 1 次 HTTP → 50 倍成本节省 + 零并发风险
 *   2) 兜底：原 multi-rpc `getTransaction` 单笔回填（仅针对主路径漏的 sig）
 *
 * Helius 在账单价上远比 multi-rpc 那几个免费档便宜；multi-rpc 仅在历史归档 /
 * Helius 抛 5xx 的边角场景兜底，所以保留作为单签 fallback。
 */
async function resolveTipSourcesBySig(sigs: string[]): Promise<Map<string, TipSource | null>> {
  const out = new Map<string, TipSource | null>();
  if (sigs.length === 0) return out;

  // 1) Helius Parsed Events 主路径
  const enhancedList: HeliusEnhancedTx[] = [];
  for (let i = 0; i < sigs.length; i += PARSE_BATCH) {
    const batch = sigs.slice(i, i + PARSE_BATCH);
    let parsed: HeliusEnhancedTx[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        parsed = await helius.parseEventsAsEnhanced(batch);
        break;
      } catch (e: any) {
        const status = e?.response?.status ?? e?.status;
        const retriable = status === 429 || (status >= 500 && status < 600) || !status;
        if (attempt < 2 && retriable) {
          console.warn(`[backfill-tip-source] Parsed Events 失败，${attempt + 1}/3 重试: ${e?.message ?? e}`);
          await sleep(800 * (attempt + 1));
          continue;
        }
        // 3 次都炸：这一段走 fallback
        console.warn(`[backfill-tip-source] Parsed Events 放弃 batch ${i}-${i + batch.length}: ${e?.message ?? e}`);
        break;
      }
    }
    enhancedList.push(...parsed);
    if (i + PARSE_BATCH < sigs.length) await sleep(200);
  }

  // 2) 从 enhanced 结果里抽 tipSource
  const parsedSigs = new Set<string>();
  for (const tx of enhancedList) {
    if (!tx?.signature) continue;
    parsedSigs.add(tx.signature);
    out.set(tx.signature, detectTipSource(tx.nativeTransfers));
  }

  // 3) 兜底：Helius 漏掉的 sig（parserStatus='ERROR' 或整批抛错）走 multi-rpc 单签
  const missing = sigs.filter((s) => !parsedSigs.has(s));
  if (missing.length > 0) {
    console.log(`[backfill-tip-source] Helius 未覆盖 ${missing.length} 笔，转 multi-rpc 兜底`);
    const results = await Promise.allSettled(
      missing.map(async (sig) => {
        const tx = await rpc.getTransaction(sig);
        if (!tx) return { sig, tip: null };
        const enhanced = solanaTxToHeliusEnhanced(tx as any);
        if (!enhanced) return { sig, tip: null };
        return { sig, tip: detectTipSource(enhanced.nativeTransfers) };
      }),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') out.set(r.value.sig, r.value.tip);
    }
  }

  return out;
}

async function backfillTargets() {
  console.log('\n[backfill-tip-source] target_trades: 重解析 nativeTransfers 精准回填');

  const daysFilter = DAYS > 0 ? `AND block_time >= NOW() - INTERVAL '${DAYS} days'` : '';
  const total = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM target_trades
     WHERE COALESCE(target_tip_sol::numeric, 0) > 0
       AND (tip_source IS NULL OR tip_source = 'unknown')
       ${daysFilter.replace('AND', 'AND')}`,
  );
  console.log(`[backfill-tip-source] 待处理 target_trades: ${total[0]?.count ?? 0}`);

  // 分批拉签名（避免一次拉太多吃光 RPC）
  let processed = 0;
  let updated = 0;
  while (true) {
    const rows = await query<{ id: number; signature: string; tip_source: string | null }>(
      `SELECT id, signature, tip_source FROM target_trades
       WHERE COALESCE(target_tip_sol::numeric, 0) > 0
         AND (tip_source IS NULL OR tip_source = 'unknown')
         ${daysFilter}
       ORDER BY id DESC
       LIMIT $1`,
      [BATCH],
    );
    if (rows.length === 0) break;

    const sigs = rows.map((r) => r.signature);
    console.log(`[backfill-tip-source] batch: 处理 ${rows.length} 笔（id 范围 ${rows[0].id}..${rows[rows.length - 1].id}）`);
    const tipMap = await resolveTipSourcesBySig(sigs);

    for (const r of rows) {
      const src = tipMap.get(r.signature);
      if (src === undefined) {
        // 拉失败：保持现状
        continue;
      }
      if (src === null) {
        // 解析结果显示没付 tip，但 DB 里 target_tip_sol>0，说明 DB 数据和链上不一致；
        // 不动 tip_source（让 UI 显示「未付」徽章 + 字段 null）
        continue;
      }
      await execute(
        `UPDATE target_trades SET tip_source = $1 WHERE id = $2 AND tip_source IS DISTINCT FROM $1`,
        [src, r.id],
      );
      updated++;
    }
    processed += rows.length;
    console.log(`[backfill-tip-source] 本批完成，累计处理 ${processed} / 更新 ${updated}`);
    if (rows.length < BATCH) break;
  }

  console.log(`[backfill-tip-source] target_trades 回填结束：处理 ${processed}, 更新 ${updated}`);
}

async function backfillBuyers() {
  console.log('\n[backfill-tip-source] block_buyers: 重解析 nativeTransfers 精准回填');

  // block_buyers 没存 block_time，按 slot 反查 block_analyses
  const daysFilter = DAYS > 0 ? `AND a.block_time >= NOW() - INTERVAL '${DAYS} days'` : '';
  const total = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM block_buyers bb
     JOIN block_analyses a ON a.id = bb.block_analysis_id
     WHERE COALESCE(bb.tip_sol::numeric, 0) > 0
       AND (bb.tip_source IS NULL OR bb.tip_source = 'unknown')
       ${daysFilter}`,
  );
  console.log(`[backfill-tip-source] 待处理 block_buyers: ${total[0]?.count ?? 0}`);

  let processed = 0;
  let updated = 0;
  while (true) {
    const rows = await query<{ id: number; signature: string; tip_source: string | null }>(
      `SELECT bb.id, bb.signature, bb.tip_source
       FROM block_buyers bb
       JOIN block_analyses a ON a.id = bb.block_analysis_id
       WHERE COALESCE(bb.tip_sol::numeric, 0) > 0
         AND (bb.tip_source IS NULL OR bb.tip_source = 'unknown')
         ${daysFilter}
       ORDER BY bb.id DESC
       LIMIT $1`,
      [BATCH],
    );
    if (rows.length === 0) break;

    const sigs = rows.map((r) => r.signature);
    console.log(`[backfill-tip-source] batch: 处理 ${rows.length} 笔`);
    const tipMap = await resolveTipSourcesBySig(sigs);

    for (const r of rows) {
      const src = tipMap.get(r.signature);
      if (src === undefined || src === null) continue;
      await execute(
        `UPDATE block_buyers SET tip_source = $1 WHERE id = $2 AND tip_source IS DISTINCT FROM $1`,
        [src, r.id],
      );
      updated++;
    }
    processed += rows.length;
    console.log(`[backfill-tip-source] 本批完成，累计处理 ${processed} / 更新 ${updated}`);
    if (rows.length < BATCH) break;
  }

  console.log(`[backfill-tip-source] block_buyers 回填结束：处理 ${processed}, 更新 ${updated}`);
}

async function main() {
  console.log('[backfill-tip-source] starting');
  console.log(`[backfill-tip-source] days filter = ${DAYS > 0 ? DAYS : 'ALL'}, batch = ${BATCH}`);
  console.log(`[backfill-tip-source] SOLANA_TIP_SOURCE_MAP 条数 = ${Object.keys(SOLANA_TIP_SOURCE_MAP).length}`);

  if (!BUYERS_ONLY) await backfillTargets();
  if (!TARGETS_ONLY) await backfillBuyers();

  console.log('\n[backfill-tip-source] done');
}

main()
  .catch((e) => {
    console.error('[backfill-tip-source] fatal:', e);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });