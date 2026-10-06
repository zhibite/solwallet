/**
 * 回归校验：用 Helius 正常时算出的 closed 行做基准，比对新取数层算出的收益。
 *
 * ## 为什么要做这个
 *
 * Helius 配额耗尽后，pnl.ts 的取数层从「Helius 增强 API」换成了
 * 「普通 RPC + meta 余额差」。这等于换了整套数据来源，但收益算法没变。
 * 换来源最危险的不是跑不动，是**跑得动但数字悄悄错了**，
 * 所以必须拿一份「已知是对的」的结果当基准逐行比对。
 *
 * ## 基准从哪来
 *
 * block_buyers 里 pnl_status='closed' 的行，是 Helius 正常时算的，
 * 那批数是走 Helius 增强 API 得到的。closed 意味着 token 全部卖出、
 * 收益完全实现，最适合当基准（open / partial 的数天生就有"还没算完"的歧义）。
 *
 * ## 跑两种模式，因为它们能暴露不同的 bug
 *
 *   A 传入库里存的 token_amount
 *     → 买入数量和 Helius 当时拿到的一致，差异只可能来自 SOL / 手续费 / 失败判定
 *   B 不传 token_amount，让新代码自己算
 *     → 额外验证「余额差算出的买入数量」和 Helius 的 tokenTransfers 是否一致
 *
 * 只跑 A 会漏掉 token 数量推导的错；只跑 B 会把「数量算错」和
 * 「SOL 算错」混在一个偏差里，看不出问题出在哪。
 *
 * ## 这个脚本只读，绝不写库
 *
 * 偏差超阈值只是报告，由人来决定要不要覆盖。
 */

import { readFileSync } from 'fs';
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

/** 绝对偏差上限（SOL）。pump.fun 抢跑盘一单本金 0.1~1 SOL，5 mSOL 已是 1% 量级。 */
const ABS_TOL_SOL = 0.005;
/** 相对偏差上限。 */
const REL_TOL = 0.02;

const args = process.argv.slice(2);
const limit = Number(args[args.indexOf('--limit') + 1]) || 0;
const onlyMode = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : null;

type Row = {
  id: number; slot: number; signature: string; address: string;
  buy_sol: string; pnl_sol: string; pnl_status: string; pnl_sold_ratio: string;
  token_amount: string | null; result: string | null;
  mint: string; block_time: string;
};

interface Verdict {
  mode: 'A' | 'B';
  id: number;
  sig: string;
  old: number;
  neu: number | null;
  status: string;
  verdict: 'PASS' | 'FAIL' | 'ERROR' | 'MISMATCH';
  note: string;
}

