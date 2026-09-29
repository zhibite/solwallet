/**
 * /api/confirm
 * POST - 一键确认目标（把地址加入 confirmed_targets）
 * body: { address, label?, source? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne, execute } from '@/lib/db';

export async function POST(req: NextRequest) {
  const { address, label, source = 'manual' } = await req.json();
  if (!address) return NextResponse.json({ ok: false, error: 'address 必填' }, { status: 400 });
  try {
    const row = await queryOne<any>(
      `INSERT INTO confirmed_targets (address, label, source)
       VALUES ($1, $2, $3)
       ON CONFLICT (address) DO UPDATE SET label = EXCLUDED.label
       RETURNING *`,
      [address, label || null, source],
    );
    // 标记对应的交易为 confirmed
    await execute('UPDATE target_trades SET confirmed = true WHERE target_address = $1', [address]);
    return NextResponse.json({ ok: true, data: row });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

/** 批量确认 */
export async function PUT(req: NextRequest) {
  const { addresses, source = 'bulk' } = await req.json();
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return NextResponse.json({ ok: false, error: 'addresses 必须为非空数组' }, { status: 400 });
  }
  let count = 0;
  for (const addr of addresses) {
    try {
      await queryOne(
        `INSERT INTO confirmed_targets (address, source) VALUES ($1, $2)
         ON CONFLICT (address) DO NOTHING`,
        [addr, source],
      );
      await execute('UPDATE target_trades SET confirmed = true WHERE target_address = $1', [addr]);
      count++;
    } catch (err) {
      console.warn('[confirm] failed', addr, err);
    }
  }
  return NextResponse.json({ ok: true, confirmed: count });
}
