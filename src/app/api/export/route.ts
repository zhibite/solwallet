/**
 * /api/export
 * GET - 导出已确认目标为 CSV
 * query: ?type=confirmed|targets|transactions
 */
import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get('type') || 'confirmed';

  let sql = '';
  let filename = '';
  switch (type) {
    case 'confirmed':
      sql = `SELECT address, label, source, first_seen_at, confirmed_at FROM confirmed_targets ORDER BY confirmed_at DESC`;
      filename = 'confirmed_targets.csv';
      break;
    case 'targets':
      sql = `SELECT id, address, label, threshold_sol::text, status, record_count, last_buy_at FROM monitored_targets ORDER BY id DESC`;
      filename = 'targets.csv';
      break;
    case 'transactions':
      sql = `SELECT signature, target_address, mint, slot, block_time, buy_sol::text, pnl_sol::text, status, confirmed FROM target_trades ORDER BY block_time DESC LIMIT 5000`;
      filename = 'transactions.csv';
      break;
    default:
      return NextResponse.json({ ok: false, error: 'unknown type' }, { status: 400 });
  }

  const rows = await query<any>(sql);
  if (rows.length === 0) {
    return new NextResponse('No data', { status: 404 });
  }

  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(','),
    ...rows.map((r) =>
      headers
        .map((h) => {
          const v = r[h];
          if (v === null || v === undefined) return '';
          const s = String(v).replace(/"/g, '""');
          return /[,"\n]/.test(s) ? `"${s}"` : s;
        })
        .join(','),
    ),
  ].join('\n');

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
