/**
 * /api/targets/[id]/clear
 * POST - 清除监控记录
 */
import { NextRequest, NextResponse } from 'next/server';
import { execute } from '@/lib/db';

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const n = await execute(
    `DELETE FROM target_trades WHERE target_id = $1;
     UPDATE monitored_targets SET record_count = 0 WHERE id = $1;`,
    [id],
  );
  return NextResponse.json({ ok: true });
}
