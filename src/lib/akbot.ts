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

import { getMultiRpc } from './multi-rpc';
import type { HeliusEnhancedTx } from './types';

/** AKBot 卖币合约地址（所有 akbot 用户 sell 都走这个 program） */
export const AKBOT_PROGRAM = 'AKbotMAGJmYPwV8z55Lqiqgijt2KcjLeFGue5sw1noHM';

/**
 * 检查一笔原始 RPC tx（json 编码，含 meta.innerInstructions）是否调用过 AKBot 程序。
 *
 * 不需要把整笔 tx 适配成 Helius 形状 —— akbot 判定的全部信号就是「顶层 / 内层
 * 任意一条指令的 programId 等于 AKBOT_PROGRAM」。直接走 meta.innerInstructions 即可，
 * 避免走 solanaTxToHeliusEnhanced 的 token balance 计算 / 余额差法等 akbot 用不上的开销。
 *
 * 返回 true 即为 akbot 命中（被调用方写入 is_akbot=true）；返回 false 表示当前 tx 没痕迹，
 * 需继续扫下一页；抛错由调用方捕获。
 */
export function isAkbotTxFromRpc(tx: any): boolean {
  if (!tx || !tx.transaction) return false;
  // 顶层指令
  const topIxList = (tx.transaction.message?.instructions ?? []) as any[];
  for (const ix of topIxList) {
    const pid = resolveProgramId(ix, tx.transaction.message);
    if (pid === AKBOT_PROGRAM) return true;
  }
  // 内层指令（akbot 实际是被 Jupiter/CPMM 在 CPI 里调用，必走 inner）
  const inner = (tx.meta?.innerInstructions ?? []) as any[];
  for (const innerGroup of inner) {
    for (const ix of innerGroup.instructions ?? []) {
      const pid = resolveProgramId(ix, tx.transaction.message);
      if (pid === AKBOT_PROGRAM) return true;
    }
  }
  return false;
}

/** 解析一条 compiled instruction 的 programId，处理 string / PublicKey / index 三种形态 */
function resolveProgramId(ix: any, message: any): string | undefined {
  if (typeof ix.programId === 'string') return ix.programId;
  if (ix.programId && typeof ix.programId.toBase58 === 'function') return ix.programId.toBase58();
  if (typeof ix.programIdIndex === 'number') {
    const keys = message?.staticAccountKeys ?? message?.accountKeys ?? [];
    const k = keys[ix.programIdIndex];
    if (typeof k === 'string') return k;
    if (k && typeof k.toBase58 === 'function') return k.toBase58();
  }
  return undefined;
}

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
 * 扫描结果。
 *
 * 为什么不用 `AkbotEvidence | null`：
 *   熔断打开（429 保护期）和限流放弃这两种情况下，我们其实**没得出结论**，
 *   但如果都返回 null，上游无法把它和「扫完了，确实不是 akbot 用户」区分开，
 *   于是这些地址被当成「已排除」静默丢弃，且永不复查 —— 熔断 30s 窗口内
 *   密集 block 的场景会成片漏检。
 *
 * 判定规则：
 *   found        —— 扫完了，命中
 *   clean        —— 扫完了，确实没有 AKBot 痕迹（可以不再查这个地址）
 *   inconclusive —— 没扫完（熔断 / 429 / 参数非法），需要稍后重试
 */
export type AkbotCheckResult =
  | { status: 'found'; evidence: AkbotEvidence }
  | { status: 'clean' }
  | { status: 'inconclusive'; reason: string };

/**
 * 扫描一个地址最近 N 笔签名（分页），找最近一笔调用 AKBot 合约的 tx。
 *
 * 参数：
 *   maxPages  默认 5（= 最多 5000 笔签名）；活跃地址够用，老 tx 靠后续实时 hook 补
 *   pageSize  默认 1000
 *
 * 返回：AkbotCheckResult —— 用 status 区分「命中 / 干净 / 没结论」
 *
 * 用法：
 *   - 默认（5000 签名）—— 适合一次性回填
 *   - 显式 maxPages=1 pageSize=200 —— 适合实时 hot path（见 quickAkbotCheck）
 */
export function scanAddressForAkbot(
  address: string,
  opts: { maxPages?: number; pageSize?: number } = {},
): Promise<AkbotCheckResult> {
  return scanAddressForAkbotCore(address, opts);
}

/**
 * 轻量版：仅扫最近 1 页（默认 200 笔签名），用于实时 hook（每次监控触发的批量扫描）
 *
 * 200 笔签名 ≈ 活跃地址最近 1-3 天，对实时识别 akbot 用户已足够；
 * 未命中的地址会再次进入监控时再扫，或交给 scripts/backfill-akbot.ts 全量兜底。
 *
 * 命中即返回 found；扫完没命中返回 clean；熔断/限流返回 inconclusive
 */
