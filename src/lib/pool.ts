/**
 * 池子 (Pool) —— 自动发现 / 递归归池
 *
 * 核心流程:
 *   1) 从 monitored_targets seed 开始
 *   2) 对每个 target 的最近 N 笔 buy 触发过的 block_buyers 做扫描
 *      - mark in (first_sniper, follower, pre_target) 的地址 = 该 target 的「跟随者」
 *   3) 聚合到 pool_members (地址、角色、出现次数、跟随目标列表)
 *   4) 聚合到 pool_edges (follower -> target 关系)
 *   5) freq 高于阈值的 pool_member 自动 promote 到 monitored_targets
 *   6) 进入下一轮 BFS（深度 BFS，可设上限）
 *
 * 触发点:
 *   - monitor.ts 的 ingestTargetTrade: 每次新增 target_trades 后异步触发本 target 的增量扫描
 *   - pool-worker.ts: 定时全量 BFS + 重新计算决策
 */

import { query, queryOne, execute, withTransaction } from './db';

// 调优参数（可通过 env 覆盖）
const SCAN_TRADES_PER_TARGET = parseInt(process.env.POOL_SCAN_TRADES || '20', 10);
const PROMOTE_FREQ_THRESHOLD = parseInt(process.env.POOL_PROMOTE_FREQ || '3', 10); // 至少 N 次才晋升
const PROMOTE_MIN_DISTINCT_TARGETS = parseInt(process.env.POOL_PROMOTE_DISTINCT || '2', 10); // 至少跟过 N 个独立 target
const PROMOTE_DEFAULT_THRESHOLD = parseFloat(process.env.POOL_PROMOTE_THRESHOLD || '0.5');
const BFS_MAX_DEPTH = parseInt(process.env.POOL_BFS_DEPTH || '3', 10);

export interface PoolMember {
  id: number;
  address: string;
  label: string | null;
  role: 'first_sniper' | 'follower' | 'both';
  freq: number;
  seen_as_first_sniper: number;
  seen_as_follower: number;
  distinct_targets: number;
  target_addresses: string[];
  mints_sample: string[];
  avg_buy_sol: number;
  avg_offset_pos: number;
  first_seen_at: string;
  last_seen_at: string;
  worth_score: number | null;
  recommended_tip_sol: number | null;
  recommended_prio_lamports: number | null;
  score_updated_at: string | null;
  promoted_to_target: boolean;
  promoted_at: string | null;
  notes: string | null;
  // AKBot 用户标记（见 migrations/0006_akbot_tag.sql）
  is_akbot: boolean;
  akbot_detected_at: string | null;
  akbot_evidence_sig: string | null;
  akbot_evidence_slot: number | null;
}

/**
 * 把一个地址标记为 AKBot 用户。幂等：已经是 true 就不动 evidence。
 * - 证据签名/时间以「最早」写入的那笔为准，避免后到的覆盖前面的
 * - 返回 true 表示这行确实被写成了 is_akbot=true（新增或翻转）；false 表示
 *   参数非法或该地址本来就是 true
 *
 * 为什么是 upsert 而不是 UPDATE：
 *   实时检测的对象是「这个 block 里刚出现的新买家」，它们绝大多数还没被
 *   scanForTarget 写进 pool_members。原来的纯 UPDATE 在这种地址上影响 0 行，
 *   既不报错也无返回值，调用方照样打 "akbot detected" 日志 —— 命中率静默归零。
 *   改成 ON CONFLICT DO UPDATE 后，池外地址也能落标记。
 */
