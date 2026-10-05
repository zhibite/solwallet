/**
 * scripts/backfill-akbot.ts
 *
 * 一次性回填脚本：扫描所有 pool_members，识别哪些是 AKBot 用户。
 *
 * 检测逻辑：
 *   拉地址最近 ~5000 笔签名，分批解析，找「任意交易（含 inner instructions）
 *   调用过 AKBot 合约 (AKbotMAGJmYPwV8z55Lqiqgijt2KcjLeFGue5sw1noHM)」的 tx 作为证据。
 *
 * 用法：
 *   # 先应用 migration（0006_akbot_tag.sql）创建字段
 *   npx tsx --env-file=.env scripts/backfill-akbot.ts
 *
 *   # 自定义扫描上限（默认 500 地址）
 *   LIMIT=2000 SLEEP_MS=300 npx tsx --env-file=.env scripts/backfill-akbot.ts
 *     LIMIT    一次最多扫多少个地址（按 freq DESC 选）
 *     SLEEP_MS 每个地址之间的间隔（ms），防止 Helius 速率限制
 *
 * 输出：
 *   - 控制台进度日志
 *   - DB 更新：pool_members.is_akbot = true + 证据 sig/slot/time
 *
 * 注意：
 *   - markAsAkbot 是幂等的；已经被标记的会被自动跳过（不影响证据字段）
 *   - 每地址之间 sleep 200ms，避免 Helius 速率限制
 *   - 该脚本对 Helius API key 有强依赖；env 必须配 HELIUS_API_KEY
 */

import { query, pool } from '../src/lib/db';
import { scanAddressForAkbot, AKBOT_PROGRAM } from '../src/lib/akbot';
import { markAsAkbot } from '../src/lib/pool';

const LIMIT = parseInt(process.env.LIMIT ?? '500', 10);
const SLEEP_MS = parseInt(process.env.SLEEP_MS ?? '200', 10);

async function main() {
  console.log('[backfill-akbot] starting');
  console.log(`[backfill-akbot] program = ${AKBOT_PROGRAM}`);
  console.log(`[backfill-akbot] LIMIT   = ${LIMIT} addresses`);

  // 1) 拉候选池：freq 高的优先扫（活跃地址更可能是 akbot 用户）
  const candidates = await query<{ address: string; freq: number }>(`
    SELECT address, freq::int AS freq
    FROM pool_members
    WHERE is_akbot = FALSE
    ORDER BY freq DESC
    LIMIT $1
  `, [LIMIT]);

  console.log(`[backfill-akbot] scanning ${candidates.length} pool members\n`);

  let scanned = 0;
  let detected = 0;
  let failed = 0;
  let skipped = 0; // 熔断/限流导致没扫完的地址 —— 下一轮 LIMIT 更大时自然覆盖到
  const t0 = Date.now();

  for (const c of candidates) {
    scanned++;
    try {
      const res = await scanAddressForAkbot(c.address);
      if (res.status === 'found') {
        const ev = res.evidence;
        await markAsAkbot(c.address, ev.signature, ev.blockTime, ev.slot);
        detected++;
        console.log(
          `  [${scanned}/${candidates.length}] HIT  ${c.address.slice(0, 8)}…${c.address.slice(-4)} ` +
          `(freq=${c.freq}) evidence=${ev.signature.slice(0, 12)}…`,
        );
      } else if (res.status === 'inconclusive') {
        // 关键：不能把「没扫完」当成「不是 akbot」。这类地址不写任何标记，
        // 下次跑（WHERE is_akbot = FALSE 会重新捞到它）再扫一遍。
        skipped++;
        console.warn(
          `  [${scanned}/${candidates.length}] SKIP ${c.address.slice(0, 8)}… (${res.reason})`,
        );
      } else {
        process.stdout.write(
          `.${scanned % 50 === 0 ? '\n' : ''}`,
        );
      }
    } catch (err) {
      failed++;
      console.warn(
        `\n  [${scanned}/${candidates.length}] FAIL ${c.address.slice(0, 8)}…: ${(err as Error).message}`,
      );
    }
    if (SLEEP_MS > 0) await new Promise((r) => setTimeout(r, SLEEP_MS));
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `\n\n[backfill-akbot] done in ${elapsed}s — scanned=${scanned} detected=${detected} failed=${failed} skipped=${skipped}`,
  );
  if (skipped > 0) {
    console.log(
      `[backfill-akbot] 注意：${skipped} 个地址因限流/熔断未扫完，重跑本脚本（增大 LIMIT）会重新扫它们。`,
    );
  }

  // 顺手打一下当前 AKBot 总数
  const total = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM pool_members WHERE is_akbot = TRUE`,
  );
  console.log(`[backfill-akbot] total akbot members in pool = ${total[0].c}`);
}

main()
  .catch((e) => {
    console.error('[backfill-akbot] fatal:', e);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });