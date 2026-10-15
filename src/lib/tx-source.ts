






































import type { TransactionResponse } from '@solana/web3.js';
import type { HeliusEnhancedTx } from './types';
import { getMultiRpc } from './multi-rpc';
import { solanaTxToHeliusEnhanced, inboundTokenAmount, outboundTokenAmount } from './parser';










export function isFailedTx(tx: HeliusEnhancedTx | null | undefined): boolean {
  if (!tx) return false;
  if (tx.transactionError) return true;
  return !!(tx.events?.swap?.error);
}


export interface TxView {
  signature: string;
  slot: number;
  blockTime: number;
  
  feeLamports: number;
  
  failed: boolean;
  



  tokenDelta(mint: string, wallet: string): number;
  



  solNet(wallet: string): number;
  
  raw: HeliusEnhancedTx;
}






function accountKeysOf(tx: TransactionResponse): string[] {
  const msg: any = (tx as any).transaction?.message;
  const raw: any[] = msg?.staticAccountKeys ?? msg?.accountKeys ?? [];
  return raw.map((k: any) => (typeof k === 'string' ? k : (k?.toBase58?.() ?? String(k))));
}


export function rpcTxView(tx: TransactionResponse | null): TxView | null {
  if (!tx || !(tx as any).transaction) return null;
  const meta: any = tx.meta;
  if (!meta) return null;

  const keys = accountKeysOf(tx);
  if (keys.length === 0) return null;
  const feePayer = keys[0];
  const fee: number = meta.fee ?? 0;
  const preSol: number[] = meta.preBalances ?? [];
  const postSol: number[] = meta.postBalances ?? [];
  const preTok: any[] = meta.preTokenBalances ?? [];
  const postTok: any[] = meta.postTokenBalances ?? [];

  
  const preTokMap = new Map<string, number>();
  for (const b of preTok) {
    preTokMap.set(`${b.accountIndex}-${b.mint}`, Number(b.uiTokenAmount?.amount ?? 0));
  }

  const idxCache = new Map<string, number>();
  const indexOf = (wallet: string): number => {
    let i = idxCache.get(wallet);
    if (i === undefined) {
      i = keys.indexOf(wallet);
      idxCache.set(wallet, i);
    }
    return i;
  };

  
  const raw = solanaTxToHeliusEnhanced(tx) as HeliusEnhancedTx;

  return {
    signature: (tx as any).transaction.signatures?.[0] ?? '',
    slot: tx.slot,
    blockTime: tx.blockTime ?? 0,
    feeLamports: fee,
    failed: meta.err != null,
    tokenDelta(mint: string, wallet: string): number {
      let sum = 0;
      for (const po of postTok) {
        if (po.mint !== mint) continue;
        
        if (po.owner !== wallet) continue;
        const pre = preTokMap.get(`${po.accountIndex}-${po.mint}`) ?? 0;
        sum += Number(po.uiTokenAmount?.amount ?? 0) - pre;
      }
      return sum;
    },
    solNet(wallet: string): number {
      const i = indexOf(wallet);
      if (i < 0 || i >= preSol.length || i >= postSol.length) return 0;
      const d = postSol[i] - preSol[i];
      
      
      return (d - (i === 0 ? fee : 0)) / 1e9;
    },
    raw: raw ?? ({ signature: '', instructions: [] } as unknown as HeliusEnhancedTx),
  };
}














function ownersOf(tx: HeliusEnhancedTx, wallet: string): string[] {
  return [wallet];
}

export function heliusTxView(tx: HeliusEnhancedTx | null): TxView | null {
  if (!tx) return null;
  const txAny = tx as any;
  return {
    signature: tx.signature,
    
    
    slot: txAny.data?.slot ?? txAny.slot ?? 0,
    blockTime: txAny.data?.blockTime ?? txAny.blockTime ?? 0,
    feeLamports: tx.fee ?? 0,
    failed: isFailedTx(tx),
    tokenDelta(mint: string, wallet: string): number {
      return inboundTokenAmount(tx, mint, wallet) - outboundTokenAmount(tx, mint, wallet);
    },
        solNet(wallet: string): number {
      
      
      
      
      const ad = (tx as any).accountData;
      if (Array.isArray(ad)) {
        const me = ad.find((a: any) => a?.account === wallet);
        if (me && typeof me.nativeBalanceChange === 'number') {
          
          const isPayer = (tx as any).feePayer === wallet;
          return (me.nativeBalanceChange - (isPayer ? (tx.fee ?? 0) : 0)) / 1e9;
        }
      }
      
      const owners = ownersOf(tx, wallet);
      let solIn = 0;
      let solOut = 0;
      for (const t of tx.nativeTransfers ?? []) {
        if (t.fromUserAccount === t.toUserAccount) continue; 
        const amt = Number(t.amount);
        if (owners.includes(t.toUserAccount)) solIn += amt;
        if (owners.includes(t.fromUserAccount)) solOut += amt;
      }
      return (solIn - solOut) / 1e9;
    },
    raw: tx,
  };
}





