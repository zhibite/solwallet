/**
 * /api/analyze
 * POST - 对某个地址做历史 PnL 分析
 * body: { address, from, to, includeFailed }
 */
import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { getHelius } from '@/lib/helius';
import { getRPC } from '@/lib/solana-rpc';
import { parseHeliusTx } from '@/lib/parser';
import { calcTradePnL } from '@/lib/pnl';

export async function POST(req: NextRequest) {
  const { address, from, to, includeFailed } = await req.json();

  if (!address || typeof address !== 'string') {
    return NextResponse.json({ ok: false, error: 'address 不合法' }, { status: 400 });
  }

  const fromTs = from ? new Date(from).getTime() / 1000 : Math.floor(Date.now() / 1000) - 86400 * 30;
  const toTs = to ? new Date(to).getTime() / 1000 : Math.floor(Date.now() / 1000);

  try {
    const helius = getHelius();
    const rpc = getRPC();

    // 1) 拉签名
    const sigs = await helius.getSignaturesForAddress(address, { limit: 200 });
    const inRange = sigs.filter((s) => (s.blockTime ?? 0) >= fromTs && (s.blockTime ?? 0) <= toTs);

    // 2) 解析每一笔，找出 buy
    const trades = [];
    let totalPnl = 0;
    let failedFee = 0;
    let confirmed = 0;
    let pending = 0;
    let buyCount = 0;
    let failed = 0;

    for (const s of inRange) {
      if (s.err) continue;
      try {
        const tx = await helius.parseTransaction(s.signature);
        if (!tx) continue;
        const buy = parseHeliusTx(tx);
        if (!buy || buy.address !== address) continue;

        buyCount++;
        const result = await calcTradePnL({
          mint: buy.mint,
          buySig: buy.signature,
          buyWallet: address,
          buySol: buy.buySol,
          buyBlockTime: buy.blockTime,
          includeFailed,
        });
        totalPnl += result.totalPnl;
        failedFee += result.failedFee;
        confirmed += result.confirmed;
        pending += result.pending;
        failed += result.failed;

        trades.push({
          signature: buy.signature,
          slot: buy.slot,
          blockTime: buy.blockTime,
          mint: buy.mint,
          sol: buy.buySol,
          pnl: result.totalPnl,
          status: result.confirmed > 0 ? 'confirmed' : result.pending > 0 ? 'pending' : 'failed',
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
        totalPnl,
        failedFee,
        netPnl: totalPnl - failedFee,
        buyCount,
        failed,
        confirmed,
        pending,
        trades,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
