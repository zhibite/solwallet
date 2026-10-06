/**
 * Solana 交易解析模块
 * 输入：Helius Enhanced Transaction 或公共 RPC 原始交易
 * 输出：标准化 buy 信息（MINT / SOL 数量 / TIP / PRIO / 是否 bundled）
 *
 * 关键概念：
 * - buy_sol: 买入花掉的 SOL（含 jito tip / ATA rent，**不含** tx fee）。
 *   两路算法（Helius 增强 API / 公共 RPC）口径统一都是这个语义，
 *   fee 在 pnl.ts 里单独按 soldRatio 分摊扣减。
 * - tip_sol: 给 validator 的小费
 * - prio_lamports: 优先级费 (compute unit price * CU)
 * - bundled: 是否是 jito bundle 内交易（通过 ALT / 同一 slot 内 5+ 笔极短时间内发送判断）
 * - version: 'v0' 表示地址表交易（含 ALT），'legacy' 表示传统交易
 */

import { PublicKey, TransactionInstruction, TransactionResponse } from '@solana/web3.js';
import type { HeliusEnhancedTx, SolanaBlock } from './types';

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Solana 标准 system program ID */
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

/** 已知 DEX 程序 ID → source 名称映射（取首个命中） */
const PROGRAM_SOURCE_MAP: Record<string, string> = {
  'pAMMBay6oceH9fJKBRHGP5D4bD4nWc6YfiMwT4w5SHf': 'RAYDIUM_CPMM',
  '675kPX9MHTjS2zt1qfr1WiF9jrTeX7JXqGev3N1uR3kS': 'RAYDIUM',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'PUMP_FUN',
  'JUP6LgZ9JyH4xNz7n9P2xBCfA4rWXxW9gh6D6L6R4Vfq': 'JUPITER',
  'JUP4Fb2aWiR2XApy9C7v3R4v6v1kM7k7b5F3H7w5QHDq': 'JUPITER',
  'JUP5eah7fHkzu7tQHiCQLfB6y8L3c6Yz4rCKQEEYwmK7': 'JUPITER',
  'whirLbMiicVdio4qvUfM5KAgmbLp4R9vCf8qMCH4bEd': 'ORCA',
};

export interface ParsedBuy {
  signature: string;
  slot: number;
  blockTime: number;
  address: string;          // 买入者地址（feePayer）
  mint: string;
  buySol: number;
  tipSol: number;
  prioLamports: number;
  fee: number;              // 总手续费（含 base + priority + tip）
  version: 'v0' | 'legacy';
  isBundled: boolean;
  hasAlt: boolean | null;   // 是否观察到 Address Lookup Table（fallback 适配器写；Helius 路径为 null）
  bundleId: string | null;  // 同 bundle 的多笔共享同一 ID
  source: string;           // pump.fun / raydium / jupiter 等
  /**
   * 0010: tip 收款渠道。null = 未付 tip；
   *        'unknown' = 付了 tip 但收款地址不在 4 通道（jito / helius_sender / landx / zero_slot）里。
   */
  tipSource: import('./types').TipSource | null;
  success: boolean;
  tokenAmount?: number | null;
}

/** 检查交易是否可能为 swap/buy */
export function isBuyTx(tx: HeliusEnhancedTx): boolean {
  if (!tx) return false;
  // Helius 已标注的类型
  if (tx.type === 'SWAP' || tx.type === 'BUY' || tx.source === 'RAYDIUM' || tx.source === 'PUMP_FUN' || tx.source === 'JUPITER' || tx.source === 'ORCA') {
    return true;
  }
  // tokenTransfers 包含 out（卖出 SOL/Token）
  return Array.isArray(tx.tokenTransfers) && tx.tokenTransfers.length > 0;
}

/** 提取 MINT：从 tokenTransfers 中选 token 变动最大者 */
export function extractMint(tx: HeliusEnhancedTx): string | null {
  if (!tx.tokenTransfers || tx.tokenTransfers.length === 0) return null;

  // 优先取接收方为 feePayer 的 transfer（=买入的目标 token）
  const inbound = findInboundTransfer(tx);
  if (inbound) return inbound.mint;

  // 否则取 amount 最大的
  const sorted = [...tx.tokenTransfers].sort((a, b) => (b.tokenAmount || 0) - (a.tokenAmount || 0));
  return sorted[0]?.mint ?? null;
}

/**
 * 找出「流入 feePayer」的那条 token transfer。
 *
 * extractMint 靠它定 mint，之前 tokenAmount 却直接取 tokenTransfers[0]，
 * 两者可能不是同一条（数组顺序不保证按金额排），导致落库的 token 数量
 * 跟 mint 对不上，FIFO 配对就会算错。
 */
function findInboundTransfer(tx: HeliusEnhancedTx) {
  if (!tx.tokenTransfers || tx.tokenTransfers.length === 0) return null;
  return (
    tx.tokenTransfers.find((t) => t.toUserAccount === tx.feePayer) ??
    [...tx.tokenTransfers].sort((a, b) => (b.tokenAmount || 0) - (a.tokenAmount || 0))[0] ??
    null
  );
}

/**
 * 某笔交易里，指定 mint 流入 owner 的 token 数量（买入数量）。
 *
 * owner 通常就是 feePayer，但 Jito bundle / relayer 代付场景下 feePayer 可能是别人，
 * 而 token 的实际持有人是钱包本身，所以两个账户都要认。
 *
 * 注意用 .reduce() 而不是 .find()：一笔交易里同 mint 可能通过多条路径打到 owner
 * （比如 swap 走多跳中间池），只取第一笔会少算 token 数 —— 这种漏算会破坏 pnl.ts 里
 * FIFO 配对的分母 / 分子，下游的 soldRatio 与 proceeds 都会偏。
 */
