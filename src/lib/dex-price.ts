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
      // DexScreener（2s timeout，1s connect）
      try {
        const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
          timeout: 2000,
        });
        const pair = data?.pairs?.[0];
        if (pair?.priceUsd) return parseFloat(pair.priceUsd);
      } catch {
        // fallthrough
      }

      // Birdeye（2s timeout）
      const birdeyeKey = process.env.BIRDEYE_API_KEY;
      if (birdeyeKey) {
        try {
          const { data } = await axios.get(`https://public-api.birdeye.so/defi/price`, {
            params: { address: mint },
            headers: { 'X-API-KEY': birdeyeKey, 'x-chain': 'solana' },
            timeout: 2000,
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

/**
 * 当前 SOL 对 USD 的价格（30s 缓存）。
 * 单一来源 = Birdeye 公开接口（SOL 是 base token，单独查询比 DexScreener 稳定）。
 * 用于：把 token 的 USD 价格折算成 SOL 单位，避免跟单收益误用美元数。
 *
 * 缓存 key 独立于 tokenPrice(mint)：如果用 cacheKeys.tokenPrice('SOL') 会和
 *   getTokenPriceUsd('SOL') 撞 key，万一某天有人误用 wrapped SOL 做 token 查询，
 *   就会把 SOL 汇率 token 价格互串。用独立命名空间避免这种隐式耦合。
 */
export async function getSolPriceUsd(): Promise<number> {
  return Cache.wrap<number>(
    'price:usd-sol',  // 独立 key，不与 tokenPrice 撞
    30,
    async () => {
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
      // 兜底：CoinGecko
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
      // 最末兜底：最近一次成功值（避免 cron 全断时所有数显示 null）
      return 150;
    },
  );
}

/**
 * 当前 token 的 SOL 单价（= USD / SOL_USD）。
 *
 * 返回 null 的场景：token USD 拉不到（无流动性），或除零（不会发生）。
 *
 * 这个函数才是「拿来落库到 block_buyers.current_price_sol」的接口。
 * 把 USD/SOL 转换包在这里，让上层专心处理浮盈算术、不用关心单位。
 */
export async function getTokenPriceSol(mint: string): Promise<number | null> {
  const usd = await getTokenPriceUsd(mint);
  if (usd == null || usd <= 0) return null;
  const solUsd = await getSolPriceUsd();
  if (solUsd <= 0) return null;
  return usd / solUsd;
}

/** 清除价格缓存 */
export async function clearPriceCache(mint?: string) {
  if (mint) await Cache.del(cacheKeys.tokenPrice(mint));
  else await Cache.clear();
}
