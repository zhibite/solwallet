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
import { getMultiRpc } from './multi-rpc';
import { parseHeliusTx } from './parser';
import { saveBlockAnalysis } from './first-sniper';
import { quickAkbotCheck } from './akbot';
import { markAsAkbot } from './pool';

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
  // 签名列表是公开 RPC，走多源轮询降 Helius 配额消耗；
  // 解析（parseTransaction）只能走 Helius Enhanced API，保留
  const helius = getHelius();
  const rpc = getMultiRpc();
  const targets = await query<any>(`
    SELECT id, address, threshold_sol, last_buy_at
    FROM monitored_targets
    WHERE status = 'active'
  `);

  for (const t of targets) {
    try {
      const sigs = await rpc.getSignaturesForAddress(t.address, 20);
      let recordedCount = 0; // 本轮实际入 buy 的数量
      let recordedBlockTime: number | null = null; // 最近一笔被记录的 buy 的 blockTime
      // 整批解析遇 429（Helius 配额打满）→ 短退避一次，避免雪崩重试
      let parseBackoffMs = 0;
      for (const s of sigs) {
        if (s.err) continue;
        // 已存在则跳过
        const existing = await queryOne<{ id: number }>(
          'SELECT id FROM target_trades WHERE signature = $1',
          [s.signature],
        );
        if (existing) continue;

        // 单 sig 解析失败（429/网络）→ 跳过这一个,继续下一个。
        // 这条把"Helius 限流 → 整个 target poll 瘫痪"修掉,只丢当批未解析的 sigs,
        // 下次轮询 (默认 15s) 会再扫到同一批未入库的 sigs,DB 主键去重保证不重复入库。
        // parseTransactionWithFallback: Helius Enhanced 优先,失败/限流时自动
        // 回退到 6 个公共 RPC + 自适配 parser,Helius 被打满也不会丢解析能力。
        let tx: Awaited<ReturnType<typeof helius.parseTransactionWithFallback>> = null;
        try {
          if (parseBackoffMs > 0) await new Promise((r) => setTimeout(r, parseBackoffMs));
          tx = await helius.parseTransactionWithFallback(s.signature);
          parseBackoffMs = 0;
        } catch (perr: any) {
          const status = perr?.response?.status ?? perr?.status;
          if (status === 429) {
            // 整批打满 → 退避 8s,本批剩余 sigs 全部跳过
            parseBackoffMs = 8_000;
            console.warn(`[monitor] Helius 429 on target ${t.address.slice(0, 8)}… — skip remaining ${sigs.length - sigs.indexOf(s) - 1} sigs, retry next poll`);
            break;
          }
          // 其它错误（5xx/网络）→ 跳过这一个继续
          console.warn(`[monitor] parseTransaction ${s.signature.slice(0, 12)}… failed: ${perr?.message ?? perr}`);
          continue;
        }
        if (!tx) continue;
        const buy = parseHeliusTx(tx);
        if (!buy) continue;
        if (buy.buySol < parseFloat(t.threshold_sol)) continue;

        // 写库
        await ingestTargetTrade(t.id, buy, tx);
        recordedCount++;
        // 用被录入的那笔的 blockTime，没拿到就用签名列表的头条
        recordedBlockTime = (buy.blockTime && buy.blockTime > 0) ? buy.blockTime : s.blockTime;
      }
      // 只在真正入 buy 时才更新 last_buy_at；避免「拉到卖出/转账就把 last_buy_at 推高」的误导
      if (recordedCount > 0 && recordedBlockTime) {
        await query(
          'UPDATE monitored_targets SET last_buy_at = to_timestamp($1) WHERE id = $2',
          [recordedBlockTime, t.id],
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

      // 4) 实时 AkBot 检测：对这次 block 的所有非 own / 非 target 买家，
      //    各跑一次 quickAkbotCheck（最近 200 签名），命中即异步标记。
      //    顺序执行 + 150ms throttle 防止 Helius 速率限制；
      //    再套一层 setImmediate 做到真正 fire-and-forget —— 不阻塞下一次 analyzeBlock/pool scan。
      //    （webhook 突发时，analyzeBlock 不会因 akbot 排队而堆积。）
      setImmediate(() => {
        scheduleAkbotChecksForBuyers(analyzeResult.buyers).catch((e) =>
          console.warn('[monitor] akbot check failed:', (e as Error).message),
        );
      });
    } catch (err) {
      console.error('[monitor] analyzeBlock failed', err);
    }
  });
}

/**
 * 对一批买家跑轻量 AkBot 检测
 * - 跳过 mark === 'target' / 'own'
 * - 同地址只跑一次
 * - 命中后立即 markAsAkbot（幂等）
 * - 顺序执行 + 150ms throttle（Helius free ~10 RPS，paid ~50 RPS）
 *
 * 每个 event 5-20 个新买家 → 顺序执行 ≈ 1-3s。
 * 故意做成在 setImmediate 里调用，避免阻塞 monitor 主流程（analyzeBlock / pool scan / 下一次事件）。
 * 若想彻底解耦，可以把这一段提到独立 worker / BullMQ 队列。
 */
export async function scheduleAkbotChecksForBuyers(
  buyers: Array<{ address: string; mark?: string }>,
): Promise<void> {
  if (!Array.isArray(buyers) || buyers.length === 0) return;
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const b of buyers) {
    if (!b?.address) continue;
    if (b.mark === 'target' || b.mark === 'own') continue;
    if (seen.has(b.address)) continue;
    seen.add(b.address);
    targets.push(b.address);
  }
  if (targets.length === 0) return;

  const SLEEP_MS = 150;
  for (const addr of targets) {
    try {
      const ev = await quickAkbotCheck(addr);
      if (ev) {
        await markAsAkbot(addr, ev.signature, ev.blockTime, ev.slot);
        console.log(
          `[monitor] akbot detected ${addr.slice(0, 8)}…${addr.slice(-4)} evidence=${ev.signature.slice(0, 12)}…`,
        );
      }
    } catch (err) {
      // 单个地址失败不影响其它
      console.warn(`[monitor] quickAkbotCheck ${addr.slice(0, 8)}… failed: ${(err as Error).message}`);
    }
    if (SLEEP_MS > 0) await new Promise((r) => setTimeout(r, SLEEP_MS));
  }
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