export function inboundTokenAmount(tx: HeliusEnhancedTx, mint: string, owner?: string): number {
  const mine = (t: { mint: string; toUserAccount: string }) =>
    t.mint === mint && (t.toUserAccount === tx.feePayer || t.toUserAccount === owner);
  return (tx.tokenTransfers ?? [])
    .filter(mine)
    .reduce((sum, t) => sum + Number(t.tokenAmount), 0);
}

/** 某笔交易里，指定 mint 从 owner 流出的 token 数量（卖出数量）。
 *  同样的原因用 .reduce() 而不是 .find()。 */
export function outboundTokenAmount(tx: HeliusEnhancedTx, mint: string, owner?: string): number {
  const mine = (t: { mint: string; fromUserAccount: string }) =>
    t.mint === mint && (t.fromUserAccount === tx.feePayer || t.fromUserAccount === owner);
  return (tx.tokenTransfers ?? [])
    .filter(mine)
    .reduce((sum, t) => sum + Number(t.tokenAmount), 0);
}

/** 计算买入花费的 SOL：含 jito tip 与 ATA rent，**不含** tx fee（fee 单独走 buyFeeLamports）。
 *
 *  Helius 路径：nativeTransfers 是账户间转账列表，runtime 烧掉的 fee 不在里面，
 *  所以直接累加 feePayer 的 outgoing transfers 就是 buy + tip + rent。 */
export function calcBuySol(tx: HeliusEnhancedTx): number {
  // SOL 净流出 = preBalance - postBalance，再扣 fee 即 buy 金额
  // 但 tx 没有直接给 preBalance/postBalance，所以从 nativeTransfers 推算
  if (!tx.nativeTransfers) return 0;

  const outLamports = tx.nativeTransfers
    .filter((t) => t.fromUserAccount === tx.feePayer)
    .reduce((sum, t) => {
      // Helius 新版 API 返回的 amount 是字符串，需要转 number 再相加
      const amt = typeof t.amount === 'string' ? Number(t.amount) : t.amount;
      return sum + amt;
    }, 0);

  // 转换 lamports -> SOL（再加回 fee 与 tip 才是真正的 buy 支出）
  // 但注意：fee 与 tip 都在 nativeTransfers 中体现（如果是 tip，则有 transfer 给 tip account）
  // 我们这里用 rough estimate: outLamports / 1e9
  return outLamports / LAMPORTS_PER_SOL;
}

/**
 * Solana tip 收款账户全集（jito / helius_sender / landx / zero_slot 四通道合并，2026/10 快照）。
 *
 * 各通道来源：
 *   - jito:           https://mainnet.block-engine.jito.wtf/api/v1/getTipAccounts（refreshSolanaTipAccounts 会自动刷新这 8 个）
 *   - helius_sender:  https://docs.helius.dev/sending-transactions（Designated Tip Accounts, 10 个，Sender Max 最低 0.001 SOL）
 *   - landx:          https://landx-1.gitbook.io/landx-docs/tip-addresses（10 个，地址前缀 LandX，最低 0.001 SOL）
 *   - zero_slot:      https://0slot.trade（10 个，Advanced 档 0.0001 SOL / 默认档 0.001 SOL）
 *
 * 同一笔 buy 同时付多个通道极少见（如 Helius Sender 的多通路 fan-out），
 * calcSolanaTip / getTipSource 永远取首个命中的通道，余额累加（保证 tip_sol 不漏）。
 *
 * 新通道（Harmonic / Rakurai / jitoBAM 等）按以下步骤加：
 *   1) 把新地址放进 SOLANA_TIP_SOURCE_MAP（值 = 渠道名）
 *   2) 跑 backfill-tip-source.ts 回填历史 tip_source
 */
export let SOLANA_TIP_ACCOUNTS: ReadonlySet<string> = new Set([
  // === Jito（8 个；由 refreshSolanaTipAccounts 自动覆盖）===
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',

  // === Helius Sender（10 个，2026/10 文档）===
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yP2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',

  // === LandX（10 个，地址前缀 LandX）===
  'LandX1EMgYtrfi4jVJ7ryby4mDpZcef6sVH9b9U1cog',
  'LandX2gHE7y6RejuvoLJK4hJiKkrAwcrJJ34u19Gmo1',
  'LandX3uK1cSUF7hbefKo3oL1j4FhvhxitiMRKut99Z6',
  'LandX4wXzvDyWfq1XXn4StRjwPjzqb7je2kqDGLoT9L',
  'LandX5T4jfRASrcn76owxHM4q9bduNGj24ev4Ufc5fP',
  'LandX6RsjjnfaxfYAFTZX1TW9Cgfe9HFStj9nRDd5SK',
  'LandX7LsdzXDAbbyBjAq5FxLTnGQaU3LojGQMLZCvkt',
  'LandX8Gv3UkhjmgKdSEg4F7yG7Z2tiqhNDYDtxazydN',
  'LandX9fhNN5S7fuBgekKBYeYvK1Sy9hbGvDmHsBGYFh',
  'LandXXxDXaSS8MjrqG9nri51htrfM6V4R3zXDVCeV8R',

  // === 0slot（10 个，Advanced 档 0.0001 SOL / 默认 0.001 SOL）===
  'DiTmWENJsHQdawVUUKnUXkconcpW4Jv52TnMWhkncF6t',
  'HRyRhQ86t3H4aAtgvHVpUJmw64BDrb61gRiKcdKUXs5c',
  '7y4whZmw388w1ggjToDLSBLv47drw5SUXcLk6jtmwixd',
  'J9BMEWFbCBEjtQ1fG5Lo9kouX1HfrKQxeUxetwXrifBw',
  '8U1JPQh3mVQ4F5jwRdFTBzvNRQaYFQppHQYoH38DJGSQ',
  'Eb2KpSC8uMt9GmzyAEm5Eb1AAAgTjRaXWFjKyFXHZxF3',
  'FCjUJZ1qozm1e8romw216qyfQMaaWKxWsuySnumVCCNe',
  'ENxTEjSQ1YabmUpXAdCgevnHQ9MHdLv8tzFiuiYJqa13',
  '6rYLG55Q9RpsPGvqdPNJs4z5WTxJVatMB8zV3WJhs5EK',
  'Cix2bHfqPcKcM233mzxbLk14kSggUUiz2A87fJtGivXr',
]);

