/**
 * 内部 API 重导出。
 *
 * 之前所有 internal-use 函数都从各个 module 文件直接 export，被 index.ts 透传出去。
 * 业务代码（API route、UI）误 import `executeDecision` / `recordDecision` /
 * `getLLMConfig` (含 apiKey) 就有意外副作用：跳过 LLM decision path 直接改
 * monitored_targets、读到明文 key 等。
 *
 * 这里把这些"内部用"函数集中重导出，index.ts 用 `@internal` 标记，**业务代码
 * 应当继续走 index.ts 的公开 exports**。
 *
 * 例外：runner.ts / scheduler.ts / executor.ts 之间相互 import 仍走这里。
 *
 * Fix #15
 */

export { getLLMConfig } from './llm';
export {
  executeDecision,
  recordDecision,
  updateRoundExecutionCount,
  toggleGlobalShadowMode,
} from './executor';
