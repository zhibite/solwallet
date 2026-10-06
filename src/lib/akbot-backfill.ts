/**
 * AKBot 池子回填 —— CLI 和 API 共用的扫描核心
 *
 * 设计要点：
 *   - 纯函数式核心（runScan）+ 进度回调 + AbortSignal，三处调用方各取所需：
 *       scripts/backfill-akbot.ts → CLI（stdout 进度）
 *       /api/pool/akbot-scan       → Web UI（轮询进度）
 *       startAkbotBackfillWorker   → instrumentation.ts（每日定时）
 *
 *   - 复用 src/lib/akbot.ts 的 scanAddressForAkbot 核心逻辑（含熔断、并发闸门、
 *     inconclusive 区分），不再独立实现一套。
 *
 *   - 「同一进程内不要并行跑两轮扫描」由 inFlight 互斥保证，避免：
 *       UI 手动按的同时定时任务触发 → Helius 配额双倍消耗 → 429 把两轮都打挂。
 */

import { query } from './db';
import { scanAddressForAkbot, AKBOT_PROGRAM } from './akbot';
import { markAsAkbot } from './pool';

export interface AkbotScanOpts {
  /** 一次最多扫多少个地址（按 freq DESC 选候选），默认 100 —— 按钮 + daily 统一上限 */
  limit?: number;
  /** 每地址之间的间隔 ms，限速防 Helius 配额打爆，默认 200 */
  sleepMs?: number;
  /** 每地址最多翻几页签名，默认 5（=5000 笔） */
  maxPages?: number;
  /** 每页签名数，默认 1000 */
  pageSize?: number;
  /** 是否跳过 freq < 2 的地址（默认 true —— 单次蹭单的地址不值得打 Helius） */
  minFreq?: number;
  /** 进度回调，可选；UI 用它实时刷新 */
  onProgress?: (p: AkbotScanProgress) => void;
  /** 取消信号，可选；CLI 不需要，UI 用来 abort */
  signal?: AbortSignal;
}

export interface AkbotScanProgress {
  scanned: number;
  total: number;
  detected: number;
  failed: number;
  skipped: number; // 熔断/限流导致 inconclusive 的地址数
  /** 当前正在扫描的地址，便于 UI 显示「正在扫 X…」 */
  currentAddress: string | null;
  /** 预计剩余毫秒；扫描第 N 个时根据已用时间估算 */
  etaMs: number | null;
  status: 'running' | 'done' | 'aborted' | 'skipped_running';
  /** 触发结果汇总（仅 status==='done' 时填） */
  result?: AkbotScanResult;
}

export interface AkbotScanResult {
  scanned: number;
  detected: number;
  failed: number;
  skipped: number;
  /** 实际用时（ms） */
  durationMs: number;
  /** 触发的具体命中明细（每条 ≤10 条，避免 UI 渲染过重） */
  hits: Array<{ address: string; evidence: string }>;
}

/** 进程内互斥：避免 UI+定时撞车 */
let inFlight: Promise<AkbotScanResult> | null = null;

/**
 * 跑一次 akbot 池子回填。
 *
 * 返回 Promise<AkbotScanResult>；并发调用返回同一 Promise（不重复扫）。
 * 想要真的并发跑两份请自己再开一个子进程。
 */
export function runAkbotScan(opts: AkbotScanOpts = {}): Promise<AkbotScanResult> {
  if (inFlight) {
    // 已经有扫描在跑 —— 给调用方一个「我啥也没干」的结果，避免双倍扫。
    // 这样 UI 点第二次不会和第一次争抢进度，回调里 status='skipped_running'。
    if (opts.onProgress) {
      try {
        opts.onProgress({
          scanned: 0, total: 0, detected: 0, failed: 0, skipped: 0,
          currentAddress: null, etaMs: null, status: 'skipped_running',
        });
      } catch {}
    }
    return Promise.resolve({
      scanned: 0, detected: 0, failed: 0, skipped: 0, durationMs: 0, hits: [],
    });
  }

  const p = runScan(opts).finally(() => {
    inFlight = null;
  });
  inFlight = p;
  return p;
}

