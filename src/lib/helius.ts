/**
 * Helius API 客户端
 * 文档: https://docs.helius.dev/
 * - Enhanced Transactions API: 解析过的交易数据
 * - Enhanced Webhooks: 实时推送
 * - DAS API: 资产元数据
 *
 * 新版 endpoint 格式（api-key 通过 query string 传入）：
 *   - RPC:               POST https://mainnet.helius-rpc.com/?api-key=<KEY>
 *   - 解析交易:          POST https://mainnet.helius-rpc.com/v0/transactions/?api-key=<KEY>
 *   - 地址交易:          GET  https://mainnet.helius-rpc.com/v0/addresses/<addr>/transactions/?api-key=<KEY>
 *   - Webhook 列表:      GET  https://mainnet.helius-rpc.com/v0/webhooks/?api-key=<KEY>
 *   - Webhook 创建:      POST https://mainnet.helius-rpc.com/v0/webhooks/?api-key=<KEY>
 *   - Webhook 更新:      PUT  https://mainnet.helius-rpc.com/v0/webhooks/<id>/?api-key=<KEY>
 *   - Webhook 删除:      DELETE https://mainnet.helius-rpc.com/v0/webhooks/<id>/?api-key=<KEY>
 */

import axios, { AxiosInstance } from 'axios';
import type { HeliusEnhancedTx } from './types';
import { solanaTxToHeliusEnhanced } from './parser';
import { getMultiRpc } from './multi-rpc';

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

  /** 通过 Enhanced Transactions API 解析单笔/多笔交易 */
  async parseTransactions(signatures: string[]): Promise<HeliusEnhancedTx[]> {
    if (signatures.length === 0) return [];
    const { data } = await this.http.post(
      '/v0/transactions/',
      { transactions: signatures },
      { timeout: 30_000 },
    );
    return data as HeliusEnhancedTx[];
  }

  /** 解析单笔交易 */
  async parseTransaction(signature: string): Promise<HeliusEnhancedTx | null> {
    const list = await this.parseTransactions([signature]);
    return list[0] ?? null;
  }

  /**
   * 带 fallback 的单笔交易解析
   * 1) 先走 Helius Enhanced API（首选，解析最干净）
   * 2) 失败 / 限流（429/503/5xx）/ 抛错 → 用 6 个公共 RPC 的 getTransaction 兜底，
   *    通过 solanaTxToHeliusEnhanced 适配成 HeliusEnhancedTx 形状后返回
   *
   * 整体不再抛错（除非两边都炸），让上游如 monitor 的 try/catch 不会因 429 把整批 target 拖死
   */
  async parseTransactionWithFallback(signature: string): Promise<HeliusEnhancedTx | null> {
    // 1) Helius Enhanced
    try {
      const r = await this.parseTransaction(signature);
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
    await this.http.delete(`/v0/webhooks/${webhookID}/`);
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
