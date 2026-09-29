/**
 * /api/ranking
 * GET - 跟单排行数据
 * query: ?from=&to=&limit=
 */
import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = parseInt(searchParams.get('limit') || '50', 10);
  const from = searchParams.get('from') || new Date(Date.now() - 86400_000 * 30).toISOString();

  try {
    const rows = await query<any>(`
      SELECT
        target_address AS address,
        COUNT(*)::int AS trade_count,
        SUM(buy_sol)::text AS total_buy,
        SUM(pnl_sol)::text AS total_pnl,
        AVG(pnl_sol)::text AS avg_pnl,
        SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END)::int AS win_count,
        SUM(CASE WHEN pnl_sol < 0 THEN 1 ELSE 0 END)::int AS loss_count,
        MAX(block_time) AS last_active
      FROM target_trades
      WHERE confirmed = true AND block_time >= $1
      GROUP BY target_address
      ORDER BY SUM(pnl_sol) DESC NULLS LAST
      LIMIT $2
    `, [from, limit]);

    return NextResponse.json({ ok: true, data: rows });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