export async function markAsAkbot(
  address: string,
  evidenceSig: string,
  blockTime: number | null | undefined,
  slot: number | null | undefined,
): Promise<boolean> {
  // evidence sig 必须是字符串（且非空）
  if (!address || !evidenceSig) return false;
  const detectedAt =
    typeof blockTime === 'number' && blockTime > 0
      ? new Date(blockTime * 1000).toISOString()
      : new Date().toISOString();
  const slotValue = typeof slot === 'number' ? slot : null;
  // 冲突分支的 WHERE is_akbot = FALSE 让「本来就是 true」的行走不到 DO UPDATE，
  // 于是 RETURNING 不会有行 —— 调用方据此跳过重复检测和重复日志。
  // 证据字段用 pool_members.<col> 取旧值、EXCLUDED.<col> 取新值，别写反。
  const rows = await query<{ is_akbot: boolean }>(
    `INSERT INTO pool_members (address, role, is_akbot, akbot_detected_at, akbot_evidence_sig, akbot_evidence_slot)
     VALUES ($1, 'follower', TRUE, $2::timestamptz, $3, $4)
     ON CONFLICT (address) DO UPDATE
        SET is_akbot = TRUE,
            akbot_detected_at = COALESCE(pool_members.akbot_detected_at, EXCLUDED.akbot_detected_at),
            akbot_evidence_sig = COALESCE(pool_members.akbot_evidence_sig, EXCLUDED.akbot_evidence_sig),
            akbot_evidence_slot = COALESCE(pool_members.akbot_evidence_slot, EXCLUDED.akbot_evidence_slot),
            updated_at = NOW()
      WHERE pool_members.is_akbot = FALSE
     RETURNING is_akbot`,
    [address, detectedAt, evidenceSig, slotValue],
  );
  return rows.length > 0;
}

export interface PoolEdge {
  id: number;
  follower: string;
  target: string;
  freq: number;
  same_slot_count: number;
  next_slot_count: number;
  win_count: number;
  fail_count: number;
  avg_offset_pos: number | null;
  avg_buy_sol: number | null;
  first_seen_at: string;
  last_seen_at: string;
}

/**
 * 增量扫描：给定一个 target address + slot 范围，把这些 slot 的 block_buyers 聚合进 pool
 * 在 monitor.ts ingestTargetTrade 后调用
 */
