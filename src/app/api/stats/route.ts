/**
 * /api/stats
 * GET - 全局统计（首页用）
 *   recordedBuys = target_trades 总数
 *   pending      = target_trades 中还没分析完的（block_analyses 里没对应记录）
 *   analyzed     = block_analyses 去重后的 target_signature 数（每个被分析过的目标 trade 一次）
 */
import { NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';

export async function GET() {
  try {
    const [targets, activeCount, recordedBuys, pending, analyzed] = await Promise.all([
      queryOne<{ count: string }>('SELECT COUNT(*)::text AS count FROM monitored_targets'),
      queryOne<{ count: string }>("SELECT COUNT(*)::text AS count FROM monitored_targets WHERE status = 'active'"),
      queryOne<{ count: string }>('SELECT COUNT(*)::text AS count FROM target_trades'),
      queryOne<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM target_trades t
        WHERE NOT EXISTS (
          SELECT 1 FROM block_analyses b
          WHERE b.target_signature = t.signature
        )
      `),
      queryOne<{ count: string }>('SELECT COUNT(DISTINCT target_signature)::text AS count FROM block_analyses'),
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
