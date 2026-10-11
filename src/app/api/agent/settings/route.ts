import { NextRequest, NextResponse } from 'next/server';
import { checkAgentAuth } from '@/lib/agent/auth';
import {
  getGlobalSettings,
  updateGlobalSettings,
  getPublicLLMConfig,
  setLLMConfig,
} from '@/lib/agent';

export async function GET(request: NextRequest) {
  const auth = checkAgentAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const globalSettings = await getGlobalSettings();
    // Fix #4: 用 getPublicLLMConfig 替代 getLLMConfig，剥掉 apiKey
    const llmConfig = await getPublicLLMConfig();

    return NextResponse.json({
      ok: true,
      data: {
        global: globalSettings,
        llm: llmConfig,
      },
    });
  } catch (error) {
    console.error('GET /api/agent/settings error:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  const auth = checkAgentAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const body = await request.json();

    // Update global settings if provided
    if (body.global) {
      await updateGlobalSettings({
        shadow_mode: body.global.shadow_mode,
        interval_minutes: body.global.interval_minutes,
        model: body.global.model,
        provider: body.global.provider,
      });
    }

    // Update LLM config if provided
    if (body.llm) {
      await setLLMConfig({
        provider: body.llm.provider,
        model: body.llm.model,
        apiKey: body.llm.apiKey,
        baseUrl: body.llm.baseUrl,
        temperature: body.llm.temperature,
        maxTokens: body.llm.maxTokens,
      });
    }

    const globalSettings = await getGlobalSettings();
    const llmConfig = await getPublicLLMConfig();

    return NextResponse.json({
      ok: true,
      data: {
        global: globalSettings,
        llm: llmConfig,
      },
    });
  } catch (error) {
    console.error('PUT /api/agent/settings error:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
