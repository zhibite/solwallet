'use server';

/**
 * akbot-executor
 *
 * 角色：把 agent 的 Decision 翻译成 akbot API 调用。
 *
 * 设计：
 *   - 不在 shadow 模式下调用（executor 那边已经按 shadow 决定是否调进来）
 *   - 失败不会抛 — 返回结构化结果，让上层写 akbot_call_log + agent_decisions.execution_error
 *   - 严格按决策类型路由，不擅自多做操作（不解释、不重试、不并联）
 *   - 所有需要全量字段的 update 都先 GET detail 再 merge 再 PUT（用户确认 merge_existing）
 */

import { query, queryOne } from '../db';
import { getAkbotClient, AkBotAddDTO, AkBotConfig, AkBuyDetail, AkCommonConfig } from '../akbot-client';
import { Decision } from './prompts';

/* ---------- 类型 ---------- */

export interface AkbotExecutionResult {
  ok: boolean;
  action: Decision['action'];
  targetId: number;
  /** shadow 模式下不调，返回 { skipped: true, reason: 'shadow_mode' } */
  skipped: boolean;
  reason?: string;
  /** 调用 akbot 用了哪个端点（用于 audit） */
  endpoint?: string;
  /** HTTP 状态 */
  httpStatus?: number;
  /** 业务错误/网络错误 */
  error?: string;
  /** 本次新建的 idConfig（add 时回填） */
  newIdConfig?: number;
  /** 本次 akbot 调用的请求 body（JSON.stringify 后），用于排错 */
  requestBody?: unknown;
  /** 本次 akbot 调用的响应 body（已 parse），用于排错 */
  responseBody?: unknown;
  /** 本次 akbot 调用的耗时 ms */
  durationMs?: number;
}

/**
 * 单个 step 的最小可记录结果 —— 让 multi-step（add → switch）能各自写一行 log。
 * 上层 executeOnAkbot 把 step result 收集起来一次性写 call_log。
 */
export interface AkbotStepResult {
  endpoint: string;
  httpStatus: number;
  ok: boolean;
  error?: string;
  requestBody?: unknown;
  responseBody?: unknown;
  durationMs: number;
  /** 业务字段：add 成功时回填的 idConfig */
  newIdConfig?: number;
}

/* ---------- DB helpers ---------- */

interface TargetRow {
  id: number;
  address: string;
  label: string | null;
  agent_params: Record<string, unknown> | null;
}

interface MapRow {
  monitored_target_id: number;
  akbot_id_config: number;
  akbot_user_id: number;
}

async function loadTarget(targetId: number): Promise<TargetRow | null> {
  return queryOne<TargetRow>(
    `SELECT id, address, label, agent_params FROM monitored_targets WHERE id = $1`,
    [targetId],
  );
}

async function loadMap(targetId: number): Promise<MapRow | null> {
  return queryOne<MapRow>(
    `SELECT monitored_target_id, akbot_id_config, akbot_user_id
     FROM akbot_target_map WHERE monitored_target_id = $1`,
    [targetId],
  );
}

/**
 * Race-safe: 多 worker 并发跑同一 target 的 enable/limit_update 时，
 * 多个 addConfig 都会成功（产生孤儿 config），saveMap 改用 ON CONFLICT DO NOTHING
 * + RETURNING idConfig，让第一个落库的人赢；其它人拿不到行就 re-load 现有 map。
 *
 * 返回值：
 *   { winner: 'self',  idConfig } — 本次 INSERT 成功，本次用这个 idConfig
 *   { winner: 'other', idConfig } — 本次没 INSERT（被并发抢先），re-load 出的现有 idConfig
 */
