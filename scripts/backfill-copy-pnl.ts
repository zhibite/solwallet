/**
 * 用新的单笔跟单收益口径重算库里已存的 pnl_sol。
 *
 * 背景：旧的 pnl_sol 是「只认一笔买入、把这个地址对该 mint 的全部卖出收入都算进来」
 * 的口径。遇到一个地址对同一币做多轮买卖（波段机器人）就会虚高几个数量级 ——
 * 实测某笔老实现算出 +1.2455 SOL，真实只有 +0.006967 SOL。
 *
 * 安全约束：
 *   - 默认只处理已经有 pnl_sol 的行（历史算错的那些）。没算过的行保持 null，
 *     不在这里顺手批量跑，免得一次性打爆 Helius 配额。
 *   - 新口径算得出数就写，算不出（持仓中 / token 数量缺失）就写 NULL。
 *     旧值来自错口径，留着比 NULL 更糟。
 *   - 抛异常（Helius 限流 / 网络抖动）时整行不动：这种失败不代表「算不出来」，
 *     写 NULL 会误伤本来正确的数。留下的旧值仍然是旧口径，日志里会标出来。
 *   - 失败判定不读 block_buyers.result，交给 calcCopyPnl 看 Helius 的 transactionError；
 *     买入手续费也不估算，直接用 calcCopyPnl 从买入交易读到的链上真实 fee。
 *
 * 用法：
 *   npx tsx scripts/backfill-copy-pnl.ts              # 只重算已有 pnl_sol 的行
 *   npx tsx scripts/backfill-copy-pnl.ts 265          # 只重算某个 block_analysis_id
 *   npx tsx scripts/backfill-copy-pnl.ts 265 --all    # 该分析下所有行都算（不管有没有旧值）
 *   npx tsx scripts/backfill-copy-pnl.ts --ids=30,45  # 只重算指定行
 */
import { readFileSync } from 'fs';
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const onlyAnalysis = /^\d+$/.test(process.argv[2] ?? '') ? parseInt(process.argv[2], 10) : null;
const includeUnset = process.argv.includes('--all');
const idsArg = process.argv.find((a) => a.startsWith('--ids='));
const onlyIds = idsArg
  ? idsArg.slice('--ids='.length).split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite)
  : null;
// 老钱包签名量大到几万笔，限流概率高，间隔给大一点
const rowDelay = process.argv.includes('--slow') ? 4000 : 1200;

