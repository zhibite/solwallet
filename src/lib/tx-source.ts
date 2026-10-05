/**
 * 交易取数层：把 Helius 增强 API 和普通 Solana RPC 归一化成同一个 TxView。
 *
 * ## 为什么需要这一层
 *
 * pnl.ts 的收益算法只用到四件事：某笔交易有没有失败、手续费多少、
 * 钱包在这个 mint 上的 token 进出、钱包的 SOL 进出。
 * 这四件事在 Helius 增强 API 和普通 `getTransaction` 里都能拿到，
 * 但**取法完全不同**，所以算法层不能直接依赖任何一方。
 *
 * ## 两种来源的真实差异
 *
 * 1) `getSignaturesForAddress` 根本不是 Helius 专有接口，
 *    就是标准 JSON-RPC。原来它被发到 Helius 的域名，白白消耗配额。
 *
 * 2) 交易解析原本走 Helius 的 `/v0/transactions`。它给的是
 *    **已经解析好的 tokenTransfers / nativeTransfers 列表**。
 *
 * 3) 普通 RPC 没有这个列表，但 `getTransaction` 的 `meta` 里有
 *    `preTokenBalances` / `postTokenBalances` / `preBalances` / `postBalances`，
 *    **余额差就是这笔交易真实的进出**。
 *
 * ## 为什么余额差比 Helius 的解析列表更可信
 *
 * 余额差是链上记账的最终结果，不依赖任何一套索引器的解析规则。
 * Helius 对**失败交易**仍会返回根本没执行的转账（实测一笔失败的买入
 * 带着一条 2.43 SOL 的 phantom 转出），而失败交易的所有余额变动都是 0，
 * 余额差天然免疫这个问题。
 *
 * ## 一个必须讲清楚的限制
 *
 * 余额差只能给出**净额**，拆不开「收了多少又付了多少」。
 * 这一点不影响收益结果，因为 FIFO 算法对买入只用净流出、对卖出只用净流入，
 * 净额就是它需要的全部。唯一受影响的是 trades[] 里记录的明细金额，
 * 对收益本身没有影响。
 */

import type { TransactionResponse } from '@solana/web3.js';
import type { HeliusEnhancedTx } from './types';
import { getMultiRpc } from './multi-rpc';
import { solanaTxToHeliusEnhanced, inboundTokenAmount, outboundTokenAmount } from './parser';

/**
 * Helius 增强 API 的失败标记。
 *
 * tx.err 是 getSignaturesForAddress 才有的字段，在 parseTransaction 的返回里恒为 undefined，
 * 拿它判失败等于「所有交易都算成功」。
 *
 * 注意 null 的语义：**null 是「没解析出来」（限流 / 网络），不是「交易失败」**。
 * 把两者混同会把限流的结果当成买入失败写进库，比算错收益更难发现。
 */
export function isFailedTx(tx: HeliusEnhancedTx | null | undefined): boolean {
  if (!tx) return false;
  if (tx.transactionError) return true;
  return !!(tx.events?.swap?.error);
}

/** 归一化后的单笔交易视图。算法层只认这个接口，不认底层来源。 */
export interface TxView {
  signature: string;
  slot: number;
  blockTime: number;
  /** 本笔手续费 (lamports)，含 base + priority */
  feeLamports: number;
  /** 交易是否失败。**null 表示没取到，不能当失败用** */
  failed: boolean;
  /**
   * 钱包在某 mint 上的 token 净变动（原始单位）。
   * 正 = 收到（买入），负 = 卖出。
   */
  tokenDelta(mint: string, wallet: string): number;
  /**
   * 钱包的 SOL 净变动（SOL），**已剔除本笔手续费**。
   * 正 = 收到（卖出回款），负 = 付出（买入成本）。
   */
  solNet(wallet: string): number;
  /** 供 isAkbotTx 这类需要 programId 的检测使用 */
  raw: HeliusEnhancedTx;
}

// ============================================================
//  普通 RPC 实现：全部来自 meta 的余额差
// ============================================================

