import { NextRequest, NextResponse } from 'next/server';
import { checkAgentAuth } from '@/lib/agent/auth';
import {
  loadKnowledgeBase,
  addKnowledge,
  getKnowledgeStats,
} from '@/lib/agent';

export async function GET(request: NextRequest) {
  const auth = checkAgentAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const searchParams = request.nextUrl.searchParams;
    const includeStats = searchParams.get('stats') === 'true';

    const entries = await loadKnowledgeBase();
    const stats = includeStats ? await getKnowledgeStats() : null;

    return NextResponse.json({
      ok: true,
      data: {
        entries,
        stats,
      },
    });
  } catch (error) {
    console.error('GET /api/agent/knowledge error:', error);
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
    const body = await request.json();

    if (!body.category || !body.content) {
      return NextResponse.json(
        { ok: false, error: 'category and content are required' },
        { status: 400 }
      );
    }

    const entry = await addKnowledge(body.category, body.content, {
      title: body.title,
      isRecommended: body.is_recommended || body.isRecommended || false,
      isMandatory: body.is_mandatory || body.isMandatory || false,
      sortOrder: body.sort_order || body.sortOrder || 0,
    });

    return NextResponse.json({
      ok: true,
      data: entry,
    });
  } catch (error) {
    console.error('POST /api/agent/knowledge error:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
