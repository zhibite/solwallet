/**
 * /api/targets/clear-all
 * POST - 清空全部 target_trades 记录（慎用）
 * 返回: { deleted: number }
 */
import { NextRequest, NextResponse } from 'next/server';
import { execute } from '@/lib/db';

export async function POST(_req: NextRequest) {
  try {
    const deleted = await execute('DELETE FROM target_trades');
    return NextResponse.json({ ok: true, deleted });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
