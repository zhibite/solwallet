/**
 * /api/block/[slot]/[mint]/buyer/[id]/pnl
 * POST  - 重算该 buyer 的单笔跟单收益（写回 block_buyers.pnl_sol / pnl_status / pnl_sold_ratio）
 * DELETE - 取消算（清空这三个字段）
 */
import { NextRequest, NextResponse } from 'next/server';
import { queryOne, execute } from '@/lib/db';
import { calcCopyPnl } from '@/lib/pnl';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ slot: string; mint: string; id: string }> }) {
  const { slot, mint, id } = await ctx.params;
  const buyerId = parseInt(id, 10);
  if (Number.isNaN(buyerId)) {
    return NextResponse.json({ ok: false, error: 'id 不合法' }, { status: 400 });
  }

  try {
    const buyer = await queryOne<any>(
      `SELECT bb.id, bb.slot, bb.signature, bb.address,
              bb.buy_sol::text AS buy_sol,
              bb.token_amount::text AS token_amount,
              bb.prio_lamports,
              bb.result,
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
    const tokenAmount = buyer.token_amount != null ? Number(buyer.token_amount) : null;

    const result = await calcCopyPnl({
      mint: buyer.mint,
      buySig: buyer.signature,
      buyWallet: buyer.address,
      buySol: parseFloat(buyer.buy_sol),
      buyBlockTime: blockTime,
      buyTokenAmount: tokenAmount,
    });

    // pnl_sol 只在有已实现收益时写数；持仓中写 NULL，和真实的 0 区分开
    await execute(
      `UPDATE block_buyers
          SET pnl_sol = $1, pnl_status = $2, pnl_sold_ratio = $3, token_amount = COALESCE($4, token_amount)
        WHERE id = $5`,
      [result.pnlSol, result.status, result.soldRatio, tokenAmount, buyerId],
    );

    return NextResponse.json({
      ok: true,
      pnl_sol: result.pnlSol,
      pnl_status: result.status,
      sold_ratio: result.soldRatio,
      remaining_token: result.remainingTokenAmount,
      later_buys: result.laterBuys,
      failed_fee: result.failedFeeSol,
      trades: result.trades,
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const buyerId = parseInt(id, 10);
  if (Number.isNaN(buyerId)) {
    return NextResponse.json({ ok: false, error: 'id 不合法' }, { status: 400 });
  }
  try {
    await execute(
      `UPDATE block_buyers SET pnl_sol = NULL, pnl_status = NULL, pnl_sold_ratio = NULL WHERE id = $1`,
      [buyerId],
    );
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
