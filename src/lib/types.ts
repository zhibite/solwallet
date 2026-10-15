/**
 * Solana 跟单抢单监控系统 - 核心类型定义
 */

export type TargetStatus = 'active' | 'paused';

/**
 * Solana tip 渠道分类。同一笔 buy 可能走不同 tip 服务，
 * 因此光看 tip_sol 金额无法判断渠道——必须用收款地址映射。
 *
 * 收款地址 → 渠道的映射表：src/lib/parser.ts 的 SOLANA_TIP_SOURCE_MAP。
 *
/**
 *   - 'jito'           : Jito（mainnet.block-engine.jito.wtf 的 8 个 tip account）
 *   - 'helius_sender'  : Helius Sender（多通路：Jito/Harmonic/Rakurai 走同一个 tip 账户池）
 *   - 'landx'          : LandX（landx.dev 的 10 个 tip account，前缀 LandX）
 *   - 'zero_slot'      : 0slot.trade 的 10 个 tip account
 *   - 'extended_tip'   : 通过启发式识别（feePayer 出去的最小非 self SOL 转账，< 30% buy_sol），
 *                        但收款地址不在上面 4 通道里。新发现的 tip 服务（Astralane / rapidX /
 *                        Jito TipRouter / 未知 tip pool）会落到这里。
 *   - 'unknown'        : 已知表/启发式都判定是 tip，但渠道仍无法归类
 *   - null/undefined   : 该笔未付 tip（不是任何 tip 通道；普通 v0 tx / 纯 prio 通道）
 */
export type TipSource = 'jito' | 'helius_sender' | 'landx' | 'zero_slot' | 'extended_tip' | 'unknown';

export interface MonitoredTarget {
  id: number;
  address: string;
  label: string | null;
  threshold_sol: string;       // pg numeric -> string
  status: TargetStatus;
  created_at: string;
  updated_at: string;
  last_buy_at: string | null;
  record_count: number;
}

export interface OwnWallet {
  id: number;
  address: string;
  label: string | null;
  created_at: string;
}

export type TradeStatus = 'pending' | 'confirmed' | 'failed';

export interface TargetTrade {
  id: number;
  target_id: number;
  signature: string;
  slot: number;
  block_time: string;
  mint: string;
  target_address: string;
  buy_sol: string;
  target_tip_sol: string | null;
  target_prio_lamports: number | null;
  is_bundled: boolean;
  /** 0008: 解析时是否观察到 Address Lookup Table（v0 才有，Helius 路径可能为 null） */
  has_alt: boolean | null;
  /** 0008: 同 bundle 多笔共享的 ID */
  bundle_id: string | null;
  /**
   * 0010: tip 收款渠道（从 SOLANA_TIP_SOURCE_MAP 映射得出）。
   * null = 该笔未付 tip；非 null = 走的是哪个 tip 通道。
   */
  tip_source: TipSource | null;
  /**
   * 0008: 同 bundle_id 在 target_trades 表内的行数。
   * 注意：≠ Solana bundle 内总 tx 数（monitor 只记录目标 wallet 的买入）；
   *      同 bundle 内 5 笔 sniper tx 只买 1 个目标 wallet 时，这里也是 1。
   *      真实 bundle 大小参考 block_buyers.bundle_size。
   */
  bundle_size: number | null;
  first_sniper: string | null;
  first_sniper_buy_sol: string | null;
  first_sniper_tip_sol: string | null;
  first_sniper_prio_lamports: number | null;
  first_sniper_signature: string | null;
  pnl_sol: string | null;
  fee_sol: string | null;
  status: TradeStatus;
  version: string | null;
  confirmed: boolean;
  notes: string | null;
  created_at: string;
}

export interface BlockAnalysis {
  id: number;
  slot: number;
  mint: string;
  target_signature: string;
  block_time: string;
  /** 目标 tx 在 block 内的顺序索引 */
  target_block_index: number | null;
  /** 同一 slot 内同一 mint 的买入笔数 */
  same_slot_count: number;
  /** 下一个 slot 内同一 mint 的买入笔数 */
  next_slot_count: number;
  /** 0021: 狙击者竞争态势（块级） */
  competitor_count: number | null;
  /** 0021: 系统选中的狙击者地址（默认 = first_sniper，可被决策逻辑覆盖） */
  chosen_address: string | null;
  /** 0021: 竞争者排名 JSON：{ "<address>": rank1, ... } */
  competitor_rank: Record<string, number> | null;
  created_at: string;
}

export interface BlockBuyer {
  id: number;
  block_analysis_id: number;
  slot: number;
  /** 在 block（含下一个 slot 合并后的）内的顺序索引 */
  block_index: number;
  /** 相对目标 tx 的块内位置差（block_index - target_block_index）。下一 slot 行为 NULL */
  offset_pos: number | null;
  /** 相对目标 tx 的时间偏移（ms），保留字段主要做兼容 */
  offset_ms: number | null;
  /** 0 = 同一 slot, 1 = 下一个 slot */
  slot_offset: number;
  signature: string;
  address: string;
  buy_sol: string;
  tip_sol: string | null;
  prio_lamports: number | null;
  pnl_sol: string | null;
  is_first_sniper: boolean;
  is_follower: boolean;
  is_own: boolean;
  is_pre_target: boolean;
  result: string | null;
  version: string | null;
  is_bundled: boolean;
  /** 0008: 解析时是否观察到 Address Lookup Table */
  has_alt: boolean | null;
  /** 0008: 同 bundle 多笔共享的 ID */
  bundle_id: string | null;
  /** 0008: 同 bundle 内的笔数（≥2 才有意义） */
  bundle_size: number | null;
  /** 0010: 该笔走的 tip 通道（null = 未付 tip） */
  tip_source: TipSource | null;
  /** 0007: 这笔买入收到的 token 数量，单笔跟单收益按它做 FIFO 配对 */
  token_amount: string | null;
  /** open=持仓中 / closed=已平仓 / partial=部分平仓 / buy_failed=买入失败 */
  pnl_status: string | null;
  /** 该笔买入的 token 已卖出比例 0~1 */
  pnl_sold_ratio: string | null;
  /** 0018: 该笔是否是目标本人（signature = analysis.target_signature） */
  is_self: boolean;
  /** 0021: 我们 own wallet 在该 block 的竞争 rank（NULL=不是 own） */
  mine_rank: number | null;
  /** 0021: 相对目标 slot 的差（-1=前置，0=同 slot，1=下一 slot） */
  sniper_slot_delta: number | null;
  /** 0021: 在同+next-slot 非 own 非 target 内的排名（1-based；NULL=不参与竞争） */
  competitor_rank: number | null;
}

