/**
 * 多免费/低配额 RPC 源轮询客户端
 * 策略：
 * 1) 健康检查：定期探测，自动剔除失败的端点
 * 2) 严格 round-robin 轮询：每个端点均匀轮流使用，避免免费 RPC 限额/限流
 * 3) 速率限制：每个端点独立的令牌桶
 * 4) 熔断器：连续失败 N 次暂停该端点 X 秒
 * 5) Redis 缓存：相同 slot/signature 的请求短时间合并
 */

import { Connection, PublicKey, Commitment, BlockResponse, TransactionResponse } from '@solana/web3.js';
import { Cache, cacheKeys } from './cache';

/**
 * 端点「接不住」而不是请求「有问题」的错误。
 *
 * 只有 429/503 走换端点 + 降配额这条路。404（节点没这笔交易）和网络超时
 * 换端点也没意义 —— 前者换个节点还是 404，后者该由重试层处理。
 */
function isRateLimited(err: any): boolean {
  const m = String(err?.message ?? '');
  const s = err?.status ?? err?.response?.status;
  return s === 429 || s === 503 || /\b(429|503)\b/.test(m);
}

/**
 * 配额/权限用尽。
 *
 * 和 429 的区别决定处理方式：429 是「现在太挤，稍后再来」，退避降配额就行；
 * 402 是「这个 key 的额度用完了」，再等 30 秒也还是 402。当成普通故障处理的话，
 * 熔断 → 恢复 → 再失败会无限循环，日志刷屏之外还白占轮询名额。
 */
function isQuotaExhausted(err: any): boolean {
  const s = err?.status ?? err?.response?.status;
  if (s === 401 || s === 402) return true;
  return /out of CU|payment required|quota exceeded|insufficient (credit|funds)/i.test(
    String(err?.message ?? ''),
  );
}

/**
 * 「这个端点不认识 until」——和「这次请求失败了」必须分开。
 *
 * 混为一谈的后果很实际：一次网络抖动就把端点永久标记成不支持 until，
 * eventually 全部端点都被标掉，pick() 找不到任何合格端点，
 * 锚定翻页直接变成「All RPC endpoints failed」——而且再也回不来。
 *
 * 只有明确的「参数不认」才算：HTTP 400、JSON-RPC -32602，
 * 或节点自己那句 "failed to get signatures for address: ... not found"
 * （把 until 指向一个存在的签名还找不到，就是它不认 until）。
 * 超时、fetch failed、5xx 一律**不算**，那些是暂时的。
 */
function isParamUnsupported(err: any): boolean {
  const s = err?.status ?? err?.response?.status;
  if (s === 400) return true;
  if (err?.code === -32602) return true;          // JSON-RPC Invalid params
  const m = String(err?.message ?? '');
  return /failed to get signatures for address/i.test(m) && /not found|找不到/i.test(m);
}

/** 每个端点的起步 rps，也是降配额后回升的天花板 */
const RPC_INITIAL_RPS = 10;

/** 连续多少次返回 null 之后，判定该端点没有历史归档 */
const NULL_STREAK_LIMIT = 15;

export interface RpcEndpoint {
  url: string;
  weight: number;             // 基础权重 1-10
  rps: number;                // 估计的每秒请求上限
  fails: number;              // 连续失败计数
  circuitOpenUntil: number;   // 熔断截止时间戳 (ms)
  totalRequests: number;
  totalFails: number;
  // 新增：响应时间统计
  responseTimes: number[];    // 最近 100 次的响应时间 (ms)
  lastError: string;
  /**
   * 是否支持 getSignaturesForAddress 的 until 参数。
   *
   * undefined = 还没试过，按支持处理。实测 6 个端点里只有 quiknode / alchemy
   * 支持 until；zan.top、getblock、publicnode 会回 "Transaction not found"，
   * leorpc 直接参数校验报错。对不支持的端点发 until，**每次都失败**，
   * 所以第一次撞上就永久标记，之后带 until 的请求直接绕开它。
   */
  supportsUntil?: boolean;
  /**
   * 是否有历史归档（getTransaction 能不能取到几天前的交易）。
   *
   * undefined = 还没证据。实测 6 个端点里只有 quiknode / alchemy 有归档：
   * leorpc、publicnode、zan.top 对历史交易一律返回 null（它们也是那 3 个
   * 不支持 until 的节点 —— 非 archive 节点本来就没有「翻到某一笔之前」的能力）。
   * getblock 则是配额耗尽，直接 402。
   *
   * 为什么要单独记：这些端点对 getSlot、getSignaturesForAddress 仍然有用，
   * 一刀切踢掉反而更慢。只在「取历史交易」这件事上让位。
   */
  supportsArchive?: boolean;
  /** 连续返回 null 的次数，用来判定「这个端点没有归档」 */
  nullStreak: number;
  /**
   * 配额/权限已用尽（402 / 401 / "Out of CU"），本次进程内不再使用。
   *
   * 这类错误不会自己好：不是等几秒就能恢复的限流，而是账单意义上的没额度了。
   * 所以不能只熔断 —— 熔断 30 秒后它会回来继续 402，然后进入
   * 「熔断 → 恢复 → 再失败」的无限循环：日志刷屏，且每次失败都白占一次轮询
   * 名额和 200ms 退避，把本可以给别人的时间耗掉。
   */
  dead?: boolean;
  deadReason?: string;
}

