-- 0024: 给 mark-stale UPDATE 加部分索引
--
-- 背景：
--   cron POST 每次启动都会跑一次「mark-stale」UPDATE：
--     UPDATE block_buyers bb SET pnl_status='stale'
--     FROM block_analyses ba
--     WHERE bb.block_analysis_id = ba.id
--       AND bb.pnl_status IS NULL
--       AND ba.block_time < NOW() - INTERVAL '2 hours'
--
--   没有专用索引时，Postgres 必须全表扫 block_buyers（每行判断 pnl_status IS NULL
--   再回表 block_analyses 拿 block_time）。block_buyers 是项目里行数最多的表之一
--   （每个 buyer 一行），单次 mark-stale 在积压期跑可能要几百 ms，全表 IO 也拖累
--   同一时刻的 compute-pnl 主查询。
--
-- 索引策略：
--   部分索引 (partial index)  WHERE pnl_status IS NULL
--   原因：
--     1) 真正参与 mark-stale 的只是「pnl_status IS NULL」的子集（其他行 pnl_status
--        已经被设为 open/closed/partial/buy_failed/stale 之一），索引只覆盖热路径
--     2) 索引列 = block_analysis_id：join 到 block_analyses.id（PK）做时间过滤
--     3) 索引大小 = 几 MB 级（pending 行通常 < 几千），远小于全表索引
--     4) 写开销小：UPDATE 把行从 pnl_status IS NULL 改到 'stale' 时，对应索引条目
--        会从部分索引里被删除（不是 update-in-place），开销可接受
--
-- 同理，"compute-pnl 主查询 SELECT ... WHERE pnl_status IS NULL AND result='success'
-- ORDER BY created_at" 也受益于本索引（pnl_status IS NULL 这部分是子集，剩下
-- result='success' 的过滤会在索引扫描后逐行判断，行数小，不需再单独建索引）。
--
-- 不加 pnl_status='stale' 的反向索引：运维只在 GET 状态接口读 stale_count，
-- 全表扫 + FILTER 即可，不需要索引（且 stale 是终态，索引收益低）。

CREATE INDEX IF NOT EXISTS idx_block_buyers_pending_block_analysis
  ON block_buyers (block_analysis_id)
  WHERE pnl_status IS NULL;
