/**
 * scripts/backfill-tip-sol.ts
 *
 * 历史 target_trades / block_buyers 的 tip_sol 假 0 回填。
 *
 * 背景：旧版 parser 在 Helius Enhanced 限流时 tipSol 硬编码 0（见 src/lib/parser.ts:532 注释）。
 * 之后 backfill-tip-source.ts 只回填了 tip_source 渠道名，没回填金额，导致出现
 *   `tip_source = 'helius_sender' AND tip_sol = 0.000000000`
 * 这种"假 0"组合（监控列表 tip 字段显示 0.00000）。
 *
 * 本脚本做的事：
 *   - 对 tip_source 已知 ∈ {jito, helius_sender, landx, zero_slot} 且 tip_sol = 0 的行
 *   - 通过 signature 拉真实交易 → 走 solanaTxToHeliusEnhanced 适配 → calcSolanaTip 拿真实 SOL
 *   - UPDATE 落库（只覆盖仍为 0 的，避免把已有正确数据覆盖成错值）
 *
 * 用法：
 *   # 默认：全量回填（target_trades.target_tip_sol + first_sniper_tip_sol + block_buyers.tip_sol）
 *   npx tsx --env-file=.env scripts/backfill-tip-sol.ts
 *
 *   # 只回填 target_trades.target_tip_sol
 *   TARGET_ONLY=1 npx tsx --env-file=.env scripts/backfill-tip-sol.ts
 *
 *   # 只回填 first_sniper_tip_sol
 *   SNIPER_ONLY=1 npx tsx --env-file=.env scripts/backfill-tip-sol.ts
 *
 *   # 只回填 block_buyers.tip_sol
 *   BUYERS_ONLY=1 npx tsx --env-file=.env scripts/backfill-tip-sol.ts
 *
 *   # 只回填最近 N 天（默认全部）
 *   DAYS=7 npx tsx --env-file=.env scripts/backfill-tip-sol.ts
 *
 *   # 限制单批处理行数（默认 500）
 *   BATCH=200 npx tsx --env-file=.env scripts/backfill-tip-sol.ts
 *
 * 注意：
 *   - 拉交易消耗 RPC 配额；先小批（DAYS=1 + BATCH=50）跑一遍验证
 *   - 历史数据中 tx 可能已不可拉（节点历史 shortlist）；失败自动跳过
 */

import { query, execute, pool } from '../src/lib/db';
import { getMultiRpc } from '../src/lib/multi-rpc';
import { getHelius } from '../src/lib/helius';
import { solanaTxToHeliusEnhanced, SOLANA_TIP_ACCOUNTS } from '../src/lib/parser';
import type { HeliusEnhancedTx } from '../src/lib/types';

// Solana 1 SOL = 1e9 lamports（保持与 src/lib/parser.ts 一致，不从 @solana/web3.js 引）
const LAMPORTS_PER_SOL = 1_000_000_000;

const TARGET_ONLY = process.env.TARGET_ONLY === '1';
const SNIPER_ONLY = process.env.SNIPER_ONLY === '1';
const BUYERS_ONLY = process.env.BUYERS_ONLY === '1';
const rawDays = parseInt(process.env.DAYS ?? '0', 10);
const DAYS = Number.isFinite(rawDays) && rawDays > 0 ? rawDays : 0;
const BATCH = parseInt(process.env.BATCH ?? '500', 10);

// Helius Parsed Events 单批上限；>100 容易触发响应体过大 / Helius 限流
const PARSE_BATCH = 100;

// 4 通道：已知有 tip 但 tip_sol 错填 0 的行才需要回填
const KNOWN_SOURCES_SQL = `tip_source IN ('jito','helius_sender','landx','zero_slot')`;

const rpc = getMultiRpc();
const helius = getHelius();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 从 enhanced tx 里算 tip SOL：累加 nativeTransfers 中转账到 SOLANA_TIP_ACCOUNTS 的 lamports。
 * 复用 calcSolanaTip 同款逻辑；这里单独写是为了不依赖 parser 模块的内部 export 顺序，
 * 同时也避免把 NaN/异常值往库写。
 */
