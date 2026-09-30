-- 2004: 池子 (Pool) —— 自动发现的跟单池 + 关系图谱
--
-- 设计：
--   pool_members: 每个被自动发现过的地址（first_sniper / follower / both 角色）
--               freq 是「该地址在多少笔目标 buy 后的 slot/slot+1 内出现过」
--   pool_edges:  (follower -> target) 关系边，次数 + 平均块内位置差
--
-- 配合 lib/pool.ts 的 BFS discoverer：
--   1) 从 monitored_targets seed 开始
--   2) 扫描每笔 target_trades 对应的 block_buyers（同 slot + 下一 slot 中标 first_sniper / follower）
--   3) 聚合 pool_members 和 pool_edges
--   4) freq 高于阈值时把 pool_member 自动 promote 到 monitored_targets，进入下一轮 BFS

CREATE TABLE IF NOT EXISTS pool_members (
    id                BIGSERIAL PRIMARY KEY,
    address           TEXT NOT NULL UNIQUE,
    label             TEXT,
    role              TEXT NOT NULL DEFAULT 'follower',  -- first_sniper / follower / both
    freq              BIGINT NOT NULL DEFAULT 0,         -- 出现次数
    seen_as_first_sniper BIGINT NOT NULL DEFAULT 0,
    seen_as_follower  BIGINT NOT NULL DEFAULT 0,
    distinct_targets  BIGINT NOT NULL DEFAULT 0,         -- 跟随过多少个独立目标
    target_addresses  TEXT[]        NOT NULL DEFAULT '{}',  -- 跟随过的目标地址（用于定位）
    mints_sample       TEXT[]        NOT NULL DEFAULT '{}',  -- 最近 100 个 mint 样本
    avg_buy_sol       NUMERIC(20, 9) DEFAULT 0,
    avg_offset_pos    REAL         DEFAULT 0,            -- 平均相对目标的块内位置
    first_seen_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_seen_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    -- 决策字段（pool-decision 写入）
    worth_score       NUMERIC(8, 4),                     -- 是否值得跟的评分
    recommended_tip_sol  NUMERIC(20, 9),                 -- 决策: 推荐 tip
    recommended_prio_lamports BIGINT,                   -- 决策: 推荐 prio
    score_updated_at  TIMESTAMPTZ,
    -- 提升
    promoted_to_target BOOLEAN     NOT NULL DEFAULT FALSE,
    promoted_at       TIMESTAMPTZ,
    notes             TEXT,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pool_members_freq ON pool_members(freq DESC);
CREATE INDEX IF NOT EXISTS idx_pool_members_role ON pool_members(role);
CREATE INDEX IF NOT EXISTS idx_pool_members_promoted ON pool_members(promoted_to_target);
CREATE INDEX IF NOT EXISTS idx_pool_members_score ON pool_members(worth_score DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS pool_edges (
    id                BIGSERIAL PRIMARY KEY,
    follower          TEXT NOT NULL,                    -- 跟随者 (first_sniper / follower)
    target            TEXT NOT NULL,                    -- 被跟随的目标 (monitored_targets.address)
    freq              BIGINT NOT NULL DEFAULT 0,         -- 多少笔 target_trades 之后
    same_slot_count   BIGINT NOT NULL DEFAULT 0,         -- 同 slot 跟随
    next_slot_count   BIGINT NOT NULL DEFAULT 0,         -- slot+1 跟随
    win_count         BIGINT NOT NULL DEFAULT 0,         -- 跟随后自己抢单成功
    fail_count        BIGINT NOT NULL DEFAULT 0,         -- 跟随后抢单失败
    avg_offset_pos    REAL,                             -- 平均相对目标的块内位置
    avg_buy_sol       NUMERIC(20, 9),
    first_seen_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_seen_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE(follower, target)
);
CREATE INDEX IF NOT EXISTS idx_pool_edges_follower ON pool_edges(follower);
CREATE INDEX IF NOT EXISTS idx_pool_edges_target ON pool_edges(target);
CREATE INDEX IF NOT EXISTS idx_pool_edges_freq ON pool_edges(freq DESC);

-- 池子发现记录（每次 BFS 扫描的元信息）
CREATE TABLE IF NOT EXISTS pool_discoveries (
    id                BIGSERIAL PRIMARY KEY,
    source_target     TEXT NOT NULL,                    -- 本轮扫描的 seed target
    followers_found   BIGINT NOT NULL DEFAULT 0,         -- 发现多少个 follower / first_sniper
    new_addresses     BIGINT NOT NULL DEFAULT 0,         -- 多少个新地址入库
    promoted          BIGINT NOT NULL DEFAULT 0,         -- 多少个被自动 promote
    scanned_trades    BIGINT NOT NULL DEFAULT 0,         -- 扫了多少笔 target_trades
    duration_ms       INT,
    error             TEXT,
    started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pool_discoveries_source ON pool_discoveries(source_target);
CREATE INDEX IF NOT EXISTS idx_pool_discoveries_started ON pool_discoveries(started_at DESC);