async function saveMapRaceSafe(
  targetId: number,
  idConfig: number,
  userId: number,
): Promise<{ winner: 'self' | 'other'; idConfig: number; userId: number }> {
  const rows = await query<{ akbot_id_config: number; akbot_user_id: number }>(
    `INSERT INTO akbot_target_map (monitored_target_id, akbot_id_config, akbot_user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (monitored_target_id) DO NOTHING
     RETURNING akbot_id_config, akbot_user_id`,
    [targetId, idConfig, userId],
  );
  if (rows[0]) {
    return { winner: 'self', idConfig: rows[0].akbot_id_config, userId: rows[0].akbot_user_id };
  }
  // 被并发抢先了，re-load 现有映射用对方的 idConfig
  const cur = await loadMap(targetId);
  if (!cur) {
    // 极端：并发也删了。不应该发生，但兜底用自己 add 出来的 idConfig
    return { winner: 'self', idConfig, userId };
  }
  return { winner: 'other', idConfig: cur.akbot_id_config, userId: cur.akbot_user_id };
}

async function removeMap(targetId: number): Promise<void> {
  await query(
    `DELETE FROM akbot_target_map WHERE monitored_target_id = $1`,
    [targetId],
  );
}

/* ---------- 决策路由 ---------- */

export interface AkbotCallOutcome {
  result: AkbotExecutionResult;
  /** 这次决策走过的所有 step —— 上层用这个写多行 akbot_call_log */
  steps: AkbotStepResult[];
}

/** helper alias */
type RunOutcome = { result: AkbotExecutionResult; steps: AkbotStepResult[] };

export async function executeOnAkbot(
  targetId: number,
  decision: Decision,
  shadow: boolean,
): Promise<AkbotCallOutcome> {
  // hold 在 akbot 层不需要操作
  if (decision.action === 'hold') {
    return {
      result: { ok: true, action: 'hold', targetId, skipped: true, reason: 'hold' },
      steps: [],
    };
  }

  if (shadow) {
    return {
      result: { ok: true, action: decision.action, targetId, skipped: true, reason: 'shadow_mode' },
      steps: [],
    };
  }

  const target = await loadTarget(targetId);
  if (!target) {
    return {
      result: {
        ok: false, action: decision.action, targetId,
        skipped: false, error: `target ${targetId} not found`,
      },
      steps: [],
    };
  }

  switch (decision.action) {
    case 'enable':      return runEnable(target, decision);
    case 'disable':     return runDisable(target, decision);
    case 'delete':      return runDelete(target, decision);
    case 'limit_update':return runLimitUpdate(target, decision);
    default: {
      const exhaustive: never = decision.action;
      return {
        result: {
          ok: false, action: exhaustive, targetId,
          skipped: false, error: `unsupported action: ${String(exhaustive)}`,
        },
        steps: [],
      };
    }
  }
}

/* ---------- 单个 action 实现 ---------- */

