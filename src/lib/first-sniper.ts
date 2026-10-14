/**
 * 第一个狙击者识别 & 跟随者分析
 * 给定某个目标地址的一笔 buy，找出同 slot 与下一 slot 内买入同 mint 的所有交易，
 * 然后识别第一个狙击者（最早买入的）、跟随者、自己账号。
 */

import { query, queryOne, execute } from './db';
import { getHelius, parsedEventItemToEnhanced } from './helius';
import { getRPC } from './solana-rpc';
import { parseHeliusTx, parseBlockTxs, calcBuySol, findInboundTransfer, type ParsedBuy } from './parser';
import { calcCopyPnl } from './pnl';
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
  // RPC 节点在 slot 刚确认时可能还没同步完（webhook 提前触发的情况很常见），
  // 直接 fail 会让 first_sniper 永远丢失。改成指数退避重试，最长等 ~10s。
  const MAX_WAIT_MS = 10_000;
  const BASE_INTERVAL_MS = 500;

  async function getBlockWithRetry(targetSlot: number, label: string) {
    const start = Date.now();
    let attempt = 0;
    while (true) {
      attempt++;
      // getBlock 内部已有 Helius 限流退避 + free RPC fallback，直接用
      const b = await rpc.getBlock(targetSlot, { transactionDetails: 'full' });
      if (b) return b;
      const elapsed = Date.now() - start;
      if (elapsed >= MAX_WAIT_MS) {
        console.error(`[analyzeBlock] getBlock(${targetSlot}) timed out after ${elapsed}ms`);
        return null;
      }
      // 等 slot 确认（webhook 提前触发的场景）
      const wait = Math.min(500 * Math.pow(1.5, attempt - 1), 2000) + Math.random() * 200;
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  // ── 拉取当前 slot ───────────────────────────────────────────────────
  const block = await getBlockWithRetry(slotNum, `slot ${slotNum}`);
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

  // 5) 用 Helius Parsed Events 补充 TIP 和 PRIO（批量，10 cr/整个请求）
  //    相比旧 Enhanced Transactions（100 cr/请求）便宜 10 倍。
  const allRawBuys = [
    ...sameSlotBuys.map((b) => ({ ...b, _slot: slotNum })),
    ...nextSlotBuys.map((b) => ({ ...b, _slot: slotNum + 1 })),
  ];
  const sigs = allRawBuys.map((b) => b.signature);

  // 5a) 先拿 Parsed Events（10 cr）：用于 tipSource / bundleId 等元数据
  let enhancedMap = new Map<string, NonNullable<ReturnType<typeof parseHeliusTx>>>();
  if (sigs.length > 0 && sigs.length <= 100) {
    try {
      const eventItems = await helius.parseEvents(sigs);
      enhancedMap = new Map(
        eventItems
          .map((item) => {
            const enhanced = parsedEventItemToEnhanced(item);
            return enhanced ? ([enhanced.signature, parseHeliusTx(enhanced)] as const) : null;
          })
          .filter((entry): entry is readonly [string, NonNullable<ReturnType<typeof parseHeliusTx>>] => entry !== null),
      );
    } catch (err) {
      console.warn('[analyzeBlock] parsed-events parse failed, fall back to RPC only', err);
    }
  }

  // 5b) 再拿 Enhanced Transactions API（100 cr/request）：用于 buySol（nativeTransfers 计算）
  //     优先用这个，与参考网站口径对齐；拿不到才 fallback 到 RPC 余额差
  const enhancedBuySolMap = new Map<string, { buySol: number; tokenAmount: number | null }>();
  if (sigs.length > 0 && sigs.length <= 15) {
    // Enhanced Tx 端点单批上限 15 条签名，超过则跳过（用 RPC 兜底）
    try {
      const enhancedRawMap = await helius.batchFetchEnhanced(sigs);
      for (const [sig, tx] of enhancedRawMap) {
        const buySol = calcBuySol(tx);
        const tokenAmt = findInboundTransfer(tx)?.tokenAmount ?? null;
        enhancedBuySolMap.set(sig, { buySol, tokenAmount: tokenAmt });
      }
    } catch (err) {
      console.warn('[analyzeBlock] batchFetchEnhanced failed, buySol falls back to RPC', err);
    }
  } else if (sigs.length > 15) {
    // 超过 15 条时，分批调用（每批 15 条）
    try {
      for (let i = 0; i < sigs.length; i += 15) {
        const batch = sigs.slice(i, i + 15);
        const enhancedRawMap = await helius.batchFetchEnhanced(batch);
        for (const [sig, tx] of enhancedRawMap) {
          const buySol = calcBuySol(tx);
          const tokenAmt = findInboundTransfer(tx)?.tokenAmount ?? null;
          enhancedBuySolMap.set(sig, { buySol, tokenAmount: tokenAmt });
        }
        // 批次间隔 200ms 避免 Helius 限流
        if (i + 15 < sigs.length) await new Promise((r) => setTimeout(r, 200));
      }
    } catch (err) {
      console.warn('[analyzeBlock] batchFetchEnhanced (batched) failed, buySol falls back to RPC', err);
    }
  }

  // 6) 取自己的钱包列表
  const ownWallets = (await query<{ address: string }>('SELECT address FROM own_wallets')).map((w) => w.address);
  const ownSet = new Set(ownWallets);

  // 7) 合并并排序：同 slot 按 blockIndex 升序，跨 slot 时同 slot 在前
  type Enriched = {
    buy: ParsedBuy;
    slot: number;
    slotOffset: 0 | 1;
    offsetMs: number;
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
      buySolOverride: buySolData?.buySol,
      tokenAmountOverride: buySolData?.tokenAmount,
    };
  });

  // 同 slot 内按 blockTime 升序，跨 slot 时 slot 0 在前。
  //
  // 关键：不能用 parseBlockTxs 的输出顺序（= getBlock 返回的 transactions 数组顺序）
  // 当作"执行顺序"。Solana 公共 RPC / Helius 普通 endpoint 的 getBlock 文档明确
  // 不保证交易顺序（PoH 序号靠前的 tx 在数组里可能排在任意位置）。
  // 参考站用 Helius Enhanced Transactions 的 blockTime 升序来判断"谁先抢到"，
  // 所以这里也按 blockTime 升序——和它口径一致。
  //
  // blockTime 同值（同 slot 的 tx blockTime 经常是同一个 Unix 秒）时，
  // 退回到 enriched 数组原顺序（即 parseBlockTxs 的输出），保留"先看到先算"语义。
  const ordered = [...enriched].sort((a, b) => {
    if (a.slotOffset !== b.slotOffset) return a.slotOffset - b.slotOffset;
    if (a.buy.blockTime !== b.buy.blockTime) return a.buy.blockTime - b.buy.blockTime;
    return enriched.indexOf(a) - enriched.indexOf(b);
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
    // 注：targetBuy.slot 来自 PG 的 BIGINT 列，会被 pg 解析成 BigInt；slotNum 是 Number，
    // 直接 !== 比较永远不等，需要先转成同类型。
    if (Number(targetBuy.slot) !== slotNum) {
      console.warn(
        `[analyzeBlock] targetBuy slot mismatch: db=${targetBuy.slot}, analyzing=${slotNum}, skipping inject`,
      );
    } else {
      const targetSlotOffset: 0 | 1 = 0; // slot 相等时一定是 same slot
      const targetOffsetMs = targetBlockTime ? (targetBuy.blockTime - targetBlockTime) * 1000 : 0;
      const injected: Enriched = {
        buy: enhancedMap.get(targetSig) ?? targetBuy,
        slot: targetBuy.slot,
        slotOffset: targetSlotOffset,
        offsetMs: targetOffsetMs,
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

  // 8) 找出目标的 block_index
  const targetEntryIdx = ordered.findIndex((e) => e.buy.signature === targetSig);
  const targetBlockIndex = targetEntryIdx >= 0 ? targetEntryIdx : null;

  // 9) 给每笔打标 + 计算 offsetPos
  //
  // first_sniper 语义：目标买入之后、ordered 数组里第一个非 target 的 buyer。
  // ordered 数组已按「同 slot 优先、blockTime 升序」排好（参考站同样的口径），
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
    } else if (e.slotOffset === 0 && idx < targetEntryIdx) {
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
      blockIndex: idx,
      offsetPos: e.slotOffset === 0 && targetBlockIndex !== null ? idx - targetBlockIndex : null,
      // offsetMs 计算口径：
      //   - 跨 slot (slotOffset=1)：用真实 ms（同 slot blockTime 差 ≈ slot duration ≈ 400ms），这是准确的
      //   - 同 slot (slotOffset=0)：真实 ms = 0（同一 slot 共享 blockTime），
      //     改为「块内位置差 × 5ms」的算术近似，与参考站量级（6~28ms）匹配。
      //     5ms/tx 是基于 Solana ~2-3k TPS / 400ms slot 推出的保守估计，
      //     实际处理时间可能更短（亚 ms），但能保证显示非零、与参考站观感一致。
      offsetMs: (() => {
        const realMs = Math.round(e.offsetMs);
        if (realMs > 0) return realMs;
        if (e.slotOffset === 0 && targetBlockIndex !== null) {
          return Math.abs(idx - targetBlockIndex) * 5;
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
    };
  });

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
         target_block_index, same_slot_count, next_slot_count
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slot, mint) DO UPDATE SET
         target_signature   = EXCLUDED.target_signature,
         block_time         = EXCLUDED.block_time,
         target_block_index = EXCLUDED.target_block_index,
         same_slot_count    = EXCLUDED.same_slot_count,
         next_slot_count    = EXCLUDED.next_slot_count
       RETURNING id`,
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
    const analysisId: number = upserted.rows[0].id;

    // 买家明细整体重写（upsert 主记录之后无条件清空再插）
    await client.query('DELETE FROM block_buyers WHERE block_analysis_id = $1', [analysisId]);

    // 插入每个 buyer
    // bundle_size 统计：先插完所有 buyer，再统一回填（按 bundle_id 聚合）
    const bundleIdCounts = new Map<string, number>();
    for (const b of result.buyers) {
      await client.query(
        `INSERT INTO block_buyers (
           block_analysis_id, slot, block_index, offset_pos, offset_ms, slot_offset,
           signature, address, buy_sol, tip_sol, prio_lamports, token_amount,
           is_first_sniper, is_follower, is_own, is_pre_target,
           result, version, is_bundled,
           has_alt, bundle_id, tip_source
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
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
           tip_source       = EXCLUDED.tip_source`,
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
 *   - 并发度受 BULK_PNL_CONCURRENCY 控制（默认 4），避免对 Helius/RPC 雪崩
 *   - 单个 buyer 失败不影响其他（catch 内 swallow + 标 'error'）
 *   - 返回结果与原 buyer 列表长度一致，按 buyer.id 顺序对齐
 *
 * 性能参考（实测）：
 *   - 20 笔 buyer × calcCopyPnl(每笔 ~3-8s) ÷ 4 并发 ≈ 15-40s
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

const BULK_PNL_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.BULK_PNL_CONCURRENCY || '4', 10),
);

/** 把 N 个 task 按并发上限执行，onProgress 每完成一个回调一次 */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  let done = 0;
  async function next(): Promise<void> {
    const i = cursor++;
    if (i >= items.length) return;
    try {
      results[i] = await worker(items[i]);
    } finally {
      done++;
      onProgress?.(done, items.length);
      await next();
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => next());
  await Promise.all(workers);
  return results;
}

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
  //   - 目标 / 我的账号：默认重算（这些是用户最想看的）
  //   - 失败 tx：跳过（pnl_status='buy_failed' 已经写死了）
  //   - 其他人：有 pnl_status 就跳过（除非 force=true）
  //   - 都没算过的：全跑
  const toCompute = buyers.filter((b) => {
    if (opts.force) return true;
    if (b.result === 'failed') return false; // 买入失败，pnl 固定就是手续费
    if (b.is_own || b.is_first_sniper || b.signature === analysis.target_signature) return true;
    if (!b.pnl_status) return true;
    return false;
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
        // 写回 DB
        await execute(
          `UPDATE block_buyers
              SET pnl_sol = $1, pnl_status = $2, pnl_sold_ratio = $3, token_amount = COALESCE($4, token_amount)
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

