// scripts/test-tip-decode.ts
// 验证 fix：从 RPC 原始 block 解出 first_sniper 的 tip/prio
import { getMultiRpc } from '../src/lib/multi-rpc';
import { parseBlockTxs, solanaTxToHeliusEnhanced, calcJitoTip, calcPriorityFee } from '../src/lib/parser';
import { query, pool } from '../src/lib/db';
import { getHelius } from '../src/lib/helius';

const JITO_TIP_ACCOUNTS = new Set([
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
]);

async function main() {
  const rpc = getMultiRpc();
  const txs = await query<any>(`
    SELECT slot, signature, mint, first_sniper_signature
    FROM target_trades
    WHERE first_sniper_signature IS NOT NULL
    ORDER BY block_time DESC
    LIMIT 3
  `);
  console.log(`找到 ${txs.length} 笔最新有 first_sniper 的 target_trades\n`);

  for (const t of txs) {
    const slotNum = Number(t.slot);
    const sniperSig: string = t.first_sniper_signature;
    console.log(`--- slot=${slotNum} mint=${t.mint.slice(0,8)} sniper=${sniperSig.slice(0,12)} ---`);

    let block: any = null;
    try {
      block = await rpc.getBlock(slotNum, { transactionDetails: 'full' });
    } catch (e: any) {
      console.log(`  getBlock 失败: ${(e as Error).message}`);
      continue;
    }
    if (!block) { console.log('  block is null'); continue; }

    const sniperWrapper = block.transactions.find((w: any) => w.transaction?.signatures?.[0] === sniperSig);
    if (!sniperWrapper) { console.log('  sniper tx 不在这个 block 里'); continue; }

    // 1) Helius Enhanced（如果 429 就跳过）
    let heliusTip = 0, heliusPrio = 0;
    try {
      const enhanced = await getHelius().parseTransaction(sniperSig);
      if (enhanced) {
        heliusTip = parseFloat(enhanced.tipSol ?? '0');
        heliusPrio = enhanced.prioLamports ?? 0;
        console.log(`  [Helius Enhanced] tip=${heliusTip} prio=${heliusPrio}`);
      }
    } catch (e: any) {
      console.log(`  [Helius Enhanced] 失败: ${e.message?.slice(0,60)}`);
    }

    // 2) parseBlockTxs 返回的 tipSol（fix 后走 solanaTxToHeliusEnhanced）
    const parsed = parseBlockTxs(block, t.mint);
    const sniperParsed = parsed.find((p) => p.signature === sniperSig);

    // 3) 直接走 solanaTxToHeliusEnhanced
    const enhanced = solanaTxToHeliusEnhanced({
      slot: slotNum,
      blockTime: block.blockTime ?? 0,
      transaction: sniperWrapper.transaction,
      meta: sniperWrapper.meta,
    } as any);
    const directTip = enhanced ? calcJitoTip(enhanced) : 0;
    const directPrio = enhanced ? calcPriorityFee(enhanced) : 0;

    console.log(`  [fix 后 parseBlockTxs]       tip=${sniperParsed?.tipSol}  prio=${sniperParsed?.prioLamports}  buy=${sniperParsed?.buySol}`);
    console.log(`  [直接 solanaTxToHeliusEnhanced] tip=${directTip}  prio=${directPrio}`);
    console.log(`  meta.fee = ${sniperWrapper.meta?.fee}`);

    if (enhanced?.nativeTransfers) {
      const jitoOnes = enhanced.nativeTransfers.filter((nt: any) => JITO_TIP_ACCOUNTS.has(nt.toUserAccount));
      console.log(`  nativeTransfers 总 ${enhanced.nativeTransfers.length} 条，其中 jito tip ${jitoOnes.length} 条`);
      for (const nt of jitoOnes) {
        const lamports = typeof nt.amount === 'string' ? Number(nt.amount) : nt.amount;
        console.log(`    JITO  ${nt.fromUserAccount.slice(0,8)} → ${nt.toUserAccount.slice(0,8)}  ${lamports} lamports (${lamports / 1e9} SOL)`);
      }
    }
    console.log();
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
