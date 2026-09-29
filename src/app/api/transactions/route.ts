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
    SELECT t.*, mt.label AS target_label
    FROM target_trades t
    LEFT JOIN monitored_targets mt ON mt.id = t.target_id
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