export class MultiFreeRpc {
  private endpoints: RpcEndpoint[];
  private buckets = new Map<string, { tokens: number; lastRefill: number }>();
  private pendingRequests = new Map<string, Promise<any>>();
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private rrIndex = 0; // 下一个待选端点的起始索引（round-robin）

  constructor(urls: string[] = MultiFreeRpc.defaultEndpoints()) {
    this.endpoints = urls.map((url) => ({
      url,
      weight: 5,
      // 起步值。真实上限各端点差别很大（带 key 的能到几十，免费节点个位数），
      // 这里保守起步，交给 penalize() 挨了 429 往下压、reward() 成功后慢慢回升。
      rps: RPC_INITIAL_RPS,
      fails: 0,
      circuitOpenUntil: 0,
      totalRequests: 0,
      totalFails: 0,
      responseTimes: [],
      lastError: '',
      nullStreak: 0,
    }));
    this.pendingRequests = new Map();
    this.startHealthCheck();
  }

  static defaultEndpoints(): string[] {
    return [
      'https://api.mainnet-beta.solana.com',
      'https://rpc.ankr.com/solana',
      'https://solana.publicnode.com',
      'https://solana.api.onfinality.io/public',
    ];
  }

  /**
   * 选一个可用端点（严格 round-robin，熔断中的跳过）。
   *
   * needUntil   = true 时只考虑支持 until 的端点。
   * needArchive = true 时（取历史交易）只考虑有归档的端点。
   *
   * 这两种能力都是实测出来的、且各端点差别极大。带 until 的请求发给不支持的
   * 端点必然失败；取历史交易发给没归档的端点必然返回 null —— 两者都是白跑，
   * 还会白吃掉令牌桶配额和轮询名额，所以要在选端点这一步就绕开。
   */
  private pick(exclude?: Set<string>, needUntil = false, needArchive = false): RpcEndpoint | null {
    const now = Date.now();
    const n = this.endpoints.length;
    // 绕一整圈，跳过熔断中的，找到下一个可用端点
    for (let i = 0; i < n; i++) {
      const idx = (this.rrIndex + i) % n;
      const ep = this.endpoints[idx];
      if (exclude?.has(ep.url)) continue;
      if (ep.dead) continue;          // 配额用尽，进程内不再用
      if (needUntil && ep.supportsUntil === false) continue;
      if (needArchive && ep.supportsArchive === false) continue;
      if (ep.circuitOpenUntil < now) {
        // 下次从下一个开始，确保均匀轮询
        this.rrIndex = (idx + 1) % n;
        return ep;
      }
    }
    return null;
  }

  /**
   * 被 429 之后降配额。
   *
   * 429 说明的是「这个端点现在接不住」，不是「这个请求有问题」。所以要把端点
   * 本身压下去（rps 减半）并短暂熔断，让后面排队的请求也绕开它 —— 否则每个
   * 限流中的请求还会再来一次，把同一个端点彻底打死。
   *
   * 只降不升会把自己锁死：连续 429 之后 rps 跌到地板值 2 并永远停在那儿，
   * 一次网络抖动造成的限流会把端点永久废掉。所以配套两件事：
   *   1) 地板抬到 4（低于这个值信号量太小，吞吐直接归零）
   *   2) recordResult 成功时按比例慢慢回升，上限是初始 rps
   */
  private penalize(ep: RpcEndpoint) {
    const floor = Math.max(4, Math.ceil(RPC_INITIAL_RPS / 2));
    ep.rps = Math.max(floor, Math.floor(ep.rps / 2));
    ep.fails = 0;                       // 429 不算「坏了」，不算进熔断计数，否则 5 次就永久拉黑
    ep.circuitOpenUntil = Date.now() + 1_500;
    this.buckets.delete(ep.url);        // 令牌桶重置，按新 rps 重新起步
  }

