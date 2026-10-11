import { TargetSnapshot } from './snapshot';

export interface Decision {
  action: 'enable' | 'disable' | 'delete' | 'limit_update' | 'hold';
  params: {
    position_sol?: number;
    tip_sol?: number;
    gas_sol?: number;
    slippage?: number;
    high_gas_mode?: boolean;
    high_gas_sol?: number;
    high_gas_tip_sol?: number;
    high_gas_slippage?: number;
  } | null;
  reasoning: string;
  confidence: number; // 0.0 - 1.0
}

export const SYSTEM_PROMPT = `你是 Solana 跟单交易系统的 AI 决策引擎。

## 你的角色
分析钱包的历史交易数据，做出是否开启、暂停、调整参数的决策。

## 可用动作
1. **enable** - 开启跟单（用于暂停中的目标）
2. **disable** - 暂停跟单（保留目标但不执行交易）
3. **delete** - 删除目标（用于彻底不需要的目标）
4. **limit_update** - 调整跟单参数（position_sol/tip_sol/gas_sol/slippage）
5. **hold** - 保持现状不变

> **关于 enable / limit_update 的隐式 add**：如果目标在 akbot 端尚无对应配置
> （snapshot 里显示"akbot 映射: 无"），第一次执行 enable 或 limit_update 会
> **自动先在 akbot 创建配置**（add），然后再 switch/update。不需要也无法主动
> 输出 add 动作。执行结果以最终端点（switch / update）的成功为准。

## 决策参数
当动作是 limit_update 时，可以同时调整以下参数：
- position_sol: 每次跟单投入的 SOL 数量（建议 0.5-3.0）
- tip_sol: Jito tip 上限（建议 0.001-0.02）
- gas_sol: Priority fee 上限（建议 0.001-0.01）
- slippage: 滑点容忍（建议 0.05-0.5，即 5%-50%）
- high_gas_mode: 是否启用高gas模式（true/false）
- high_gas_sol: 高gas模式下的 gas 上限
- high_gas_tip_sol: 高gas模式下的 tip 上限
- high_gas_slippage: 高gas模式下的滑点

## 决策要求
1. 优先看胜率和平均利润
2. 新目标（<3 笔交易）建议 hold，除非胜率明显 > 60%
3. 胜率 < 40% 或连续亏损建议 disable
4. 目标使用高gas策略时，考虑提高我方gas
5. 置信度 0.0-1.0，越高表示越确定

## 输出格式
必须返回 JSON 格式：
{
  "action": "enable|disable|delete|limit_update|hold",
  "params": { ... } | null,
  "reasoning": "决策理由（1-3句话）",
  "confidence": 0.0-1.0
}`;

