/**
 * Helius API 客户端
 * 文档: https://docs.helius.dev/
 * - Parsed Events API: 解析过的交易数据（10 credits/request，Enhanced 的继任者）
 * - Enhanced Webhooks: 实时推送
 * - DAS API: 资产元数据
 *
 * 端点：
 *   - RPC:                       POST https://mainnet.helius-rpc.com/?api-key=<KEY>
 *   - Parsed Events 解析:        POST https://mainnet.helius-rpc.com/v1/parsed-events/transactions
 *   - 地址历史解析:              POST https://mainnet.helius-rpc.com/v1/parsed-events/transaction-history
 *   - Webhook 列表:              GET  https://mainnet.helius-rpc.com/v0/webhooks/?api-key=<KEY>
 *   - Webhook 创建:              POST https://mainnet.helius-rpc.com/v0/webhooks/?api-key=<KEY>
 *   - Webhook 更新:              PUT  https://mainnet.helius-rpc.com/v0/webhooks/<id>/?api-key=<KEY>
 *   - Webhook 删除:              DELETE https://mainnet.helius-rpc.com/v0/webhooks/<id>/?api-key=<KEY>
 *
 * 计费要点（2026/10 起）：
 *   - Parsed Events:  10 cr / request（不受签名数影响）
 *   - Enhanced Tx:   100 cr / request（legacy，maintenance mode）
 *   - getSignaturesForAddress: 1 cr
 *   - getTransaction: 1 cr
 *   - Webhook push:  1 cr / 推送事件
 *
 * 通用计费：https://www.helius.dev/docs/billing/credits
 */

import axios, { AxiosInstance } from 'axios';
import type { HeliusEnhancedTx } from './types';
import { solanaTxToHeliusEnhanced } from './parser';
import { getMultiRpc } from './multi-rpc';

// ============================================================================
// Parsed Events API 类型定义（Helius 新版解析端点，10 credits/request）
// ============================================================================

/** Parsed Events 的单个解析结果 */
export interface ParsedEventItem {
  signature: string;
  parserStatus: 'OK' | 'ERROR';
  parsed?: ParsedEventParsed;
  /** 原 Solana 交易，仅当请求中 includeRawTransaction=true 时存在 */
  raw?: any;
}

export interface ParsedEventParsed {
  slot: number;
  blockTime: number;
  fee: number;
  feePayer: string;
  transactionStatus: 'OK' | 'FAILED';
  error: unknown | null;
  decodedError: unknown | null;
  nativeTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
  tokenTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    fromTokenAccount: string;
    toTokenAccount: string;
    rawTokenAmount: number | string;
    decimals: number;
    tokenStandard: string;
    mint: string;
  }>;
  /** 顶层交易摘要，例如 swap / transfer / create 等 */
  summary?: {
    type?: string;
    description?: string;
    parsedData?: {
      type?: string;
      protocol?: string;  // jupiter / raydium / pump.fun / orca ...
    };
  };
  instructions?: Array<{
    instructionIndex: number;
    innerInstructionIndex: number | null;
    stackHeight: number;
    programId: string;
    rawAccounts: string[];
    rawData: string;
    programName?: string;
    instructionName?: string;
    decoded?: any;
  }>;
}

// ============================================================================
// Parsed Events → HeliusEnhancedTx 适配器
// ============================================================================

/**
 * 把 Parsed Events 单条结果适配成 HeliusEnhancedTx 形状。
 * 这样做的好处：下游 parser.ts / first-sniper.ts 完全不感知数据源差异。
 *
 * 关键映射：
 *   tokenTransfers: rawTokenAmount / 10^decimals → tokenAmount
 *   instructions:   rawAccounts → accounts（已经含 programId 字符串）
 *   source:         summary.parsedData.protocol → source（jupiter / raydium / ...）
 *   version:        读 rawTransaction.version；raw 缺失时保守设为 'legacy'
 *   _hasAlt:        读 rawTransaction.message.addressTableLookups（仅 v0 有意义）
 *
 * 返回 null 表示该项解析失败（parserStatus !== 'OK' 或缺关键字段）。
 */
