/**
 * Redis 缓存层（带内存 fallback）
 * 用于：
 * - block 缓存（30s）
 * - transaction 缓存（5min）
 * - 价格缓存（30s）
 * - RPC 限流计数
 *
 * 如果未配置 REDIS_URL，自动 fallback 到 Map 内存缓存
 */

interface CacheEntry<T> {
  value: T;
  expires: number;
}

// 内存 fallback
const memoryCache = new Map<string, CacheEntry<any>>();

// ioredis 动态加载（未安装也能运行）
type RedisClient = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, duration?: number): Promise<any>;
  // ioredis 原生 del 接受 (key, ...keys) 或 keys: string[] 数组形式，两种都返回删除条数
  del(key: string | string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  ping(): Promise<string>;
  quit(): Promise<any>;
};

let redis: RedisClient | null = null;
let redisEnabled = false;
let redisChecked = false;

async function tryConnectRedis(): Promise<void> {
  if (redisChecked) return;
  redisChecked = true;
  const url = process.env.REDIS_URL;
  if (!url) {
    console.log('[cache] REDIS_URL 未配置，使用内存缓存');
    return;
  }
  try {
    // 动态 require 避免未安装时报错
    const IORedis = (await import('ioredis')).default;
    const client = new IORedis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 500, 5000),
      enableOfflineQueue: true,
      lazyConnect: false,
      connectTimeout: 5000,
    }) as any;
    client.on('error', (err: any) => {
      if (redisEnabled) console.warn('[cache] redis error:', err.message);
      redisEnabled = false;
    });
    client.on('ready', () => {
      redisEnabled = true;
      console.log('[cache] redis connected');
    });
    // 测一下连通性
    await client.ping();
    redis = client as RedisClient;
    redisEnabled = true;
  } catch (err: any) {
    console.warn('[cache] redis 连接失败，使用内存缓存:', err.message);
    redisEnabled = false;
  }
}

export class Cache {
  /** 通用 get/set/del */
  static async get<T = any>(key: string): Promise<T | null> {
    await tryConnectRedis();
    if (redisEnabled && redis) {
      try {
        const raw = await redis.get(key);
        if (raw) return JSON.parse(raw) as T;
        return null;
      } catch {
        // 退化到内存
      }
    }
    const hit = memoryCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value as T;
    if (hit) memoryCache.delete(key);
    return null;
  }

  static async set<T = any>(key: string, value: T, ttlSec = 30): Promise<void> {
    await tryConnectRedis();
    if (redisEnabled && redis) {
      try {
        await redis.set(key, JSON.stringify(value), 'EX', ttlSec);
        return;
      } catch {
        // 退化到内存
      }
    }
    memoryCache.set(key, { value, expires: Date.now() + ttlSec * 1000 });
  }

  static async del(key: string): Promise<void> {
    await tryConnectRedis();
    if (redisEnabled && redis) {
      try { await redis.del(key); return; } catch { /* ignore */ }
    }
    memoryCache.delete(key);
  }

  /** 一次性读取 + 回填（防止雪崩） */
  static async wrap<T>(key: string, ttlSec: number, loader: () => Promise<T>): Promise<T> {
    const hit = await Cache.get<T>(key);
    if (hit !== null && hit !== undefined) return hit;
    const value = await loader();
    if (value !== null && value !== undefined) {
      await Cache.set(key, value, ttlSec);
    }
    return value;
  }

  /** 获取缓存统计 */
  static async stats(): Promise<{
    backend: 'redis' | 'memory';
    keys: number;
    redisReady: boolean;
  }> {
    await tryConnectRedis();
    if (redisEnabled && redis) {
      try {
        const keys = await redis.keys('*');
        return { backend: 'redis', keys: keys.length, redisReady: true };
      } catch {
        // ignore
      }
    }
    return { backend: 'memory', keys: memoryCache.size, redisReady: false };
  }

  /** 清空所有缓存（调试用） */
  static async clear(): Promise<void> {
    if (redisEnabled && redis) {
      try {
        const keys = await redis.keys('*');
        if (keys.length > 0) await redis.del(keys);
      } catch { /* ignore */ }
    }
    memoryCache.clear();
  }
}

// 缓存 key 生成器（统一格式）
export const cacheKeys = {
  block: (slot: number) => `block:${slot}`,
  tx: (sig: string) => `tx:${sig}`,
  // until 必须进键。锚定翻页（until=买入签名）下，同一个 before 的两次请求
  // 答案完全不同；漏掉 until 会让「同一钱包在两个区块各买过一次」拿到同一份签名窗口。
  sigs: (addr: string, before: string | undefined, until: string | undefined) =>
    `sigs:${addr}:${before ?? 'latest'}:${until ?? 'earliest'}`,
  tokenPrice: (mint: string) => `price:${mint}`,
  rpcHealth: (url: string) => `rpchealth:${encodeURIComponent(url)}`,
  targetTrades: (targetId: number, page: number) => `targettrades:${targetId}:${page}`,
};