  /**
   * 成功之后把配额慢慢还回去。
   *
   * 一次性拉满会让刚被限流过的端点再次被打爆，然后又是一轮 429 ——
   * 那样在两个极端之间来回震荡，实际吞吐反而更低。所以每次成功只回 1 rps，
   * 靠成功次数慢慢爬回上限。
   */
  private reward(ep: RpcEndpoint) {
    if (ep.rps < RPC_INITIAL_RPS) {
      ep.rps = Math.min(RPC_INITIAL_RPS, ep.rps + 1);
      this.buckets.set(ep.url, { tokens: ep.rps, lastRefill: Date.now() });
    }
  }

  /** 令牌桶：每个端点限速 */
  private consumeToken(ep: RpcEndpoint): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(ep.url);
    if (!bucket) {
      bucket = { tokens: ep.rps, lastRefill: now };
      this.buckets.set(ep.url, bucket);
    }
    // 补 token
    const elapsed = (now - bucket.lastRefill) / 1000;
    const refill = elapsed * ep.rps;
    bucket.tokens = Math.min(ep.rps, bucket.tokens + refill);
    bucket.lastRefill = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  /** 记录成功/失败，更新熔断状态 */
  private recordResult(ep: RpcEndpoint, ok: boolean, responseMs = 0, errMsg = '') {
    ep.totalRequests++;
    if (ok) {
      ep.fails = 0;
      ep.weight = Math.min(10, ep.weight + 0.5);
      // 成功就把之前被 429 压下去的配额还一点回去
      this.reward(ep);
      if (responseMs > 0) {
        ep.responseTimes.push(responseMs);
        if (ep.responseTimes.length > 100) ep.responseTimes.shift();
      }
    } else {
      ep.fails++;
      ep.totalFails++;
      ep.weight = Math.max(1, ep.weight - 1);
      ep.lastError = errMsg.slice(0, 200);
      if (ep.fails >= 5) {
        ep.circuitOpenUntil = Date.now() + 30_000;
        console.warn(`[multi-rpc] circuit open: ${ep.url} (fails=${ep.fails})`);
      }
    }
  }

  /** 计算百分位响应时间 */
  private percentile(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
    return sorted[idx];
  }

  /** 带缓存 + 请求合并的 RPC 调用 */
  async rpc<T>(method: string, params: any[], cacheMs = 0): Promise<T> {
    const cacheKey = this.buildCacheKey(method, params);
    const now = Date.now();

    // 1) Redis/内存缓存命中
    if (cacheMs > 0) {
      const hit = await Cache.get<T>(cacheKey);
      if (hit !== null && hit !== undefined) return hit;
    }

    // 2) 合并相同请求（防止雪崩）
    const pending = this.pendingRequests.get(cacheKey);
    if (pending) return pending as Promise<T>;

    // 3) 执行请求
    const promise = this.execute<T>(method, params).then(async (value) => {
      if (cacheMs > 0 && value !== null && value !== undefined) {
        await Cache.set(cacheKey, value, Math.ceil(cacheMs / 1000));
      }
      this.pendingRequests.delete(cacheKey);
      return value;
    }).catch((err) => {
      this.pendingRequests.delete(cacheKey);
      throw err;
    });
    this.pendingRequests.set(cacheKey, promise);
    return promise;
  }

  private buildCacheKey(method: string, params: any[]): string {
    if (method === 'getBlock') return cacheKeys.block(params[0]);
    if (method === 'getTransaction') return cacheKeys.tx(params[0]);
    if (method === 'getSignaturesForAddress') {
      return cacheKeys.sigs(params[0], params[1]?.before, params[1]?.until);
    }
    return `${method}:${JSON.stringify(params)}`;
  }

