/**
 * /api/pool/[address]/analytics
 * GET - 单个 target / pool_member 的综合分析
 *
 * 2026-10-16 拆分：
 *   - 监控中的 target → target 视角（竞争分析、Top 竞争者）
 *   - 其余 pool member → member 视角（自身买入画像、蹭过的目标）
 *   路由用 getAnalyticsFor 自动分流。
 *
 *   返回结构：data.analytics = { view: 'target' | 'member', ... 该视角的全部字段 }
 *   顶层 view 字段让前端无需 import 类型就能按分支渲染。
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAnalyticsFor } from '@/lib/pool-analytics';
import { recommendFee, scoreWorthFollowing } from '@/lib/pool-decision';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  try {
    const { address } = await params;
    const [analyticsResult, fee, score] = await Promise.all([
      getAnalyticsFor(address),
      recommendFee(address),
      scoreWorthFollowing(address),
    ]);
    return NextResponse.json({
      ok: true,
      data: {
        // 拍平 { view, data } → 顶层 view + data 字段直接展开，
        // 客户端按 analytics.view 切分支时少一层 .data.xxx 访问。
        analytics: { view: analyticsResult.view, ...analyticsResult.data },
        fee,
        score,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}