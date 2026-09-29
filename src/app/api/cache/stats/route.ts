/**
 * /api/cache/stats
 * GET - 缓存统计
 * POST - 清空缓存（{ prefix?: string }）
 */
import { NextRequest, NextResponse } from 'next/server';
import { Cache } from '@/lib/cache';

export async function GET() {
  try {
    const stats = await Cache.stats();
    return NextResponse.json({ ok: true, data: stats });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { prefix } = await req.json().catch(() => ({}));
    await Cache.clear();
    return NextResponse.json({ ok: true, cleared: prefix ?? 'all' });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
