/**
 * AKBot 用户识别模块
 *
 * 背景：
 *   AKBot 是 memecoin sniper 常用的"一键卖币"工具。
 *   所有 akbot 用户在 sell 时都走同一合约：
 *     AKbotMAGJmYPwV8z55Lqiqgijt2KcjLeFGue5sw1noHM
 *   因此只要一个地址发起的任意交易（含 inner instructions）调用过该 program，
 *   就可以判定该地址是 akbot 用户。
 *
 * 调用方式：
 *   - 实时：在 pnl.ts / monitor.ts 解析 sell tx 时立即调用 isAkbotTx()
 *   - 批量回填：scripts/backfill-akbot.ts 走 scanAddressForAkbot() 全扫
 *
 * 注意：
 *   检测是单向、不可逆的。一旦标记 is_akbot=true 就保留（避免误清）。
 *   未来如果要支持"取消标记"，需要人工 + Solscan 复核，不要靠脚本自动清。
 */

import { getHelius } from './helius';
import { getMultiRpc } from './multi-rpc';
import type { HeliusEnhancedTx } from './types';

/** AKBot 卖币合约地址（所有 akbot 用户 sell 都走这个 program） */
export const AKBOT_PROGRAM = 'AKbotMAGJmYPwV8z55Lqiqgijt2KcjLeFGue5sw1noHM';

/**
 * 判断一笔 Helius 增强交易（含 innerInstructions）是否调用了 AKBot 合约
 */
export function isAkbotTx(tx: HeliusEnhancedTx | null | undefined): boolean {
  if (!tx) return false;
  const ixs = tx.instructions ?? [];
  for (const ix of ixs) {
    if (ix.programId === AKBOT_PROGRAM) return true;
    const inner = ix.innerInstructions;
    if (Array.isArray(inner)) {
      for (const item of inner) {
        // Helius inner instruction 形状：{ programId, accounts, data, ... }
        const innerIx = item as { programId?: string };
        if (innerIx.programId === AKBOT_PROGRAM) return true;
      }
    }
  }
  return false;
}

export interface AkbotEvidence {
  signature: string;
  blockTime: number;
  slot: number;
}

/**
 * 扫描一个地址最近 N 笔签名（分页），找最近一笔调用 AKBot 合约的 tx。
 *
 * 参数：
 *   maxPages  默认 5（= 最多 5000 笔签名）；活跃地址够用，老 tx 靠后续实时 hook 补
 *   pageSize  默认 1000
 *
 * 返回：第一笔（newest-first）命中的证据；找不到返回 null
 *
 * 用法：
 *   - 默认（5000 签名）—— 适合一次性回填
 *   - 显式 maxPages=1 pageSize=200 —— 适合实时 hot path（见 quickAkbotCheck）
 */
export function scanAddressForAkbot(
  address: string,
  opts: { maxPages?: number; pageSize?: number } = {},
): Promise<AkbotEvidence | null> {
  return scanAddressForAkbotCore(address, opts);
}

/**
 * 轻量版：仅扫最近 1 页（默认 200 笔签名），用于实时 hook（每次监控触发的批量扫描）
 *
 * 200 笔签名 ≈ 活跃地址最近 1-3 天，对实时识别 akbot 用户已足够；
 * 未命中的地址会再次进入监控时再扫，或交给 scripts/backfill-akbot.ts 全量兜底。
 *
 * 命中即返回；不命中返回 null
 */
export function quickAkbotCheck(address: string): Promise<AkbotEvidence | null> {
  return scanAddressForAkbotCore(address, { maxPages: 1, pageSize: 200 });
}

/**
 * Helius 并发闸门 + 429 熔断
 *
 * 为什么需要：监控侧用 setImmediate fire-and-forget 触发扫描，没有任何背压。
 * block 密集时会同时叠出几十条扫描链，每条链按 100 笔一批打 Helius，结果就是配额
 * 被打爆（429），而在途的 promise 和 axios 错误对象（带 request/response 引用）会
 * 持续堆积 —— 这是 dev server 堆涨到 8GB 溢出的直接原因。
 *
 * 两道闸：
 *   1) 并发上限 —— 同时最多 MAX_CONCURRENT_SCANS 条链，其余排队（而不是一起冲出去）
 *   2) 429 熔断 —— 命中一次 429 就全局暂停 BREAK_AFTER_429_MS，期间直接返回 null，
 *      不再打 Helius；下一轮监控自然会重试未命中的地址
 */
