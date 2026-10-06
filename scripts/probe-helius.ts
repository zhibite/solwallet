/**
 * 测 Helius key 现在还能不能用。
 *
 * 为什么现在测：回归默认走免费公共 RPC（PNL_TX_SOURCE 没配，默认 rpc），
 * 持续压到一定量就被限流，一行要 5 分钟。而基准数据本来就是 Helius 时期算的，
 * 用 Helius 跑才是同源对比。所以要先确认这个 key 还有没有配额，
 * 以及它支不支持 until 翻页（免费节点里只有 2/6 支持，Helius 底层是完整节点，
 * 理论上支持，但必须实测）。
 */
import { readFileSync } from 'fs';
import { Connection, PublicKey } from '@solana/web3.js';

for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

const key = process.env.HELIUS_API_KEY!;
const wallet = process.argv[2];
const buySig = process.argv[3];

async function main() {
  const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${key}`, 'confirmed');

  // 1) 连通性
  try {
    console.log(`getSlot = ${await conn.getSlot()}`);
  } catch (e: any) {
    console.log(`getSlot 失败: ${(e.message ?? String(e)).slice(0, 120)}`);
    return;
  }

  if (!wallet || !buySig) { console.log('（没给钱包/买入签名，跳过后续）'); return; }
  const addr = new PublicKey(wallet);

  // 2) 普通翻页
  try {
    const sigs = await conn.getSignaturesForAddress(addr, { limit: 1000 });
    console.log(`普通翻页 = ${sigs.length} 笔`);
  } catch (e: any) {
    console.log(`普通翻页失败: ${(e.message ?? String(e)).slice(0, 120)}`);
  }

  // 3) until 锚定翻页 —— 回归能否跑完取决于这个
  try {
    const t0 = Date.now();
    const sigs = await conn.getSignaturesForAddress(addr, { limit: 1000, until: buySig });
    console.log(`until 翻页 = ${sigs.length} 笔，用时 ${Date.now() - t0}ms`);
  } catch (e: any) {
    console.log(`until 翻页失败: ${(e.message ?? String(e)).slice(0, 120)}`);
  }

  // 4) getTransaction（archive 覆盖：Helius 是付费归档级，预期比免费节点好）
  let hit = 0, miss = 0;
  try {
    const sigs = await conn.getSignaturesForAddress(addr, { limit: 40 });
    for (const s of sigs) {
      const t = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1 });
      if (t) hit++; else miss++;
    }
    console.log(`getTransaction 连测 40 笔：拿到 ${hit}，null ${miss}`);
  } catch (e: any) {
    console.log(`getTransaction 失败: ${(e.message ?? String(e)).slice(0, 120)}`);
  }

  // 5) Parsed Events API（10 credits / request；Enhanced Transactions 已废弃）
  //    路径在 mainnet.helius-rpc.com 域下，/v1/parsed-events/transactions，
  //    不是旧的 api.helius.xyz/v0/addresses/{wallet}/transactions 那个 100 cr 接口。
  //    src/lib/helius.ts 的 parseEvents 走的就是这个端点。
  try {
    const r = await fetch(`https://mainnet.helius-rpc.com/v1/parsed-events/transactions?api-key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transactions: buySig ? [buySig] : [],
        includeRawTransaction: true,
      }),
    });
    const j: any = await r.json();
    if (Array.isArray(j)) {
      const ok = j.filter((x: any) => x?.parserStatus === 'OK').length;
      console.log(`Parsed Events = HTTP ${r.status}, 返回 ${j.length} 条（OK ${ok}）`);
    } else {
      console.log(`Parsed Events 响应异常: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    }
  } catch (e: any) {
    console.log(`Parsed Events 失败: ${(e.message ?? String(e)).slice(0, 120)}`);
  }
}

main();
