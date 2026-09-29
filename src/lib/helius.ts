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

  /** 给 Webhook 增删地址 */
  async updateWebhookAddresses(webhookID: string, accountAddresses: string[]): Promise<void> {
    await this.http.put(`/v0/webhooks/${webhookID}/`, { accountAddresses });
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
