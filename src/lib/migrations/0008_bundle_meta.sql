-- 0008: bundle 元数据
--
-- 之前 is_bundled 只是 v0 的简化判定，导致大量普通 v0 tx 被误标为 bundle。
-- 修正后判定依据：付 jito tip（强信号）或 v0 + ALT（次信号）。
--
-- 新增字段：
--   has_alt       : 解析时是否观察到 Address Lookup Table（v0 才有这个可能）
--   bundle_size   : 同 bundle 内的交易笔数（从 block_buyers 按 bundle_id 聚合）
--   bundle_id     : 同 bundle 的多笔共享同一 ID（暂时按 slot + tip_account + tip_amount 计算的简化 hash）
--
-- 历史数据回填见 scripts/recompute-bundle.ts。

ALTER TABLE target_trades
  ADD COLUMN IF NOT EXISTS has_alt      BOOLEAN,
  ADD COLUMN IF NOT EXISTS bundle_size  INT,
  ADD COLUMN IF NOT EXISTS bundle_id    TEXT;

CREATE INDEX IF NOT EXISTS idx_target_trades_bundle_id ON target_trades(bundle_id) WHERE bundle_id IS NOT NULL;

-- block_buyers 也加这两个字段，分析块内首狙的 bundle 信息
ALTER TABLE block_buyers
  ADD COLUMN IF NOT EXISTS has_alt     BOOLEAN,
  ADD COLUMN IF NOT EXISTS bundle_id   TEXT,
  ADD COLUMN IF NOT EXISTS bundle_size INT;

CREATE INDEX IF NOT EXISTS idx_block_buyers_bundle_id ON block_buyers(bundle_id) WHERE bundle_id IS NOT NULL;