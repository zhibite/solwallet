-- 0017: sniper-ranking 性能索引
--
-- 背景：
--   /api/sniper-ranking 走的是：
--     block_buyers WHERE is_first_sniper=true
--     JOIN block_analyses ON ...
--     LEFT JOIN pool_members / monitored_targets
--   现状是 Seq Scan on block_buyers（26639 行，filter 掉 87%），warm 后
--   mainSql ~5-7ms、总查询（含 COUNT DISTINCT）~12-15ms，已经不慢。
--   单次翻页慢的真正瓶颈是：每次翻页都跑 totalSql（COUNT DISTINCT），
--   多一个 round-trip ~15ms。索引在 26k 行表上帮不了太多。
--
--   这次加：
--     (a) block_analyses(block_time DESC) 索引
--         当前数据 < 13 天，7d/30d 窗口几乎覆盖全表，加完短期看不出收益。
--         但 block_analyses 一旦涨到 50w+ 行（7d 之外有数据），ba.block_time>=$1
--         过滤会从 Seq Scan 退化成 Index Range Scan，避免回归。
--     (b) 不再加 block_buyers partial index：实验显示 26k 行表上
--         Index Scan (1779 random buffers) 反而比 Seq Scan (944 seq buffers) 慢。
--         翻页优化走 API 端 total 内存缓存（30s TTL），不走 DB 索引。
--
-- 验证（实测，DB 规模 7090 block_analyses / 26639 block_buyers / 3535 first_sniper）：
--   加索引前 EXPLAIN ANALYZE (warm)
--     totalSql (COUNT DISTINCT)        : ~13 ms  (Buffers 1142)
--     mainSql sort=count LIMIT 30      :  ~7 ms  (Buffers 1469)
--     mainSql sort=pnl   LIMIT 30      :  ~9 ms
--   加 block_buyers partial index 反而变慢：
--     totalSql                         : ~27 ms  (Buffers 1977)
--     mainSql sort=count               : ~17 ms  (Buffers 2304)
--   仅加 block_analyses(block_time) 索引：与原始几乎一致
--     totalSql                         : ~12 ms
--     mainSql sort=count               :  ~7 ms
--   + API total 缓存（30s TTL）：翻页只跑 main = ~7 ms SQL + 一次 round-trip

CREATE INDEX IF NOT EXISTS idx_block_analyses_block_time
  ON block_analyses(block_time DESC);

ANALYZE block_analyses;
