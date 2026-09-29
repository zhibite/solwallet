/**
 * /api/groups
 * GET - 组合排行（找经常一起出现的聪明钱组合）
 * 这是较复杂的功能：找出在同 slot 多次同时买入 mint 的地址组合
 */
import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = parseInt(searchParams.get('limit') || '50', 10);

  try {
    // 简化：找所有 mint 下，至少 2 个不同狙击者同时买入（同一 slot）的组合
    const rows = await query<any>(`
      WITH slot_buyers AS (
        SELECT
          b.slot,
          b.mint,
          b.address,
          b.signature
        FROM block_buyers b
        WHERE b.is_first_sniper = true OR b.is_follower = true
      ),
      pair_co AS (
        SELECT
          a.address AS addr_a,
          b.address AS addr_b,
          a.mint,
          a.slot
        FROM slot_buyers a
        JOIN slot_buyers b ON a.slot = b.slot AND a.mint = b.mint AND a.address < b.address
      ),
      pair_stats AS (
        SELECT
          addr_a,
          addr_b,
          COUNT(DISTINCT mint)::int AS shared_mints,
          COUNT(*)::int AS co_occurrences,
          MIN(slot) AS first_slot,
          MAX(slot) AS last_slot
        FROM pair_co
        GROUP BY addr_a, addr_b
      )
      SELECT
        ps.*,
        (SELECT total_pnl_sol FROM smart_money_library WHERE address = ps.addr_a) AS pnl_a,
        (SELECT total_pnl_sol FROM smart_money_library WHERE address = ps.addr_b) AS pnl_b
      FROM pair_stats ps
      WHERE shared_mints >= 2
      ORDER BY shared_mints DESC, co_occurrences DESC
      LIMIT $1
    `, [limit]);

    return NextResponse.json({ ok: true, data: rows });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
