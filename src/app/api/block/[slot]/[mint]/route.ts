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
    // 第 3 层展开只显示"狙击者 + 跟随者"：目标本人不展示（其地址 / 买入 SOL
    // 已经单独挂到 analysis.target_address / target_buy_sol，摘要行直接读那里）。
    // 这样 table 第 1 行就是"第一个狙击者"，与"我们显示的是从第 1 狙击开始"语义一致。
    const otherBuyers = result.buyers.filter((b) => b.signature !== targetSig);
    const buyers: BlockBuyer[] = otherBuyers.map((b) => ({
      ...b,
      is_self: false, // 目标本人已被过滤，这里永远 false
    }));
    return NextResponse.json({
      ok: true,
      data: {
        analysis: {
          ...result.analysis,
          target_address: targetBuyer?.address,
          target_buy_sol: targetBuyer?.buy_sol,
          // 0021: 狙击者竞争态势（从 block_analyses 顶层透传）
          // competitor_rank 是 PG JSONB，前端按 address 查
          competitor_count: (result.analysis as any).competitor_count ?? null,
          chosen_address: (result.analysis as any).chosen_address ?? null,
          competitor_rank: (result.analysis as any).competitor_rank ?? {},
        },
        buyers,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
