-- 0002: Block 详情对齐参考截图
-- 1) block_buyers.offset_pos: 相对目标 tx 的块内位置差 (block_index - target_block_index)
-- 2) block_buyers.slot_offset: 0 = 同一 slot, 1 = 下一个 slot
-- 3) block_analyses.target_block_index: 目标 tx 在 block 内的位置
-- 4) block_analyses.same_slot_count / next_slot_count: 用于显示「同一 slot 里 X 笔, 下一个 slot 里 Y 笔」

ALTER TABLE block_buyers
  ADD COLUMN IF NOT EXISTS offset_pos INT,
  ADD COLUMN IF NOT EXISTS slot_offset INT NOT NULL DEFAULT 0;

ALTER TABLE block_analyses
  ADD COLUMN IF NOT EXISTS target_block_index INT,
  ADD COLUMN IF NOT EXISTS same_slot_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_slot_count INT NOT NULL DEFAULT 0;
