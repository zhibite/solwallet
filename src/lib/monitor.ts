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
import { getHelius, isHeliusConfigured, parsedEventItemToEnhanced, type ParsedEventItem } from './helius';
import { getMultiRpc } from './multi-rpc';
import { parseHeliusTx } from './parser';
import { saveBlockAnalysis } from './first-sniper';
import { quickAkbotCheck, isAkbotCircuitOpen } from './akbot';
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
  // 解析（parseTransaction）现在走 Helius Parsed Events（10 cr/batch），
  // 比旧的 Enhanced Transactions（100 cr/batch）便宜 10 倍
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
      if (sigs.length === 0) continue;

      // 1) 过滤 s.err（RPC 已标记失败，没必要再去 Helius 解析一次）
      const goodSigs = sigs.filter((s) => !s.err);
      if (goodSigs.length === 0) continue;

      // 2) 一次 SELECT ANY 查重（替代原来的 per-sig SELECT，DB 调用量降到 1/N）
      const existingRows = await query<{ signature: string }>(
        'SELECT signature FROM target_trades WHERE signature = ANY($1::text[])',
        [goodSigs.map((s) => s.signature)],
      );
      const existingSet = new Set(existingRows.map((r) => r.signature));
      const toParse: Array<{ signature: string; blockTime: number }> = [];
      for (const s of goodSigs) {
        if (existingSet.has(s.signature)) continue;
        toParse.push({ signature: s.signature, blockTime: s.blockTime });
      }
      if (toParse.length === 0) continue;

      // 3) 批量解析（一发入 Helius，10 cr/request，与签名数无关）
      //    替代原来的 per-sig parseTransactionWithFallback：HTTP 请求数从 N 降到 1，
      //    Helius 配额消耗从 ~10N cr 降到 ~10 cr（18x 节省）；
      //    失败回退到公共 RPC 单笔解析被砍掉——批量回退等于批量劣化回原状，整批重试让
      //    DB 主键去重 + 下轮轮询（默认 5s）兜底，单次 429 只会让整批延迟一轮，无数据丢失。
      let parsedItems: ParsedEventItem[];
      try {
        parsedItems = await helius.parseEvents(toParse.map((p) => p.signature));
      } catch (perr: any) {
        const status = perr?.response?.status ?? perr?.status;
        if (status === 429) {
          // 整批限流 → 整批跳过，DB 主键去重保证下轮会重扫到同一批 sigs
          console.warn(
            `[monitor] Helius 429 on target ${t.address.slice(0, 8)}… — skip batch of ${toParse.length} sigs, retry next poll`,
          );
        } else {
          // 其它错误（5xx/网络）也直接跳过本批，下轮重试
          console.warn(
            `[monitor] parseEvents batch failed on target ${t.address.slice(0, 8)}…: ${perr?.message ?? perr}`,
          );
        }
        continue;
      }

      // 顺序与请求一致。长度不一致（Helius 截断/重复响应）→ 尾部 sigs 下轮重扫，DB 主键去重兜底
      if (parsedItems.length !== toParse.length) {
        console.warn(
          `[monitor] parseEvents length mismatch: requested ${toParse.length} got ${parsedItems.length} on target ${t.address.slice(0, 8)}… — trailing sigs re-fetched next poll`,
        );
      }

      // 4) 顺序与请求一致，逐个适配 → parseHeliusTx → threshold → 入库
      let recordedCount = 0; // 本轮实际入 buy 的数量
      let recordedBlockTime: number | null = null; // 最近一笔被记录的 buy 的 blockTime
      for (let i = 0; i < parsedItems.length; i++) {
        const item = parsedItems[i];
        const meta = toParse[i];
        if (!item || !meta) continue;
        // parserStatus === 'ERROR' → 单笔解析失败，跳过这一笔，其他正常（留 warn 便于排查）
        if (item.parserStatus !== 'OK' || !item.parsed) {
          console.warn(
            `[monitor] parseEvents item failed: ${meta.signature.slice(0, 12)}… parserStatus=${item.parserStatus} on target ${t.address.slice(0, 8)}…`,
          );
          continue;
        }
        const tx = parsedEventItemToEnhanced(item);
        if (!tx) continue;
        const buy = parseHeliusTx(tx);
        if (!buy) continue;
        if (buy.buySol < parseFloat(t.threshold_sol)) continue;

        // 写库
        await ingestTargetTrade(t.id, buy, tx);
        recordedCount++;
        // 用被录入的那笔的 blockTime，没拿到就用签名列表的 blockTime
        recordedBlockTime = (buy.blockTime && buy.blockTime > 0) ? buy.blockTime : meta.blockTime;
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
               first_sniper_offset_pos = $7,
               first_sniper_offset_ms = $8
           WHERE signature = $6`,
          [
            sniper.address,
            sniper.buySol,
            sniper.tipSol,
            sniper.prioLamports,
            sniper.signature,
            buy.signature,
            sniper.offsetPos,
            sniper.offsetMs,
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
      //    各跑一次 quickAkbotCheck（最近 200 签名），命中即标记。
      //    顺序执行 + 150ms throttle 防止 Helius 速率限制；
      //    再套一层 setImmediate 做到真正 fire-and-forget —— 不阻塞下一次 analyzeBlock/pool scan。
      //    （webhook 突发时，analyzeBlock 不会因 akbot 排队而堆积。）
      //    被熔断/限流打断的地址由 scheduleAkbotChecksForBuyers 内部的
      //    akbotRetryQueue 补扫，不会因为离开这个 block 就丢失。
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
          `[monitor] akbot detected ${addr.slice(0, 8)}…${addr.slice(-4)} evidence=${res.evidence.signature.slice(0, 12)}…`,
        );
      }
    } else if (res.status === 'inconclusive') {
      enqueueAkbotRetry(addr, res.reason);
    }
    // status === 'clean'：扫完了确实不是 akbot，不用再管
  } catch (err) {
    // 单个地址失败不影响其它；同样入队，别让异常路径变成漏检
    console.warn(`[monitor] quickAkbotCheck ${addr.slice(0, 8)}… failed: ${(err as Error).message}`);
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
    `[monitor] akbot check inconclusive (${reason}), queued for retry ${addr.slice(0, 8)}… (${akbotRetryQueue.length} pending)`,
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
    })().catch((e) => console.warn('[monitor] akbot retry drain failed:', (e as Error).message));
  }, AKBOT_RETRY_INTERVAL_MS);
  // 别让重试定时器吊住进程退出
  if (typeof akbotRetryTimer.unref === 'function') akbotRetryTimer.unref();
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