function computeTipSol(tx: HeliusEnhancedTx): number {
  if (!tx?.nativeTransfers || tx.nativeTransfers.length === 0) return 0;
  let lamports = 0;
  for (const nt of tx.nativeTransfers) {
    if (!SOLANA_TIP_ACCOUNTS.has(nt.toUserAccount)) continue;
    const amt = typeof nt.amount === 'string' ? Number(nt.amount) : nt.amount;
    if (!Number.isFinite(amt) || amt <= 0) continue;
    lamports += amt;
  }
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * 对一组 signature 拉真实交易，过 SOLANA_TIP_ACCOUNTS 算 tip_sol。
 * 返回 Map<signature, tip_sol | null>，sigs 中拉不到的项不会被放进 map（调用方按 undefined 处理）。
 *   - value > 0: 算到了真实 tip
 *   - value === null: 拉到了 tx 但 nativeTransfers 里没命中任何 tip 收款地址（可能 tip_source 错识别）
 *
 * 路径：
 *   1) 主路径：Helius Parsed Events 批量解析（10 cr / 请求，与签名数无关）
 *   2) 兜底：multi-rpc getTransaction 单签解析（针对主路径漏的 sig）
 */
async function resolveTipSolBySig(sigs: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
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
          console.warn(`[backfill-tip-sol] Parsed Events 失败，${attempt + 1}/3 重试: ${e?.message ?? e}`);
          await sleep(800 * (attempt + 1));
          continue;
        }
        console.warn(`[backfill-tip-sol] Parsed Events 放弃 batch ${i}-${i + batch.length}: ${e?.message ?? e}`);
        break;
      }
    }
    enhancedList.push(...parsed);
    if (i + PARSE_BATCH < sigs.length) await sleep(200);
  }

  const parsedSigs = new Set<string>();
  for (const tx of enhancedList) {
    if (!tx?.signature) continue;
    parsedSigs.add(tx.signature);
    const tip = computeTipSol(tx);
    out.set(tx.signature, tip > 0 ? tip : null);
  }

  // 2) 兜底：Helius 漏的 sig 走 multi-rpc
  const missing = sigs.filter((s) => !parsedSigs.has(s));
  if (missing.length > 0) {
    console.log(`[backfill-tip-sol] Helius 未覆盖 ${missing.length} 笔，转 multi-rpc 兜底`);
    const results = await Promise.allSettled(
      missing.map(async (sig) => {
        const tx = await rpc.getTransaction(sig);
        if (!tx) return { sig, tip: null as number | null };
        const enhanced = solanaTxToHeliusEnhanced(tx as any);
        if (!enhanced) return { sig, tip: null as number | null };
        const tip = computeTipSol(enhanced);
        return { sig, tip: tip > 0 ? tip : null };
      }),
    );
    for (const r of results) {
      if (r.status === 'fulfilled') out.set(r.value.sig, r.value.tip);
    }
  }

  return out;
}

/**
 * target_trades.target_tip_sol：监控目标自己的 buy 的 tip。
 * 条件：tip_source 已知 ∈ 4 通道，但 target_tip_sol 仍是 0。
 *   - 这些是历史 bug（parser 限流时硬编码 0）
 *   - 当前 parser 修复后，新数据不会再进这个状态
 */
