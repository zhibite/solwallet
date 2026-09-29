/**
 * 多免费 RPC 源轮询客户端
 * 策略：
 * 1) 健康检查：定期探测，自动剔除失败的端点
 * 2) 权重轮询：根据历史成功率分配请求权重
 * 3) 速率限制：每个端点独立的令牌桶
 * 4) 熔断器：连续失败 N 次暂停该端点 X 秒
 * 5) Redis 缓存：相同 slot/signature 的请求短时间合并
 */

import { Connection, PublicKey, Commitment, BlockResponse, TransactionResponse } from '@solana/web3.js';
import { Cache, cacheKeys } from './cache';

export interface RpcEndpoint {
  url: string;
  weight: number;             // 基础权重 1-10
  rps: number;                // 估计的每秒请求上限
  fails: number;              // 连续失败计数
  circuitOpenUntil: number;   // 熔断截止时间戳 (ms)
  totalRequests: number;
  totalFails: number;
  // 新增：响应时间统计
  responseTimes: number[];    // 最近 100 次的响应时间 (ms)
  lastError: string;
}

export class MultiFreeRpc {
  private endpoints: RpcEndpoint[];
  private buckets = new Map<string, { tokens: number; lastRefill: number }>();
  private pendingRequests = new Map<string, Promise<any>>();
  private healthCheckTimer: NodeJS.Timeout | null = null;

  constructor(urls: string[] = MultiFreeRpc.defaultEndpoints()) {
    this.endpoints = urls.map((url) => ({
      url,
      weight: 5,
      rps: 20,
      fails: 0,
      circuitOpenUntil: 0,
      totalRequests: 0,
      totalFails: 0,
      responseTimes: [],
      lastError: '',
    }));
    this.pendingRequests = new Map();
    this.startHealthCheck();
  }

  static defaultEndpoints(): string[] {
    return [
      'https://api.mainnet-beta.solana.com',
      'https://rpc.ankr.com/solana',
      'https://solana.publicnode.com',
      'https://solana.api.onfinality.io/public',
    ];
  }

  /** 选一个可用端点（按权重，熔断中的跳过） */
  private pick(): RpcEndpoint | null {
    const now = Date.now();
    const available = this.endpoints.filter((e) => e.circuitOpenUntil < now);
    if (available.length === 0) {
      // 全部熔断中，挑失败最少的
      return this.endpoints.sort((a, b) => a.fails - b.fails)[0] ?? null;
    }
    // 加权随机
    const totalWeight = available.reduce((s, e) => s + e.weight, 0);
    let r = Math.random() * totalWeight;
    for (const e of available) {
      r -= e.weight;
      if (r <= 0) return e;
    }
    return available[0];
  }

  /** 令牌桶：每个端点限速 */
  private consumeToken(ep: RpcEndpoint): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(ep.url);
    if (!bucket) {
      bucket = { tokens: ep.rps, lastRefill: now };
      this.buckets.set(ep.url, bucket);
    }
    // 补 token
    const elapsed = (now - bucket.lastRefill) / 1000;
    const refill = elapsed * ep.rps;
    bucket.tokens = Math.min(ep.rps, bucket.tokens + refill);
    bucket.lastRefill = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  /** 记录成功/失败，更新熔断状态 */
  private recordResult(ep: RpcEndpoint, ok: boolean, responseMs = 0, errMsg = '') {
    ep.totalRequests++;
    if (ok) {
      ep.fails = 0;
      ep.weight = Math.min(10, ep.weight + 0.5);
      if (responseMs > 0) {
        ep.responseTimes.push(responseMs);
        if (ep.responseTimes.length > 100) ep.responseTimes.shift();
      }
    } else {
      ep.fails++;
      ep.totalFails++;
      ep.weight = Math.max(1, ep.weight - 1);
      ep.lastError = errMsg.slice(0, 200);
      if (ep.fails >= 5) {
        ep.circuitOpenUntil = Date.now() + 30_000;
        console.warn(`[multi-rpc] circuit open: ${ep.url} (fails=${ep.fails})`);
      }
    }
  }

  /** 计算百分位响应时间 */
  private percentile(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
    return sorted[idx];
  }

