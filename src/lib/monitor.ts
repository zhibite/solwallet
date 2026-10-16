/**
 * Helius Enhanced Webhooks 入库 + 注册（被 ws-monitor 之外的 webhook 链路共用）
 *
 * 监控主路径已切到 WebSocket（src/lib/ws-monitor.ts，毫秒级 logsSubscribe）。
 * 本文件只保留：
 *   1) registerWebhooks    — 同步 active 目标地址到 Helius webhook（被 sync-webhook.ts 触发）
 *   2) handleWebhookEvent  — Helius POST 进来的事件解析 + 入库（被 api/webhooks/helius/route.ts 调用）
 *   3) ingestTargetTrade   — webhook 入库与后续 block / pool / akbot 联动逻辑
 *   4) akbot 重试队列     — 给熔断吞掉的地址补扫
 *
 * 已移除（2026-10-15）：
 *   - startMonitor / stopMonitor / scheduleNextPoll / pollAllTargets
 *     轮询方案：5s 拉 getSignaturesForAddress + Helius parseEvents。
 *     WebSocket logsSubscribe 已完全覆盖，公共 RPC 限流时轮询会被 429 拖崩，没意义。
 */

import { query, queryOne } from './db';
import { getHelius } from './helius';
import { parseHeliusTx } from './parser';
import { saveBlockAnalysis, computeBulkBuyerPnL, applyFirstSniperToTarget } from './first-sniper';
import { quickAkbotCheck, isAkbotCircuitOpen } from './akbot';
import { markAsAkbot } from './pool';

const WEBHOOK_URL = process.env.WEBHOOK_URL || '';

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
    console.log('[webhook] updated', ourWebhook.webhookID);
  } else {
    const w = await helius.createWebhook({
      webhookURL: WEBHOOK_URL,
      accountAddresses: addresses,
      transactionTypes: ['Any'],
    });
    console.log('[webhook] created', w.webhookID);
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
      console.error('[webhook] event error', err);
      await query(
        'UPDATE webhook_events SET error = $1, processed = true WHERE id = (SELECT MAX(id) FROM webhook_events)',
        [String(err)],
      );
    }
  }
}