async function backfillTargetSelf() {
  console.log('\n[backfill-tip-sol] target_trades.target_tip_sol: 假 0 回填');

  const daysFilter = DAYS > 0 ? `AND block_time >= NOW() - INTERVAL '${DAYS} days'` : '';
  const total = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM target_trades
     WHERE ${KNOWN_SOURCES_SQL}
       AND COALESCE(target_tip_sol::numeric, 0) = 0
       ${daysFilter}`,
  );
  console.log(`[backfill-tip-sol] 待处理 target_trades: ${total[0]?.count ?? 0}`);

  let processed = 0;
  let updated = 0;
  let nulled = 0;
  while (true) {
    const rows = await query<{ id: number; signature: string; tip_source: string | null }>(
      `SELECT id, signature, tip_source FROM target_trades
       WHERE ${KNOWN_SOURCES_SQL}
         AND COALESCE(target_tip_sol::numeric, 0) = 0
         ${daysFilter}
       ORDER BY id DESC
       LIMIT $1`,
      [BATCH],
    );
    if (rows.length === 0) break;

    const sigs = rows.map((r) => r.signature);
    console.log(`[backfill-tip-sol] batch: 处理 ${rows.length} 笔（id 范围 ${rows[0].id}..${rows[rows.length - 1].id}）`);
    const tipMap = await resolveTipSolBySig(sigs);

    for (const r of rows) {
      const tip = tipMap.get(r.signature);
      if (tip === undefined) continue; // 拉失败
      if (tip === null) {
        // 拉到 tx 但 nativeTransfers 没命中 tip 收款地址 → tip_source 误判
        // 这里不动 tip_source（不在本脚本职责），但把 tip_sol 显式标 0 防误读
        await execute(
          `UPDATE target_trades
              SET target_tip_sol = 0
            WHERE id = $1
              AND target_tip_sol IS DISTINCT FROM 0`,
          [r.id],
        );
        nulled++;
        continue;
      }
      // 拉到真实 tip > 0：只覆盖仍为 0 的，避免误改已正确数据
      await execute(
        `UPDATE target_trades
            SET target_tip_sol = $1
          WHERE id = $2
            AND COALESCE(target_tip_sol::numeric, 0) = 0`,
        [tip.toFixed(9), r.id],
      );
      updated++;
    }
    processed += rows.length;
    console.log(`[backfill-tip-sol] 本批完成，累计处理 ${processed} / 回填 ${updated} / 显式置 0 ${nulled}`);
    if (rows.length < BATCH) break;
  }

  console.log(`[backfill-tip-sol] target_trades 回填结束：处理 ${processed}, 回填 ${updated}, 显式置 0 ${nulled}`);
}

/**
 * target_trades.first_sniper_tip_sol：首狙（block_buyers 里那笔 tx）的 tip。
 * 关键差异：要拉的 sig 是 first_sniper_signature，不是 target_trades.signature。
 *   - 因为同 target_trades 行的「自己 buy」和「首狙 buy」是两笔不同的 tx
 *   - 回填条件：tip_source 已知（来自 block_buyers JOIN），但 first_sniper_tip_sol 仍是 0
 *
 * 监控列表「最近一次第一个狙击者」列直接读这个字段，是当前最显眼的假 0 来源。
 */
async function backfillSniper() {
  console.log('\n[backfill-tip-sol] target_trades.first_sniper_tip_sol: 假 0 回填（首狙）');

  const daysFilter = DAYS > 0 ? `AND t.block_time >= NOW() - INTERVAL '${DAYS} days'` : '';
  const total = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM target_trades t
     JOIN block_buyers bb ON bb.signature = t.first_sniper_signature
     WHERE bb.tip_source IN ('jito','helius_sender','landx','zero_slot')
       AND COALESCE(t.first_sniper_tip_sol::numeric, 0) = 0
       AND t.first_sniper_signature IS NOT NULL
       ${daysFilter}`,
  );
  console.log(`[backfill-tip-sol] 待处理 first_sniper_tip_sol: ${total[0]?.count ?? 0}`);

  let processed = 0;
  let updated = 0;
  let nulled = 0;
  while (true) {
    const rows = await query<{ id: number; first_sniper_signature: string }>(
      `SELECT t.id, t.first_sniper_signature
         FROM target_trades t
         JOIN block_buyers bb ON bb.signature = t.first_sniper_signature
        WHERE bb.tip_source IN ('jito','helius_sender','landx','zero_slot')
          AND COALESCE(t.first_sniper_tip_sol::numeric, 0) = 0
          AND t.first_sniper_signature IS NOT NULL
          ${daysFilter}
        ORDER BY t.id DESC
        LIMIT $1`,
      [BATCH],
    );
    if (rows.length === 0) break;

    const sigs = rows.map((r) => r.first_sniper_signature);
    console.log(`[backfill-tip-sol] batch: 处理 ${rows.length} 笔`);
    const tipMap = await resolveTipSolBySig(sigs);

    for (const r of rows) {
      const tip = tipMap.get(r.first_sniper_signature);
      if (tip === undefined) continue;
      if (tip === null) {
        await execute(
          `UPDATE target_trades
              SET first_sniper_tip_sol = 0
            WHERE id = $1
              AND first_sniper_tip_sol IS DISTINCT FROM 0`,
          [r.id],
        );
        nulled++;
        continue;
      }
      await execute(
        `UPDATE target_trades
            SET first_sniper_tip_sol = $1
          WHERE id = $2
            AND COALESCE(first_sniper_tip_sol::numeric, 0) = 0`,
        [tip.toFixed(9), r.id],
      );
      updated++;
    }
    processed += rows.length;
    console.log(`[backfill-tip-sol] 本批完成，累计处理 ${processed} / 回填 ${updated} / 显式置 0 ${nulled}`);
    if (rows.length < BATCH) break;
  }

  console.log(`[backfill-tip-sol] first_sniper_tip_sol 回填结束：处理 ${processed}, 回填 ${updated}, 显式置 0 ${nulled}`);
}