async function main() {
  const { pool } = await import('../src/lib/db');
  const { calcCopyPnl } = await import('../src/lib/pnl');
  const { sourceStatus } = await import('../src/lib/tx-source');

  const { rows } = await pool.query<Row>(`
    SELECT bb.id, bb.slot, bb.signature, bb.address, bb.buy_sol, bb.pnl_sol,
           bb.pnl_status, bb.pnl_sold_ratio, bb.token_amount, bb.result,
           ba.mint, ba.block_time
      FROM block_buyers bb
      JOIN block_analyses ba ON ba.id = bb.block_analysis_id
     WHERE bb.pnl_status = 'closed'
       AND bb.pnl_sol IS NOT NULL
     ORDER BY bb.id
     ${limit > 0 ? `LIMIT ${Number(limit)}` : ''}
  `);

  console.log(`\n基准行（Helius 时期算的 closed）: ${rows.length} 行`);
  console.log(`取数来源: ${JSON.stringify(sourceStatus())}`);
  if (rows.length === 0) {
    console.log('没有基准行可比对，跳过。');
    await pool.end();
    process.exit(0);
  }
  for (const r of rows) {
    console.log(`  #${r.id} pnl=${Number(r.pnl_sol).toFixed(6)} buy=${r.buy_sol} ` +
      `ratio=${Number(r.pnl_sold_ratio).toFixed(3)} tok=${r.token_amount ?? 'NULL'} ` +
      `${r.signature.slice(0, 10)} ${r.address.slice(0, 6)}`);
  }

  const verdicts: Verdict[] = [];
  const modes: Array<'A' | 'B'> = onlyMode === 'A' || onlyMode === 'B' ? [onlyMode] : ['A', 'B'];

  for (const mode of modes) {
    console.log(`\n===== 模式 ${mode}：${mode === 'A' ? '传入库里的 token_amount' : '让新代码自己算 token 数量'} =====`);
    for (const r of rows) {
      const label = `#${r.id} ${r.signature.slice(0, 10)} ${r.address.slice(0, 6)}`;
      const old = Number(r.pnl_sol);
      try {
        const res = await calcCopyPnl({
          mint: r.mint,
          buySig: r.signature,
          buyWallet: r.address,
          buySol: Number(r.buy_sol),
          buyBlockTime: Math.floor(new Date(r.block_time).getTime() / 1000),
          buyTokenAmount: mode === 'A' ? Number(r.token_amount) : null,
        });
        const neu = res.pnlSol;

        if (neu == null) {
          verdicts.push({
            mode, id: r.id, sig: r.signature, old, neu: null, status: res.status,
            verdict: 'MISMATCH', note: '新实现算不出数（基准是 closed）',
          });
          console.log(`  ${label} 算不出(${res.status})  基准=${old.toFixed(6)}  <-- 状态都对不上`);
          continue;
        }

        const absDiff = Math.abs(neu - old);
        const relDiff = old !== 0 ? absDiff / Math.abs(old) : absDiff;
        const ok = absDiff <= ABS_TOL_SOL || relDiff <= REL_TOL;
        verdicts.push({
          mode, id: r.id, sig: r.signature, old, neu, status: res.status,
          verdict: ok ? 'PASS' : 'FAIL',
          note: `abs=${absDiff.toFixed(6)} rel=${(relDiff * 100).toFixed(1)}%`,
        });
        console.log(
          `  ${label} ${res.status} 基准=${old.toFixed(6)} 新=${neu.toFixed(6)} ` +
          `abs=${absDiff.toFixed(6)} rel=${(relDiff * 100).toFixed(1)}% ${ok ? 'PASS' : '  <== FAIL'}`,
        );
      } catch (e: any) {
        verdicts.push({
          mode, id: r.id, sig: r.signature, old, neu: null, status: 'throw',
          verdict: 'ERROR', note: e?.message ?? String(e),
        });
        console.log(`  ${label} 抛异常: ${(e?.message ?? String(e)).slice(0, 110)}`);
      }
    }
  }

  console.log('\n===== 汇总 =====');
  for (const mode of modes) {
    const vs = verdicts.filter((v) => v.mode === mode);
    const pass = vs.filter((v) => v.verdict === 'PASS').length;
    const fail = vs.filter((v) => v.verdict === 'FAIL').length;
    const err = vs.filter((v) => v.verdict === 'ERROR').length;
    const mis = vs.filter((v) => v.verdict === 'MISMATCH').length;
    console.log(`  模式 ${mode}: PASS ${pass} / FAIL ${fail} / ERROR ${err} / 状态不符 ${mis}  (共 ${vs.length})`);
    for (const v of vs.filter((x) => x.verdict !== 'PASS')) {
      console.log(`    #${v.id} ${v.sig.slice(0, 12)} [${v.verdict}] ${v.note}`);
    }
  }

  const bad = verdicts.filter((v) => v.verdict !== 'PASS');
  console.log(
    bad.length === 0
      ? '\n全部通过。\n'
      : `\n${bad.length} 行未通过 —— 本脚本未写任何数据，覆盖与否由你决定。\n`,
  );

  await pool.end();
  process.exit(bad.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
