import { NextRequest, NextResponse } from 'next/server';
import { checkAgentAuth } from '@/lib/agent/auth';
import { generateTargetSnapshot } from '@/lib/agent';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ targetId: string }> }
) {
  const auth = checkAgentAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const { targetId } = await params;
    const id = parseInt(targetId, 10);

    if (isNaN(id)) {
      return NextResponse.json(
        { ok: false, error: 'Invalid target ID' },
        { status: 400 }
      );
    }

    const snapshot = await generateTargetSnapshot(id);

    if (!snapshot) {
      return NextResponse.json(
        { ok: false, error: 'Target not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      ok: true,
      data: snapshot,
    });
  } catch (error) {
    console.error('GET /api/agent/snapshot/[targetId] error:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
