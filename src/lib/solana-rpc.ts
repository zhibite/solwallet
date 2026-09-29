/**
 * Solana RPC 客户端（统一入口）
 * 优先使用 Helius RPC（含 API key 的高质量端点）
 * 自动 fallback 到多免费 RPC 源轮询
 */

import { Connection, PublicKey, Commitment, BlockResponse, TransactionResponse } from '@solana/web3.js';
import { getMultiRpc, MultiFreeRpc } from './multi-rpc';

const HELIUS_RPCS = (process.env.SOLANA_RPCS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.includes('helius') || s.includes('alchemy') || s.includes('quicknode'));

const FREE_RPCS = (process.env.SOLANA_RPCS ?? MultiFreeRpc.defaultEndpoints().join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

class SolanaRPC {
  private heliusConn: Connection | null = null;
  private multiRpc = getMultiRpc();

  constructor() {
    if (HELIUS_RPCS.length > 0) {
      this.heliusConn = new Connection(HELIUS_RPCS[0], 'confirmed' as Commitment);
    }
  }

  /** 智能 RPC 调用：付费端点优先，免费端点 fallback */
  async rpc<T = any>(method: string, params: any[], cacheMs = 0): Promise<T> {
    // 付费端点
    if (this.heliusConn) {
      try {
        const result = await this.callMethod(this.heliusConn, method, params);
        return result as T;
      } catch (err: any) {
        // 429 / 503 fallback
        if (err.message?.includes('429') || err.message?.includes('503')) {
          console.warn('[rpc] helius 限速，切换到免费源');
        } else {
          // 其他错误也 fallback（防止单点故障）
          console.warn('[rpc] helius 错误，fallback:', err.message);
        }
      }
    }
    // 免费源轮询
    return this.multiRpc.rpc<T>(method, params, cacheMs);
  }

  private async callMethod(conn: Connection, method: string, params: any[]): Promise<any> {
    switch (method) {
      case 'getBlock':
        return conn.getBlock(params[0], params[1] ?? { maxSupportedTransactionVersion: 0 });
      case 'getTransaction':
        return conn.getTransaction(params[0], params[1] ?? { maxSupportedTransactionVersion: 0 });
      case 'getSignaturesForAddress':
        return conn.getSignaturesForAddress(new PublicKey(params[0]), params[1] ?? { limit: 100 });
      case 'getSlot':
        return conn.getSlot();
      case 'getBlockHeight':
        return conn.getBlockHeight();
      default:
        throw new Error(`Unsupported RPC method: ${method}`);
    }
  }

  async getBlock(slot: number, opts: { transactionDetails?: 'full' | 'signatures' | 'none' } = {}): Promise<BlockResponse | null> {
    return this.rpc('getBlock', [slot, { maxSupportedTransactionVersion: 0, ...opts }], 30_000);
  }

  async getTransaction(signature: string): Promise<TransactionResponse | null> {
    return this.rpc('getTransaction', [signature, { maxSupportedTransactionVersion: 0 }], 5 * 60_000);
  }

  async getSignaturesForAddress(address: string, limit = 100): Promise<any[]> {
    return this.rpc('getSignaturesForAddress', [address, { limit }], 5_000);
  }

  async getSlot(): Promise<number> {
    return this.rpc('getSlot', []);
  }

  /** 查看端点状态 */
  getStatus() {
    return this.multiRpc.getStatus();
  }
}

let _rpc: SolanaRPC | null = null;
export function getRPC(): SolanaRPC {
  if (!_rpc) _rpc = new SolanaRPC();
  return _rpc;
}
