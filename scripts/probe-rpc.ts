/**
 * 逐个端点探一遍，把真实错误打出来。
 *
 * 为什么需要：熔断日志只说 fails=5，不说是哪一类错。429 和「节点根本不认这个
 * 方法」都会走到熔断，但处理方式完全相反 —— 前者降配额，后者换端点。
 * 混在一起看日志会误判成限流。
 */
import { readFileSync } from 'fs';
import { Connection, PublicKey } from '@solana/web3.js';

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const wallet = process.argv[2] ?? '';
const until = process.argv[3] ?? '';

async function probe(name: string, url: string) {
  const conn = new Connection(url, 'confirmed');
  const host = new URL(url).host;
  const out: string[] = [];

  try {
    out.push(`slot=${await conn.getSlot()}`);
  } catch (e: any) {
    out.push(`getSlot失败:${(e.message ?? String(e)).slice(0, 55)}`);
  }

  if (wallet) {
    const key = new PublicKey(wallet);
    // 回归依赖的两个翻页形态：普通翻页 + until 锚定翻页
    try {
      const sigs = await conn.getSignaturesForAddress(key, { limit: 1000 });
      out.push(`翻页=${sigs.length}`);
    } catch (e: any) {
      out.push(`翻页失败:${(e.message ?? String(e)).slice(0, 55)}`);
    }
    if (until) {
      try {
        const sigs = await conn.getSignaturesForAddress(key, { limit: 1000, until });
        out.push(`until=${sigs.length}`);
      } catch (e: any) {
        out.push(`until失败:${(e.message ?? String(e)).slice(0, 55)}`);
      }
    }
    // getTransaction 是最贵的一类调用，也是最容易被限的
    try {
      const sigs = await conn.getSignaturesForAddress(key, { limit: 1 });
      if (sigs.length > 0) {
        const t = await conn.getTransaction(sigs[0].signature, { maxSupportedTransactionVersion: 1 });
        out.push(`getTx=${t ? 'ok' : 'null'}`);
      } else {
        out.push('getTx=无签名');
      }
    } catch (e: any) {
      out.push(`getTx失败:${(e.message ?? String(e)).slice(0, 55)}`);
    }
  }

  console.log(`${name.padEnd(13)} ${host.padEnd(32)} ${out.join(' | ')}`);
}

async function main() {
  const eps = Object.keys(process.env)
    .filter((k) => /^SOLANA_RPC_\d+$/.test(k))
    .sort()
    .map((k) => ({ name: k, url: process.env[k]! }));

  for (const { name, url } of eps) await probe(name, url);
}

main();