async function runEnable(
  target: TargetRow,
  decision: Decision,
): Promise<RunOutcome> {
  const client = getAkbotClient();
  const steps: AkbotStepResult[] = [];

  const map = await loadMap(target.id);

  // 已有映射 → 直接 switch（一行 step）
  if (map) {
    const r = await withAkbotGate(() => client.switchConfigs([map.akbot_id_config], true));
    steps.push({
      endpoint: '/akBot/switch/config', httpStatus: r.status, ok: r.ok,
      ...(r.ok ? {} : { error: r.error ?? 'unknown' }),
      durationMs: r.durationMs,
      requestBody: { enableSwitch: 1, idConfigs: [map.akbot_id_config] },
      responseBody: r.body,
    });
    return fromSteps(steps, decision, target.id);
  }

  // 没映射 → add (step 1) + saveMap + switch (step 2)
  // add 端点响应 data 字段是新建的 idConfig（integer），不是 DTO 本身 —— 见 akbot-client.ts
  const addDto = buildAddDtoFromTarget(target);
  const addRes = await withAkbotGate(() => client.addConfig(addDto));
  steps.push({
    endpoint: '/akBot/add', httpStatus: addRes.status, ok: addRes.ok,
    ...(addRes.ok ? {} : { error: addRes.error ?? 'unknown' }),
    durationMs: addRes.durationMs,
    requestBody: addDto,
    responseBody: addRes.body,
  });
  if (!addRes.ok || addRes.body?.data === undefined || addRes.body?.data === null) {
    return fromSteps(steps, decision, target.id);
  }
  // Fix #18：addConfig 回包里没 userId，只能从 ping 拿
  const newId = addRes.body.data;
  const userId = await loadUserIdFromGlobal();
  if (!newId || !userId) {
    steps.push({
      endpoint: '/akBot/add',
      httpStatus: addRes.status,
      ok: false,
      error: !newId
        ? 'addConfig returned no idConfig'
        : 'akbot userId 未配置（AKBOT_API_KEY 错？或 /globalConfig 返了空 userId）',
      durationMs: 0,
    });
    return fromSteps(steps, decision, target.id);
  }

  // Fix #19：race-safe saveMap
  const saved = await saveMapRaceSafe(target.id, newId, userId);
  // 若是 'other'，我们 add 出来的 config 在 akbot 上是孤儿 —— 删掉它
  if (saved.winner === 'other') {
    const cleanup = await withAkbotGate(() => client.deleteConfigs([newId]));
    steps.push({
      endpoint: '/akBot/delete/v2',
      httpStatus: cleanup.status,
      ok: cleanup.ok,
      ...(cleanup.ok ? {} : { error: `orphan cleanup failed: ${cleanup.error}` }),
      durationMs: cleanup.durationMs,
      requestBody: [newId],
      responseBody: cleanup.body,
    });
    // 即便 cleanup 失败也不致命：akbot 端多一个孤儿 config，等下次人工巡检时清
  }

  // 用最终落库的 idConfig 做 switch（add 后默认 enableSwitch=0）
  const swRes = await withAkbotGate(() => client.switchConfigs([saved.idConfig], true));
  steps.push({
    endpoint: '/akBot/switch/config', httpStatus: swRes.status, ok: swRes.ok,
    ...(swRes.ok ? {} : { error: swRes.error ?? 'unknown' }),
    durationMs: swRes.durationMs,
    requestBody: { enableSwitch: 1, idConfigs: [saved.idConfig] },
    responseBody: swRes.body,
    newIdConfig: saved.idConfig,
  });
  return fromSteps(steps, decision, target.id, saved.idConfig);
}

async function runDisable(
  target: TargetRow,
  decision: Decision,
): Promise<RunOutcome> {
  const client = getAkbotClient();
  const map = await loadMap(target.id);
  if (!map) {
    // 没映射：本地已经是 paused/disabled 状态，akbot 端也本来就停 — 当作 OK
    return {
      result: {
        ok: true, action: decision.action, targetId: target.id,
        skipped: true, reason: 'no_akbot_mapping',
      },
      steps: [],
    };
  }
  const r = await withAkbotGate(() => client.switchConfigs([map.akbot_id_config], false));
  const step: AkbotStepResult = {
    endpoint: '/akBot/switch/config', httpStatus: r.status, ok: r.ok,
    ...(r.ok ? {} : { error: r.error ?? 'unknown' }),
    durationMs: r.durationMs,
    requestBody: { enableSwitch: 0, idConfigs: [map.akbot_id_config] },
    responseBody: r.body,
  };
  return fromSteps([step], decision, target.id);
}

async function runDelete(
  target: TargetRow,
  decision: Decision,
): Promise<RunOutcome> {
  const client = getAkbotClient();
  const map = await loadMap(target.id);
  if (!map) {
    return {
      result: {
        ok: true, action: decision.action, targetId: target.id,
        skipped: true, reason: 'no_akbot_mapping',
      },
      steps: [],
    };
  }
  const r = await withAkbotGate(() => client.deleteConfigs([map.akbot_id_config]));
  const step: AkbotStepResult = {
    endpoint: '/akBot/delete/v2', httpStatus: r.status, ok: r.ok,
    ...(r.ok ? {} : { error: r.error ?? 'unknown' }),
    durationMs: r.durationMs,
    requestBody: [map.akbot_id_config],
    responseBody: r.body,
  };
  if (!r.ok) {
    return fromSteps([step], decision, target.id);
  }
  // 删了以后本地映射也没意义了
  await removeMap(target.id);
  return fromSteps([step], decision, target.id);
}

