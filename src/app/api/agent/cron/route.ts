/**
 * /api/agent/cron
 *
 * Fix #10：scheduler.ts 的 setInterval 在 serverless（Vercel/Cloud Run）环境
 * 不会跨 invocation 持续——每次冷启动 module 重置，调度器等于不存在。
 *
 * 这个 endpoint 给外部 cron（Vercel Cron / GitHub Actions / 外部 watchdog）
 * 周期性调用。advisory_lock 保证多副本 / 多次调用同时间只有 1 个真正执行。
 *
 * 鉴权：
 *   - env AGENT_CRON_SECRET 必填（fail-closed）
 *   - Header `x-cron-secret: <env 值>` 匹配才放行
 *   - 没有 secret → 503「请先配 secret」
 *
 * 用法：
 *   Vercel Cron 配：* /5 * * * *  curl -H "x-cron-secret: $AGENT_CRON_SECRET" \
 *     https://yourdomain.com/api/agent/cron
 *
 * 返回：triggerImmediateRound 的 RunResult，没拿到 lock 时 { skipped: true }。
 */

import { NextRequest, NextResponse } from 'next/server';
import { triggerImmediateRound } from '@/lib/agent';

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}

async function handle(request: NextRequest): Promise<NextResponse> {
  const expected = process.env.AGENT_CRON_SECRET;
  if (!expected || expected.length < 16) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'AGENT_CRON_SECRET 未配置或太短（≥16 字符）。在 .env 里设一个长随机串。',
      },
      { status: 503 },
    );
  }
  const provided = request.headers.get('x-cron-secret') ?? '';
  if (provided !== expected) {
    return NextResponse.json(
      { ok: false, error: 'invalid cron secret' },
      { status: 401 },
    );
  }

  try {
    // triggerImmediateRound 已经走 advisory_lock + Fix #3 修正 + Fix #9 刷缓存
    const result = await triggerImmediateRound();
    if (!result) {
      // 没拿到 lock：另一个实例/调用正在跑，正常
      return NextResponse.json({ ok: true, data: { skipped: true, reason: 'lock held' } });
    }
    return NextResponse.json({
      ok: true,
      data: {
        roundId: result.roundId,
        status: result.status,
        targetCount: result.targetCount,
        decisionCount: result.decisionCount,
        executedCount: result.executedCount,
        errorCount: result.errorCount,
        totalMs: result.totalMs,
      },
    });
  } catch (error) {
    console.error('[/api/agent/cron] error:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
