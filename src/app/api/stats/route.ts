/**
 * /api/stats
 * GET - 全局统计（首页用）
 */
import { NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';

export async function GET() {
  try {
    const [targets, activeCount, recordedBuys, pending, analyzed] = await Promise.all([
      queryOne<{ count: string }>('SELECT COUNT(*)::text AS count FROM monitored_targets'),
      queryOne<{ count: string }>("SELECT COUNT(*)::text AS count FROM monitored_targets WHERE status = 'active'"),
      queryOne<{ count: string }>('SELECT COUNT(*)::text AS count FROM target_trades'),
      queryOne<{ count: string }>("SELECT COUNT(*)::text AS count FROM target_trades WHERE status = 'pending'"),
      queryOne<{ count: string }>("SELECT COUNT(*)::text AS count FROM target_trades WHERE status = 'confirmed'"),
    ]);
    return NextResponse.json({
      ok: true,
      data: {
        totalTargets: parseInt(targets?.count || '0', 10),
        activeTargets: parseInt(activeCount?.count || '0', 10),
        recordedBuys: parseInt(recordedBuys?.count || '0', 10),
        pending: parseInt(pending?.count || '0', 10),
        analyzed: parseInt(analyzed?.count || '0', 10),
      },
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