/**
 * tip 收款地址 → 渠道名映射。
 * SOLANA_TIP_ACCOUNTS 是这个 map 的 keys，是同一份数据的两种视图。
 * 给一个 tip 收款地址，告诉你它属于哪个 tip 通道（用于落 tip_source 列）。
 */
export const SOLANA_TIP_SOURCE_MAP: Readonly<Record<string, import('./types').TipSource>> = {
  // Jito
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL': 'jito',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe': 'jito',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY': 'jito',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5': 'jito',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49': 'jito',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT': 'jito',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh': 'jito',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt': 'jito',
  // Helius Sender
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE': 'helius_sender',
  'D2L6yP2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ': 'helius_sender',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta': 'helius_sender',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn': 'helius_sender',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD': 'helius_sender',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ': 'helius_sender',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF': 'helius_sender',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT': 'helius_sender',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey': 'helius_sender',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or': 'helius_sender',
  // LandX（前缀 LandX，全部 landx）
  'LandX1EMgYtrfi4jVJ7ryby4mDpZcef6sVH9b9U1cog': 'landx',
  'LandX2gHE7y6RejuvoLJK4hJiKkrAwcrJJ34u19Gmo1': 'landx',
  'LandX3uK1cSUF7hbefKo3oL1j4FhvhxitiMRKut99Z6': 'landx',
  'LandX4wXzvDyWfq1XXn4StRjwPjzqb7je2kqDGLoT9L': 'landx',
  'LandX5T4jfRASrcn76owxHM4q9bduNGj24ev4Ufc5fP': 'landx',
  'LandX6RsjjnfaxfYAFTZX1TW9Cgfe9HFStj9nRDd5SK': 'landx',
  'LandX7LsdzXDAbbyBjAq5FxLTnGQaU3LojGQMLZCvkt': 'landx',
  'LandX8Gv3UkhjmgKdSEg4F7yG7Z2tiqhNDYDtxazydN': 'landx',
  'LandX9fhNN5S7fuBgekKBYeYvK1Sy9hbGvDmHsBGYFh': 'landx',
  'LandXXxDXaSS8MjrqG9nri51htrfM6V4R3zXDVCeV8R': 'landx',
  // 0slot
  'DiTmWENJsHQdawVUUKnUXkconcpW4Jv52TnMWhkncF6t': 'zero_slot',
  'HRyRhQ86t3H4aAtgvHVpUJmw64BDrb61gRiKcdKUXs5c': 'zero_slot',
  '7y4whZmw388w1ggjToDLSBLv47drw5SUXcLk6jtmwixd': 'zero_slot',
  'J9BMEWFbCBEjtQ1fG5Lo9kouX1HfrKQxeUxetwXrifBw': 'zero_slot',
  '8U1JPQh3mVQ4F5jwRdFTBzvNRQaYFQppHQYoH38DJGSQ': 'zero_slot',
  'Eb2KpSC8uMt9GmzyAEm5Eb1AAAgTjRaXWFjKyFXHZxF3': 'zero_slot',
  'FCjUJZ1qozm1e8romw216qyfQMaaWKxWsuySnumVCCNe': 'zero_slot',
  'ENxTEjSQ1YabmUpXAdCgevnHQ9MHdLv8tzFiuiYJqa13': 'zero_slot',
  '6rYLG55Q9RpsPGvqdPNJs4z5WTxJVatMB8zV3WJhs5EK': 'zero_slot',
  'Cix2bHfqPcKcM233mzxbLk14kSggUUiz2A87fJtGivXr': 'zero_slot',
};

/**
 * 给 tip 收款地址查来源渠道；null = 不在已知 4 通道中
 * （调用方应当用 calcSolanaTip > 0 这个判定先做一次，命中后再查这个函数更安全）。
 */
export function getTipSource(addr: string | null | undefined): import('./types').TipSource | null {
  if (!addr) return null;
  return (SOLANA_TIP_SOURCE_MAP as Record<string, import('./types').TipSource>)[addr] ?? null;
}

/**
 * 从 Jito block engine 实时刷新 tip accounts。
 * 注意：Helius Sender / LandX / 0slot 的 tip account 是写死列表（这些服务不公开 getTipAccounts 接口），
 *       所以这里只刷新 Jito 那 8 个，其它三通道仍走静态常量。
 * 失败时保留旧值。
 */
