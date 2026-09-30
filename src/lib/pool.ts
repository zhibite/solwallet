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
    // 跳过 own（block_buyers.is_own = true，但 JOIN 里没取这个字段，靠 owner set 过滤）
    if (b.address === opts.targetAddress) continue;

    // slot_offset=0 表示同 slot（同 block），为 first_sniper
    // slot_offset=1 表示下一个 slot，为 follower
    const realRole: 'first_sniper' | 'follower' = b.slot_offset === 0 ? 'first_sniper' : 'follower';

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
      const mergedRole = cur.role === m.role ? cur.role :
        (cur.role === 'first_sniper' || m.role === 'first_sniper') ? 'both' : 'follower';
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
  const candidates = await query<any>(`
    SELECT pm.address, pm.freq, pm.role
    FROM pool_members pm
    LEFT JOIN monitored_targets mt ON mt.address = pm.address
    WHERE pm.freq >= $1
      AND pm.distinct_targets >= $2
      AND pm.promoted_to_target = false
      AND mt.id IS NULL
    ORDER BY pm.freq DESC
    LIMIT 50
  `, [freqThreshold, distinctTargetsThreshold]);

  const promoted: string[] = [];
  for (const c of candidates) {
    try {
      await query(
        `INSERT INTO monitored_targets (address, label, threshold_sol, status)
         VALUES ($1, $2, $3, 'active')
         ON CONFLICT (address) DO NOTHING`,
        [c.address, `auto:${c.role}`, defaultThreshold],
      );
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
 * 列出 pool_members
 */
export async function listPoolMembers(opts: {
  role?: string;
  promoted?: boolean;
  minFreq?: number;
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
           score_updated_at, promoted_to_target, promoted_at, notes
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
           score_updated_at, promoted_to_target, promoted_at, notes
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
  if (m.promoted_to_target) return { ok: false, reason: 'already promoted' };

  await query(
    `INSERT INTO monitored_targets (address, label, threshold_sol, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (address) DO NOTHING`,
    [address, m.label ?? `pool:${m.role}`, threshold ?? PROMOTE_DEFAULT_THRESHOLD],
  );
  await query(
    `UPDATE pool_members SET promoted_to_target = true, promoted_at = NOW() WHERE address = $1`,
    [address],
  );
  return { ok: true };
}

/** 池子统计 */
export async function getPoolStats(): Promise<{
  totalMembers: number;
  promoted: number;
  firstSnipers: number;
  followers: number;
  totalEdges: number;
  bfsLastRun: string | null;
}> {
  const [total, prom, fs, fo, ed, lastRun] = await Promise.all([
    queryOne<{ c: string }>(`SELECT COUNT(*)::text AS c FROM pool_members`),
    queryOne<{ c: string }>(`SELECT COUNT(*)::text AS c FROM pool_members WHERE promoted_to_target = true`),
    queryOne<{ c: string }>(`SELECT COUNT(*)::text AS c FROM pool_members WHERE role IN ('first_sniper', 'both')`),
    queryOne<{ c: string }>(`SELECT COUNT(*)::text AS c FROM pool_members WHERE role IN ('follower', 'both')`),
    queryOne<{ c: string }>(`SELECT COUNT(*)::text AS c FROM pool_edges`),
    queryOne<{ finished_at: string }>(`SELECT finished_at FROM pool_discoveries ORDER BY started_at DESC LIMIT 1`),
  ]);
  return {
    totalMembers: parseInt(total?.c ?? '0', 10),
    promoted: parseInt(prom?.c ?? '0', 10),
    firstSnipers: parseInt(fs?.c ?? '0', 10),
    followers: parseInt(fo?.c ?? '0', 10),
    totalEdges: parseInt(ed?.c ?? '0', 10),
    bfsLastRun: lastRun?.finished_at ?? null,
  };
}

function normalizeMember(r: any): PoolMember {
  return {
    ...r,
    avg_buy_sol: r.avg_buy_sol ? parseFloat(r.avg_buy_sol) : 0,
    worth_score: r.worth_score !== null ? parseFloat(r.worth_score) : null,
    recommended_tip_sol: r.recommended_tip_sol !== null ? parseFloat(r.recommended_tip_sol) : null,
  };
}