/**
 * WebSocket 实时监控模块
 *
 * 使用 Solana 原生 WebSocket (logsSubscribe) 实时监听：
 * 1. 目标地址的交易（直接订阅，零延迟）
 * 2. Raydium 流动性池初始化（新币发现）
 *
 * 相比轮询的优势：
 * - 毫秒级延迟，而非轮询的 5-15 秒
 * - 不漏掉任何交易
 * - 资源消耗更低
 *
 * 与轮询的关系：
 * - WebSocket 是主要数据源，保证实时性
 * - 轮询作为 WebSocket 断开时的兜底，以及历史数据补扫
 */

import { Connection, Context, PublicKey } from '@solana/web3.js';
import { query } from './db';
import { parseHeliusTx, solanaTxToHeliusEnhanced } from './parser';
import { saveBlockAnalysis, applyFirstSniperToTarget, computeBulkBuyerPnL, prefillOpenUnrealized } from './first-sniper';
import { scanForTarget } from './pool';
import { quickAkbotCheck, isAkbotCircuitOpen } from './akbot';
import { markAsAkbot } from './pool';

// ============ 配置 ============

const WS_RECONNECT_DELAY_MS = parseInt(process.env.WS_RECONNECT_DELAY_MS ?? '3000', 10);
const WS_MAX_RECONNECT_ATTEMPTS = parseInt(process.env.WS_MAX_RECONNECT_ATTEMPTS ?? '10', 10);
const WS_ENABLE_POOL_EVENTS = process.env.WS_ENABLE_POOL_EVENTS !== 'false'; // 默认开启

// ============ Raydium 程序 ID（用于发现新池） ============

// Raydium Liquidity Pool V4 (当前活跃版本)
const RAYDIUM_LP_V4 = new PublicKey('RVKd21zr224GL7D7ysXRjeCkwXxbKkSMRGDvcoPaqCY');
// Raydium CLMM (恒定乘积做市商)
const RAYDIUM_CLMM = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
// Raydium StableSwap (占位，未启用)
// const RAYDIUM_STABLE = new PublicKey('stRDqDkBxHkJDqGzcW2qT7AiWqZBjXH5q3J4KUXZ2X');

// ============ Pump.fun 程序 ID（用于发现新币） ============

// Pump.fun (pump.fun / pump.science)
const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

// Pump.fun 新币发现的默认阈值（SOL 金额以上的才自动加入监控）
const PUMP_FUN_MIN_SOL = parseFloat(process.env.PUMP_FUN_MIN_SOL ?? '0.01');

// ============ 状态（使用 globalThis 单例，跨 Turbopack 热重载持久化）============

interface WsMonitorState {
  wsConnection: Connection | null;
  subscriptions: Map<string, number>; // address -> subscription id
  pumpFunSubscriptionId: number | null; // Pump.fun 程序订阅 ID
  isRunning: boolean;
  reconnectAttempts: number;
  reconnectTimer: NodeJS.Timeout | null;
  lastConnectedAt: number;
  // 标记 WebSocket 是否真正处于连接状态（open）
  // wsConnection !== null 不代表连接已建立，Solana 的 Connection 是懒连接的
  wsActuallyConnected: boolean;
  // 标记是否已放弃重连（达到上限）
  gaveUp: boolean;
  // 周期性重试定时器（放弃模式下的兜底）
  periodicRetryTimer: NodeJS.Timeout | null;
  // 已订阅的目标地址（内存缓存，避免频繁查询数据库）
  subscribedTargets: Set<string>;
  targetRefreshTimer: NodeJS.Timeout | null;
  // Pump.fun 近期已处理的 mint（防止重复处理同一币的多次 create log）
  recentPumpMints: Set<string>;
  // 心跳时间戳（用于调试，不驱动重连逻辑）
  lastHeartbeatAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __wsMonitorState: WsMonitorState | undefined;
}

const PUMP_MINT_DEDUP_TTL_MS = 60_000;

function getState(): WsMonitorState {
  if (!globalThis.__wsMonitorState) {
    globalThis.__wsMonitorState = {
      wsConnection: null,
      subscriptions: new Map(),
      pumpFunSubscriptionId: null,
      isRunning: false,
      reconnectAttempts: 0,
      reconnectTimer: null,
      lastConnectedAt: 0,
      wsActuallyConnected: false,
      gaveUp: false,
      periodicRetryTimer: null,
      subscribedTargets: new Set(),
      targetRefreshTimer: null,
      recentPumpMints: new Set(),
      lastHeartbeatAt: 0,
    };
  }
  return globalThis.__wsMonitorState;
}

// ============ 核心函数 ============

/**
 * 启动 WebSocket 监控
 */
export async function startWsMonitor() {
  const s = getState();
  if (s.isRunning) {
    console.log('[ws-monitor] already running, skip');
    return;
  }

  console.log('[ws-monitor] starting...');
  s.isRunning = true;

  // 初始化连接
  await initializeConnection();

  // 启动目标地址刷新定时器（定期同步数据库中的目标列表）
  startTargetRefresh();
}

/**
 * 停止 WebSocket 监控
 */
