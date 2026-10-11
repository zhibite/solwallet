import { NextRequest, NextResponse } from 'next/server';
import { checkAgentAuth } from '@/lib/agent/auth';
import { query } from '@/lib/db';

export async function GET(request: NextRequest) {
  const auth = checkAgentAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const searchParams = request.nextUrl.searchParams;
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const targetId = searchParams.get('targetId');
    const action = searchParams.get('action');

    let queryText = `
      SELECT
        d.*,
        t.address as target_address,
        t.label as target_label,
        r.started_at as round_started_at
      FROM agent_decisions d
      JOIN monitored_targets t ON d.target_id = t.id
      JOIN agent_rounds r ON d.round_id = r.id
      WHERE 1=1
    `;
    const params: unknown[] = [];
    let paramIndex = 1;

    if (targetId) {
      queryText += ` AND d.target_id = $${paramIndex++}`;
      params.push(parseInt(targetId, 10));
    }

    if (action) {
      queryText += ` AND d.action = $${paramIndex++}`;
      params.push(action);
    }

    queryText += ` ORDER BY d.id DESC LIMIT $${paramIndex}`;
    params.push(limit);

    const decisions = await query(queryText, params);

    return NextResponse.json({
      ok: true,
      data: decisions,
    });
  } catch (error) {
    console.error('GET /api/agent/decisions error:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
