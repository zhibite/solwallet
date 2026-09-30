/**
 * /api/pool/[address]/analytics
 * GET - 单个 target / pool_member 的综合竞争分析
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAnalytics } from '@/lib/pool-analytics';
import { recommendFee, scoreWorthFollowing } from '@/lib/pool-decision';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  try {
    const { address } = await params;
    const [analytics, fee, score] = await Promise.all([
      getAnalytics(address),
      recommendFee(address),
      scoreWorthFollowing(address),
    ]);
    return NextResponse.json({ ok: true, data: { analytics, fee, score } });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}