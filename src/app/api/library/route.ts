/**
 * /api/library
 * GET - 跟单库（已确认目标的地址池）
 * POST - 手动添加
 * DELETE - 删除
 */
import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne, execute } from '@/lib/db';

export async function GET() {
  try {
    const rows = await query<any>(`
      SELECT id, address, label, source, first_seen_at, confirmed_at,
             (SELECT COUNT(*) FROM target_trades t WHERE t.target_address = c.address AND t.confirmed = true)::int AS trade_count
      FROM confirmed_targets c
      ORDER BY confirmed_at DESC
      LIMIT 500
    `);
    return NextResponse.json({ ok: true, data: rows });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const { address, label, source = 'manual' } = await req.json();
  if (!address) return NextResponse.json({ ok: false, error: 'address 必填' }, { status: 400 });
  try {
    const row = await queryOne(
      `INSERT INTO confirmed_targets (address, label, source) VALUES ($1, $2, $3)
       ON CONFLICT (address) DO UPDATE SET label = EXCLUDED.label
       RETURNING *`,
      [address, label || null, source],
    );
    return NextResponse.json({ ok: true, data: row });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id 必填' }, { status: 400 });
  await execute('DELETE FROM confirmed_targets WHERE id = $1', [id]);
  return NextResponse.json({ ok: true });
}