async function main() {
  const { pool, query } = await import('../src/lib/db');
  const { calcCopyPnl } = await import('../src/lib/pnl');
  const { getHelius } = await import('../src/lib/helius');
  const { inboundTokenAmount } = await import('../src/lib/parser');
  const helius = getHelius();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const where: string[] = [];
  const params: any[] = [];
  if (onlyIds) {
    params.push(onlyIds);
    where.push(`bb.id = ANY($${params.length})`);
  } else if (onlyAnalysis != null) {
    params.push(onlyAnalysis);
    where.push(`bb.block_analysis_id = $${params.length}`);
  } else if (!includeUnset) {
    where.push(`bb.pnl_sol IS NOT NULL`);
  }

  const rows = await query<any>(
    `SELECT bb.id, bb.signature, bb.address, bb.buy_sol::float, bb.prio_lamports,
            bb.result, bb.pnl_sol::float AS old_pnl, bb.token_amount AS old_token,
            ba.mint, ba.block_time, ba.slot
       FROM block_buyers bb
       JOIN block_analyses ba ON ba.id = bb.block_analysis_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY bb.id`,
    params,
  );
  console.log(`待处理 ${rows.length} 行\n`);

  // --- 补齐 token_amount：没有它就没法按 token 数量配对，会退化成旧行为 ---
  const mintsOfSig = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!mintsOfSig.has(r.signature)) mintsOfSig.set(r.signature, new Set());
    mintsOfSig.get(r.signature)!.add(r.mint);
  }
  const sigs = [...mintsOfSig.keys()];
  const tokenMap = new Map<string, number>(); // `${sig}|${mint}` -> 数量
  for (let i = 0; i < sigs.length; i += 50) {
    const batch = sigs.slice(i, i + 50);
    let txs: any[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        txs = await helius.parseEventsAsEnhanced(batch);
        break;
      } catch (e: any) {
        const st = e?.response?.status ?? e?.status;
        if (st !== 429 || attempt === 3) throw e;
        await sleep(2000 * (attempt + 1));
      }
    }
    for (const tx of txs) {
      if (!tx) continue;
      for (const mint of mintsOfSig.get(tx.signature) ?? []) {
        const amt = inboundTokenAmount(tx, mint);
        if (amt > 0) tokenMap.set(`${tx.signature}|${mint}`, amt);
      }
    }
    process.stdout.write(`\r  补齐 token: ${Math.min(i + 50, sigs.length)}/${sigs.length}`);
    await sleep(400);
  }
  console.log(`\n  拿到 token 数量: ${tokenMap.size}/${rows.length} 行\n`);

  let ok = 0;
  let unchanged = 0;
  let nulled = 0;
  let failed = 0;

  for (const r of rows) {
    const label = `#${r.id} slot=${r.slot} ${r.signature.slice(0, 10)} ${r.address.slice(0, 6)}`;
    const tokens = tokenMap.get(`${r.signature}|${r.mint}`) ?? null;

    try {
      // 不传 buyFeeLamports：calcCopyPnl 已经把买入交易解析出来了，用链上真实 fee，
      // 比这里拿 5000 + prio_lamports 估算准（多签交易 base fee 是 5000×签名数）。
      // 失败判定也交给 calcCopyPnl 看 Helius 的 transactionError，
      // 不信 block_buyers.result 那一列 —— 整个回填就是因为不信旧结果才存在的。
      const res = await calcCopyPnl({
        mint: r.mint,
        buySig: r.signature,
        buyWallet: r.address,
        buySol: r.buy_sol,
        buyBlockTime: Math.floor(new Date(r.block_time).getTime() / 1000),
        buyTokenAmount: tokens,
      });

      const delta =
        r.old_pnl != null && res.pnlSol != null ? (res.pnlSol - r.old_pnl).toFixed(6) : '';
      await pool.query(
        `UPDATE block_buyers
            SET pnl_sol = $1, pnl_status = $2, pnl_sold_ratio = $3,
                token_amount = COALESCE($4::numeric, token_amount)
          WHERE id = $5`,
        [res.pnlSol, res.status, res.soldRatio, tokens, r.id],
      );
      ok++;
      const mark = delta ? (delta.startsWith('-') ? '' : '  <-- 修正') : '';
      if (res.pnlSol == null) {
        // 新口径算不出数（持仓中 / token 数量缺失）。旧值是错口径算出来的，
        // 留着比写 NULL 更危险 —— NULL 至少是诚实的「还没算出来」。
        // 代价是丢掉一个可能看着合理的数，但它本来就不对。
        console.log(`  ${label} 算不出（${res.status}）→ 写 NULL，旧值 ${r.old_pnl} 已丢弃`);
        nulled++;
        continue;
      }
      console.log(
        `  ${label} buy=${r.buy_sol} ${res.status} 旧=${r.old_pnl} 新=${res.pnlSol.toFixed(6)} ` +
          `Δ=${delta}${mark}`,
      );
      if (delta === '0.000000') unchanged++;
    } catch (e: any) {
      // 抛异常 = Helius 限流 / 网络抖动，不是「这笔算不出来」。
      // 这种情况不动数据库：既不写 NULL（会误伤本来正确的数），也不覆盖（结果是残缺的）。
      failed++;
      console.warn(
        `  ${label} 失败，原样保留旧值 ${r.old_pnl}（该值仍是旧口径，未经验证）: ${e?.message ?? e}`,
      );
    }
    await sleep(rowDelay);
  }

  console.log(
    `\n完成: ${ok} 重算（其中 ${unchanged} 个数没变, ${nulled} 个算不出已写 NULL）, ${failed} 失败未动`,
  );
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
