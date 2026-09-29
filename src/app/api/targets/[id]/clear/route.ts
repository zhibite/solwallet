/**
 * /api/targets/[id]/clear
 * POST - 清除某个目标的所有交易记录（含相关 block_analyses）
 */
import { NextRequest, NextResponse } from 'next/server';
import { withTransaction } from '@/lib/db';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const targetId = parseInt(id, 10);

  const result = await withTransaction(async (client) => {
    // 1) 收集要清掉的 sigs
    const sigsRes = await client.query<{ signature: string }>(
      'SELECT signature FROM target_trades WHERE target_id = $1',
      [targetId],
    );
    const sigs = sigsRes.rows.map((r) => r.signature);

    // 2) 清 block_analyses（block_buyers 通过 ON DELETE CASCADE 一起清）
    let analyses = 0;
    if (sigs.length > 0) {
      const r = await client.query(
        'DELETE FROM block_analyses WHERE target_signature = ANY($1)',
        [sigs],
      );
      analyses = r.rowCount ?? 0;
    }

    // 3) 清 target_trades
    const trades = await client.query('DELETE FROM target_trades WHERE target_id = $1', [targetId]);

    // 4) 重置 record_count
    await client.query('UPDATE monitored_targets SET record_count = 0 WHERE id = $1', [targetId]);

    return { trades: trades.rowCount ?? 0, analyses };
  });

  return NextResponse.json({ ok: true, deleted: result });
}
