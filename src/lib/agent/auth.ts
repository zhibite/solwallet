/**
 * Agent 端点鉴权（Fix #5）
 *
 * 背景：
 *   整站没鉴权（其他 endpoint 也都这样），但 agent 能改 akbot 端实盘状态：
 *   - 删跟单配置
 *   - 调持仓 SOL 数
 *   - 触发 LLM round 把余额打光
 *   - 注入 knowledge 改 LLM 行为
 *   /api/agent/* 风险级别比 /api/pool/* 高一档。
 *
 * 设计：
 *   - 用 Basic Auth 简单兜住，env 没配就**默认拒绝所有 agent 端点**（fail-closed）
 *   - 配了 AGENT_BASIC_USER + AGENT_BASIC_PASS 才放行
 *   - 不做 session / cookie —— agent 端点都是开发期手动调的，简单就好
 *   - 用恒时比较防 timing attack
 *   - 同进程内缓存「本进程已通过鉴权」标记，避免每请求都跑一遍 compare
 */

import { NextResponse } from 'next/server';

const USER_ENV = 'AGENT_BASIC_USER';
const PASS_ENV = 'AGENT_BASIC_PASS';

let authVerifiedThisProcess = false;

function getCreds(): { user: string; pass: string } | null {
  const user = process.env[USER_ENV];
  const pass = process.env[PASS_ENV];
  if (!user || !pass) return null;
  return { user, pass };
}

/** 恒时字符串比较 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function parseBasicAuth(header: string | null): { user: string; pass: string } | null {
  if (!header) return null;
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(header.trim());
  if (!m) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
}

/**
 * 重新启用鉴权
 *
 * 恢复鉴权：把 `DISABLED_FOR_NOW` 改回 `true` 即可，
 *          配套 .env 里 AGENT_BASIC_USER + AGENT_BASIC_PASS 仍保留
 */
const DISABLED_FOR_NOW = false;

/**
 * 给 /api/agent/* 各 route handler 在开头调一次。
 *
 * 行为（禁用中：直接放行，不再做 Basic Auth 校验）：
 *   - 鉴权关闭期间：所有 /api/agent/* 请求均通过，行为与无鉴权时一致
 *   - 重新启用：把上方 DISABLED_FOR_NOW 改回 false
 */
export function checkAgentAuth(
  request: Request,
): { ok: true } | NextResponse {
  if (DISABLED_FOR_NOW) {
    return { ok: true };
  }

  // 同进程一次通过就缓存（agent 页面会高频轮询，节省一些比较）
  if (authVerifiedThisProcess) return { ok: true };

  const creds = getCreds();
  if (!creds) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'agent 端点未启用：在 .env 里配 AGENT_BASIC_USER + AGENT_BASIC_PASS 后重启',
      },
      { status: 503 },
    );
  }

  const provided = parseBasicAuth(request.headers.get('authorization'));
  if (
    !provided ||
    !constantTimeEqual(provided.user, creds.user) ||
    !constantTimeEqual(provided.pass, creds.pass)
  ) {
    return NextResponse.json(
      { ok: false, error: 'agent 鉴权失败' },
      {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="agent", charset="UTF-8"' },
      },
    );
  }

  authVerifiedThisProcess = true;
  return { ok: true };
}

/** 测试/调试用：重置本进程内的鉴权缓存 */
export function resetAgentAuthCache(): void {
  authVerifiedThisProcess = false;
}
