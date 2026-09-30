/**
 * /api/pool/discover
 * POST - 手动触发一次 BFS 归池 + 决策重算
 */
import { NextRequest, NextResponse } from 'next/server';
import { triggerBFSNow } from '@/lib/pool-worker';
import { recomputeAllDecisions } from '@/lib/pool-decision';

export async function POST(_req: NextRequest) {
  try {
    const [bfs, dec] = await Promise.all([
      triggerBFSNow(),
      recomputeAllDecisions(),
    ]);
    return NextResponse.json({ ok: true, data: { bfs, decision: dec } });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}