export async function stopWsMonitor() {
  const s = getState();
  console.log('[ws-monitor] stopping...');
  s.isRunning = false;

  // 清理定时器
  if (s.reconnectTimer) {
    clearTimeout(s.reconnectTimer);
    s.reconnectTimer = null;
  }
  if (s.periodicRetryTimer) {
    clearTimeout(s.periodicRetryTimer);
    s.periodicRetryTimer = null;
  }
  if (s.targetRefreshTimer) {
    clearInterval(s.targetRefreshTimer);
    s.targetRefreshTimer = null;
  }

  // 取消所有订阅
  unsubscribeAll();
  await unsubscribePumpFun();

  // 关闭连接
  if (s.wsConnection) {
    // Connection 没有 removeAllListeners，用 null 让 GC 回收旧连接
    s.wsConnection = null;
  }

  console.log('[ws-monitor] stopped');
}

/**
 * 初始化 WebSocket 连接
 */
async function initializeConnection() {
  const s = getState();

  // 选择 WebSocket 端点：优先使用 Helius（如果有 API key）
  const heliusWsUrl = getHeliusWebsocketUrl();
  const wsUrl = heliusWsUrl || getDefaultWebsocketUrl();

  console.log(`[ws-monitor] connecting to ${wsUrl.slice(0, 50)}...`);

  // 关闭自动重连，由我们手动控制
  // wsEndpoint 用于 WebSocket 通信（订阅日志等）
  // 第一个参数必须是 http/https，wsEndpoint 才是 wss
  const httpUrl = wsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  s.wsConnection = new Connection(httpUrl, {
    wsEndpoint: wsUrl,
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 0, // WebSocket 模式不需要这个
  } as any);

  // 设置事件监听
  setupEventListeners();

  // 订阅目标地址
  await refreshAndSubscribeTargets();

  // 订阅 Pump.fun 程序日志（发现新币）
  await subscribeToPumpFun();

  // 订阅成功后，标记为真正连接
  s.wsActuallyConnected = true;
  s.lastConnectedAt = Date.now();
  s.reconnectAttempts = 0;
  s.gaveUp = false; // 重连成功后清除放弃标志

  // 验证订阅状态
  const totalSubs = s.subscriptions.size + (s.pumpFunSubscriptionId !== null ? 1 : 0);
  if (totalSubs === 0) {
    console.warn('[ws-monitor] WARNING: no subscriptions active after connect!');
  } else {
    console.log(`[ws-monitor] verified ${s.subscriptions.size} target subscriptions + Pump.fun = ${totalSubs} total`);
  }

  console.log('[ws-monitor] connected successfully');
}

/**
 * 获取 Helius WebSocket URL（如果有配置）
 */
function getHeliusWebsocketUrl(): string | null {
  const heliusKey = process.env.HELIUS_API_KEY;
  if (!heliusKey) return null;

  // Helius WebSocket 端点格式
  const heliusRpc = process.env.SOLANA_RPCS;
  if (heliusRpc && heliusRpc.includes('helius')) {
    // 从 HTTP URL 提取 host，转换为 WSS
    const url = new URL(heliusRpc.split(',')[0].trim());
    return url.protocol === 'https:'
      ? `wss://${url.host}/?api-key=${heliusKey}`
      : `wss://${url.host}/?api-key=${heliusKey}`;
  }
  return null;
}

/**
 * 获取默认公共 WebSocket 端点
 */
function getDefaultWebsocketUrl(): string {
  // 公共节点通常也支持 WebSocket
  const publicNode = process.env.SOLANA_RPC_3; // publicnode
  if (publicNode) {
    return publicNode.replace('https://', 'wss://').replace('http://', 'ws://');
  }
  return 'wss://api.mainnet-beta.solana.com';
}

/**
 * 设置 WebSocket 健康检查（Solana Web3.js 1.99+ 不再继承 EventEmitter，
 * 改用心跳检测连接状态）
/**
 * 记录心跳（每次有订阅事件时调用，用于调试）
 */
function recordHeartbeat() {
  getState().lastHeartbeatAt = Date.now();
}

/**
 * 设置 WebSocket 事件监听（v1.99+ Connection 不再继承 EventEmitter，
 * connectionChange 等事件已移除）。
 *
 * 直接监听底层 WebSocket 的 close/error 事件，实现立即检测断开。
 * Connection 内部使用 _rpcWs 属性暴露 WebSocket 实例。
 */
function setupEventListeners() {
  const s = getState();
  if (!s.wsConnection) return;

  // 访问 Connection 内部的 WebSocket 实例（_rpcWs）
  const rawWs = (s.wsConnection as any)._rpcWs;
  if (!rawWs) return;

  // close 事件：WebSocket 正常关闭
  rawWs.addEventListener('close', (e: CloseEvent) => {
    console.warn(`[ws-monitor] WebSocket close event: code=${e.code} reason=${e.reason || 'none'}`);
    handleDisconnect();
  });

  // error 事件：WebSocket 发生错误（error 后通常紧跟 close）
  rawWs.addEventListener('error', (e: Event) => {
    console.warn('[ws-monitor] WebSocket error event:', e);
    handleDisconnect();
  });

  // open 事件：重连后再次连接
  rawWs.addEventListener('open', () => {
    console.log('[ws-monitor] WebSocket reopened');
    const state = getState();
    state.wsActuallyConnected = true;
    state.lastConnectedAt = Date.now();
    state.reconnectAttempts = 0;
  });
}

/**
 * 处理断开连接
 */
