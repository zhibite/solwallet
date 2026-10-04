/**
 * Solana 跟单抢单监控系统 - 核心类型定义
 */

export type TargetStatus = 'active' | 'paused';

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
  /** 0007: 这笔买入收到的 token 数量，单笔跟单收益按它做 FIFO 配对 */
  token_amount: string | null;
  /** 0007: open=持仓中 / closed=已平仓 / partial=部分平仓 / buy_failed=买入失败 */
  pnl_status: string | null;
  /** 0007: 该笔买入的 token 已卖出比例 0~1 */
  pnl_sold_ratio: string | null;
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
