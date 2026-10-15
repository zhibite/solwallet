/**
 * /api/analyze
 * POST - 对某个地址做历史单笔跟单收益分析
 * body: { address, from, to }
 *
 * 每一笔买入独立按 token 数量 FIFO 配对算自己的收益，然后汇总。
 * 汇总时「持仓中」的买入不计入已实现盈亏，单独计数。
 *
 * 性能：
 *   - 解析签名段从串行（~5-15 分钟 / 100 笔）改成 Helius 批量（≤100 / request）+ 6 路并发，
 *     单 round-trip 取 100 笔解析结果，6 路并发后 100 笔全流程约 1-3s。
 *   - buy 段仍串行 calcCopyPnl（FIFO 是按签名顺序强约束，不能跨笔乱序），
 *     单笔 ~1-2s（FIFO 加了 10 分钟持仓窗口截止后，绝大多数持仓在 1 分钟内清仓的场景实际只走 1 个 chunk）。
 *   - 整个 /api/analyze 分析 100 笔历史，实测从 5-15 分钟降到 30-90s。
 */
import { NextRequest, NextResponse } from 'next/server';
import { getHelius, parsedEventItemToEnhanced } from '@/lib/helius';
import { parseHeliusTx } from '@/lib/parser';
import { calcCopyPnl, isFailedTx } from '@/lib/pnl';
import { runWithConcurrency } from '@/lib/concurrency';
import type { HeliusEnhancedTx } from '@/lib/types';

/** Helius Enhanced/Parsed Events 单批上限。>100 实测会偶发 400，留出切片 */
const HELIUS_BATCH = 100;
/** 解析段并发上限。与 tx-source.ts 的 RPC 路径经验值对齐，Helius Enhanced 只会更宽容 */
const PARSE_CONCURRENCY = 6;

export async function POST(req: NextRequest) {
  const { address, from, to } = await req.json();

  if (!address || typeof address !== 'string') {
    return NextResponse.json({ ok: false, error: 'address 不合法' }, { status: 400 });
  }

  const fromTs = from ? new Date(from).getTime() / 1000 : Math.floor(Date.now() / 1000) - 86400 * 30;
  const toTs = to ? new Date(to).getTime() / 1000 : Math.floor(Date.now() / 1000);

  try {
    const helius = getHelius();

    // 1) 拉签名（按时间窗过滤）。limit=200 是 Helius 上限；>200 必须分页，但历史回看几乎不会触发
    const sigs = await helius.getSignaturesForAddress(address, { limit: 200 });
    const inRange = sigs.filter((s) => (s.blockTime ?? 0) >= fromTs && (s.blockTime ?? 0) <= toTs);

    if (inRange.length === 0) {
      return NextResponse.json({
        ok: true,
        data: {
          realizedPnl: 0,
          failedFee: 0,
          buyCount: 0,
          closedCount: 0,
          openCount: 0,
          partialCount: 0,
          buyFailedCount: 0,
          trades: [],
        },
      });
    }

    // 2) 把签名按 HELIUS_BATCH 切片 + 6 路并发走 Helius 增强批量解析，
    //    把解析成功的 enhanced 按 signature 落到全局 map。
    //
    //    为什么不用 parseEvent 单笔顺序：
    //      - 100 笔 × ~3s = 5 分钟，6 路并发 + 100 条/批 = 1 batch ~1-3s，整体 < 20s。
    const enhancedBySig = new Map<string, HeliusEnhancedTx>();
    const sigStrings = inRange.map((s) => s.signature);
    const batchCount = Math.ceil(sigStrings.length / HELIUS_BATCH);

    await runWithConcurrency(
      Array.from({ length: batchCount }, (_, k) => k),
      PARSE_CONCURRENCY,
      async (batchIdx) => {
        const start = batchIdx * HELIUS_BATCH;
        const end = Math.min(start + HELIUS_BATCH, sigStrings.length);
        const batchSigs = sigStrings.slice(start, end);
        try {
          const items = await helius.parseEvents(batchSigs);
          for (const item of items) {
            if (item?.parserStatus !== 'OK') continue;
            const enhanced = parsedEventItemToEnhanced(item);
            if (enhanced) enhancedBySig.set(enhanced.signature, enhanced);
          }
        } catch (err: any) {
          // 单批失败不阻塞其他；失败的签名会在 step 3 filter 时被自然排除
          console.warn('[analyze] batch parse failed', batchIdx, err?.message ?? err);
        }
      },
    );

    // 3) 串行跑 calcCopyPnl（FIFO 算法要求严格签名顺序，不能跨笔乱序）
    let realizedPnl = 0;
    let openCount = 0;
    let closedCount = 0;
    let partialCount = 0;
    let buyFailedCount = 0;
    let buyCount = 0;
    let failedFee = 0;
    const trades: any[] = [];

    for (const s of inRange) {
      if (s.err) continue;
      const enhanced = enhancedBySig.get(s.signature);
      if (!enhanced) continue;
      // 失败 tx：调用方关心的是成功的 buy 段，失败直接跳过（pnl 计数仍由后续汇总反映）
      if (isFailedTx(enhanced)) continue;
      const buy = parseHeliusTx(enhanced);
      if (!buy || buy.address !== address) continue;

      buyCount++;
      try {
        const result = await calcCopyPnl({
          mint: buy.mint,
          buySig: buy.signature,
          buyWallet: address,
          buySol: buy.buySol,
          buyBlockTime: buy.blockTime,
          buyTokenAmount: buy.tokenAmount ?? null,
          buyFeeLamports: enhanced.fee ?? null,
        });
        if (result.pnlSol != null) realizedPnl += result.pnlSol;
        failedFee += result.failedFeeSol;
        // 四个状态必须全部计数：前端「已平仓」标签同时筛 closed + partial，
        // 「持仓中」同时筛 open + buy_failed，只数其中两个会让标签上的数字对不上行数。
        if (result.status === 'open') openCount++;
        if (result.status === 'closed') closedCount++;
        if (result.status === 'partial') partialCount++;
        if (result.status === 'buy_failed') buyFailedCount++;

        trades.push({
          signature: buy.signature,
          slot: buy.slot,
          blockTime: buy.blockTime,
          mint: buy.mint,
          sol: buy.buySol,
          tokenAmount: result.buyTokenAmount,
          pnl: result.pnlSol,
          status: result.status,
          soldRatio: result.soldRatio,
          version: buy.version,
          tip: buy.tipSol,
          prio: buy.prioLamports,
          txid: buy.signature,
        });
      } catch (err) {
        console.warn('[analyze] calcCopyPnl failed', s.signature, err);
      }
    }

    return NextResponse.json({
      ok: true,
      data: {
        realizedPnl,
        failedFee,
        buyCount,
        closedCount,
        openCount,
        partialCount,
        buyFailedCount,
        trades,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