export async function scanForTarget(opts: {
  targetAddress: string;
  sinceTs?: number;  // ISO seconds, 只扫描 block_time >= sinceTs
  limit?: number;    // 最多扫多少笔 target_trades
}): Promise<{ newMembers: number; updatedMembers: number; newEdges: number; updatedEdges: number }> {
  const limit = opts.limit ?? SCAN_TRADES_PER_TARGET;
  const sinceTs = opts.sinceTs ?? 0;

  // 0) 读取水位线（NULL → epoch 0），保证 BFS 幂等：
  //    只扫 block_time > watermark 的新 trade，避免被 monitor 实时触发 + pool-worker
  //    周期触发互相叠加导致 freq / seen_as_* 双倍累加。
  const watermarkRow = await queryOne<{ wm: string | null }>(`
    SELECT last_scanned_block_time AS wm
    FROM monitored_targets WHERE address = $1
  `, [opts.targetAddress]);
  const watermark: Date = watermarkRow?.wm ? new Date(watermarkRow.wm) : new Date(0);

  // 1) 拉这个 target 水位线之后的新 trade
  const trades = await query<any>(`
    SELECT signature, slot, mint, buy_sol, target_address, block_time
    FROM target_trades
    WHERE target_address = $1 AND block_time > $2
    ORDER BY block_time ASC
    LIMIT $3
  `, [opts.targetAddress, watermark, limit]);

  if (trades.length === 0) {
    // 没有新 trade，仍推进一次水位线（防止 watermark 是过去某个时间导致永远不更新）
    return { newMembers: 0, updatedMembers: 0, newEdges: 0, updatedEdges: 0 };
  }

  // 2) 用 sig 批量查 block_buyers (通过 first_sniper_signature 关联 + 同 slot 同 mint)
  const sigs = trades.map((t) => t.signature);

  // 取与每笔 target_trade 对应的 block_buyers：靠 block_analyses JOIN
  // 用 (slot, mint) 一次性取所有块内买家
  const buyerRows = await query<any>(`
    SELECT bb.address, bb.slot, bb.slot_offset, bb.block_index,
           bb.is_first_sniper, bb.is_own,
           bb.buy_sol::text, bb.tip_sol::text, bb.prio_lamports,
           bb.result, bb.signature,
           ba.mint, ba.target_signature
    FROM block_buyers bb
    JOIN block_analyses ba ON ba.id = bb.block_analysis_id
    WHERE ba.target_signature = ANY($1)
      AND bb.address IS NOT NULL
      AND bb.address <> $2  -- 排除自己
  `, [sigs, opts.targetAddress]);

  if (buyerRows.length === 0) {
    return { newMembers: 0, updatedMembers: 0, newEdges: 0, updatedEdges: 0 };
  }

  // 3) 聚合: 按 address 统计 role / freq / distinct_targets / target_addresses
  const memberAgg = new Map<string, {
    role: 'first_sniper' | 'follower' | 'both';
    freq: number;
    seen_as_first_sniper: number;
    seen_as_follower: number;
    distinctTargets: Set<string>;
    mints: Set<string>;
    buySolSum: number;
    offsetPosSum: number;
    offsetPosCount: number;
  }>();

  // edges: (follower, target) → 聚合
  const edgeAgg = new Map<string, {
    freq: number;
    sameSlot: number;
    nextSlot: number;
    win: number;
    fail: number;
    offsetPosSum: number;
    offsetPosCount: number;
    buySolSum: number;
  }>();

  for (const b of buyerRows) {
    // 跳过 own：自己的钱包不是「跟随者」，不该进池子。
    // 原来只有 <address <> targetAddress> 这一个过滤条件，只排掉了目标本身，
    // own_wallets 里其它地址仍然会被当成 follower 累加进 freq / seen_as_follower。
    if (b.is_own || b.address === opts.targetAddress) continue;

    // 角色以 block_buyers 已落库的 mark 为准（由 first-sniper.ts analyzeBlock 打标）：
    //   is_first_sniper = 同 slot 内、且在目标之前的**第一笔**买入，每笔目标交易有且仅有一个。
    // 不能用 slot_offset 判首狙：slot_offset=0 只说明「同 slot」，而同 slot 里排在目标之后的
    // 买家其实是跟随者，把它们算成 first_sniper 会让首狙计数被同 slot 的跟风盘灌水。
    const realRole: 'first_sniper' | 'follower' = b.is_first_sniper ? 'first_sniper' : 'follower';

    let m = memberAgg.get(b.address);
    if (!m) {
      m = {
        role: realRole,
        freq: 0,
        seen_as_first_sniper: 0,
        seen_as_follower: 0,
        distinctTargets: new Set(),
        mints: new Set(),
        buySolSum: 0,
        offsetPosSum: 0,
        offsetPosCount: 0,
      };
      memberAgg.set(b.address, m);
    }
    m.freq++;
    if (realRole === 'first_sniper') m.seen_as_first_sniper++; else m.seen_as_follower++;
    // 同上：role 跟着计数走。本批里先出现跟随、后出现首狙的地址，初始 role 是 follower，
    // 不重新派生的话它会以 follower 身份入库。
    m.role = m.seen_as_first_sniper > 0 && m.seen_as_follower > 0 ? 'both'
      : m.seen_as_first_sniper > 0 ? 'first_sniper' : 'follower';
    m.distinctTargets.add(opts.targetAddress);
    m.mints.add(b.mint);
    const bs = parseFloat(b.buy_sol);
    if (!Number.isNaN(bs)) m.buySolSum += bs;
    if (typeof b.block_index === 'number') {
      m.offsetPosSum += b.block_index;
      m.offsetPosCount++;
    }

    // edge
    const ek = `${b.address}|${opts.targetAddress}`;
    let e = edgeAgg.get(ek);
    if (!e) {
      e = {
        freq: 0,
        sameSlot: 0,
        nextSlot: 0,
        win: 0,
        fail: 0,
        offsetPosSum: 0,
        offsetPosCount: 0,
        buySolSum: 0,
      };
      edgeAgg.set(ek, e);
    }
    e.freq++;
    if (b.slot_offset === 0) e.sameSlot++; else e.nextSlot++;
    if (b.result === 'success') e.win++; else if (b.result === 'failed') e.fail++;
    if (typeof b.block_index === 'number') {
      e.offsetPosSum += b.block_index;
      e.offsetPosCount++;
    }
    if (!Number.isNaN(bs)) e.buySolSum += bs;
  }

  // 4) upsert 到 pool_members
  let newMembers = 0;
  let updatedMembers = 0;

  for (const [addr, m] of memberAgg) {
    // 合并 role
    const cur = await queryOne<any>(`SELECT role, freq, seen_as_first_sniper, seen_as_follower,
      target_addresses, mints_sample, avg_buy_sol, avg_offset_pos FROM pool_members WHERE address = $1`, [addr]);
    if (!cur) {
      await query(
        `INSERT INTO pool_members (address, role, freq, seen_as_first_sniper, seen_as_follower,
          distinct_targets, target_addresses, mints_sample, avg_buy_sol, avg_offset_pos, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())`,
        [
          addr,
          m.role,
          m.freq,
          m.seen_as_first_sniper,
          m.seen_as_follower,
          m.distinctTargets.size,
          Array.from(m.distinctTargets),
          Array.from(m.mints).slice(0, 100),
          m.buySolSum / Math.max(m.freq, 1),
          m.offsetPosCount ? m.offsetPosSum / m.offsetPosCount : 0,
        ],
      );
      newMembers++;
    } else {
      const mergedTargets = Array.from(new Set([
        ...(cur.target_addresses ?? []),
        ...Array.from(m.distinctTargets),
      ]));
      const mergedMints = Array.from(new Set([
        ...(cur.mints_sample ?? []),
        ...Array.from(m.mints),
      ])).slice(-100);

      const newFreq = Number(cur.freq ?? 0) + m.freq;
      const newFirstSniper = Number(cur.seen_as_first_sniper ?? 0) + m.seen_as_first_sniper;
      const newFollower = Number(cur.seen_as_follower ?? 0) + m.seen_as_follower;
      // role 从计数派生。不要写成「cur.role / m.role 里有没有 first_sniper」：
      // m.role 只是本批第一条记录碰巧的角色，同一批里既当首狙又当跟随者的地址会被漏判成 follower。
      const mergedRole: 'first_sniper' | 'follower' | 'both' =
        newFirstSniper > 0 && newFollower > 0 ? 'both'
          : newFirstSniper > 0 ? 'first_sniper' : 'follower';
      const prevBuySolSum = (parseFloat(cur.avg_buy_sol ?? '0') * Number(cur.freq ?? 0)) + m.buySolSum;
      const newAvgBuySol = prevBuySolSum / Math.max(newFreq, 1);

      // distinct_targets: 用 cardinality array_length 不可靠，重新计算
      const distinctCount = mergedTargets.length;

      await query(
        `UPDATE pool_members
         SET role = $2, freq = $3, seen_as_first_sniper = $4, seen_as_follower = $5,
             distinct_targets = $6, target_addresses = $7, mints_sample = $8,
             avg_buy_sol = $9, last_seen_at = NOW()
         WHERE address = $1`,
        [addr, mergedRole, newFreq, newFirstSniper, newFollower, distinctCount,
         mergedTargets, mergedMints, newAvgBuySol],
      );
      updatedMembers++;
    }
  }

  // 5) upsert pool_edges
  let newEdges = 0;
  let updatedEdges = 0;

  for (const [ek, e] of edgeAgg) {
    const [follower, target] = ek.split('|');
    const cur = await queryOne<any>(`SELECT freq, same_slot_count, next_slot_count, win_count, fail_count
      FROM pool_edges WHERE follower = $1 AND target = $2`, [follower, target]);
    if (!cur) {
      await query(
        `INSERT INTO pool_edges (follower, target, freq, same_slot_count, next_slot_count,
          win_count, fail_count, avg_offset_pos, avg_buy_sol, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())`,
        [follower, target, e.freq, e.sameSlot, e.nextSlot, e.win, e.fail,
         e.offsetPosCount ? e.offsetPosSum / e.offsetPosCount : 0,
         e.buySolSum / Math.max(e.freq, 1)],
      );
      newEdges++;
    } else {
      const newFreq = Number(cur.freq ?? 0) + e.freq;
      const newSameSlot = Number(cur.same_slot_count ?? 0) + e.sameSlot;
      const newNextSlot = Number(cur.next_slot_count ?? 0) + e.nextSlot;
      const newWin = Number(cur.win_count ?? 0) + e.win;
      const newFail = Number(cur.fail_count ?? 0) + e.fail;

      await query(
        `UPDATE pool_edges
         SET freq = $3, same_slot_count = $4, next_slot_count = $5,
             win_count = $6, fail_count = $7, last_seen_at = NOW()
         WHERE follower = $1 AND target = $2`,
        [follower, target, newFreq, newSameSlot, newNextSlot, newWin, newFail],
      );
      updatedEdges++;
    }
  }

  // 7) 推进水位线 = MAX(trades.block_time)
  //    即使没有 member/edge 变化，只要扫到了 trade 也要推进，否则下次会重扫同样的 trade。
  const newWatermark = trades.reduce<Date>(
    (acc, t) => (acc > new Date(t.block_time) ? acc : new Date(t.block_time)),
    watermark,
  );
  await query(
    `UPDATE monitored_targets
       SET last_scanned_block_time = $2,
           updated_at = NOW()
     WHERE address = $1
       AND (last_scanned_block_time IS NULL OR last_scanned_block_time < $2)`,
    [opts.targetAddress, newWatermark],
  );

  return { newMembers, updatedMembers, newEdges, updatedEdges };
}