/** web3.js 的 accountKeys 在 legacy 和 v0 下字段名不同 */
function accountKeysOf(tx: TransactionResponse): string[] {
  const msg: any = (tx as any).transaction?.message;
  const raw: any[] = msg?.staticAccountKeys ?? msg?.accountKeys ?? [];
  return raw.map((k: any) => (typeof k === 'string' ? k : (k?.toBase58?.() ?? String(k))));
}

/** 构造余额差视图。meta 缺失时返回 null（调用方要区分「没取到」和「失败」） */
export function rpcTxView(tx: TransactionResponse | null): TxView | null {
  if (!tx || !(tx as any).transaction) return null;
  const meta: any = tx.meta;
  if (!meta) return null;

  const keys = accountKeysOf(tx);
  if (keys.length === 0) return null;
  const feePayer = keys[0];
  const fee: number = meta.fee ?? 0;
  const preSol: number[] = meta.preBalances ?? [];
  const postSol: number[] = meta.postBalances ?? [];
  const preTok: any[] = meta.preTokenBalances ?? [];
  const postTok: any[] = meta.postTokenBalances ?? [];

  // token 账户按 (accountIndex, mint) 索引；同一 mint 可能分散在钱包的多个 ATA 上，要累加
  const preTokMap = new Map<string, number>();
  for (const b of preTok) {
    preTokMap.set(`${b.accountIndex}-${b.mint}`, Number(b.uiTokenAmount?.amount ?? 0));
  }

  const idxCache = new Map<string, number>();
  const indexOf = (wallet: string): number => {
    let i = idxCache.get(wallet);
    if (i === undefined) {
      i = keys.indexOf(wallet);
      idxCache.set(wallet, i);
    }
    return i;
  };

  // instructions 只需要 programId，适配器这部分是可靠的
  const raw = solanaTxToHeliusEnhanced(tx) as HeliusEnhancedTx;

  return {
    signature: (tx as any).transaction.signatures?.[0] ?? '',
    slot: tx.slot,
    blockTime: tx.blockTime ?? 0,
    feeLamports: fee,
    failed: meta.err != null,
    tokenDelta(mint: string, wallet: string): number {
      let sum = 0;
      for (const po of postTok) {
        if (po.mint !== mint) continue;
        // owner 才是钱包归属；accountIndex 是 token 账户，wallet 自己可能不是 token 账户
        if (po.owner !== wallet) continue;
        const pre = preTokMap.get(`${po.accountIndex}-${po.mint}`) ?? 0;
        sum += Number(po.uiTokenAmount?.amount ?? 0) - pre;
      }
      return sum;
    },
    solNet(wallet: string): number {
      const i = indexOf(wallet);
      if (i < 0 || i >= preSol.length || i >= postSol.length) return 0;
      const d = postSol[i] - preSol[i];
      // 钱包自己付手续费时，余额差里已经含了 fee，要扣回来才是「除手续费外的净变动」。
      // 别人（Blockworks / Jito）代付时，余额差是纯粹的进出，不该再扣。
      return (d - (i === 0 ? fee : 0)) / 1e9;
    },
    raw: raw ?? ({ signature: '', instructions: [] } as unknown as HeliusEnhancedTx),
  };
}

// ============================================================
//  Helius 增强 API 实现：配额恢复后可用
// ============================================================

/** 本人在交易里的账户：feePayer 一定是自己，relayer 代付时钱包余额也会变 */
function ownersOf(tx: HeliusEnhancedTx, wallet: string): string[] {
  return tx.feePayer === wallet ? [tx.feePayer] : [tx.feePayer, wallet];
}

export function heliusTxView(tx: HeliusEnhancedTx | null): TxView | null {
  if (!tx) return null;
  return {
    signature: tx.signature,
    slot: (tx as any).slot ?? 0,
    blockTime: (tx as any).blockTime ?? 0,
    feeLamports: tx.fee ?? 0,
    failed: isFailedTx(tx),
    tokenDelta(mint: string, wallet: string): number {
      return inboundTokenAmount(tx, mint, wallet) - outboundTokenAmount(tx, mint, wallet);
    },
    solNet(wallet: string): number {
      const owners = ownersOf(tx, wallet);
      let solIn = 0;
      let solOut = 0;
      for (const t of tx.nativeTransfers ?? []) {
        if (t.fromUserAccount === t.toUserAccount) continue; // 自转不算
        const amt = Number(t.amount);
        if (owners.includes(t.toUserAccount)) solIn += amt;
        if (owners.includes(t.fromUserAccount)) solOut += amt;
      }
      // Helius 的 nativeTransfers 不含 fee，所以这里不减 fee
      return (solIn - solOut) / 1e9;
    },
    raw: tx,
  };
}

