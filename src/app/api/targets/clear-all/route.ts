/**
 * /api/targets/clear-all
 * POST - 清空全部 target_trades 记录（含相关 block_analyses，慎用）
 *
 * 安全约束：必须传 `{ confirm: true }` body，否则拒绝。
 * （鉴权由 Basic Auth 反向代理 / 内部网络层负责；该端点只清监控数据，
 *  不触及钱包/资金/私钥，confirm 双重确认已足以防误触。）
 * 返回: { deleted: { trades, analyses } }
 */
import { NextRequest, NextResponse } from 'next/server';
import { withTransaction } from '@/lib/db';

export async function POST(req: NextRequest) {
  // 必须显式 confirm：true 才能执行
  const body = await req.json().catch(() => ({}));
  if (body.confirm !== true) {
    return NextResponse.json(
      { ok: false, error: '必须传 { confirm: true } 才能执行清空操作' },
      { status: 400 },
    );
  }

  try {
    const result = await withTransaction(async (client) => {
      // 1) 收集所有 sigs（用于日志）
      const sigsRes = await client.query<{ signature: string }>('SELECT signature FROM target_trades');
      const sigs = sigsRes.rows.map((r) => r.signature);

      // 2) 清 block_analyses（block_buyers 通过 ON DELETE CASCADE 一起清）
      // 注意：可能有孤立的 block_analyses 记录（无对应 target_signature），需要无条件全清
      const r2 = await client.query('DELETE FROM block_analyses');
      const analyses = r2.rowCount ?? 0;

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