export async function refreshJitoTipAccounts(): Promise<{ ok: boolean; source: string; count: number }> {
  try {
    const r = await fetch('https://mainnet.block-engine.jito.wtf/api/v1/getTipAccounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }),
    });
    const j: any = await r.json();
    if (Array.isArray(j?.result) && j.result.length >= 1) {
      // 把 Jito 新地址并入 SOLANA_TIP_ACCOUNTS，并保持 SOLANA_TIP_SOURCE_MAP 标记为 'jito'
      const existing = new Set(SOLANA_TIP_ACCOUNTS);
      for (const addr of j.result as string[]) {
        if (!existing.has(addr)) {
          existing.add(addr);
          (SOLANA_TIP_SOURCE_MAP as Record<string, import('./types').TipSource>)[addr] = 'jito';
        }
      }
      SOLANA_TIP_ACCOUNTS = existing;
      return { ok: true, source: 'live', count: j.result.length };
    }
    return { ok: false, source: 'live(empty)', count: 0 };
  } catch (e) {
    return { ok: false, source: 'live(error)', count: 0 };
  }
}

/**
 * 兼容旧名：脚本里偶尔还会 import { JITO_TIP_ACCOUNTS }，
 * 直接 export 同样的 SOLANA_TIP_ACCOUNTS 引用让旧 import 不报错。
 *
 * 注意是 getter，不复制——refreshJitoTipAccounts 替换 SOLANA_TIP_ACCOUNTS 后，
 * 通过 JITO_TIP_ACCOUNTS 拿到的也是新值（如果你 .has(...)）。
 */
export const JITO_TIP_ACCOUNTS: ReadonlySet<string> = new Proxy(
  {} as ReadonlySet<string>,
  {
    get(_t, prop) {
      // 把所有 Set 方法转发到 SOLANA_TIP_ACCOUNTS
      const v = (SOLANA_TIP_ACCOUNTS as any)[prop];
      return typeof v === 'function' ? v.bind(SOLANA_TIP_ACCOUNTS) : v;
    },
    has(_t, addr) {
      return SOLANA_TIP_ACCOUNTS.has(addr as string);
    },
  },
);

/**
 * 计算 tip：转账给任意已知 tip 账户（Jito / Helius Sender / LandX / 0slot）的 lamports 累计 SOL。
 *
 * 旧名 calcJitoTip 已弃用，仍以别名 export 给外部脚本兼容。
 */
export function calcSolanaTip(tx: HeliusEnhancedTx): number {
  if (!tx.nativeTransfers) return 0;

  const tipLamports = tx.nativeTransfers
    .filter((t) => SOLANA_TIP_ACCOUNTS.has(t.toUserAccount))
    .reduce((sum, t) => {
      // Helius nativeTransfers[].amount 在新版 API 是字符串，直接 + 会触发字符串拼接
      const amt = typeof t.amount === 'string' ? Number(t.amount) : t.amount;
      return sum + amt;
    }, 0);

  return tipLamports / LAMPORTS_PER_SOL;
}

/** @deprecated 改名 calcSolanaTip，外部 import 向后兼容 */
export const calcJitoTip = calcSolanaTip;

/** 计算 priority fee (compute unit price * compute units) */
export function calcPriorityFee(tx: HeliusEnhancedTx): number {
  // Helius 在 instructions 中不会直接给 CU，但可以从 fee - baseFee - tip 推算
  // 或者从交易的 computeBudget 指令中读取
  if (!tx.instructions) return 0;

  let cuPrice = 0;
  let cuLimit = 0;

  for (const ix of tx.instructions) {
    if (ix.programId !== 'ComputeBudget111111111111111111111111111111111') continue;
    const data = Buffer.from(ix.data || '', 'base64');
    // SetComputeUnitPrice: tag 3, u64 micros
    // SetComputeUnitLimit: tag 2, u32 units
    const tag = data[0];
    if (tag === 3 && data.length >= 9) {
      cuPrice = Number(data.readBigUInt64LE(1));
    } else if (tag === 2 && data.length >= 5) {
      cuLimit = data.readUInt32LE(1);
    }
  }

  // priorityFee = cuPrice * cuLimit / 1e6 (cuPrice 是 microlamports)
  // 但实际上很多交易只设置 cuPrice，cuLimit 走默认 200000
  const cu = cuLimit || 200_000;
  const parsed = Math.floor((cuPrice * cu) / 1_000_000); // lamports

  // 兜底：用 tx.fee 反推 priority fee。
  // Solana 每笔签名收 5000 lamports base fee，因此 priorityFee ≈ fee − 5000 × sigCount。
  // 单签 sniper tx 几乎全是 1 个签名；多签需 signatures 数组，但当前 HeliusEnhancedTx 只暴露主 signature。
  // 这样做的好处：能覆盖 (a) 老 ComputeBudget 顶层指令、(b) 新 pfeeUxB6 / Blockworks PriorityFee
  // 走 CPI innerInstruction 发的 priority fee、(c) 完全不付 prio（此时 fallback=0）。
  const baseFee = 5000; // 单签 base fee
  const fallback = Math.max(0, (tx.fee ?? 0) - baseFee);

  // 取较大值，避免在多签场景下 fallback 偏低
  return Math.max(parsed, fallback);
}

