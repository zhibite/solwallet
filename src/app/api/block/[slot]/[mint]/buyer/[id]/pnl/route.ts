/**
 * /api/block/[slot]/[mint]/buyer/[id]/pnl
 * POST  - 重算该 buyer 的 PnL（写回 block_buyers.pnl_sol）
 * DELETE - 取消算（清空 block_buyers.pnl_sol）
 */
import { NextRequest, NextResponse } from 'next/server';
import { queryOne, execute } from '@/lib/db';
import { calcTradePnL } from '@/lib/pnl';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ slot: string; mint: string; id: string }> }) {
  const { slot, mint, id } = await ctx.params;
  const buyerId = parseInt(id, 10);
  if (Number.isNaN(buyerId)) {
    return NextResponse.json({ ok: false, error: 'id 不合法' }, { status: 400 });
  }

  try {
    // 取出 buyer + 对应 analysis 的 mint / block_time
    const buyer = await queryOne<any>(
      `SELECT bb.id, bb.slot, bb.signature, bb.address, bb.buy_sol::text AS buy_sol,
              ba.mint, ba.block_time
       FROM block_buyers bb
       JOIN block_analyses ba ON ba.id = bb.block_analysis_id
       WHERE bb.id = $1 AND ba.slot = $2 AND ba.mint = $3
       LIMIT 1`,
      [buyerId, slot, mint],
    );
    if (!buyer) {
      return NextResponse.json({ ok: false, error: 'buyer 不存在' }, { status: 404 });
    }

    const blockTime = Math.floor(new Date(buyer.block_time).getTime() / 1000);
    const buySol = parseFloat(buyer.buy_sol);

    // 算 PnL
    const result = await calcTradePnL({
      mint: buyer.mint,
      buySig: buyer.signature,
      buyWallet: buyer.address,
      buySol,
      buyBlockTime: blockTime,
      includeFailed: false,
    });

    // 只取最后一笔 sell 的 PnL（第一笔 buy 的对面 sell）
    // calcTradePnL 返回 trades[0] = buy，trades[1..] = sells
    const sell = result.trades.find((t) => t.side === 'sell');
    const pnlSol = sell ? sell.pnlSol : null;

    await execute(
      `UPDATE block_buyers SET pnl_sol = $1 WHERE id = $2`,
      [pnlSol, buyerId],
    );

    return NextResponse.json({
      ok: true,
      pnl_sol: pnlSol,
      confirmed: result.confirmed,
      pending: result.pending,
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ slot: string; mint: string; id: string }> }) {
  const { id } = await ctx.params;
  const buyerId = parseInt(id, 10);
  if (Number.isNaN(buyerId)) {
    return NextResponse.json({ ok: false, error: 'id 不合法' }, { status: 400 });
  }
  try {
    await execute(`UPDATE block_buyers SET pnl_sol = NULL WHERE id = $1`, [buyerId]);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
