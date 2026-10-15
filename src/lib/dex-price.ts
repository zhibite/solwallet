/**
 * 代币 USD 价格查询
 * 优先级：DexScreener（免费） -> Birdeye（付费，限额较高）-> Redis 缓存
 *
 * 历史：原本提供 getTokenPriceSol / prefetchTokensPriceUsd 给浮盈链路用。
 *   2026-10-15 砍掉浮盈后只剩 USD 单价查 + SOL/USD 汇率两个原子能力，
 *   用在哪里是调用方决定，这里不再做单位换算也不做批量。
 *
 * 仍保留同 mint 并发去重 + 429 冷却 + 30s 正负缓存，是因为这两个能力
 * 可能在未来「按 USD 价排序目标 / 池子估值」等场景用上；移除只是删接口，
 * 不动 30s 缓存键和 inflight 跟踪。
 */

import axios from 'axios';
import { Cache, cacheKeys } from './cache';

// ─── 同 mint 并发去重 ────────────────────────────────────────────────────────
const inflightPrice = new Map<string, Promise<number | null>>();

// 限流状态：mint 维度。触发 429/503 后把 mint 锁一段时间，期间所有调用直接返回 null。
const rateLimitedMint = new Map<string, number>(); // mint → unlockAt (ms)
const RATE_LIMIT_TTL_MS = 60_000;
const NEG_CACHE_TTL_SEC = 30;

function isCooldown(mint: string): boolean {
  const until = rateLimitedMint.get(mint);
  if (until == null) return false;
  if (Date.now() < until) return true;
  rateLimitedMint.delete(mint);
  return false;
}

function markCooldown(mint: string, ms = RATE_LIMIT_TTL_MS): void {
  rateLimitedMint.set(mint, Date.now() + ms);
}

function isRateLimitError(err: any): boolean {
  if (err?.response?.status === 429 || err?.response?.status === 503) return true;
  return /429|503|504/.test(String(err?.message ?? err));
}

export async function getTokenPriceUsd(mint: string): Promise<number | null> {
  if (isCooldown(mint)) return null;

  const existing = inflightPrice.get(mint);
  if (existing) return existing;

  const p = (async () => {
    try {
      const cached = await Cache.get<number>(cacheKeys.tokenPrice(mint));
      if (cached != null && cached > 0) return cached;

      const negCached = await Cache.get<true>(cacheKeys.tokenPrice(mint) + ':null');
      if (negCached === true) return null;

      let rateLimited = false;
      try {
        const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
          timeout: 2000,
        });
        const pair = data?.pairs?.[0];
        if (pair?.priceUsd) {
          const v = parseFloat(pair.priceUsd);
          if (v > 0) {
            await Cache.set(cacheKeys.tokenPrice(mint), v, 30);
            return v;
          }
        }
      } catch (err: any) {
        if (isRateLimitError(err)) rateLimited = true;
      }

      const birdeyeKey = process.env.BIRDEYE_API_KEY;
      if (birdeyeKey) {
        try {
          const { data } = await axios.get(`https://public-api.birdeye.so/defi/price`, {
            params: { address: mint },
            headers: { 'X-API-KEY': birdeyeKey, 'x-chain': 'solana' },
            timeout: 2000,
          });
          if (data?.data?.value) {
            const v = data.data.value as number;
            if (v > 0) {
              await Cache.set(cacheKeys.tokenPrice(mint), v, 30);
              return v;
            }
          }
        } catch (err: any) {
          if (isRateLimitError(err)) rateLimited = true;
        }
      }

      if (rateLimited) {
        markCooldown(mint);
        await Cache.set(cacheKeys.tokenPrice(mint) + ':null', true, 90);
        console.warn(`[dex-price] ${mint.slice(0, 8)} 限流,冷却 60s`);
      } else {
        await Cache.set(cacheKeys.tokenPrice(mint) + ':null', true, NEG_CACHE_TTL_SEC);
      }
      return null;
    } finally {
      inflightPrice.delete(mint);
    }
  })();

  inflightPrice.set(mint, p);
  return p;
}

/**
 * SOL 对 USD 汇率，30s 缓存。
 * Birdeye 公开接口（独立 key 命名空间避免和 tokenPrice 互串）。
 */
let solUsdInflight: Promise<number> | null = null;
export async function getSolPriceUsd(): Promise<number> {
  if (solUsdInflight) return solUsdInflight;
  solUsdInflight = Cache.wrap<number>('price:usd-sol', 30, async () => {
    try {
      const { data } = await axios.get(`https://public-api.birdeye.so/defi/price`, {
        params: { address: 'So11111111111111111111111111111111111111112' },
        timeout: 2000,
      });
      const v = data?.data?.value;
      if (typeof v === 'number' && v > 0) return v;
    } catch {
      // ignore
    }
    try {
      const { data } = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
        params: { ids: 'solana', vs_currencies: 'usd' },
        timeout: 2000,
      });
      const v = data?.solana?.usd;
      if (typeof v === 'number' && v > 0) return v;
    } catch {
      // ignore
    }
    return 150;
  }).finally(() => {
    solUsdInflight = null;
  });
  return solUsdInflight;
}

/** 清除价格缓存 */
export async function clearPriceCache(mint?: string) {
  if (mint) await Cache.del(cacheKeys.tokenPrice(mint));
  else await Cache.clear();
}
