-- 2007: 单笔跟单收益所需的字段
--
-- 背景：
--   之前 block_buyers 只记了买入的 SOL 金额，缺少「这笔买到了多少 token」，
--   导致算收益时只能把这个钱包对该 mint 的全部卖出收入都压在这一次买入上，
--   遇到一个地址对同一币做多轮买卖的机器人就会虚高几个数量级。
--   单笔跟单收益必须按 token 数量做 FIFO 配对，所以要先落库买入的 token 数量。
--
-- 字段：
--   token_amount    这笔买入实际收到的 token 数量（原始单位，pump.fun 通常 6 位小数）
--   pnl_status      收益状态，区分「还没算 / 持仓中 / 已平仓 / 部分平仓 / 买入失败」
--   pnl_sold_ratio  这笔买入的 token 已被卖出的比例（0~1），部分平仓时 < 1

ALTER TABLE block_buyers
    ADD COLUMN IF NOT EXISTS token_amount   NUMERIC(40, 0),
    ADD COLUMN IF NOT EXISTS pnl_status     TEXT,
    ADD COLUMN IF NOT EXISTS pnl_sold_ratio NUMERIC(20, 9);

COMMENT ON COLUMN block_buyers.token_amount   IS '这笔买入收到的 token 数量，单笔跟单收益按它做 FIFO 配对';
COMMENT ON COLUMN block_buyers.pnl_status     IS 'open=持仓中 / closed=已平仓 / partial=部分平仓 / buy_failed=买入失败';
COMMENT ON COLUMN block_buyers.pnl_sold_ratio IS '该笔买入的 token 已卖出比例 0~1';

-- target_trades 也补上，作为 block_buyers 之外的第二条落点
-- （first-sniper 在目标 tx 不在 block 里时会回退到 target_trades 取买入信息）
ALTER TABLE target_trades
    ADD COLUMN IF NOT EXISTS target_token_amount NUMERIC(40, 0);

COMMENT ON COLUMN target_trades.target_token_amount IS '买入收到的 token 数量，单笔跟单收益的 FIFO 配对基数';
