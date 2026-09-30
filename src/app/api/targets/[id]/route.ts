/**
 * /api/targets/[id]
 * GET / DELETE
 */

import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne, execute } from '@/lib/db';
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
  const n = await execute('DELETE FROM monitored_targets WHERE id = $1', [id]);
  if (n === 0) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  // 异步同步 Helius webhook（删除后让 Helius 不再监控该地址）
  syncWebhookAsync();
  return NextResponse.json({ ok: true });
}
