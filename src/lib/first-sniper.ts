/**
 * 第一个狙击者识别 & 跟随者分析
 * 给定某个目标地址的一笔 buy，找出同 slot 与下一 slot 内买入同 mint 的所有交易，
 * 然后识别第一个狙击者（最早买入的）、跟随者、自己账号。
 */

import type { BlockResponse } from '@solana/web3.js';
import { query, queryOne, execute } from './db';
import { runWithConcurrency } from './concurrency';
import { getHelius, parsedEventItemToEnhanced } from './helius';
import { getRPC } from './solana-rpc';
import { parseHeliusTx, parseBlockTxs, calcBuySol, findInboundTransfer, type ParsedBuy } from './parser';
import { calcCopyPnl } from './pnl';
// getEnrichableBuyerWithPrice 不再需要 —— 浮盈链路已整体下线（2026-10-15）。
import type { BlockBuyer } from './types';

// ============ 改动 1：slot 进度跟踪（替代盲目 getBlock 轮询）============
//
// 为什么：
//   - WS 通知在 'confirmed' 触发时，slot 经常刚被处理，getBlock 拿不到
//     （validator 节点还没把 block 落到 store）。
//   - 旧版靠指数退避硬轮询，最长 10s 浪费。getRPC().waitForSlotConfirmed()
//     用 onSlotChange 订阅链头进度，chainHead >= targetSlot 时立即返回，
//     几乎 0 延迟拿到 block（典型从 ~1-2s 降到 ~50ms）。
//   - 该方法内部已经处理：超时（timeoutMs 内没等到就 resolve false，
//     上层继续走原重试）、订阅失败兜底、订阅泄漏清理。
//
// 改动 3 联动：getBlock 结果按 slot 缓存，同 slot 的并发 / 后续请求直接复用。

// ============ 改动 3：按 slot 缓存 getBlock 结果 ============
//
// 为什么：
//   - 一个 slot 里通常有 N 笔不同目标的 buy 同时触发 analyzeBlock(slot, mint, ...)，
//     getBlock(slot) 是同一份 200-500ms 的 RPC 工作，重复打是浪费。
//   - Helius Enhanced 信息（H 带回来的）或别处也可能再次按 slot 拉全块。
//   - 给同一个 slot 的多次 analyze 复用第一次拉到的内存块，对前端抢单高峰期的
//     slot 突发尤其有用（典型场景：10 个目标地址的 buy 都落在同一个 slot 里）。
//
// 为什么 TTL 而非 LRU：
//   - Solana slot 在 ~12s 后就基本不再被查了（前端热点只会持续 1-2 波重查）。
//   - 60s TTL 既能覆盖同 slot 的 burst，也能让老 slot 自动过期释放内存。
//   - 简单实现胜过 LRU 的复杂度（这里不需要严格的容量上限）。
//
// 注意：
//   - 只缓存"成功返回的"块；null 结果不缓存（让下一次重试可以再次打 RPC）。
//   - 用 rpc.getBlock 拉到的就是 @solana/web3.js 的 BlockResponse，与已存的 type 兼容。
//   - 多个 analyzeBlock 命中同一 slot 时，复用 Promise 避免重复 in-flight 请求。
const BLOCK_CACHE_TTL_MS = 60_000;
type BlockCacheEntry = { block: BlockResponse; fetchedAt: number };
const blockCache = new Map<number, BlockCacheEntry>();
// in-flight 跟踪：同一 slot 的并发请求复用同一个 Promise
const blockInflight = new Map<number, Promise<BlockResponse | null>>();

function readBlockCache(slot: number): BlockResponse | null {
  const e = blockCache.get(slot);
  if (!e) return null;
  if (Date.now() - e.fetchedAt > BLOCK_CACHE_TTL_MS) {
    blockCache.delete(slot);
    return null;
  }
  return e.block;
}

function writeBlockCache(slot: number, block: BlockResponse): void {
  blockCache.set(slot, { block, fetchedAt: Date.now() });
}

export interface AnalyzeBuyer {
  blockIndex: number;
  offsetPos: number | null;     // 相对目标的块内位置差（同 slot），跨 slot 为 null
  offsetMs: number;             // 相对目标的时间偏移（ms）
  slotOffset: 0 | 1;            // 0 = 同 slot, 1 = 下一 slot
  signature: string;
  address: string;
  buySol: number;
  tipSol: number;
  prioLamports: number;
  /** 这笔买入收到的 token 数量；单笔跟单收益按它做 FIFO 配对 */
  tokenAmount: number | null;
  result: 'success' | 'failed';
  version: string;
  isBundled: boolean;
  hasAlt: boolean | null;
  bundleId: string | null;
  /** 0010: tip 渠道（null = 没付 tip；'unknown' = 付了但地址不在 4 通道列表里） */
  tipSource: import('./types').TipSource | null;
  mark: 'first_sniper' | 'target' | 'follower' | 'own' | 'pre_target';
  /** 0021: 狙击者竞争态势
   *  - mineRank:         我们 own wallet 在该 block 的 rank（NULL=非 own）
   *  - sniperSlotDelta:  相对目标 slot 的差（同=0，next=1，前置=-1）
   *  - competitorRank:   在同+next-slot 非 own 非 target 内的排名（NULL=不参与竞争）
   */
  mineRank: number | null;
  sniperSlotDelta: -1 | 0 | 1;
  competitorRank: number | null;
}

export interface AnalyzeResult {
  buyers: AnalyzeBuyer[];
  /** 目标 tx 在 block 内的位置索引（块内第 N 笔，从 0 开始） */
  targetBlockIndex: number | null;
  sameSlotCount: number;
  nextSlotCount: number;
  /** 0021: 狙击者竞争态势（块级）
   *  - competitorCount: 同 slot + 下一 slot 内非 own 非 target 的买家总数（无竞争者为 null）
   *  - chosenAddress:   系统选中的狙击者（默认 = first_sniper，可被决策逻辑覆盖）
   *  - competitorRank:  { address: rank }  每个竞争者的排名（1-based，rank=1 是最前的）
   */
  competitorCount: number | null;
  chosenAddress: string | null;
  competitorRank: Record<string, number> | null;
}