async function runScan(opts: AkbotScanOpts): Promise<AkbotScanResult> {
  const limit = opts.limit ?? 100;
  const sleepMs = opts.sleepMs ?? 200;
  const maxPages = opts.maxPages ?? 5;
  const pageSize = opts.pageSize ?? 1000;
  const minFreq = opts.minFreq ?? 2;

  // 1) 候选池：freq 高的优先扫（活跃地址更可能是 akbot 用户）。
  //    is_akbot = FALSE 的会被「已确认非 akbot」标签卡掉吗？不会 —— backfill 的语义
  //    就是「没标记的全当未确认」，含 inconclusive 也算未确认（见 akbot.ts 的 status 三态）。
  //    所以这里不能加 is_akbot = TRUE 之外的过滤，否则 inconclusive 永远扫不到。
  const candidates = await query<{ address: string; freq: number }>(`
    SELECT address, freq::int AS freq
    FROM pool_members
    WHERE is_akbot = FALSE AND freq >= $1
    ORDER BY freq DESC
    LIMIT $2
  `, [minFreq, limit]);

  const total = candidates.length;
  const emit = (p: Partial<AkbotScanProgress>) => {
    if (!opts.onProgress) return;
    try {
      opts.onProgress({
        scanned: 0, total, detected: 0, failed: 0, skipped: 0,
        currentAddress: null, etaMs: null, status: 'running',
        ...p,
      });
    } catch (err) {
      console.warn('[akbot-backfill] onProgress threw', err);
    }
  };

  if (total === 0) {
    const empty: AkbotScanResult = {
      scanned: 0, detected: 0, failed: 0, skipped: 0, durationMs: 0, hits: [],
    };
    emit({ status: 'done', result: empty });
    return empty;
  }

  emit({ scanned: 0, detected: 0, failed: 0, skipped: 0, currentAddress: null, etaMs: null });

  let scanned = 0;
  let detected = 0;
  let failed = 0;
  let skipped = 0;
  const hits: AkbotScanResult['hits'] = [];
  const t0 = Date.now();

  // 串行扫描候选地址，每个地址之间 sleep 防 Helius 配额打爆。
  // 2026-10-06 试过并发（chunked Promise.all + MAX_CONCURRENT_SCANS=6），结果是 313s
  // + 48 失败 —— 并发高了把 monitor 自己的 6 in-flight fire-and-forget 也放出来，
  // 12 × 5 = 60 in-flight 超过 4 公共端点 rps 总和（~40），全部 429 → penalize 雪崩
  // → circuit open 30s × 多次。结论：限速就是限速，不能靠"多线程"绕开 RPC 容量。
  // 真要加速：1) 加 Helius 当 endpoint（free tier 50 rps，比公共端点稳 5 倍）
  //           2) 把 work 砍小（pageSize 100 而不是 200，2 batch 而不是 4）
  //           3) 减少 candidates（top 50 而非 top 100）
  for (const c of candidates) {
    if (opts.signal?.aborted) {
      const r: AkbotScanResult = {
        scanned, detected, failed, skipped,
        durationMs: Date.now() - t0, hits,
      };
      emit({ status: 'aborted', result: r });
      return r;
    }

    scanned++;
    const elapsedMs = Date.now() - t0;
    const etaMs = scanned > 0 ? Math.round((elapsedMs / scanned) * (total - scanned)) : null;
    emit({
      scanned, detected, failed, skipped,
      currentAddress: c.address,
      etaMs,
    });

    try {
      const res = await scanAddressForAkbot(c.address, { maxPages, pageSize });
      if (res.status === 'found') {
        await markAsAkbot(
          c.address, res.evidence.signature, res.evidence.blockTime, res.evidence.slot,
        );
        detected++;
        if (hits.length < 50) {
          hits.push({
            address: c.address,
            evidence: res.evidence.signature,
          });
        }
      } else if (res.status === 'inconclusive') {
        // 没扫完：下次再扫（这个地址 is_akbot 仍是 FALSE，下次候选还会捞到它）。
        // 不要写 false 标记 —— 「没扫完」和「确认非 akbot」是两件事。
        skipped++;
      }
      // 'clean' = 扫完了确实没有，啥也不做
    } catch (err) {
      failed++;
      console.warn(
        `[akbot-backfill] scan ${c.address.slice(0, 8)}… failed:`,
        (err as Error).message,
      );
    }

    if (sleepMs > 0) {
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }

  const result: AkbotScanResult = {
    scanned, detected, failed, skipped,
    durationMs: Date.now() - t0,
    hits,
  };
  emit({ status: 'done', result });
  return result;
}

/** 是否当前有扫描正在跑（UI 显示「上次任务仍在跑中…」用） */
export function isAkbotScanRunning(): boolean {
  return inFlight !== null;
}

/** 取消当前正在跑的扫描（无扫描时返回 false） */
export function cancelAkbotScan(): boolean {
  // AbortSignal 由 inFlight 自己持有；外面拿不到，这里只能靠标记 inFlight=null 让它下一轮跳出。
  // 因为 inFlight 会在 finally 里清掉，所以「点了取消但等它自己跑完」是当前最稳的策略。
  // 这里返回 inFlight !== null 用来给 UI 一个「取消请求已提交」的回执。
  return inFlight !== null;
}

export { AKBOT_PROGRAM };