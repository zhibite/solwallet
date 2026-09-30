/**
 * /api/targets/[id]/pause
 * POST - 暂停监控
 */
import { NextRequest, NextResponse } from 'next/server';
import { execute } from '@/lib/db';
import { syncWebhookAsync } from '@/lib/sync-webhook';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const n = await execute(
    "UPDATE monitored_targets SET status = 'paused', updated_at = NOW() WHERE id = $1",
    [id],
  );
  if (n === 0) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  // 暂停后 status='paused'，从 Helius 监控列表中移除
  syncWebhookAsync();
  return NextResponse.json({ ok: true });
}
