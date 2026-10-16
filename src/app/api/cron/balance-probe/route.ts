/**
 * /api/cron/balance-probe
 *
 * 定时任务：每 1 分钟跑一次余额探测，把"已卖"的 buyer 提前算 PnL。
 *
 * 调用方式：
 *   1) Vercel Cron: vercel.json 配置 "* * * * *"（每分钟）
 *   2) 外部 Cron:  curl -X POST .../api/cron/balance-probe
 *   3) 手动触发:    POST
 *
 * 安全：需要 CRON_SECRET 请求头验证（防恶意调用，避免被刷爆 RPC）
 *
 * 工作流（详见 src/lib/balance-probe.ts）：
 *   1) 拉 next_balance_check_at <= NOW() 的 buyer
 *   2) 并发调 getTokenAccountsByOwner 查余额
 *   3) 余额 == 初始 → 推后 4 分钟到 5min 那个探测点
 *   4) 5min 那点还没动 → 交回 FIFO 兜底
 *   5) 余额 < 初始 → 立即调 calcCopyPnl 精算
 *
 * 性能参考（实测 5 个 RPC 端点）：
 *   - 50 buyer/批 × 1 次 getTokenAccountsByOwner ≈ 1-2s
 *   - 触发精算时单 buyer calcCopyPnl ~1-2s
 *   - 总 wallTime 通常 5-15s（取决于触发精算的占比）
 *
 * 与 compute-pnl cron 的关系：
 *   - balance-probe 优先：发现"已卖"立即精算
 *   - compute-pnl 兜底：5min 那点没动 / >2h 的积压由 mark-stale 处理
 *   - 两者对 pnl_status 写入是幂等的：后写覆盖前写，最终态相同
 *
 * RPC 消耗：
 *   两点探测方案，单 buyer 上限 = 2 次 getTokenAccountsByOwner（不计精算时的签名查询）
 *   绝大多数 buyer 在 1min 那点就卖掉 → 仅消耗 1 次余额查询
 *   5+ 分钟才卖/一直持仓 → 2 次查询后交回 FIFO（不再 5 次浪费）
 */

import { NextRequest, NextResponse } from 'next/server';
import { runBalanceProbe, getBalanceProbeQueueStats } from '@/lib/balance-probe';

const CRON_SECRET = process.env.CRON_SECRET;

export async function POST(req: NextRequest) {
  if (CRON_SECRET) {
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (token !== CRON_SECRET) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
  }

  const startTime = Date.now();
  try {
    const stats = await runBalanceProbe();
    return NextResponse.json({
      ok: true,
      duration: `${Date.now() - startTime}ms`,
      ...stats,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? String(err) },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  if (CRON_SECRET) {
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace('Bearer ', '');
    if (token !== CRON_SECRET) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const queue = await getBalanceProbeQueueStats();
    return NextResponse.json({
      ok: true,
      queue,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? String(err) },
      { status: 500 },
    );
  }
}
