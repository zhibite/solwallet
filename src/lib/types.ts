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
  created_at: string;
}

export interface BlockBuyer {
  id: number;
  block_analysis_id: number;
  slot: number;
  block_index: number;
  offset_ms: number | null;
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
  events?: any;
  instructions?: Array<{ programId: string; accounts: string[]; data: string; innerInstructions?: any[] }>;
}

/** Solana RPC Block 响应简化 */
export interface SolanaBlock {
  blockhash: string;
  blockTime: number | null;
  blockHeight: number;
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