export function parsedEventItemToEnhanced(item: ParsedEventItem): HeliusEnhancedTx | null {
  if (!item || item.parserStatus !== 'OK' || !item.parsed) return null;
  const p = item.parsed;

  // tokenTransfers：把 rawTokenAmount / 10^decimals → tokenAmount（与 Enhanced 兼容）
  const tokenTransfers = (p.tokenTransfers ?? []).map((t) => {
    const raw = typeof t.rawTokenAmount === 'string' ? Number(t.rawTokenAmount) : t.rawTokenAmount;
    const decimals = t.decimals ?? 0;
    return {
      fromUserAccount: t.fromUserAccount,
      toUserAccount: t.toUserAccount,
      fromTokenAccount: t.fromTokenAccount,
      toTokenAccount: t.toTokenAccount,
      mint: t.mint,
      tokenStandard: t.tokenStandard,
      tokenAmount: decimals > 0 ? raw / Math.pow(10, decimals) : raw,
    };
  });

  // instructions：rawAccounts → accounts（已经是展开的 pubkey 字符串）
  const instructions = (p.instructions ?? []).map((ix) => ({
    programId: ix.programId,
    accounts: ix.rawAccounts ?? [],
    data: ix.rawData ?? '',
  }));

  // version：从 raw.transaction.message 推断 v0 / legacy
  let version: 'legacy' | 0 = 'legacy';
  let hasAlt: boolean | null = null;
  const rawTx = item.raw;
  if (rawTx) {
    // web3.js 风格，version 字段可能在 raw.transaction.message.version 或顶层 raw.version
    const topVer = rawTx.version ?? rawTx?.transaction?.version;
    if (topVer === 0 || topVer === '0') version = 0;
    const lookups = rawTx?.transaction?.message?.addressTableLookups;
    hasAlt = Array.isArray(lookups) && lookups.length > 0;
  }

  // source：Parsed Events 在 summary.parsedData.protocol 给出 DEX 名
  const source = p.summary?.parsedData?.protocol ?? '';

  return {
    signature: item.signature,
    slot: p.slot,
    blockTime: p.blockTime,
    fee: p.fee,
    feePayer: p.feePayer,
    version,
    tokenTransfers,
    nativeTransfers: p.nativeTransfers ?? [],
    instructions,
    source,
    type: p.summary?.type,
    // 失败交易走 transactionError 字段，让 parser.ts 的 success 判定正确生效
    transactionError: p.transactionStatus === 'FAILED' ? p.error ?? true : null,
    // 内部标记：fallback 适配器写；与 solanaTxToHeliusEnhanced 路径同款字段，
    // parser.ts 的 isBundled / computeBundleId 都靠它识别 Jito bundle
    _hasAlt: hasAlt,
  } as HeliusEnhancedTx & { _hasAlt: boolean | null };
}

const HELIUS_BASE = 'https://mainnet.helius-rpc.com';

