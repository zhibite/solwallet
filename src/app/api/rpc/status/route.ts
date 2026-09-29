/**
 * /api/rpc/status
 * GET - 查看所有 RPC 端点状态 + cache 状态
 */
import { NextResponse } from 'next/server';
import { getRPC } from '@/lib/solana-rpc';
import { Cache } from '@/lib/cache';

export async function GET() {
  try {
    const rpc = getRPC();
    const cacheStats = await Cache.stats();
    return NextResponse.json({
      ok: true,
      data: {
        endpoints: rpc.getStatus(),
        cache: cacheStats,
        ts: new Date().toISOString(),
      },
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
