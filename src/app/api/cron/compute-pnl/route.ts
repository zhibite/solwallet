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
 *   - 只查询最近 2 小时内的 block（保证新的解析能及时跑出来）
 *   - 旧的记录（>2h）直接跳过不处理 —— 避免积压拖慢新增数据
 *   - 跳过已计算过的（pnl_status 非空）
 *   - 优先计算目标本人和第一个狙击者
 *
 * 过期标记（每轮 cron POST 都会跑一次）：
 *   每次 POST 启动时先执行一次「mark-stale」SQL —— 把 block_time >2h 且
 *   pnl_status IS NULL 的行批量标 'stale'。这样：
 *     - 新数据进来的瞬间还是 pnl_status IS NULL，cron 当下立即 pick
 *     - 跑过 2h 还没算的，cron 标 stale 主动放弃，永远不会被重复 pick
 *     - UI / GET 统计能区分「真的还在算」vs「已过期放弃」
 *
 * 状态值参考 migration 0022_stale_pending_pnl.sql 的注释。
 */

import { NextRequest, NextResponse } from 'next/server';
import { query, queryOne } from '@/lib/db';
import { computeBulkBuyerPnL } from '@/lib/first-sniper';
import { runWithConcurrency } from '@/lib/concurrency';

// Cron Secret 验证（部署时设置环境变量 CRON_SECRET）
const CRON_SECRET = process.env.CRON_SECRET;

/**
 * Block 级别并发上限
 *
 * 旧版 = 1（串行），跑完一个 block 才进下一个，50 block 单 block 平均 1.5s
 *        至少 75s。Block 之间毫无关联，纯粹是浪费串行时间。
 *
 * 3 路 = 3× 加速。每个 block 内部已经 8 路并发（BULK_PNL_CONCURRENCY），
 * 所以全局最大并发 = 3 × 8 = 24 个 calcCopyPnl，对应 ~144 个 RPC roundtrip
 * 并行（fetchTxViews 内部 6 路并发），公共 RPC 吃得下。
 *
 * 调大到 4-5 收益递减，且容易触发 429；调小到 2 又被串行问题追上。
 */
