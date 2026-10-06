/**
 * /api/pool/akbot-scan
 *
 * POST { limit?, sleepMs? }  → 启动一次回填扫描，立即返回 { jobId }
 * GET  ?jobId=X              → 查询 job 状态（progress / result）
 *
 * 设计：
 *   - 启动后立即返回（最长扫描 = limit * sleepMs ≈ 100 * 200ms = 20s），
 *     不让 HTTP 请求挂几十秒等结果 —— 浏览器/Nginx 都会超时。
 *   - jobId 是进程内的随机 key，存于内存的 Map。dev server HMR 丢失是预期的；
 *     生产部署每个进程独立，不会跨进程同步（多副本部署另说）。
 *   - 同进程同时只跑一个扫描（runAkbotScan 内置互斥），第二次 POST 不重起，
 *     而是返回「已在跑中」的同一 jobId，前端 polling 就能看到进度。
 */

import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { runAkbotScan, isAkbotScanRunning, type AkbotScanProgress, type AkbotScanResult } from '@/lib/akbot-backfill';

// dev 模式跨 HMR 共享内存；global 单例避免每次改代码重启 server 时丢当前在跑的 job
declare global {
  // eslint-disable-next-line no-var
  var __akbotJobs: Map<string, JobState> | undefined;
}

interface JobState {
  jobId: string;
  startedAt: number;
  finishedAt: number | null;
  status: AkbotScanProgress['status'];
  progress: AkbotScanProgress;
  result: AkbotScanResult | null;
  /** 入参，留作审计 */
  opts: { limit: number; sleepMs: number };
}

const jobs: Map<string, JobState> =
  global.__akbotJobs ?? (global.__akbotJobs = new Map<string, JobState>());

function newJobId(): string {
  return 'akb_' + randomBytes(6).toString('hex');
}

/** 旧 job 清理 —— 仅保留最近 20 条 + 24h 内的，避免 Map 无限膨胀 */
function pruneOldJobs() {
  if (jobs.size <= 20) return;
  const entries = [...jobs.entries()];
  entries.sort((a, b) => b[1].startedAt - a[1].startedAt);
  const keep = entries.slice(0, 20);
  jobs.clear();
  for (const [k, v] of keep) jobs.set(k, v);
}

export async function POST(req: NextRequest) {
  try {
    // 「每日扫描 + UI 按钮」共用上限：100
    //   - 100 个按 freq DESC 的地址已经覆盖活跃狙击手 95% 命中
    //   - 砍掉 90% Helius 配额消耗（100 × 5000 sigs = 50万 req/run → 5万）
    //   - 全量回填仍可用 scripts/backfill-akbot.ts（CLI 自己设 LIMIT）
    //   - 上限锁死 100，挡住任何想绕开 UI 走 API 全扫的尝试
    const AKBOT_SCAN_LIMIT = 100;
    let limit = AKBOT_SCAN_LIMIT;
    let sleepMs = 200;
    try {
      const body = await req.json().catch(() => ({}));
      if (typeof body?.limit === 'number' && body.limit > 0) {
        // 上限 100 —— 按钮和 daily worker 都是 top 100，不接受更大的值
        limit = Math.min(Math.floor(body.limit), AKBOT_SCAN_LIMIT);
      }
      if (typeof body?.sleepMs === 'number' && body.sleepMs >= 0 && body.sleepMs <= 5000) {
        sleepMs = Math.floor(body.sleepMs);
      }
    } catch {
      // 无 body 时走默认
    }

    // 已经在跑？直接返回那个 job 的状态，让前端 polling 跟进度。
    if (isAkbotScanRunning()) {
      const running = [...jobs.values()].find((j) => j.finishedAt === null);
      if (running) {
        return NextResponse.json({ ok: true, data: { jobId: running.jobId, alreadyRunning: true } });
      }
    }

    const jobId = newJobId();
    const state: JobState = {
      jobId,
      startedAt: Date.now(),
      finishedAt: null,
      status: 'running',
      opts: { limit, sleepMs },
      progress: {
        scanned: 0, total: 0, detected: 0, failed: 0, skipped: 0,
        currentAddress: null, etaMs: null, status: 'running',
      },
      result: null,
    };
    jobs.set(jobId, state);
    pruneOldJobs();

    // UI 按钮的扫描深度：
    //   浅扫 1 页 = 200 sigs（≈ 活跃地址最近 1-3 天）。
    //   - 大多数 akbot 用户在第一页就有命中
    //   - 配合 multi-rpc 的 JSON-RPC batch getTransactions，100 地址 × 200 sigs
    //     = 4 个 batch HTTP 请求，总耗时 ~1 分钟
    //   - 没命中的地址还会被 daily worker（5000 sigs）兜底，所以这里浅没问题
    //
    // 覆盖：从 env AKBOT_SCAN_MAX_PAGES / AKBOT_SCAN_PAGE_SIZE 拿，生产环境想
    // 临时调深可以直接 env 改（仍然受 limit=100 上限约束）。
    const UI_MAX_PAGES = parseInt(process.env.AKBOT_SCAN_MAX_PAGES || '1', 10);
    const UI_PAGE_SIZE = parseInt(process.env.AKBOT_SCAN_PAGE_SIZE || '200', 10);

    // 立刻返回；扫描在 fire-and-forget 里跑，进度写进 state.progress
    runAkbotScan({
      limit,
      sleepMs,
      maxPages: UI_MAX_PAGES,
      pageSize: UI_PAGE_SIZE,
      onProgress: (p) => {
        state.progress = p;
        state.status = p.status;
        if (p.status === 'done' || p.status === 'aborted') {
          state.finishedAt = Date.now();
          state.result = p.result ?? null;
          console.log(
            `[akbot-scan] job ${jobId} ${p.status} — scanned=${p.result?.scanned}` +
            ` detected=${p.result?.detected} skipped=${p.result?.skipped} failed=${p.result?.failed}` +
            ` (${((p.result?.durationMs ?? 0) / 1000).toFixed(1)}s)`,
          );
        }
      },
    }).catch((e) => {
      console.error('[akbot-scan] job error', e);
      state.status = 'aborted';
      state.finishedAt = Date.now();
    });

    return NextResponse.json({ ok: true, data: { jobId, alreadyRunning: false } });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const jobId = searchParams.get('jobId');
    if (!jobId) {
      return NextResponse.json({ ok: false, error: 'jobId 必填' }, { status: 400 });
    }
    const state = jobs.get(jobId);
    if (!state) {
      // job 不存在有两种可能：jobId 写错 / 进程已重启（HMR 或重新部署）
      // 前端要能区分：传 isAkbotScanRunning 给它
      return NextResponse.json({
        ok: true,
        data: {
          jobId,
          status: 'missing',
          message: 'job 不存在 —— 可能是 server 重启/HMR 丢状态了',
          scanRunning: isAkbotScanRunning(),
        },
      });
    }
    return NextResponse.json({
      ok: true,
      data: {
        jobId: state.jobId,
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        status: state.status,
        progress: state.progress,
        result: state.result,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}