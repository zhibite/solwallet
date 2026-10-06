/**
 * 单行逐步诊断：把 calcCopyPnl 内部每一步拆开打印。
 *
 * 为什么需要：回归只说「买入交易取数失败」，但从买入到卖出之间隔着
 * fetchSigsFrom / fetchTxViews / rpcTxView 三层，每层都可能把「没取到」
 * 变成 null。猜是哪一层没有意义，把每层的实际输入输出打出来才有。
 */
import { readFileSync } from 'fs';
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const ID = Number(process.argv[2] ?? 30);

async function main() {
  const { pool } = await import('../src/lib/db');
  const { getMultiRpc } = await import('../src/lib/multi-rpc');
  const { fetchSigsFrom, fetchTxViews, rpcTxView } = await import('../src/lib/tx-source');
  const { calcCopyPnl } = await import('../src/lib/pnl');

  const { rows } = await pool.query(
    `SELECT bb.id, bb.signature, bb.address, bb.buy_sol, bb.token_amount,
            ba.mint, ba.block_time
       FROM block_buyers bb
       JOIN block_analyses ba ON ba.id = bb.block_analysis_id
      WHERE bb.id = $1`,
    [ID],
  );
  const r: any = rows[0];
  if (!r) { console.log(`没有 #${ID}`); await pool.end(); process.exit(1); }

  console.log(`#${r.id} mint=${r.mint}`);
  console.log(`  钱包=${r.address}`);
  console.log(`  买入=${r.signature}`);
  console.log(`  buySol=${r.buy_sol} 库里的 token_amount=${r.token_amount}\n`);

  const rpc = getMultiRpc();

  // --- 第 1 层：买入交易本身 ---
  const rawTx = await rpc.getTransaction(r.signature);
  console.log(`[1] getTransaction 原始返回: ${rawTx === null ? 'null' : '有数据'}`);
  if (rawTx) {
    const msg: any = (rawTx as any).transaction?.message;
    const raw: any[] = msg?.staticAccountKeys ?? msg?.accountKeys ?? [];
    console.log(`    message 字段: ${Object.keys(msg ?? {}).join(', ')}`);
    console.log(`    账户数=${raw.length}  首个元素类型=${typeof raw[0]}`);
    console.log(`    首个元素: ${JSON.stringify(String(raw[0])).slice(0, 90)}`);
    console.log(`    钱包在 accountKeys 里的下标: ${raw.indexOf(r.address)}`);
    console.log(`    meta 存在: ${!!(rawTx as any).meta}  fee=${(rawTx as any).meta?.fee}`);
  }

  // --- 第 2 层：rpcTxView 转换 ---
  const view = rpcTxView(rawTx);
  console.log(`\n[2] rpcTxView: ${view === null ? 'null  <-- 就是这里丢的' : '转换成功'}`);
  if (view) {
    console.log(`    signature 对得上: ${view.signature === r.signature}`);
    const delta = (view as any).tokenDelta?.(r.mint, r.address);
    console.log(`    tokenDelta(mint, 钱包) = ${delta ?? 'N/A'}`);
  }

  // --- 第 3 层：锚定翻页 ---
  const sigs = await fetchSigsFrom(r.address, r.signature);
  console.log(`\n[3] 买入之后的签名: ${sigs.length} 笔`);
  if (sigs.length > 0) {
    console.log(`    最新一笔 slot=${sigs[0].slot}  最老一笔 slot=${sigs[sigs.length - 1].slot}`);
  }

  // --- 第 4 层：取前 100 笔交易，看有多少笔能用 ---
  if (sigs.length > 0) {
    const txs = await fetchTxViews(sigs.slice(0, 100).map((s) => s.signature), r.address);
    const nulls = txs.filter((t) => t === null).length;
    console.log(`\n[4] 前 100 笔交易: 取到 ${100 - nulls}，null ${nulls}`);
    let touched = 0;
    for (const t of txs) {
      if (!t) continue;
      const d = (t as any).tokenDelta?.(r.mint, r.address);
      if (d) touched++;
    }
    console.log(`    其中与本 mint 有余额变动的: ${touched} 笔`);
  }

  // --- 第 5 层：整条链路 ---
  try {
    const res = await calcCopyPnl({
      mint: r.mint,
      buySig: r.signature,
      buyWallet: r.address,
      buySol: Number(r.buy_sol),
      buyBlockTime: Math.floor(new Date(r.block_time).getTime() / 1000),
      buyTokenAmount: Number(r.token_amount),
    });
    console.log(`\n[5] calcCopyPnl: status=${res.status}  pnl=${res.pnlSol}  ratio=${res.soldRatio ?? 'N/A'}`);
  } catch (e: any) {
    console.log(`\n[5] calcCopyPnl 抛异常: ${e?.message ?? String(e)}`);
  }

  console.log('\n--- RPC 池状态 ---');
  for (const s of rpc.getStatus()) {
    console.log(`  ${s.shortUrl.padEnd(32)} 成功率=${s.successRate.padStart(6)}  429后降配额到=${s.rpsCap}  until=${s.supportsUntil}  ${s.circuitOpen}`);
  }

  await pool.end();
  process.exit(0);
}

main();
