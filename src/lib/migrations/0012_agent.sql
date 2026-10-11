-- Migration: 0012_agent
-- Description: Agent decision system - rounds, decisions, knowledge base

-- Agent rounds: each periodic cycle of agent decision-making
CREATE TABLE agent_rounds (
    id              BIGSERIAL PRIMARY KEY,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ,
    llm_model       TEXT,                       -- e.g. 'deepseek-chat'
    llm_provider    TEXT,                       -- e.g. 'deepseek'
    total_ms        INT,                        -- total LLM call duration
    target_count    INT,                        -- number of targets evaluated
    decision_count  INT,                        -- number of decisions made
    executed_count  INT DEFAULT 0,              -- number of decisions executed
    error_count     INT DEFAULT 0,              -- number of errors
    status          TEXT DEFAULT 'running',     -- 'running' | 'completed' | 'error'
    error_message   TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Agent decisions: individual decisions per target per round
CREATE TABLE agent_decisions (
    id              BIGSERIAL PRIMARY KEY,
    round_id        BIGINT REFERENCES agent_rounds(id) ON DELETE CASCADE,
    target_id       BIGINT REFERENCES monitored_targets(id) ON DELETE CASCADE,
    action          TEXT NOT NULL,              -- 'enable' | 'disable' | 'delete' | 'limit_update' | 'hold'
    params          JSONB,                      -- { position_sol?, tip_sol?, gas_sol?, slippage? }
    reasoning       TEXT,                      -- LLM natural language reasoning
    confidence      NUMERIC(4,2),              -- 0.00 - 1.00
    shadow          BOOLEAN DEFAULT FALSE,      -- shadow mode flag
    executed        BOOLEAN DEFAULT FALSE,      -- whether actually executed
    executed_at     TIMESTAMPTZ,
    execution_error TEXT,                      -- error message if execution failed
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Agent knowledge base: rules and strategies
CREATE TABLE agent_knowledge (
    id              BIGSERIAL PRIMARY KEY,
    category        TEXT NOT NULL,              -- e.g. '跟单策略'
    title           TEXT,
    content         TEXT NOT NULL,              -- rule content
    is_recommended  BOOLEAN DEFAULT FALSE,       -- recommended rule (LLM should consider)
    is_mandatory    BOOLEAN DEFAULT FALSE,      -- mandatory rule (LLM must follow)
    sort_order      INT DEFAULT 0,
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Agent settings: global agent configuration
CREATE TABLE agent_settings (
    id              BIGSERIAL PRIMARY KEY,
    key             TEXT UNIQUE NOT NULL,
    value           JSONB NOT NULL,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_agent_rounds_started_at ON agent_rounds(started_at DESC);
CREATE INDEX idx_agent_rounds_status ON agent_rounds(status);
CREATE INDEX idx_agent_decisions_round_id ON agent_decisions(round_id);
CREATE INDEX idx_agent_decisions_target_id ON agent_decisions(target_id);
CREATE INDEX idx_agent_decisions_action ON agent_decisions(action);
CREATE INDEX idx_agent_decisions_created_at ON agent_decisions(created_at DESC);
CREATE INDEX idx_agent_knowledge_category ON agent_knowledge(category);
CREATE INDEX idx_agent_knowledge_active ON agent_knowledge(is_active) WHERE is_active = TRUE;

-- Add agent_params column to monitored_targets table for storing decision parameters
ALTER TABLE monitored_targets ADD COLUMN IF NOT EXISTS agent_params JSONB;

-- Add target-level shadow mode (per-target override)
ALTER TABLE monitored_targets ADD COLUMN IF NOT EXISTS agent_shadow BOOLEAN DEFAULT FALSE;

-- Insert default knowledge base entries
INSERT INTO agent_knowledge (category, title, content, is_recommended, is_mandatory, sort_order) VALUES
-- Mandatory rules
('跟单策略', '只跟盈利钱包', '只跟胜率 > 50% 且平均利润为正的钱包', TRUE, TRUE, 1),
('跟单策略', '观察期要求', '新钱包需要至少 3 笔交易记录后才考虑开启跟单', TRUE, TRUE, 2),
-- Recommended rules
('跟单策略', '动态调整参数', '根据钱包的胜率和平均利润动态调整 position_sol 和 tip_sol', TRUE, FALSE, 3),
('跟单策略', '止损建议', '连续 2 轮亏损建议降低仓位或暂停', TRUE, FALSE, 4),
('跟单策略', '高gas模式', '当目标钱包使用高gas策略时，考虑提高我方gas以增加竞争力', TRUE, FALSE, 5);

-- Insert default agent settings
INSERT INTO agent_settings (key, value) VALUES
('global', '{"shadow_mode": true, "interval_minutes": 5, "model": "deepseek-chat", "provider": "deepseek"}');

COMMENT ON TABLE agent_rounds IS 'Each agent decision cycle';
COMMENT ON TABLE agent_decisions IS 'Individual decisions per target per round';
COMMENT ON TABLE agent_knowledge IS 'LLM prompt injection rules and strategies';
COMMENT ON TABLE agent_settings IS 'Global agent configuration';
