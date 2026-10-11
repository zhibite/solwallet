-- 0015_agent_round_attempted_count.sql
-- Fix #6：补 agent_rounds.attempted_count 字段。
-- 原来 round 表只有 executed_count + error_count，把「本地写库成功但 akbot 调
-- 用失败」这种半态算在 error 里。增加 attempted_count 让 round 级别也能区分
-- 「尝试过」(本地+akbot 中间某步失败) vs 「完全失败」(本地就抛了)。

ALTER TABLE agent_rounds
  ADD COLUMN IF NOT EXISTS attempted_count INT DEFAULT 0;
