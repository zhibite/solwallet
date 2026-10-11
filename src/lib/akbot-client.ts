/**
 * Akbot API client (typed wrapper)
 *
 * 背景：
 *   - akbot 是我们的跟单执行端（外部 SaaS）。
 *   - 我们 agent 决策后要在这里真正触发 enable/disable/delete/limit_update。
 *   - 这个文件是唯一允许持有 x-api-key 的地方（从 process.env.AKBOT_API_KEY 读）。
 *   - 绝不允许把 key 写进任何 .ts/.js/.sql/.md/.json 文件。
 *
 * 调用约定：
 *   - base URL 从 env.AKBOT_BASE_URL 读，缺省 https://api.akbot.pro/api
 *   - x-api-key 从 env.AKBOT_API_KEY 读，缺省抛错（不静默 fallback）
 *   - 每次调用都返回 `{ ok, status, body, error }`，不抛异常（executor 那边自己 log + 写 call_log）
 *   - 不重试（重复 add 会脏数据；调用方决定是否补单）
 */

const BASE_URL_DEFAULT = 'https://api.akbot.pro/api';

export type AkResult<T> = {
  ok: boolean;
  status: number;
  body: T | null;       // 已解析的 body
  error?: string;       // 网络/HTTP 错误信息
  durationMs: number;
};

export interface AkResponseEnvelope<T> {
  code: number;
  level?: string | null;
  msg?: string | null;
  ok: boolean;
  data: T | null;
  dataType?: number;
}

/* ---------- Schemas (与 docs/akbot_api.html 对齐) ---------- */

export interface AkGlobalConfig {
  userId: number;
  walletNote?: string;
  walletPubKey?: string;
  altPubKey?: string;
  activeAccount?: number;
  walletPrivateKey?: string;     // 回包里有，但前端用不到；别打印
  sellTip: number;
  sellGas: number;
  privateAccount?: string;
  privateProgram?: string;
  usdcMode: number;
  usd1Mode: number;
  mintFilter?: number;
  globalSwitch: number;            // 0 关 / 1 开
  gasRiskSwitch?: number;
  failSafeSwitch?: number;
  autoSwapStockToken?: number;
  hiddenSellSwitch?: number;
  minPosition?: number;
  updateTime?: string;
}

export interface AkCopyAddress {
  idAddress?: number;
  idConfig?: number;
  userId?: number;
  copyAddress: string;
  orderNum?: number;
}

export interface AkBuyDetail {
  idDetail?: number;
  userId?: number;
  idConfig?: number;
  buyMode: number;                 // 1=固定金额 2=正倍数 3=反比例
  buyAmount: number;               // SOL 或倍数（看 buyMode）
  marketValueMin?: number;         // K（千市值）下限，0=不限
  marketValueMax?: number;
  tipFee: number;                  // SOL，0.0001-100
  gasFee: number;                  // SOL，0.000005-20
  slippageBuy: number;             // 0-500
  slippageMode: number;            // 0=百分比 1=SOL 数量
  highGasMode: number;             // 0/1
  highGas?: number;                // ≤60
  highGasTip?: number;             // ≤100
  highGasSlippage?: number;        // ≤500
  orderNum?: number;
}

export interface AkProfitTpSegment {
  idSegment?: number;
  idConfig?: number;
  segmentOrder?: number;
  triggerPct: number;              // ≥5
  sellPct: number;
  timeOutSwitch: number;           // 0/1
  timeOutStamp?: number;
  timeoutAtTriggerPct?: number;
}

export interface AkLossSegment {
  idLoss?: number;
  idConfig?: number;
  segmentOrder?: number;
  triggerPct: number;              // 5-100
  sellPct: number;                 // 0-100
}

export interface AkCommonConfig {
  idConfig?: number;
  /** akbot 账户 userId（addConfig 回包里带，可用来省一次 ping globalConfig） */
  userId?: number;
  enableSwitch: number;            // 0/1
  copyAddressNote?: string;
  groupSlippageMultiple?: number;
  platform?: string;               // 多平台用英文逗号分隔
  firstPurchaseSwitch?: number;    // 0/1
  positionFollowSwitch?: number;
  followSellPctMode?: number;      // 0/1/2
  followClearPct?: number;
  stopFollowSwitch?: number;
  blockCount?: number;
  stopFollowSecond?: number;
  onlyDevSwitch?: number;
  mayhemSwitch?: number;
  addressBlacklist?: string;
  quickSellSwitch?: number;
  quickSellMs?: number;
  quickSellPct?: number;
  stopFollowTimes?: number;
  drawdownPctSwitch?: number;
  drawdownPct?: number;
  drawdownActivateTarget?: number;
  copyMinAmount?: number;
  copyMaxAmount?: number;
  updateTime?: string;
  pinTopTime?: string;
  akCopyAddresses: AkCopyAddress[];
  akConfigLabels?: AkConfigLabel[];
}

export interface AkConfigLabel {
  idConfigLabel?: number;
  idLabel?: number;
  labelName?: string;
  idConfig?: number;
}

export interface AkBotConfig {
  akCommonConfig: AkCommonConfig;
  akBuyDetails: AkBuyDetail[];
  akProfitTpSegments?: AkProfitTpSegment[];
  akLossSegments?: AkLossSegment[];
}

export interface AkBotAddDTO {
  akCommonConfig: AkCommonConfig;
  akBuyDetails: AkBuyDetail[];
  akProfitTpSegments?: AkProfitTpSegment[];
  akLossSegments?: AkLossSegment[];
}

