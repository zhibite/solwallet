/**
 * /api/targets/[id]/resume
 * POST - 恢复监控
 */
import { NextRequest, NextResponse } from 'next/server';
import { execute } from '@/lib/db';
import { syncWebhookAsync } from '@/lib/sync-webhook';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const n = await execute(
    "UPDATE monitored_targets SET status = 'active', updated_at = NOW() WHERE id = $1",
    [id],
  );
  if (n === 0) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  // 恢复后 status='active'，加回 Helius 监控列表
  syncWebhookAsync();
  return NextResponse.json({ ok: true });
}