async function handleDisconnect() {
  const s = getState();
  if (!s.isRunning) return;

  s.wsActuallyConnected = false;

  const elapsed = s.lastConnectedAt > 0
    ? ` (connected for ${Math.round((Date.now() - s.lastConnectedAt) / 1000)}s)`
    : '';

  console.warn(`[ws-monitor] connection closed${elapsed}`);

  // 清理订阅（事件回调里调用，本函数 async 返回的 Promise 在此处被忽略，
  // 所以内部 try/catch 必须吃掉所有异常，避免 unhandled promise rejection）
  s.subscriptions.clear();
  if (s.pumpFunSubscriptionId !== null && s.wsConnection) {
    try {
      await s.wsConnection.removeOnLogsListener(s.pumpFunSubscriptionId);
    } catch (err) {
      console.warn('[ws-monitor] handleDisconnect: removeOnLogsListener pumpFun failed:', err);
    }
    s.pumpFunSubscriptionId = null;
  }

  // 尝试重连
  scheduleReconnect();
}

/**
 * 安排重连
 */
function scheduleReconnect() {
  const s = getState();
  if (!s.isRunning) return;
  if (s.reconnectTimer) return; // 已经在等待中

  s.reconnectAttempts++;

  if (s.reconnectAttempts > WS_MAX_RECONNECT_ATTEMPTS) {
    if (!s.gaveUp) {
      s.gaveUp = true;
      console.error(
        `[ws-monitor] max reconnect attempts (${WS_MAX_RECONNECT_ATTEMPTS}) reached, entering periodic retry mode`,
      );
    }
    // 每 5 分钟尝试一次重连（指数退避从 3s 重新开始）
    schedulePeriodicRetry();
    return;
  }

  // 指数退避：3s -> 6s -> 12s -> ... -> 最多 30s
  const delay = Math.min(WS_RECONNECT_DELAY_MS * Math.pow(2, s.reconnectAttempts - 1), 30_000);

  console.log(
    `[ws-monitor] reconnecting in ${delay / 1000}s (attempt ${s.reconnectAttempts}/${WS_MAX_RECONNECT_ATTEMPTS})`,
  );

  s.reconnectTimer = setTimeout(async () => {
    s.reconnectTimer = null;
    if (s.isRunning) {
      await initializeConnection();
    }
  }, delay);
}

/**
 * 周期性重试（达到上限后，每 5 分钟尝试一次）
 * 成功后恢复正常指数退避逻辑
 */
const PERIODIC_RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟

function schedulePeriodicRetry() {
  const s = getState();
  if (!s.isRunning) return;
  if (s.periodicRetryTimer) return; // 已经在等待中

  s.periodicRetryTimer = setTimeout(async () => {
    s.periodicRetryTimer = null;
    if (!s.isRunning) return;

    console.log('[ws-monitor] periodic retry: attempting reconnection...');
    // 重置重试计数，恢复正常指数退避
    s.reconnectAttempts = 0;
    s.gaveUp = false;
    await initializeConnection();
  }, PERIODIC_RETRY_INTERVAL_MS);
}

/**
 * 启动目标地址刷新定时器
 */
function startTargetRefresh() {
  const s = getState();
  // 每 30 秒刷新一次目标地址列表
  s.targetRefreshTimer = setInterval(async () => {
    if (s.isRunning) {
      await refreshAndSubscribeTargets();
    }
  }, 30_000);
}

/**
 * 刷新并订阅目标地址
 */
async function refreshAndSubscribeTargets() {
  const s = getState();
  try {
    // 订阅所有 status='active' 的目标（pump 自动目标和手动目标一视同仁），
    // 因为 24h 之后的 pump 目标如果还在被买入，WS 漏了以后只能等轮询兜底（5-15s 延迟），
    // 对抢单场景是致命的。Solana 公共节点单连接 WS 订阅数上限约 1000-2000，正常使用足够。
    const targets = await query<{ address: string }>(`
      SELECT DISTINCT address
      FROM monitored_targets
      WHERE status = 'active'
    `);

    const newAddresses = new Set<string>();
    for (const t of targets) {
      newAddresses.add(t.address);
    }

    // 计算需要添加和移除的地址
    const toAdd: string[] = [];
    const toRemove: string[] = [];

    for (const addr of newAddresses) {
      if (!s.subscribedTargets.has(addr)) {
        toAdd.push(addr);
      }
    }

    for (const addr of s.subscribedTargets) {
      if (!newAddresses.has(addr)) {
        toRemove.push(addr);
      }
    }

    // 移除不再需要的订阅
    for (const addr of toRemove) {
      await unsubscribe(addr);
      s.subscribedTargets.delete(addr);
    }

    // 添加新订阅
    for (const addr of toAdd) {
      await subscribeToAddress(addr);
      s.subscribedTargets.add(addr);
    }

    if (toAdd.length > 0 || toRemove.length > 0) {
      console.log(
        `[ws-monitor] targets refreshed: +${toAdd.length} -${toRemove.length}, total ${newAddresses.size}`,
      );
    }
  } catch (err) {
    console.error('[ws-monitor] failed to refresh targets:', err);
  }
}

/**
 * 订阅一个地址的交易日志
 */
async function subscribeToAddress(address: string) {
  const s = getState();
  if (!s.wsConnection || s.subscriptions.has(address)) return;

  try {
    const publicKey = new PublicKey(address);
    const subscriptionId = await s.wsConnection.onLogs(
      publicKey,
      (logs, context) => {
        handleLogs(address, logs, context);
      },
      'confirmed',
    );

    s.subscriptions.set(address, subscriptionId);
    console.log(`[ws-monitor] subscribed to ${address.slice(0, 8)}... (id: ${subscriptionId})`);
  } catch (err) {
    console.error(`[ws-monitor] failed to subscribe to ${address.slice(0, 8)}...:`, err);
  }
}