  /** 带缓存 + 请求合并的 RPC 调用 */
  async rpc<T>(method: string, params: any[], cacheMs = 0): Promise<T> {
    const cacheKey = this.buildCacheKey(method, params);
    const now = Date.now();

    // 1) Redis/内存缓存命中
    if (cacheMs > 0) {
      const hit = await Cache.get<T>(cacheKey);
      if (hit !== null && hit !== undefined) return hit;
    }

    // 2) 合并相同请求（防止雪崩）
    const pending = this.pendingRequests.get(cacheKey);
    if (pending) return pending as Promise<T>;

    // 3) 执行请求
    const promise = this.execute<T>(method, params).then(async (value) => {
      if (cacheMs > 0 && value !== null && value !== undefined) {
        await Cache.set(cacheKey, value, Math.ceil(cacheMs / 1000));
      }
      this.pendingRequests.delete(cacheKey);
      return value;
    }).catch((err) => {
      this.pendingRequests.delete(cacheKey);
      throw err;
    });
    this.pendingRequests.set(cacheKey, promise);
    return promise;
  }

  private buildCacheKey(method: string, params: any[]): string {
    if (method === 'getBlock') return cacheKeys.block(params[0]);
    if (method === 'getTransaction') return cacheKeys.tx(params[0]);
    if (method === 'getSignaturesForAddress') return cacheKeys.sigs(params[0], params[1]?.before);
    return `${method}:${JSON.stringify(params)}`;
  }

  private async execute<T>(method: string, params: any[]): Promise<T> {
    const tries = Math.min(this.endpoints.length, 3);
    let lastErr: any;

    for (let i = 0; i < tries; i++) {
      const ep = this.pick();
      if (!ep) break;

      if (!this.consumeToken(ep)) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }

      const start = Date.now();
      try {
        const conn = new Connection(ep.url, 'confirmed' as Commitment);
        const result = await this.callMethod(conn, method, params);
        const ms = Date.now() - start;
        this.recordResult(ep, true, ms);
        return result as T;
      } catch (err: any) {
        const ms = Date.now() - start;
        this.recordResult(ep, false, ms, err.message ?? String(err));
        lastErr = err;
        if (err.message?.includes('429') || err.message?.includes('503')) continue;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw lastErr ?? new Error('All RPC endpoints failed');
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
      case 'getMultipleAccounts':
        return conn.getMultipleAccountsInfo(params[0].map((p: string) => new PublicKey(p)));
      default:
        throw new Error(`Unsupported method: ${method}`);
    }
  }

  /** 启动后台健康检查 */
  private startHealthCheck() {
    if (this.healthCheckTimer) return;
    this.healthCheckTimer = setInterval(async () => {
      // 每个端点 ping 一下
      for (const ep of this.endpoints) {
        if (ep.circuitOpenUntil > Date.now()) continue;
        try {
          const conn = new Connection(ep.url, 'confirmed' as Commitment);
          await Promise.race([
            conn.getSlot(),
            new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 3000)),
          ]);
          this.recordResult(ep, true);
        } catch {
          this.recordResult(ep, false);
        }
      }
    }, 60_000); // 每分钟一次
  }

  /** 关闭 */
  destroy() {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
  }

  /** 当前端点状态（调试用，含响应时间） */
  getStatus() {
    return this.endpoints.map((e) => ({
      url: e.url,
      shortUrl: e.url.replace(/^https?:\/\//, '').slice(0, 30),
      weight: Math.round(e.weight * 10) / 10,
      fails: e.fails,
      successRate: e.totalRequests > 0
        ? ((1 - e.totalFails / e.totalRequests) * 100).toFixed(1) + '%'
        : 'N/A',
      circuitOpen: e.circuitOpenUntil > Date.now() ? 'OPEN' : 'OK',
      totalRequests: e.totalRequests,
      p50ms: this.percentile(e.responseTimes, 0.5),
      p95ms: this.percentile(e.responseTimes, 0.95),
      lastError: e.lastError,
    }));
  }

  // ====== 便捷方法（带缓存） ======

  async getBlock(slot: number): Promise<BlockResponse | null> {
    // block 缓存 30 秒（slot 不会重组超过这点时间）
    return this.rpc('getBlock', [slot, { maxSupportedTransactionVersion: 0, transactionDetails: 'full' }], 30_000);
  }

  async getTransaction(sig: string): Promise<TransactionResponse | null> {
    return this.rpc('getTransaction', [sig, { maxSupportedTransactionVersion: 0 }], 5 * 60_000);
  }

  async getSignaturesForAddress(address: string, limit = 100): Promise<any[]> {
    return this.rpc('getSignaturesForAddress', [address, { limit }], 5_000);
  }
}

let _instance: MultiFreeRpc | null = null;
export function getMultiRpc(): MultiFreeRpc {
  if (!_instance) {
    const urls = (process.env.SOLANA_RPCS ?? MultiFreeRpc.defaultEndpoints().join(',')).split(',').map((s) => s.trim()).filter(Boolean);
    _instance = new MultiFreeRpc(urls);
  }
  return _instance;
}
