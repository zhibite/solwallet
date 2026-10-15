-- 0021: 狙击者竞争态势信号 (Sniper Competition Dynamics)
--
-- 背景（参考站 liste2.json 拆解）：
--   参考站把「狙击者竞争态势」作为决策第一信号，每个 monitor 的 last_sniper_buy
--   都带这几个字段：
--     - competitor_count    : 该 slot 内同 mint 的非 own 买家总数（不含 target）
--     - chosen_address      : 系统选中的狙击者地址
--     - mine_rank           : 我们 own wallet 在该 mint 的排位（rank=1 = 第一个）
--     - sniper_slot_delta   : 狙击者相对目标的 slot 差（-1/0/1/2/...）
--
--   我们当前决策口径：目标在 slot S 买入 → 分析 slot S/S+1 的所有买家 → 算 PnL。
--   缺的是「竞争态势」维度的元数据：
--     - 这个 mint 有多少人抢（不知道 → 推荐 tip 没依据）
--     - 我们自己排在第几（不知道 → 跟了但太晚，没人知道）
--     - 系统选了谁跟（不知道 → 复盘缺锚点）
--
-- 改动：
--   1) block_analyses：
--        competitor_count INT     -- 该 slot+next-slot 内非 own 非 target 的买家数
--        chosen_address   TEXT    -- 系统选中的狙击者（= first_sniper 或决策覆盖）
--        competitor_rank  JSONB   -- {"<address>": rank, ...}，每个竞争者的排名
--   2) block_buyers：
--        mine_rank        INT     -- 我们 own wallet 在该 block 的 rank（NULL=非 own）
--        sniper_slot_delta INT    -- 相对目标 slot 的差（同=0，next=1，前置=-1）
--        competitor_rank  INT     -- 在同+next-slot 非 own 非 target 内的排名（1-based）
--
-- 不回填历史：competitor_count / mine_rank 需要重新跑 analyzeBlock 才正确。
-- 迁移跑完后会被 backfill-sniper-rank.ts 一次补齐（见 scripts/）。

ALTER TABLE block_analyses
    ADD COLUMN IF NOT EXISTS competitor_count INT,
    ADD COLUMN IF NOT EXISTS chosen_address   TEXT,
    ADD COLUMN IF NOT EXISTS competitor_rank  JSONB;

ALTER TABLE block_buyers
    ADD COLUMN IF NOT EXISTS mine_rank        INT,
    ADD COLUMN IF NOT EXISTS sniper_slot_delta INT,
    ADD COLUMN IF NOT EXISTS competitor_rank  INT;

COMMENT ON COLUMN block_analyses.competitor_count IS
    '狙击者竞争态势：同 slot + 下一 slot 内非 own 非 target 的买家总数';
COMMENT ON COLUMN block_analyses.chosen_address IS
    '系统选中的狙击者地址（默认 = first_sniper，可被决策逻辑覆盖）';
COMMENT ON COLUMN block_analyses.competitor_rank IS
    '每个竞争者在同+next-slot 内的排名 JSON，例: {"<addr>": 1, "<addr>": 2, ...}';

COMMENT ON COLUMN block_buyers.mine_rank IS
    '我们 own wallet 在该 block 的竞争排位（1 = 第一个买；NULL = 不是 own wallet）';
COMMENT ON COLUMN block_buyers.sniper_slot_delta IS
    '相对目标 slot 的差（同=0，next=1，前置=-1；越大说明跟得越晚）';
COMMENT ON COLUMN block_buyers.competitor_rank IS
    '在同+next-slot 非 own 非 target 买家中的排名（1 = 第一个狙击者，NULL = 不参与竞争）';
