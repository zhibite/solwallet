/**
 * /api/block/[slot]/[mint]
 * GET - 获取 block 级深度分析
 */
import { NextRequest, NextResponse } from 'next/server';
import { getBlockAnalysis } from '@/lib/first-sniper';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ slot: string; mint: string }> }) {
  const { slot, mint } = await ctx.params;
  const slotNum = parseInt(slot, 10);
  if (Number.isNaN(slotNum)) {
    return NextResponse.json({ ok: false, error: 'slot 不合法' }, { status: 400 });
  }
  try {
    const result = await getBlockAnalysis(slotNum, mint);
    if (!result) {
      return NextResponse.json({ ok: false, error: '分析不存在' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, data: result });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