/** 是否为 bundled transaction */
export function isBundled(tx: HeliusEnhancedTx): boolean {
  // 强信号：付了任意渠道 tip → 必是 bundle（tip 是 bundle 唯一可靠的强信号）
  // calcSolanaTip 已合并 4 通道（Jito / Helius Sender / LandX / 0slot），转账给其中任一地址即算。
  if (calcSolanaTip(tx) > 0) return true;

  // 次信号：fallback 适配器（solanaTxToHeliusEnhanced）显式观察到了 Address Lookup Table。
  // v0 + ALT 通常表示 jito bundle（jito bundle 强制用 ALT 来塞多笔 tx）。
  const hasAlt = (tx as any)._hasAlt as boolean | undefined;
  if (hasAlt === true) return true;
  if (hasAlt === false) return false;

  // Helius Enhanced 路径拿不到 ALT 信息：保守返回 false。
  // 旧实现直接用 `tx.version === 0` 会把所有 v0 tx 误判为 bundle，包括普通 v0 交易（Solana 上极常见）。
  return false;
}

/** 是否观察到 Address Lookup Table（fallback 适配器会用此字段） */
export function txHasAlt(tx: HeliusEnhancedTx): boolean | null {
  const hasAlt = (tx as any)._hasAlt as boolean | undefined;
  // undefined → null（Helius Enhanced 路径拿不到 ALT 信息），便于前端区分"未知 / 确认 false / 确认 true"
  return hasAlt === undefined ? null : hasAlt;
}

/**
 * 计算 bundle_id：用于把同 bundle 的多笔 tx 串起来。
 *
 * 设计：
 *   - 同 bundle 内多笔 tx 通常 feePayer 各不相同（每个 wallet 各付各的 tip），
 *     因此 bundle_id 不能把 feePayer 算进去；否则同 bundle 的不同 tx 会被误判成不同 bundle。
 *   - 真实 bundle 内多笔 tx 共享：slot + tip account + tip amount
 *     （bundle 由 tip 账户 + tip 金额 + slot 共同标识，validator 看到的是一组同时落地）。
 *   - 没 tip 时（fallback 解析失败 / Helius Enhanced 路径）：用 (slot, hasAlt flag) 当弱 ID，
 *     不含 feePayer；这意味着 v0+ALT 同 slot 多笔会被聚合到同一 bundle_id（够用但不精确）。
 *
 * 返回 null 表示「不是 bundle」或「数据不足，无法归类」。
 */