/**
 * 对一个目标交易做 block 级深度分析
 * - 同 slot 内买入同 mint 的所有交易
 * - 下一 slot 内买入同 mint 的交易（跟随者可能落在 slot+1）
 */
export async function analyzeBlock(slot: number, mint: string, targetSig: string): Promise<AnalyzeResult> {
  const rpc = getRPC();
  const helius = getHelius();

  // 0) 默认空结果
  const emptyResult: AnalyzeResult = {
    buyers: [],
    targetBlockIndex: null,
    sameSlotCount: 0,
    nextSlotCount: 0,
    competitorCount: null,
    chosenAddress: null,
    competitorRank: null,
  };

  // 1) 先获取目标交易详细信息（建立时间基准）
  let targetBlockTime = 0;
  let targetBuy = await fetchBuyBySig(targetSig);
  if (!targetBuy) {
    try {
      // 走 Helius Parsed Events → 公共 RPC 的 fallback（10 cr + 1 cr），避免 Helius 限流时拿不到目标 tx
      const enhanced = await helius.parseTransactionWithFallback(targetSig);
      if (enhanced) {
        targetBuy = parseHeliusTx(enhanced);
      }
    } catch {
      // 忽略
    }
  }
  if (targetBuy) {
    targetBlockTime = targetBuy.blockTime;
  }

  // 2) 拉取当前 slot 的交易
  const slotNum = Number(slot);

  // ── 辅助：带重试的 getBlock ──────────────────────────────────────────
  // 改动 1：先等链头推进到 targetSlot（getRPC().waitForSlotConfirmed），
  //         再调 getBlock。slot 已 confirmed 后再拉，几乎 0 等待。
  // 改动 3：getBlock 结果按 slot 缓存 + in-flight 复用，同 slot 的
  //         并发 / 后续请求直接复用第一次拉到的 BlockResponse。
  // 兜底仍然是 10s 硬超时，行为不会变差。
  const MAX_WAIT_MS = 10_000;

  async function getBlockWithRetry(targetSlot: number) {
    // 0) 命中缓存：秒返回
    const cached = readBlockCache(targetSlot);
    if (cached) return cached;

    // 1) 命中 in-flight：复用其他调用方正在拉的 Promise
    const inflight = blockInflight.get(targetSlot);
    if (inflight) return inflight;

    // 2) 新的拉取任务
    const fetchPromise = (async () => {
      // 改动 1：先等链头推进到 targetSlot。最长等 3s，到点就走原重试逻辑。
      //         行为完全兼容：waitForSlotConfirmed 超时返回 false，不阻塞。
      await rpc.waitForSlotConfirmed(targetSlot, Math.min(MAX_WAIT_MS, 3000)).catch(() => {});
      const start = Date.now();
      let attempt = 0;
      while (true) {
        attempt++;
        // getBlock 内部已有 Helius 限流退避 + free RPC fallback，直接用
        const b = await rpc.getBlock(targetSlot, { transactionDetails: 'full' });
        if (b) {
          writeBlockCache(targetSlot, b);
          return b;
        }
        const elapsed = Date.now() - start;
        if (elapsed >= MAX_WAIT_MS) {
          console.error(`[analyzeBlock] getBlock(${targetSlot}) timed out after ${elapsed}ms`);
          return null;
        }
        // 等 slot 确认（webhook 提前触发的场景）
        const wait = Math.min(500 * Math.pow(1.5, attempt - 1), 2000) + Math.random() * 200;
        await new Promise((r) => setTimeout(r, wait));
      }
    })();
    blockInflight.set(targetSlot, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      blockInflight.delete(targetSlot);
    }
  }

  // ── 拉取当前 slot ───────────────────────────────────────────────────
  const block = await getBlockWithRetry(slotNum);
  if (!block) return emptyResult;

  // 3) 解析出所有买入 mint 的 tx（同 slot）
  //    rpc.getBlock 返回的是 @solana/web3.js 的 BlockResponse（versioned transaction）
  //    parseBlockTxs 内部已经兼容（message 用 any），这里 cast 一下绕开 TS 结构差异
  const sameSlotBuys = parseBlockTxs(block as any, mint);

  // 4) 尝试拉取下一 slot 的交易（跟随者通常落在 slot+1）
  //    改动 3：slot+1 也走 getBlockWithRetry —— 复用同一 slot 的 in-flight / cache，
  //    并且 slot+1 通常还没确认，等链头推进到 slot+1+2 后再 getBlock 更稳。
  let nextSlotBuys: ParsedBuy[] = [];
  try {
    const nextBlock = await getBlockWithRetry(slotNum + 1);
    if (nextBlock) {
      nextSlotBuys = parseBlockTxs(nextBlock as any, mint);
    }
  } catch (err) {
    // 下一 slot 可能尚未确认/已跳过，静默失败
    console.warn('[analyzeBlock] getBlock next slot failed', err);
  }

  // 5) 用 Helius 补充 TIP / PRIO / buySol / tokenAmount
  //    改动 2：parseEvents（10 cr）和 batchFetchEnhanced（100 cr）并发跑，
  //    旧版串行总耗时 = A + B，现 = max(A, B)，单次省 300-800ms。
  //    失败语义保留：任一失败不会阻塞另一路；失败的签名落回 RPC 余额差。
  //    Enhanced Tx 端点单批上限 15 条签名，超出分批（200ms 间隔避免 Helius 限流）。
  const allRawBuys = [
    ...sameSlotBuys.map((b) => ({ ...b, _slot: slotNum })),
    ...nextSlotBuys.map((b) => ({ ...b, _slot: slotNum + 1 })),
  ];
  const sigs = allRawBuys.map((b) => b.signature);

  // 5a) 拉 Parsed Events（10 cr）—— 用于 tipSource / bundleId / address
  const parseEventsPromise: Promise<Map<string, NonNullable<ReturnType<typeof parseHeliusTx>>>> = (async () => {
    if (sigs.length === 0 || sigs.length > 100) return new Map();
    try {
      const eventItems = await helius.parseEvents(sigs);
      return new Map(
        eventItems
          .map((item) => {
            const enhanced = parsedEventItemToEnhanced(item);
            return enhanced ? ([enhanced.signature, parseHeliusTx(enhanced)] as const) : null;
          })
          .filter((entry): entry is readonly [string, NonNullable<ReturnType<typeof parseHeliusTx>>] => entry !== null),
      );
    } catch (err) {
      console.warn('[analyzeBlock] parsed-events parse failed, fall back to RPC only', err);
      return new Map();
    }
  })();

  // 5b) 拉 Enhanced Transactions（100 cr）—— 用于 buySol / tokenAmount
  //     <=15 一批；>15 分批（200ms 间隔）
  const batchEnhancedPromise: Promise<Map<string, { buySol: number; tokenAmount: number | null }>> = (async () => {
    const out = new Map<string, { buySol: number; tokenAmount: number | null }>();
    if (sigs.length === 0) return out;
    try {
      if (sigs.length <= 15) {
        const enhancedRawMap = await helius.batchFetchEnhanced(sigs);
        for (const [sig, tx] of enhancedRawMap) {
          const buySol = calcBuySol(tx);
          const tokenAmt = findInboundTransfer(tx)?.tokenAmount ?? null;
          out.set(sig, { buySol, tokenAmount: tokenAmt });
        }
      } else {
        for (let i = 0; i < sigs.length; i += 15) {
          const batch = sigs.slice(i, i + 15);
          const enhancedRawMap = await helius.batchFetchEnhanced(batch);
          for (const [sig, tx] of enhancedRawMap) {
            const buySol = calcBuySol(tx);
            const tokenAmt = findInboundTransfer(tx)?.tokenAmount ?? null;
            out.set(sig, { buySol, tokenAmount: tokenAmt });
          }
          if (i + 15 < sigs.length) await new Promise((r) => setTimeout(r, 200));
        }
      }
    } catch (err) {
      console.warn('[analyzeBlock] batchFetchEnhanced failed, buySol falls back to RPC', err);
    }
    return out;
  })();

  // 改动 2 核心：两路并发
  const [enhancedMap, enhancedBuySolMap] = await Promise.all([parseEventsPromise, batchEnhancedPromise]);

  // 6) 取自己的钱包列表
  const ownWallets = (await query<{ address: string }>('SELECT address FROM own_wallets')).map((w) => w.address);
  const ownSet = new Set(ownWallets);

  // 7) 合并并排序：同 slot 按块内执行位置（txIndex）升序，跨 slot 时同 slot 在前
  type Enriched = {
    buy: ParsedBuy;
    slot: number;
    slotOffset: 0 | 1;
    offsetMs: number;
    /** 块内真实执行位置（= wrapper 在 block.transactions 里的下标）。参考站口径。 */
    txIndex: number;
    /** 来自 Enhanced Transactions API 的 buySol，优先于 buy.buySol */
    buySolOverride?: number;
    /** 来自 Enhanced Transactions API 的 tokenAmount，优先于 buy.tokenAmount */
    tokenAmountOverride?: number | null;
  };
  const enriched: Enriched[] = allRawBuys.map((b) => {
    const e = enhancedMap.get(b.signature);
    // 优先用 Enhanced Transactions API 的 buySol 和 tokenAmount（来自 nativeTransfers / tokenTransfers）
    // 与参考网站口径一致；拿不到时 fallback 到 RPC 余额差（parseBlockTxs 结果）
    const buySolData = enhancedBuySolMap.get(b.signature);
    return {
      buy: e ?? b,
      slot: b._slot,
      slotOffset: b._slot === slotNum ? 0 : 1,
      offsetMs: targetBlockTime ? (b.blockTime - targetBlockTime) * 1000 : 0,
      // 始终保留 parseBlockTxs 写入的块内位置。Helius enhanced 路径不会带这个字段，
      // 即使 b.buy 被替换成 enhanced 解析结果，txIndex 仍然是块内真实位置。
      txIndex: b.txIndex ?? 0,
      buySolOverride: buySolData?.buySol,
      tokenAmountOverride: buySolData?.tokenAmount,
    };
  });

  // 同 slot 内按块内执行位置（txIndex）升序，跨 slot 时 slot 0 在前。
  //
  // 关键：之前用 blockTime 排序是错的。Solana 同一个 slot 里的所有交易共享
  // 同一个 Unix 秒（blockTime 是 slot 级时间戳，不是 tx 级），所以那层比较
  // 永远相等，最后 fallback 到 enriched 数组原顺序——也就是「同 mint buy 数组里」
  // 的位置，不是块内真实位置。busy slot 里有几十到几百笔非 buy tx 把 sniper
  // 往后挤，导致我们的 offset 看起来远大于参考站。
  //
  // 参考站口径：用 getBlock 返回的 transactions 数组下标（= 块内真实执行位置）
  // 当作 offset。txIndex 就是这个下标（parseBlockTxs 写入）。
  // Solana RPC 文档保证 getBlock 返回 transactions 顺序与块内处理顺序一致。
  const ordered = [...enriched].sort((a, b) => {
    if (a.slotOffset !== b.slotOffset) return a.slotOffset - b.slotOffset;
    return a.txIndex - b.txIndex;
  });

  // ── 8b) 补漏：如果目标交易不在 ordered 里（parseBlockTxs 因 postToken 漏报而丢失了它），
  //    从 enhancedMap / targetBuy 里把它补进去，按 slot + blockTime 插到正确位置。
  //
  //    触发条件：
  //      - targetBuy 存在（从 DB 或 Helius fallback 拿到了）
  //      - 但 targetSig 不在 ordered 中（parseBlockTxs 漏掉了）
  //
  //    位置规则：
  //      同 slot（slotOffset=0）：插到所有同 slot 已有条目之后、next-slot 条目之前，
  //                              在同 slot 内按 blockTime 升序排（blockTime 相同则 append）
  //      next slot（slotOffset=1）：插到所有 next-slot 条目之后
  //
  //    这补上了 postTokenBalances 漏报导致的 first_sniper 永远为 null 的根因。
  if (targetBuy && !ordered.some((e) => e.buy.signature === targetSig)) {
    // 防御：如果目标在 DB 里的 slot 与当前分析的 slot 不一致，
    // 说明 DB 数据可能不新鲜或被覆盖过，注入到错误 slot 会导致 target 被标成 follower。
    // 此时跳过注入（first_sniper 仍无法标记，但至少不会把 slot 信息搞乱）。
    // 防御：targetBuy.slot 来自 PG 的 BIGINT 列，pg 库解析成 BigInt，
    // slotNum 是 Number，类型不同直接 !== 永远返回 true（BigInt !== Number）。
    // 此处必须用 Number() 统一后再比较，勿删。
    if (Number(targetBuy.slot) !== slotNum) {
      console.warn(
        `[analyzeBlock] targetBuy slot mismatch: db=${targetBuy.slot}, analyzing=${slotNum}, skipping inject`,
      );
    } else {
      const targetSlotOffset: 0 | 1 = 0; // slot 相等时一定是 same slot
      const targetOffsetMs = targetBlockTime ? (targetBuy.blockTime - targetBlockTime) * 1000 : 0;
      // 注入目标在 block.transactions 里的真实下标未知（同 slot 内有多少非 buy tx 把目标挤到哪
      // 一步不可知）。给一个不影响排序的占位值：放在同 slot 最大 txIndex 之后。
      // mark / first_sniper 检测仍按 idx 走（见 9) 段），所以这个占位不影响狙击者识别，
      // 只是 injected 那笔自己的 offset_pos 会偏大（参考站同类场景也会这样）。
      const sameSlotMaxTx = ordered.reduce((m, e) => (e.slotOffset === 0 ? Math.max(m, e.txIndex) : m), 0);
      const injected: Enriched = {
        buy: enhancedMap.get(targetSig) ?? targetBuy,
        slot: targetBuy.slot,
        slotOffset: targetSlotOffset,
        offsetMs: targetOffsetMs,
        txIndex: sameSlotMaxTx + 1,
      };
      if (targetSlotOffset === 0) {
        // 同 slot：插到最后一个 slotOffset=0 条目之后
        const lastSameSlot = ordered.reduce<number>(
          (last, e, i) => (e.slotOffset === 0 ? i : last),
          -1,
        );
        ordered.splice(lastSameSlot + 1, 0, injected);
      } else {
        // next slot：append 到所有条目之后
        ordered.push(injected);
      }
    }
  }

  // 8) 找出目标的 block_index（= 块内真实执行位置，对应参考站 tx_index）
  const targetEntryIdx = ordered.findIndex((e) => e.buy.signature === targetSig);
  const targetTxIndex = targetEntryIdx >= 0 ? ordered[targetEntryIdx].txIndex : null;
  // targetBlockIndex 保留给 block_analyses 表（语义不变，= 目标在块内的位置）。
  // 同 slot 时就是 txIndex；target 跨 slot 时（极少见）置 null。
  const targetBlockIndex = targetTxIndex;

  // 9) 给每笔打标 + 计算 offsetPos
  //
  // first_sniper 语义：目标买入之后、ordered 数组里第一个非 target 的 buyer。
  // ordered 数组已按「同 slot 优先、块内 txIndex 升序」排好（= 参考站口径），
  // 所以「目标之后第一个」= ordered 数组里 idx > targetEntryIdx 的第一笔。
  // 这覆盖两个常见场景：
  //   - sniper bot 紧跟目标在同 slot 买（最常见，A4Ppe / Aox6K 都属此类）
  //   - sniper bot 跨 slot 立即在 slot+1 跟单（offset_ms 较小）
  let firstSniperMarked = false;
  const buyers: AnalyzeBuyer[] = ordered.map((e, idx) => {
    let mark: AnalyzeBuyer['mark'];
    if (e.buy.signature === targetSig) {
      mark = 'target';
    } else if (ownSet.has(e.buy.address)) {
      mark = 'own';
    } else if (e.slotOffset === 0 && targetEntryIdx >= 0 && idx < targetEntryIdx) {
      // 同 slot 内、目标之前
      mark = 'pre_target';
    } else {
      // 目标之后（同 slot 或下一 slot）：第一个非 target 标 first_sniper，其余 follower
      if (!firstSniperMarked) {
        mark = 'first_sniper';
        firstSniperMarked = true;
      } else {
        mark = 'follower';
      }
    }

    return {
      // blockIndex = 块内真实执行位置（不是「同 mint buy 数组里」的位置），
      // 对应参考站 tx_index / sniper_index。offset_pos = sniper.blockIndex - target.blockIndex。
      blockIndex: e.txIndex,
      offsetPos:
        e.slotOffset === 0 && targetTxIndex !== null ? e.txIndex - targetTxIndex : null,
      // offsetMs 计算口径：
      //   - 跨 slot (slotOffset=1)：用真实 ms（同 slot blockTime 差 ≈ slot duration ≈ 400ms），这是准确的
      //   - 同 slot (slotOffset=0)：真实 ms = 0（同一 slot 共享 blockTime），
      //     改为「块内位置差 × 5ms」的算术近似，与参考站量级（6~28ms）匹配。
      //     5ms/tx 是基于 Solana ~2-3k TPS / 400ms slot 推出的保守估计，
      //     实际处理时间可能更短（亚 ms），但能保证显示非零、与参考站观感一致。
      offsetMs: (() => {
        const realMs = Math.round(e.offsetMs);
        if (realMs > 0) return realMs;
        if (e.slotOffset === 0 && targetTxIndex !== null) {
          return Math.abs(e.txIndex - targetTxIndex) * 5;
        }
        return realMs;
      })(),
      slotOffset: e.slotOffset,
      signature: e.buy.signature,
      address: e.buy.address,
      // 优先用 Enhanced Transactions API 的 buySol（nativeTransfers 计算），与参考网站口径一致
      buySol: e.buySolOverride ?? e.buy.buySol,
      tipSol: e.buy.tipSol,
      prioLamports: e.buy.prioLamports,
      // 同样优先用 Enhanced API 的 tokenAmount（来自 tokenTransfers 中 toUserAccount=feepayer 的最大那笔）
      tokenAmount: e.tokenAmountOverride ?? e.buy.tokenAmount ?? null,
      result: e.buy.success ? 'success' : 'failed',
      version: e.buy.version,
      isBundled: e.buy.isBundled,
      hasAlt: e.buy.hasAlt ?? null,
      bundleId: e.buy.bundleId ?? null,
      tipSource: e.buy.tipSource ?? null,
      mark,
      // 0021: 狙击者竞争态势占位，下文（10 段）填真实值
      mineRank: null,
      sniperSlotDelta: e.slotOffset === 0 ? 0 : 1, // 默认 0/1；-1（前置）在「pre_target」分支里覆盖
      competitorRank: null,
    };
  });

  // ── 10) 狙击者竞争态势 ──────────────────────────────────────────────────
  //  参考站 list.e2.json 的口径：
  //   - competitor_count: 同一 slot + 下一 slot 内，与目标不同地址、非 own 的买家总数
  //   - competitor_rank:  在上述集合里按块内执行位置升序排名（rank=1 = 第一个买）
  //   - mine_rank:         我们 own wallet 的 rank（NULL = 不在 block 内 / 不是 own）
  //   - sniper_slot_delta:  买家相对目标 slot 的差；同=0、next=1、前置=-1
  //   - chosen_address:   系统选中的狙击者；默认 = first_sniper（首个非 own 非 target 的）
  //
  // 计算顺序：
  //   a) 拿到「目标之后、非 own、非 target」的子集（= 实际竞争者）
  //   b) 按 [slotOffset ASC, blockIndex ASC] 排，赋 competitor_rank
  //   c) 找 first_sniper（已通过 mark 标记好），赋 chosen_address
  //   d) 给 own_wallet 算 mine_rank
  //   e) pre_target 的 sniper_slot_delta = -1
  {
    // a) 竞争者集合：排除 target / own / pre_target
    const competitorIdx = buyers
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.mark !== 'target' && b.mark !== 'own' && b.mark !== 'pre_target');

    // b) 按「同 slot 优先、块内执行位置升序」排；这就是参考站 competitor_rank 口径
    const orderedCompetitors = [...competitorIdx].sort((a, c) => {
      if (a.b.slotOffset !== c.b.slotOffset) return a.b.slotOffset - c.b.slotOffset;
      return a.b.blockIndex - c.b.blockIndex;
    });

    // c+d+e) 回填
    const competitorRankMap: Record<string, number> = {};
    let chosenAddress: string | null = null;
    orderedCompetitors.forEach((entry, rank) => {
      const rk = rank + 1;
      buyers[entry.i].competitorRank = rk;
      competitorRankMap[entry.b.address] = rk;
      if (rk === 1) chosenAddress = entry.b.address;
    });

    // d) mine_rank：所有 own buyer 共享「在同+next-slot 内按块位置的排名」
    //    - 竞争者 + own 一起排 = 真实竞争态势（own 也是一名竞争者）
    //    - 多 own 钱包时：每个 own 都算 rank；通常只有一个
    const allRacers = buyers
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.mark === 'own' || b.mark === 'first_sniper' || b.mark === 'follower')
      .sort((a, c) => {
        if (a.b.slotOffset !== c.b.slotOffset) return a.b.slotOffset - c.b.slotOffset;
        return a.b.blockIndex - c.b.blockIndex;
      });
    allRacers.forEach((entry, rank) => {
      if (entry.b.mark === 'own') {
        buyers[entry.i].mineRank = rank + 1;
      }
    });

    // e) pre_target 的 sniper_slot_delta = -1
    for (const b of buyers) {
      if (b.mark === 'pre_target') b.sniperSlotDelta = -1;
    }

    // 写到当前闭包，return 时取出
    (buyers as any).__competitorCount = orderedCompetitors.length;
    (buyers as any).__chosenAddress = chosenAddress;
    (buyers as any).__competitorRankMap = competitorRankMap;
  }

  // targetBlockIndex 在注入逻辑（8b）后仍为 null 的唯一合理情况是：目标交易本身不在 same/next slot
  // （比如数据库里这笔记录是错的，或者目标根本没在这个 block 里）。此时 buyers 仍有值，
  // 但 first_sniper / offsetPos 无法正确计算。后续逻辑会将所有非目标标记为 follower。
  // 此处无需额外兜底。

  const sameSlotCount = buyers.filter((b) => b.slotOffset === 0).length;
  const nextSlotCount = buyers.filter((b) => b.slotOffset === 1).length;

  return {
    buyers,
    targetBlockIndex,
    sameSlotCount,
    nextSlotCount,
    competitorCount: (buyers as any).__competitorCount ?? null,
    chosenAddress: (buyers as any).__chosenAddress ?? null,
    competitorRank: (buyers as any).__competitorRankMap ?? null,
  };
}

