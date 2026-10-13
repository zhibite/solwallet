/**
 * PnL 计算 Worker：常驻后台任务，自动计算 block_buyers 的跟单收益
 *
 * 启动方式：
 * 1) 在 Next.js 启动时通过 instrumentation.ts 自动启动
 * 2) 通过 npm run pnl-worker 单独运行（用于独立部署）
 *
 * 工作逻辑：
 * - 每 30 秒检查一次待计算的记录
 * - 优先计算最近 3 天内有分析记录的 block
 * - 每次最多处理 10 个 block，每个 block 最多并行计算 5 个 buyer
 * - 跳过已计算过的记录（pnl_status 非空）
 * - 目标本人、第一个狙击者优先计算
 */

import { query, execute } from './db';
import { computeBulkBuyerPnL } from './first-sniper';

const POLL_INTERVAL_MS = parseInt(process.env.PNL_POLL_INTERVAL_MS || '30000', 10); // 默认 30 秒
const MAX_BLOCKS_PER_ROUND = parseInt(process.env.PNL_MAX_BLOCKS_PER_ROUND || '10', 10);
const MAX_AGE_DAYS = parseInt(process.env.PNL_MAX_AGE_DAYS || '3', 10); // 只计算最近 3 天的 block

interface BlockToProcess {
  slot: number;
  mint: string;
  block_analysis_id: number;
  pending_count: number;
}

let running = false;
let pollTimer: NodeJS.Timeout | null = null;

/** 启动 PnL Worker */
export async function startPnlWorker() {
  if (running) return;
  running = true;
  console.log('[pnl-worker] starting...');
  console.log(`[pnl-worker] poll interval: ${POLL_INTERVAL_MS}ms`);
  console.log(`[pnl-worker] max blocks per round: ${MAX_BLOCKS_PER_ROUND}`);
  console.log(`[pnl-worker] max age: ${MAX_AGE_DAYS} days`);
  scheduleNextPoll();
}

/** 停止 PnL Worker */
export function stopPnlWorker() {
  running = false;
  if (pollTimer) clearTimeout(pollTimer);
  console.log('[pnl-worker] stopped');
}

function scheduleNextPoll() {
  if (!running) return;
  pollTimer = setTimeout(async () => {
    try {
      await pollAndCompute();
    } catch (err) {
      console.error('[pnl-worker] poll error:', err);
    }
    scheduleNextPoll();
  }, POLL_INTERVAL_MS);
}

/** 主循环：查找待计算的 block 并处理 */
async function pollAndCompute() {
  // 1. 找出待计算的 block（按 pending_count 降序，优先处理多的）
  const blocks = await query<BlockToProcess>(`
    SELECT DISTINCT 
      ba.slot,
      ba.mint,
      ba.id AS block_analysis_id,
      COUNT(bb.id) FILTER (
        WHERE bb.pnl_status IS NULL 
          AND bb.result = 'success'
          AND (bb.is_first_sniper OR bb.is_own OR bb.signature = ba.target_signature)
      ) AS pending_count
    FROM block_analyses ba
    JOIN block_buyers bb ON bb.block_analysis_id = ba.id
    WHERE ba.block_time >= NOW() - INTERVAL '${MAX_AGE_DAYS} days'
      AND bb.result = 'success'
      AND bb.pnl_status IS NULL
    GROUP BY ba.slot, ba.mint, ba.id
    HAVING COUNT(bb.id) FILTER (
      WHERE bb.pnl_status IS NULL 
        AND bb.result = 'success'
        AND (bb.is_first_sniper OR bb.is_own OR bb.signature = ba.target_signature)
    ) > 0
    ORDER BY pending_count DESC, ba.block_time DESC
    LIMIT ${MAX_BLOCKS_PER_ROUND}
  `);

  if (blocks.length === 0) {
    return;
  }

  console.log(`[pnl-worker] found ${blocks.length} blocks with pending pnl, processing...`);

  for (const block of blocks) {
    try {
      const result = await computeBulkBuyerPnL(block.slot, block.mint, {
        force: false,
      });

      const computed = result.results.length;
      const errors = result.results.filter((r) => r.status === 'error').length;

      if (computed > 0 || errors > 0) {
        console.log(
          `[pnl-worker] block ${block.slot}/${block.mint.slice(0, 8)}... computed=${computed}, errors=${errors}`
        );
      }
    } catch (err: any) {
      console.error(`[pnl-worker] failed to compute block ${block.slot}/${block.mint.slice(0, 8)}:`, err.message);
    }
  }
}

// 单独运行时的入口
async function main() {
  const { runMigrations } = await import('./migrate');
  
  await runMigrations();
  console.log('[pnl-worker] migrations done');

  await startPnlWorker();

  process.on('SIGINT', () => {
    console.log('\n[pnl-worker] shutting down...');
    stopPnlWorker();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    stopPnlWorker();
    process.exit(0);
  });
}

// 检测是否直接运行（node scripts/pnl-worker.ts）
if (require.main === module) {
  main().catch((err) => {
    console.error('[pnl-worker] failed:', err);
    process.exit(1);
  });
}