async function runLimitUpdate(
  target: TargetRow,
  decision: Decision,
): Promise<RunOutcome> {
  const client = getAkbotClient();
  const params = decision.params;
  if (!params) {
    return {
      result: {
        ok: false, action: decision.action, targetId: target.id,
        skipped: false, error: 'limit_update with empty params',
      },
      steps: [],
    };
  }

  const steps: AkbotStepResult[] = [];
  // Fix #20：先记一份「失败时回滚用」的旧 map
  const oldMap = await loadMap(target.id);
  let map = oldMap;

  // 罕见：LLM 给没映射的目标调参 → 先 add
  if (!map) {
    const addDto = buildAddDtoFromTarget(target);
    const addRes = await withAkbotGate(() => client.addConfig(addDto));
    steps.push({
      endpoint: '/akBot/add', httpStatus: addRes.status, ok: addRes.ok,
      ...(addRes.ok ? {} : { error: addRes.error ?? 'unknown' }),
      durationMs: addRes.durationMs,
      requestBody: addDto,
      responseBody: addRes.body,
    });
    if (!addRes.ok || addRes.body?.data === undefined || addRes.body?.data === null) {
      return fromSteps(steps, decision, target.id);
    }
    const newId = addRes.body.data;
    const userId = await loadUserIdFromGlobal();
    if (!newId || !userId) {
      steps.push({
        endpoint: '/akBot/add',
        httpStatus: addRes.status,
        ok: false,
        error: !newId ? 'addConfig returned no idConfig' : 'userId 不可用',
        durationMs: 0,
      });
      return fromSteps(steps, decision, target.id);
    }

    // race-safe saveMap
    const saved = await saveMapRaceSafe(target.id, newId, userId);
    if (saved.winner === 'other') {
      const cleanup = await withAkbotGate(() => client.deleteConfigs([newId]));
      steps.push({
        endpoint: '/akBot/delete/v2',
        httpStatus: cleanup.status,
        ok: cleanup.ok,
        ...(cleanup.ok ? {} : { error: `orphan cleanup failed: ${cleanup.error}` }),
        durationMs: cleanup.durationMs,
        requestBody: [newId],
        responseBody: cleanup.body,
      });
    }
    map = { monitored_target_id: target.id, akbot_id_config: saved.idConfig, akbot_user_id: saved.userId };
  }

  // 取现有详细配置，merge，再整体 update
  const detail = await withAkbotGate(() => client.getConfigDetail(map!.akbot_id_config));
  steps.push({
    endpoint: '/akBot/getConfigDetail',
    httpStatus: detail.status,
    ok: detail.ok,
    ...(detail.ok ? {} : { error: detail.error ?? 'unknown' }),
    durationMs: detail.durationMs,
    requestBody: { idConfig: map.akbot_id_config },
    responseBody: detail.body,
  });
  if (!detail.ok || !detail.body?.data) {
    return rollbackOnFailure(steps, decision, target, oldMap);
  }
  const merged = mergeDecisionParams(detail.body.data, params);
  const updRes = await withAkbotGate(() => client.updateConfig({ ...merged, idConfig: map!.akbot_id_config }));
  steps.push({
    endpoint: '/akBot/update', httpStatus: updRes.status, ok: updRes.ok,
    ...(updRes.ok ? {} : { error: updRes.error ?? 'unknown' }),
    durationMs: updRes.durationMs,
    requestBody: { ...merged, idConfig: map.akbot_id_config },
    responseBody: updRes.body,
  });
  if (!updRes.ok) {
    return rollbackOnFailure(steps, decision, target, oldMap);
  }
  return fromSteps(steps, decision, target.id, map.akbot_id_config);
}

