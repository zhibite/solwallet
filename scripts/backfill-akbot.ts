/**
 * scripts/backfill-akbot.ts
 *
 * 一次性回填脚本（CLI 版）：扫描所有 pool_members，识别哪些是 AKBot 用户。
 *
 * 现在共享 src/lib/akbot-backfill.ts 的核心 —— Web UI 按钮、每日定时 worker、
 * 和这个 CLI 脚本走的都是同一份逻辑（同一熔断、同一 inconclusive 三态语义）。
 *
 * 用法：
 *   npx tsx --env-file=.env scripts/backfill-akbot.ts
 *
 *   # 自定义参数
 *   LIMIT=2000 SLEEP_MS=300 MAX_SIGS=2000 npx tsx --env-file=.env scripts/backfill-akbot.ts
 *     LIMIT    一次最多扫多少个地址（按 freq DESC 选）
 *     SLEEP_MS 每个地址之间的间隔（ms），防止 Helius 速率限制
 *     MAX_SIGS 每地址最多翻多少笔签名（默认 5000 = 5 页 * 1000）
 *
 * 输出：
 *   - 控制台进度日志
 *   - DB 更新：pool_members.is_akbot = true + 证据 sig/slot/time
 */

import { query, pool } from '../src/lib/db';
import { runAkbotScan, AKBOT_PROGRAM } from '../src/lib/akbot-backfill';

const LIMIT = parseInt(process.env.LIMIT ?? '500', 10);
const SLEEP_MS = parseInt(process.env.SLEEP_MS ?? '200', 10);
const MAX_SIGS = parseInt(process.env.MAX_SIGS ?? '5000', 10);

async function main() {
  console.log('[backfill-akbot] starting');
  console.log(`[backfill-akbot] program = ${AKBOT_PROGRAM}`);
  console.log(`[backfill-akbot] LIMIT   = ${LIMIT} addresses`);
  console.log(`[backfill-akbot] maxSigs = ${MAX_SIGS} per address`);

  const t0 = Date.now();
  const result = await runAkbotScan({
    limit: LIMIT,
    sleepMs: SLEEP_MS,
    maxPages: Math.ceil(MAX_SIGS / 1000),
    pageSize: 1000,
    onProgress: (p) => {
      // 30/50 行打一次心跳，不打满屏
      if (p.scanned % 50 === 0 || p.status !== 'running') {
        const eta = p.etaMs ? `ETA ${(p.etaMs / 1000).toFixed(0)}s` : '';
        process.stdout.write(
          `[backfill-akbot] scanned=${p.scanned}/${p.total} detected=${p.detected}` +
          ` skipped=${p.skipped} failed=${p.failed} ${eta}\n`,
        );
      }
      if (p.detected > 0 && p.result) {
        // 命中明细单独打一行
        for (const h of p.result.hits) {
          console.log(`  HIT  ${h.address.slice(0, 8)}…${h.address.slice(-4)} evidence=${h.evidence.slice(0, 16)}…`);
        }
      }
    },
  });

  const total = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM pool_members WHERE is_akbot = TRUE`,
  );

  console.log(
    `\n[backfill-akbot] done in ${(result.durationMs / 1000).toFixed(1)}s — ` +
    `scanned=${result.scanned} detected=${result.detected} failed=${result.failed} skipped=${result.skipped}`,
  );
  console.log(`[backfill-akbot] total akbot members in pool = ${total[0].c}`);
  if (result.skipped > 0) {
    console.log(
      `[backfill-akbot] 注意：${result.skipped} 个地址因限流/熔断未扫完，重跑本脚本（增大 LIMIT）会重新扫它们。`,
    );
  }
  if (t0) { /* 防止 lint 报 unused */ }
}

main()
  .catch((e) => {
    console.error('[backfill-akbot] fatal:', e);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });