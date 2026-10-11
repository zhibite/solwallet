import { NextRequest, NextResponse } from 'next/server';
import { checkAgentAuth } from '@/lib/agent/auth';
import { getRoundWithDecisions } from '@/lib/agent';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = checkAgentAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const { id } = await params;
    const roundId = parseInt(id, 10);

    if (isNaN(roundId)) {
      return NextResponse.json(
        { ok: false, error: 'Invalid round ID' },
        { status: 400 }
      );
    }

    const result = await getRoundWithDecisions(roundId);

    if (!result) {
      return NextResponse.json(
        { ok: false, error: 'Round not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      ok: true,
      data: result,
    });
  } catch (error) {
    console.error('GET /api/agent/rounds/[id] error:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
