/**
 * /api/analyze
 * POST - 对某个地址做历史单笔跟单收益分析
 * body: { address, from, to }
 *
 * 每一笔买入独立按 token 数量 FIFO 配对算自己的收益，然后汇总。
 * 汇总时「持仓中」的买入不计入已实现盈亏，单独计数。
 */
import { NextRequest, NextResponse } from 'next/server';
import { getHelius } from '@/lib/helius';
import { parseHeliusTx } from '@/lib/parser';
import { calcCopyPnl, isFailedTx } from '@/lib/pnl';

export async function POST(req: NextRequest) {
  const { address, from, to } = await req.json();

  if (!address || typeof address !== 'string') {
    return NextResponse.json({ ok: false, error: 'address 不合法' }, { status: 400 });
  }

  const fromTs = from ? new Date(from).getTime() / 1000 : Math.floor(Date.now() / 1000) - 86400 * 30;
  const toTs = to ? new Date(to).getTime() / 1000 : Math.floor(Date.now() / 1000);

  try {
    const helius = getHelius();

    // 1) 拉签名
    const sigs = await helius.getSignaturesForAddress(address, { limit: 200 });
    const inRange = sigs.filter((s) => (s.blockTime ?? 0) >= fromTs && (s.blockTime ?? 0) <= toTs);

    // 2) 解析每一笔，找出 buy
    const trades = [];
    let realizedPnl = 0;
    let openCount = 0;
    let closedCount = 0;
    let partialCount = 0;
    let buyFailedCount = 0;
    let buyCount = 0;
    let failedFee = 0;

    for (const s of inRange) {
      if (s.err) continue;
      try {
        const tx = await helius.parseTransaction(s.signature);
        if (!tx || isFailedTx(tx)) continue;
        const buy = parseHeliusTx(tx);
        if (!buy || buy.address !== address) continue;

        buyCount++;
        const result = await calcCopyPnl({
          mint: buy.mint,
          buySig: buy.signature,
          buyWallet: address,
          buySol: buy.buySol,
          buyBlockTime: buy.blockTime,
          buyTokenAmount: buy.tokenAmount ?? null,
          buyFeeLamports: tx.fee ?? null,
        });
        if (result.pnlSol != null) realizedPnl += result.pnlSol;
        failedFee += result.failedFeeSol;
        // 四个状态必须全部计数：前端「已平仓」标签同时筛 closed + partial，
        // 「持仓中」同时筛 open + buy_failed，只数其中两个会让标签上的数字对不上行数。
        if (result.status === 'open') openCount++;
        if (result.status === 'closed') closedCount++;
        if (result.status === 'partial') partialCount++;
        if (result.status === 'buy_failed') buyFailedCount++;

        trades.push({
          signature: buy.signature,
          slot: buy.slot,
          blockTime: buy.blockTime,
          mint: buy.mint,
          sol: buy.buySol,
          tokenAmount: result.buyTokenAmount,
          pnl: result.pnlSol,
          status: result.status,
          soldRatio: result.soldRatio,
          version: buy.version,
          tip: buy.tipSol,
          prio: buy.prioLamports,
          txid: buy.signature,
        });
      } catch (err) {
        console.warn('[analyze] tx parse failed', s.signature, err);
      }
    }

    return NextResponse.json({
      ok: true,
      data: {
        realizedPnl,
        failedFee,
        buyCount,
        closedCount,
        openCount,
        partialCount,
        buyFailedCount,
        trades,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