/**
 * 把 first_sniper 回写到 target_trades
 *
 * 任何路径（实时 ingest / WebSocket / "重分析"按钮）跑完 analyzeBlock + saveBlockAnalysis
 * 之后，**必须**调这个函数回填 target_trades.first_sniper / offset，否则会出现
 * block_buyers.is_first_sniper = true 但 target_trades.first_sniper = null 的不一致：
 *   - L3 块详情（读 block_buyers）能看到 sniper
 *   - L1 行的 last_sniper、L2 行的第一个狙击者列（都读 target_trades）显示 "—"
 *
 * 历史上 /api/analyze/block 漏了这一步，是用户最常见的"明明展开了有，列表里没有"的原因。
 *
 * @param targetSig 目标交易签名（= target_trades.signature）
 * @returns { updated: boolean; sniper: AnalyzeBuyer | null }
 *   - updated=true  表示 target_trades 被 UPDATE（命中了一行）
 *   - updated=false 表示没找到 first_sniper 或 target_trades 里没这笔（幂等 noop）
 */
export async function applyFirstSniperToTarget(
  targetSig: string,
  result: AnalyzeResult,
): Promise<{ updated: boolean; sniper: AnalyzeBuyer | null }> {
  const sniper = result.buyers.find((b) => b.mark === 'first_sniper') ?? null;
  if (!sniper) {
    return { updated: false, sniper: null };
  }
  // 用 RETURNING 判断是否真的命中了 target_trades 行。
  // targetSig 不在表里（比如老监控/孤儿）时静默返回 updated=false，
  // 不抛错，避免把"重分析"流程整个搞挂。
  const rows = await query<{ signature: string }>(
    `UPDATE target_trades
        SET first_sniper = $1,
            first_sniper_buy_sol = $2,
            first_sniper_tip_sol = $3,
            first_sniper_prio_lamports = $4,
            first_sniper_signature = $5,
            first_sniper_offset_pos = $6,
            first_sniper_offset_ms = $7
      WHERE signature = $8
      RETURNING signature`,
    [
      sniper.address,
      sniper.buySol,
      sniper.tipSol,
      sniper.prioLamports,
      sniper.signature,
      sniper.offsetPos,
      sniper.offsetMs,
      targetSig,
    ],
  );
  return { updated: rows.length > 0, sniper };
}

