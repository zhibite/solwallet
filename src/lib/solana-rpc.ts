/**
 * Solana RPC 客户端（统一入口）
 * 优先使用 Helius RPC（含 API key 的高质量端点）
 * 限流时在 Helius 上指数退避重试，不盲目把请求打到免费端点（免费端点扛不住批量回填的压力）
 */

import { Connection, PublicKey, Commitment, BlockResponse, TransactionResponse } from '@solana/web3.js';
import { getMultiRpc } from './multi-rpc';

const HELIUS_RPCS = (process.env.SOLANA_RPCS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.includes('helius') || s.includes('alchemy') || s.includes('quicknode'));

function isRateLimit(err: any): boolean {
  const m = String(err?.message ?? '');
  const s = err?.status ?? err?.response?.status;
  return s === 429 || s === 503 || /\b(429|503)\b/.test(m);
}

function isNetworkError(err: any): boolean {
  const m = String(err?.message ?? '');
  return /timeout|fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(m);
}

class SolanaRPC {
  private heliusConn: Connection | null = null;
  private multiRpc = getMultiRpc();

  constructor() {
    if (HELIUS_RPCS.length > 0) {
      this.heliusConn = new Connection(HELIUS_RPCS[0], {
        commitment: 'confirmed',
        // 关闭 Connection 内置 retry，由我们在 rpc() 里统一控制指数退避
        disableRetryOnRateLimit: true,
      } as any);
    }
  }

  /**
   * Helius 优先，限流时在 Helius 上退避重试（最多 MAX_RETRIES 次）。
   * 不走 free RPC fallback——free 端点对批量回填完全扛不住，fallback 只会让情况更糟。
   * 429 超限后的处理由调用方（backfill 脚本的 circuit breaker）负责。
   */
  async rpc<T = any>(method: string, params: any[], _cacheMs = 0): Promise<T> {
    if (!this.heliusConn) {
      // 非 Helius 环境（如本地测试）：走 free pool
      return this.multiRpc.rpc<T>(method, params);
    }

    const MAX_RETRIES = 5; // 500ms → 1s → 2s → 4s → 8s ≈ 15.5s 最大等待
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.callMethod(this.heliusConn, method, params) as T;
      } catch (err: any) {
        const ratelimit = isRateLimit(err);
        const netErr = isNetworkError(err);
        if (attempt < MAX_RETRIES - 1 && (ratelimit || netErr)) {
          // 指数退避（不套 Connection 内置 retry，因为 disableRetryOnRateLimit: true）
          const backoffMs = Math.min(500 * Math.pow(2, attempt), 8000);
          console.warn(`[rpc] helius ${method} 失败 (${ratelimit ? '429' : 'net'}), ${backoffMs}ms 后重试`);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        // 耗尽，或非 retryable 错误：直接抛
        throw err;
      }
    }
    throw new Error(`[rpc] helius ${method} 重试耗尽`);
  }

  private async callMethod(conn: Connection, method: string, params: any[]): Promise<any> {
    switch (method) {
      case 'getBlock':
        return conn.getBlock(params[0], params[1] ?? { maxSupportedTransactionVersion: 1 });
      case 'getTransaction':
        return conn.getTransaction(params[0], params[1] ?? { maxSupportedTransactionVersion: 1 });
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
    return this.rpc<BlockResponse | null>('getBlock', [slot, { maxSupportedTransactionVersion: 1, ...opts }]);
  }

  async getTransaction(signature: string): Promise<TransactionResponse | null> {
    return this.rpc<TransactionResponse | null>('getTransaction', [signature, { maxSupportedTransactionVersion: 1 }]);
  }

  async getSignaturesForAddress(address: string, limit = 100, before?: string): Promise<any[]> {
    return this.rpc<any[]>('getSignaturesForAddress', [address, { limit, ...(before ? { before } : {}) }]);
  }

  async getSlot(): Promise<number> {
    return this.rpc<number>('getSlot', []);
  }

  /** 查看端点状态（debug 用） */
  getStatus() {
    return this.multiRpc.getStatus();
  }
}

let _rpc: SolanaRPC | null = null;
export function getRPC(): SolanaRPC {
  if (!_rpc) _rpc = new SolanaRPC();
  return _rpc;
}
