/**
 * 第一个狙击者识别 & 跟随者分析
 * 给定某个目标地址的一笔 buy，找出同 slot 与下一 slot 内买入同 mint 的所有交易，
 * 然后识别第一个狙击者（最早买入的）、跟随者、自己账号。
 */

import { query, queryOne } from './db';
import { getHelius } from './helius';
import { getRPC } from './solana-rpc';
import { parseHeliusTx, parseBlockTxs, type ParsedBuy } from './parser';
import type { BlockBuyer } from './types';

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
  result: 'success' | 'failed';
  version: string;
  isBundled: boolean;
  hasAlt: boolean | null;
  bundleId: string | null;
  mark: 'first_sniper' | 'target' | 'follower' | 'own' | 'pre_target';
}

export interface AnalyzeResult {
  buyers: AnalyzeBuyer[];
  /** 目标 tx 在 block 内的位置索引（块内第 N 笔，从 0 开始） */
  targetBlockIndex: number | null;
  sameSlotCount: number;
  nextSlotCount: number;
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
  };

  // 1) 先获取目标交易详细信息（建立时间基准）
  let targetBlockTime = 0;
  let targetBuy = await fetchBuyBySig(targetSig);
  if (!targetBuy) {
    try {
      // 走 Helius Enhanced → 公共 RPC 的 fallback，避免 Helius 限流时拿不到目标 tx
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
  let block;
  try {
    block = await rpc.getBlock(slotNum, { transactionDetails: 'full' });
  } catch (err) {
    console.error('[analyzeBlock] getBlock failed', err);
    return emptyResult;
  }
  if (!block) return emptyResult;

  // 3) 解析出所有买入 mint 的 tx（同 slot）
  //    rpc.getBlock 返回的是 @solana/web3.js 的 BlockResponse（versioned transaction）
  //    parseBlockTxs 内部已经兼容（message 用 any），这里 cast 一下绕开 TS 结构差异
  const sameSlotBuys = parseBlockTxs(block as any, mint);

  // 4) 尝试拉取下一 slot 的交易（跟随者通常落在 slot+1）
  let nextSlotBuys: ParsedBuy[] = [];
  try {
    const nextBlock = await rpc.getBlock(slotNum + 1, { transactionDetails: 'full' });
    if (nextBlock) {
      nextSlotBuys = parseBlockTxs(nextBlock as any, mint);
    }
  } catch (err) {
    // 下一 slot 可能尚未确认/已跳过，静默失败
    console.warn('[analyzeBlock] getBlock next slot failed', err);
  }

  // 5) 用 Helius 增强补充 TIP 和 PRIO（批量）— 含两个 slot 的 sigs
  const allRawBuys = [
    ...sameSlotBuys.map((b) => ({ ...b, _slot: slotNum })),
    ...nextSlotBuys.map((b) => ({ ...b, _slot: slotNum + 1 })),
  ];
  const sigs = allRawBuys.map((b) => b.signature);
  let enhancedMap = new Map<string, NonNullable<ReturnType<typeof parseHeliusTx>>>();
  if (sigs.length > 0 && sigs.length <= 100) {
    try {
      const enhancedList = await helius.parseTransactions(sigs);
      enhancedMap = new Map(
        enhancedList
          .map((e) => [e.signature, parseHeliusTx(e)] as const)
          .filter(([, v]) => v !== null) as Array<[string, NonNullable<ReturnType<typeof parseHeliusTx>>]>,
      );
    } catch (err) {
      console.warn('[analyzeBlock] enhanced parse failed, fall back to RPC only', err);
    }
  }

  // 6) 取自己的钱包列表
  const ownWallets = (await query<{ address: string }>('SELECT address FROM own_wallets')).map((w) => w.address);
  const ownSet = new Set(ownWallets);

  // 7) 合并并排序：同 slot 按 blockIndex 升序，跨 slot 时同 slot 在前
  type Enriched = { buy: ParsedBuy; slot: number; slotOffset: 0 | 1; offsetMs: number; enrichedBuy: NonNullable<ReturnType<typeof parseHeliusTx>> | ParsedBuy };
  const enriched: Enriched[] = allRawBuys.map((b) => {
    const e = enhancedMap.get(b.signature);
    return {
      buy: e ?? b,
      slot: b._slot,
      slotOffset: b._slot === slotNum ? 0 : 1,
      offsetMs: targetBlockTime ? (b.blockTime - targetBlockTime) * 1000 : 0,
      enrichedBuy: e ?? b,
    };
  });

  // 同 slot 内：维持 getBlock 返回顺序（≈ block_index）。跨 slot 的排在后。
  // 给每笔打一个统一 block_index
  const ordered = [...enriched].sort((a, b) => {
    if (a.slotOffset !== b.slotOffset) return a.slotOffset - b.slotOffset;
    // 同 slot 内按 enhanced 数组原顺序（即 parseBlockTxs 输出顺序）保持
    return enriched.indexOf(a) - enriched.indexOf(b);
  });

  // 8) 找出目标的 block_index
  const targetEntryIdx = ordered.findIndex((e) => e.buy.signature === targetSig);
  const targetBlockIndex = targetEntryIdx >= 0 ? targetEntryIdx : null;

  // 9) 给每笔打标 + 计算 offsetPos
  let firstSniperMarked = false;
  const buyers: AnalyzeBuyer[] = ordered.map((e, idx) => {
    let mark: AnalyzeBuyer['mark'];
    if (e.buy.signature === targetSig) {
      mark = 'target';
    } else if (ownSet.has(e.buy.address)) {
      mark = 'own';
    } else if (e.slotOffset === 0 && idx < targetEntryIdx) {
      // 同 slot 内、目标之前
      if (!firstSniperMarked) {
        mark = 'first_sniper';
        firstSniperMarked = true;
      } else {
        mark = 'pre_target';
      }
    } else {
      // 同 slot 内目标之后，或下一 slot
      mark = 'follower';
    }

    return {
      blockIndex: idx,
      offsetPos: e.slotOffset === 0 && targetBlockIndex !== null ? idx - targetBlockIndex : null,
      offsetMs: Math.round(e.offsetMs),
      slotOffset: e.slotOffset,
      signature: e.buy.signature,
      address: e.buy.address,
      buySol: e.buy.buySol,
      tipSol: e.buy.tipSol,
      prioLamports: e.buy.prioLamports,
      result: e.buy.success ? 'success' : 'failed',
      version: e.buy.version,
      isBundled: e.buy.isBundled,
      hasAlt: e.buy.hasAlt ?? null,
      bundleId: e.buy.bundleId ?? null,
      mark,
    };
  });

  // 如果 parser 漏掉了 target 那笔 buy，标记 first_sniper 为目标之前最早的
  if (targetBlockIndex === null && buyers.length > 0) {
    // 兜底：仍选同 slot 中目标之前的第一笔作为 first_sniper
    // 这里我们无法知道目标在 block 中的精确位置，跳过
  }

  const sameSlotCount = buyers.filter((b) => b.slotOffset === 0).length;
  const nextSlotCount = buyers.filter((b) => b.slotOffset === 1).length;

  return {
    buyers,
    targetBlockIndex,
    sameSlotCount,
    nextSlotCount,
  };
}

/** 通过签名查 buy 信息（DB 优先） */
async function fetchBuyBySig(signature: string): Promise<ParsedBuy | null> {
  const row = await queryOne<any>(`
    SELECT signature, slot, block_time, target_address AS address, mint, buy_sol,
           target_tip_sol AS tip_sol, target_prio_lamports AS prio_lamports, 'success'::text AS success,
           COALESCE(version, 'legacy') AS version, COALESCE(is_bundled, false) AS is_bundled,
           has_alt, bundle_id, '' AS source
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
    fee: 0,
    version: row.version,
    isBundled: row.is_bundled,
    hasAlt: row.has_alt ?? null,
    bundleId: row.bundle_id ?? null,
    source: row.source,
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
    const existing = await client.query(
      'SELECT id FROM block_analyses WHERE slot = $1 AND mint = $2',
      [slot, mint],
    );
    let analysisId: number;
    if (existing.rowCount && existing.rowCount > 0) {
      analysisId = existing.rows[0].id;
      await client.query('DELETE FROM block_buyers WHERE block_analysis_id = $1', [analysisId]);
      await client.query(
        `UPDATE block_analyses
           SET target_signature = $2,
               block_time = $3,
               target_block_index = $4,
               same_slot_count = $5,
               next_slot_count = $6
         WHERE id = $1`,
        [
          analysisId,
          targetSig,
          blockTime,
          result.targetBlockIndex,
          result.sameSlotCount,
          result.nextSlotCount,
        ],
      );
    } else {
      const ins = await client.query(
        `INSERT INTO block_analyses (
           slot, mint, target_signature, block_time,
           target_block_index, same_slot_count, next_slot_count
         ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          slot,
          mint,
          targetSig,
          blockTime,
          result.targetBlockIndex,
          result.sameSlotCount,
          result.nextSlotCount,
        ],
      );
      analysisId = ins.rows[0].id;
    }

    // 插入每个 buyer
    // bundle_size 统计：先插完所有 buyer，再统一回填（按 bundle_id 聚合）
    const bundleIdCounts = new Map<string, number>();
    for (const b of result.buyers) {
      await client.query(
        `INSERT INTO block_buyers (
           block_analysis_id, slot, block_index, offset_pos, offset_ms, slot_offset,
           signature, address, buy_sol, tip_sol, prio_lamports,
           is_first_sniper, is_follower, is_own, is_pre_target,
           result, version, is_bundled,
           has_alt, bundle_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
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
          b.mark === 'first_sniper',
          b.mark === 'follower',
          b.mark === 'own',
          b.mark === 'pre_target',
          b.result,
          b.version,
          b.isBundled,
          b.hasAlt,
          b.bundleId,
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
