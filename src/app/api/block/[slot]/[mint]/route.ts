/**
 * /api/block/[slot]/[mint]
 * GET - 获取 block 级深度分析
 */
import { NextRequest, NextResponse } from 'next/server';
import { getBlockAnalysis } from '@/lib/first-sniper';
import type { BlockBuyer } from '@/lib/types';

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
    // 标记「目标本人」：signature = analysis.target_signature
    const targetSig = result.analysis.target_signature;
    // 找出目标本人的交易（用于提取 target_address 和 target_buy_sol）
    const targetBuyer = result.buyers.find((b) => b.signature === targetSig);
    const buyers: BlockBuyer[] = result.buyers.map((b) => ({
      ...b,
      is_self: b.signature === targetSig,
    }));
    return NextResponse.json({
      ok: true,
      data: {
        analysis: {
          ...result.analysis,
          target_address: targetBuyer?.address,
          target_buy_sol: targetBuyer?.buy_sol,
        },
        buyers,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
