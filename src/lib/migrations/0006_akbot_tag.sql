-- 2006: 给 pool_members 增加 AKBot 用户标记
--
-- 背景：
--   AKBot 是一类 memecoin sniper 出售工具，所有 akbot 用户都用同一合约 sell：
--     AKbotMAGJmYPwV8z55Lqiqgijt2KcjLeFGue5sw1noHM
--   通过检查 pool_member 的 sell tx 是否调用过该 program 来识别。
--
-- 字段：
--   is_akbot              是否命中 AKBot
--   akbot_detected_at     首次发现时间
--   akbot_evidence_sig    证据 sell 签名（人工核查 / Solscan 跳转）
--   akbot_evidence_slot   证据 sell 的 slot（可选，方便快速定位）

ALTER TABLE pool_members
    ADD COLUMN IF NOT EXISTS is_akbot              BOOLEAN     NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS akbot_detected_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS akbot_evidence_sig    TEXT,
    ADD COLUMN IF NOT EXISTS akbot_evidence_slot   BIGINT;

-- 命中 AKBot 的成员单独加索引，方便筛选 / 单独统计
CREATE INDEX IF NOT EXISTS idx_pool_members_akbot
    ON pool_members(is_akbot) WHERE is_akbot = TRUE;