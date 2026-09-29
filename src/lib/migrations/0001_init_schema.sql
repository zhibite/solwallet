-- Solana 跟单抢单监控系统 数据库 Schema
-- 适配 PostgreSQL 14+

CREATE TABLE IF NOT EXISTS monitored_targets (
    id            BIGSERIAL PRIMARY KEY,
    address       TEXT NOT NULL UNIQUE,
    label         TEXT,
    threshold_sol NUMERIC(20, 9) NOT NULL DEFAULT 0.5,
    status        TEXT NOT NULL DEFAULT 'active',  -- active / paused
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_buy_at   TIMESTAMPTZ,
    record_count  BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_monitored_targets_status ON monitored_targets(status);

CREATE TABLE IF NOT EXISTS own_wallets (
    id          BIGSERIAL PRIMARY KEY,
    address     TEXT NOT NULL UNIQUE,
    label       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value JSONB NOT NULL
);

-- 监控到的目标交易（buy 行为触发时记录）
CREATE TABLE IF NOT EXISTS target_trades (
    id                  BIGSERIAL PRIMARY KEY,
    target_id           BIGINT NOT NULL REFERENCES monitored_targets(id) ON DELETE CASCADE,
    signature           TEXT NOT NULL UNIQUE,
    slot                BIGINT NOT NULL,
    block_time          TIMESTAMPTZ NOT NULL,
    mint                TEXT NOT NULL,
    target_address      TEXT NOT NULL,
    buy_sol             NUMERIC(20, 9) NOT NULL,
    target_tip_sol      NUMERIC(20, 9) DEFAULT 0,
    target_prio_lamports BIGINT DEFAULT 0,
    is_bundled          BOOLEAN DEFAULT FALSE,
    first_sniper        TEXT,           -- 第一个狙击者地址
    first_sniper_buy_sol NUMERIC(20, 9),
    first_sniper_tip_sol NUMERIC(20, 9),
    first_sniper_prio_lamports BIGINT,
    first_sniper_signature TEXT,
    pnl_sol             NUMERIC(20, 9), -- 跟单收益
    fee_sol             NUMERIC(20, 9) DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'pending',  -- pending / confirmed / failed
    version             TEXT,           -- v0 / legacy
    confirmed           BOOLEAN DEFAULT FALSE,  -- 一键确认目标
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_target_trades_target_id ON target_trades(target_id);
CREATE INDEX IF NOT EXISTS idx_target_trades_mint ON target_trades(mint);
CREATE INDEX IF NOT EXISTS idx_target_trades_slot ON target_trades(slot);
CREATE INDEX IF NOT EXISTS idx_target_trades_block_time ON target_trades(block_time DESC);

-- Block 级深度分析结果
CREATE TABLE IF NOT EXISTS block_analyses (
    id              BIGSERIAL PRIMARY KEY,
    slot            BIGINT NOT NULL,
    mint            TEXT NOT NULL,
    target_signature TEXT NOT NULL,
    block_time      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(slot, mint)
);
CREATE INDEX IF NOT EXISTS idx_block_analyses_slot ON block_analyses(slot);

-- Slot 内每一笔买入交易（block 级分析）
CREATE TABLE IF NOT EXISTS block_buyers (
    id              BIGSERIAL PRIMARY KEY,
    block_analysis_id BIGINT NOT NULL REFERENCES block_analyses(id) ON DELETE CASCADE,
    slot            BIGINT NOT NULL,
    block_index     INT NOT NULL,        -- 在 block 中的顺序
    offset_ms       INT,                 -- 相对目标 tx 的时间偏移(ms)
    signature       TEXT NOT NULL,
    address         TEXT NOT NULL,
    buy_sol         NUMERIC(20, 9) NOT NULL,
    tip_sol         NUMERIC(20, 9) DEFAULT 0,
    prio_lamports   BIGINT DEFAULT 0,
    pnl_sol         NUMERIC(20, 9),     -- 收益
    is_first_sniper BOOLEAN DEFAULT FALSE,
    is_follower     BOOLEAN DEFAULT FALSE,
    is_own          BOOLEAN DEFAULT FALSE,
    is_pre_target   BOOLEAN DEFAULT FALSE,  -- 前置交易（同一 slot 内目标之前）
    result          TEXT,                 -- success / failed
    version         TEXT,                 -- v0 / legacy
    is_bundled      BOOLEAN DEFAULT FALSE,
    UNIQUE(slot, signature)
);
CREATE INDEX IF NOT EXISTS idx_block_buyers_analysis_id ON block_buyers(block_analysis_id);
CREATE INDEX IF NOT EXISTS idx_block_buyers_slot ON block_buyers(slot);
CREATE INDEX IF NOT EXISTS idx_block_buyers_address ON block_buyers(address);

-- 跟单收益记录（卖出时记录）
CREATE TABLE IF NOT EXISTS copy_trades (
    id              BIGSERIAL PRIMARY KEY,
    target_trade_id BIGINT REFERENCES target_trades(id) ON DELETE CASCADE,
    signature       TEXT NOT NULL UNIQUE,
    block_time      TIMESTAMPTZ NOT NULL,
    mint            TEXT NOT NULL,
    wallet          TEXT NOT NULL,
    side            TEXT NOT NULL,         -- buy / sell
    sol_amount      NUMERIC(20, 9) NOT NULL,
    token_amount    NUMERIC(40, 0),
    fee_sol         NUMERIC(20, 9) DEFAULT 0,
    pnl_sol         NUMERIC(20, 9),        -- 仅 sell 时计算
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_copy_trades_target_trade_id ON copy_trades(target_trade_id);
CREATE INDEX IF NOT EXISTS idx_copy_trades_mint ON copy_trades(mint);
CREATE INDEX IF NOT EXISTS idx_copy_trades_wallet ON copy_trades(wallet);

-- Webhook 事件日志（用于排错）
CREATE TABLE IF NOT EXISTS webhook_events (
    id          BIGSERIAL PRIMARY KEY,
    source      TEXT NOT NULL,            -- helius / yellowstone
    payload     JSONB NOT NULL,
    processed   BOOLEAN DEFAULT FALSE,
    error       TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_processed ON webhook_events(processed);

-- 一键确认的跟单目标（白名单）
CREATE TABLE IF NOT EXISTS confirmed_targets (
    id          BIGSERIAL PRIMARY KEY,
    address     TEXT NOT NULL UNIQUE,
    label       TEXT,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source      TEXT,        -- analyze / manual
    notes       TEXT
);

-- 跟单库（积累的聪明钱地址池）
CREATE TABLE IF NOT EXISTS smart_money_library (
    id              BIGSERIAL PRIMARY KEY,
    address         TEXT NOT NULL UNIQUE,
    label           TEXT,
    total_trades    BIGINT DEFAULT 0,
    win_rate        NUMERIC(5, 4),         -- 胜率
    total_pnl_sol   NUMERIC(20, 9) DEFAULT 0,
    avg_pnl_sol     NUMERIC(20, 9) DEFAULT 0,
    tags            TEXT[],
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_active_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_smart_money_library_pnl ON smart_money_library(total_pnl_sol DESC);
