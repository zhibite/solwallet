/**
 * /api/targets/clear-all
 * POST - 清空全部 target_trades 记录（含相关 block_analyses，慎用）
 * 返回: { deleted: { trades, analyses } }
 */
import { NextRequest, NextResponse } from 'next/server';
import { withTransaction } from '@/lib/db';

export async function POST(_req: NextRequest) {
  try {
    const result = await withTransaction(async (client) => {
      // 1) 收集所有 sigs
      const sigsRes = await client.query<{ signature: string }>('SELECT signature FROM target_trades');
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
      const trades = await client.query('DELETE FROM target_trades');

      // 4) 重置所有 record_count
      await client.query('UPDATE monitored_targets SET record_count = 0');

      return { trades: trades.rowCount ?? 0, analyses };
    });

    return NextResponse.json({ ok: true, deleted: result });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
