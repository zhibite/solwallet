/**
 * Solana 交易解析模块
 * 输入：Helius Enhanced Transaction 或公共 RPC 原始交易
 * 输出：标准化 buy 信息（MINT / SOL 数量 / TIP / PRIO / 是否 bundled）
 *
 * 关键概念：
 * - buy_sol: 实际买入花了多少 SOL（preBalance - postBalance, 减去 rent / fee）
 * - tip_sol: 给 validator 的小费
 * - prio_lamports: 优先级费 (compute unit price * CU)
 * - bundled: 是否是 jito bundle 内交易（通过 ALT / 同一 slot 内 5+ 笔极短时间内发送判断）
 * - version: 'v0' 表示地址表交易（含 ALT），'legacy' 表示传统交易
 */

import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { HeliusEnhancedTx, SolanaBlock } from './types';

const LAMPORTS_PER_SOL = 1_000_000_000;

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
  source: string;           // pump.fun / raydium / jupiter 等
  success: boolean;
  tokenAmount?: number;
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
  const inbound = tx.tokenTransfers.find((t) => t.toUserAccount === tx.feePayer);
  if (inbound) return inbound.mint;

  // 否则取 amount 最大的
  const sorted = [...tx.tokenTransfers].sort((a, b) => (b.tokenAmount || 0) - (a.tokenAmount || 0));
  return sorted[0]?.mint ?? null;
}

/** 计算买入花费的 SOL（含 jito tip 与 priority fee） */
export function calcBuySol(tx: HeliusEnhancedTx): number {
  // SOL 净流出 = preBalance - postBalance，再扣 fee 即 buy 金额
  // 但 tx 没有直接给 preBalance/postBalance，所以从 nativeTransfers 推算
  if (!tx.nativeTransfers) return 0;

  const outLamports = tx.nativeTransfers
    .filter((t) => t.fromUserAccount === tx.feePayer)
    .reduce((sum, t) => sum + t.amount, 0);

  // 转换 lamports -> SOL（再加回 fee 与 tip 才是真正的 buy 支出）
  // 但注意：fee 与 tip 都在 nativeTransfers 中体现（如果是 tip，则有 transfer 给 tip account）
  // 我们这里用 rough estimate: outLamports / 1e9
  return outLamports / LAMPORTS_PER_SOL;
}

/** 计算 jito tip（转账给 8 个 jito tip account 中的一个） */
export function calcJitoTip(tx: HeliusEnhancedTx): number {
  if (!tx.nativeTransfers) return 0;
  const JITO_TIP_ACCOUNTS = [
    '96gYZGLnJYVFmbLzopPSmXAwG5Mo2ckB8Z7uVwYxiwQ5',
    'ADuotR6KkC1i2sccT6RP3jMMLzrEgzVa4LAmQ4ZmFn3J',
    'DttWaMuVvTiduZRnguL7h9xJm5wP3iYpfkRJTg3MWBPJ',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPd1deFiritQLxj9',
    'HFqU5x63VTqvQss8hp11i4wV8JEodzctd55h2P8iF4jH',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLv9Y',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcUWND9jf',
  ];
  const tipSet = new Set(JITO_TIP_ACCOUNTS);

  const tipLamports = tx.nativeTransfers
    .filter((t) => tipSet.has(t.toUserAccount))
    .reduce((sum, t) => sum + t.amount, 0);

  return tipLamports / LAMPORTS_PER_SOL;
}

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
  return Math.floor((cuPrice * cu) / 1_000_000); // lamports
}

/** 是否为 bundled transaction（含 Address Lookup Table） */
export function isBundled(tx: HeliusEnhancedTx): boolean {
  // v0 + 有 ALT 通常是 jito bundle
  return tx.version === 0;
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
    tipSol: calcJitoTip(tx),
    prioLamports: calcPriorityFee(tx),
    fee: tx.fee ?? 0,
    version: tx.version === 0 ? 'v0' : 'legacy',
    isBundled: isBundled(tx),
    source: tx.source ?? '',
    success: !tx.fee || true, // fee 存在表示已上链；err 信息在 events
    tokenAmount: tx.tokenTransfers?.[0]?.tokenAmount,
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

      // 找到 feePayer 的 token balance 变化
      for (const post of postToken) {
        if (post.owner !== feePayer) continue;
        if (targetMint && post.mint !== targetMint) continue;

        const pre = preToken.find((p) => p.accountIndex === post.accountIndex);
        const preAmount = pre ? Number(pre.uiTokenAmount.amount) : 0;
        const postAmount = Number(post.uiTokenAmount.amount);
        const delta = postAmount - preAmount;

        if (delta > 0) {
          const solOut = (preBal0 - postBal0) / LAMPORTS_PER_SOL;
          result.push({
            signature: sig,
            slot: 0,
            blockTime: block.blockTime ?? 0,
            address: feePayer,
            mint: post.mint,
            buySol: solOut,
            tipSol: 0,    // RPC fallback 难算 tip
            prioLamports: (meta.fee ?? 0) - 5000,
            fee: meta.fee ?? 0,
            version: 'legacy',
            isBundled: false,
            source: '',
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