const CRON_BLOCK_CONCURRENCY = Math.max(
  1,
  Math.min(8, parseInt(process.env.CRON_BLOCK_CONCURRENCY ?? '3', 10)),
);

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
    // 2. mark-stale：先把已超时的"待算"行标为 'stale'，避免下次重复扫到。
    //    这一步必须在 2) 拉 block 之前做：
    //      - 用 block_analyses.block_time 作时间锚（block_buyers 自己没存 block_time，
    //        只能 join；单 SQL 一次完成，不必先 SELECT 再 UPDATE）。
    //      - 命中条件 = pnl_status IS NULL + result='success' + block_time < NOW()-2h。
    //        失败买入（result='failed'）原本也不会进 computeBulkBuyerPnL 的 toCompute，
    //        一起标 stale 没问题（让失败也明确"已过期"，比一直显示"待算"更诚实）。
    //      - 写完不读 result（低优先级；标 stale 之后即使被前端读到"stale"也是正确语义）。
    //      - 用 RETURNING 拿到实际标了多少行，方便 summary 给运维一个数字。
    //    注意：mark-stale 和拉 analyses 是两个独立 SQL，没有事务依赖，失败互不影响。
    const markStaleResult = await query<{ marked: number }>(`
      WITH stale_rows AS (
        UPDATE block_buyers bb
        SET pnl_status = 'stale'
        FROM block_analyses ba
        WHERE bb.block_analysis_id = ba.id
          AND bb.pnl_status IS NULL
          AND bb.result = 'success'
          AND ba.block_time < NOW() - INTERVAL '2 hours'
        RETURNING bb.id
      )
      SELECT COUNT(*)::int AS marked FROM stale_rows
    `).catch((err) => {
      // mark-stale 是 best-effort；失败不能阻塞主流程（怕的是 cron 全挂掉导致
      // 新数据全卡住），所以 catch 吞掉 + 记日志。
      console.error('[cron/compute-pnl] mark-stale failed:', err);
      return [{ marked: -1 }];
    });
    const markedStale = markStaleResult[0]?.marked ?? 0;

    // 3. 找出最近 2 小时内 block 分析的 slot/mint 组合
    //    旧逻辑 = 7 天窗口：积压的旧记录会被反复拉到，挤掉新 block 的并发额度
    //    新逻辑 = 2 小时窗口 + ORDER BY slot DESC：
    //      - 老的（>2h）先被上一步 mark-stale 标掉，本窗口内只剩「仍值得算」的行
    //      - 一旦新的进 block_analyses，下一轮 cron 立刻 pick up，最坏延迟 = cron 周期 + 2h 窗口
    //      - LIMIT 50 兜底：极端情况（多个目标几乎同时触发）单轮仍限制并发数
    //    注意：block_analyses 的 (slot, mint) 是 PK，天然唯一，不需要 DISTINCT；
    //    PG 在 DISTINCT + ORDER BY 时要求 ORDER BY 字段必须出现在 SELECT 列表里，
    //    这里直接 ORDER BY slot DESC 即可，物理上和 block_time DESC 排序一致
    //    （同一 slot 内多 mint → 多 block_analyses，slot 越大 block_time 越新）。
    const analyses = await query<BlockAnalysis>(`
      SELECT ba.slot, ba.mint, ba.id
      FROM block_analyses ba
      WHERE ba.block_time >= NOW() - INTERVAL '2 hours'
      ORDER BY ba.slot DESC
      LIMIT 50
    `);

    if (analyses.length === 0) {
      return NextResponse.json({
        ok: true,
        message: 'No recent block analyses found',
        markedStale,
        duration: `${Date.now() - startTime}ms`,
      });
    }

    // 3. 并行处理每个 block（多 block 一起算 PnL）
    //
    // 旧版串行：N block × 单 block 耗时，50 block 至少 75s。
    // 新版 3 路并发：约 N/3 × 单 block 耗时。Block 之间没有数据依赖，
    // 完全可以并行；唯一约束是 DB 连接池（max=10）和 RPC 配额。
    // 单 block 内部仍维持 BULK_PNL_CONCURRENCY=8，3 × 8 = 24 路并发
    // 跑 calcCopyPnl，DB 池需 ≥ 24 才有最理想吞吐。
    //
    // 错误处理：单 block 失败不影响其他 block，错误累加进 results 数组。
    const blockResults = await runWithConcurrency(
      analyses,
      CRON_BLOCK_CONCURRENCY,
      async (analysis): Promise<{
        slot: number;
        mint: string;
        computed: number;
        skipped: number;
        errors: number;
        error?: string;
        durationMs: number;
      }> => {
        const t0 = Date.now();
        try {
          const result = await computeBulkBuyerPnL(analysis.slot, analysis.mint, {
            force: false, // 默认不强制重算已算过的
          });
          return {
            slot: analysis.slot,
            mint: analysis.mint,
            computed: result.results.length,
            skipped: result.skippedExisting,
            errors: result.results.filter((r) => r.status === 'error').length,
            durationMs: Date.now() - t0,
          };
        } catch (err: any) {
          // 整 block 失败（如 DB 连接全满、RPC 全 429）属于全局故障，
          // 不同于单 buyer 失败：errors=1 让运维能从 totalErrors 直接看到
          // 整 block 失败的次数，而不只是单 buyer 错误数。
          console.error(
            `[cron/compute-pnl] block failed slot=${analysis.slot} mint=${analysis.mint.slice(0, 8)}…: ${err.message ?? err}`,
          );
          return {
            slot: analysis.slot,
            mint: analysis.mint,
            computed: 0,
            skipped: 0,
            errors: 1, // 整 block 失败计入 errors 计数
            error: err.message ?? String(err),
            durationMs: Date.now() - t0,
          };
        }
      },
    );
    results.push(...blockResults);

    const totalComputed = results.reduce((sum, r) => sum + r.computed, 0);
    const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);
    const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);

    return NextResponse.json({
      ok: true,
      summary: {
        totalBlocks: analyses.length,
        totalComputed,
        totalErrors,
        blockConcurrency: CRON_BLOCK_CONCURRENCY,
        wallTimeMs: Date.now() - startTime,
        // 各 block 累计耗时 = 串行总耗时；和 wallTime 对比可看到并行收益
        sumOfBlockDurationsMs: totalDuration,
        parallelismFactor: totalDuration > 0
          ? (totalDuration / (Date.now() - startTime)).toFixed(2)
          : '1.00',
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
    //
    // 字段含义（参考 migration 0022_stale_pending_pnl.sql）：
    //   pending  = 待计算（pnl_status IS NULL + result='success'，cron 会优先处理）
    //   stale    = 过期不处理（pnl_status='stale'，cron 已主动放弃；原本积压的会逐渐落在这里）
    //   open     = 持仓中
    //   closed   = 已平仓
    //   partial  = 部分平仓
    //   failed   = 买入失败
    //
    // 7 天窗口保留：这是 GET 状态接口，让运维能看到"积压了多少 stale 还没被标记"
    // 之类历史趋势；POST 处理窗口仍然是 2 小时（已硬编码在 POST 内）。
    const stats = await queryOne<any>(`
      SELECT
        COUNT(*) FILTER (WHERE bb.pnl_status IS NULL AND bb.result = 'success') AS pending_count,
        COUNT(*) FILTER (WHERE bb.pnl_status = 'stale') AS stale_count,
        COUNT(*) FILTER (WHERE bb.pnl_status = 'open') AS open_count,
        COUNT(*) FILTER (WHERE bb.pnl_status = 'closed') AS closed_count,
        COUNT(*) FILTER (WHERE bb.pnl_status = 'partial') AS partial_count,
        COUNT(*) FILTER (WHERE bb.result = 'failed') AS failed_count,
        -- 拆开看「2h 内 pending」vs「全 7 天 pending」，方便排错时区分新旧积压
        COUNT(*) FILTER (
          WHERE bb.pnl_status IS NULL AND bb.result = 'success'
            AND ba.block_time >= NOW() - INTERVAL '2 hours'
        ) AS pending_recent_count
      FROM block_buyers bb
      JOIN block_analyses ba ON ba.id = bb.block_analysis_id
      WHERE ba.block_time >= NOW() - INTERVAL '7 days'
    `);

    return NextResponse.json({
      ok: true,
      stats: {
        pending: parseInt(stats.pending_count) || 0,
        pendingRecent: parseInt(stats.pending_recent_count) || 0,
        stale: parseInt(stats.stale_count) || 0,
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
