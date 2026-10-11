import { NextRequest, NextResponse } from 'next/server';
import { checkAgentAuth } from '@/lib/agent/auth';
import {
  updateKnowledge,
  deleteKnowledge,
} from '@/lib/agent';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = checkAgentAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const { id } = await params;
    const knowledgeId = parseInt(id, 10);

    if (isNaN(knowledgeId)) {
      return NextResponse.json(
        { ok: false, error: 'Invalid knowledge ID' },
        { status: 400 }
      );
    }

    const body = await request.json();

    const updated = await updateKnowledge(knowledgeId, {
      title: body.title,
      content: body.content,
      isRecommended: body.is_recommended ?? body.isRecommended,
      isMandatory: body.is_mandatory ?? body.isMandatory,
      sortOrder: body.sort_order ?? body.sortOrder,
      isActive: body.is_active ?? body.isActive,
    });

    if (!updated) {
      return NextResponse.json(
        { ok: false, error: 'Knowledge entry not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      ok: true,
      data: updated,
    });
  } catch (error) {
    console.error('PUT /api/agent/knowledge/[id] error:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = checkAgentAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const { id } = await params;
    const knowledgeId = parseInt(id, 10);

    if (isNaN(knowledgeId)) {
      return NextResponse.json(
        { ok: false, error: 'Invalid knowledge ID' },
        { status: 400 }
      );
    }

    const success = await deleteKnowledge(knowledgeId);

    return NextResponse.json({
      ok: true,
      data: { success },
    });
  } catch (error) {
    console.error('DELETE /api/agent/knowledge/[id] error:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
