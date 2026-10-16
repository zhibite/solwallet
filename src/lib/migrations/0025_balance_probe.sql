-- 0025: 余额探测调度（balance probe）
--
-- 背景：
--   当前跟单 PnL 计算的"延迟"由三段构成：
--     1) cron 周期：*/15 分钟一次（vercel.json）
--     2) FIFO 翻签名：单 buyer ~1-2s，20 buyer block 约 5-10s
--     3) 429 退避：极端情况下整轮 compute-pnl 跑 6 分钟过不了 1 个 block
--
--   实测从「买入确认」到「PnL 写库」在 429 期间延迟 15-30 分钟。
--   用户视角：监控页面"第 2 层列表"的盈利数字长时间不出现，体感"卡死"。
--
--   解决思路：在 FIFO 翻签名之前加一道"读余额"快速路径：
--     - 买入后 1 分钟查 buyer 的 token ATA 余额（首次探测）
--     - 余额 = 0 → 100% 卖完，触发精算（直接调 calcCopyPnl）
--     - 余额 < 初始 → 有部分卖出，触发精算
--     - 余额 = 初始（1min 那点） → 推后 4 分钟到 5min 那点再探
--     - 5min 那点还没卖 → 交回 FIFO 兜底（10 分钟窗口）
--
--   余额查询 = 1 次 getTokenAccountsByOwner（节点本地查询，无历史扫描），
--   比起 FIFO 翻 N 个签名 + 拉 N 笔交易详情，RPC 压力下降 1-2 个数量级。
--
-- 为什么是"两点"（1min / 5min）而不是"1min × 5 = 5 次"：
--   经验上 pump 币"5 分钟内卖出"占比 < 50%，剩下 50%+ 是持仓套牢或 5+ 分钟才卖。
--   固定 1min × 5 对后 50% 是纯浪费（5 次 RPC 全白费），还会抢公共 RPC 配额。
--   两点方案：覆盖"5 分钟内卖出"这一关键窗口，最坏浪费 = 2 次 RPC。
--
-- 字段：
--   next_balance_check_at  下次探测时间（TIMESTAMPTZ，可空）
--                           买入入库时设 NOW()+1min（首次探测）
--                           1min 那点没卖 → 推 NOW()+4min（= 5min 那点）
--                           5min 那点还没卖 → 置 NULL（交回 FIFO 兜底）
--   balance_check_count    探测次数计数器
--                           count=0 → 1min 那点；count=1 → 5min 那点
--                           count >= 2 → 已交回 FIFO
--
-- 不影响现有 pnl_status 语义：
--   - 探测到"已卖"会调用 calcCopyPnl，后者会按 FIFO 写 pnl_sol / pnl_status
--   - pnl_status 变成 closed/partial 后，compute-pnl 主查询的过滤自动跳过
--   - 探测到"没卖" → 推后 next_balance_check_at，pnl_status 保持 open/NULL
--   - 5 次没卖 → 清 next_balance_check_at，等 FIFO cron 10 分钟窗口自然结束

ALTER TABLE block_buyers
    ADD COLUMN IF NOT EXISTS next_balance_check_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS balance_check_count   INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN block_buyers.next_balance_check_at IS
    '余额探测调度：买入后 1min 首次探测；探测到余额变化立即精算；连续 5 次没动置 NULL 交回 FIFO 兜底';
COMMENT ON COLUMN block_buyers.balance_check_count IS
    '累计余额探测次数；用于限制"一直不卖"的 buyer 不被无限探测';

-- 部分索引：和 0024 的 pending 索引类似思路
-- 覆盖真正会被探测的行：open / NULL（未算 / 持仓中）+ result='success'（买入成功）
-- 这正好是 balance-probe cron 一次 SELECT ... WHERE next_balance_check_at <= NOW() 的目标集
--
-- 不用 btree(next_balance_check_at) 是因为：
--   1) 大部分 buyer 的 next_balance_check_at 是 NULL，索引只覆盖热路径
--   2) WHERE pnl_status IN ('open', NULL) AND result='success' 的过滤放索引里，扫描量进一步缩小
--   3) 部分索引大小 = 当前 1 分钟探测窗口内的行数（通常 < 几百），毫秒级返回
CREATE INDEX IF NOT EXISTS idx_block_buyers_balance_probe
  ON block_buyers (next_balance_check_at)
  WHERE pnl_status IN ('open', NULL) AND result = 'success' AND next_balance_check_at IS NOT NULL;
