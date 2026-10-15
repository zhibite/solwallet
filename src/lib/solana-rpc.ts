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
        return conn.getSlot((params[0] ?? 'confirmed') as Commitment);
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

  /**
   * 取当前 slot（默认 commitment='confirmed'，跟 analyzeBlock 的等待语义一致）。
   * 显式指定 commitment 让 first-sniper 的"链头已推进"判断与业务保持一致。
   */
  async getSlot(_commitment: Commitment = 'confirmed'): Promise<number> {
    return this.rpc<number>('getSlot', [_commitment]);
  }

  /**
   * 订阅 slotUpdates 推送 —— 链头每推进一个 slot，回调收到
   * `{ slot, parent, root }`。返回 subscriptionId，调用方负责 removeSlotChangeListener
   * 取消订阅避免泄漏。
   *
   * 用于 first-sniper 等「等链头追到目标 slot 再 getBlock」的事件驱动场景，
   * 比按 200ms 节奏轮询 getSlot 省一次 socket IO。
   *
   * 关键：必须传 `commitment='confirmed'`，否则 web3.js 默认是 `finalized`，
   * 通知会延迟到 slot finalized（~12-15s 后），`waitForSlotConfirmed` 的 3s
   * 超时必触发，slow path 完全失效。
   *
   * 必须有 Helius 连接：当前 free RPC 池没暴露 Connection 句柄，后续需要的话
   * 再说 —— 99% 运行时都有 helius 配置。
   */
  async onSlotChange(
    callback: (slotInfo: { slot: number; parent: number | null; root: number }) => void,
  ): Promise<number> {
    if (!this.heliusConn) {
      throw new Error('[rpc] onSlotChange: helius connection unavailable');
    }
    // 第二参数 commitment 在 web3.js 1.95+ 可用；通过 as any 兼容旧类型定义
    return (this.heliusConn as any).onSlotChange(callback, 'confirmed');
  }

  /**
   * 等目标 slot 进入 confirmed 状态后 resolve。
   *
   * 策略：
   *   1) 快速查一次 getSlot（已 confirmed 直接返回，节省一次订阅往返）。
   *   2) 订阅 onSlotChange(commitment='confirmed')，callback 内 slotInfo.slot >= targetSlot
   *      就 resolve 并立刻取消订阅，避免 Helius WS 长挂。
   *   3) timeoutMs 超时兜底：返回 timedOut=true，让上层继续走原本的 getBlock 重试路径。
   *
   * 没有 Helius 连接时退化为 150ms 节奏轮询 getSlot（仅本地测试用，生产环境都走 Helius）。
   */
  async waitForSlotConfirmed(
    targetSlot: number,
    timeoutMs = 3000,
  ): Promise<{ confirmed: boolean; timedOut: boolean }> {
    if (timeoutMs <= 0) return { confirmed: false, timedOut: true };

    // 1) 快路径
    try {
      const cur = await this.getSlot();
      if (cur >= targetSlot) return { confirmed: true, timedOut: false };
    } catch {
      // getSlot 失败不致命
    }

    // 2) 没有 Helius：轮询兜底
    const conn = this.heliusConn;
    if (!conn) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          const cur = await this.getSlot();
          if (cur >= targetSlot) return { confirmed: true, timedOut: false };
        } catch {
          // 忽略
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      return { confirmed: false, timedOut: true };
    }

    // 3) 订阅路径
    return new Promise((resolve) => {
      let resolved = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let subId: number | null = null;
      const safeConn = conn!;

      const cleanup = (timedOut: boolean) => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (subId !== null) {
          safeConn.removeSlotChangeListener(subId).catch(() => {});
          subId = null;
        }
        resolve({ confirmed: !timedOut, timedOut });
      };

      timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        cleanup(true);
      }, timeoutMs);

      this.onSlotChange((slotInfo) => {
        if (resolved) return;
        if (slotInfo.slot >= targetSlot) {
          resolved = true;
          cleanup(false);
        }
      })
        .then((id) => {
          if (resolved) {
            // 超时先 fire，立刻撤销本次订阅避免泄漏
            safeConn.removeSlotChangeListener(id).catch(() => {});
          } else {
            subId = id;
          }
        })
        .catch((err: any) => {
          // 订阅失败：打日志让生产环境可排查
          console.warn(
            `[rpc] waitForSlotConfirmed(${targetSlot}) subscribe failed: ${err?.message ?? err}`,
          );
          if (!resolved) {
            resolved = true;
            cleanup(true);
          }
        });
    });
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
