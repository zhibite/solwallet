/**
 * /api/analyze/block
 * POST - 手动重跑某个 slot/mint 的 block 级分析
 * body: { slot, mint, targetSig }
 */
import { NextRequest, NextResponse } from 'next/server';
import { analyzeBlock, saveBlockAnalysis, applyFirstSniperToTarget } from '@/lib/first-sniper';

export async function POST(req: NextRequest) {
  const { slot, mint, targetSig } = await req.json();
  const slotN = Number(slot);
  if (!slotN || !mint) {
    return NextResponse.json({ ok: false, error: 'slot/mint 必填' }, { status: 400 });
  }
  try {
    const result = await analyzeBlock(slotN, mint, targetSig);
    const blockTime = new Date().toISOString();
    const analysisId = await saveBlockAnalysis(slotN, mint, targetSig || '', blockTime, result);

    // 关键：和 monitor.ts / ws-monitor.ts 一样，analyzeBlock + saveBlockAnalysis 之后
    // 必须把 first_sniper 回写到 target_trades，否则会出现
    //   block_buyers.is_first_sniper = true
    //   target_trades.first_sniper   = null
    // 的不一致，导致 L2 "第一个狙击者" 列显示 "—" 但 L3 块详情里又能看到。
    // 之前这里漏了这一步，是用户最常见的"明明展开了有，列表里没有"的原因。
    let sniperApplied = false;
    if (targetSig) {
      try {
        const r = await applyFirstSniperToTarget(targetSig, result);
        sniperApplied = r.updated;
      } catch (sniperErr: any) {
        // 回填失败不阻塞响应 —— analyze 结果已经存到 block_analyses / block_buyers，
        // 单独打日志让人能追；下次其他路径触发也会再写一次。
        console.warn(
          '[analyze/block] applyFirstSniperToTarget failed sig=' + targetSig.slice(0, 14) + '…',
          sniperErr?.message ?? sniperErr,
        );
      }
    }

    return NextResponse.json({
      ok: true,
      analysisId,
      count: result.buyers.length,
      sameSlotCount: result.sameSlotCount,
      nextSlotCount: result.nextSlotCount,
      // 0021: 狙击者竞争态势
      competitorCount: result.competitorCount,
      chosenAddress: result.chosenAddress,
      sniperApplied,
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
