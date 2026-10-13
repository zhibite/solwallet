-- 0016: block_analyses(target_signature) 索引
--
-- 背景：
--   recommendFeeForTarget / scoreMemberPnl 这类查询里频繁按
--   block_analyses.target_signature 过滤（拿到某笔 target_trades 对应的
--   block 级分析）。但 block_analyses 之前只有 (slot, mint) UNIQUE 和
--   idx_block_analyses_slot，没有 target_signature 上的索引。
--
--   没有这个索引时，Postgres 会走：
--     Seq Scan on block_analyses ba
--       Filter: (target_signature = t.signature)
--   而这个 LATERAL 在外层 target_trades 行上每行都跑一次：对于一个有
--   1490 条 target_trades 的 target，相当于 1490 × 7000 = 1000 万行 seq scan。
--   单条 recommendFeeForTarget 1.2 秒，/api/targets 15 target 全并发 1.1+ 秒，
--   「跟单抢单监控」页面首屏 / 自动刷新都明显卡顿。
--
-- 验证（实测，DB 规模 16 target / 7142 target_trades / 6997 block_analyses）：
--   加索引前 recommendFeeForTarget('Ar2Y6o1Q...')  : 1166 ms (buffers 292569)
--   加索引后 recommendFeeForTarget('Ar2Y6o1Q...')  :   36 ms (buffers 13730)
--   15 target 全并发 (recommendFee+scoreWorthFollowing):
--     加索引前 1130 ms
--     加索引后  168 ms
--
-- 索引选择：
--   target_signature 单列索引就够，target_signature 基数很高
--   （每笔 target_trades 一个），没必要建复合索引。

CREATE INDEX IF NOT EXISTS idx_block_analyses_target_signature
  ON block_analyses(target_signature);

ANALYZE block_analyses;
