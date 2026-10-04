/**
 * 验证新的单笔跟单收益算法（聚焦断言，尽量少打 Helius）。
 *
 * 案例：波段机器人 7SLPYM… 在币 HDkp7…pump 上反复做多轮往返，
 * 块详情页分析的是 11:45:37 那一笔（slot 453246949）。
 *
 * 上一轮用原生 RPC 逐笔人工核对过的账本（时间正序）：
 *   11:32:19 买 1397763.17 tok / 0.711514 SOL
 *   11:33:55 买 1084515.57 tok / 0.508000
 *   11:36:58 买  733471.42 tok / 0.508210
 *   11:40:12 买 1593029.98 tok / 0.710210
 *   11:40:50 买 1259485.96 tok / 0.508210
 *   11:45:37 买 1075722.72 tok / 0.508000   <= 块详情页分析的就是这笔
 *   11:45:46 卖 1075722.72 tok / 净收 0.515001
 *   12:01:31 买 1240582.73 tok / 0.508210
 *   12:01:38 卖 1240582.73 tok / 净收 0.502654
 *   12:12:30 买 1733567.95 tok / 0.710000
 *   12:12:52 卖 1733567.95 tok / 净收 0.732199
 *
 * 第 1 轮的正确单笔跟单收益：
 *   0.515001 - 0.508000 - 0.0000188(买费) - 0.0000152(卖费) = +0.006967
 * 旧实现把后面所有轮次的卖出都算到这一笔上，算出 +1.2455。
 */
import { readFileSync } from 'fs';
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const MINT = 'HDkp7bUr3MCqehRR2yt5ibSvUrqydftZ9CYSYQggpump';
const WALLET = '7SLPYMSA5FxaEvJRk7C6Pxav8KSWt7xcqGw4no4s8p7z';
const BUY_SIG = '3YJc6CHuWkKJDqtTBWt1GeiyPRT1QMCJdmv27iGEaWcFWu4VfNjCjVH2Fs91jVD17wy1P3Z3vewG1tLh86CN6h48';
const BUY_TOKENS = 1075722.722683;

const EXPECT_PNL = 0.006967;
const EXPECT_PROCEEDS = 0.515001; // 只有第 1 轮那笔卖出的净收入
const EXPECT_BUY_FEE = 0.0000188;
const EXPECT_SELL_FEE = 0.0000152;
const OLD_BUGGY = 1.2455; // 旧实现算出来的值

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      if ((e?.response?.status ?? e?.status) !== 429 || i === tries - 1) throw e;
      const wait = 3000 * (i + 1);
      console.log(`  (${label} 撞到 429，等 ${wait / 1000}s 重试)`);
      await sleep(wait);
    }
  }
  throw new Error('unreachable');
}

async function main() {
  const { calcCopyPnl } = await import('../src/lib/pnl');
  const { pool } = await import('../src/lib/db');

  const res = await withRetry('calcCopyPnl', () =>
    calcCopyPnl({
      mint: MINT,
      buySig: BUY_SIG,
      buyWallet: WALLET,
      buySol: 0.508,
      buyBlockTime: Math.floor(new Date('2026-10-04T11:45:37.000Z').getTime() / 1000),
      buyTokenAmount: BUY_TOKENS,
    }),
  );

  console.log('\n=== 11:45:37 这一笔（块详情页分析的那笔）的结果 ===');
  console.log(`  status           = ${res.status}`);
  console.log(`  买入成本         = ${res.costSol.toFixed(6)} SOL`);
  console.log(`  买入手续费       = ${res.buyFeeSol.toFixed(7)} SOL`);
  console.log(`  卖出净收入       = ${res.proceedsSol.toFixed(6)} SOL`);
  console.log(`  卖出手续费       = ${res.sellFeeSol.toFixed(7)} SOL`);
  console.log(`  后续加仓         = ${res.laterBuys} 笔`);
  console.log(`  窗口内失败手续费 = ${res.failedFeeSol.toFixed(7)} SOL（不并入 pnl）`);
  console.log(`  卖出比例         = ${(res.soldRatio * 100).toFixed(1)}%`);
  console.log(`  跟单收益         = ${res.pnlSol?.toFixed(6)} SOL`);
  console.log('  配对链路:');
  for (const t of res.trades) {
    console.log(
      `    ${t.side.toUpperCase().padEnd(4)} ${t.signature.slice(0, 12)} token=${t.tokenAmount} sol=${t.solAmount.toFixed(6)} fee=${t.feeSol.toFixed(7)}`,
    );
  }

  console.log('\n=== 断言 ===');
  let pass = 0;
  let fail = 0;
  const check = (name: string, ok: boolean, detail: string) => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
    ok ? pass++ : fail++;
  };

  check(
    '单笔跟单收益 = 人工核对的 +0.006967',
    Math.abs((res.pnlSol ?? -1) - EXPECT_PNL) < 0.000002,
    `实得 ${res.pnlSol?.toFixed(6)}`,
  );
  check(
    '卖出净收入只含本轮那笔卖出（不含后两轮）',
    Math.abs(res.proceedsSol - EXPECT_PROCEEDS) < 0.000002,
    `实得 ${res.proceedsSol.toFixed(6)}，若在 1.75 附近说明把别的轮次收入算进来了`,
  );
  check(
    '买入手续费用真实 fee（含优先级费）',
    Math.abs(res.buyFeeSol - EXPECT_BUY_FEE) < 1e-9,
    `实得 ${res.buyFeeSol.toFixed(7)}，写死 5000 lamports 会是 0.0000050`,
  );
  check(
    '卖出手续费只计一次',
    Math.abs(res.sellFeeSol - EXPECT_SELL_FEE) < 1e-9,
    `实得 ${res.sellFeeSol.toFixed(7)}`,
  );
  check('状态 = closed（token 全部卖出）', res.status === 'closed', `实得 ${res.status}`);
  check(
    '卖出比例 = 100%',
    Math.abs(res.soldRatio - 1) < 1e-6,
    `实得 ${(res.soldRatio * 100).toFixed(1)}%`,
  );
  // 这台机器人每发一笔成功交易，就配一笔失败交易（11:45:37 那笔的同伴是 msUNHtam172c）。
  // 失败交易必须被排除在链路外 —— 旧实现把它们当成了成功卖出。
  check(
    '失败的配对交易没有被当成卖出',
    !res.trades.some((t) => t.signature.startsWith('msUNHtam172c')),
    `链路 ${res.trades.length} 笔（含后续轮次，收益不计入），失败交易未混入`,
  );
  check(
    '相比旧实现不再虚高',
    (res.pnlSol ?? 0) < 0.01,
    `旧实现 ${OLD_BUGGY}，新实现 ${res.pnlSol?.toFixed(6)}`,
  );

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  await pool.end();
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error('ERR', e?.message ?? e);
  process.exit(1);
});
