/**
 * /api/wallets
 * GET  - 列出自己钱包
 * POST - 添加自己钱包 { address, label }
 * DELETE - 删除自己钱包 ?id=
 */
import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne, execute } from '@/lib/db';

export async function GET() {
  try {
    const rows = await query<any>('SELECT id, address, label, created_at FROM own_wallets ORDER BY id DESC');
    return NextResponse.json({ ok: true, data: rows });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const { address, label } = await req.json();
  if (!address) return NextResponse.json({ ok: false, error: 'address 必填' }, { status: 400 });
  try {
    const row = await queryOne<any>(
      `INSERT INTO own_wallets (address, label) VALUES ($1, $2)
       ON CONFLICT (address) DO UPDATE SET label = EXCLUDED.label
       RETURNING id, address, label, created_at`,
      [address, label || null],
    );
    return NextResponse.json({ ok: true, data: row });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  const address = searchParams.get('address');
  try {
    let n = 0;
    if (id) {
      n = await execute('DELETE FROM own_wallets WHERE id = $1', [id]);
    } else if (address) {
      n = await execute('DELETE FROM own_wallets WHERE address = $1', [address]);
    } else {
      return NextResponse.json({ ok: false, error: 'id 或 address 必填' }, { status: 400 });
    }
    return NextResponse.json({ ok: true, deleted: n });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
