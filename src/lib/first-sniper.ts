/**
 * 第一个狙击者识别 & 跟随者分析
 * 给定某个目标地址的一笔 buy，找出同 slot 内买入同 mint 的所有交易，
 * 然后识别第一个狙击者（最早买入的）、跟随者、自己账号。
 */

import { query, queryOne } from './db';
import { getHelius } from './helius';
import { getRPC } from './solana-rpc';
import { parseHeliusTx, parseBlockTxs, type ParsedBuy } from './parser';
import type { BlockBuyer } from './types';

/**
 * 对一个目标交易做 block 级深度分析
 * - 同 slot 内买入同 mint 的所有交易
 * - 同 slot + 下一 slot 也算（用于找跟随者）
 */
export async function analyzeBlock(slot: number, mint: string, targetSig: string): Promise<{
  blockIndex: number;
  offsetMs: number;
  signature: string;
  address: string;
  buySol: number;
  tipSol: number;
  prioLamports: number;
  result: 'success' | 'failed';
  version: string;
  isBundled: boolean;
  mark: 'first_sniper' | 'target' | 'follower' | 'own' | 'pre_target';
}[]> {
  const rpc = getRPC();
  const helius = getHelius();

  // 1) 先获取目标交易详细信息（建立时间基准）
  let targetBlockTime = 0;
  let targetBuy = await fetchBuyBySig(targetSig);
  if (!targetBuy) {
    try {
      const enhanced = await helius.parseTransaction(targetSig);
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

  // 2) 拉取整个 slot 的交易
  let block;
  try {
    block = await rpc.getBlock(slot, { transactionDetails: 'full' });
  } catch (err) {
    console.error('[analyzeBlock] getBlock failed', err);
    return [];
  }
  if (!block) return [];

  // 3) 解析出所有买入 mint 的 tx
  const allBuys = parseBlockTxs(block, mint);

  // 4) 用 Helius 增强补充 TIP 和 PRIO（批量）
  const sigs = allBuys.map((b) => b.signature);
  let enhancedMap = new Map<string, ReturnType<typeof parseHeliusTx>>();
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

  // 5) 取自己的钱包列表
  const ownWallets = (await query<{ address: string }>('SELECT address FROM own_wallets')).map((w) => w.address);
  const ownSet = new Set(ownWallets);

  // 6) 排序：block 内顺序（默认就是数组顺序），offsetMs 用 blockTime 估算
  const enriched = allBuys.map((b) => {
    const e = enhancedMap.get(b.signature);
    return {
      buy: e ?? b,
      offsetMs: targetBlockTime ? (b.blockTime - targetBlockTime) * 1000 : 0,
    };
  });

  // 7) 给每笔打标
  // 第一个狙击者 = 在目标之前的最早买入
  // 跟随者 = 目标之后的买入
  // 我的账号 = ownSet
  // 前置 = 在目标之前但不是第一个狙击者
  let firstSniperMarked = false;
  const result = enriched
    .sort((a, b) => a.offsetMs - b.offsetMs)
    .map(({ buy, offsetMs }, idx) => {
      let mark: 'first_sniper' | 'target' | 'follower' | 'own' | 'pre_target';
      if (buy.signature === targetSig) {
        mark = 'target';
      } else if (ownSet.has(buy.address)) {
        mark = 'own';
      } else if (offsetMs < 0) {
        // 在目标之前
        if (!firstSniperMarked) {
          mark = 'first_sniper';
          firstSniperMarked = true;
        } else {
          mark = 'pre_target';
        }
      } else {
        mark = 'follower';
      }

      return {
        blockIndex: idx,
        offsetMs: Math.round(offsetMs),
        signature: buy.signature,
        address: buy.address,
        buySol: buy.buySol,
        tipSol: buy.tipSol,
        prioLamports: buy.prioLamports,
        result: buy.success ? ('success' as const) : ('failed' as const),
        version: buy.version,
        isBundled: buy.isBundled,
        mark,
      };
    });

  return result;
}

/** 通过签名查 buy 信息（DB 优先） */
async function fetchBuyBySig(signature: string): Promise<ParsedBuy | null> {
  const row = await queryOne<any>(`
    SELECT signature, slot, block_time, target_address AS address, mint, buy_sol,
           target_tip_sol AS tip_sol, target_prio_lamports AS prio_lamports, 'success'::text AS success,
           COALESCE(version, 'legacy') AS version, COALESCE(is_bundled, false) AS is_bundled, '' AS source
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
  buyers: Awaited<ReturnType<typeof analyzeBlock>>,
): Promise<number> {
  const { withTransaction } = await import('./db');
  return withTransaction(async (client) => {
    // upsert block_analyses
    const existing = await client.query(
      'SELECT id FROM block_analyses WHERE slot = $1 AND mint = $2',
      [slot, mint],
    );
    let analysisId: number;
    if (existing.rowCount && existing.rowCount > 0) {
      analysisId = existing.rows[0].id;
      await client.query('DELETE FROM block_buyers WHERE block_analysis_id = $1', [analysisId]);
    } else {
      const ins = await client.query(
        `INSERT INTO block_analyses (slot, mint, target_signature, block_time)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [slot, mint, targetSig, blockTime],
      );
      analysisId = ins.rows[0].id;
    }

    // 插入每个 buyer
    for (const b of buyers) {
      await client.query(
        `INSERT INTO block_buyers (
           block_analysis_id, slot, block_index, offset_ms, signature, address,
           buy_sol, tip_sol, prio_lamports, is_first_sniper, is_follower, is_own, is_pre_target,
           result, version, is_bundled
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          analysisId,
          slot,
          b.blockIndex,
          b.offsetMs,
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
        ],
      );
    }
    return analysisId;
  });
}

/** 从 DB 读出 block 分析 */
export async function getBlockAnalysis(slot: number, mint: string): Promise<{
  analysis: { id: number; slot: number; mint: string; target_signature: string; block_time: string };
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
