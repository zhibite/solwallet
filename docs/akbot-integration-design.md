# akbot 集成设计

> 状态：2026-10-11 复核更新。代码与本文档已对齐。

## 决策回顾
- 钱包：env `AKBOT_WALLET_PRIVATE_KEY`（不入 git）
- id 映射：新建 `akbot_target_map` 表
- 新目标：executor 自动 add（**隐式**，不暴露成独立 LLM action）
- shadow_mode：保留原行为（shadow 下不调 akbot）

## 新增 / 修改文件

### 新增
1. `src/lib/akbot-client.ts` — 封装 akbot API 的 typed client（lazy 单例）
2. `src/lib/agent/akbot-executor.ts` — 在 agent executor 之后调 akbot 的 adapter
3. `src/lib/migrations/0013_akbot_target_map.sql` — 映射表 + call_log
4. `src/lib/migrations/0014_agent_shadow_default_true.sql` — 新 target 默认 shadow=TRUE
5. `scripts/setup-akbot-wallet.ts` — 一次性脚本：导入钱包（跑完删）
6. `src/lib/akbot.ts` — akbot 用户识别（独立功能：检测链上是否用了 akbot program）

### 修改
1. `src/lib/agent/executor.ts` — 在写库后调 `akbot-executor`，写多行 akbot_call_log
2. `src/lib/agent/snapshot.ts` — 暴露 `akbot_id_config` 到 LLM 上下文
3. `src/lib/agent/prompts.ts` — 决策空间：enable / disable / delete / limit_update / hold
4. `src/lib/agent/decide.ts` — 同上 action 解析
5. `.env.example` — 加 `AKBOT_API_KEY` / `AKBOT_BASE_URL` / `AKBOT_WALLET_PRIVATE_KEY`
6. `package.json` — 暂时不需要新依赖（用 Node 自带 fetch）

### 未实现 / 不再需要
- ~~`src/app/api/akbot/import-wallet/route.ts`~~ — 改用 `scripts/setup-akbot-wallet.ts` 一次性脚本
- ~~LLM 端的 `add` action~~ — 改成「enable / limit_update 隐式 add」，决策空间更小

## 数据库表

```sql
-- 0013_akbot_target_map.sql
CREATE TABLE akbot_target_map (
  monitored_target_id  INTEGER PRIMARY KEY REFERENCES monitored_targets(id) ON DELETE CASCADE,
  akbot_id_config      INTEGER NOT NULL,
  akbot_user_id        INTEGER NOT NULL,        -- 通常 1263，避免 hardcode
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_akbot_target_map_idconfig ON akbot_target_map(akbot_id_config);

-- 记录每次 akbot 调用的结果（用于排错 + 审计）
CREATE TABLE akbot_call_log (
  id              BIGSERIAL PRIMARY KEY,
  agent_decision_id INTEGER REFERENCES agent_decisions(id) ON DELETE SET NULL,
  monitored_target_id INTEGER REFERENCES monitored_targets(id) ON DELETE CASCADE,
  action          TEXT NOT NULL,                 -- add/update/switch/delete
  endpoint        TEXT NOT NULL,                 -- /akBot/switch/config etc.
  request_body    JSONB,
  response_status INTEGER,
  response_body   JSONB,
  ok              BOOLEAN NOT NULL,
  error_message   TEXT,
  duration_ms     INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_akbot_call_log_target_time ON akbot_call_log(monitored_target_id, created_at DESC);
```

## client 接口签名

```ts
// src/lib/akbot-client.ts
export interface AkBotClient {
  // 基础
  getGlobalConfig(): Promise<AkGlobalConfig | null>;
  
  // 配置 CRUD
  listConfigs(query: ListQuery): Promise<AkBotConfig[]>;
  getConfigDetail(idConfig: number): Promise<AkBotConfig | null>;
  addConfig(dto: AkBotAddDTO): Promise<number>;          // 返回 idConfig
  updateConfig(dto: AkBotAddDTO & { idConfig: number }): Promise<boolean>;
  switchConfigs(idConfigs: number[], on: boolean): Promise<boolean>;
  deleteConfigs(idConfigs: number[]): Promise<boolean>;
  
  // 健康检查
  ping(): Promise<boolean>;
}
```

`AkBotConfig` 内部包含 `akCommonConfig.akCopyAddresses[0].copyAddress`、`akBuyDetails[0]` 等完整结构。

