/**
 * 代币价格查询服务
 * 优先级：DexScreener（免费） -> Birdeye（付费，限额较高）-> Redis 缓存
 *
 * 用于：
 * - 跟单收益计算
 * - 一键确认目标（按 PnL 排序）
 */

import axios from 'axios';
import { Cache, cacheKeys } from './cache';

export async function getTokenPriceUsd(mint: string): Promise<number | null> {
  return Cache.wrap<number | null>(
    cacheKeys.tokenPrice(mint),
    30, // 30s 缓存
    async () => {
      // DexScreener
      try {
        const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 8_000 });
        const pair = data?.pairs?.[0];
        if (pair?.priceUsd) return parseFloat(pair.priceUsd);
      } catch {
        // fallthrough
      }

      // Birdeye
      const birdeyeKey = process.env.BIRDEYE_API_KEY;
      if (birdeyeKey) {
        try {
          const { data } = await axios.get(`https://public-api.birdeye.so/defi/price`, {
            params: { address: mint },
            headers: { 'X-API-KEY': birdeyeKey, 'x-chain': 'solana' },
            timeout: 8_000,
          });
          if (data?.data?.value) return data.data.value as number;
        } catch {
          // ignore
        }
      }

      return null;
    },
  );
}

/** 清除价格缓存 */
export async function clearPriceCache(mint?: string) {
  if (mint) await Cache.del(cacheKeys.tokenPrice(mint));
  else await Cache.clear();
}