/** 通过签名查 buy 信息（DB 优先） */
async function fetchBuyBySig(signature: string): Promise<ParsedBuy | null> {
  const row = await queryOne<any>(`
    SELECT signature, slot, block_time, target_address AS address, mint, buy_sol,
           target_tip_sol AS tip_sol, target_prio_lamports AS prio_lamports, 'success'::text AS success,
           target_token_amount AS token_amount,
           COALESCE(version, 'legacy') AS version, COALESCE(is_bundled, false) AS is_bundled,
           has_alt, bundle_id, '' AS source, tip_source
    FROM target_trades WHERE signature = $1
  `, [signature]);
  if (!row) return null;
  return {
    signature: row.signature,
    slot: row.slot,
    blockTime: Math.floor(new Date(row.block_time).getTime() / 1000),
    address: row.address,
    mint: row.mint,
    buySol: parseFloat(row.buy_sol),
    tipSol: parseFloat(row.tip_sol || '0'),
    prioLamports: parseInt(row.prio_lamports || '0', 10),
    tokenAmount: row.token_amount != null ? Number(row.token_amount) : null,
    fee: 0,
    version: row.version,
    isBundled: row.is_bundled,
    hasAlt: row.has_alt ?? null,
    bundleId: row.bundle_id ?? null,
    source: row.source,
    tipSource: row.tip_source ?? null,
    success: row.success === 'success',
  };
}

