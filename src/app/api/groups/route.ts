/**
 * /api/groups
 * GET - 组合排行（基于图连通分量的群组检测）
 *
 * 流程：
 *   1) 拉所有 shared_mints >= minShared 的 address pair (边)
 *   2) 在内存里建图，跑 DFS 找连通分量
 *   3) 过滤出 size >= 3 的群组
 *   4) 对每个群组：用 SQL 拉成员 mint 集合做交集，统计交易数 / slot 跨度
 *   5) 按 (size, common_mints) 排序返回 top N
 *
 * 注：block_buyers.pnl_sol 在本系统尚未填充，因此群组 PnL 暂不显示，
 *     改用"成员总买入笔数"+"活跃 slot 跨度"作为活跃度指标。
 */
import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  // 严格化参数：parseInt 失败时用 fallback；上下限都加 cap，避免恶意参数触发 DoS
  const toInt = (v: string | null, def: number, lo: number, hi: number) => {
    const n = parseInt(v ?? '', 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(Math.max(n, lo), hi);
  };
  const limit = toInt(searchParams.get('limit'), 30, 1, 200);
  const minGroupSize = toInt(searchParams.get('min_size'), 3, 2, 50);
  const minShared = toInt(searchParams.get('min_shared'), 5, 2, 50);

  try {
    // ---------- 1) 拉 pair 边 ----------
    const pairRows = await query<{
      addr_a: string;
      addr_b: string;
      shared_mints: number;
      co_occurrences: number;
    }>(
      `WITH slot_buyers AS (
         SELECT b.slot, ba.mint, b.address
         FROM block_buyers b
         JOIN block_analyses ba ON ba.id = b.block_analysis_id
         WHERE b.is_first_sniper = true OR b.is_follower = true
       ),
       pair_co AS (
         SELECT a.address AS addr_a, b.address AS addr_b, a.mint, a.slot
         FROM slot_buyers a
         JOIN slot_buyers b ON a.slot = b.slot AND a.mint = b.mint AND a.address < b.address
       ),
       pair_stats AS (
         SELECT
           addr_a,
           addr_b,
           COUNT(DISTINCT mint)::int AS shared_mints,
           COUNT(*)::int AS co_occurrences
         FROM pair_co
         GROUP BY addr_a, addr_b
         HAVING COUNT(DISTINCT mint) >= $1
       )
       SELECT addr_a, addr_b, shared_mints, co_occurrences
       FROM pair_stats`,
      [minShared]
    );

    if (pairRows.length === 0) {
      return NextResponse.json({
        ok: true,
        data: [],
        stats: { pairs: 0, addresses: 0, groups: 0, min_shared: minShared, min_size: minGroupSize },
      });
    }

    // ---------- 2) 内存里建图，跑 DFS ----------
    const adj = new Map<string, Map<string, number>>(); // addr -> {neighbor: weight}
    const allAddrs = new Set<string>();
    for (const r of pairRows) {
      allAddrs.add(r.addr_a);
      allAddrs.add(r.addr_b);
      if (!adj.has(r.addr_a)) adj.set(r.addr_a, new Map());
      if (!adj.has(r.addr_b)) adj.set(r.addr_b, new Map());
      const prev = adj.get(r.addr_a)!.get(r.addr_b) ?? 0;
      if (r.shared_mints > prev) {
        adj.get(r.addr_a)!.set(r.addr_b, r.shared_mints);
        adj.get(r.addr_b)!.set(r.addr_a, r.shared_mints);
      }
    }

    const visited = new Set<string>();
    const components: string[][] = [];
    for (const start of allAddrs) {
      if (visited.has(start)) continue;
      const stack = [start];
      const comp: string[] = [];
      while (stack.length) {
        const cur = stack.pop()!;
        if (visited.has(cur)) continue;
        visited.add(cur);
        comp.push(cur);
        const neighbors = adj.get(cur);
        if (neighbors) {
          for (const n of neighbors.keys()) {
            if (!visited.has(n)) stack.push(n);
          }
        }
      }
      if (comp.length >= minGroupSize) components.push(comp);
    }

    if (components.length === 0) {
      return NextResponse.json({
        ok: true,
        data: [],
        stats: {
          pairs: pairRows.length,
          addresses: allAddrs.size,
          groups: 0,
          min_shared: minShared,
          min_size: minGroupSize,
        },
      });
    }

    // 按 size 降序取前 50 个大群组做后续计算（避免太多 SQL）
    components.sort((a, b) => b.length - a.length);
    const topComponents = components.slice(0, 50);
    const memberAddrs = Array.from(new Set(topComponents.flat()));

    // ---------- 3) 拉成员的 mint 集合和聚合指标 ----------
    const mintRows = await query<{ address: string; mint: string }>(
      `SELECT b.address, ba.mint
       FROM block_buyers b
       JOIN block_analyses ba ON ba.id = b.block_analysis_id
       WHERE (b.is_first_sniper = true OR b.is_follower = true)
         AND b.address = ANY($1::text[])
       GROUP BY b.address, ba.mint`,
      [memberAddrs]
    );

    const mintsByAddr = new Map<string, Set<string>>();
    for (const r of mintRows) {
      if (!mintsByAddr.has(r.address)) mintsByAddr.set(r.address, new Set());
      mintsByAddr.get(r.address)!.add(r.mint);
    }

    const statsRows = await query<{
      address: string;
      trades: string;
      first_slot: string;
      last_slot: string;
      first_buy_sol: string;
    }>(
      `SELECT b.address,
              COUNT(*)::text AS trades,
              MIN(b.slot)::text AS first_slot,
              MAX(b.slot)::text AS last_slot,
              COALESCE(SUM(b.buy_sol), 0)::text AS first_buy_sol
       FROM block_buyers b
       WHERE (b.is_first_sniper = true OR b.is_follower = true)
         AND b.address = ANY($1::text[])
       GROUP BY b.address`,
      [memberAddrs]
    );

    type MemberStats = { trades: number; first_slot: number; last_slot: number; total_buy_sol: number };
    const statsByAddr = new Map<string, MemberStats>();
    for (const r of statsRows) {
      statsByAddr.set(r.address, {
        trades: parseInt(r.trades, 10) || 0,
        first_slot: parseInt(r.first_slot, 10) || 0,
        last_slot: parseInt(r.last_slot, 10) || 0,
        total_buy_sol: parseFloat(r.first_buy_sol) || 0,
      });
    }

    // ---------- 4) 计算每个群组的指标 ----------
    type MemberOut = {
      address: string;
      trades: number;
      total_buy_sol: number;
      first_slot: number;
      last_slot: number;
    };

    type GroupOut = {
      group_id: number;
      size: number;
      common_mints: number;
      common_mint_samples: string[];
      avg_shared: number;
      total_trades: number;
      total_buy_sol: number;
      first_slot: number;
      last_slot: number;
      members: MemberOut[];
    };

    const groups: GroupOut[] = topComponents.map((comp, idx) => {
      // 共同 mint：所有成员 mint 集合的交集
      let common: Set<string> | null = null;
      for (const a of comp) {
        const s = mintsByAddr.get(a);
        if (!s) { common = new Set(); break; }
        if (common === null) common = new Set(s);
        else {
          for (const m of common) if (!s.has(m)) common.delete(m);
          if (common.size === 0) break;
        }
      }
      common = common ?? new Set();

      // 平均关系强度：群组内所有边权重的平均
      let edgeSum = 0;
      let edgeCnt = 0;
      for (let i = 0; i < comp.length; i++) {
        const neigh = adj.get(comp[i]);
        if (!neigh) continue;
        for (let j = i + 1; j < comp.length; j++) {
          const w = neigh.get(comp[j]);
          if (w !== undefined) {
            edgeSum += w;
            edgeCnt += 1;
          }
        }
      }
      const avgShared = edgeCnt > 0 ? edgeSum / edgeCnt : 0;

      // 成员聚合
      let totalTrades = 0;
      let totalBuySol = 0;
      let firstSlot = Number.MAX_SAFE_INTEGER;
      let lastSlot = 0;
      const members: MemberOut[] = comp
        .map((a) => {
          const s = statsByAddr.get(a);
          const trades = s?.trades ?? 0;
          const totalBuy = s?.total_buy_sol ?? 0;
          const fs = s?.first_slot ?? 0;
          const ls = s?.last_slot ?? 0;
          totalTrades += trades;
          totalBuySol += totalBuy;
          if (fs && fs < firstSlot) firstSlot = fs;
          if (ls > lastSlot) lastSlot = ls;
          return { address: a, trades, total_buy_sol: totalBuy, first_slot: fs, last_slot: ls };
        })
        .sort((x, y) => y.trades - x.trades);

      if (firstSlot === Number.MAX_SAFE_INTEGER) firstSlot = 0;

      return {
        group_id: idx + 1,
        size: comp.length,
        common_mints: common.size,
        common_mint_samples: Array.from(common).slice(0, 5),
        avg_shared: Math.round(avgShared * 10) / 10,
        total_trades: totalTrades,
        total_buy_sol: Math.round(totalBuySol * 1000) / 1000,
        first_slot: firstSlot,
        last_slot: lastSlot,
        members,
      };
    });

    // 排序：size desc → common_mints desc → total_trades desc
    groups.sort((a, b) => {
      if (b.size !== a.size) return b.size - a.size;
      if (b.common_mints !== a.common_mints) return b.common_mints - a.common_mints;
      return b.total_trades - a.total_trades;
    });

    return NextResponse.json({
      ok: true,
      data: groups.slice(0, limit),
      stats: {
        pairs: pairRows.length,
        addresses: allAddrs.size,
        groups: groups.length,
        min_shared: minShared,
        min_size: minGroupSize,
      },
    });
  } catch (err: any) {
    // 不向客户端暴露数据库 / 框架的内部错误信息
    console.error('[api/groups] error:', err);
    return NextResponse.json({ ok: false, error: 'internal_error' }, { status: 500 });
  }
}