/**
 * limit_update 在 addConfig 成功但后续 getConfigDetail/updateConfig 失败时回滚：
 *   - 若之前没映射 → 把刚 saveMap 进去的行删掉（让 akbot 端孤儿留着，等人工清）
 *   - 若之前有旧映射 → 恢复到旧 idConfig
 */
async function rollbackOnFailure(
  steps: AkbotStepResult[],
  decision: Decision,
  target: TargetRow,
  oldMap: MapRow | null,
): Promise<RunOutcome> {
  const cur = await loadMap(target.id);
  if (!cur) {
    // 还没 saveMap 进去（add 之前就失败了），不需要回滚
    return fromSteps(steps, decision, target.id);
  }
  if (oldMap) {
    // 恢复成原 idConfig
    await query(
      `UPDATE akbot_target_map
         SET akbot_id_config = $2, akbot_user_id = $3, updated_at = NOW()
       WHERE monitored_target_id = $1`,
      [target.id, oldMap.akbot_id_config, oldMap.akbot_user_id],
    );
  } else {
    // 本次是新增映射，删掉
    await removeMap(target.id);
  }
  return fromSteps(steps, decision, target.id);
}

/* ---------- 工具函数 ---------- */

/**
 * 把多步 step 聚合成对外的 result：
 *   - overall.ok = 所有 step 都 ok（任一失败则 false）
 *   - endpoint / httpStatus / error / newIdConfig 取自「最后一个」step
 *     这样 UI 看到的还是「最关键的那一步」的状态，不会因为中间 add 失败就报
 *     错到 switch 端点（switch 根本没发生）
 *   - requestBody / responseBody / durationMs 也取自最后一个 step（让单行展示
 *     完整），多步完整记录走 executor 那边用 steps 写多行 log
 */
function fromSteps(
  steps: AkbotStepResult[],
  decision: Decision,
  targetId: number,
  newIdConfig?: number,
): RunOutcome {
  if (steps.length === 0) {
    return {
      result: { ok: true, action: decision.action, targetId, skipped: true },
      steps: [],
    };
  }
  const last = steps[steps.length - 1];
  const overallOk = steps.every((s) => s.ok);
  const firstFailure = steps.find((s) => !s.ok);
  return {
    result: {
      ok: overallOk,
      action: decision.action,
      targetId,
      skipped: false,
      endpoint: last.endpoint,
      httpStatus: last.httpStatus,
      ...(firstFailure ? { error: firstFailure.error ?? 'unknown' } : {}),
      requestBody: last.requestBody,
      responseBody: last.responseBody,
      durationMs: steps.reduce((acc, s) => acc + (s.durationMs || 0), 0),
      ...(newIdConfig !== undefined ? { newIdConfig } : {}),
    },
    steps,
  };
}

/**
 * 缓存 akbot userId。
 *
 * Fix #18：原版只缓存成功结果，akbot 启动期 ping 抖一下就 userId=null 卡住 5 分钟；
 * 失败也缓存 30s，避免每个 target 重新 ping 一次把 akbot 打挂。
 * 成功用 5 分钟缓存（userId 是账户级标识，不会动态变）。
 *
 * 取值优先级：addConfig 回包里的 akCommonConfig.userId > ping 的 userId。
 * 这样即使 ping 暂时失败，只要 add 成功就拿得到 userId。
 */
let cachedUserId: { value: number; until: number } | null = null;
let negativeUserIdCache: { until: number } | null = null;
const USER_ID_CACHE_MS = 5 * 60 * 1000;
const USER_ID_NEG_TTL_MS = 30 * 1000;

async function loadUserIdFromGlobal(): Promise<number | null> {
  const now = Date.now();
  if (cachedUserId && cachedUserId.until > now) {
    return cachedUserId.value;
  }
  if (negativeUserIdCache && negativeUserIdCache.until > now) {
    return null;
  }
  const client = getAkbotClient();
  const r = await client.ping();
  const v = r.body?.data?.userId ?? null;
  if (v && typeof v === 'number' && v > 0) {
    cachedUserId = { value: v, until: now + USER_ID_CACHE_MS };
  } else {
    negativeUserIdCache = { until: now + USER_ID_NEG_TTL_MS };
  }
  return v;
}

