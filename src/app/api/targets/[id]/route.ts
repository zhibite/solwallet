/**
 * /api/targets/[id]
 * GET / DELETE
 */

import { NextRequest, NextResponse } from 'next/server';
import { queryOne, withTransaction } from '@/lib/db';
import { syncWebhookAsync } from '@/lib/sync-webhook';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const row = await queryOne<any>(
    `SELECT id, address, label, threshold_sol::text, status,
            created_at, updated_at, last_buy_at, record_count
     FROM monitored_targets WHERE id = $1`,
    [id],
  );
  if (!row) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  return NextResponse.json({ ok: true, data: row });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // 删监控目标时必须同步重置池子里的晋升标记。否则 pool_members.promoted_to_target
  // 会停在 true 而 monitored_targets 已无此行 —— 该地址既不被监控，也过不了
  // autoPromote 的候选条件（promoted_to_target = false 不成立），永久卡死。
  // 置 auto_promote_excluded 是为了尊重「人工删除」的意图，别让 autoPromote 下一轮
  // 又把它自动拉回来。手动点晋升会清掉这个标记。
  const result = await withTransaction(async (client) => {
    const del = await client.query<{ address: string }>(
      'DELETE FROM monitored_targets WHERE id = $1 RETURNING address',
      [id],
    );
    if (del.rowCount === 0) return null;

    const address = del.rows[0].address;
    const reset = await client.query(
      `UPDATE pool_members
       SET promoted_to_target = false, promoted_at = NULL, auto_promote_excluded = true
       WHERE address = $1 AND promoted_to_target = true`,
      [address],
    );
    return { address, poolFlagReset: reset.rowCount ?? 0 };
  });

  if (!result) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  // 异步同步 Helius webhook（删除后让 Helius 不再监控该地址）
  syncWebhookAsync();
  return NextResponse.json({ ok: true, ...result });
}