export function buildUserPrompt(snapshot: TargetSnapshot): string {
  const lines: string[] = [];
  
  // Header
  lines.push(`## 目标信息`);
  lines.push(`- 地址: ${snapshot.target_address}`);
  if (snapshot.target_label) {
    lines.push(`- 标签: ${snapshot.target_label}`);
  }
  lines.push(`- 当前状态: ${snapshot.target_status}`);
  lines.push(`- 阈值: ${snapshot.threshold_sol} SOL`);
  lines.push(`- Agent影子模式: ${snapshot.agent_shadow ? '开启' : '关闭'}`);
  
  // Historical stats
  lines.push(``);
  lines.push(`## 历史统计`);
  lines.push(`- 总交易: ${snapshot.stats.total_trades} 笔`);
  lines.push(`- 胜者: ${snapshot.stats.winners}`);
  lines.push(`- 败者: ${snapshot.stats.losers}`);
  lines.push(`- 胜率: ${(snapshot.stats.win_rate * 100).toFixed(1)}%`);
  if (snapshot.stats.avg_profit !== null) {
    lines.push(`- 均利润: ${snapshot.stats.avg_profit > 0 ? '+' : ''}${snapshot.stats.avg_profit.toFixed(4)} SOL`);
  }
  if (snapshot.stats.total_profit !== null) {
    lines.push(`- 累计利润: ${snapshot.stats.total_profit > 0 ? '+' : ''}${snapshot.stats.total_profit.toFixed(4)} SOL`);
  }
  
  // Tip/Prio stats
  if (snapshot.tip_stats.median_tip !== null || snapshot.tip_stats.median_prio !== null) {
    lines.push(``);
    lines.push(`## Gas 设置`);
    if (snapshot.tip_stats.median_tip !== null) {
      lines.push(`- Tip 中位数: ${snapshot.tip_stats.median_tip.toFixed(4)} SOL`);
    }
    if (snapshot.tip_stats.median_prio !== null) {
      lines.push(`- Prio 中位数: ${snapshot.tip_stats.median_prio.toFixed(4)} SOL`);
    }
    if (snapshot.gas_analysis.target_tip_max !== null) {
      lines.push(`- 目标最大Tip: ${snapshot.gas_analysis.target_tip_max.toFixed(4)} SOL`);
    }
  }
  
  // Gas analysis
  if (snapshot.gas_analysis.our_gas !== null) {
    lines.push(``);
    lines.push(`## Gas 竞争力`);
    lines.push(`- 我方当前Gas: ${snapshot.gas_analysis.our_gas.toFixed(4)} SOL`);
    if (snapshot.gas_analysis.reason) {
      lines.push(`- 分析: ${snapshot.gas_analysis.reason}`);
    }
  }
  
  // Our performance
  lines.push(``);
  lines.push(`## 我方战绩`);
  lines.push(`- 我方交易: ${snapshot.our_stats.trades} 笔`);
  lines.push(`- 我方胜率: ${snapshot.our_stats.trades > 0 ? ((snapshot.our_stats.wins / snapshot.our_stats.trades) * 100).toFixed(1) : 'N/A'}%`);
  if (snapshot.our_stats.total_pnl !== null) {
    lines.push(`- 我方累计Pnl: ${snapshot.our_stats.total_pnl > 0 ? '+' : ''}${snapshot.our_stats.total_pnl.toFixed(4)} SOL`);
  }
  if (snapshot.our_stats.profit_missing) {
    lines.push(`- ⚠️ 我方尚无此目标交易记录`);
  }
  
  // Current params
  if (snapshot.current_params) {
    lines.push(``);
    lines.push(`## 当前参数`);
    if (snapshot.current_params.position_sol !== null) {
      lines.push(`- 仓位: ${snapshot.current_params.position_sol} SOL`);
    }
    if (snapshot.current_params.tip_sol !== null) {
      lines.push(`- Tip: ${snapshot.current_params.tip_sol} SOL`);
    }
    if (snapshot.current_params.gas_sol !== null) {
      lines.push(`- Gas: ${snapshot.current_params.gas_sol} SOL`);
    }
    if (snapshot.current_params.slippage !== null) {
      lines.push(`- 滑点: ${(snapshot.current_params.slippage * 100).toFixed(1)}%`);
    }
    if (snapshot.current_params.high_gas_mode) {
      lines.push(`- 高Gas模式: 开启`);
      if (snapshot.current_params.high_gas_tip_sol !== null) {
        lines.push(`- 高Gas Tip: ${snapshot.current_params.high_gas_tip_sol} SOL`);
      }
    }
  }
  
  // LLM context (raw stats string)
  lines.push(``);
  lines.push(`## 原始数据`);
  lines.push(snapshot.llm_context);
  
  // Request
  lines.push(``);
  lines.push(`请根据以上数据给出决策：`);
  
  return lines.join('\n');
}

export function buildBatchPrompt(snapshots: TargetSnapshot[], knowledgeContext: string): string {
  const targetsSection = snapshots
    .map((s, i) => {
      return `### 目标 ${i + 1}: ${s.target_address}${s.target_label ? ` (${s.target_label})` : ''}\n${buildUserPrompt(s)}`;
    })
    .join('\n\n');
  
  return `## 批量决策请求

共 ${snapshots.length} 个目标需要决策。

${knowledgeContext ? `\n## 知识库规则\n${knowledgeContext}\n` : ''}

${targetsSection}

请逐个给出决策，格式为：
### 决策 [序号]
{
  "action": "...",
  "params": {...} | null,
  "reasoning": "...",
  "confidence": ...
}`;
}