/** 将分析结果写入数据库 */
export async function saveBlockAnalysis(
  slot: number,
  mint: string,
  targetSig: string,
  blockTime: string,
  result: AnalyzeResult,
): Promise<number> {
  const { withTransaction } = await import('./db');
  return withTransaction(async (client) => {
    // upsert block_analyses（含 target_block_index / counts）
    //
    // 用 INSERT ... ON CONFLICT 一条语句完成，不要退回「先 SELECT 再 INSERT」：
    // 那样两个并发的 analyzeBlock 打到同一个 (slot, mint) 时会双双查到「不存在」，
    // 然后其中一个 INSERT 撞上 block_analyses_slot_mint_key 报 23505，
    // 整笔分析（含后面所有 block_buyers）一起回滚。并发时确实踩到过：
    //   键值"(slot, mint)=(453243779, DaUFkgZj…)" 已经存在
    //
    // ON CONFLICT DO UPDATE 在冲突行已存在时 RETURNING 会返回那一行的 id，
    // 所以「首次插入」和「覆盖已有分析」两条路径拿到的 analysisId 语义一致。
    const upserted = await client.query(
      `INSERT INTO block_analyses (
         slot, mint, target_signature, block_time,
         target_block_index, same_slot_count, next_slot_count,
         competitor_count, chosen_address, competitor_rank
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (slot, mint) DO UPDATE SET
         target_signature   = EXCLUDED.target_signature,
         block_time         = EXCLUDED.block_time,
         target_block_index = EXCLUDED.target_block_index,
         same_slot_count    = EXCLUDED.same_slot_count,
         next_slot_count    = EXCLUDED.next_slot_count,
         competitor_count   = EXCLUDED.competitor_count,
         chosen_address     = EXCLUDED.chosen_address,
         competitor_rank    = EXCLUDED.competitor_rank
       RETURNING id`,
      [
        slot,
        mint,
        targetSig,
        blockTime,
        result.targetBlockIndex,
        result.sameSlotCount,
        result.nextSlotCount,
        result.competitorCount,
        result.chosenAddress,
        JSON.stringify(result.competitorRank),
      ],
    );
    const analysisId: number = upserted.rows[0].id;

    // 买家明细整体重写（upsert 主记录之后无条件清空再插）
    await client.query('DELETE FROM block_buyers WHERE block_analysis_id = $1', [analysisId]);

    // 插入每个 buyer
    // bundle_size 统计：先插完所有 buyer，再统一回填（按 bundle_id 聚合）
    //
    // balance 探测（next_balance_check_at / balance_check_count）：每个 buyer 一入库就
    // 预约 1 分钟后的余额探测（详见 src/lib/balance-probe.ts）。
    //   - 失败买入（result='failed'）：token_amount 通常为 NULL，scheduleBalanceProbe
    //     会过滤掉；这里仍然写 NULL 保持一致
    //   - 成功买入：1 分钟后探测 token 余额，余额降了立即精算 PnL
    //   - ON CONFLICT (slot, signature) DO UPDATE 时也要重置探测时间
    //     （同一 sig 被 re-analyze 时，新一轮分析应当重新预约探测）
    const bundleIdCounts = new Map<string, number>();
    for (const b of result.buyers) {
      await client.query(
        `INSERT INTO block_buyers (
           block_analysis_id, slot, block_index, offset_pos, offset_ms, slot_offset,
           signature, address, buy_sol, tip_sol, prio_lamports, token_amount,
           is_first_sniper, is_follower, is_own, is_pre_target,
           result, version, is_bundled,
           has_alt, bundle_id, tip_source,
           mine_rank, sniper_slot_delta, competitor_rank,
           next_balance_check_at, balance_check_count
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
         ON CONFLICT (slot, signature) DO UPDATE SET
           block_analysis_id = EXCLUDED.block_analysis_id,
           block_index      = EXCLUDED.block_index,
           offset_pos       = EXCLUDED.offset_pos,
           offset_ms        = EXCLUDED.offset_ms,
           slot_offset      = EXCLUDED.slot_offset,
           address          = EXCLUDED.address,
           buy_sol          = EXCLUDED.buy_sol,
           tip_sol          = EXCLUDED.tip_sol,
           prio_lamports    = EXCLUDED.prio_lamports,
           token_amount     = EXCLUDED.token_amount,
           is_first_sniper  = EXCLUDED.is_first_sniper,
           is_follower      = EXCLUDED.is_follower,
           is_own           = EXCLUDED.is_own,
           is_pre_target    = EXCLUDED.is_pre_target,
           result           = EXCLUDED.result,
           version          = EXCLUDED.version,
           is_bundled       = EXCLUDED.is_bundled,
           has_alt          = EXCLUDED.has_alt,
           bundle_id        = EXCLUDED.bundle_id,
           tip_source       = EXCLUDED.tip_source,
           mine_rank        = EXCLUDED.mine_rank,
           sniper_slot_delta = EXCLUDED.sniper_slot_delta,
           competitor_rank  = EXCLUDED.competitor_rank,
           next_balance_check_at = EXCLUDED.next_balance_check_at,
           balance_check_count   = EXCLUDED.balance_check_count`,
        [
          analysisId,
          b.slotOffset === 0 ? slot : slot + 1,
          b.blockIndex,
          b.offsetPos,
          b.offsetMs,
          b.slotOffset,
          b.signature,
          b.address,
          b.buySol,
          b.tipSol,
          b.prioLamports,
          b.tokenAmount,
          b.mark === 'first_sniper',
          b.mark === 'follower',
          b.mark === 'own',
          b.mark === 'pre_target',
          b.result,
          b.version,
          b.isBundled,
          b.hasAlt,
          b.bundleId,
          b.tipSource,
          b.mineRank,
          b.sniperSlotDelta,
          b.competitorRank,
          // 仅成功买入 + 拿到 token_amount 才设探测时间；其余 buyer 留 NULL
          b.result === 'success' && b.tokenAmount != null && Number(b.tokenAmount) > 0
            ? new Date(Date.now() + 60_000)
            : null,
          0,
        ],
      );
      if (b.bundleId) {
        bundleIdCounts.set(b.bundleId, (bundleIdCounts.get(b.bundleId) ?? 0) + 1);
      }
    }
    // 回填每个 bundle_id 的 size
    // 限定 block_analysis_id 是对的：同一 jito bundle 必然落在同一 slot，
    // 因而必然落在同一 block_analyses；不同 block_analyses 的同 bundle_id 一定是误判或数据污染。
    for (const [bid, cnt] of bundleIdCounts) {
      await client.query(
        `UPDATE block_buyers SET bundle_size = $1 WHERE bundle_id = $2 AND block_analysis_id = $3`,
        [cnt, bid, analysisId],
      );
    }
    return analysisId;
  });
}

