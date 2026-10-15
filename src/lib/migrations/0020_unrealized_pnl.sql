-- 0020: 持仓的未实现 PnL（浮盈）
--
-- 背景：
--   之前 block_buyers 只记了已实现 PnL（pnl_sol / pnl_status / pnl_sold_ratio），
--   遇到 status='open'（一笔都没卖）或 status='partial'（卖了一部分）的行，UI 只能
--   显示"*"标记持仓中，没法告诉用户这笔浮盈多少。
--   真正跟单者关心的是"总 PnL"：已实现 + (持仓 * 当前价) - 买入成本。
--
-- 设计：
--   - 字段落库是为了减少每次刷新页面的外部 API 调用 + 让 UI 即时显示，不用等 cron 跑。
--   - 不把 price 直接 join 到 PnL 计算里去：单笔 FIFO 配对还是用买入时真实成本/收入，
--     浮盈只是叠在已经算好的 pnl_sol 上的「额外视图」。
--   - calcCopyPnl 主体不调外部价格（拖慢 3-8s → 10-15s）；
--     改由 refresh-unrealized.ts 定时刷新 status IN ('open','partial') 的行。
--
-- 字段：
--   current_price_sol     当前 token 价格（SOL 单位）。null = 拉不到（dex 上无流动性 / API 失败）
--   unrealized_sol        本笔剩余持仓按当前价估值的浮盈（= remaining * price - 按比例分摊的成本 - 买入 fee 部分）
--   total_pnl_sol         总 PnL（= pnl_sol + unrealized_sol）。open 时 = unrealized_sol；closed 时 = pnl_sol
--   price_updated_at      价格拉取时间。> N 秒没刷则视为过期（UI 显示 ~）

ALTER TABLE block_buyers
    ADD COLUMN IF NOT EXISTS current_price_sol NUMERIC(30, 18),
    ADD COLUMN IF NOT EXISTS unrealized_sol    NUMERIC(20, 9),
    ADD COLUMN IF NOT EXISTS total_pnl_sol      NUMERIC(20, 9),
    ADD COLUMN IF NOT EXISTS price_updated_at  TIMESTAMPTZ;

COMMENT ON COLUMN block_buyers.current_price_sol IS '当前 token 的 SOL 单价（来自 DexScreener/Birdeye）。null=拉不到';
COMMENT ON COLUMN block_buyers.unrealized_sol    IS '未实现部分：remainingTokenAmount * current_price_sol - 按比例分摊的成本';
COMMENT ON COLUMN block_buyers.total_pnl_sol      IS '总 PnL = pnl_sol(已实现) + unrealized_sol；closed 时两者就是 pnl_sol/0';
COMMENT ON COLUMN block_buyers.price_updated_at  IS 'current_price_sol 拉取时间；超过 90s 视为过期';

-- refresh-unrealized.ts 主查询用的索引：只刷 open/partial 且价过期的行
CREATE INDEX IF NOT EXISTS block_buyers_unrealized_due_idx
    ON block_buyers (pnl_status, price_updated_at)
    WHERE pnl_status IN ('open', 'partial');
