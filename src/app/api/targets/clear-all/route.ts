/**
 * /api/targets/clear-all
 * POST - 清空全部 target_trades 记录（含相关 block_analyses，慎用）
 *
 * 安全约束：必须传 `{ confirm: true }` body，否则拒绝。
 * （鉴权由 Basic Auth 反向代理 / 内部网络层负责；该端点只清监控数据，
 *  不触及钱包/资金/私钥，confirm 双重确认已足以防误触。）
 * 返回: { deleted: { trades, analyses } }
 */
import { NextRequest, NextResponse } from 'next/server';
import { withTransaction } from '@/lib/db';

export async function POST(req: NextRequest) {
  // 必须显式 confirm：true 才能执行
  const body = await req.json().catch(() => ({}));
  if (body.confirm !== true) {
    return NextResponse.json(
      { ok: false, error: '必须传 { confirm: true } 才能执行清空操作' },
      { status: 400 },
    );
  }

  try {
    const result = await withTransaction(async (client) => {
      // 1) 收集所有 sigs（用于日志）
      const sigsRes = await client.query<{ signature: string }>('SELECT signature FROM target_trades');
      const sigs = sigsRes.rows.map((r) => r.signature);

      // 2) 清 block_analyses（block_buyers 通过 ON DELETE CASCADE 一起清）
      // 注意：可能有孤立的 block_analyses 记录（无对应 target_signature），需要无条件全清
      const r2 = await client.query('DELETE FROM block_analyses');
      const analyses = r2.rowCount ?? 0;

      // 3) 清 target_trades
      const trades = await client.query('DELETE FROM target_trades');

      // 4) 重置 record_count + last_buy_at = NOW()。
      //    必须改 last_buy_at：clear-all 后 DB 已是空的，monitor 的 5 秒 fallback
      //    轮询会调 getSignaturesForAddress(addr, 20)，对冷门目标这 20 笔可能跨 1-2 天。
      //    设为 NOW() 后，monitor.ts 的 blockTime > lastBuyAtSec 过滤只接受
      //    最近 5 秒的实时买入（5s 冗余防时钟边界 race），旧的 34h 历史 sig 全部被挡。
      //    ws-monitor 是另一条独立路径，不受该过滤影响，新买入照常入库并把 last_buy_at
      //    推到自己的 blockTime。
      await client.query(
        "UPDATE monitored_targets SET record_count = 0, last_buy_at = NOW()",
      );

      return { trades: trades.rowCount ?? 0, analyses };
    });

    return NextResponse.json({ ok: true, deleted: result });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
