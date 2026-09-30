/**
 * /api/pool/[address]
 * GET - 单个池子成员的详情 + 边（following / followers）
 */
import { NextRequest, NextResponse } from 'next/server';
import { getPoolMember, getPoolEdges } from '@/lib/pool';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  try {
    const { address } = await params;
    const m = await getPoolMember(address);
    if (!m) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const edges = await getPoolEdges(address);
    return NextResponse.json({ ok: true, data: { member: m, ...edges } });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}