/**
 * akbot API 熔断 + 并发闸（Fix #17）。
 *
 * 背景：runner.ts CONCURRENCY=3 起 worker，每 worker 内可能一次调 1-3 个 akbot 接口
 * (add → saveMap → switch)。一轮 round 跑下来几十个并发 HTTP 同时砸 akbot，
 * 限流 429 后整轮 fail，UI 全标红。
 *
 * 抄 akbot.ts 的模式：
 *   - 6 个并发槽，其余排队
 *   - 命中 429/5xx/网络错误 → 拉 30s 熔断，期间直接返回 circuit-open
 *   - 熔断期内不让新调用进，但已经在 in-flight 的继续（不会泄漏到外层）
 */
const MAX_CONCURRENT_AKBOT = 6;
const AKBOT_CIRCUIT_MS = 30_000;

let akbotInFlight = 0;
let akbotCircuitOpenUntil = 0;
const akbotQueue: Array<() => void> = [];

function isAkbotCircuitOpen(): boolean {
  return Date.now() < akbotCircuitOpenUntil;
}

function tripAkbotCircuit(reason: string): void {
  const until = Date.now() + AKBOT_CIRCUIT_MS;
  if (until > akbotCircuitOpenUntil) {
    akbotCircuitOpenUntil = until;
    console.warn(`[akbot-api] 熔断 ${AKBOT_CIRCUIT_MS / 1000}s (${reason})`);
  }
}

async function acquireAkbotSlot(): Promise<void> {
  if (akbotInFlight < MAX_CONCURRENT_AKBOT) {
    akbotInFlight++;
    return;
  }
  await new Promise<void>((resolve) => akbotQueue.push(resolve));
}

function releaseAkbotSlot(): void {
  const next = akbotQueue.shift();
  if (next) {
    next();
  } else {
    akbotInFlight--;
  }
}

function isRateLikeFailure(r: { status: number; error?: string }): boolean {
  if (r.status === 0 || r.status === 429 || (r.status >= 500 && r.status < 600)) {
    return true;
  }
  const m = r.error ?? '';
  return /429|too many requests|rate limit|请求过多|超出请求频率/i.test(m);
}

/**
 * 给 akbot API 调用加闸 + 熔断。传入 fetch 闭包，返回 AkResult 或熔断标记。
 * 不在熔断期时调闭包；在熔断期时直接返回 ok:false 标记。
 */
async function withAkbotGate<T>(fn: () => Promise<{
  ok: boolean; status: number; body: T | null; error?: string; durationMs: number;
}>): Promise<{ ok: boolean; status: number; body: T | null; error?: string; durationMs: number }> {
  if (isAkbotCircuitOpen()) {
    return {
      ok: false, status: 0, body: null,
      error: 'akbot_api_circuit_open',
      durationMs: 0,
    };
  }
  await acquireAkbotSlot();
  try {
    const r = await fn();
    if (isRateLikeFailure(r)) {
      tripAkbotCircuit(`status=${r.status} err=${r.error?.slice(0, 60) ?? ''}`);
    }
    return r;
  } finally {
    releaseAkbotSlot();
  }
}

