-- 2009: 池子晋升标记与 monitored_targets 的状态一致性
--
-- 问题：
--   autoPromote / promotePoolMember 先 INSERT monitored_targets，再无条件把
--   pool_members.promoted_to_target 置 true。用户后续在页面上删除该监控目标时，
--   monitored_targets 的行被删掉，但池子里的标记还留着 —— 该地址既不会被监控，
--   也不会被 autoPromote 再次选中（promoted_to_target = false 过不去，
--   mt.id IS NULL 又满足），永久卡死。
--
-- 修复：
--   1) 新增 auto_promote_excluded：标记「这是被人工删掉的，不要自动再拉回来」。
--      删除监控目标时置 true，autoPromote 候选查询排除它。
--      人工点晋升时清零（显式意图覆盖自动策略）。
--   2) 删除监控目标时一并重置 promoted_to_target，让 autoPromote 的候选条件自洽。
--
-- 注意 promoted_to_target 的语义是「被池子系统晋升进过 monitored_targets」，
-- 不是「当前是 monitored_targets 里的一行」——手动添加的监控目标若也在池子里，
-- promoted_to_target = false 属于正常状态，不要当成漂移去改。

ALTER TABLE pool_members
    ADD COLUMN IF NOT EXISTS auto_promote_excluded BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN pool_members.auto_promote_excluded IS
    '人工删除监控目标后置 true，阻止 autoPromote 自动拉回；手动晋升时清零';

CREATE INDEX IF NOT EXISTS idx_pool_members_excluded
    ON pool_members (auto_promote_excluded)
    WHERE auto_promote_excluded = false;
