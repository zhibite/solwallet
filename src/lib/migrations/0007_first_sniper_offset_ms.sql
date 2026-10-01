-- 0007: 狙击者时间偏移（ms）
-- 与 first_sniper_offset_pos（块内位置差）配对使用：
--   first_sniper_offset_pos: 同 slot 内 TX 位置差（小数字，-10 ~ +10 量级）
--   first_sniper_offset_ms : 时间差，> 0 表示狙击者比目标更早（ms）
--
-- 数据源：first-sniper.ts 已经把 ms 偏移算到 block_buyers.offset_ms，
-- 这里只是回写到 target_trades，供 monitor / sniper 页面直接展示「抢到 +Nms」。
--
-- backfill：见 scripts/backfill-sniper-ms.ts，从 block_buyers.offset_ms JOIN target_trades。

ALTER TABLE target_trades
  ADD COLUMN IF NOT EXISTS first_sniper_offset_ms INT;