/**
 * /api/targets/cleanup
 * POST - 清理旧记录
 * body: { olderThanDays?: number }   默认 30 天
 * 返回: { deleted: number }
 */
import { NextRequest, NextResponse } from 'next/server';
import { execute } from '@/lib/db';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const days = parseInt(String(body?.olderThanDays ?? 30), 10);
  if (Number.isNaN(days) || days < 1) {
    return NextResponse.json({ ok: false, error: 'olderThanDays 不合法' }, { status: 400 });
  }
  try {
    const deleted = await execute(
      `DELETE FROM target_trades WHERE block_time < NOW() - ($1 || ' days')::interval`,
      [String(days)],
    );
    return NextResponse.json({ ok: true, deleted });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
