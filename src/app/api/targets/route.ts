/**
 * /api/targets
 * GET  - 列表
 * POST - 添加监控目标
 */

import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status');
  const limit = parseInt(searchParams.get('limit') || '100', 10);

  try {
    const sql = `
      SELECT id, address, label, threshold_sol::text, status,
             created_at, updated_at, last_buy_at, record_count
      FROM monitored_targets
      ${status ? 'WHERE status = $1' : ''}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    const rows = await query<any>(sql, status ? [status] : []);
    return NextResponse.json({ ok: true, data: rows });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { address, label, threshold_sol = 0.5 } = body || {};
    if (!address || typeof address !== 'string' || address.length < 32 || address.length > 44) {
      return NextResponse.json({ ok: false, error: 'address 不合法' }, { status: 400 });
    }

    const row = await queryOne<any>(
      `INSERT INTO monitored_targets (address, label, threshold_sol)
       VALUES ($1, $2, $3)
       ON CONFLICT (address) DO UPDATE SET label = EXCLUDED.label, threshold_sol = EXCLUDED.threshold_sol
       RETURNING *`,
      [address, label || null, threshold_sol],
    );
    return NextResponse.json({ ok: true, data: row });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