/** 从 DB 读出 block 分析 */
export async function getBlockAnalysis(slot: number, mint: string): Promise<{
  analysis: { id: number; slot: number; mint: string; target_signature: string; block_time: string; target_block_index: number | null; same_slot_count: number; next_slot_count: number };
  buyers: BlockBuyer[];
} | null> {
  const a = await queryOne<any>('SELECT * FROM block_analyses WHERE slot = $1 AND mint = $2', [slot, mint]);
  if (!a) return null;
  const buyers = await query<BlockBuyer>(
    'SELECT * FROM block_buyers WHERE block_analysis_id = $1 ORDER BY block_index ASC',
    [a.id],
  );
  return { analysis: a, buyers };
}

/**
 * 批量算一个 block 里所有 buyer 的跟单收益，并行跑 + 写回 DB。
 *
 * 用途：UI 展开 block 时一次算完所有 buyer，不用每个点"算收益"。
 * 设计：
 *   - 并发度受 BULK_PNL_CONCURRENCY 控制（默认 8），见下方 429 说明
 *   - 单个 buyer 失败不影响其他（catch 内 swallow + 标 'error'）
 *   - 返回结果与原 buyer 列表长度一致，按 buyer.id 顺序对齐
 *
 * 429 / 限流防御（天然处理，不需要在这里写）：
 *   - fetchTxViews 命中 Helius 429 会自动 fallback 到 RPC 路径，并把 _heliusDead 置 true，
 *     后续 buyer 全程走 RPC，避免 Helius 雪崩。
 *   - 显式并发回落只在跑出来仍慢得受不了时再用环境变量 BULK_PNL_CONCURRENCY 调小（4 / 2）。
 *
 * 性能参考（实测）：
 *   - 20 笔 buyer × calcCopyPnl(每笔 ~1-2s，FIFO 加 10 分钟窗口后) ÷ 8 并发 ≈ 5-10s
 *   - 1 分钟内清仓的 sniper 单笔耗时 < 1s（chunk=1 即 break），整批 < 5s
 *   - 之后再访问同一个 block 直接走 DB 缓存，秒开
 */