const MAX_CONCURRENT_SCANS = 2;
const BREAK_AFTER_429_MS = 30_000;

let inFlight = 0;
let circuitOpenUntil = 0;
const queue: Array<() => void> = [];

function isCircuitOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}

function tripCircuit(): void {
  const until = Date.now() + BREAK_AFTER_429_MS;
  // 只延后不提前关断，避免并发的多条链把熔断窗口互相顶掉
  if (until > circuitOpenUntil) circuitOpenUntil = until;
  console.warn(`[akbot] Helius 429，熔断 ${BREAK_AFTER_429_MS / 1000}s`);
}

async function acquireScanSlot(): Promise<void> {
  if (inFlight < MAX_CONCURRENT_SCANS) {
    inFlight++;
    return;
  }
  // 满了就排队。名额由 releaseScanSlot 直接移交给这里，所以醒来后不再自增 ——
  // 否则 release 的 inFlight-- 与新调用者之间会有个窗口，被抢走名额后导致超发。
  await new Promise<void>((resolve) => queue.push(resolve));
}

function releaseScanSlot(): void {
  const next = queue.shift();
  if (next) {
    next(); // 槽位移交，inFlight 保持不变
  } else {
    inFlight--;
  }
}

async function scanAddressForAkbotCore(
  address: string,
  opts: { maxPages?: number; pageSize?: number },
): Promise<AkbotEvidence | null> {
  // 防御：空地址 / 太短地址直接返回，避免打到 Helius 报错
  if (!address || typeof address !== 'string' || address.length < 32) return null;
  // 熔断期内直接放弃：本次不下结论，交给下一轮监控重试
  if (isCircuitOpen()) return null;

  await acquireScanSlot();
  try {
    return await doScanAddressForAkbot(address, opts);
  } finally {
    releaseScanSlot();
  }
}

async function doScanAddressForAkbot(
  address: string,
  opts: { maxPages?: number; pageSize?: number },
): Promise<AkbotEvidence | null> {
  const helius = getHelius();
  const rpc = getMultiRpc();
  const pageSize = Math.min(opts.pageSize ?? 1000, 1000); // 上限保护
  const maxPages = Math.min(opts.maxPages ?? 5, 20);        // 上限保护（≤ 20000 sigs）

  // 1) 分页拉签名（newest-first）—— 公开 RPC，走多源轮询省 Helius 配额
  const allSigs: Array<{ signature: string }> = [];
  const seenSigs = new Set<string>();
  let before: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    // before 必须真的传下去：漏传的话每一页都拉回同一批「最新 pageSize 条」，
    // 白跑 maxPages-1 次 RPC，还让后面的 Helius 批量解析对着同一批签名重复打 5 遍，
    // 极易把自己打进 429。seenSigs 再兜一层，防止分页边界重叠。
    const batch = await rpc.getSignaturesForAddress(address, pageSize, before);
    if (!batch || batch.length === 0) break;
    for (const s of batch) {
      if (seenSigs.has(s.signature)) continue;
      seenSigs.add(s.signature);
      allSigs.push(s);
    }
    if (batch.length < pageSize) break;
    before = batch[batch.length - 1].signature;
  }
  if (allSigs.length === 0) return null;

  // 2) 分批解析（Helius 一次最多 ~100 笔更稳）
  for (let i = 0; i < allSigs.length; i += 100) {
    const slice = allSigs.slice(i, i + 100).map((s) => s.signature);
    try {
      const enhancedList = await helius.parseTransactions(slice);
      for (const tx of enhancedList) {
        if (isAkbotTx(tx)) {
          return {
            signature: tx.signature,
            blockTime: tx.blockTime,
            slot: tx.slot,
          };
        }
      }
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 429) {
        // 429 之后继续打下一批只会接着 429：既白烧配额又加深堆积。
        // 直接放弃这个地址剩下的批，熔断交给外层的闸门处理。
        tripCircuit();
        return null;
      }
      // 单批解析失败不影响下一批；最后没找到自然返回 null
      console.warn('[akbot] parseTransactions batch failed:', (err as Error).message);
    }
  }
  return null;
}