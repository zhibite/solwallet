// Agent Decision System
// AI-powered decision making for target management

// Snapshot generation
export {
  generateTargetSnapshot,
  generateSnapshotsForAllTargets,
} from './snapshot';
export type { TargetSnapshot } from './snapshot';

// Prompt templates
export { SYSTEM_PROMPT, buildUserPrompt, buildBatchPrompt } from './prompts';
export type { Decision } from './prompts';

// Knowledge base
export {
  loadKnowledgeBase,
  loadKnowledgeByCategory,
  buildKnowledgeContext,
  addKnowledge,
  updateKnowledge,
  deleteKnowledge,
  getCategories,
  getKnowledgeStats,
} from './knowledge';
export type { KnowledgeEntry, KnowledgeCategory } from './knowledge';

// LLM client
// 公开版：getPublicLLMConfig 剥掉 apiKey（Fix #4），供 API 响应使用
// 完整版：getLLMConfig 带 apiKey，仅供 lib 内部使用
export {
  callLLM,
  getPublicLLMConfig,    // Fix #4: 剥掉 apiKey
  setLLMConfig,
  getAvailableModels,
} from './llm';
export type { LLMConfig, PublicLLMConfig, LLMMessage, LLMResponse, LLMError } from './llm';

// Decision parsing
export {
  parseLLMResponse,
  validateDecisions,
} from './decide';

// Decision execution
// 公开：getRecentDecisions (API 用), getGlobalSettings / updateGlobalSettings (API 用)
// 内部：executeDecision / recordDecision / updateRoundExecutionCount / toggleGlobalShadowMode
//       — Fix #15: 这些由 runner.ts 串起来用，不该从外部 import
export {
  getRecentDecisions,
  getGlobalSettings,
  updateGlobalSettings,
} from './executor';
export type { ExecutionResult, TargetInfo } from './executor';

// Agent runner
export {
  runAgentRound,
  getLatestRound,
  getRoundWithDecisions,
  getRecentRounds,
  getAgentStats,
} from './runner';
export type { AgentRound, RunResult } from './runner';

// Scheduler
export {
  startScheduler,
  stopScheduler,
  updateSchedulerSettings,
  triggerImmediateRound,
  getSchedulerState,
  getSchedulerHealth,
} from './scheduler';
export type { SchedulerState } from './scheduler';

// Auth (Fix #5)
export { checkAgentAuth, resetAgentAuthCache } from './auth';

// 内部 API —— 明确标注「别从 lib/agent 外直接 import」。
// 留这个口子只是因为 scheduler.ts 内部 use server 需要能跨文件复用。
// 业务代码（包括 API route）应该走上面的公开 exports。
/** @internal */
export {
  getLLMConfig,  // 含 apiKey
  executeDecision,
  recordDecision,
  updateRoundExecutionCount,
  toggleGlobalShadowMode,
} from './internal';
