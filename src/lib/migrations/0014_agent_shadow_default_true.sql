-- 0014_agent_shadow_default_true.sql
-- Fix #16：migration 0012 把 agent_shadow 默认值设成 FALSE —— 危险：
--   新晋升的 target 默认不是 shadow 模式，agent 第一次 round 就会实盘改 akbot。
-- 改成 DEFAULT TRUE：所有 target 默认进 shadow，运维显式开灯才实盘。
--
-- 这条 migration 同时干两件事：
--   1) 把所有现有行的 agent_shadow 反转成 TRUE（让历史 target 也安全）
--   2) 改 column default 让未来 INSERT 走 TRUE
--
-- 已经在 .env 配过 shadow_mode=false 全局开关 + 显式关过 agent_shadow 的 target
-- 会被「全部反白」成 TRUE，等于回滚到最安全状态。运维需要重新挨个开：
--   UPDATE monitored_targets SET agent_shadow = FALSE WHERE <条件>;
-- 这是有意的——新装的环境应该默认安全，不应该默认危险。

-- 1) 老行全反转成 TRUE
UPDATE monitored_targets
SET agent_shadow = TRUE
WHERE agent_shadow IS DISTINCT FROM TRUE;

-- 2) 改 default 给未来的 INSERT 用
ALTER TABLE monitored_targets
  ALTER COLUMN agent_shadow SET DEFAULT TRUE;
