/**
 * dev_wallet 查询与回写（0023，DRAFT — 暂缓，2026-10-16）
 *
 * 背景：参考站每条 buy 带 is_dev_buy 字段（0/1），用于给操作员"目标钱包=该 mint dev"提示。
 * 我们已确认下游链路（follow / sniper / PnL / 告警）都不消费 is_dev_buy，TargetRow.tsx
 * 上的 dev badge 纯装饰。整条链路暂缓，待真有消费方再启。
 *
 * 设计概要（如要启用）：
 *   1) 跑 migrations/0023_dev_wallet.sql 创建 mint_dev_wallets + target_trades.is_dev_buy
 *   2) ws-monitor.ts 监听 Pump.fun Create 事件时，把 feePayer 当 dev_wallet 落 mint_dev_wallets
 *      (解 import 注释 + 调 upsertMintDevWallet + extractFeePayerFromRpcTx)
 *   3) monitor.ts ingestTargetTrade / ws-monitor.ts ingestWsTrade 写 target_trades 时，
 *      用 mint 查 mint_dev_wallets.dev_wallet，比对 target_address，命中即 is_dev_buy=true
 *   4) /api/transactions SQL 投影 t.is_dev_buy
 *   5) scripts/backfill-dev-wallet.ts 用 getSignaturesForAddress 拉 mint 最早 sig 回填
 *
 * 启用时改动的文件：
 *   - src/lib/ws-monitor.ts:  import 本文件 + 调 upsertMintDevWallet + ingestWsTrade 加 checkIsDevBuy
 *   - src/lib/monitor.ts:      ingestTargetTrade 加 checkIsDevBuy
 *   - src/app/api/transactions/route.ts: SELECT 加 t.is_dev_buy
 *   - scripts/backfill-dev-wallet.ts:    新建（一次性回填历史 mint → dev_wallet）
 *
 * 当前状态：本文件暂未 import，不参与运行。
 */

import { query, queryOne } from './db';

/** 写入 mint → dev_wallet 映射（幂等）。Pump.fun Create 事件 / backfill 都调这个。 */
export async function upsertMintDevWallet(args: {
  mint: string;
  devWallet: string;
  slot?: number;
  signature?: string;
  source: 'pump_create' | 'first_tx_backfill';
}): Promise<void> {
  await query(
    `INSERT INTO mint_dev_wallets (mint, dev_wallet, slot, signature, source)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (mint) DO NOTHING`,
    [args.mint, args.devWallet, args.slot ?? null, args.signature ?? null, args.source],
  );
}

/**
 * 给定 mint 和目标地址，判断是否为 dev 单。
 *
 * 返回：
 *   - true  = 命中（target_address == dev_wallet）
 *   - false = mint 在表里但 target_address 不是 dev（普通买家 / 跟单）
 *   - null  = mint 不在表里（非 Pump.fun 后缀 / 还没回填），调用方按 false 落库但允许后续 backfill 修正
 */
export async function checkIsDevBuy(
  mint: string,
  targetAddress: string,
): Promise<boolean | null> {
  const row = await queryOne<{ is_dev: boolean }>(
    `SELECT (dev_wallet = $2) AS is_dev
       FROM mint_dev_wallets
      WHERE mint = $1`,
    [mint, targetAddress],
  );
  return row ? row.is_dev : null;
}

/** 批量：列出 mint_dev_wallets 里所有 mint（给 backfill 脚本做差集） */
export async function listKnownDevMints(): Promise<Set<string>> {
  const rows = await query<{ mint: string }>(`SELECT mint FROM mint_dev_wallets`);
  return new Set(rows.map((r) => r.mint));
}