/**
 * /api/targets/clear-all
 * POST - 清空全部 target_trades 记录（含相关 block_analyses，慎用）
 *
 * 安全修复（HIGH）：
 *   - 需要 Basic Auth（复用的 agent 鉴权体系）
 *   - 必须传 `{ confirm: true }` body，否则拒绝
 * 返回: { deleted: { trades, analyses } }
 */
import { NextRequest, NextResponse } from 'next/server';
import { withTransaction } from '@/lib/db';
import { checkAgentAuth } from '@/lib/agent/auth';

export async function POST(req: NextRequest) {
  // 1) 鉴权
  const auth = checkAgentAuth(req);
  if ('ok' in auth && !auth.ok) return auth;

  // 2) 确认 flag 检查（防误触）
  const body = await req.json().catch(() => ({}));
  if (body.confirm !== true) {
    return NextResponse.json(
      { ok: false, error: '必须传 { confirm: true } 才能执行清空操作' },
      { status: 400 },
    );
  }

  try {
    const result = await withTransaction(async (client) => {
      // 3) 收集所有 sigs（用于日志）
      const sigsRes = await client.query<{ signature: string }>('SELECT signature FROM target_trades');
      const sigs = sigsRes.rows.map((r) => r.signature);

      // 4) 清 block_analyses（block_buyers 通过 ON DELETE CASCADE 一起清）
      // 注意：可能有孤立的 block_analyses 记录（无对应 target_signature），需要无条件全清
      const r2 = await client.query('DELETE FROM block_analyses');
      const analyses = r2.rowCount ?? 0;

      // 5) 清 target_trades
      const trades = await client.query('DELETE FROM target_trades');

      // 6) 重置所有 record_count
      await client.query('UPDATE monitored_targets SET record_count = 0');

      return { trades: trades.rowCount ?? 0, analyses };
    });

    return NextResponse.json({ ok: true, deleted: result });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
