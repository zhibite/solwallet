/**
 * /api/rpc/test
 * POST - 测试 RPC 调用（验证缓存）
 * body: { method?: 'getSlot' | 'getBlock' | 'getSignaturesForAddress', params?: any[] }
 *
 * 返回：响应时间 + 缓存命中信息 + 原始结果
 */
import { NextRequest, NextResponse } from 'next/server';
import { getMultiRpc } from '@/lib/multi-rpc';

export async function POST(req: NextRequest) {
  const start = Date.now();
  try {
    const { method = 'getSlot', params = [] } = await req.json().catch(() => ({}));

    const multiRpc = getMultiRpc();

    // 第一次：冷请求（无缓存）
    const coldStart = Date.now();
    const coldResult = await multiRpc.rpc(method, params, 30_000);
    const coldMs = Date.now() - coldStart;

    // 第二次：热请求（应该命中缓存）
    const warmStart = Date.now();
    const warmResult = await multiRpc.rpc(method, params, 30_000);
    const warmMs = Date.now() - warmStart;

    return NextResponse.json({
      ok: true,
      data: {
        method,
        params,
        cold: { ms: coldMs, hit: false },
        warm: { ms: warmMs, hit: warmMs < coldMs / 2 }, // 经验判断
        resultPreview: JSON.stringify(coldResult).slice(0, 200),
      },
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