  private async execute<T>(method: string, params: any[]): Promise<T> {
    // 429 意味着「换个端点」，所以一轮要**走遍所有端点**。原来只试 3 个：
    // 6 个端点里只要有 3 个正在限流，这一请求就直接白送。6 个并发 worker
    // 一起这么干，等于整个池子只用了一半。
    const total = this.endpoints.length;
    let lastErr: any;
    const rateLimited = new Set<string>();
    // 「这个节点说它没有」和「限流/报错」要分开记，两者换个节点的理由不同
    const notFound = new Set<string>();
    // 带 until 的翻页只能发给支持它的端点
    const needUntil = method === 'getSignaturesForAddress' && !!params[1]?.until;
    // 取历史交易需要归档节点：实测 6 个端点里只有 2 个有归档，
    // 其余 4 个对历史交易一律返回 null。让它们照样参与轮询的话，
    // 2/3 的轮次和令牌桶配额会花在一个必然返回 null 的请求上。
    const needArchive = method === 'getTransaction' || method === 'getBlock';

    // 安全网：如果每个端点都被标成「不支持 until」，那基本是误标（早期版本会把
    // 网络错误也算进去）。这时清掉标记重试 —— 宁可多撞几次墙，也不能让锚定翻页
    // 永久失去所有端点之后再也回不来。
    if (needUntil && this.endpoints.every((e) => e.supportsUntil === false)) {
      console.warn('[multi-rpc] 全部端点都被标记为不支持 until，清除标记后重试（判定疑似过严）');
      for (const e of this.endpoints) e.supportsUntil = undefined;
    }

    // 同理，如果每个端点都被判成「配额用尽」，也清掉重来一次。
    // 402 有时是对方计费系统的抖动，全军覆没不该让整条链路彻底停摆。
    if (this.endpoints.every((e) => e.dead)) {
      console.warn('[multi-rpc] 所有端点都被判定为配额用尽，清除标记后重试（疑似计费抖动）');
      for (const e of this.endpoints) { e.dead = false; e.deadReason = undefined; }
    }

    // 同样的安全网：归档判定也允许翻案。全被降级就重新挨个问一遍 ——
    // 宁可慢，也不能让「取历史交易」这条路彻底失去所有端点。
    if (needArchive && this.endpoints.every((e) => e.supportsArchive === false)) {
      console.warn('[multi-rpc] 全部端点都被判定为无归档，清除标记后重试');
      for (const e of this.endpoints) { e.supportsArchive = undefined; e.nullStreak = 0; }
    }

    // 「令牌桶空」不算一次尝试。原来它和真正的请求失败共用同一个 for 计数，
    // 于是限速把端点预算直接吃掉：6 次机会里有 2 次花在「等令牌」上，
    // 真正发出的请求只剩 4 次，而池子里明明还有端点没试。
    // 改成按**发过的请求数**计数，另加一个总时限兜底，防止极端情况死转。
    const deadline = Date.now() + 15_000;
    let tried = 0;
    while (tried < total && Date.now() < deadline) {
      const ep = this.pick(rateLimited, needUntil, needArchive);
      if (!ep) break;   // 其余全在熔断窗口内（或全都不支持 until / 无归档）

      if (notFound.has(ep.url)) continue;   // 这个节点已经说过「没有」了
      if (!this.consumeToken(ep)) {
        // 没抢到令牌：等一下再抢。pick() 每次都会把 rrIndex 往后挪一格，
        // 所以下一轮自然就轮到别的端点，不用在这里手动改轮询位置。
        await new Promise((r) => setTimeout(r, 80));
        continue;
      }
      tried++;

      const start = Date.now();
      try {
        const conn = new Connection(ep.url, 'confirmed' as Commitment);
        const result = await this.callMethod(conn, method, params);
        const ms = Date.now() - start;
        this.recordResult(ep, true, ms);

        // getTransaction / getBlock 返回 null，意思是**这个节点手上没有**，
        // 不是「链上不存在」。非 archive 节点和被裁剪的历史都会这样，6 个端点里
        // 实测有 4 个对同一笔交易返回 null。立刻返回就等于用四分之一的覆盖���
        // 去回答「取不到」，下游只能把已经算对的行判成算不出。
        // 所以：换节点再问，全都问不到才算真的没有。
        if (result == null && needArchive) {
          notFound.add(ep.url);
          // 连续多次返回 null = 这个节点没有历史归档。
          // 累计到阈值就永久降级：之后取历史交易直接绕开它，
          // 但 getSlot / getSignaturesForAddress 照常用它 —— 一刀切踢掉反而更慢。
          if (++ep.nullStreak >= NULL_STREAK_LIMIT && ep.supportsArchive !== false) {
            ep.supportsArchive = false;
            console.warn(
              `[multi-rpc] ${new URL(ep.url).host} 连续 ${ep.nullStreak} 次取不到历史交易，` +
              `判定为无归档节点，之后取历史交易不再发给它（slot / 翻页仍可用）`,
            );
          }
          continue;
        }
        // 拿到了就说明有归档，清掉降级标记（配额恢复后不该继续被排除）
        ep.nullStreak = 0;
        if (ep.supportsArchive === false) {
          ep.supportsArchive = true;
          console.warn(`[multi-rpc] ${new URL(ep.url).host} 又取到历史交易了，恢复归档能力`);
        }
        return result as T;
      } catch (err: any) {
        const ms = Date.now() - start;
        this.recordResult(ep, false, ms, err.message ?? String(err));
        lastErr = err;
        // 配额/权限用尽（402 / 401 / "Out of CU"）→ 端点直接停用。
        // 必须排在 isRateLimited 前面：有些节点用 402 表达「超出额度」，
        // 当成限流处理就是「熔断 30 秒 → 恢复 → 再 402」的无限循环，
        // 实测 getblock 就是这样把 fails 从 5 数到 95 还在涨，日志全被它刷掉。
        if (isQuotaExhausted(err)) {
          if (!ep.dead) {
            ep.dead = true;
            ep.deadReason = (err.message ?? String(err)).slice(0, 120);
            ep.fails = 0;
            console.warn(
              `[multi-rpc] ${new URL(ep.url).host} 配额/权限用尽，本次进程内停用：${ep.deadReason}`,
            );
          }
          rateLimited.add(ep.url);
          continue;
        }
        if (isRateLimited(err)) {
          rateLimited.add(ep.url);
          this.penalize(ep);
          continue;
        }
        // 明确的「参数不认」→ 永久排除该端点的 until 能力，并把熔断计数清零：
        // 它没坏，只是不支持这个参数，不该继续占着熔断名额拖累同端点的正常请求。
        if (needUntil && isParamUnsupported(err)) {
          ep.supportsUntil = false;
          ep.fails = 0;
          console.warn(
            `[multi-rpc] ${new URL(ep.url).host} 不支持 until 翻页，已排除（以后带 until 的请求不再发给它）`,
          );
          continue;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    // 够格的端点 = 满足本次调用全部能力要求的。取历史交易时只有有归档的算，
    // 否则「全都取不到」会误判成「链上没这笔」，而实际情况是问错了节点。
    const eligible = this.endpoints.filter(
      (e) => !e.dead
        && (!needUntil || e.supportsUntil !== false)
        && (!needArchive || e.supportsArchive !== false),
    );

    // 每个够格的端点都说「手上没有」→ 链上确实没有这笔，返回 null 让调用方
    // 如实知道「取不到」，而不是抛一个会被当成网络故障重试的错误。
    if (notFound.size > 0 && eligible.length > 0 && eligible.every((e) => notFound.has(e.url))) {
      return null as T;
    }

    // 所有**够格的**端点都 429 过了。与其立刻把错误抛给调用方（它 500ms 后又来
    // 一遍，正好又撞在限流窗口里），不如等到最早的那个恢复再试一次。
    // 注意是按「够格的端点」算，不是按端点总数 —— 带 until 时只有 2 个端点有资格。
    if (eligible.length > 0 && eligible.every((e) => rateLimited.has(e.url))) {
      const waitMs = Math.max(
        200,
        Math.min(...eligible.map((e) => e.circuitOpenUntil - Date.now())),
      );
      await new Promise((r) => setTimeout(r, waitMs));
      const retry = this.pick(undefined, needUntil, needArchive);
      if (retry && this.consumeToken(retry)) {
        try {
          const conn = new Connection(retry.url, 'confirmed' as Commitment);
          const t0 = Date.now();
          const result = await this.callMethod(conn, method, params);
          this.recordResult(retry, true, Date.now() - t0);
          return result as T;
        } catch (err: any) {
          this.recordResult(retry, false, 0, err.message ?? String(err));
          lastErr = err;
        }
      }
    }

    throw lastErr ?? new Error('All RPC endpoints failed');
  }

  private async callMethod(conn: Connection, method: string, params: any[]): Promise<any> {
    switch (method) {
      case 'getBlock':
        // 默认 maxSupportedTransactionVersion=1，支持 legacy + v0 + v1
        return conn.getBlock(params[0], params[1] ?? { maxSupportedTransactionVersion: 1 });
      case 'getTransaction':
        return conn.getTransaction(params[0], params[1] ?? { maxSupportedTransactionVersion: 1 });
      case 'getSignaturesForAddress':
        return conn.getSignaturesForAddress(new PublicKey(params[0]), params[1] ?? { limit: 100 });
      case 'getSlot':
        return conn.getSlot();
      case 'getBlockHeight':
        return conn.getBlockHeight();
      case 'getMultipleAccounts':
        return conn.getMultipleAccountsInfo(params[0].map((p: string) => new PublicKey(p)));
      default:
        throw new Error(`Unsupported method: ${method}`);
    }
  }

  /**
   * 启动后台健康检查。
   *
   * 对已停用（配额用尽）的端点，这次 ping 同时是「额度有没有回来」的探针：
   * ping 成功就复活，ping 仍然报配额错就保持停用、且**不**再计失败次数 ——
   * 否则一个已经确定没额度的端点会每分钟重新触发一次熔断并刷一行日志。
   */
  private startHealthCheck() {
    if (this.healthCheckTimer) return;
    this.healthCheckTimer = setInterval(async () => {
      // 每个端点 ping 一下
      for (const ep of this.endpoints) {
        if (ep.circuitOpenUntil > Date.now()) continue;
        try {
          const conn = new Connection(ep.url, 'confirmed' as Commitment);
          await Promise.race([
            conn.getSlot(),
            new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 3000)),
          ]);
          if (ep.dead) {
            console.warn(`[multi-rpc] ${new URL(ep.url).host} 额度恢复了，重新启用`);
            ep.dead = false;
            ep.deadReason = undefined;
            ep.fails = 0;
          }
          this.recordResult(ep, true);
        } catch (err: any) {
          if (ep.dead && isQuotaExhausted(err)) continue;   // 额度还没回来，维持停用
          this.recordResult(ep, false);
        }
      }
    }, 60_000); // 每分钟一次
  }

  /** 关闭 */
  destroy() {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
  }

  /** 当前端点状态（调试用，含响应时间） */
  getStatus() {
    return this.endpoints.map((e) => ({
      url: e.url,
      shortUrl: e.url.replace(/^https?:\/\//, '').slice(0, 30),
      weight: Math.round(e.weight * 10) / 10,
      fails: e.fails,
      successRate: e.totalRequests > 0
        ? ((1 - e.totalFails / e.totalRequests) * 100).toFixed(1) + '%'
        : 'N/A',
      circuitOpen: e.circuitOpenUntil > Date.now() ? 'OPEN' : 'OK',
      supportsUntil: e.supportsUntil === false ? 'NO' : 'yes',
      archive: e.supportsArchive === false ? 'NO' : 'yes',
      dead: e.dead ? `YES (${e.deadReason ?? ''})` : 'no',
      rpsCap: e.rps,
      totalRequests: e.totalRequests,
      p50ms: this.percentile(e.responseTimes, 0.5),
      p95ms: this.percentile(e.responseTimes, 0.95),
      lastError: e.lastError,
    }));
  }

  // ====== 便捷方法（带缓存） ======

  async getBlock(slot: number): Promise<BlockResponse | null> {
    // block 缓存 30 秒（slot 不会重组超过这点时间）
    return this.rpc('getBlock', [slot, { maxSupportedTransactionVersion: 1, transactionDetails: 'full' }], 30_000);
  }

  async getTransaction(sig: string): Promise<TransactionResponse | null> {
    return this.rpc('getTransaction', [sig, { maxSupportedTransactionVersion: 1 }], 5 * 60_000);
  }

  async getSignaturesForAddress(
    address: string,
    limit = 100,
    before?: string,
    until?: string,
  ): Promise<any[]> {
    // before / until 都要透传进 options，否则调用方分页时每一页都拉回同一批签名。
    // until = 只取「比这个签名更新」的，配合 before 就能把窗口框在两者之间，
    // 从而**从任意一笔往回翻**而不用先翻到链尾。
    return this.rpc(
      'getSignaturesForAddress',
      [
        address,
        {
          limit,
          ...(before ? { before } : {}),
          ...(until ? { until } : {}),
        },
      ],
      5_000,
    );
  }
}

let _instance: MultiFreeRpc | null = null;

function loadRpcEndpoints(): string[] {
  const urls: string[] = [];
  for (let i = 1; ; i++) {
    const val = process.env[`SOLANA_RPC_${i}`];
    if (val === undefined || val.trim() === '') break;
    urls.push(val.trim());
  }
  return urls.length > 0 ? urls : MultiFreeRpc.defaultEndpoints();
}

export function getMultiRpc(): MultiFreeRpc {
  if (!_instance) {
    const urls = loadRpcEndpoints();
    _instance = new MultiFreeRpc(urls);
  }
  return _instance;
}
