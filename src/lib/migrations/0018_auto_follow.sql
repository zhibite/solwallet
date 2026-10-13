-- 添加 auto_follow 列：勾选后 trading_agent 的跟单 agent 才会自动决策这个目标
ALTER TABLE monitored_targets ADD COLUMN IF NOT EXISTS auto_follow BOOLEAN NOT NULL DEFAULT FALSE;