export interface BulkBuyerPnLProgress {
  done: number;
  total: number;
}

export interface BulkBuyerPnLResult {
  buyerId: number;
  pnlSol: number | null;
  status: 'closed' | 'partial' | 'open' | 'buy_failed' | 'error';
  soldRatio: number | null;
}

// 默认并发 3（不是 8）：
//   - 实测 Helius free tier 50 rps，8 路并发买 6 路 fetchTxViews 子并发 = 48 路 RPC in-flight，
//     撞 429 是常态（compute-pnl 跑 6 分钟过不了 1 个 block 就是这个）。
//   - 3 路并发买 6 子并发 = 18 路 in-flight，单端点 rps 足够吃下，
//     配合 multi-rpc.ts 端点合并修复（5 端点 round-robin）后几乎不会 429。
//   - 想更激进：环境变量 BULK_PNL_CONCURRENCY=6 / 8，但要确认 5 个端点都健康。
//   - 想更保守：=2（保守，1 个 block 内全走完往往要 5-10 分钟）。
const BULK_PNL_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.BULK_PNL_CONCURRENCY || '3', 10),
);

/**
 * 把 N 个 task 按并发上限执行，onProgress 每完成一个回调一次。
 *
 * 实现已统一抽到 ./concurrency.ts（与 analyze 路由等模块共享）。
 * 这里保留签名 + 行为：结果数组按入参下标对齐；异常向上抛，由 worker 自己 try/catch。
 *
 * 429/限流防御（不需要在本函数里写）：
 *   - 单个 worker 命中 Helius 429 时由 tx-source.ts 的 fetchTxViews 自动 fallback 到 RPC 路径，
 *     并把 _heliusDead 设为 true，后续 buyer 自动全走 RPC，避免 Helius 雪崩。
 *   - 显式的并发回落只在跑出来实际慢得受不了时再用环境变量 BULK_PNL_CONCURRENCY 改小。
 */