/** 写入一笔目标交易 + 触发 block 分析（webhook 路径专用） */
export async function ingestTargetTrade(targetId: number, buy: any, rawTx: any) {
  const { analyzeBlock } = await import('./first-sniper');

  // 1) 写 target_trades（COALESCE 兜底，防止 blockTime 为 0/undefined 时 to_timestamp 失败）
  //    用 xmax=0 判定「真实新增」——ON CONFLICT DO UPDATE 触发的更新 xmax ≠ 0
  //    新增 bundle 元数据（has_alt / bundle_id），bundle_size 由同 bundle 的其他 tx 聚合后回填
  //    0010: tip_source 由 parser.ts 从 SOLANA_TIP_SOURCE_MAP 映射得到，监控时落库
  const inserted = await queryOne<{ id: number; was_inserted: boolean }>(`
    INSERT INTO target_trades (
      target_id, signature, slot, block_time, mint, target_address,
      buy_sol, target_tip_sol, target_prio_lamports, is_bundled, version,
      has_alt, bundle_id, tip_source
    ) VALUES ($1,$2,$3,to_timestamp(COALESCE(NULLIF($4, 0), EXTRACT(epoch FROM NOW()))),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (signature) DO UPDATE SET
      slot = EXCLUDED.slot,
      is_bundled = EXCLUDED.is_bundled,
      has_alt = EXCLUDED.has_alt,
      bundle_id = COALESCE(EXCLUDED.bundle_id, target_trades.bundle_id),
      tip_source = COALESCE(EXCLUDED.tip_source, target_trades.tip_source)
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
    buy.hasAlt,
    buy.bundleId,
    buy.tipSource,
  ]);

  if (!inserted) return;

  // 1.4) 如果本笔是 bundle 的一部分，把同一 bundle_id 的所有 target_trades 标上 bundle_size
  //      合并成一条 SQL 避免 SELECT+UPDATE 之间被并发插入污染（race → size=1）
  //      语义说明：这里 COUNT 的是 target_trades 表内同 bundle_id 的行数；
  //                monitor 只记录目标 wallet 的买入，所以 jito bundle 内 5 笔 tx 只买 1 个目标时也是 1。
  //                真实 bundle 大小参考 block_buyers.bundle_size（在 first-sniper 里算）。
  if (buy.bundleId) {
    await query(
      `WITH cnt AS (
         SELECT bundle_id, COUNT(*)::int AS c
           FROM target_trades
          WHERE bundle_id = $1
          GROUP BY bundle_id
       )
       UPDATE target_trades t
          SET bundle_size = cnt.c
         FROM cnt
        WHERE t.bundle_id = cnt.bundle_id`,
      [buy.bundleId],
    );
  }

  // 1.5) 真实新增时 +1 + 推进 last_buy_at（webhook 重投 / polling 重复扫到同一个 sig 不会重复计数）
  //    关键：ON CONFLICT 时也必须推进 last_buy_at。
  //    原因：ws 重连重放导致同一 sig 多次进入 ingestWsTrade；poll 因网络抖动也可能
  //    两次 INSERT 同一 sig（一次 INSERT，一次 ON CONFLICT）。两种情况都是
  //    was_inserted = false 但 last_buy_at 必须推进，否则 poll 的过滤会失效。
  if (inserted.was_inserted) {
    const blockSec = buy.blockTime && buy.blockTime > 0
      ? buy.blockTime
      : Math.floor(Date.now() / 1000);
    await query(
      'UPDATE monitored_targets SET record_count = record_count + 1, last_buy_at = to_timestamp($2) WHERE id = $1',
      [targetId, blockSec],
    );
  } else {
    // ON CONFLICT：只推进 last_buy_at，不重复计数
    const blockSec = buy.blockTime && buy.blockTime > 0
      ? buy.blockTime
      : Math.floor(Date.now() / 1000);
    await query(
      'UPDATE monitored_targets SET last_buy_at = to_timestamp($2) WHERE id = $1',
      [targetId, blockSec],
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

      // 立即算本 block 所有 buyer 的 PnL（不等独立 worker 兜底）：
      //   - block_buyers 刚由 saveBlockAnalysis 写好，pnl_sol=NULL
      //   - filter 跳过 follower / pre_target 的 'open' 行（FIFO 翻签名页在没卖出的情况下是纯浪费）
      //   - 真正 fire-and-forget：再包一层 setImmediate，不阻塞后面的 first_sniper 回填 / pool scan / akbot
      //   - 历史 backlog（worker 卡在 456738961 之前的那批）由 scripts/backfill-block-pnl.ts 一次补齐
      // 浮盈功能 2026-10-15 砍掉后，prefillOpenUnrealized 整段移除。
      setImmediate(() => {
        computeBulkBuyerPnL(buy.slot, buy.mint)
          .then((r) => {
            if (r.results.length === 0) return;
            const closed = r.results.filter((x) => x.status === 'closed').length;
            const open = r.results.filter((x) => x.status === 'open').length;
            const errors = r.results.filter((x) => x.status === 'error').length;
            console.log(
              `[webhook] immediate pnl slot=${buy.slot} mint=${buy.mint.slice(0, 8)}... computed=${r.results.length} closed=${closed} open=${open} errors=${errors}`,
            );
          })
          .catch((e) =>
            console.warn(
              `[webhook] immediate pnl failed slot=${buy.slot}:`,
              (e as Error)?.message ?? e,
            ),
          );
      });

      // 识别第一个狙击者，更新 target_trades —— 公共函数在 first-sniper.ts
      // 任何 analyze 路径都必须调它，否则会出现 block_buyers.is_first_sniper=true 但
      // target_trades.first_sniper=null 的不一致（详见 applyFirstSniperToTarget 注释）。
      try {
        await applyFirstSniperToTarget(buy.signature, analyzeResult);
      } catch (sniperErr) {
        // 单独 try/catch：sniper 回填失败不应影响后面的 pool scan / akbot
        console.warn('[webhook] applyFirstSniperToTarget failed', sniperErr);
      }

      // 3) 增量扫描池子（递归发现闭环）
      try {
        const { scanForTarget } = await import('./pool');
        await scanForTarget({ targetAddress: buy.address });
      } catch (poolErr) {
        console.warn('[webhook] pool scan failed', poolErr);
      }

      // 4) 实时 AkBot 检测：对这次 block 的所有非 own / 非 target 买家，
      //    各跑一次 quickAkbotCheck（最近 200 签名），命中即标记。
      //    顺序执行 + 150ms throttle 防止 Helius 速率限制；
      //    再套一层 setImmediate 做到真正 fire-and-forget —— 不阻塞下一次 analyzeBlock/pool scan。
      //    （webhook 突发时，analyzeBlock 不会因 akbot 排队而堆积。）
      //    被熔断/限流打断的地址由 scheduleAkbotChecksForBuyers 内部的
      //    akbotRetryQueue 补扫，不会因为离开这个 block 就丢失。
      setImmediate(() => {
        scheduleAkbotChecksForBuyers(analyzeResult.buyers).catch((e) =>
          console.warn('[webhook] akbot check failed:', (e as Error).message),
        );
      });
    } catch (err) {
      console.error('[webhook] analyzeBlock failed', err);
    }
  });
}

/**
 * AKBot 检测被熔断/限流打断时，地址会进这里等重试。
 *
 * 为什么不靠「下一轮监控自然会重试」：每轮监控的入参是该 block 的新买家，
 * 被熔断吞掉的地址属于上一个 block，不会再进这个列表 —— 静默丢弃就是永久漏检。
 * 队列上限防止 Helius 长时间不可用时无限堆积。
 */
const akbotRetryQueue: string[] = [];
const AKBOT_RETRY_MAX = 500;
let akbotRetryTimer: NodeJS.Timeout | null = null;
const AKBOT_RETRY_INTERVAL_MS = 30_000;

/**
 * 对一批买家跑轻量 AkBot 检测
 * - 跳过 mark === 'target' / 'own'
 * - 同地址只跑一次
 * - 命中后 markAsAkbot（幂等，池外地址也会 upsert 落标记）
 * - 顺序执行 + 150ms throttle（Helius free ~10 RPS，paid ~50 RPS）
 * - 熔断/限流导致没扫成的地址进 akbotRetryQueue，后台补扫
 *
 * 每个 event 5-20 个新买家 → 顺序执行 ≈ 1-3s。
 * 故意做成在 setImmediate 里调用，避免阻塞主流程（analyzeBlock / pool scan / 下一次事件）。
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
    await checkOneAddressForAkbot(addr);
    if (SLEEP_MS > 0) await new Promise((r) => setTimeout(r, SLEEP_MS));
  }

  // 有地址因熔断没扫成 → 起一个后台重试循环，熔断结束后自动补扫
  scheduleAkbotRetryDrain();
}

/** 扫一个地址并落标记；inconclusive 的地址进重试队列 */
async function checkOneAddressForAkbot(addr: string): Promise<void> {
  try {
    const res = await quickAkbotCheck(addr);
    if (res.status === 'found') {
      // markAsAkbot 返回 false = 该地址本来就已标记，别再刷一遍 detected 日志
      const wrote = await markAsAkbot(addr, res.evidence.signature, res.evidence.blockTime, res.evidence.slot);
      if (wrote) {
        console.log(
          `[webhook] akbot detected ${addr.slice(0, 8)}…${addr.slice(-4)} evidence=${res.evidence.signature.slice(0, 12)}…`,
        );
      }
    } else if (res.status === 'inconclusive') {
      enqueueAkbotRetry(addr, res.reason);
    }
    // status === 'clean'：扫完了确实不是 akbot，不用再管
  } catch (err) {
    // 单个地址失败不影响其它；同样入队，别让异常路径变成漏检
    console.warn(`[webhook] quickAkbotCheck ${addr.slice(0, 8)}… failed: ${(err as Error).message}`);
    enqueueAkbotRetry(addr, `error: ${(err as Error).message}`);
  }
}

function enqueueAkbotRetry(addr: string, reason: string): void {
  if (akbotRetryQueue.includes(addr)) return;
  if (akbotRetryQueue.length >= AKBOT_RETRY_MAX) {
    // 队列满：丢掉最老的一个，保证新地址还能进来
    akbotRetryQueue.shift();
  }
  akbotRetryQueue.push(addr);
  console.warn(
    `[webhook] akbot check inconclusive (${reason}), queued for retry ${addr.slice(0, 8)}… (${akbotRetryQueue.length} pending)`,
  );
}

function scheduleAkbotRetryDrain(): void {
  if (akbotRetryTimer || akbotRetryQueue.length === 0) return;
  akbotRetryTimer = setInterval(() => {
    if (akbotRetryQueue.length === 0) {
      if (akbotRetryTimer) clearInterval(akbotRetryTimer);
      akbotRetryTimer = null;
      return;
    }
    // 串行排空，一批最多 20 个，避免和实时检测撞在一起
    const batch = akbotRetryQueue.splice(0, 20);
    (async () => {
      for (let i = 0; i < batch.length; i++) {
        // 熔断还开着就整批放回队首，等下个周期，别浪费这一批
        if (isAkbotCircuitOpen()) {
          akbotRetryQueue.unshift(...batch.slice(i));
          return;
        }
        await checkOneAddressForAkbot(batch[i]);
      }
    })().catch((e) => console.warn('[webhook] akbot retry drain failed:', (e as Error).message));
  }, AKBOT_RETRY_INTERVAL_MS);
  // 别让重试定时器吊住进程退出
  if (typeof akbotRetryTimer.unref === 'function') akbotRetryTimer.unref();
}
