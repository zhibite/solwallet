/**
 * 余额探测（balance probe）
 *
 * 作用：在 FIFO 翻签名精算 PnL 之前，用「读余额」快速判定 buyer 是否已经卖出。
 * 把"盈利不及时"的最坏延迟从 cron 周期（默认 15 分钟）压到 1 分钟级。
 *
 * 触发链：
 *   1) 买入入库（monitor.ts / ws-monitor.ts）→ 给 success buyer 设
 *      next_balance_check_at = NOW() + 1min
 *   2) /api/cron/balance-probe 每 1 分钟跑一次（本文件 runBalanceProbe）
 *   3) 找 next_balance_check_at <= NOW() 的 buyer
 *   4) 调 getTokenAccountsByOwner 查 mint 余额
 *   5) 比较余额 vs token_amount：
 *      - 1min 那点：没卖 → 推后 4 分钟（= 5min 那点再探一次）
 *      - 5min 那点：还没卖 → 交回 FIFO（next_balance_check_at = NULL）
 *      - 任一时点余额下降 → 立即调 calcCopyPnl 精算
 *      - 探测失败（429/超时）→ 推后 30s 再试，balance_check_count 不增加
 *
 * 为什么是两点（1min / 5min）而不是固定 1min × 5：
 *   pump 币"买入后 5 分钟内卖出"的占比经验上 < 50%，剩下 50%+ 是持仓套牢
 *   或 5+ 分钟才卖的。固定 1min × 5 对后 50% 是纯浪费（5 次 RPC 全白费），
 *   而且会和 FIFO 抢公共 RPC 配额（公共 RPC ~10 rps/端点）。
 *
 *   两点方案：覆盖"5 分钟内卖出"这一关键窗口（这部分最影响"算得慢"体验），
 *   最坏浪费 = 2 次 RPC，5+ 分钟的交回 FIFO 兜底。
 *
 * 设计取舍：
 *   - 余额查询节点本地，无历史扫描，比 FIFO 省 1-2 个数量级 RPC
 *   - "余额降了"才触发精算 → 避免对"还在持仓"的 buyer 空跑 FIFO
 *   - 用 calcCopyPnl 精算而不是用"初始余额 - 当前余额 × 当前价"：
 *     当前价要拉预言机（Birdeye/Helius），新依赖，不值；FIFO 已经有签名数据可复用
 *   - 探测不到 token ATA（用户 close 了账户）→ 视为"已卖光"，触发精算
 *   - 探测失败（429/超时）→ 推后 30s 再试，balance_check_count 不增加
 *   - 精算失败（429 翻签名）→ 推后 5s 再试，balance_check_count +1
 *
 * 不影响 compute-pnl cron：
 *   compute-pnl 主查询过滤的是 pnl_status IN ('open', NULL) AND result='success'
 *   探测触发精算后，pnl_status 变成 closed/partial，compute-pnl 自动跳过
 *   5min 那点还没动的（已交回）由 FIFO cron 走 10 分钟窗口自然结束
 */

import { query, execute, queryOne } from './db';
import { getMultiRpc } from './multi-rpc';
import { calcCopyPnl } from './pnl';

const MAX_PROBES_PER_RUN = 50;          // 单轮探测上限（防 RPC 雪崩）
const MAX_CHECKS_BEFORE_GIVEUP = 2;     // 两点探测：1min + 5min，2 次没动就交回 FIFO
const REPROBE_AFTER_NO_SELL_SEC = 240;  // 1min 那点探了没卖 → 推后 4min（= 5min 那个探测点）
const REPROBE_AFTER_ERROR_SEC = 30;     // 探测失败（429/超时）时重试时间（秒）
const REPROBE_AFTER_SOLD_SEC = 5;       // 探测到"已卖"但精算尚未完成时，5s 内不重复探测

/**
 * 跑一轮余额探测。
 *
 * 调用方：/api/cron/balance-probe POST（每 1 分钟一次）。
 *
 * 流程：
 *   1) 拉一批 next_balance_check_at <= NOW() 的 buyer
 *   2) 按 buyer.address 并发查余额（multi-rpc 内部已 round-robin + 限流）
 *   3) 分类处理：未卖 / 部分卖 / 全部卖 / 探测失败
 *
 * @returns 探测统计 + 精算触发计数
 */