/**
 * 自动晋升: freq 高的 pool_member 加入 monitored_targets
 * 返回被晋升的 address 列表
 */
export async function autoPromote(opts: {
  freqThreshold?: number;
  distinctTargetsThreshold?: number;
  defaultThreshold?: number;
} = {}): Promise<string[]> {
  const freqThreshold = opts.freqThreshold ?? PROMOTE_FREQ_THRESHOLD;
  const distinctTargetsThreshold = opts.distinctTargetsThreshold ?? PROMOTE_MIN_DISTINCT_TARGETS;
  const defaultThreshold = opts.defaultThreshold ?? PROMOTE_DEFAULT_THRESHOLD;

  // 候选: freq >= 阈值 且 distinct_targets >= 阈值 且未被晋升 且不在 monitored_targets
  // 且未被人工删除标记排除（auto_promote_excluded，见 0009 迁移）
  const candidates = await query<any>(`
    SELECT pm.address, pm.freq, pm.role
    FROM pool_members pm
    LEFT JOIN monitored_targets mt ON mt.address = pm.address
    WHERE pm.freq >= $1
      AND pm.distinct_targets >= $2
      AND pm.promoted_to_target = false
      AND mt.id IS NULL
      AND pm.auto_promote_excluded = false
    ORDER BY pm.freq DESC
    LIMIT 50
  `, [freqThreshold, distinctTargetsThreshold]);

  const promoted: string[] = [];
  for (const c of candidates) {
    try {
      // RETURNING 判断是否真的插入了新行。候选查询已保证 mt.id IS NULL，
      // 这里返回空只可能是并发下被另一个 worker 先插了 —— 那就不重复标记。
      const inserted = await query<{ id: string }>(
        `INSERT INTO monitored_targets (address, label, threshold_sol, status)
         VALUES ($1, $2, $3, 'active')
         ON CONFLICT (address) DO NOTHING
         RETURNING id`,
        [c.address, `auto:${c.role}`, defaultThreshold],
      );
      if (inserted.length === 0) {
        console.log(`[pool] skip ${c.address.slice(0, 6)}... already a target (concurrent insert)`);
        continue;
      }
      await query(
        `UPDATE pool_members SET promoted_to_target = true, promoted_at = NOW() WHERE address = $1`,
        [c.address],
      );
      promoted.push(c.address);
      console.log(`[pool] promoted ${c.address.slice(0, 6)}... freq=${c.freq} role=${c.role}`);
    } catch (err) {
      console.warn('[pool] promote failed', c.address, err);
    }
  }

  return promoted;
}