export type TxSourceKind = 'rpc' | 'helius' | 'auto';

function configuredSource(): TxSourceKind {
  const v = (process.env.PNL_TX_SOURCE ?? 'rpc').toLowerCase();
  return v === 'helius' || v === 'auto' ? v : 'rpc';
}

let _kind: TxSourceKind | null = null;
let _heliusDead = false;   

export function activeSource(): TxSourceKind {
  if (_kind) return _kind;
  _kind = configuredSource();
  if (_kind === 'helius' && !process.env.HELIUS_API_KEY) _kind = 'rpc';
  return _kind;
}


export function sourceStatus(): { configured: TxSourceKind; active: TxSourceKind; heliusDead: boolean } {
  return { configured: configuredSource(), active: activeSource(), heliusDead: _heliusDead };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


function fetchConcurrency(): number {
  const v = parseInt(process.env.PNL_FETCH_CONCURRENCY ?? '', 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 12) : 6;
}







export async function fetchTxViews(
  sigs: string[],
  wallet: string,
): Promise<Array<TxView | null>> {
  if (sigs.length === 0) return [];

  
  if (activeSource() === 'helius' || (activeSource() === 'auto' && !_heliusDead)) {
    try {
      const { getHelius } = await import('./helius');
      const txMap = await getHelius().batchFetchEnhanced(sigs);
      return sigs.map((s) => heliusTxView(txMap.get(s) ?? null));
    } catch (err: any) {
      const status = err?.response?.status ?? err?.status;
      if (status === 429 || /max usage|quota|rate/i.test(err?.message ?? '')) {
        console.warn('[tx-source] Helius RPC');
        _heliusDead = true;
      } else if (activeSource() === 'helius') {
        
        console.warn('[tx-source] Helius Enhanced RPC:', (err as Error).message);
        _heliusDead = true;
      } else {
        
        console.warn('[tx-source] Helius Enhanced RPC:', (err as Error).message);
        _heliusDead = true;
      }
    }
  }

  
  const rpc = getMultiRpc();
  const out: Array<TxView | null> = new Array(sigs.length).fill(null);
  const conc = fetchConcurrency();
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= sigs.length) return;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const tx = await rpc.getTransaction(sigs[i]);
          out[i] = rpcTxView(tx);
          break;
        } catch (err: any) {
          const msg = err?.message ?? String(err);
          const retriable = /429|503|502|504|timeout|socket|ECONN/i.test(msg);
          if (!retriable || attempt === 2) {
            if (attempt === 2) console.warn(`[tx-source] ${sigs[i].slice(0, 12)} ${msg.slice(0, 100)}`);
            break;
          }
          await sleep(500 * (attempt + 1));
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(conc, sigs.length) }, () => worker()));
  return out;
}





export interface SigInfo {
  signature: string;
  slot: number;
  blockTime: number;
  err: any | null;
}

const SIG_PAGE_SIZE = 1000;
const MAX_SIG_PAGES = 20;   







const sigCache = new Map<string, SigInfo[]>();
const SIG_CACHE_MAX = 200;

function cacheKey(address: string, fromSig: string): string {
  return `${address}|${fromSig}`;
}

function rememberSigs(key: string, sigs: SigInfo[]): void {
  
  while (sigCache.size >= SIG_CACHE_MAX) {
    const oldest = sigCache.keys().next().value;
    if (oldest === undefined) break;
    sigCache.delete(oldest);
  }
  sigCache.set(key, sigs);
}

export function clearSigCache(): void {
  sigCache.clear();
}


























export async function fetchSigsFrom(address: string, fromSig: string): Promise<SigInfo[]> {
  const key = cacheKey(address, fromSig);
  const cached = sigCache.get(key);
  if (cached) return cached;

  const rpc = getMultiRpc();
  const collected: SigInfo[] = [];   
  let before: string | undefined;

  for (let i = 0; i < MAX_SIG_PAGES; i++) {
    let batch: SigInfo[];
    try {
      batch = await rpc.getSignaturesForAddress(address, SIG_PAGE_SIZE, before, fromSig);
    } catch (err: any) {
      
      
      
      if (collected.length > 0) {
        console.warn(
          `[tx-source] ${address.slice(0, 8)}${collected.length} : ` +
          String(err?.message ?? err).slice(0, 80),
        );
        break;
      }
      throw err;
    }
    if (!batch || batch.length === 0) break;
    collected.push(...batch);
    if (batch.length < SIG_PAGE_SIZE) break;
    before = batch[batch.length - 1].signature;
  }

  const result = collected.reverse();
  rememberSigs(key, result);
  return result;
}