/**
 * block_buyers.tip_sol：block 内每笔 buy 的 tip。
 *   - 这是真值（compute 阶段写入），但旧版 parser bug 也会让这列出现 0
 *   - block 详情页和决策打分都会读这列
 */
async function backfillBuyers() {
  console.log('\n[backfill-tip-sol] block_buyers.tip_sol: 假 0 回填');

  // block_buyers 没存 block_time，按 slot 反查 block_analyses
  const daysFilter = DAYS > 0 ? `AND a.block_time >= NOW() - INTERVAL '${DAYS} days'` : '';
  const total = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM block_buyers bb
     JOIN block_analyses a ON a.id = bb.block_analysis_id
     WHERE bb.tip_source IN ('jito','helius_sender','landx','zero_slot')
       AND COALESCE(bb.tip_sol::numeric, 0) = 0
       ${daysFilter}`,
  );
  console.log(`[backfill-tip-sol] 待处理 block_buyers: ${total[0]?.count ?? 0}`);

  let processed = 0;
  let updated = 0;
  let nulled = 0;
  while (true) {
    const rows = await query<{ id: number; signature: string }>(
      `SELECT bb.id, bb.signature
         FROM block_buyers bb
         JOIN block_analyses a ON a.id = bb.block_analysis_id
        WHERE bb.tip_source IN ('jito','helius_sender','landx','zero_slot')
          AND COALESCE(bb.tip_sol::numeric, 0) = 0
          ${daysFilter}
        ORDER BY bb.id DESC
        LIMIT $1`,
      [BATCH],
    );
    if (rows.length === 0) break;

    const sigs = rows.map((r) => r.signature);
    console.log(`[backfill-tip-sol] batch: 处理 ${rows.length} 笔`);
    const tipMap = await resolveTipSolBySig(sigs);

    for (const r of rows) {
      const tip = tipMap.get(r.signature);
      if (tip === undefined) continue;
      if (tip === null) {
        await execute(
          `UPDATE block_buyers
              SET tip_sol = 0
            WHERE id = $1
              AND tip_sol IS DISTINCT FROM 0`,
          [r.id],
        );
        nulled++;
        continue;
      }
      await execute(
        `UPDATE block_buyers
            SET tip_sol = $1
          WHERE id = $2
            AND COALESCE(tip_sol::numeric, 0) = 0`,
        [tip.toFixed(9), r.id],
      );
      updated++;
    }
    processed += rows.length;
    console.log(`[backfill-tip-sol] 本批完成，累计处理 ${processed} / 回填 ${updated} / 显式置 0 ${nulled}`);
    if (rows.length < BATCH) break;
  }

  console.log(`[backfill-tip-sol] block_buyers 回填结束：处理 ${processed}, 回填 ${updated}, 显式置 0 ${nulled}`);
}

async function main() {
  console.log('[backfill-tip-sol] starting');
  console.log(`[backfill-tip-sol] days filter = ${DAYS > 0 ? DAYS : 'ALL'}, batch = ${BATCH}`);

  // 互斥 + 全开互斥：任一开关只跑对应一个；都不开就跑全部
  const only = [TARGET_ONLY, SNIPER_ONLY, BUYERS_ONLY].filter(Boolean).length;
  if (only > 1) {
    console.error('[backfill-tip-sol] 互斥的开关只能开一个：TARGET_ONLY / SNIPER_ONLY / BUYERS_ONLY');
    process.exit(2);
  }

  if (!SNIPER_ONLY && !BUYERS_ONLY) await backfillTargetSelf();
  if (!TARGET_ONLY && !BUYERS_ONLY) await backfillSniper();
  if (!TARGET_ONLY && !SNIPER_ONLY) await backfillBuyers();

  console.log('\n[backfill-tip-sol] done');
}

main()
  .catch((e) => {
    console.error('[backfill-tip-sol] fatal:', e);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
