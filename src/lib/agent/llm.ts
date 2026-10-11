'use server';

import { query, queryOne } from '../db';

export interface LLMConfig {
  provider: 'openai' | 'deepseek' | 'anthropic';
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * 公开给 API 返回的 LLM 配置。**故意不带 apiKey** —— Fix #4：
 * 之前 getLLMConfig() 返回完整 LLMConfig，agent_settings GET 把 key 塞进
 * HTTP 响应，浏览器按 F12 就能拿到直接花余额。基址/温度这些无关值可以公开。
 */
export type PublicLLMConfig = Omit<LLMConfig, 'apiKey'> & {
  /** 是否已配置了 key（true / false，不暴露 key 本身） */
  hasApiKey: boolean;
};

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
  finishReason: string;
}

export interface LLMError {
  message: string;
  code?: string;
  status?: number;
}

const DEFAULT_DEEPSEEK_CONFIG: LLMConfig = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  baseUrl: 'https://api.deepseek.com',
  temperature: 0.3,
  maxTokens: 1024,
};

const DEFAULT_OPENAI_CONFIG: LLMConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  baseUrl: 'https://api.openai.com/v1',
  temperature: 0.3,
  maxTokens: 1024,
};

/**
 * Get LLM config from database settings.
 *
 * 配置来源优先级（从高到低）：
 *  1. agent_settings.key = 'llm'  (用户单独保存的 LLM 配置，含 apiKey/baseUrl/temperature/maxTokens 等)
 *  2. agent_settings.key = 'global' (全局设置，仅含 model/provider 两个字段，会与默认 DeepSeek 配置合并)
 *  3. DEFAULT_DEEPSEEK_CONFIG (兜底默认)
 */
export async function getLLMConfig(): Promise<LLMConfig> {
  // 1) 用户显式保存的 LLM 配置（含 apiKey/baseUrl 等完整字段）
  const llmRow = await queryOne<{ value: LLMConfig }>(
    `SELECT value FROM agent_settings WHERE key = 'llm'`
  );
  
  if (llmRow?.value && (llmRow.value as LLMConfig).model) {
    return llmRow.value;
  }
  
  // 2) 从全局设置里拿 model/provider，与默认 DeepSeek 配置合并
  const globalRow = await queryOne<{ value: { model?: string; provider?: string } }>(
    `SELECT value FROM agent_settings WHERE key = 'global'`
  );
  
  if (globalRow?.value) {
    const provider = (globalRow.value.provider as LLMConfig['provider']) || 'deepseek';
    return {
      ...DEFAULT_DEEPSEEK_CONFIG,
      model: globalRow.value.model || DEFAULT_DEEPSEEK_CONFIG.model,
      provider,
      baseUrl: provider === 'openai' ? DEFAULT_OPENAI_CONFIG.baseUrl : DEFAULT_DEEPSEEK_CONFIG.baseUrl,
    };
  }
  
  // 3) 兜底默认
  return DEFAULT_DEEPSEEK_CONFIG;
}

/**
 * Update LLM config
 */
export async function setLLMConfig(config: Partial<LLMConfig>): Promise<void> {
  const current = await getLLMConfig();
  const merged = { ...current, ...config };

  await query(
    `INSERT INTO agent_settings (key, value) VALUES ('llm', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [merged]
  );
}

/**
 * 给 API 响应用的 LLM 配置。**剥掉 apiKey**。Fix #4。
 *
 * 旧实现：getLLMConfig() 全文返回 → /api/agent/settings GET 把 key 塞进
 * HTTP 响应 → 浏览器 F12 拿到直接花余额。
 * 新实现：hasApiKey=true 表示「已经配过了，但具体值不告诉你」。
 * 设置时（PUT）必须从请求体里拿 apiKey，因为客户端本来就只看到 hasApiKey。
 */
export async function getPublicLLMConfig(): Promise<PublicLLMConfig> {
  const full = await getLLMConfig();
  const envKey = process.env.LLM_API_KEY;
  const hasApiKey = !!(
    (typeof full.apiKey === 'string' && full.apiKey.length > 0) ||
    (typeof envKey === 'string' && envKey.length > 0)
  );
  const { apiKey: _omit, ...rest } = full;
  return { ...rest, hasApiKey };
}

/**
 * Call LLM with messages
 */
export async function callLLM(
  messages: LLMMessage[],
  config?: Partial<LLMConfig>
): Promise<LLMResponse> {
  const mergedConfig = config
    ? { ...await getLLMConfig(), ...config }
    : await getLLMConfig();
  
  const apiKey = mergedConfig.apiKey || process.env.LLM_API_KEY;
  
  if (!apiKey) {
    throw new Error('LLM_API_KEY environment variable not set');
  }
  
  const startTime = Date.now();
  
  try {
    const response = mergedConfig.provider === 'deepseek'
      ? await callDeepSeek(messages, mergedConfig, apiKey)
      : mergedConfig.provider === 'openai'
        ? await callOpenAI(messages, mergedConfig, apiKey)
        : (() => { throw new Error(`Unsupported LLM provider: ${mergedConfig.provider}`); })();
    
    const latencyMs = Date.now() - startTime;
    if (latencyMs > 3000) {
      console.warn(`[LLM] Slow response: ${latencyMs}ms (${mergedConfig.provider}/${mergedConfig.model})`);
    }
    return response;
  } catch (error) {
    const llmError: LLMError = {
      message: error instanceof Error ? error.message : 'Unknown LLM error',
      code: (error as { code?: string }).code,
      status: (error as { status?: number }).status,
    };
    throw llmError;
  }
}

async function callDeepSeek(
  messages: LLMMessage[],
  config: LLMConfig,
  apiKey: string
): Promise<LLMResponse> {
  const baseUrl = config.baseUrl || 'https://api.deepseek.com';
  
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      temperature: config.temperature ?? 0.3,
      max_tokens: config.maxTokens ?? 1024,
    }),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(`DeepSeek API error: ${response.status} ${errorText}`) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  
  const data = await response.json() as {
    choices: Array<{
      message: { content: string };
      finish_reason: string;
    }>;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
    model: string;
  };
  
  const choice = data.choices[0];
  
  return {
    content: choice.message.content,
    usage: {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens,
    },
    model: data.model,
    finishReason: choice.finish_reason,
  };
}

async function callOpenAI(
  messages: LLMMessage[],
  config: LLMConfig,
  apiKey: string
): Promise<LLMResponse> {
  const baseUrl = config.baseUrl || 'https://api.openai.com/v1';
  
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      temperature: config.temperature ?? 0.3,
      max_tokens: config.maxTokens ?? 1024,
    }),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(`OpenAI API error: ${response.status} ${errorText}`) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  
  const data = await response.json() as {
    choices: Array<{
      message: { content: string };
      finish_reason: string;
    }>;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
    model: string;
  };
  
  const choice = data.choices[0];
  
  return {
    content: choice.message.content,
    usage: {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens,
    },
    model: data.model,
    finishReason: choice.finish_reason,
  };
}

/**
 * Get available LLM providers/models
 */
export async function getAvailableModels(): Promise<Record<string, { provider: string; models: string[] }[]>> {
  return {
    deepseek: [
      {
        provider: 'deepseek',
        models: ['deepseek-chat', 'deepseek-coder'],
      },
    ],
    openai: [
      {
        provider: 'openai',
        models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
      },
    ],
  };
}
