/**
 * 抓 getblock / leorpc 到底报什么错。
 *
 * 回归日志里它们是 circuit open fails=9，但熔断日志不带错误内容。
 * 这两个端点每个占了池子 1/6，白扔掉就是 1/6 的吞吐 —— 值得先确认是
 * 「这个端点坏了」还是「我们对它的请求方式不对」。两者的处理完全不同。
 */
import { readFileSync } from 'fs';
import { Connection, PublicKey } from '@solana/web3.js';

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const wallet = process.argv[2];
const targets = (process.argv[3] ?? '3,6').split(',').map(Number);

async function main() {
  const urls: Record<number, string> = {};
  for (const k of Object.keys(process.env)) {
    const m = k.match(/^SOLANA_RPC_(\d+)$/);
    if (m) urls[Number(m[1])] = process.env[k]!;
  }

  for (const n of targets) {
    const url = urls[n];
    if (!url) { console.log(`RPC_${n} 没配`); continue; }
    const conn = new Connection(url, 'confirmed');
    console.log(`\n=== RPC_${n}  ${new URL(url).host} ===`);

    // 先拿一批签名（用能用的节点代取，避免这一步本身就失败）
    const sigs = await new Connection(urls[2], 'confirmed')
      .getSignaturesForAddress(new PublicKey(wallet), { limit: 25 });

    const errs = new Map<string, number>();
    let ok = 0, nulls = 0;
    for (const s of sigs) {
      try {
        const t = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1 });
        if (t) ok++; else nulls++;
      } catch (e: any) {
        const key = `${e?.status ?? 'no-status'} | ${(e?.message ?? String(e)).slice(0, 90)}`;
        errs.set(key, (errs.get(key) ?? 0) + 1);
      }
    }
    console.log(`  ${sigs.length} 笔：成功 ${ok}，null ${nulls}，报错 ${[...errs.values()].reduce((a, b) => a + b, 0)}`);
    for (const [k, v] of [...errs.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ×${v}  ${k}`);
    }
  }
}

main();
