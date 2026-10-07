-- 2011: 推荐手续费 (P50/P75) 双轨 + 字段 nullable 化
--
-- 背景：
--   pool-decision.ts 之前只把 P75 写进 pool_members.recommended_tip_sol 单字段，
--   然后 UI 端用 `m.recommended_tip_sol ? <SolAmount> : '-'` 三元渲染。
--   0 被当 falsy 显示 '-'，巧合掩盖了"没样本"的事实。语义上：
--     - "推荐交 0 SOL"（真的便宜）
--     - "没样本不能给推荐"（数据不足）
--   两者现在写库都是 0，UI 区分不出来。
--
-- 修复：
--   1) 老字段语义不变（仍然写 P50，"最低推荐"），但允许 NULL：
--        样本不足时写 NULL，UI `value == null` 显式显示 '-'。
--   2) 新加两个 P75 字段（"激进推荐"），类型和 P50 一致：
--        recommended_tip_sol_p75     NUMERIC(20, 9)
--        recommended_prio_lamports_p75 BIGINT
--   3) 老 P50 字段也允许 NULL（语义同上）。
--
-- 不回填：旧 0 是"0 还是 NULL"没法分辨，回填等于发明事实。
-- recomputeAllDecisions 在这次部署后第一次跑会自动写新值（P50 和 P75 都写）。

ALTER TABLE pool_members
    ADD COLUMN IF NOT EXISTS recommended_tip_sol_p75     NUMERIC(20, 9),
    ADD COLUMN IF NOT EXISTS recommended_prio_lamports_p75 BIGINT;

-- 老 P50 字段允许 NULL：原来 NUMERIC 默认 NOT NULL，DDL 改成 NULL
ALTER TABLE pool_members
    ALTER COLUMN recommended_tip_sol DROP NOT NULL,
    ALTER COLUMN recommended_prio_lamports DROP NOT NULL;

COMMENT ON COLUMN pool_members.recommended_tip_sol IS
    'P50 推荐 tip (最低推荐)；NULL = 成功样本不足';
COMMENT ON COLUMN pool_members.recommended_prio_lamports IS
    'P50 推荐 prio；NULL = 成功样本不足';
COMMENT ON COLUMN pool_members.recommended_tip_sol_p75 IS
    'P75 推荐 tip (激进推荐)；NULL = 成功样本不足';
COMMENT ON COLUMN pool_members.recommended_prio_lamports_p75 IS
    'P75 推荐 prio；NULL = 成功样本不足';