/** Helius Enhanced Transaction 简化结构 */
export interface HeliusEnhancedTx {
  signature: string;
  slot: number;
  blockTime: number;
  fee: number;
  feePayer: string;
  version: 'legacy' | 0;
  accountData?: Array<{ account: string; nativeBalanceChange: number; tokenBalanceChanges?: any[] }>;
  tokenTransfers?: Array<{ fromUserAccount: string; toUserAccount: string; fromTokenAccount: string; toTokenAccount: string; tokenAmount: number; mint: string; tokenStandard: string }>;
  nativeTransfers?: Array<{ fromUserAccount: string; toUserAccount: string; amount: number }>;
  type?: string;
  source?: string;
  description?: string;
  /**
   * Helius 增强 API 的失败标记。注意失败判定只能看这个字段：
   * `err` 是 getSignaturesForAddress 才有的，parseTransaction 返回的对象上永远是 undefined。
   */
  transactionError?: unknown;
  events?: any;
  instructions?: Array<{ programId: string; accounts: string[]; data: string; innerInstructions?: any[] }>;
}

/** Solana RPC Block 响应简化 */
export interface SolanaBlock {
  blockhash: string;
  blockTime: number | null;
  blockHeight?: number;
  parentSlot: number;
  transactions: Array<{
    transaction: {
      signatures: string[];
      message: {
        accountKeys: string[];
        instructions: any[];
        recentBlockhash: string;
      };
    };
    meta: {
      err: any | null;
      fee: number;
      preBalances: number[];
      postBalances: number[];
      innerInstructions?: any[];
      preTokenBalances?: any[];
      postTokenBalances?: any[];
    };
  }>;
}

// =====================================================================
// 0020 共享：监控目标行
//
// 之前 TargetRow.tsx 和 MonitorList.tsx 各自定义了局部 `Target`，
// 一个是「旧版」(pnl_sol / pnl_sold_ratio 必填、缺浮盈三件套)，
// 一个是「0020 版」(三段式可选、缺 pnl_sold_ratio)，导致 tsc 报
// "Two different types with this name exist, but they are unrelated"。
//
// 后端 /api/targets 实际是同时把两套字段都返回来（见
// src/app/api/targets/route.ts 的 last_sniper_* 投影），所以这里
// 把所有字段并到同一个类型上，并标成可选。
// =====================================================================

/** 该监控目标最近一笔「真的被抢过」的 first_sniper 买入 */
export interface TargetLastSniper {
  address: string;
  signature: string;
  /** block 内相对目标 tx 的位置差 */
  offset_pos: number | null;
  /** block 内相对目标 tx 的时间偏移（ms） */
  offset_ms: number | null;
  tip_sol: string | null;
  prio_lamports: number | null;
  buy_sol: string | null;
  tip_source: TipSource | null;
  slot: number;
  mint: string;
  block_time: string;
  /** 【P1-#3】目标自己在这一笔的 tip（不是狙击者的 tip） */
  target_tip_sol: string | null;
  /** 【P1-#3】目标自己在这一笔的 prio fee（不是狙击者的 prio） */
  target_prio_lamports: number | null;
  /** 狙击者那笔的 PnL（=「如果跟单这个狙击者能赚多少」） */
  pnl_sol: string | null;
  /** open=持仓中 / closed=已平仓 / partial=部分平仓 / buy_failed=买入失败 */
  pnl_status: string | null;
  /** 已卖出比例 0~1（老版字段，0020 后继续保留） */
  pnl_sold_ratio: string | null;
  /** 0020: 浮盈（未实现），open/partial 才有意义；closed 时 = 0 */
  unrealized_sol: string | null;
  /** 0020: 总 PnL = pnl_sol(已实现) + unrealized_sol，UI 主显示值 */
  total_pnl_sol: string | null;
  /** 0020: 当前价格 SOL 单位（拉不到为 null） */
  current_price_sol: string | null;
  /** 0020: 价格刷新时间（> 60s 没刷 UI 标 ~ 表示可能过期） */
  price_updated_at: string | null;
}

/** 跟单决策聚合（由后端 /api/targets 一起返回） */
export interface TargetDecision {
  worth_score: number | null;
  win_rate: number;
  avg_pnl_sol: number;
  p50_tip_sol: number | null;
  p50_prio_lamports: number | null;
  p75_tip_sol: number | null;
  p75_prio_lamports: number | null;
  success_count: number;
  failed_count: number;
  sample_size: number;
}

/** 监控列表里的一行目标 */
export interface Target {
  id: number;
  address: string;
  label: string | null;
  threshold_sol: string;
  status: TargetStatus;
  record_count: number;
  last_buy_at: string | null;
  updated_at: string;
  auto_follow: boolean;
  last_sniper?: TargetLastSniper | null;
  decision?: TargetDecision;
}