/**
 * BFS 全量扫描: 从 monitored_targets seed 开始，深度受限递归归池
 */
export async function runBFS(opts: {
  maxDepth?: number;
} = {}): Promise<{
  scannedTargets: number;
  totalNewMembers: number;
  totalUpdatedMembers: number;
  totalPromoted: number;
  durationMs: number;
}> {
  const maxDepth = opts.maxDepth ?? BFS_MAX_DEPTH;
  const t0 = Date.now();
  let scannedTargets = 0;
  let totalNewMembers = 0;
  let totalUpdatedMembers = 0;
  let totalPromoted = 0;
  const seenAddresses = new Set<string>();

  for (let depth = 0; depth < maxDepth; depth++) {
    const targets = await query<any>(
      `SELECT address FROM monitored_targets WHERE status = 'active'`
    );

    let newInDepth = 0;
    for (const t of targets) {
      if (seenAddresses.has(t.address)) continue;
      seenAddresses.add(t.address);
      try {
        const res = await scanForTarget({ targetAddress: t.address });
        totalNewMembers += res.newMembers;
        totalUpdatedMembers += res.updatedMembers;
        newInDepth += res.newMembers + res.updatedMembers;
        scannedTargets++;
      } catch (err) {
        console.warn('[pool] scanForTarget failed', t.address, err);
      }
    }

    // 深度结束后尝试晋升
    const promos = await autoPromote();
    totalPromoted += promos.length;
    // 晋升的地址标记为已扫描，防止在下一层深度被重复归池
    for (const p of promos) seenAddresses.add(p);

    if (newInDepth === 0 && promos.length === 0) {
      console.log(`[pool] BFS converged at depth ${depth}`);
      break;
    }
    console.log(`[pool] BFS depth ${depth}: scanned=${scannedTargets} newInDepth=${newInDepth} promoted=${promos.length}`);
  }

  return {
    scannedTargets,
    totalNewMembers,
    totalUpdatedMembers,
    totalPromoted,
    durationMs: Date.now() - t0,
  };
}