/**
 * 取消订阅一个地址
 */
async function unsubscribe(address: string) {
  const s = getState();
  if (!s.wsConnection) return;

  const subscriptionId = s.subscriptions.get(address);
  if (subscriptionId === undefined) return;

  try {
    await s.wsConnection.removeOnLogsListener(subscriptionId);
    s.subscriptions.delete(address);
    console.log(`[ws-monitor] unsubscribed from ${address.slice(0, 8)}...`);
  } catch (err) {
    console.error(`[ws-monitor] failed to unsubscribe from ${address.slice(0, 8)}...:`, err);
  }
}

// ============ Pump.fun 新币发现 ============

/**
 * 订阅 Pump.fun 程序的日志，发现新币后自动加入监控
 */
async function subscribeToPumpFun() {
  const s = getState();
  if (!s.wsConnection) return;

  // 是否开启 Pump.fun 监听（可通过环境变量关闭）
  if (!WS_ENABLE_POOL_EVENTS) {
    console.log('[ws-monitor] pool events disabled, skip Pump.fun subscription');
    return;
  }

  try {
    s.pumpFunSubscriptionId = await s.wsConnection.onLogs(
      PUMP_FUN_PROGRAM,
      (logs, context) => {
        handlePumpFunLogs(logs, context);
      },
      'confirmed',
    );
    console.log(`[ws-monitor] subscribed to Pump.fun program (id: ${s.pumpFunSubscriptionId})`);
  } catch (err) {
    console.error('[ws-monitor] failed to subscribe to Pump.fun program:', err);
  }
}

/**
 * 处理 Pump.fun 程序日志：检测新币创建和交易事件
 */
async function handlePumpFunLogs(
  logs: any,
  context: { slot: number; signature: string },
) {
  recordHeartbeat(); // 记录心跳，表明订阅活跃
  try {
    const s = getState();
    const logMessages: string[] = logs.logs ?? [];
    // Solana web3.js onLogs 回调里 signature 在 logs (LogInfo) 上，不在 context 上
    const sig = logs.signature;
    if (!sig) return; // signature may be undefined in some WS events

    // Pump.fun 事件通过 program log 识别：
    // - CreateEvent  disc=00：发币事件
    // - TradeEvent   disc=01：买卖交易
    // - CompleteEvent disc=02：迁移到 Raydium
    const hasPumpLog = logMessages.some(
      (msg) => msg.includes('Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P') ||
               msg.includes('pump.fun'),
    );
    if (!hasPumpLog) return;

    // 检测事件类型
    const hasCreate    = logMessages.some((msg) => msg.includes('Program log: Instruction: Create'));
    const hasTrade     = logMessages.some((msg) =>
      msg.includes('Program log: Instruction: Trade') ||
      /Program log: \d+$/.test(msg.trim()), // 裸事件 disc 日志
    );
    const hasComplete  = logMessages.some((msg) => msg.includes('Program log: Instruction: Complete'));

    if (hasComplete) {
      // 迁移到 Raydium，跳过（已有 Raydium 监听覆盖）
      return;
    }

    // 去重
    if (s.recentPumpMints.has(sig)) return;

    // 解析交易
    const tx = await getTransactionDetails(sig);
    if (!tx) return;

    if (hasCreate) {
      // ---- 新币创建：提取 mint，加入监控列表，并立即订阅 ----
      const mint = extractPumpFunMint(tx);
      if (!mint) return;

      if (s.recentPumpMints.has(mint)) return;
      s.recentPumpMints.add(mint);
      setTimeout(() => s.recentPumpMints.delete(mint), PUMP_MINT_DEDUP_TTL_MS);

      console.log(
        `[ws-monitor] 🆕 Pump.fun new coin! mint=${mint} sig=${sig.slice(0, 12)}... slot=${context.slot}`,
      );
      await addPumpFunMintAsTarget(mint, sig, context.slot);

    } else if (hasTrade) {
      // ---- 交易事件：提取 mint，检查是否在监控中，是则走 ingestWsTrade 流程 ----
      const mint = extractPumpFunMintFromTrade(tx);
      if (!mint) return;

      // 检查是否在监控列表（阈值检查在 ingestWsTrade 里做）
      const target = await query<{ id: number; threshold_sol: string }>(
        `SELECT id, threshold_sol FROM monitored_targets WHERE address = $1 AND status = 'active'`,
        [mint],
      );
      if (target.length === 0) return;

      // 解析交易
      const buy = parseHeliusTx(tx);
      if (!buy) return;

      // 阈值检查
      if (buy.buySol < parseFloat(target[0].threshold_sol)) return;

      console.log(
        `[ws-monitor] 📈 Pump.fun trade detected! mint=${mint} sig=${sig.slice(0, 12)}... ` +
        `buyer=${buy.address?.slice(0, 8)}... buySol=${buy.buySol.toFixed(4)}`,
      );

      await ingestWsTrade(target[0].id, buy, tx);
    }
  } catch (err) {
    console.error('[ws-monitor] handlePumpFunLogs error:', err);
  }
}

/**
 * 从 Pump.fun 交易中提取 MINT 地址
 * Pump.fun 创建币时会调用 system_program::create_account，mint 地址在 account_keys 中
 */
