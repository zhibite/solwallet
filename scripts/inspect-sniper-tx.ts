// scripts/inspect-sniper-tx.ts
// 把 amount 当字符串解析成 BigInt 再换算
import { query, pool } from '../src/lib/db';
import { getHelius } from '../src/lib/helius';

const LAMPORTS_PER_SOL = 1_000_000_000;

// 现行 8 个
const KNOWN_JITO_TIPS = new Set([
  '96gYZGLnJYVFmbLzopPSmXAwG5Mo2ckB8Z7uVwYxiwQ5',
  'ADuotR6KkC1i2sccT6RP3jMMLzrEgzVa4LAmQ4ZmFn3J',
  'DttWaMuVvTiduZRnguL7h9xJm5wP3iYpfkRJTg3MWBPJ',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPd1deFiritQLxj9',
  'HFqU5x63VTqvQss8hp11i4wV8JEodzctd55h2P8iF4jH',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLv9Y',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcUWND9jf',
]);

async function main() {
  const helius = getHelius();
  const sigs = await query<any>(`
    SELECT signature FROM block_buyers
    WHERE slot_offset = 0 AND is_follower = TRUE
    ORDER BY prio_lamports DESC NULLS LAST
    LIMIT 6
  `);
  const tipAccountHits = new Map<string, { count: number; lamports: bigint }>();
  const otherReceivers = new Map<string, { count: number; lamports: bigint; sample: string }>();
  let totalPayout = 0n;

  for (const r of sigs) {
    const list = await helius.parseTransactions([r.signature]);
    const tx = list?.[0];
    if (!tx) { console.log(`# ${r.signature}  Helius 没拿到`); continue; }
    console.log(`\nsig ${r.signature}`);
    console.log(`  feePayer=${tx.feePayer}  fee=${tx.fee}  source=${tx.source}  type=${tx.type}  version=${tx.version}`);
    const outs = (tx.nativeTransfers ?? []).filter((t: any) => t.fromUserAccount === tx.feePayer);
    let sumOut = 0n;
    for (const t of outs) {
      const lamports = BigInt(t.amount);
      sumOut += lamports;
      if (KNOWN_JITO_TIPS.has(t.toUserAccount)) {
        tipAccountHits.set(t.toUserAccount, { count: (tipAccountHits.get(t.toUserAccount)?.count ?? 0) + 1, lamports: (tipAccountHits.get(t.toUserAccount)?.lamports ?? 0n) + lamports });
      } else {
        const key = t.toUserAccount;
        const cur = otherReceivers.get(key) ?? { count: 0, lamports: 0n, sample: r.signature };
        otherReceivers.set(key, { count: cur.count + 1, lamports: cur.lamports + lamports, sample: cur.sample });
      }
      const tag = KNOWN_JITO_TIPS.has(t.toUserAccount) ? '  ★TIP' : '';
      console.log(`  payer → ${t.toUserAccount}  ${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(9)} SOL${tag}`);
    }
    totalPayout += sumOut;
    console.log(`  Σ payer outflow = ${(Number(sumOut) / LAMPORTS_PER_SOL).toFixed(9)} SOL`);
  }

  console.log('\n=== 已知 8 个 tip account 在这些 tx 里的命中 ===');
  if (tipAccountHits.size === 0) console.log('  无');
  for (const [a, v] of [...tipAccountHits.entries()].sort((x, y) => Number(y[1].lamports - x[1].lamports))) {
    console.log(`  ${a}  count=${v.count}  total=${(Number(v.lamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  }
  console.log('\n=== 「非常见 tip account」其他收款账户 Top 20（高频 + 高额）===');
  const sorted = [...otherReceivers.entries()].sort((a, b) => Number(b[1].lamports - a[1].lamports));
  for (const [a, v] of sorted.slice(0, 20)) {
    console.log(`  ${a}  count=${v.count}  total=${(Number(v.lamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL  sample=${v.sample}`);
  }
  console.log(`\n总 feePayer outflow：${(Number(totalPayout) / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