// ============================================================
//  来源选择
// ============================================================

export type TxSourceKind = 'rpc' | 'helius' | 'auto';

function configuredSource(): TxSourceKind {
  const v = (process.env.PNL_TX_SOURCE ?? 'rpc').toLowerCase();
  return v === 'helius' || v === 'auto' ? v : 'rpc';
}

let _kind: TxSourceKind | null = null;
let _heliusDead = false;   // 探测到配额耗尽后，本次进程内不再试 Helius

export function activeSource(): TxSourceKind {
  if (_kind) return _kind;
  _kind = configuredSource();
  if (_kind === 'helius' && !process.env.HELIUS_API_KEY) _kind = 'rpc';
  return _kind;
}

/** 供 /settings 之类的页面显示当前实际在用哪条链路 */
export function sourceStatus(): { configured: TxSourceKind; active: TxSourceKind; heliusDead: boolean } {
  return { configured: configuredSource(), active: activeSource(), heliusDead: _heliusDead };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 同时跑多少个 getTransaction。公共 RPC 对并发敏感，6 是实测不炸的上限附近。 */
function fetchConcurrency(): number {
  const v = parseInt(process.env.PNL_FETCH_CONCURRENCY ?? '', 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 12) : 6;
}

/**
 * 取一批交易，返回与输入**同序**的结果。
 *
 * null = 没取到（限流 / 网络 / 节点没有这笔），
 * 绝不能当成「交易失败」—— 调用方要能区分这两种情况。
 */
export async function fetchTxViews(
  sigs: string[],
  wallet: string,
): Promise<Array<TxView | null>> {
  if (sigs.length === 0) return [];

  // ---- Helius 增强 API ----
  if (activeSource() === 'helius' || (activeSource() === 'auto' && !_heliusDead)) {
    try {
      const { getHelius } = await import('./helius');
      const parsed = await getHelius().parseTransactions(sigs);
      // Helius 返回按时间倒序，不按请求顺序，必须按签名对齐
      const bySig = new Map<string, HeliusEnhancedTx>();
      for (const t of parsed) if (t) bySig.set(t.signature, t);
      return sigs.map((s) => heliusTxView(bySig.get(s) ?? null));
    } catch (err: any) {
      const status = err?.response?.status ?? err?.status;
      if (status === 429 || /max usage|quota|rate/i.test(err?.message ?? '')) {
        console.warn('[tx-source] Helius 配额耗尽，本次进程切到公共 RPC');
        _heliusDead = true;
      } else if (activeSource() === 'helius') {
        // 显式要求 helius 却报别的错，仍然退回去，否则整条链路瘫掉
        console.warn('[tx-source] Helius 取数失败，退回公共 RPC:', (err as Error).message);
        _heliusDead = true;
      } else {
        throw err;
      }
    }
  }

  // ---- 公共 RPC ----
  const rpc = getMultiRpc();
  const out: Array<TxView | null> = new Array(sigs.length).fill(null);
  const conc = fetchConcurrency();
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= sigs.length) return;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const tx = await rpc.getTransaction(sigs[i]);
          out[i] = rpcTxView(tx);
          break;
        } catch (err: any) {
          const msg = err?.message ?? String(err);
          const retriable = /429|503|502|504|timeout|socket|ECONN/i.test(msg);
          if (!retriable || attempt === 2) {
            if (attempt === 2) console.warn(`[tx-source] 取不到 ${sigs[i].slice(0, 12)}…: ${msg.slice(0, 100)}`);
            break;
          }
          await sleep(500 * (attempt + 1));
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(conc, sigs.length) }, () => worker()));
  return out;
}