export function quickAkbotCheck(address: string): Promise<AkbotCheckResult> {
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
 *   2) 429 熔断 —— 命中一次 429 就全局暂停 BREAK_AFTER_429_MS，期间直接返回
 *      inconclusive，不再打 Helius。注意「下一轮监控自然会重试」原本不成立：
 *      每轮监控拿到的是该 block 的新买家，被熔断吞掉的旧地址不会再进这个列表。
 *      所以重试责任交给调用方（见 monitor.ts 的 akbotRetryQueue）。
 */
const MAX_CONCURRENT_SCANS = 2;
const BREAK_AFTER_429_MS = 30_000;

let inFlight = 0;
let circuitOpenUntil = 0;
const queue: Array<() => void> = [];

function isCircuitOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}

/**
 * 给 monitor 的重试队列用：让它能在排队前先判断「现在还值不值得打 Helius」。
 * 队列里存的是已经因为熔断而 inconclusive 的地址，重试前先问一句，
 * 免得刚熔断完又被拖进一轮注定失败的扫描。
 */
export function isAkbotCircuitOpen(): boolean {
  return isCircuitOpen();
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
): Promise<AkbotCheckResult> {
  // 防御：空地址 / 太短地址直接返回，避免打到 Helius 报错
  if (!address || typeof address !== 'string' || address.length < 32) {
    return { status: 'inconclusive', reason: 'invalid address' };
  }
  // 熔断期内直接放弃：本次不下结论。返回 inconclusive 而不是 null，
  // 好让调用方把这个地址放进重试队列，而不是当成「已排除」丢掉。
  if (isCircuitOpen()) return { status: 'inconclusive', reason: 'circuit open' };

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
): Promise<AkbotCheckResult> {
  const rpc = getMultiRpc();
  const pageSize = Math.min(opts.pageSize ?? 1000, 1000); // 上限保护
  const maxPages = Math.min(opts.maxPages ?? 5, 20);        // 上限保护（≤ 20000 sigs）

  // 1) 分页拉签名（newest-first）—— 公开 RPC，走多源轮询省 Helius 配额
  //    类型带 blockTime/slot：命中 akbot 时直接用 sig 元数据作 evidence，
  //    避免再去 getTransaction（省一次 RPC）。
  const allSigs: Array<{ signature: string; blockTime?: number; slot?: number }> = [];
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
      // 适配 multi-rpc 返回的签名项：Helius 风格的字段同时兼容 Solana web3.js 风格
      const blockTime = (s as any).blockTime ?? (s as any).blockTimeUnix;
      const slot = (s as any).slot;
      allSigs.push({ signature: s.signature, blockTime, slot });
    }
    if (batch.length < pageSize) break;
    before = batch[batch.length - 1].signature;
  }
  // 签名拉取本身失败会抛到调用方；拉回来 0 条是「这个地址链上没交易」，属确定结论。
  if (allSigs.length === 0) return { status: 'clean' };

  // 2) 逐签名拉 tx + 检查 programId
  //    关键变化：原实现走 Helius Enhanced API（100 cr / 100 sigs / 请求），
  //    现改为走 multi-rpc.getTransaction（public RPC 优先，0 credits；fallback 到 Helius 1 cr）。
  //    单签名扫描延迟比批量稍高（顺序处理），但 akbot 用例实时性要求不高（结果仅做 is_akbot 标记）。
  //    同时省掉 100 cr/batch 的开销，单个地址最多 200 sigs → 200 credits（原 400 cr/200 sigs）。
  let sawParseFailure = false;
  for (const sigInfo of allSigs) {
    try {
      const tx = await rpc.getTransaction(sigInfo.signature);
      if (!tx) continue;
      if (isAkbotTxFromRpc(tx)) {
        return {
          status: 'found',
          evidence: {
            signature: sigInfo.signature,
            blockTime: sigInfo.blockTime ?? tx.blockTime ?? 0,
            slot: sigInfo.slot ?? tx.slot ?? 0,
          },
        };
      }
    } catch (err: any) {
      // multi-rpc 已经做了端点轮换 + 自动退避，最后抛出的错误通常不带 axios 风格的
      // response.status（web3.js 风格的 Error）。用 message 正则兜底，确保「多端点全
      // 被打满」时仍能触发熔断并返回 inconclusive。
      const status = err?.response?.status ?? err?.status;
      const msg = String(err?.message ?? '');
      const is429 = status === 429 || /\b429\b/.test(msg) || /rate.?limit/i.test(msg);
      if (is429) {
        // 429 之后继续打只会接着 429：既白烧配额又加深堆积。
        // 直接放弃这个地址剩下的签名，熔断交给外层的闸门处理。
        tripCircuit();
        return { status: 'inconclusive', reason: 'rate limited (429)' };
      }
      // 单笔解析失败不影响下一笔，但这一笔确实没结论，要记下来
      sawParseFailure = true;
      console.warn('[akbot] getTransaction failed:', (err as Error).message);
    }
  }
  // 有签名解析失败 → 这部分没被检查过，不能宣布「干净」
  if (sawParseFailure) return { status: 'inconclusive', reason: 'getTransaction failed' };
  return { status: 'clean' };
}