function extractPumpFunMint(tx: any): string | null {
  try {
    const message = tx.transaction?.message;
    if (!message) return null;

    // 获取所有 account keys
    const accountKeys = message.accountKeys ?? [];
    const instructions = message.instructions ?? [];
    const innerInstructions = message.innerInstructions ?? [];

    // 从顶层指令找 Initialize / Create 相关的
    const allInstructions = [...instructions, ...innerInstructions.flat()];

    for (const ix of allInstructions) {
      const programIdIndex = ix.programIdIndex ?? ix.programId;
      let programId = '';
      if (typeof programIdIndex === 'number') {
        programId = accountKeys[programIdIndex] ?? '';
      } else {
        programId = programIdIndex ?? '';
      }

      // 命中 Pump.fun 程序
      if (programId !== '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P') continue;

      // Pump.fun initialize 指令的第一个 account 通常是 mint
      if (ix.accounts && ix.accounts.length > 0) {
        const mintIndex = ix.accounts[0];
        const mint = accountKeys[mintIndex];
        if (mint && isValidPublicKey(mint)) {
          return mint;
        }
      }
    }

    // 备用策略：从 tokenTransfers 解析
    const tokenTransfers = (tx as any).tokenTransfers;
    if (Array.isArray(tokenTransfers) && tokenTransfers.length > 0) {
      // 新币通常只有一个很大的 tokenAmount（初始发行）
      const sorted = [...tokenTransfers].sort((a: any, b: any) =>
        (b.tokenAmount || 0) - (a.tokenAmount || 0),
      );
      if (sorted[0]?.mint) return sorted[0].mint;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 从 Pump.fun 交易中提取 MINT 地址（用于 Trade 事件）
 * Trade 交易里，mint 地址通常出现在 tokenTransfers 或 accounts 中
 */
function extractPumpFunMintFromTrade(tx: any): string | null {
  try {
    // 策略1：从 tokenTransfers 提取（最可靠）
    const tokenTransfers = (tx as any).tokenTransfers;
    if (Array.isArray(tokenTransfers) && tokenTransfers.length > 0) {
      // Pump.fun 交易里，tokenTransfers 会包含用户收到/付出的 token mint
      // 找非 SOL 的 mint（SOL 的 mint 为空字符串或特殊标识）
      for (const t of tokenTransfers) {
        if (t.mint && t.mint !== 'So11111111111111111111111111111111111111112' && isValidPublicKey(t.mint)) {
          return t.mint;
        }
      }
    }

    // 策略2：从 instructions 提取 Pump.fun 相关 account
    const message = tx.transaction?.message;
    if (message) {
      const accountKeys = message.accountKeys ?? [];
      const instructions = [...(message.instructions ?? []), ...(message.innerInstructions ?? []).flat()];

      for (const ix of instructions) {
        const programIdIndex = ix.programIdIndex ?? ix.programId;
        let programId = '';
        if (typeof programIdIndex === 'number') {
          programId = accountKeys[programIdIndex] ?? '';
        } else {
          programId = programIdIndex ?? '';
        }

        if (programId !== '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P') continue;

        // Trade 指令中，mint 通常在 accounts[1] 或 accounts[2]
        if (ix.accounts && ix.accounts.length > 1) {
          for (const idx of ix.accounts.slice(1, 4)) {
            const addr = accountKeys[idx];
            if (addr && isValidPublicKey(addr)) {
              return addr;
            }
          }
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * 判断是否为合法的 Solana 公钥（44字符，base58）
 */
function isValidPublicKey(key: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key);
}

/**
 * 将 Pump.fun 新币自动加入监控
 */
async function addPumpFunMintAsTarget(mint: string, signature: string, slot: number) {
  try {
    // 安全修复（HIGH #6）：用严格正则二次验证地址，不信任 extractPumpFunMint 的返回值
    if (!isValidPublicKey(mint) || mint.length < 32 || mint.length > 44) {
      console.warn(`[ws-monitor] addPumpFunMintAsTarget: 非法 mint 格式，跳过 mint=${mint}`);
      return;
    }

    // 检查是否已在监控列表
    const existing = await query<{ id: number }>(
      `SELECT id FROM monitored_targets WHERE address = $1`,
      [mint],
    );
    if (existing.length > 0) return;

    // 插入新目标（默认阈值由环境变量控制）
    const label = `pump:${mint.slice(0, 8)}`;
    const threshold = PUMP_FUN_MIN_SOL.toString();

    await query(
      `INSERT INTO monitored_targets (address, label, threshold_sol, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (address) DO NOTHING`,
      [mint, label, threshold],
    );

    // 立即订阅该 mint 地址，确保后续交易不被遗漏（两笔交易间隔极短的情况）
    await subscribeToAddress(mint);
    getState().subscribedTargets.add(mint);

    console.log(
      `[ws-monitor] ✅ Pump.fun mint auto-added to monitoring: ${mint.slice(0, 12)}... ` +
      `threshold=${PUMP_FUN_MIN_SOL} SOL`,
    );
  } catch (err) {
    console.error('[ws-monitor] addPumpFunMintAsTarget failed:', err);
  }
}

/**
 * 取消所有订阅
 */
async function unsubscribeAll() {
  const s = getState();
  for (const [address, subscriptionId] of s.subscriptions) {
    try {
      if (s.wsConnection) {
        await s.wsConnection.removeOnLogsListener(subscriptionId);
      }
    } catch (err) {
      console.error(`[ws-monitor] error removing subscription ${subscriptionId}:`, err);
    }
  }
  s.subscriptions.clear();
  s.subscribedTargets.clear();
}

/**
 * 取消 Pump.fun 程序订阅
 */
async function unsubscribePumpFun() {
  const s = getState();
  if (s.pumpFunSubscriptionId === null) return;
  if (!s.wsConnection) {
    s.pumpFunSubscriptionId = null;
    return;
  }
  try {
    await s.wsConnection.removeOnLogsListener(s.pumpFunSubscriptionId);
  } catch (err) {
    console.warn('[ws-monitor] removeOnLogsListener pumpFun failed:', err);
  }
  s.pumpFunSubscriptionId = null;
}

/**
 * 处理收到的日志
 */
async function handleLogs(
  address: string,
  logs: any,
  context: Context,
) {
  recordHeartbeat(); // 记录心跳，表明订阅活跃
  // Solana web3.js onLogs 回调里 signature 在 logs (LogInfo) 上，不在 context 上
  const signature = logs.signature;
  if (!signature) return;
  // 性能优化：先看 logs.logs 是否包含 buy 相关关键字（RAYDIUM/PUMP/bonk 等 swap 指令的 log 模式），
  // 没有就直接 return，避免对每个 slot 内无关 tx 都打一次 Helius RPC（45 个订阅同时触发 100+ req/min）。
  // 关键字从 parseHeliusTx 的 isBuyTx 行为倒推：含 'Buy' / 'buy' / 'swap' 之一即有 buy 候选。
  const logStrings = logs?.logs ?? [];
  if (Array.isArray(logStrings) && logStrings.length > 0) {
    const haystack = logStrings.join('\n');
    if (!/Buy|buy|swap|Swap/i.test(haystack)) {
      return;
    }
  }
  try {
    // 获取完整交易详情
    const tx = await getTransactionDetails(signature);
    if (!tx) {
      console.warn(`[ws-monitor] failed to get tx ${signature.slice(0, 12)}...`);
      return;
    }

    // 适配：rpc.getTransaction 返回标准 RPC TransactionResponse；
    //   parseHeliusTx 期待 Helius Enhanced 形状（带 tokenTransfers / source / type），
    //   直接传会因 tokenTransfers === undefined 被 isBuyTx 判 false 然后静默 return null。
    //   monitor.ts 的轮询路径走 helius.parseEvents() → parsedEventItemToEnhanced()，
    //   WS 路径用 solanaTxToHeliusEnhanced()（已在 parser.ts 里）为同样的适配器。
    const enhancedTx = solanaTxToHeliusEnhanced(tx);
    const buy = parseHeliusTx(enhancedTx ?? tx);
    if (!buy) {
      // 不是买入交易
      return;
    }

    // 获取目标 ID
    const target = await query<{ id: number; threshold_sol: string }>(
      `SELECT id, threshold_sol FROM monitored_targets WHERE address = $1 AND status = 'active'`,
      [address],
    );

    if (target.length === 0) {
      console.warn(`[ws-monitor] target not found for ${address.slice(0, 8)}...`);
      return;
    }

    const targetInfo = target[0];

    // 检查是否达到阈值
    if (buy.buySol < parseFloat(targetInfo.threshold_sol)) {
      return;
    }

    // 入库（复用 monitor.ts 的逻辑）
    console.log(
      `[ws-monitor] 🚀 real-time trade detected! ${signature.slice(0, 12)}... ` +
      `buyer=${buy.address?.slice(0, 8)}... buySol=${buy.buySol.toFixed(4)}`,
    );

    await ingestWsTrade(targetInfo.id, buy, tx);
  } catch (err) {
    console.error('[ws-monitor] error handling logs:', err);
  }
}

/**
 * 获取交易详情（带 10s 超时，防止 WebSocket 高频事件时 Promise 堆积导致 OOM）
 *
 * 安全修复（HIGH #5）：
 *   - 每个 getTransaction 都有 10 秒硬截止，超时直接返回 null
 *   - Helius RPC 和 fallback RPC 各自独立超时，互不影响
 */
async function fetchWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T | null> {
  try {
    // AbortSignal.timeout() 在 Node.js 18+ 和所有现代浏览器均支持
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await fn();
      clearTimeout(timer);
      return result;
    } catch (err: any) {
      clearTimeout(timer);
      if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
        console.warn(`[ws-monitor] ${label} timed out after ${timeoutMs}ms`);
      }
      throw err;
    }
  } catch (err: any) {
    if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
      console.warn(`[ws-monitor] ${label} timed out after ${timeoutMs}ms`);
      return null;
    }
    throw err;
  }
}

async function getTransactionDetails(signature: string): Promise<any> {
  const RPC_TIMEOUT_MS = 10_000;

  try {
    // 优先用 Helius（如果有的话）
    const heliusUrl = process.env.SOLANA_RPCS?.split(',')[0]?.trim();
    if (heliusUrl && heliusUrl.includes('helius')) {
      const heliusConn = new Connection(heliusUrl, 'confirmed' as any);
      const tx = await fetchWithTimeout(
        () =>
          heliusConn.getTransaction(signature, {
            maxSupportedTransactionVersion: 1,
            rewards: false,
          } as any),
        RPC_TIMEOUT_MS,
        `helius getTransaction ${signature.slice(0, 12)}`,
      );
      if (tx) return tx;
    }

    // Fallback 到公共 RPC
    const rpc = await import('./multi-rpc').then((m) => m.getMultiRpc());
    const tx = await fetchWithTimeout(
      () => rpc.getTransaction(signature),
      RPC_TIMEOUT_MS,
      `rpc getTransaction ${signature.slice(0, 12)}`,
    );
    return tx;
  } catch (err) {
    console.error(`[ws-monitor] getTransaction ${signature.slice(0, 12)}... failed:`, err);
    return null;
  }
}

/**
 * WebSocket 交易的入库逻辑（类似 monitor.ts 的 ingestTargetTrade）
 */
async function ingestWsTrade(targetId: number, buy: any, rawTx: any) {
  const { analyzeBlock } = await import('./first-sniper');

  // 1) 写 target_trades
  const inserted = await query<{ id: number; was_inserted: boolean }>(`
    INSERT INTO target_trades (
      target_id, signature, slot, block_time, mint, target_address,
      buy_sol, target_tip_sol, target_prio_lamports, is_bundled, version,
      has_alt, bundle_id, tip_source
    ) VALUES ($1,$2,$3,to_timestamp(COALESCE(NULLIF($4, 0), EXTRACT(epoch FROM NOW()))),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (signature) DO UPDATE SET
      slot = EXCLUDED.slot,
      is_bundled = EXCLUDED.is_bundled,
      has_alt = EXCLUDED.has_alt,
      bundle_id = COALESCE(EXCLUDED.bundle_id, target_trades.bundle_id),
      tip_source = COALESCE(EXCLUDED.tip_source, target_trades.tip_source)
    RETURNING id, (xmax = 0) AS was_inserted
  `, [
    targetId,
    buy.signature,
    buy.slot,
    buy.blockTime || 0,
    buy.mint,
    buy.address,
    buy.buySol,
    buy.tipSol,
    buy.prioLamports,
    buy.isBundled,
    buy.version,
    buy.hasAlt,
    buy.bundleId,
    buy.tipSource,
  ]);

  if (!inserted) return;

  // 1.4) Bundle size 回填
  if (buy.bundleId) {
    await query(
      `WITH cnt AS (
         SELECT bundle_id, COUNT(*)::int AS c
           FROM target_trades
          WHERE bundle_id = $1
          GROUP BY bundle_id
       )
       UPDATE target_trades t
          SET bundle_size = cnt.c
         FROM cnt
        WHERE t.bundle_id = cnt.bundle_id`,
      [buy.bundleId],
    );
  }

  // 1.5) 计数 + 推进 last_buy_at
  //    ws 订阅有重连重放机制，同一 sig 可能多次触发 ingestWsTrade：
  //    - 第一次：INSERT → was_inserted = true → record_count +1，last_buy_at = NOW()
  //    - 后续重放：ON CONFLICT UPDATE → was_inserted = false → 只更新 last_buy_at = NOW()
  //    这样无论重放几次，last_buy_at 永远推进到最新处理时间，poll 的
  //    blockTime > lastBuyAtSec 过滤正确工作（blockTime 旧则被挡，实时则通过）。
  if (inserted.was_inserted) {
    await query(
      'UPDATE monitored_targets SET record_count = record_count + 1, last_buy_at = NOW() WHERE id = $1',
      [targetId],
    );
  } else {
    // ON CONFLICT（重放）：不重复计数，但必须推进 last_buy_at
    await query(
      'UPDATE monitored_targets SET last_buy_at = NOW() WHERE id = $1',
      [targetId],
    );
  }

  // 2) 触发 block 分析
  setImmediate(async () => {
    try {
      const analyzeResult = await analyzeBlock(buy.slot, buy.mint, buy.signature);
      const blockTime = buy.blockTime
        ? new Date(buy.blockTime * 1000).toISOString()
        : new Date().toISOString();
      await saveBlockAnalysis(buy.slot, buy.mint, buy.signature, blockTime, analyzeResult);

      // 【提速 ①】与 monitor.ts 保持一致：立即给「有 token + 未平仓」的 buyer 落一份浮盈。
      //   监控页「跟单收益」列不用等 unrealized-worker 30s tick 才有数字。
      setImmediate(() => {
        prefillOpenUnrealized(buy.slot, buy.mint)
          .then((r) => {
            if (r.written === 0 && r.reason === 'no eligible buyers') return;
            console.log(
              `[ws-monitor] prefill open slot=${buy.slot} mint=${buy.mint.slice(0, 8)}... written=${r.written} skipped=${r.skipped} (${r.reason})`,
            );
          })
          .catch((e) =>
            console.warn(
              `[ws-monitor] prefill open failed slot=${buy.slot}:`,
              (e as Error)?.message ?? e,
            ),
          );
      });

      // 【P0 修复】立即算本 block 所有 buyer 的 PnL（fire-and-forget，不阻塞后面的 sniper 回填 / pool scan / akbot）
      // 与 monitor.ts:295-308 保持完全一致；WS 路径之前漏掉了导致 sniper_pnl_sol 永远是 NULL。
      setImmediate(() => {
        computeBulkBuyerPnL(buy.slot, buy.mint)
          .then((r) => {
            if (r.results.length === 0) return;
            const closed = r.results.filter((x) => x.status === 'closed').length;
            const open   = r.results.filter((x) => x.status === 'open').length;
            const errors = r.results.filter((x) => x.status === 'error').length;
            console.log(
              `[ws-monitor] immediate pnl slot=${buy.slot} mint=${buy.mint.slice(0, 8)}... ` +
                `computed=${r.results.length} closed=${closed} open=${open} errors=${errors}`,
            );
          })
          .catch((e) =>
            console.warn(
              `[ws-monitor] immediate pnl failed slot=${buy.slot}:`,
              (e as Error)?.message ?? e,
            ),
          );
      });

      // 识别第一狙击者 —— 走公共函数（详见 first-sniper.ts: applyFirstSniperToTarget）
      // 不在这里直接拼 SQL，三处共用一份逻辑才能保证 target_trades 和 block_buyers 不漂移。
      try {
        await applyFirstSniperToTarget(buy.signature, analyzeResult);
      } catch (sniperErr) {
        console.warn('[ws-monitor] applyFirstSniperToTarget failed', sniperErr);
      }

      // 3) 池子扫描
      try {
        await scanForTarget({ targetAddress: buy.address });
      } catch (poolErr) {
        console.warn('[ws-monitor] pool scan failed', poolErr);
      }

      // 4) AkBot 检测
      setImmediate(() => {
        scheduleAkbotChecksForBuyers(analyzeResult.buyers).catch((e) =>
          console.warn('[ws-monitor] akbot check failed:', (e as Error).message),
        );
      });
    } catch (err) {
      console.error('[ws-monitor] analyzeBlock failed', err);
    }
  });
}

// ============ AkBot 检测（复用 monitor.ts 的逻辑） ============

const akbotRetryQueue: string[] = [];
const AKBOT_RETRY_MAX = 500;
let akbotRetryTimer: NodeJS.Timeout | null = null;
const AKBOT_RETRY_INTERVAL_MS = 30_000;

export async function scheduleAkbotChecksForBuyers(
  buyers: Array<{ address: string; mark?: string }>,
): Promise<void> {
  if (!Array.isArray(buyers) || buyers.length === 0) return;
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const b of buyers) {
    if (!b?.address) continue;
    if (b.mark === 'target' || b.mark === 'own') continue;
    if (seen.has(b.address)) continue;
    seen.add(b.address);
    targets.push(b.address);
  }
  if (targets.length === 0) return;

  const SLEEP_MS = 150;
  for (const addr of targets) {
    await checkOneAddressForAkbot(addr);
    if (SLEEP_MS > 0) await new Promise((r) => setTimeout(r, SLEEP_MS));
  }

  scheduleAkbotRetryDrain();
}

async function checkOneAddressForAkbot(addr: string): Promise<void> {
  try {
    const res = await quickAkbotCheck(addr);
    if (res.status === 'found') {
      const wrote = await markAsAkbot(addr, res.evidence.signature, res.evidence.blockTime, res.evidence.slot);
      if (wrote) {
        console.log(
          `[ws-monitor] akbot detected ${addr.slice(0, 8)}… evidence=${res.evidence.signature.slice(0, 12)}…`,
        );
      }
    } else if (res.status === 'inconclusive') {
      enqueueAkbotRetry(addr, res.reason);
    }
  } catch (err) {
    console.warn(`[ws-monitor] quickAkbotCheck ${addr.slice(0, 8)}… failed:`, (err as Error).message);
    enqueueAkbotRetry(addr, `error: ${(err as Error).message}`);
  }
}

function enqueueAkbotRetry(addr: string, reason: string): void {
  if (akbotRetryQueue.includes(addr)) return;
  if (akbotRetryQueue.length >= AKBOT_RETRY_MAX) {
    akbotRetryQueue.shift();
  }
  akbotRetryQueue.push(addr);
  console.warn(
    `[ws-monitor] akbot inconclusive (${reason}), queued ${addr.slice(0, 8)}… (${akbotRetryQueue.length} pending)`,
  );
}

function scheduleAkbotRetryDrain(): void {
  if (akbotRetryTimer || akbotRetryQueue.length === 0) return;
  akbotRetryTimer = setInterval(() => {
    if (akbotRetryQueue.length === 0) {
      if (akbotRetryTimer) clearInterval(akbotRetryTimer);
      akbotRetryTimer = null;
      return;
    }
    const batch = akbotRetryQueue.splice(0, 20);
    (async () => {
      for (let i = 0; i < batch.length; i++) {
        if (isAkbotCircuitOpen()) {
          akbotRetryQueue.unshift(...batch.slice(i));
          return;
        }
        await checkOneAddressForAkbot(batch[i]);
      }
    })().catch((e) => console.warn('[ws-monitor] akbot retry drain failed:', (e as Error).message));
  }, AKBOT_RETRY_INTERVAL_MS);
  if (typeof akbotRetryTimer.unref === 'function') akbotRetryTimer.unref();
}

// ============ 状态查询 ============

/**
 * 获取 WebSocket 监控状态
 */
export function getWsMonitorStatus() {
  const s = getState();
  return {
    running: s.isRunning,
    connected: s.wsActuallyConnected,
    lastConnectedAt: s.lastConnectedAt > 0 ? new Date(s.lastConnectedAt).toISOString() : null,
    reconnectAttempts: s.reconnectAttempts,
    gaveUp: s.gaveUp,
    subscribedTargetsCount: s.subscribedTargets.size,
    subscriptionsCount: s.subscriptions.size,
    akbotRetryQueueSize: akbotRetryQueue.length,
    // 调试用：最后一次收到任意订阅事件的毫秒时间戳（0 = 从未）
    lastHeartbeatAt: s.lastHeartbeatAt > 0 ? s.lastHeartbeatAt : null,
    secondsSinceLastHeartbeat: s.lastHeartbeatAt > 0
      ? Math.round((Date.now() - s.lastHeartbeatAt) / 1000)
      : null,
  };
}