/**
 * 数 pool_members（同 listPoolMembers 的 WHERE 条件，用于前端分页 total）
 */
export async function countPoolMembers(opts: {
  role?: string;
  promoted?: boolean;
  minFreq?: number;
  isAkbot?: boolean;
} = {}): Promise<number> {
  const conditions: string[] = ['1=1'];
  const params: any[] = [];
  if (opts.role) {
    params.push(opts.role);
    conditions.push(`role = $${params.length}`);
  }
  if (opts.promoted !== undefined) {
    params.push(opts.promoted);
    conditions.push(`promoted_to_target = $${params.length}`);
  }
  if (opts.minFreq !== undefined) {
    params.push(opts.minFreq);
    conditions.push(`freq >= $${params.length}`);
  }
  if (opts.isAkbot !== undefined) {
    params.push(opts.isAkbot);
    conditions.push(`is_akbot = $${params.length}`);
  }
  const row = await queryOne<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM pool_members WHERE ${conditions.join(' AND ')}`,
    params,
  );
  return parseInt(row?.c ?? '0', 10);
}

/**
 * 列出 pool_members
 */
export async function listPoolMembers(opts: {
  role?: string;
  promoted?: boolean;
  minFreq?: number;
  isAkbot?: boolean;
  limit?: number;
  offset?: number;
  sortBy?: 'freq' | 'score' | 'seen';
} = {}): Promise<PoolMember[]> {
  const conditions: string[] = ['1=1'];
  const params: any[] = [];
  if (opts.role) {
    params.push(opts.role);
    conditions.push(`role = $${params.length}`);
  }
  if (opts.promoted !== undefined) {
    params.push(opts.promoted);
    conditions.push(`promoted_to_target = $${params.length}`);
  }
  if (opts.minFreq !== undefined) {
    params.push(opts.minFreq);
    conditions.push(`freq >= $${params.length}`);
  }
  if (opts.isAkbot !== undefined) {
    params.push(opts.isAkbot);
    conditions.push(`is_akbot = $${params.length}`);
  }
  const orderCol =
    opts.sortBy === 'score' ? 'worth_score DESC NULLS LAST' :
    opts.sortBy === 'seen' ? 'last_seen_at DESC' :
    'freq DESC';

  params.push(opts.limit ?? 100);
  params.push(opts.offset ?? 0);

  const rows = await query<any>(`
    SELECT id, address, label, role, freq, seen_as_first_sniper, seen_as_follower,
           distinct_targets, target_addresses, mints_sample, avg_buy_sol::text AS avg_buy_sol,
           avg_offset_pos, first_seen_at, last_seen_at,
           worth_score::text AS worth_score,
           recommended_tip_sol::text AS recommended_tip_sol,
           recommended_prio_lamports,
           score_updated_at, promoted_to_target, promoted_at, notes,
           is_akbot, akbot_detected_at, akbot_evidence_sig, akbot_evidence_slot
    FROM pool_members
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${orderCol}
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);

  return rows.map(normalizeMember);
}

/**
 * 给定地址返回 pool 详情
 */