/**
 * 一次性算 block 里所有 buyer 的 PnL，写回 block_buyers。
 * 已经算过（pnl_status 非空）的会跳过 —— 用户点过"算收益"的会保留。
 *
 * 用法：被 /api/block/[slot]/[mint]/pnl POST 调用
 */
export async function computeBulkBuyerPnL(
  slot: number,
  mint: string,
  opts: { force?: boolean; onProgress?: (p: BulkBuyerPnLProgress) => void } = {},
): Promise<{ results: BulkBuyerPnLResult[]; analysis: any; skippedExisting: number }> {
  const got = await getBlockAnalysis(slot, mint);
  if (!got) return { results: [], analysis: null, skippedExisting: 0 };
  const { analysis, buyers } = got;

  // 决定哪些需要重算：
  //   - 我的账号 / 第一个狙击者：永远算（开发者自己账户 + 狙击单，最关键）
  //   - 跟单者（follower / pre_target）：第一次进入（pnl_status NULL）时跑；
  //     之后 pnl_status='open' 的：没卖出 = 没 realized = 跑也是白跑，
  //     直接跳过（2026-10-15 砍掉浮盈后，open 跟随单者没有浮盈兜底刷新，
  //     要 partial/closed 只能等用户手动点 /api/.../buyer/[id]/pnl）。
  //   - 目标账号（target）：不参与 cron 计算——选目标时已人工确认盈利，
  //     重复算既浪费 RPC 也不产生业务价值（系统关注的是跟单者和狙击者的 tip/优先费/净盈利）。
  //     单点重算仍可走 /api/block/[slot]/[mint]/buyer/[id]/pnl 覆盖。
  //   - 失败 tx：跳过（pnl_status='buy_failed' 已经写死了）
  //   - pnl_status='stale'：cron 已主动放弃（>2h 仍 NULL），不再重算
  const toCompute = buyers.filter((b) => {
    if (opts.force) return true;
    if (b.result === 'failed') return false; // 买入失败，pnl 固定就是手续费
    // 目标账号不参与 cron 计算（见上方注释）
    if (b.signature === analysis.target_signature) return false;
    if (b.is_own || b.is_first_sniper) return true;
    if (!b.pnl_status) return true;
    // follower / pre_target 在 open 状态：没卖出 = 无 realized = 纯浪费
    if (b.pnl_status === 'open' && b.token_amount && Number(b.token_amount) > 0) return false;
    return false; // 其他（closed/partial/stale）跳过
  });
  const skippedExisting = buyers.length - toCompute.length;

  if (toCompute.length === 0) {
    return { results: [], analysis, skippedExisting };
  }

  const blockTime = Math.floor(new Date(analysis.block_time).getTime() / 1000);

  const results = await runWithConcurrency(
    toCompute,
    BULK_PNL_CONCURRENCY,
    async (buyer): Promise<BulkBuyerPnLResult> => {
      try {
        const tokenAmount =
          buyer.token_amount != null ? Number(buyer.token_amount) : null;
        const r = await calcCopyPnl({
          mint,
          buySig: buyer.signature,
          buyWallet: buyer.address,
          buySol: parseFloat(String(buyer.buy_sol)),
          buyBlockTime: blockTime,
          buyTokenAmount: tokenAmount,
        });
        // 写回 DB：只写 4 个 pnl 字段 + token_amount 兜底。
        // 0020 浮盈 4 列不再触碰（保持上次值或 NULL），monitor.ts / ws-monitor.ts 也不再触发 prefill。
        await execute(
          `UPDATE block_buyers
              SET pnl_sol          = $1,
                  pnl_status       = $2,
                  pnl_sold_ratio   = $3,
                  token_amount     = COALESCE($4, token_amount)
            WHERE id = $5`,
          [r.pnlSol, r.status, r.soldRatio, tokenAmount, buyer.id],
        );
        return {
          buyerId: buyer.id,
          pnlSol: r.pnlSol,
          status: r.status,
          soldRatio: r.soldRatio,
        };
      } catch (err: any) {
        console.warn(`[bulk-pnl] buyer ${buyer.id} 失败:`, err?.message ?? err);
        return {
          buyerId: buyer.id,
          pnlSol: null,
          status: 'error' as const,
          soldRatio: null,
        };
      }
    },
    (done, total) => opts.onProgress?.({ done, total }),
  );

  return { results, analysis, skippedExisting };
}

