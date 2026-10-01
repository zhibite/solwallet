/**
 * /api/transactions
 * GET - 查询交易列表（支持 target / mint / 时间范围过滤）
 */
import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const targetId = searchParams.get('target_id');
  const address = searchParams.get('address');
  const mint = searchParams.get('mint');
  const from = searchParams.get('from');  // ISO string
  const to = searchParams.get('to');
  const confirmed = searchParams.get('confirmed'); // true/false
  const limit = parseInt(searchParams.get('limit') || '200', 10);

  const conditions: string[] = [];
  const params: any[] = [];

  if (targetId) {
    params.push(targetId);
    conditions.push(`t.target_id = $${params.length}`);
  }
  if (address) {
    params.push(address);
    conditions.push(`t.target_address = $${params.length}`);
  }
  if (mint) {
    params.push(mint);
    conditions.push(`t.mint = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`t.block_time >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`t.block_time <= $${params.length}`);
  }
  if (confirmed === 'true') {
    conditions.push('t.confirmed = true');
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);

  const sql = `
    SELECT t.*,
           mt.label AS target_label,
           b_first.slot AS first_sniper_slot,
           b_first.signature AS first_sniper_buyer_signature,
           b_first.offset_ms AS first_sniper_offset_ms,
           b_own.block_index AS my_block_index,
           b_own.tip_sol::text AS my_tip_sol,
           b_own.prio_lamports AS my_prio_lamports,
           b_own.signature AS my_signature,
           b_own.result AS my_result,
           ba.same_slot_count AS same_slot_count,
           ba.next_slot_count AS next_slot_count
    FROM target_trades t
    LEFT JOIN monitored_targets mt ON mt.id = t.target_id
    LEFT JOIN block_buyers b_first ON b_first.signature = t.first_sniper_signature
    LEFT JOIN block_analyses ba ON ba.slot = t.slot AND ba.mint = t.mint
    LEFT JOIN LATERAL (
      SELECT bb.*
      FROM block_buyers bb
      JOIN block_analyses ba ON ba.id = bb.block_analysis_id
      WHERE bb.slot = t.slot AND ba.mint = t.mint AND bb.is_own = true
      ORDER BY bb.block_index ASC
      LIMIT 1
    ) b_own ON true
    ${where}
    ORDER BY t.block_time DESC
    LIMIT $${params.length}
  `;
  try {
    const rows = await query<any>(sql, params);
    return NextResponse.json({ ok: true, data: rows });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
