-- 2005: 给 monitored_targets 加 BFS 扫描水位线
--
-- 背景：
--   scanForTarget 之前每次都会全量扫 target_trades 后聚合进 pool_members/edges，
--   跑多次（监控触发 + pool-worker 周期任务）会把 freq 翻倍。
--
-- 修复：
--   monitored_targets.last_scanned_block_time 记录该 target 已处理的最大 block_time，
--   scanForTarget 只扫 block_time > 该水位线的新 trade；扫完后推进水位线。
--   保证 BFS 幂等。
--
-- 不回填历史水位线 —— 首次 BFS 会把已有 trade 全扫一遍并把水位线推进到 MAX(block_time)，
-- 这样不会因为水位线等于最新 trade 的 block_time 而把历史 trade 跳过。

ALTER TABLE monitored_targets
    ADD COLUMN IF NOT EXISTS last_scanned_block_time TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_monitored_targets_last_scan
    ON monitored_targets(last_scanned_block_time);
