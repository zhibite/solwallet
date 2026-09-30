/**
 * 监控 worker：监听已注册的目标地址，发现 buy 即入库并触发 block 分析
 *
 * 启动方式：
 * 1) 在 Next.js 启动时通过 instrumentation.ts 启动
 * 2) 或者通过独立 node scripts/monitor.ts
 *
 * 数据源：
 * - 优先使用 Helius Enhanced Webhooks
 * - Fallback 用 Helius getSignaturesForAddress 轮询
 */

import { query, queryOne, withTransaction } from './db';
import { getHelius, isHeliusConfigured } from './helius';
import { parseHeliusTx } from './parser';
import { saveBlockAnalysis } from './first-sniper';

const POLL_INTERVAL_MS = parseInt(process.env.MONITOR_POLL_INTERVAL_MS || '5000', 10);
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_ONLY = process.env.HELIUS_USE_WEBHOOK === 'true' && !!WEBHOOK_URL;
const lastSigs = new Map<number, string>(); // targetId -> latest signature

let running = false;
let pollTimer: NodeJS.Timeout | null = null;

/** 启动监控 */
export async function startMonitor() {
  if (running) return;
  running = true;
  console.log('[monitor] starting');

  // 0) 检查 Helius key
  if (!isHeliusConfigured()) {
    console.warn('[monitor] HELIUS_API_KEY 未配置，监控功能已禁用（数据查询仍可用）');
    console.warn('[monitor] 申请地址: https://dashboard.helius.dev');
    return;
  }

  // 1) 注册 Helius Webhook
  if (WEBHOOK_ONLY) {
    try {
      await registerWebhooks();
    } catch (err) {
      console.warn('[monitor] registerWebhooks failed, fall back to polling', err);
    }
  }

  // 2) 启动 polling loop（webhook 模式下跳过，避免双倍 RPC）
  if (!WEBHOOK_ONLY) {
    console.log('[monitor] polling mode (webhook 关闭)');
    scheduleNextPoll();
  } else {
    console.log('[monitor] webhook only mode，跳过轮询');
  }
}

/** 停止监控 */
export function stopMonitor() {
  running = false;
  if (pollTimer) clearTimeout(pollTimer);
}

function scheduleNextPoll() {
  if (!running) return;
  pollTimer = setTimeout(async () => {
    try {
      await pollAllTargets();
    } catch (err) {
      console.error('[monitor] poll error', err);
    }
    scheduleNextPoll();
  }, POLL_INTERVAL_MS);
}

/** 轮询所有 active 目标 */
async function pollAllTargets() {
  const helius = getHelius();
  const targets = await query<any>(`
    SELECT id, address, threshold_sol, last_buy_at
    FROM monitored_targets
    WHERE status = 'active'
  `);

  for (const t of targets) {
    try {
      const sigs = await helius.getSignaturesForAddress(t.address, { limit: 20 });
      for (const s of sigs) {
        if (s.err) continue;
        // 已存在则跳过
        const existing = await queryOne<{ id: number }>(
          'SELECT id FROM target_trades WHERE signature = $1',
          [s.signature],
        );
        if (existing) continue;

        // 解析 + 阈值过滤
        const tx = await helius.parseTransaction(s.signature);
        if (!tx) continue;
        const buy = parseHeliusTx(tx);
        if (!buy) continue;
        if (buy.buySol < parseFloat(t.threshold_sol)) continue;

        // 写库
        await ingestTargetTrade(t.id, buy, tx);
      }
      // 更新 last_buy_at（不修改 record_count，那由 ingestTargetTrade 维护）
      if (sigs.length > 0) {
        await query(
          'UPDATE monitored_targets SET last_buy_at = to_timestamp($1) WHERE id = $2',
          [sigs[0].blockTime, t.id],
        );
      }
    } catch (err) {
      console.error(`[monitor] poll target ${t.address} failed`, err);
    }
  }
}

