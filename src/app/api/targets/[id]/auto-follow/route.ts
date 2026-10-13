/**
 * /api/targets/[id]/auto-follow
 * POST - 开启/关闭自动跟单
 */
import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const body = await req.json();
    const auto_follow = !!body.on;

    const row = await queryOne<any>(
      'UPDATE monitored_targets SET auto_follow = $2 WHERE id = $1 RETURNING id, auto_follow',
      [id, auto_follow],
    );
    if (!row) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true, data: row });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
