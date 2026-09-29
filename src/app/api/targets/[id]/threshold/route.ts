/**
 * /api/targets/[id]/threshold
 * POST - 更新阈值
 * body: { threshold_sol: number }
 */
import { NextRequest, NextResponse } from 'next/server';
import { execute } from '@/lib/db';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { threshold_sol } = await req.json();
  if (typeof threshold_sol !== 'number' || threshold_sol < 0) {
    return NextResponse.json({ ok: false, error: 'threshold_sol 必须为非负数' }, { status: 400 });
  }
  const n = await execute(
    'UPDATE monitored_targets SET threshold_sol = $1, updated_at = NOW() WHERE id = $2',
    [threshold_sol, id],
  );
  if (n === 0) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
