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
    // 用 LATERAL 给每个 target 抓「最近一笔 first_sniper 不为 null 的 trade」
    // —— 只算"被抢过的那笔"，避免给前端返回「刚发生、sniper 还在分析中」的最新 trade（first_sniper 必然 null）
    const sql = `
      SELECT mt.id, mt.address, mt.label, mt.threshold_sol::text, mt.status,
             mt.created_at, mt.updated_at, mt.last_buy_at, mt.record_count, mt.auto_follow,
             s.first_sniper            AS last_sniper_address,
             s.first_sniper_signature  AS last_sniper_signature,
             s.first_sniper_offset_pos AS last_sniper_offset_pos,
             s.first_sniper_offset_ms  AS last_sniper_offset_ms,
             s.first_sniper_tip_sol    AS last_sniper_tip_sol,
             s.first_sniper_prio_lamports AS last_sniper_prio_lamports,
             s.first_sniper_buy_sol    AS last_sniper_buy_sol,
             s.slot                    AS last_sniper_slot,
             s.mint                    AS last_sniper_mint,
             s.block_time              AS last_sniper_block_time,
             s.first_sniper_tip_source AS last_sniper_tip_source,
             -- 【P1-#3】目标自己在这一笔 pay 的 tip / prio，方便用户决定「跟多少 tip / prio」
             s.target_tip_sol          AS last_target_tip_sol,
             s.target_prio_lamports    AS last_target_prio_lamports,
             -- 跟单收益：target_trades.pnl_sol 是孤儿字段（无写入路径），
             -- 改读狙击者那笔 block_buyers.pnl_sol（=「如果跟单这个狙击者能赚多少」）
             s.sniper_pnl_sol          AS last_sniper_pnl_sol,
             s.sniper_pnl_status       AS last_sniper_pnl_status,
             s.sniper_pnl_sold_ratio   AS last_sniper_pnl_sold_ratio,
             -- 0020: 未实现 PnL（浮盈），open/partial 行才有意义
             s.sniper_unrealized_sol     AS last_sniper_unrealized_sol,
             s.sniper_total_pnl_sol      AS last_sniper_total_pnl_sol,
             s.sniper_current_price_sol  AS last_sniper_current_price_sol,
             s.sniper_price_updated_at   AS last_sniper_price_updated_at
      FROM monitored_targets mt
      LEFT JOIN LATERAL (
        SELECT t.first_sniper, t.first_sniper_signature, t.first_sniper_offset_pos,
               t.first_sniper_offset_ms, t.first_sniper_tip_sol, t.first_sniper_prio_lamports,
               t.first_sniper_buy_sol, t.slot, t.mint, t.block_time,
               t.target_tip_sol, t.target_prio_lamports,
               bb.tip_source AS first_sniper_tip_source,
               bb.pnl_sol AS sniper_pnl_sol,
               bb.pnl_status AS sniper_pnl_status,
               bb.pnl_sold_ratio AS sniper_pnl_sold_ratio,
               bb.unrealized_sol AS sniper_unrealized_sol,
               bb.total_pnl_sol AS sniper_total_pnl_sol,
               bb.current_price_sol AS sniper_current_price_sol,
               bb.price_updated_at AS sniper_price_updated_at
        FROM target_trades t
        LEFT JOIN block_buyers bb ON bb.signature = t.first_sniper_signature
        WHERE t.target_id = mt.id AND t.first_sniper IS NOT NULL
        ORDER BY t.block_time DESC
        LIMIT 1
      ) s ON true
      ${status ? 'WHERE mt.status = $1' : ''}
      ORDER BY mt.created_at DESC
      LIMIT ${limit}
    `;
    const rows = await query<any>(sql, status ? [status] : []);

    // 把 LATERAL 出来的列压成一个嵌套对象，方便前端直接读 target.last_sniper?.address
    const shaped = rows.map((r: any) => {
      if (!r.last_sniper_address) return r;
      const { last_sniper_address, last_sniper_signature, last_sniper_offset_pos,
              last_sniper_offset_ms, last_sniper_tip_sol, last_sniper_prio_lamports,
              last_sniper_buy_sol, last_sniper_slot, last_sniper_mint, last_sniper_block_time,
              last_sniper_tip_source, last_sniper_pnl_sol,
              last_target_tip_sol, last_target_prio_lamports,
              ...rest } = r;
      return {
        ...rest,
        last_sniper: {
          address: last_sniper_address,
          signature: last_sniper_signature,
          offset_pos: last_sniper_offset_pos,
          offset_ms: last_sniper_offset_ms,
          tip_sol: last_sniper_tip_sol,
          prio_lamports: last_sniper_prio_lamports,
          buy_sol: last_sniper_buy_sol,
          slot: last_sniper_slot,
          mint: last_sniper_mint,
          block_time: last_sniper_block_time,
          tip_source: last_sniper_tip_source,
          pnl_sol: last_sniper_pnl_sol,
          pnl_status: r.last_sniper_pnl_status,
          pnl_sold_ratio: r.last_sniper_pnl_sold_ratio,
          // 0020: 未实现 PnL
          unrealized_sol: r.last_sniper_unrealized_sol,
          total_pnl_sol: r.last_sniper_total_pnl_sol,
          current_price_sol: r.last_sniper_current_price_sol,
          price_updated_at: r.last_sniper_price_updated_at,
          // 【P1-#3】目标自己在这一笔的 tip / prio
          target_tip_sol: last_target_tip_sol,
          target_prio_lamports: last_target_prio_lamports,
        },
      };
    });

    const data = withDecisions ? await attachDecisions(shaped) : shaped;
    return NextResponse.json({ ok: true, data });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { address, label, threshold_sol = 0.8 } = body || {};
    if (!address || typeof address !== 'string' || address.length < 32 || address.length > 44) {
      return NextResponse.json({ ok: false, error: 'address 不合法' }, { status: 400 });
    }

    // 用 CTE 判断是 INSERT 还是 UPDATE（ON CONFLICT 时 xmax = 0 表示新插入）
    const row = await queryOne<any>(
      `WITH ins AS (
        INSERT INTO monitored_targets (address, label, threshold_sol)
        VALUES ($1, $2, $3)
        ON CONFLICT (address) DO UPDATE SET label = EXCLUDED.label, threshold_sol = EXCLUDED.threshold_sol
        RETURNING *, (xmax = 0) AS is_new
      )
      SELECT *, is_new FROM ins`,
      [address, label || null, threshold_sol],
    );
    // 异步同步 Helius webhook（新增/更新后让 Helius 立即知道地址变更）
    syncWebhookAsync();
    return NextResponse.json({ ok: true, data: row, isNew: row?.is_new ?? false });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
