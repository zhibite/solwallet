-- 0022: pnl_status 新增 'stale' 值（过期不处理）
--
-- 背景：
--   之前 cron 的处理窗口是 7 天，导致历史积压的 block_buyers.pnl_status IS NULL 行
--   反复被拉到，挤占新 block 的并发额度，新数据得不到及时解析（典型 102 待分析积压）。
--
--   把窗口缩到 2 小时后，超出窗口的旧待分析行不再被 cron 拉到。
--   但仅靠窗口过滤还不够 —— 这些行还在数据库里、还在 UI 上以"待算"显示，
--   用户每次看都觉得"还有 102 条没算"，但其实系统已经主动放弃。
--
--   引入 'stale' 状态值显式标记"过期不处理"，让：
--     1) cron 查询只 pick pnl_status IS NULL 的行 → 天然跳过 stale
--     2) GET 状态统计区分 pending / stale → pending=实时新数据，stale=历史积压
--     3) UI 区分 "算中"（pnl_status IS NULL）和 "已过期"（pnl_status='stale'） →
--        用户不会再误以为这些行在等
--
-- 字段含义（pnl_status）：
--   null         = 待计算（最新进入的，新数据优先解析）
--   'open'       = 持仓中
--   'partial'    = 部分平仓
--   'closed'     = 已平仓
--   'buy_failed' = 买入交易失败
--   'stale'      = 过期不处理（>2h 仍 NULL，被 cron 主动标 stale）
--
-- 不做 ALTER：pnl_status 字段类型已经是 TEXT，新值不需要 schema 变更。
-- 只需要更新 COMMENT 文档化新值（运维 / 排错用）。

COMMENT ON COLUMN block_buyers.pnl_status IS
    'open=持仓中 / closed=已平仓 / partial=部分平仓 / buy_failed=买入失败 / '
    'stale=过期不处理（>2h 仍 NULL，由 cron 主动标 stale，不再参与计算）';