## executor 改造

```ts
// src/lib/agent/akbot-executor.ts
export async function executeOnAkbot(
  targetId: number,
  decision: Decision,
  shadow: boolean
): Promise<AkbotExecutionResult> {
  if (shadow) return { skipped: true, reason: 'shadow_mode' };
  
  const target = await loadTarget(targetId);     // 取 address/label/agent_params
  const map = await loadAkbotMap(targetId);
  
  switch (decision.action) {
    case 'enable':
    case 'disable':
      if (!map) {
        // 没映射 → 自动 add
        const idConfig = await client.addConfig(buildAddDto(target));
        await saveAkbotMap(targetId, idConfig);
        if (decision.action === 'enable') {
          // add 完默认 enableSwitch=0，enable 还要再 switch
          await client.switchConfigs([idConfig], true);
        }
      } else {
        await client.switchConfigs([map.akbot_id_config], decision.action === 'enable');
      }
      break;
    
    case 'delete':
      if (map) {
        await client.deleteConfigs([map.akbot_id_config]);
        await removeAkbotMap(targetId);
      }
      // 本地 status='deleted' 在前一步已经做了
      break;
    
    case 'limit_update':
      if (!map) {
        // 罕见：LLM 给没映射的目标调参 → 先 add
        const idConfig = await client.addConfig(buildAddDto(target));
        await saveAkbotMap(targetId, idConfig);
        map = { akbot_id_config: idConfig };
      }
      const detail = await client.getConfigDetail(map.akbot_id_config);
      if (!detail) throw new Error('config detail missing');
      const merged = mergeParamsIntoDetail(detail, decision.params);
      await client.updateConfig({ idConfig: map.akbot_id_config, ...merged });
      break;
    
    case 'hold':
      // 啥也不做
      break;
  }
  
  return { skipped: false, ok: true };
}
```

## 失败处理

- akbot 调用失败 → 仍然写本地 DB（`agent_decisions.executed=true`），但记录 `execution_error` + `akbot_call_log.ok=false`
- 关键决策（enable/disable/delete）失败时返回 `executed=false`，让 UI 标红
- 不做重试（避免重复 add 产生脏数据）；UI 提供「重试」按钮时再调
- 所有调用都过 `akbot_call_log`（多步序列如 add→switch 写多行），方便排错
- **熔断 + 并发闸**：`akbot-executor.ts` 内置 6 并发槽 + 30s 熔断（命中 429/5xx/网络错误拉下）
  —— 抄 `src/lib/akbot.ts` 的 Helius 闸模式，避免一轮 round 几十个并发 HTTP 把 akbot 打挂
- **userId 缓存**：成功缓存 5min，失败负缓存 30s（Fix #18）
- **saveMap race-safe**：`ON CONFLICT DO NOTHING RETURNING` + re-load，避免并发 add 产生孤儿 config（Fix #19）
- **limit_update 回滚**：add 成功但后续 getConfigDetail/updateConfig 失败时，把刚 saveMap 进去的行
  删掉 / 恢复成旧 idConfig，避免本地 map 指向永远跟不上的 config（Fix #20）

## 跑通步骤（人工）

1. 把 key 加到 `.env.local`：
   ```
   AKBOT_BASE_URL=https://api.akbot.pro/api
   AKBOT_API_KEY=<从 akbot 后台拿>
   AKBOT_WALLET_PRIVATE_KEY=<base58 私钥>
   ```
2. 跑迁移：`npm run migrate`（应用 0013、0014）
3. 一次性导入钱包：`npm run setup:akbot` → `npx tsx scripts/setup-akbot-wallet.ts` —— 这步跑完就不要再跑，会覆盖
4. agent 后台从 shadow_mode=true 跑几轮验证 → 切到 false
   - 修改 `monitored_targets.agent_shadow=FALSE` 给要实盘的 target
   - 或者改全局 `AGENT_SHADOW_MODE=false`

## 不在本次范围

- 钱包余额查询（akbot 没暴露这个接口，跳过）
- 自动重试队列（先简单 log，等出问题再加）
- 多个 wallet 切换（先单 wallet）
- akbot 自己的 sell tip/gas 优化（先用全局 sellTip/sellGas）
- LLM 端主动 add 决策（已合并成 enable/limit_update 隐式 add）
