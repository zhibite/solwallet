/**
 * /api/pool
 * GET  - 列出 pool_members
 * POST - 手动添加一个地址到池子
 */
import { NextRequest, NextResponse } from 'next/server';
import { listPoolMembers, addPoolMember, getPoolStats } from '@/lib/pool';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const role = searchParams.get('role') ?? undefined;
    const promoted = searchParams.get('promoted');
    const minFreq = searchParams.get('min_freq');
    const sortBy = (searchParams.get('sort') ?? 'freq') as 'freq' | 'score' | 'seen';
    const limit = parseInt(searchParams.get('limit') ?? '100', 10);
    const offset = parseInt(searchParams.get('offset') ?? '0', 10);

    const [members, stats] = await Promise.all([
      listPoolMembers({
        role,
        promoted: promoted === 'true' ? true : promoted === 'false' ? false : undefined,
        minFreq: minFreq ? parseInt(minFreq, 10) : undefined,
        sortBy,
        offset,
        limit,
      }),
      getPoolStats(),
    ]);

    return NextResponse.json({ ok: true, data: { members, stats } });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { address, label } = await req.json();
    if (!address || address.length < 32 || address.length > 44) {
      return NextResponse.json({ ok: false, error: 'address 必填且为合法 Solana 地址' }, { status: 400 });
    }
    const m = await addPoolMember(address, label);
    return NextResponse.json({ ok: true, data: m });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}