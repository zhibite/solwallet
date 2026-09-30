/**
 * /api/pool/[address]/promote
 * POST - 手动晋升到 monitored_targets
 */
import { NextRequest, NextResponse } from 'next/server';
import { promotePoolMember } from '@/lib/pool';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  try {
    const { address } = await params;
    const body = await req.json().catch(() => ({}));
    const threshold = typeof body?.threshold === 'number' ? body.threshold : undefined;
    const result = await promotePoolMember(address, threshold);
    if (!result.ok) return NextResponse.json(result, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}