/**
 * /api/sniper-ranking
 * GET - 狙击排行：按 is_first_sniper=true 的地址聚合，给出抢单频率、收益、胜率等
 *
 * Query:
 *   - from: ISO 时间，默认最近 30 天
 *   - limit: 默认 100
 *   - sort: 'count' | 'pnl' | 'win_rate' | 'avg_offset'，默认 'count'
 */
import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const from = searchParams.get('from') || new Date(Date.now() - 30 * 86400_000).toISOString();
  const limit = Math.min(parseInt(searchParams.get('limit') || '100', 10), 500);
  const sort = searchParams.get('sort') || 'count';

  const orderBy = (() => {
    switch (sort) {
      case 'pnl':       return 'total_pnl DESC NULLS LAST';
      case 'win_rate':  return 'win_rate DESC NULLS LAST';
      case 'avg_offset':return 'avg_offset ASC NULLS LAST';   // 越早抢到越好
      case 'count':
      default:          return 'snipe_count DESC';
    }
  })();

  try {
    // 聚合：每个 sniper 地址的统计
    // offset_pos 为负数表示抢在目标之前；越负越早抢到
    const sql = `
      SELECT b.address,
             COUNT(*)                                       AS snipe_count,
             COUNT(DISTINCT ba.mint)                        AS mint_count,
             SUM(CASE WHEN b.result = 'success' THEN 1 ELSE 0 END) AS win_count,
             COUNT(*) FILTER (WHERE b.result = 'success')::numeric
               / NULLIF(COUNT(*), 0)                       AS win_rate,
             SUM(b.buy_sol)::text                           AS total_buy,
             SUM(b.tip_sol)::text                           AS total_tip,
             AVG(b.offset_pos)::numeric(20, 4)             AS avg_offset,
             SUM(b.pnl_sol)::text                           AS total_pnl,
             AVG(b.pnl_sol)::text                           AS avg_pnl,
             MAX(ba.block_time)                             AS last_active
      FROM block_buyers b
      JOIN block_analyses ba ON ba.id = b.block_analysis_id
      WHERE b.is_first_sniper = true
        AND ba.block_time >= $1
      GROUP BY b.address
      ORDER BY ${orderBy}
      LIMIT $2
    `;
    const rows = await query<any>(sql, [from, limit]);
    return NextResponse.json({ ok: true, data: rows });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
