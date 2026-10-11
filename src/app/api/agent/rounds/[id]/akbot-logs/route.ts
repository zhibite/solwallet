/**
 * GET /api/agent/rounds/[id]/akbot-logs
 *
 * 拉这一轮 round 所有 agent_decision 对应的 akbot_call_log。
 * 用于 /agent/rounds/[id] 页面给每条 decision 展示对应的 akbot 调用轨迹
 * （多步序列 add → saveMap → switch 会显示成多行）。
 */
import { NextRequest, NextResponse } from 'next/server';
import { checkAgentAuth } from '@/lib/agent/auth';
import { query } from '@/lib/db';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = checkAgentAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const { id } = await params;
    const roundId = parseInt(id, 10);
    if (isNaN(roundId)) {
      return NextResponse.json({ ok: false, error: 'Invalid round ID' }, { status: 400 });
    }
    // 一行一条 akbot_call_log，按 decision_id + created_at 排序
    // 这样 multi-step（add → switch）按时间顺序排好
    const rows = await query<{
      id: number;
      agent_decision_id: number | null;
      monitored_target_id: number;
      action: string;
      endpoint: string;
      response_status: number | null;
      ok: boolean;
      error_message: string | null;
      duration_ms: number | null;
      request_body: unknown;
      response_body: unknown;
      created_at: string;
    }>(
      `SELECT l.id, l.agent_decision_id, l.monitored_target_id, l.action, l.endpoint,
              l.response_status, l.ok, l.error_message, l.duration_ms,
              l.request_body, l.response_body, l.created_at
         FROM akbot_call_log l
         JOIN agent_decisions d ON d.id = l.agent_decision_id
        WHERE d.round_id = $1
        ORDER BY d.id ASC, l.created_at ASC, l.id ASC`,
      [roundId],
    );
    return NextResponse.json({ ok: true, data: rows });
  } catch (error) {
    console.error('GET /api/agent/rounds/[id]/akbot-logs error:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
