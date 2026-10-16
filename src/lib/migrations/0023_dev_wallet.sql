-- 0023: dev wallet 追踪 + is_dev_buy 标记 (DRAFT — 暂缓，2026-10-16)
--
-- 状态：未应用。已确认下游链路（follow / sniper / PnL / 告警）都不消费 is_dev_buy，
--       TargetRow.tsx 的 dev badge 是纯装饰。整条链路暂缓，待真有消费方再启。
--
-- 如要启用：
--   1) 跑本 SQL（建 mint_dev_wallets + target_trades.is_dev_buy）
--   2) 解开 src/lib/dev-wallet.ts 顶部的 import（按文件头注释指引）
--   3) 跑 scripts/backfill-dev-wallet.ts 回填历史
--
-- 背景：
--   参考站 (docs/wanglong/list.json) 的每条 buy 都带 is_dev_buy 字段（0/1）：
--     - 1 = 目标钱包 = 该 mint 的 dev（创建者）
--     - 0 = 目标钱包只是普通买家 / 跟单者
--
--   Pump.fun 上 dev 单典型场景：
--     - dev 用一个 tx 同时 create + buy 自己发的币（最常见，参考站数据 100% 命中）
--     - dev create 完一笔，过一会儿用原 wallet 又 buy 一次（少见）
--     - 共同点：目标钱包 = 这个 mint 的 Create 交易 feePayer
--
--   我们的现状：
--     - TargetRow.tsx 已经接好 dev badge UI（is_dev_buy===true 时显示绿色"dev"）
--     - 但 target_trades 没这列、API 没投影、前端永远拿不到
--     - 结果：监控列表里所有 mint 都没 dev 标识
--
-- 改动：
--   1) 新表 mint_dev_wallets：mint → dev_wallet 映射
--        - source 字段标记 dev 来源（pump_create / first_tx_backfill）
--        - 主键 mint，避免重复写入
--   2) target_trades.is_dev_buy BOOLEAN：每笔 buy 是否来自该 mint 的 dev
--
-- 落点（实时）：
--   - ws-monitor.ts handlePumpFunLogs 看见 Create 事件时，把 feePayer 当 dev_wallet 落 mint_dev_wallets
--   - ws-monitor.ts ingestWsTrade / monitor.ts ingestTargetTrade 写 target_trades 时，
--     用 mint 查 mint_dev_wallets.dev_wallet，比对 target_address，命中即 is_dev_buy=true
--
-- 回填（历史）：
--   - scripts/backfill-dev-wallet.ts 对已有 mint 用 getSignaturesForAddress 拉最早 sig，
--     解析后取 feePayer，回写 mint_dev_wallets + 批量更新 target_trades.is_dev_buy
--   - 只处理 mint LIKE '%pump'（Pump.fun 后缀），与参考站覆盖范围一致

CREATE TABLE IF NOT EXISTS mint_dev_wallets (
    mint        TEXT PRIMARY KEY,
    dev_wallet  TEXT NOT NULL,
    slot        BIGINT,
    signature   TEXT,
    source      TEXT NOT NULL,           -- 'pump_create' / 'first_tx_backfill'
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mint_dev_wallets_dev ON mint_dev_wallets(dev_wallet);

COMMENT ON TABLE mint_dev_wallets IS
    'mint → dev 钱包映射；Pump.fun Create 事件的 feePayer 即 dev 钱包';
COMMENT ON COLUMN mint_dev_wallets.source IS
    'pump_create = 实时 WS Pump.fun Create 事件捕获；first_tx_backfill = 历史回填（getSignaturesForAddress 最早 sig 的 feePayer）';

ALTER TABLE target_trades
    ADD COLUMN IF NOT EXISTS is_dev_buy BOOLEAN;

COMMENT ON COLUMN target_trades.is_dev_buy IS
    '目标钱包是否也是该 mint 的 dev（创建者）：true=dev 自买，false=普通 buy；NULL=未识别（mint 不在 mint_dev_wallets 或非 Pump.fun）';
CREATE INDEX IF NOT EXISTS idx_target_trades_is_dev_buy ON target_trades(is_dev_buy) WHERE is_dev_buy = true;