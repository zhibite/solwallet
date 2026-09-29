/**
 * /api/settings
 * GET / PUT - 系统设置（数据库存储的环境变量覆盖）
 */
import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';

export async function GET() {
  try {
    const rows = await query<{ key: string; value: any }>('SELECT key, value FROM settings');
    const data: Record<string, string> = {};
    for (const r of rows) data[r.key] = r.value;
    return NextResponse.json({ ok: true, data });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const body = await req.json();
  try {
    for (const [key, value] of Object.entries(body)) {
      await queryOne(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, JSON.stringify(value)],
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
