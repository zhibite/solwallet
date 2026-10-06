/**
 * 实测 RPC 池的真实吞吐。
 *
 * 为什么必须实测：代码里 rps 起步值是猜的，回归能不能跑完完全取决于这个猜得
 * 对不对。凭感觉调并发是在赌。直接按固定并发打一段 getTransaction，
 * 分别统计 429 占比和实际 QPS，让「能跑多快」变成一个数字。
 */
import { readFileSync } from 'fs';
import { Connection } from '@solana/web3.js';

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const SIGS = process.argv[2].split(',').filter(Boolean);
const REQS = Number(process.argv[3] ?? 60);
const CONC = Number(process.argv[4] ?? 6);

const urls = Object.keys(process.env)
  .filter((k) => /^SOLANA_RPC_\d+$/.test(k))
  .sort()
  .map((k) => ({ name: k, url: process.env[k]! }));

const stat = new Map<string, { ok: number; rate: number; other: number; ms: number[] }>();
for (const { url } of urls) stat.set(url, { ok: 0, rate: 0, other: 0, ms: [] });

const conns = new Map(urls.map((u) => [u.url, new Connection(u.url, 'confirmed')]));

let cursor = 0;
let done = 0;
const t0 = Date.now();

async function worker() {
  for (;;) {
    const i = cursor++;
    if (i >= REQS) return;
    const url = urls[i % urls.length].url;
    const sig = SIGS[i % SIGS.length];
    const s = stat.get(url)!;
    const t = Date.now();
    try {
      await conns.get(url)!.getTransaction(sig, { maxSupportedTransactionVersion: 1 });
      s.ok++;
      s.ms.push(Date.now() - t);
    } catch (e: any) {
      const m = String(e?.message ?? '');
      if (/\b(429|503)\b/.test(m) || e?.status === 429) s.rate++;
      else s.other++;
    }
    done++;
  }
}

async function main() {
  await Promise.all(Array.from({ length: CONC }, () => worker()));
  const elapsed = (Date.now() - t0) / 1000;

  console.log(`并发 ${CONC}，共 ${done} 次 getTransaction，用时 ${elapsed.toFixed(1)}s，` +
    `实际 ${(done / elapsed).toFixed(1)} QPS\n`);

  let allOk = 0, allRate = 0, allOther = 0;
  for (const { name, url } of urls) {
    const s = stat.get(url)!;
    allOk += s.ok; allRate += s.rate; allOther += s.other;
    const total = s.ok + s.rate + s.other;
    if (total === 0) { console.log(`${name.padEnd(13)} 无请求`); continue; }
    const p50 = s.ms.length ? [...s.ms].sort((a, b) => a - b)[Math.floor(s.ms.length / 2)] : 0;
    console.log(
      `${name.padEnd(13)} 成功 ${String(s.ok).padStart(3)}  429 ${String(s.rate).padStart(3)}` +
      `  其他错 ${String(s.other).padStart(3)}  成功率 ${((s.ok / total) * 100).toFixed(0).padStart(3)}%` +
      `  p50 ${p50}ms  ${new URL(url).host}`,
    );
  }
  const tot = allOk + allRate + allOther;
  console.log(`\n合计：成功率 ${((allOk / tot) * 100).toFixed(1)}%，` +
    `429 占 ${((allRate / tot) * 100).toFixed(1)}%，其他错 ${((allOther / tot) * 100).toFixed(1)}%`);
}

main();
