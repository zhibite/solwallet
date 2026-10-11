import { NextRequest, NextResponse } from 'next/server';
import { checkAgentAuth } from '@/lib/agent/auth';
import {
  getRecentRounds,
  getAgentStats,
  triggerImmediateRound,
} from '@/lib/agent';

export async function GET(request: NextRequest) {
  const auth = checkAgentAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const searchParams = request.nextUrl.searchParams;
    const limit = parseInt(searchParams.get('limit') || '20', 10);

    const rounds = await getRecentRounds(limit);
    const stats = await getAgentStats();

    return NextResponse.json({
      ok: true,
      data: {
        rounds,
        stats,
      },
    });
  } catch (error) {
    console.error('GET /api/agent/rounds error:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = checkAgentAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    // Fix #8 + #3：POST 之前直接调 runAgentRound 会绕过 advisory_lock，
    // 跟 scheduler / 另一个 trigger 并发跑会同时改 akbot 端状态。
    // 现在统一走 triggerImmediateRound —— 里面拿 lock + 刷缓存，UI 触发的 round
    // 和定时触发的 round 互斥。多副本部署时也只 1 个真正执行。
    const body = await request.json().catch(() => ({}));
    const result = await triggerImmediateRound();

    if (!result) {
      // 锁被另一个实例/调用拿着：跳过本次
      return NextResponse.json({
        ok: true,
        data: { skipped: true, reason: 'lock held by another round' },
      });
    }

    // 请求体里的 forceShadow / targetIds：当前 triggerImmediateRound 不支持透传，
    // 返回明确错误让客户端改用 /api/agent/scheduler POST action=trigger。
    // 保留 body 解析只是因为前端 fetch 总是带 body 防止 400。
    void body;

    return NextResponse.json({
      ok: true,
      data: result,
    });
  } catch (error) {
    console.error('POST /api/agent/rounds error:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
