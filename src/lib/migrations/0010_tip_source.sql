-- 0010: tip 来源渠道
--
-- 之前 tip_sol 只知道「金额」，没法区分走的是哪条 tip 通道（Jito / Helius Sender / LandX / 0slot / ...）。
-- 同一个 tip 金额可能对应完全不同的服务：
--   - 0.001 SOL 既可能是 Jito 的最低 tip，也可能是 Helius Sender / LandX 的最低 tip
--   - 高额 tip（>0.1 SOL）也可能是 Jito 高优 tip 或 Helius Sender 顶 tip buffer
-- 仅看金额会无法分析「哪个渠道的 tip 抢单最有效」。
--
-- 新增字段：
--   tip_source  TEXT  → 'jito' | 'helius_sender' | 'landx' | 'zero_slot' | 'unknown'
--                       - 'jito'         : 转账给 8 个 Jito tip account 之一
--                       - 'helius_sender': 转账给 Helius Sender 的 10 个 tip account 之一
--                       - 'landx'        : 转账给 LandX 的 10 个 tip account 之一（地址前缀 LandX）
--                       - 'zero_slot'    : 转账给 0slot 的 10 个 tip account 之一
--                       - 'unknown'      : 付了 tip 但未匹配任何已知渠道（新通道 / 链上数据补）
--                       - NULL           : 该笔未付 tip（不是任何 tip 通道）
--
-- 新通道（Harmonic / Rakurai / jitoBAM 等）后续只需：
--   1) 在 src/lib/parser.ts 的 SOLANA_TIP_SOURCE_MAP 加原文/新地址
--   2) 跑 backfill-tip-source.ts 回填历史数据

ALTER TABLE target_trades
  ADD COLUMN IF NOT EXISTS tip_source TEXT;

ALTER TABLE block_buyers
  ADD COLUMN IF NOT EXISTS tip_source TEXT;

-- 索引：常按「同笔 buy 的 tip 渠道分布」聚合
CREATE INDEX IF NOT EXISTS idx_target_trades_tip_source
  ON target_trades(tip_source) WHERE tip_source IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_block_buyers_tip_source
  ON block_buyers(tip_source) WHERE tip_source IS NOT NULL;

-- 历史回填见 scripts/backfill-tip-source.ts。