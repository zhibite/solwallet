-- 0013_akbot_target_map.sql
-- 目的：把我们本地的 monitored_targets.id 映射到 akbot 服务端的 idConfig
-- 解决两个问题：
--   1) agent 决策 enable/disable/limit_update/delete 时需要把 target → akbot config
--   2) 调用日志留底，方便排错（akbot 端只能看到 200/4xx，不能看到完整 payload）

CREATE TABLE akbot_target_map (
  monitored_target_id  INTEGER PRIMARY KEY REFERENCES monitored_targets(id) ON DELETE CASCADE,
  akbot_id_config      INTEGER NOT NULL,
  akbot_user_id        INTEGER NOT NULL,           -- 避免代码里 hardcode 1263
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_akbot_target_map_idconfig ON akbot_target_map(akbot_id_config);

-- 每次调 akbot 的请求/响应都落库。失败也落，方便事后复盘。
-- agent_decisions.execution_error 写太细太冗长，单独放这。
CREATE TABLE akbot_call_log (
  id                   BIGSERIAL PRIMARY KEY,
  agent_decision_id    INTEGER REFERENCES agent_decisions(id) ON DELETE SET NULL,
  monitored_target_id  INTEGER REFERENCES monitored_targets(id) ON DELETE CASCADE,
  action               TEXT NOT NULL,              -- enable/disable/delete/limit_update/hold
  endpoint             TEXT NOT NULL,              -- /akBot/switch/config 等
  request_body         JSONB,
  response_status      INTEGER,
  response_body        JSONB,
  ok                   BOOLEAN NOT NULL,
  error_message        TEXT,
  duration_ms          INTEGER,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_akbot_call_log_target_time ON akbot_call_log(monitored_target_id, created_at DESC);
CREATE INDEX idx_akbot_call_log_decision ON akbot_call_log(agent_decision_id);
CREATE INDEX idx_akbot_call_log_failed ON akbot_call_log(ok, created_at DESC) WHERE ok = FALSE;