export function computeBundleId(tx: HeliusEnhancedTx): string | null {
  if (!tx?.slot) return null;

  const tipAccount = (tx.nativeTransfers ?? []).find((t) =>
    SOLANA_TIP_ACCOUNTS.has(t.toUserAccount),
  );
  const tipAmount = tipAccount
    ? (typeof tipAccount.amount === 'string' ? Number(tipAccount.amount) : tipAccount.amount)
    : 0;

  // 没 tip 也没 ALT：肯定不是 bundle（普通 v0 legacy tx）
  if (tipAmount <= 0 && txHasAlt(tx) !== true) return null;

  // 仅用 (slot, tipAccount, tipAmount) 做 hash——feePayer 故意不参与，
  // 让同 bundle 的不同 tx 共享 bundle_id。注意 tipAccount 为空时也参与 hash，
  // 这样 hash 在「同 slot 同 ALT 但 tip 信息缺失」的场景下还能稳定聚类。
  const key = `${tx.slot}|${tipAccount?.toUserAccount ?? ''}|${tipAmount}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `bd_${(h >>> 0).toString(16).padStart(8, '0')}`;
}

/** 标准化 Helius tx 为 ParsedBuy */
export function parseHeliusTx(tx: HeliusEnhancedTx): ParsedBuy | null {
  if (!tx || !tx.signature) return null;
  if (!isBuyTx(tx)) return null;

  const mint = extractMint(tx);
  if (!mint) return null;

  return {
    signature: tx.signature,
    slot: tx.slot,
    // Helius Enhanced Webhook 推送的 payload 用 timestamp 字段（Unix 秒），
    // 而 Enhanced Transactions API / RPC parse 返回 blockTime。这里兼容两者。
    blockTime: (tx as any).blockTime ?? (tx as any).timestamp ?? 0,
    address: tx.feePayer,
    mint,
    buySol: calcBuySol(tx),
    tipSol: calcSolanaTip(tx),
    prioLamports: calcPriorityFee(tx),
    fee: tx.fee ?? 0,
    version: tx.version === 0 ? 'v0' : 'legacy',
    isBundled: isBundled(tx),
    hasAlt: txHasAlt(tx),
    bundleId: computeBundleId(tx),
    source: tx.source ?? '',
    // 0010: tip 收款渠道；命中未知收款地址时写 'unknown'，方便后续 backfill。
    tipSource: (() => {
      const t = (tx.nativeTransfers ?? []).find((nt) => SOLANA_TIP_ACCOUNTS.has(nt.toUserAccount));
      if (!t) return null;
      const src = getTipSource(t.toUserAccount);
      return src ?? 'unknown';
    })(),
    // success 判定：
    //   - Helius Enhanced Transactions API 在 tx 失败时通常带 transactionError 字段（非 null）
    //   - 拿不到时（webhook payload 等）默认 true（feePayer 已收 token = 买入成功完成）
    // 注：旧实现 `!tx.fee || true` 因 `|| true` 永远为 true，是个 dead branch。
    success: !(tx as any).transactionError,
    tokenAmount: findInboundTransfer(tx)?.tokenAmount,
  };
}

/** 从原始 RPC block 中解析 buy 交易（fallback 用） */
export function parseBlockTxs(
  block: SolanaBlock,
  targetMint: string | null,
): ParsedBuy[] {
  if (!block || !block.transactions) return [];
  const result: ParsedBuy[] = [];

  for (const wrapper of block.transactions) {
    try {
      const { transaction, meta } = wrapper;
      if (!meta || meta.err) continue; // 失败交易

      // VersionedTransaction 的 message 是 VersionedMessage，accountKeys 可能用 getter 或 getAccountKeys()
      const sig = transaction?.signatures?.[0];
      if (!sig) continue;
      const msg: any = transaction?.message;
      if (!msg) continue;
      // VersionedMessage.getAccountKeys() 在 ALT 未解析时会抛异常（公共 RPC 常见情况），
      // 改用 staticAccountKeys（v0 静态账户键，feePayer 必在其中），legacy 用 accountKeys，
      // 这样不依赖 RPC 端的 ALT 解析也能拿到 feePayer。
      const accountKeys: any[] = (msg.staticAccountKeys ?? msg.accountKeys ?? []) as any[];
      const feePayer = accountKeys[0]?.toBase58?.() ?? accountKeys[0];
      if (!feePayer) continue;

      // SOL 净流出（preBalance/postBalance 都是按账户 index 的数组，0 = feePayer）
      const preBal = meta.preBalances ?? [];
      const postBal = meta.postBalances ?? [];
      const preBal0 = preBal[0] ?? 0;
      const postBal0 = postBal[0] ?? 0;

      // 简单判断：token balance change 包含目标 mint，且为 feePayer 收入
      const postToken = meta.postTokenBalances ?? [];
      const preToken = meta.preTokenBalances ?? [];

      // 找到 feePayer 的 token balance 变化。用 (accountIndex, mint) 复合 key 防多个 mint 复用同一 ata 时的歧义。
      const preMap = new Map<string, any>();
      for (const p of preToken) preMap.set(`${p.accountIndex}-${p.mint}`, p);

      // 用 solanaTxToHeliusEnhanced 把 RPC 原始 tx 适配成 Helius 形状，
      // 这样 calcSolanaTip / calcPriorityFee 就能在 Helius Enhanced 限流时仍然
      // 从 instructions + nativeTransfers 里算出真实的 tip / prio。
      // 旧实现 tipSol 硬编码 0，导致 Helius 429 fallback 时 first_sniper_tip_sol 全 0。
      const enhanced = solanaTxToHeliusEnhanced({
        slot: (block as any).slot ?? 0,
        blockTime: block.blockTime ?? 0,
        transaction: wrapper.transaction as any,
        meta: wrapper.meta as any,
      } as TransactionResponse);
      const tipSol = enhanced ? calcSolanaTip(enhanced) : 0;
      const prioLamports = enhanced
        ? calcPriorityFee(enhanced)
        : Math.max(0, (meta.fee ?? 0) - 5000);
      const bundleId = enhanced ? computeBundleId(enhanced) : null;
      const hasAltVal = enhanced ? txHasAlt(enhanced) : null;
      const isBundledVal = enhanced ? isBundled(enhanced) : false;
      const tipSourceVal = enhanced
        ? (() => {
            const t = (enhanced.nativeTransfers ?? []).find((nt: any) =>
              SOLANA_TIP_ACCOUNTS.has(nt.toUserAccount),
            );
            if (!t) return null;
            return getTipSource(t.toUserAccount) ?? 'unknown';
          })()
        : null;

      for (const post of postToken) {
        if (post.owner !== feePayer) continue;
        if (targetMint && post.mint !== targetMint) continue;

        const pre = preMap.get(`${post.accountIndex}-${post.mint}`);
        const preAmount = pre ? Number(pre.uiTokenAmount.amount) : 0;
        const postAmount = Number(post.uiTokenAmount.amount);
        const delta = postAmount - preAmount;

        if (delta > 0) {
          // preBal0 - postBal0 是 feePayer 的 SOL 净流出（含 buy + tip + rent + fee），
          // 与 Helius 路径（buySol = buy + tip + rent，**不含** fee）口径不一致。
          // pnl.ts 已经按 soldRatio 单独扣了一次 buyFee，buySol 里再含 fee 就会被双扣。
          // 这里减掉 meta.fee 让两条路径口径对齐。
          const buySol = (preBal0 - postBal0 - (meta.fee ?? 0)) / LAMPORTS_PER_SOL;
          const isVersioned = !!msg.addressTableLookups || !!msg.staticAccountKeys;
          result.push({
            signature: sig,
            slot: 0, // block 上下文无 slot 信息，由调用方补
            blockTime: block.blockTime ?? 0,
            address: feePayer,
            mint: post.mint,
            buySol,
            tipSol,
            prioLamports,
            fee: meta.fee ?? 0,
            version: isVersioned ? 'v0' : 'legacy',
            isBundled: isBundledVal,
            hasAlt: hasAltVal,
            bundleId,
            source: '',
            tipSource: tipSourceVal,
            success: true,
            tokenAmount: delta,
          });
        }
      }
    } catch (err) {
      // 单笔 tx 解析失败不影响其它 tx，继续
      console.warn('[parseBlockTxs] skip tx:', (err as Error).message);
      continue;
    }
  }
  return result;
}

/**
 * 把 Solana 标准 RPC 的 TransactionResponse 适配成 HeliusEnhancedTx 形状，
 * 让 parseHeliusTx() 可以直接消费。这样 monitor / first-sniper 等下游代码
 * 不用关心数据是来自 Helius Enhanced API 还是免费公共 RPC。
 *
 * 适配要点：
 * - accountKeys: web3.js 的 message.staticAccountKeys(v0) 或 message.accountKeys(legacy)，
 *   accounts index 指向这一组键
 * - tokenTransfers: 从 meta.postTokenBalances - preTokenBalances 计算（owner = feePayer 时），
 *   关注 feePayer 净收入（即买入的 token）
 * - nativeTransfers: 解码 System Program::Transfer 指令（顶层 + innerInstructions），
 *   标签 2(u32 LE) + 8 bytes lamports
 * - instructions: 顶层 compiledInstructions 原文，accounts 索引展开为公钥
 * - version: web3.js v1.95 在响应顶层带 version 字段；同时检测 message.addressTableLookups 兜底
 *
 * 不依赖 Helius Enhanced API，但能输出与 Helius 兼容的形状。
 */
export function solanaTxToHeliusEnhanced(
  tx: TransactionResponse,
): HeliusEnhancedTx | null {
  try {
    if (!tx || !tx.transaction) return null;
    const t = tx.transaction as any;
    const sig: string | undefined = t.signatures?.[0];
    if (!sig) return null;

    const message: any = t.message;
    if (!message) return null;

    // accountKeys: v0 用 staticAccountKeys，legacy 用 accountKeys
    const rawKeys: any[] = (message.staticAccountKeys ?? message.accountKeys ?? []) as any[];
    const accountKeys: string[] = rawKeys.map((k: any) =>
      typeof k === 'string' ? k : (k?.toBase58?.() ?? String(k)),
    );
    if (accountKeys.length === 0) return null;
    const feePayer = accountKeys[0];

    const meta = tx.meta;
    if (!meta) return null;

    // version: 顶层 tx.version 是 web3.js v1.95+ 提供的，没有就检测 addressTableLookups
    const topVersion = (tx as any).version;
    const isVersioned =
      topVersion === 0 ||
      (typeof topVersion === 'string' && topVersion !== 'legacy') ||
      Array.isArray(message.addressTableLookups);
    const version: 'legacy' | 0 = isVersioned ? 0 : 'legacy';

    // v0 是否有 ALT（Address Lookup Table）：影响 isBundled 判定。
    // Solana 的 bundle 入口（Jito / Helius Sender bundle / LandX bundle）强制用 ALT，普通 v0 tx（无 ALT）不算 bundle。
    const hasAlt = isVersioned
      ? Array.isArray(message.addressTableLookups) && message.addressTableLookups.length > 0
      : false;

    // ----- 1) tokenTransfers：feePayer 净收入 = 买入的 token -----
    // 按 delta 倒序排（amount 大的在前），让 extractMint 的 find() 取到真正的 buy target。
    // 否则 postTokenBalances 数组顺序里，deltasmall 的 mint 可能先出现，误选为 mint。
    const tokenTransfers: NonNullable<HeliusEnhancedTx['tokenTransfers']> = [];
    const pre = meta.preTokenBalances ?? [];
    const post = meta.postTokenBalances ?? [];
    const preMap = new Map<string, any>();
    for (const p of pre) {
      preMap.set(`${p.accountIndex}-${p.mint}`, p);
    }
    const inboundCandidates: Array<{ mint: string; delta: number; owner: string; toTokenAccount: string }> = [];
    for (const po of post) {
      const key = `${po.accountIndex}-${po.mint}`;
      const preEntry = preMap.get(key);
      const preAmt = preEntry ? Number(preEntry.uiTokenAmount?.amount ?? 0) : 0;
      const postAmt = Number(po.uiTokenAmount?.amount ?? 0);
      const delta = postAmt - preAmt;
      if (delta <= 0) continue;
      if (po.owner !== feePayer) continue; // 仅 feePayer 收入 = 买入 token
      inboundCandidates.push({
        mint: po.mint,
        delta,
        owner: po.owner,
        toTokenAccount: accountKeys[po.accountIndex] ?? '',
      });
    }
    // 倒序：amount 大的 mint 排在前，extractMint 会优先选它
    inboundCandidates.sort((a, b) => b.delta - a.delta);
    for (const c of inboundCandidates) {
      tokenTransfers.push({
        fromUserAccount: '', // 公共 RPC 不直接解 fromUserAccount（pool 合约的 ata）
        toUserAccount: c.owner,
        fromTokenAccount: '',
        toTokenAccount: c.toTokenAccount,
        tokenAmount: c.delta,
        mint: c.mint,
        tokenStandard: 'Fungible',
      });
    }

    // ----- 2) nativeTransfers：解码顶层 + inner 的 System::Transfer -----
    // web3.js v1.95 不一致：顶层 CompiledInstruction 用 accountKeyIndexes，inner 用 accounts
    const nativeTransfers: NonNullable<HeliusEnhancedTx['nativeTransfers']> = [];
    const collectSystemTransfers = (ixList: any[]) => {
      for (const ix of ixList) {
        if (!ix) continue;
        let pidStr: string | undefined;
        if (typeof ix.programId === 'string') {
          pidStr = ix.programId;
        } else if (ix.programId?.toBase58) {
          pidStr = ix.programId.toBase58();
        } else if (typeof ix.programIdIndex === 'number') {
          pidStr = accountKeys[ix.programIdIndex];
        }
        if (pidStr !== SYSTEM_PROGRAM_ID) continue;
        // 顶层(accountKeyIndexes) 或 inner(accounts)
        const accounts: number[] = ix.accountKeyIndexes ?? ix.accounts ?? [];
        if (accounts.length < 2) continue;
        const rawData = ix.data;
        const data = Buffer.isBuffer(rawData)
          ? rawData
          : Buffer.from(rawData ?? '', 'base64');
        // System::Transfer: tag 2 (u32 LE) + lamports (u64 LE) = 12 bytes
        if (data.length < 12) continue;
        const tag = data.readUInt32LE(0);
        if (tag !== 2) continue;
        let lamports: number;
        try {
          lamports = Number(data.readBigUInt64LE(4));
        } catch {
          continue;
        }
        if (lamports <= 0) continue;
        const fromKey = accountKeys[accounts[0]];
        const toKey = accountKeys[accounts[1]];
        if (!fromKey || !toKey) continue;
        nativeTransfers.push({
          fromUserAccount: fromKey,
          toUserAccount: toKey,
          amount: lamports,
        });
      }
    };

    // 顶层 compiledInstructions（顶层一定存在）
    const topIxList = (message.compiledInstructions ?? message.instructions ?? []) as any[];
    collectSystemTransfers(topIxList);

    // inner instructions
    if (Array.isArray(meta.innerInstructions)) {
      for (const inner of meta.innerInstructions) {
        collectSystemTransfers(inner.instructions ?? []);
      }
    }

    // ----- 2.5) 兜底：余额差法 -----
    // 有的 tx（如 Pump.fun v0 + ALT）System::Transfer 在 inner 里也被聚合掉、或 base64 解析失败，
    // 此时 nativeTransfers 会少算 feePayer 出去的总 SOL。但 feePayer 的 preBal[0]-postBal[0]
    // 一定是 SOL 净流出 = buy + tip + fee，单独合成一个伪 transfer 让 calcBuySol 能算 buySol。
    // toUserAccount 留空，calcSolanaTip 不会误识别（它只比对 4 通道 38 个已知 tip account）。
    // 扣 fee：preBal-postBal 含 fee，而 Helius 的 calcBuySol 累加的是 nativeTransfers 中的 SOL
    // 转账（不含 fee，因为 fee 走 system program 的特定路径，不是 transfer 指令）。
    const pre0 = meta.preBalances?.[0] ?? 0;
    const post0 = meta.postBalances?.[0] ?? 0;
    const solOut = pre0 - post0;
    if (solOut > 0) {
      const alreadyOut = nativeTransfers
        .filter((t) => t.fromUserAccount === feePayer)
        .reduce((s, t) => s + (typeof t.amount === 'string' ? Number(t.amount) : t.amount), 0);
      const missing = solOut - alreadyOut - (meta.fee ?? 0);
      if (missing > 0) {
        nativeTransfers.push({
          fromUserAccount: feePayer,
          toUserAccount: '',
          amount: missing,
        });
      }
    }

    // ----- 3) instructions：顶层 + inner 合并，accounts index 展开为公钥，programId 也展开 -----
    // 为什么合并 inner：CalcPriorityFee/ComputeBudget 可能在 CPI 内（Blockworks PriorityFee program），
    // 只看顶层会漏掉 prio fee。Helius Enhanced 的 instructions 实际是扁平化顶层 + inner 的所有指令。
    const expandIx = (ix: any) => {
      let pid = '';
      if (typeof ix.programId === 'string') {
        pid = ix.programId;
      } else if (ix.programId?.toBase58) {
        pid = ix.programId.toBase58();
      } else if (typeof ix.programIdIndex === 'number') {
        pid = accountKeys[ix.programIdIndex] ?? '';
      }
      const accts: number[] = ix.accountKeyIndexes ?? ix.accounts ?? [];
      return {
        programId: pid,
        accounts: accts.map((a: number) => accountKeys[a] ?? ''),
        data: ix.data ?? '',
      };
    };
    const instructions: NonNullable<HeliusEnhancedTx['instructions']> = [
      ...topIxList.map(expandIx),
      ...((meta.innerInstructions ?? []).flatMap((inner: any) =>
        (inner.instructions ?? []).map(expandIx),
      )),
    ];

    // ----- 4) source：仅按顶层 programId 找首个已知 DEX（inner 里的 CPI 不算） -----
    let source = '';
    for (const raw of topIxList) {
      let pid = '';
      const idx = raw.programIdIndex;
      if (typeof raw.programId === 'string') {
        pid = raw.programId;
      } else if (raw.programId?.toBase58) {
        pid = raw.programId.toBase58();
      } else if (typeof idx === 'number') {
        pid = accountKeys[idx] ?? '';
      }
      if (pid && PROGRAM_SOURCE_MAP[pid]) {
        source = PROGRAM_SOURCE_MAP[pid];
        break;
      }
    }

    return {
      signature: sig,
      slot: tx.slot,
      blockTime: tx.blockTime ?? 0,
      fee: meta.fee ?? 0,
      feePayer,
      version,
      tokenTransfers,
      nativeTransfers,
      instructions,
      source,
      // 内部标记：fallback 是否观察到 Address Lookup Table，被 isBundled 读取
      _hasAlt: hasAlt,
    } as HeliusEnhancedTx & { _hasAlt: boolean };
  } catch (err) {
    console.warn('[solanaTxToHeliusEnhanced] failed:', (err as Error).message);
    return null;
  }
}
