/**
 * /api/targets
 * GET  - 列表
 * POST - 添加监控目标
 */

import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { syncWebhookAsync } from '@/lib/sync-webhook';
import { recommendFee, scoreWorthFollowing } from '@/lib/pool-decision';

async function attachDecisions(targets: any[]): Promise<any[]> {
  return Promise.all(targets.map(async (t) => {
    try {
      const [fee, score] = await Promise.all([
        recommendFee(t.address),
        scoreWorthFollowing(t.address),
      ]);
      return {
        ...t,
        decision: {
          p50_tip_sol: fee.p50_tip_sol,
          p50_prio_lamports: fee.p50_prio_lamports,
          p75_tip_sol: fee.p75_tip_sol,
          p75_prio_lamports: fee.p75_prio_lamports,
          success_count: fee.success_count,
          failed_count: fee.failed_count,
          sample_size: fee.sample_size,
          worth_score: score.offered,
          win_rate: score.win_rate,
          avg_pnl_sol: score.avg_pnl_sol,
        },
      };
    } catch {
      return t;
    }
  }));
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status');
  const limit = parseInt(searchParams.get('limit') || '100', 10);
  const withDecisions = searchParams.get('decision') !== 'false';

  try {
    const sql = `
      SELECT id, address, label, threshold_sol::text, status,
             created_at, updated_at, last_buy_at, record_count
      FROM monitored_targets
      ${status ? 'WHERE status = $1' : ''}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    const rows = await query<any>(sql, status ? [status] : []);
    const data = withDecisions ? await attachDecisions(rows) : rows;
    return NextResponse.json({ ok: true, data });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { address, label, threshold_sol = 0.5 } = body || {};
    if (!address || typeof address !== 'string' || address.length < 32 || address.length > 44) {
      return NextResponse.json({ ok: false, error: 'address 不合法' }, { status: 400 });
    }

    const row = await queryOne<any>(
      `INSERT INTO monitored_targets (address, label, threshold_sol)
       VALUES ($1, $2, $3)
       ON CONFLICT (address) DO UPDATE SET label = EXCLUDED.label, threshold_sol = EXCLUDED.threshold_sol
       RETURNING *`,
      [address, label || null, threshold_sol],
    );
    // 异步同步 Helius webhook（新增/更新后让 Helius 立即知道地址变更）
    syncWebhookAsync();
    return NextResponse.json({ ok: true, data: row });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