export async function getPoolMember(address: string): Promise<PoolMember | null> {
  const row = await queryOne<any>(`
    SELECT id, address, label, role, freq, seen_as_first_sniper, seen_as_follower,
           distinct_targets, target_addresses, mints_sample, avg_buy_sol::text AS avg_buy_sol,
           avg_offset_pos, first_seen_at, last_seen_at,
           worth_score::text AS worth_score,
           recommended_tip_sol::text AS recommended_tip_sol,
           recommended_prio_lamports,
           score_updated_at, promoted_to_target, promoted_at, notes,
           is_akbot, akbot_detected_at, akbot_evidence_sig, akbot_evidence_slot
    FROM pool_members WHERE address = $1
  `, [address]);
  return row ? normalizeMember(row) : null;
}

/**
 * 列出某地址的边（作为 follower 跟随了谁 / 作为 target 被谁跟随）
 */
export async function getPoolEdges(address: string): Promise<{
  following: PoolEdge[];   // address 跟随了谁
  followers: PoolEdge[];   // 谁跟随 address
}> {
  const following = await query<any>(`
    SELECT id, follower, target, freq, same_slot_count, next_slot_count,
           win_count, fail_count, avg_offset_pos, avg_buy_sol::text AS avg_buy_sol,
           first_seen_at, last_seen_at
    FROM pool_edges WHERE follower = $1 ORDER BY freq DESC LIMIT 50
  `, [address]);
  const followers = await query<any>(`
    SELECT id, follower, target, freq, same_slot_count, next_slot_count,
           win_count, fail_count, avg_offset_pos, avg_buy_sol::text AS avg_buy_sol,
           first_seen_at, last_seen_at
    FROM pool_edges WHERE target = $1 ORDER BY freq DESC LIMIT 50
  `, [address]);
  return { following, followers };
}

/** 手动添加地址到池子 */
export async function addPoolMember(address: string, label?: string): Promise<PoolMember> {
  await query(
    `INSERT INTO pool_members (address, label, role) VALUES ($1, $2, 'follower')
     ON CONFLICT (address) DO UPDATE SET label = COALESCE(EXCLUDED.label, pool_members.label), updated_at = NOW()
     RETURNING id`,
    [address, label ?? null],
  );
  const m = await getPoolMember(address);
  if (!m) throw new Error('addPoolMember failed');
  return m;
}

