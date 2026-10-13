/**
 * /api/block/[slot]/[mint]/pnl
 * POST - 批量算这个 block 里所有 buyer 的跟单收益，并行跑 + 写回 DB
 *
 * 用法：UI 展开 block 时点 "批量算收益"，或在自动展开时直接调用
 *
 * 行为：
 *   - 默认跳过已经算过 pnl_status 非空的 buyer
 *   - force=true 会把所有人重算一遍（包括之前算过的）
 *   - 失败 tx (result='failed') 永远跳过（pnl 固定就是手续费，已在初始分析时写过）
 *
 * 性能：
 *   - 20 笔 × ~3-8s/笔 ÷ 4 并发 ≈ 15-40s
 *   - DB 里有 pnl_sol 后，再展开 block 直接秒开
 */
import { NextRequest, NextResponse } from 'next/server';
import { computeBulkBuyerPnL } from '@/lib/first-sniper';

export async function POST(req: NextRequest, ctx: { params: Promise<{ slot: string; mint: string }> }) {
  const { slot, mint } = await ctx.params;
  const slotNum = parseInt(slot, 10);
  if (Number.isNaN(slotNum)) {
    return NextResponse.json({ ok: false, error: 'slot 不合法' }, { status: 400 });
  }
  // body 可选；没有 body / body 不是 JSON 都按 force=false 走
  let force = false;
  try {
    const body = (await req.json().catch(() => null)) as { force?: boolean } | null;
    force = body?.force === true;
  } catch {
    force = false;
  }

  try {
    const { results, analysis, skippedExisting } = await computeBulkBuyerPnL(slotNum, mint, {
      force,
    });
    return NextResponse.json({
      ok: true,
      computed: results.length,
      skipped: skippedExisting,
      results,
      analysis: analysis ? { slot: analysis.slot, mint: analysis.mint } : null,
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message ?? String(err) }, { status: 500 });
  }
}