export interface BalanceProbeStats {
  scanned: number;        // 本轮扫描的 buyer 数
  noSell: number;         // 探测到"没卖"（推后下次）
  partialSell: number;    // 探测到"部分卖"（触发精算）
  fullSell: number;       // 探测到"全卖"（触发精算）
  probeError: number;      // 探测失败（429/超时/账号不存在）
  recalculated: number;   // 实际触发 calcCopyPnl 精算的次数
  givenUp: number;        // 5min 那点还没动，交回 FIFO 的 buyer 数
}

export async function runBalanceProbe(): Promise<BalanceProbeStats> {
  const stats: BalanceProbeStats = {
    scanned: 0,
    noSell: 0,
    partialSell: 0,
    fullSell: 0,
    probeError: 0,
    recalculated: 0,
    givenUp: 0,
  };

  // 1) 拉一批 next_balance_check_at <= NOW() 的 buyer
  //    部分索引 idx_block_buyers_balance_probe 覆盖此查询（pnl_status IN ('open', NULL) + result='success'）
  //
  //    不拼到 block_analyses 的 block_time 过滤：余额探测不需要时间窗口，只看 buyer 自己的状态。
  //    单 SQL 行数小（< 几百），不需要按时间分批。
  //
  //    关键：必须按 next_balance_check_at ASC 拉，让最该跑的最先跑
  //    原因：cron 每 1 分钟跑一次；如果本轮 50 个名额用完，下轮再处理剩下的
  //          排序保持 FIFO，先到期的优先（避免「永远是同一批先跑」的奇怪顺序）
  //
  //    mint / block_time 都从 block_analyses join 拿 —— block_buyers 表本身不存 mint
  //    （mint 维度在 block_analyses 唯一）。
  const buyers = await query<{
    id: number;
    address: string;
    signature: string;
    mint: string;
    buy_sol: string;
    token_amount: string;
    balance_check_count: number;
    target_block_time: number;
  }>(`
    SELECT
      bb.id, bb.address, bb.signature,
      ba.mint,
      bb.buy_sol, bb.token_amount, bb.balance_check_count,
      extract(epoch from ba.block_time)::bigint AS target_block_time
    FROM block_buyers bb
    JOIN block_analyses ba ON ba.id = bb.block_analysis_id
    WHERE bb.next_balance_check_at <= NOW()
      AND bb.pnl_status IN ('open', NULL)
      AND bb.result = 'success'
      AND bb.token_amount IS NOT NULL
    ORDER BY bb.next_balance_check_at ASC
    LIMIT $1
  `, [MAX_PROBES_PER_RUN]);

  if (buyers.length === 0) {
    return stats;
  }
  stats.scanned = buyers.length;

  const rpc = getMultiRpc();

  // 2) 逐 buyer 并发查余额（multi-rpc 内部已 round-robin + 限流）
  const probeResults = await Promise.all(
    buyers.map(async (b): Promise<{
      buyer: typeof b;
      outcome: 'noSell' | 'partialSell' | 'fullSell' | 'noAccount' | 'error';
      currentRaw: bigint;
      soldRatio: number;
    }> => {
      try {
        const resp = await rpc.getTokenAccountsByOwner(b.address, b.mint);
        // Solana web3.js 返回 null 表示 RPC 端点全挂（multi-rpc 内部已尽力）
        // 返回 { value: [] } 表示该 owner 在该 mint 下没有任何 token account
        //   → 可能是用户 close 了 ATA；视为"已卖光"
        if (!resp || !resp.value || resp.value.length === 0) {
          return { buyer: b, outcome: 'noAccount' as const, currentRaw: 0n, soldRatio: 1 };
        }

        // 同一 (owner, mint) 理论上最多 1 个 ATA，但有项目方会发空投到多个 token account
        // → 取所有 account 的余额求和（保守：用户实际持仓 = 所有 ATA 之和）
        let totalRaw = 0n;
        for (const acct of resp.value) {
          const info = acct?.account?.data?.parsed?.info;
          if (!info?.tokenAmount?.amount) continue;
          try {
            totalRaw += BigInt(info.tokenAmount.amount);
          } catch {
            // amount 不是合法整数（极少数 decimals > 0 的边缘 case）
            // 退回 uiAmount * 10^decimals 兜底
            const ui = Number(info.tokenAmount.uiAmount ?? 0);
            const dec = info.tokenAmount.decimals ?? 0;
            totalRaw += BigInt(Math.floor(ui * 10 ** dec));
          }
        }

        const initialRaw = BigInt(b.token_amount);
        if (initialRaw <= 0n) {
          // token_amount 解析异常（买入时拿到的就是 0），无法做余额对比
          // → 视为"没卖"，走正常 noSell 分支（count 不变，下次正常探测）
          return { buyer: b, outcome: 'noSell' as const, currentRaw: totalRaw, soldRatio: 0 };
        }

        // 容差：token 余额会有精度问题（spl token 收尾的 dust），
        // 视为 0 = 全卖，视为 initialRaw = 没卖，中间按比例
        if (totalRaw >= initialRaw) {
          return { buyer: b, outcome: 'noSell' as const, currentRaw: totalRaw, soldRatio: 0 };
        }
        if (totalRaw === 0n) {
          return { buyer: b, outcome: 'fullSell' as const, currentRaw: 0n, soldRatio: 1 };
        }
        // 部分卖：精确比例
        const soldRatio = Number(initialRaw - totalRaw) / Number(initialRaw);
        return { buyer: b, outcome: 'partialSell' as const, currentRaw: totalRaw, soldRatio };
      } catch (err: any) {
        // 429 / 超时 / RPC 异常 → 推后 30s 后重试，不增加 check_count
        console.warn(
          `[balance-probe] buyer ${b.id} (${b.address.slice(0, 8)}…) probe failed: ${err?.message ?? err}`,
        );
        return { buyer: b, outcome: 'error' as const, currentRaw: 0n, soldRatio: 0 };
      }
    }),
  );

  // 3) 分类处理
  for (const r of probeResults) {
    const { buyer: b, outcome, soldRatio } = r;

    if (outcome === 'noSell') {
      // 没卖：count=0 是 1min 那点，count=1 是 5min 那点
      const newCount = b.balance_check_count + 1;
      if (newCount >= MAX_CHECKS_BEFORE_GIVEUP) {
        // 5min 那点还没动：交回 FIFO 兜底
        await execute(
          `UPDATE block_buyers
              SET next_balance_check_at = NULL,
                  balance_check_count   = $1
            WHERE id = $2`,
          [newCount, b.id],
        );
        stats.givenUp++;
        console.log(
          `[balance-probe] buyer ${b.id} ${b.address.slice(0, 8)}… no movement at 5min checkpoint (count=${newCount}), deferring to FIFO`,
        );
      } else {
        // 1min 那点没卖 → 推后 4 分钟到 5min 那个探测点
        await execute(
          `UPDATE block_buyers
              SET next_balance_check_at = NOW() + interval '${REPROBE_AFTER_NO_SELL_SEC} seconds',
                  balance_check_count   = $1
            WHERE id = $2`,
          [newCount, b.id],
        );
        stats.noSell++;
      }
      continue;
    }

    if (outcome === 'error') {
      // 探测失败：推后 30s + counter 不变
      await execute(
        `UPDATE block_buyers
            SET next_balance_check_at = NOW() + interval '${REPROBE_AFTER_ERROR_SEC} seconds'
          WHERE id = $1`,
        [b.id],
      );
      stats.probeError++;
      continue;
    }

    // partialSell / fullSell / noAccount → 触发精算
    // 调 calcCopyPnl（已经有 FIFO 翻签名 + 10 分钟持仓窗口的所有逻辑，零复制）
    // 写回 pnl_sold_ratio 作为「早期提示」（部分平仓时给 UI 一个动态百分比，不必等精算完）
    try {
      const r = await calcCopyPnl({
        mint: b.mint,
        buySig: b.signature,
        buyWallet: b.address,
        buySol: parseFloat(String(b.buy_sol)),
        buyBlockTime: Number(b.target_block_time),
        buyTokenAmount: Number(b.token_amount),
      });
      // 精算完成后写回（与 computeBulkBuyerPnL 的写法对齐）
      await execute(
        `UPDATE block_buyers
            SET pnl_sol          = $1,
                pnl_status       = $2,
                pnl_sold_ratio   = $3,
                next_balance_check_at = NULL,
                balance_check_count   = balance_check_count + 1
          WHERE id = $4`,
        [r.pnlSol, r.status, r.soldRatio, b.id],
      );
      stats.recalculated++;
      if (outcome === 'partialSell') stats.partialSell++;
      else stats.fullSell++;
      console.log(
        `[balance-probe] buyer ${b.id} ${b.address.slice(0, 8)}… ${outcome} → ` +
        `status=${r.status} pnlSol=${r.pnlSol?.toFixed(6) ?? 'null'}`,
      );
    } catch (recalcErr: any) {
      // 精算失败（最常见 = FIFO 翻签名命中 429）→ 推后 5s 触发再试
      // 但 counter +1（每次精算失败都算一次有效探测）
      await execute(
        `UPDATE block_buyers
            SET next_balance_check_at = NOW() + interval '${REPROBE_AFTER_SOLD_SEC} seconds',
                balance_check_count   = balance_check_count + 1
          WHERE id = $1`,
        [b.id],
      );
      stats.probeError++;
      console.warn(
        `[balance-probe] buyer ${b.id} ${b.address.slice(0, 8)}… recalc failed (${outcome}): ${recalcErr?.message ?? recalcErr}`,
      );
    }
  }

  return stats;
}