/** 从本地 target 构造一个最小可用的 add DTO（用全局 sellTip/sellGas + 默认值） */
function buildAddDtoFromTarget(target: TargetRow): AkBotAddDTO {
  const params = (target.agent_params ?? {}) as Record<string, number | boolean>;

  const buyDetail: AkBuyDetail = {
    buyMode: 1,                                            // 固定金额
    buyAmount: clampNumber(params.position_sol, 0.01, 60, 1.0),
    tipFee: clampNumber(params.tip_sol, 0.0001, 100, 0.001),
    gasFee: clampNumber(params.gas_sol, 0.000005, 20, 0.001),
    slippageBuy: clampNumber(params.slippage, 0, 500, 20), // 百分比
    slippageMode: 0,                                        // 0=%
    highGasMode: params.high_gas_mode ? 1 : 0,
    highGas: clampNumber(params.high_gas_sol, 0, 60, 0.01),
    highGasTip: clampNumber(params.high_gas_tip_sol, 0, 100, 0.01),
    highGasSlippage: clampNumber(params.high_gas_slippage, 0, 500, 30),
  };

  const common: AkCommonConfig = {
    enableSwitch: 0,                                        // add 后默认关
    copyAddressNote: target.label ?? '',
    firstPurchaseSwitch: 1,
    positionFollowSwitch: 0,
    followSellPctMode: 0,
    followClearPct: 100,
    addressBlacklist: '',
    copyMinAmount: 0,
    copyMaxAmount: 60,
    akCopyAddresses: [{ copyAddress: target.address }],
    akConfigLabels: [],
  };

  return {
    akCommonConfig: common,
    akBuyDetails: [buyDetail],
    // 止盈止损先不填，让 akbot 用默认（用户原决策没指定就别瞎填）
  };
}

/** merge_existing：把决策 params 合并到现有 detail，覆盖 LLM 提到的字段 */
function mergeDecisionParams(
  detail: AkBotConfig,
  params: NonNullable<Decision['params']>,
): AkBotAddDTO {
  const result: AkBotAddDTO = {
    akCommonConfig: { ...detail.akCommonConfig },
    akBuyDetails: detail.akBuyDetails.map((d) => ({ ...d })),
    akProfitTpSegments: detail.akProfitTpSegments?.map((s) => ({ ...s })),
    akLossSegments: detail.akLossSegments?.map((s) => ({ ...s })),
  };

  // Fix #14：用户可能在 akbot 端配了 N 个 buy detail（多账户/多策略），但 agent
  // 只动 [0]。保留 [1..N] 原始值不动是安全的，但运维可能不知道 [1..N] 没被同步。
  // 留个 warn 让 akbot_call_log / 排错时能搜到。
  if (result.akBuyDetails.length > 1) {
    console.warn(
      `[akbot-executor] target 有 ${result.akBuyDetails.length} 个 buy detail，agent 只动 [0]，其余保持原样`,
    );
  }

  // akBuyDetails[0] 是我们主要改的
  if (result.akBuyDetails.length === 0) {
    result.akBuyDetails.push({
      buyMode: 1, buyAmount: 1, tipFee: 0.001, gasFee: 0.001,
      slippageBuy: 20, slippageMode: 0, highGasMode: 0,
    });
  }
  const d = result.akBuyDetails[0];
  if ('position_sol' in params)   d.buyAmount        = clampNumber(params.position_sol as number, 0.01, 60, d.buyAmount);
  if ('tip_sol' in params)        d.tipFee           = clampNumber(params.tip_sol as number, 0.0001, 100, d.tipFee);
  if ('gas_sol' in params)        d.gasFee           = clampNumber(params.gas_sol as number, 0.000005, 20, d.gasFee);
  if ('slippage' in params)       d.slippageBuy      = clampNumber(params.slippage as number, 0, 500, d.slippageBuy);
  if ('high_gas_mode' in params)  d.highGasMode      = (params.high_gas_mode as boolean) ? 1 : 0;
  if ('high_gas_sol' in params)   d.highGas          = clampNumber(params.high_gas_sol as number, 0, 60, d.highGas ?? 0);
  if ('high_gas_tip_sol' in params) d.highGasTip     = clampNumber(params.high_gas_tip_sol as number, 0, 100, d.highGasTip ?? 0);
  if ('high_gas_slippage' in params) d.highGasSlippage = clampNumber(params.high_gas_slippage as number, 0, 500, d.highGasSlippage ?? 0);

  return result;
}

function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