/* ---------- Client ---------- */

export class AkbotClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts?: { baseUrl?: string; apiKey?: string }) {
    this.baseUrl = (opts?.baseUrl ?? process.env.AKBOT_BASE_URL ?? BASE_URL_DEFAULT)
      .replace(/\/+$/, '');
    const key = opts?.apiKey ?? process.env.AKBOT_API_KEY;
    if (!key) {
      // 显式抛错：避免接口存在但 key 缺了还走通，污染状态
      throw new Error('AKBOT_API_KEY missing in env (refusing to call akbot API)');
    }
    this.apiKey = key;
  }

  /* ===== 基础 HTTP ===== */

  private async request<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<AkResult<T>> {
    const url = this.baseUrl + path;
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'x-api-key': this.apiKey,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept': 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let parsed: T | null = null;
      try {
        parsed = text ? (JSON.parse(text) as T) : null;
      } catch {
        // 非 JSON 响应（Cloudflare HTML、5xx 错误页等）原样塞到 error
        return {
          ok: false,
          status: res.status,
          body: null,
          error: `non-json response: ${text.slice(0, 500)}`,
          durationMs: Date.now() - t0,
        };
      }
      // 业务层失败：HTTP 200 但 envelope.code != 0 / ok=false
      const env = parsed as AkResponseEnvelope<unknown> | null;
      const bizOk = res.ok && (env?.ok === true) && (env?.code === 0 || env?.code === undefined);
      return {
        ok: bizOk,
        status: res.status,
        body: parsed,
        ...(bizOk ? {} : { error: env?.msg ?? `http ${res.status}` }),
        durationMs: Date.now() - t0,
      };
    } catch (e) {
      return {
        ok: false,
        status: 0,
        body: null,
        error: e instanceof Error ? e.message : String(e),
        durationMs: Date.now() - t0,
      };
    }
  }

  /* ===== 端点 ===== */

  ping(): Promise<AkResult<AkResponseEnvelope<AkGlobalConfig>>> {
    return this.request('GET', '/akBot/get/globalConfig');
  }

  /** 一次性：导入/覆盖钱包私钥到 akbot 全局配置 */
  importWallet(args: {
    walletPrivateKey: string;
    walletPubKey: string;             // 服务端可推导，但接口要求传
    walletNote?: string;
    sellTip?: number;
    sellGas?: number;
  }): Promise<AkResult<AkResponseEnvelope<unknown>>> {
    return this.request('POST', '/akBot/update/globalConfig/wallet', {
      walletPubKey: args.walletPubKey,
      walletPrivateKey: args.walletPrivateKey,
      walletNote: args.walletNote ?? '',
      sellTip: args.sellTip ?? 0.001,
      sellGas: args.sellGas ?? 0.00001,
    });
  }

  listConfigs(q: {
    userId: number;
    keywords?: string;
    idLabels?: number[];
    enableSwitch?: number | null;     // null=不限
  }): Promise<AkResult<AkResponseEnvelope<AkBotConfig[]>>> {
    return this.request('POST', '/akBot/list', {
      userId: q.userId,
      keywords: q.keywords ?? '',
      idLabels: q.idLabels ?? [],
      enableSwitch: q.enableSwitch ?? null,
    });
  }

  getConfigDetail(idConfig: number): Promise<AkResult<AkResponseEnvelope<AkBotConfig>>> {
    const qs = new URLSearchParams({ idConfig: String(idConfig) });
    return this.request('GET', `/akBot/getConfigDetail?${qs.toString()}`);
  }

  /**
   * 添加 akbot 配置
   * 成功时 data 字段是新建配置的 idConfig（integer，不是 DTO 本身）。
   * 见 docs/akbot_api.md `/akBot/add` Response 200 = ResponseDTOInteger。
   */
  addConfig(dto: AkBotAddDTO): Promise<AkResult<AkResponseEnvelope<number>>> {
    return this.request('POST', '/akBot/add', dto);
  }

  /**
   * 更新 akbot 配置
   * 成功时 data 字段是 String（业务消息/版本号），不是 DTO。
   * 见 docs/akbot_api.md `/akBot/update` Response 200 = ResponseDTOString。
   * 入参还是带 idConfig 的 DTO，响应 body 不需要解析。
   */
  updateConfig(dto: AkBotAddDTO & { idConfig: number }): Promise<AkResult<AkResponseEnvelope<string>>> {
    return this.request('POST', '/akBot/update', dto);
  }

  /** 批量开关；idConfigs 通常 1 个；on=true 启用 false 停用 */
  switchConfigs(idConfigs: number[], on: boolean): Promise<AkResult<AkResponseEnvelope<unknown>>> {
    return this.request('POST', '/akBot/switch/config', {
      enableSwitch: on ? 1 : 0,
      idConfigs,
    });
  }

  /** 批量删除 */
  deleteConfigs(idConfigs: number[]): Promise<AkResult<AkResponseEnvelope<unknown>>> {
    return this.request('POST', '/akBot/delete/v2', idConfigs);
  }
}

/* ---------- 默认单例：lazy，env 缺 key 时第一次构造才报错 ---------- */

let _client: AkbotClient | null = null;
export function getAkbotClient(): AkbotClient {
  if (!_client) _client = new AkbotClient();
  return _client;
}