/** 手动晋升到 monitored_targets */
export async function promotePoolMember(address: string, threshold?: number): Promise<{ ok: boolean; reason?: string }> {
  const m = await getPoolMember(address);
  if (!m) return { ok: false, reason: 'pool member not found' };

  // 标记为已晋升、但 monitored_targets 里没有对应行时（历史遗留的孤儿状态），
  // 要允许重新晋升，而不是被 promoted_to_target 直接挡回去。
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM monitored_targets WHERE address = $1`,
    [address],
  );
  if (existing) return { ok: false, reason: 'already a monitored target' };

  // 手动晋升是显式意图，清掉「人工删除后不要自动拉回」的标记
  await query(`UPDATE pool_members SET auto_promote_excluded = false WHERE address = $1`, [address]);

  const inserted = await query<{ id: string }>(
    `INSERT INTO monitored_targets (address, label, threshold_sol, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (address) DO NOTHING
     RETURNING id`,
    [address, m.label ?? `pool:${m.role}`, threshold ?? PROMOTE_DEFAULT_THRESHOLD],
  );
  if (inserted.length === 0) return { ok: false, reason: 'already a monitored target' };

  await query(
    `UPDATE pool_members SET promoted_to_target = true, promoted_at = NOW() WHERE address = $1`,
    [address],
  );
  return { ok: true };
}

/**
 * 对账：清理 pool_members.promoted_to_target 的孤儿状态。
 *
 * promoted_to_target 的语义是「这个池成员被池子系统晋升进过 monitored_targets」，
 * 而不是「当前是 monitored_targets 里的一行」。手动添加的监控目标若同时也在池子里，
 * promoted_to_target = false 是正常状态，不能当成漂移去改。
 *
 * 真正的漂移只有一类：标记为 true，但 monitored_targets 里已没有对应的 active 行。
 * 旧的删除接口只删 monitored_targets、不重置这个标记，于是该地址既不被监控，
 * 也过不了 autoPromote 的候选条件（promoted_to_target = false 不成立、
 * mt.id IS NULL 成立），永久卡死。
 *
 * 不在 pool-worker 里自动调用：修复会让这些地址重新具备被自动晋升的资格
 * （进而真实抢单、花 SOL），需人工确认后再跑 scripts/reconcile-promotion.ts。
 */
export async function reconcilePromotionFlags(opts: {
  /** 孤儿处置方式：exclude = 置排除标记（默认，尊重人工删除）；requeue = 放回候选池 */
  orphanAction?: 'exclude' | 'requeue';
  dryRun?: boolean;
} = {}): Promise<{
  orphans: { address: string; role: string; freq: number; promoted_at: string | null }[];
  fixed: number;
}> {
  const orphanAction = opts.orphanAction ?? 'exclude';
  const dryRun = opts.dryRun ?? false;

  const orphans = await query<any>(`
    SELECT pm.address, pm.role, pm.freq, pm.promoted_at
    FROM pool_members pm
    WHERE pm.promoted_to_target = true
      AND NOT EXISTS (
        SELECT 1 FROM monitored_targets mt
        WHERE mt.address = pm.address AND mt.status = 'active'
      )
    ORDER BY pm.freq DESC
  `);

  if (dryRun) return { orphans, fixed: 0 };

  const fixed = orphanAction === 'exclude'
    ? await execute(`
        UPDATE pool_members
        SET promoted_to_target = false, promoted_at = NULL, auto_promote_excluded = true
        WHERE promoted_to_target = true
          AND NOT EXISTS (
            SELECT 1 FROM monitored_targets mt
            WHERE mt.address = pool_members.address AND mt.status = 'active'
          )
      `)
    : await execute(`
        UPDATE pool_members
        SET promoted_to_target = false, promoted_at = NULL
        WHERE promoted_to_target = true
          AND NOT EXISTS (
            SELECT 1 FROM monitored_targets mt
            WHERE mt.address = pool_members.address AND mt.status = 'active'
          )
      `);

  return { orphans, fixed };
}

/** 池子统计 */
export async function getPoolStats(): Promise<{
  totalMembers: number;
  promoted: number;
  firstSnipers: number;
  followers: number;
  totalEdges: number;
  akbotCount: number;
  bfsLastRun: string | null;
}> {
  const [total, prom, fs, fo, ed, akb, lastRun] = await Promise.all([
    queryOne<{ c: string }>(`SELECT COUNT(*)::text AS c FROM pool_members`),
    queryOne<{ c: string }>(`SELECT COUNT(*)::text AS c FROM pool_members WHERE promoted_to_target = true`),
    queryOne<{ c: string }>(`SELECT COUNT(*)::text AS c FROM pool_members WHERE role IN ('first_sniper', 'both')`),
    queryOne<{ c: string }>(`SELECT COUNT(*)::text AS c FROM pool_members WHERE role IN ('follower', 'both')`),
    queryOne<{ c: string }>(`SELECT COUNT(*)::text AS c FROM pool_edges`),
    queryOne<{ c: string }>(`SELECT COUNT(*)::text AS c FROM pool_members WHERE is_akbot = true`),
    queryOne<{ finished_at: string }>(`SELECT finished_at FROM pool_discoveries ORDER BY started_at DESC LIMIT 1`),
  ]);
  return {
    totalMembers: parseInt(total?.c ?? '0', 10),
    promoted: parseInt(prom?.c ?? '0', 10),
    firstSnipers: parseInt(fs?.c ?? '0', 10),
    followers: parseInt(fo?.c ?? '0', 10),
    totalEdges: parseInt(ed?.c ?? '0', 10),
    akbotCount: parseInt(akb?.c ?? '0', 10),
    bfsLastRun: lastRun?.finished_at ?? null,
  };
}

function normalizeMember(r: any): PoolMember {
  return {
    ...r,
    avg_buy_sol: r.avg_buy_sol ? parseFloat(r.avg_buy_sol) : 0,
    worth_score: r.worth_score !== null ? parseFloat(r.worth_score) : null,
    recommended_tip_sol: r.recommended_tip_sol !== null ? parseFloat(r.recommended_tip_sol) : null,
    is_akbot: !!r.is_akbot,
    akbot_evidence_slot: r.akbot_evidence_slot !== null ? Number(r.akbot_evidence_slot) : null,
  };
}