/** 写入一笔目标交易 + 触发 block 分析 */
export async function ingestTargetTrade(targetId: number, buy: any, rawTx: any) {
  const { saveBlockAnalysis, analyzeBlock } = await import('./first-sniper');

  // 1) 写 target_trades（COALESCE 兜底，防止 blockTime 为 0/undefined 时 to_timestamp 失败）
  //    用 xmax=0 判定「真实新增」——ON CONFLICT DO UPDATE 触发的更新 xmax ≠ 0
  const inserted = await queryOne<{ id: number; was_inserted: boolean }>(`
    INSERT INTO target_trades (
      target_id, signature, slot, block_time, mint, target_address,
      buy_sol, target_tip_sol, target_prio_lamports, is_bundled, version
    ) VALUES ($1,$2,$3,to_timestamp(COALESCE(NULLIF($4, 0), EXTRACT(epoch FROM NOW()))),$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (signature) DO UPDATE SET slot = EXCLUDED.slot
    RETURNING id, (xmax = 0) AS was_inserted
  `, [
    targetId,
    buy.signature,
    buy.slot,
    buy.blockTime || 0,
    buy.mint,
    buy.address,
    buy.buySol,
    buy.tipSol,
    buy.prioLamports,
    buy.isBundled,
    buy.version,
  ]);

  if (!inserted) return;

  // 1.5) 真实新增时 +1（webhook 重投 / polling 重复扫到同一个 sig 不会重复计数）
  if (inserted.was_inserted) {
    await query(
      'UPDATE monitored_targets SET record_count = record_count + 1 WHERE id = $1',
      [targetId],
    );
  }

  // 2) 触发 block 级分析（异步，不阻塞）
  setImmediate(async () => {
    try {
      const analyzeResult = await analyzeBlock(buy.slot, buy.mint, buy.signature);
      const blockTime = buy.blockTime
        ? new Date(buy.blockTime * 1000).toISOString()
        : new Date().toISOString();
      await saveBlockAnalysis(buy.slot, buy.mint, buy.signature, blockTime, analyzeResult);

      // 识别第一个狙击者，更新 target_trades
      const sniper = analyzeResult.buyers.find((b) => b.mark === 'first_sniper');
      if (sniper) {
        await query(
          `UPDATE target_trades
           SET first_sniper = $1, first_sniper_buy_sol = $2,
               first_sniper_tip_sol = $3, first_sniper_prio_lamports = $4,
               first_sniper_signature = $5,
               first_sniper_offset_pos = $7
           WHERE signature = $6`,
          [
            sniper.address,
            sniper.buySol,
            sniper.tipSol,
            sniper.prioLamports,
            sniper.signature,
            buy.signature,
            sniper.offsetPos,
          ],
        );
      }

      // 3) 增量扫描池子（递归发现闭环）
      try {
        const { scanForTarget } = await import('./pool');
        await scanForTarget({ targetAddress: buy.address });
      } catch (poolErr) {
        console.warn('[monitor] pool scan failed', poolErr);
      }
    } catch (err) {
      console.error('[monitor] analyzeBlock failed', err);
    }
  });
}

/** 同步 Helius Webhook（handler 调用） */
export async function registerWebhooks() {
  if (!WEBHOOK_URL) {
    throw new Error('WEBHOOK_URL 未配置');
  }
  const helius = getHelius();
  const targets = await query<{ address: string }>(
    "SELECT address FROM monitored_targets WHERE status = 'active'",
  );
  if (targets.length === 0) return;

  const addresses = targets.map((t) => t.address);

  // 检查现有 webhook 是否包含这些地址
  const existing = await helius.listWebhooks();
  const ourWebhook = existing.find((w) => w.webhookURL === WEBHOOK_URL);

  if (ourWebhook) {
    // 同步地址
    await helius.updateWebhookAddresses(ourWebhook.webhookID, addresses);
    console.log('[monitor] webhook updated', ourWebhook.webhookID);
  } else {
    const w = await helius.createWebhook({
      webhookURL: WEBHOOK_URL,
      accountAddresses: addresses,
      transactionTypes: ['Any'],
    });
    console.log('[monitor] webhook created', w.webhookID);
  }
}

/** 处理 webhook 推送（被 api/webhooks/helius/route.ts 调用） */
export async function handleWebhookEvent(events: any[]) {
  const helius = getHelius();
  for (const ev of events) {
    try {
      // 写日志
      await query(
        'INSERT INTO webhook_events (source, payload) VALUES ($1, $2)',
        ['helius', JSON.stringify(ev)],
      );

      const signature = ev.signature;
      if (!signature) continue;

      // 优先按 feePayer 严格匹配（目标地址作为 buy 发起者）。
      // 同时把 accountData 中的账户放进备选池，用于 fallback（如 v0 交易 feePayer 是 ALT 钱包）。
      const accountKeys: string[] = [
        ev.feePayer,
        ...(ev.accountData?.map((a: any) => a.account) ?? []),
        ...(ev.nativeTransfers?.flatMap((t: any) => [t.fromUserAccount, t.toUserAccount]) ?? []),
        ...(ev.tokenTransfers?.flatMap((t: any) => [t.fromUserAccount, t.toUserAccount]) ?? []),
      ];
      // 1) 严格匹配 feePayer
      let matches = await query<{ id: number; address: string; threshold_sol: string }>(
        `SELECT id, address, threshold_sol FROM monitored_targets
         WHERE status = 'active' AND address = $1`,
        [ev.feePayer],
      );
      // 2) Fallback：如果 feePayer 不命中（罕见的 ALT/v0 场景），再用 accountKeys 池匹配
      if (matches.length === 0) {
        matches = await query<{ id: number; address: string; threshold_sol: string }>(
          `SELECT id, address, threshold_sol FROM monitored_targets
           WHERE status = 'active' AND address = ANY($1)`,
          [accountKeys],
        );
      }
      if (matches.length === 0) continue;

      const buy = parseHeliusTx(ev);
      if (!buy) continue;

      for (const m of matches) {
        if (buy.buySol < parseFloat(m.threshold_sol)) continue;
        await ingestTargetTrade(m.id, buy, ev);
      }
    } catch (err) {
      console.error('[monitor] webhook event error', err);
      await query(
        'UPDATE webhook_events SET error = $1, processed = true WHERE id = (SELECT MAX(id) FROM webhook_events)',
        [String(err)],
      );
    }
  }
}