// ============================================================
//  签名列表：按地址缓存
// ============================================================

export interface SigInfo {
  signature: string;
  slot: number;
  blockTime: number;
  err: any | null;
}

const SIG_PAGE_SIZE = 1000;
const MAX_SIG_PAGES = 20;   // 单次计算最多往后翻 2 万笔

/**
 * 签名按 (地址, 起点) 缓存。
 *
 * 一个地址在 block_buyers 里可能有多行（最多的一个有 328 行），同一行的多次请求
 * 也可能重试。缓存后这些重复请求只付一次。
 */
const sigCache = new Map<string, SigInfo[]>();
const SIG_CACHE_MAX = 200;

function cacheKey(address: string, fromSig: string): string {
  return `${address}|${fromSig}`;
}

function rememberSigs(key: string, sigs: SigInfo[]): void {
  // Map 保持插入序，删最早的即可近似 LRU
  while (sigCache.size >= SIG_CACHE_MAX) {
    const oldest = sigCache.keys().next().value;
    if (oldest === undefined) break;
    sigCache.delete(oldest);
  }
  sigCache.set(key, sigs);
}

export function clearSigCache(): void {
  sigCache.clear();
}

/**
 * 取某个地址**在 fromSig 之后**的所有签名，按链上顺序从旧到新排好。
 *
 * ## 为什么是「从买入往后翻」而不是「从现在往回翻」
 *
 * 早期实现是 getSignaturesForAddress(address) 从链尾往回翻页，找到买入那一笔，
 * 再截取它之后那一段。这有两个致命问题：
 *
 * 1) **够不到。** 翻页上限 2 万笔。钱包只要在这笔买入之后又做了 2 万笔交易，
 *    买入就被挤出窗口了。实测一批 2026-09-30 的历史行，钱包签名窗口最老只到
 *    slot 453498000，而买入在 451923109 —— 差 160 万个 slot，永远走不到。
 *    够不到时 calcCopyPnl 会返回 status='open' / pnlSol=null，
 *    回填脚本会把这个已经算对的 closed 行**覆盖成 NULL**。
 *
 * 2) **贵。** 一个钱包要先翻 2 万笔才够得着买入，而真正需要的往往只有买入后
 *    几十笔。实测 429 频繁、熔断器连续打开。
 *
 * 改用 until=fromSig：第一页直接就是「买入之后最新的 1000 笔」，
 * 再用 before 把窗口往更老的方向挪、同时用 until 锁住下界，
 * 于是**只翻买入之后那几笔**，既不受链尾位置影响，也几乎不消耗翻页预算。
 *
 * 代价：拿不到买入之前的历史。但 calcCopyPnl 本来就不需要那些。
 *
 * @param fromSig 起点签名，**不含**这一笔本身
 */
export async function fetchSigsFrom(address: string, fromSig: string): Promise<SigInfo[]> {
  const key = cacheKey(address, fromSig);
  const cached = sigCache.get(key);
  if (cached) return cached;

  const rpc = getMultiRpc();
  const collected: SigInfo[] = [];   // newest-first，最后 reverse
  let before: string | undefined;

  for (let i = 0; i < MAX_SIG_PAGES; i++) {
    let batch: SigInfo[];
    try {
      batch = await rpc.getSignaturesForAddress(address, SIG_PAGE_SIZE, before, fromSig);
    } catch (err: any) {
      // 翻到一半失败：宁可返回不完整的部分，也不要整条链路断掉。
      // 调用方拿到的链路短了，只会把「持仓中」算成「还没卖完」，
      // 不会凭空编出一个收益数。
      if (collected.length > 0) {
        console.warn(
          `[tx-source] ${address.slice(0, 8)}… 往后翻签名中断（已取 ${collected.length} 笔）: ` +
          String(err?.message ?? err).slice(0, 80),
        );
        break;
      }
      throw err;
    }
    if (!batch || batch.length === 0) break;
    collected.push(...batch);
    if (batch.length < SIG_PAGE_SIZE) break;
    before = batch[batch.length - 1].signature;
  }

  const result = collected.reverse();
  rememberSigs(key, result);
  return result;
}
