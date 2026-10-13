/**
 * /api/cron/compute-pnl
 * 
 * 定时任务：批量计算 block_buyers 的跟单收益
 * 
 * 调用方式：
 *   1. Vercel Cron: 自动按 vercel.json 配置的时间触发
 *   2. 外部 Cron: curl 或定时器调用此接口
 *   3. 手动触发: POST 请求
 * 
 * 安全：需要 CRON_SECRET 请求头验证（防止恶意调用）
 * 
 * 查询逻辑：
 *   - 只查询最近 7 天内有新 block 分析的记录
 *   - 跳过已计算过的（pnl_status 非空）
 *   - 优先计算目标本人和第一个狙击者
 */

import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { computeBulkBuyerPnL } from '@/lib/first-sniper';

// Cron Secret 验证（部署时设置环境变量 CRON_SECRET）
const CRON_SECRET = process.env.CRON_SECRET;

interface BlockAnalysis {
  slot: number;
  mint: string;
  id: number;
}

export async function POST(req: NextRequest) {
  // 1. 安全验证
  if (CRON_SECRET) {
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (token !== CRON_SECRET) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
  }

  const startTime = Date.now();
  const results: {
    slot: number;
    mint: string;
    computed: number;
    skipped: number;
    errors: number;
    error?: string;
  }[] = [];

  try {
    // 2. 找出最近 7 天内有 block 分析的 slot/mint 组合
    //    限制时间范围避免一次性处理太多
    const analyses = await query<BlockAnalysis>(`
      SELECT DISTINCT ba.slot, ba.mint, ba.id
      FROM block_analyses ba
      WHERE ba.block_time >= NOW() - INTERVAL '7 days'
      ORDER BY ba.block_time DESC
      LIMIT 50
    `);

    if (analyses.length === 0) {
      return NextResponse.json({
        ok: true,
        message: 'No recent block analyses found',
        duration: `${Date.now() - startTime}ms`,
      });
    }

    // 3. 逐个处理每个 block
    for (const analysis of analyses) {
      try {
        const result = await computeBulkBuyerPnL(analysis.slot, analysis.mint, {
          force: false, // 默认不强制重算已算过的
        });

        results.push({
          slot: analysis.slot,
          mint: analysis.mint,
          computed: result.results.length,
          skipped: result.skippedExisting,
          errors: result.results.filter((r) => r.status === 'error').length,
        });
      } catch (err: any) {
        results.push({
          slot: analysis.slot,
          mint: analysis.mint,
          computed: 0,
          skipped: 0,
          errors: 0,
          error: err.message,
        });
      }
    }

    const totalComputed = results.reduce((sum, r) => sum + r.computed, 0);
    const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);

    return NextResponse.json({
      ok: true,
      summary: {
        totalBlocks: analyses.length,
        totalComputed,
        totalErrors,
        duration: `${Date.now() - startTime}ms`,
      },
      results,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err.message },
      { status: 500 }
    );
  }
}

// GET 请求返回状态信息（不执行计算）
export async function GET(req: NextRequest) {
  if (CRON_SECRET) {
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (token !== CRON_SECRET) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    // 统计待计算记录数
    const stats = await queryOne<any>(`
      SELECT 
        COUNT(*) FILTER (WHERE bb.pnl_status IS NULL AND bb.result = 'success') AS pending_count,
        COUNT(*) FILTER (WHERE bb.pnl_status = 'open') AS open_count,
        COUNT(*) FILTER (WHERE bb.pnl_status = 'closed') AS closed_count,
        COUNT(*) FILTER (WHERE bb.pnl_status = 'partial') AS partial_count,
        COUNT(*) FILTER (WHERE bb.result = 'failed') AS failed_count,
        COUNT(*) FILTER (WHERE bb.pnl_status IS NULL AND bb.result = 'success') AS to_compute
      FROM block_buyers bb
      JOIN block_analyses ba ON ba.id = bb.block_analysis_id
      WHERE ba.block_time >= NOW() - INTERVAL '7 days'
    `);

    return NextResponse.json({
      ok: true,
      stats: {
        pending: parseInt(stats.pending_count) || 0,
        open: parseInt(stats.open_count) || 0,
        closed: parseInt(stats.closed_count) || 0,
        partial: parseInt(stats.partial_count) || 0,
        failed: parseInt(stats.failed_count) || 0,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
