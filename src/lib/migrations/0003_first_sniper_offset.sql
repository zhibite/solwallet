-- 0003: 监控列表「抱对 +X」字段
-- 记录第一次狙击者相对目标 tx 的块内位置差，用于在 MonitorList 显示「抱对 +270」之类

ALTER TABLE target_trades
  ADD COLUMN IF NOT EXISTS first_sniper_offset_pos INT;
