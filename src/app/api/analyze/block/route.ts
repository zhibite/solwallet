/**
 * /api/analyze/block
 * POST - 手动重跑某个 slot/mint 的 block 级分析
 * body: { slot, mint }
 */
import { NextRequest, NextResponse } from 'next/server';
import { analyzeBlock, saveBlockAnalysis } from '@/lib/first-sniper';

export async function POST(req: NextRequest) {
  const { slot, mint, targetSig } = await req.json();
  if (!slot || !mint) {
    return NextResponse.json({ ok: false, error: 'slot/mint 必填' }, { status: 400 });
  }
  try {
    const buyers = await analyzeBlock(slot, mint, targetSig);
    const blockTime = new Date().toISOString();
    const analysisId = await saveBlockAnalysis(slot, mint, targetSig || '', blockTime, buyers);
    return NextResponse.json({ ok: true, analysisId, count: buyers.length });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