export class HeliusClient {
  private http: AxiosInstance;
  public apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.http = axios.create({
      baseURL: HELIUS_BASE,
      timeout: 15_000,
      headers: { 'Content-Type': 'application/json' },
      params: { 'api-key': apiKey },
    });
  }

  /** 通用 RPC 调用 */
  async rpc<T = any>(method: string, params: any[]): Promise<T> {
    const { data } = await this.http.post('', {
      jsonrpc: '2.0',
      id: 'solwallet',
      method,
      params,
    });
    if (data.error) throw new Error(`Helius RPC error: ${JSON.stringify(data.error)}`);
    return data.result as T;
  }

  /**
   * 通过 Parsed Events API 批量解析交易签名（10 credits / request，与签名数无关）
   *
   * 相比旧的 Enhanced Transactions API（100 cr / request）：
   *   - 单价便宜 10 倍 → 大批量解析大幅降本
   *   - 响应顺序与请求顺序一致（含重复），单项失败用 parserStatus='ERROR' 标识
   *
   * 返回 raw 原始 Solana 交易，供适配器读取 version / addressTableLookups，
   * 这些字段 Helius Enhanced 没给但 parser.ts 的 isBundled / computeBundleId 需要。
   */
  async parseEvents(signatures: string[]): Promise<ParsedEventItem[]> {
    if (signatures.length === 0) return [];
    const { data } = await this.http.post(
      '/v1/parsed-events/transactions',
      {
        transactions: signatures,
        // 拿原始 tx 用来读 version / addressTableLookups（影响 isBundled 判定）
        includeRawTransaction: true,
      },
      { timeout: 30_000 },
    );
    if (!Array.isArray(data)) {
      throw new Error(`Parsed Events 响应不是数组：${JSON.stringify(data).slice(0, 200)}`);
    }
    return data as ParsedEventItem[];
  }

  /**
   * 单笔解析便捷方法
   */
  async parseEvent(signature: string): Promise<HeliusEnhancedTx | null> {
    const list = await this.parseEvents([signature]);
    if (list.length === 0) return null;
    return parsedEventItemToEnhanced(list[0]);
  }

  /**
   * 批量解析便捷方法：把 parseEvents 的所有结果适配成 HeliusEnhancedTx，
   * 丢弃 parserStatus='ERROR' 的项。适配失败的项同样丢弃。
   *
   * 调用点（scripts/backfill-copy-pnl.ts 等）原本直接拿 HeliusEnhancedTx，
   * 改走 Parsed Events 后必须经适配器转一次 → 集中在这里，避免每个调用点重复适配逻辑。
   */
  async parseEventsAsEnhanced(signatures: string[]): Promise<HeliusEnhancedTx[]> {
    const items = await this.parseEvents(signatures);
    const out: HeliusEnhancedTx[] = [];
    for (const item of items) {
      const enhanced = parsedEventItemToEnhanced(item);
      if (enhanced) out.push(enhanced);
    }
    return out;
  }

  /**
   * 带 fallback 的单笔交易解析
   * 1) 先走 Helius Parsed Events（首选，10 cr，且能区分 Enhanced 没有的字段如 version/ALT）
   * 2) 失败 / 限流（429/503/5xx）/ 抛错 → 用 6 个公共 RPC 的 getTransaction 兜底，
   *    通过 solanaTxToHeliusEnhanced 适配成 HeliusEnhancedTx 形状后返回
   *
   * 整体不再抛错（除非两边都炸），让上游如 monitor 的 try/catch 不会因 429 把整批 target 拖死
   */
  async parseTransactionWithFallback(signature: string): Promise<HeliusEnhancedTx | null> {
    // 1) Helius Parsed Events
    try {
      const r = await this.parseEvent(signature);
      if (r) return r;
    } catch (err: any) {
      const status = err?.response?.status ?? err?.status;
      // 429/503/500/网络错误 全部进 fallback；其他（参数错误）直接返回 null
      if (status && ![429, 500, 502, 503, 504].includes(status)) {
        const msg = err?.message ?? String(err);
        if (!/ENOTFOUND|ETIMEDOUT|ECONNRESET|network/i.test(msg)) {
          return null;
        }
      }
      // 否则静默进入 fallback
    }
    // 2) 公共 RPC fallback
    try {
      const tx = await getMultiRpc().getTransaction(signature);
      if (!tx) return null;
      const adapted = solanaTxToHeliusEnhanced(tx);
      if (adapted) {
        // 标记为 fallback 来源，方便上层日志/排障
        (adapted as any)._source = 'rpc_fallback';
      }
      return adapted;
    } catch (err) {
      console.warn(
        `[helius] fallback parseTransaction ${signature.slice(0, 12)}… failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** 获取某地址的签名列表（支持 until 翻页） */
  async getSignaturesForAddress(
    address: string,
    opts: { limit?: number; before?: string; until?: string } = {},
  ): Promise<Array<{ signature: string; slot: number; blockTime: number; err: any | null }>> {
    const params: any[] = [
      address,
      {
        limit: opts.limit ?? 100,
        ...(opts.before ? { before: opts.before } : {}),
        ...(opts.until ? { until: opts.until } : {}),
      },
    ];
    return this.rpc('getSignaturesForAddress', params);
  }

  /** 创建 Enhanced Webhook（监听交易） */
  async createWebhook(opts: {
    webhookURL: string;
    accountAddresses: string[];
    transactionTypes?: string[];
    webhookType?: 'enhanced' | 'raw';
  }): Promise<{ webhookID: string }> {
    const { data } = await this.http.post('/v0/webhooks/', {
      webhookURL: opts.webhookURL,
      transactionTypes: opts.transactionTypes ?? ['Any'],
      accountAddresses: opts.accountAddresses,
      webhookType: opts.webhookType ?? 'enhanced',
    });
    return data;
  }

  /** 列出所有 Webhooks */
  async listWebhooks(): Promise<Array<{ webhookID: string; webhookURL: string; accountAddresses: string[]; transactionTypes: string[]; webhookType: string }>> {
    const { data } = await this.http.get('/v0/webhooks/');
    return data;
  }

  /** 删除 Webhook */
  async deleteWebhook(webhookID: string): Promise<void> {
    // 关键：DELETE 不能带 application/json + 空 body，否则 Helius 那边会报
    //       "Unexpected token 'n', \"null\" is not valid JSON"（HTTP 400）。
    // 这里显式把 Content-Type 置空 + 用 fetch 跳过 axios 的默认 JSON 解析。
    const url = `${HELIUS_BASE}/v0/webhooks/${webhookID}/?api-key=${encodeURIComponent(this.apiKey)}`;
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
    }
  }

  /** 给 Webhook 增删地址（Helius PUT 需要完整 webhook 对象） */
  async updateWebhookAddresses(webhookID: string, accountAddresses: string[]): Promise<void> {
    // 先获取当前 webhook，再保留其它字段一并 PUT
    const list = await this.listWebhooks();
    const current = list.find((w) => w.webhookID === webhookID);
    if (!current) throw new Error(`webhook ${webhookID} not found`);
    await this.http.put(`/v0/webhooks/${webhookID}/`, {
      webhookURL: current.webhookURL,
      transactionTypes: current.transactionTypes ?? ['ANY'],
      accountAddresses,
      webhookType: current.webhookType ?? 'enhanced',
    });
  }
}

/** Helius 是否已配置（用于判断是否启动监控） */
export function isHeliusConfigured(): boolean {
  return !!process.env.HELIUS_API_KEY;
}

/** 全局 Helius 客户端（按需创建） */
let _helius: HeliusClient | null = null;
export function getHelius(): HeliusClient {
  const key = process.env.HELIUS_API_KEY;
  if (!key) {
    throw new Error('HELIUS_API_KEY 未配置。请在 .env 中设置 Helius API Key');
  }
  if (!_helius) _helius = new HeliusClient(key);
  return _helius;
}
