// scripts/test-tip-decode.ts
// 验证 fix：从 RPC 原始 block 解出 first_sniper 的 tip/prio
import { getMultiRpc } from '../src/lib/multi-rpc';
import {
  parseBlockTxs,
  solanaTxToHeliusEnhanced,
  calcSolanaTip,
  calcPriorityFee,
  parseHeliusTx,
  SOLANA_TIP_ACCOUNTS,
  SOLANA_TIP_SOURCE_MAP,
  getTipSource,
} from '../src/lib/parser';
import { query, pool } from '../src/lib/db';
import { getHelius } from '../src/lib/helius';

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
      // getBlock 只接收 slot 一个参数（multi-rpc 内部已固定 transactionDetails/transactionDetails='full' + maxSupportedTransactionVersion=1）
      block = await rpc.getBlock(slotNum);
    } catch (e: any) {
      console.log(`  getBlock 失败: ${(e as Error).message}`);
      continue;
    }
    if (!block) { console.log('  block is null'); continue; }

    const sniperWrapper = block.transactions.find((w: any) => w.transaction?.signatures?.[0] === sniperSig);
    if (!sniperWrapper) { console.log('  sniper tx 不在这个 block 里'); continue; }

    // 1) Helius Enhanced（如果 429 就跳过）
    let heliusTip = 0, heliusPrio = 0, heliusSource: string | null = null;
    try {
      const enhanced = await getHelius().parseEvent(sniperSig);
      if (enhanced) {
        // parseEvent 返回 HeliusEnhancedTx（fee / nativeTransfers 等），不直接含 tipSol/prioLamports
        // 走 parseHeliusTx 拿标准 ParsedBuy（含 tip / prio / tipSource）
        const parsed = parseHeliusTx(enhanced);
        if (parsed) {
          heliusTip = parsed.tipSol;
          heliusPrio = parsed.prioLamports;
          heliusSource = parsed.tipSource;
        }
        console.log(`  [Helius Enhanced] tip=${heliusTip} prio=${heliusPrio} source=${heliusSource ?? 'null'}`);
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
    const directTip = enhanced ? calcSolanaTip(enhanced) : 0;
    const directPrio = enhanced ? calcPriorityFee(enhanced) : 0;

    console.log(`  [fix 后 parseBlockTxs]       tip=${sniperParsed?.tipSol}  prio=${sniperParsed?.prioLamports}  buy=${sniperParsed?.buySol}`);
    console.log(`  [直接 solanaTxToHeliusEnhanced] tip=${directTip}  prio=${directPrio}`);
    console.log(`  meta.fee = ${sniperWrapper.meta?.fee}`);

    if (enhanced?.nativeTransfers) {
      const jitoOnes = enhanced.nativeTransfers.filter((nt: any) => SOLANA_TIP_ACCOUNTS.has(nt.toUserAccount));
      console.log(`  nativeTransfers 总 ${enhanced.nativeTransfers.length} 条，其中任意 tip channel ${jitoOnes.length} 条`);
      for (const nt of jitoOnes) {
        const lamports = typeof nt.amount === 'string' ? Number(nt.amount) : nt.amount;
        const src = getTipSource(nt.toUserAccount) ?? 'unknown';
        console.log(
          `    ${src.padEnd(11)}  ${nt.fromUserAccount.slice(0,8)} → ${nt.toUserAccount.slice(0,8)}  ${lamports} lamports (${lamports / 1e9} SOL)`,
        );
      }
      console.log(`  SOLANA_TIP_SOURCE_MAP 总条数 = ${Object.keys(SOLANA_TIP_SOURCE_MAP).length}`);
    }
    console.log();
  }

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