/**
 * 给一批 buyer 设上"1 分钟后探测"。
 *
 * 调用方：monitor.ts / ws-monitor.ts 在 saveBlockAnalysis 之后，
 * 给所有 result='success' 的 buyer 设上。失败买入（result='failed'）不用设。
 *
 * @param buyerIds block_buyers.id 列表
 *
 * 注意：这里的 SQL 是同步写的，但调用方一般在 setImmediate 里，阻塞不到监控主流程。
 * 单次 UPDATE 上百行 < 10ms，可接受。
 */
export async function scheduleBalanceProbe(buyerIds: number[]): Promise<void> {
  if (buyerIds.length === 0) return;
  await execute(
    `UPDATE block_buyers
        SET next_balance_check_at = NOW() + interval '1 minute',
            balance_check_count   = 0
      WHERE id = ANY($1::int[])
        AND result = 'success'
        AND token_amount IS NOT NULL`,
    [buyerIds],
  );
}

/**
 * 查询余额探测调度状态（运维 / 排错用，给 GET 状态接口调用）
 */
export interface BalanceProbeQueueStats {
  pending: number;       // 当前 next_balance_check_at <= NOW() 待探测
  scheduled: number;     // 已调度但还没到时间
  givenUp: number;       // 5min 那点没动交给 FIFO 的累计
}

export async function getBalanceProbeQueueStats(): Promise<BalanceProbeQueueStats> {
  const row = await queryOne<{
    pending: string;
    scheduled: string;
    givenUp: string;
  }>(`
    SELECT
      COUNT(*) FILTER (WHERE next_balance_check_at <= NOW())                                    AS pending,
      COUNT(*) FILTER (WHERE next_balance_check_at > NOW() AND balance_check_count < $1)        AS scheduled,
      COUNT(*) FILTER (WHERE next_balance_check_at IS NULL AND balance_check_count >= $1)      AS givenUp
    FROM block_buyers
    WHERE pnl_status IN ('open', NULL)
      AND result = 'success'
  `, [MAX_CHECKS_BEFORE_GIVEUP]);
  return {
    pending: parseInt(row?.pending ?? '0', 10),
    scheduled: parseInt(row?.scheduled ?? '0', 10),
    givenUp: parseInt(row?.givenUp ?? '0', 10),
  };
}
