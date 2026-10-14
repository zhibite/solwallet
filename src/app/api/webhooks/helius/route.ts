/**
 * /api/webhooks/helius
 * POST - 接收 Helius Enhanced Webhook 推送
 *
 * 安全修复（CRITICAL）：
 *   - 验证 helius-signature 头（HMAC-SHA256），不验证的请求返回 401
 *   - .env 需配置 HELIUS_WEBHOOK_SECRET
 */
import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { handleWebhookEvent } from '@/lib/monitor';

/**
 * 验证 Helius webhook 签名
 *
 * Helius webhook 签名格式：schema=1&type=0&data=<sha256_hex>
 * data 字段是对整个请求 body 的 SHA-256 摘要（hex）。
 * 验证时拼接 "schema=1&type=0&data=" + body_sha256，然后用 HELIUS_WEBHOOK_SECRET 做 HMAC-SHA256，
 * 结果与 header 值做恒时比较。
 *
 * ref: https://docs.helius.xyz/webhooks/webhook-security
 */
async function verifyHeliusSignature(
  req: NextRequest,
  body: string,
): Promise<boolean> {
  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  if (!secret) {
    // 没配置 secret 时拒绝所有请求（fail-closed）
    console.error('[webhook] HELIUS_WEBHOOK_SECRET 未配置，拒绝所有请求');
    return false;
  }

  const sigHeader = req.headers.get('helius-signature');
  if (!sigHeader) {
    console.warn('[webhook] 缺少 helius-signature 头');
    return false;
  }

  // 1) 计算 body 的 SHA-256
  const { createHash } = await import('crypto');
  const bodySha256 = createHash('sha256').update(body, 'utf8').digest('hex');

  // 2) 构造 Helius 签名原文
  const message = `schema=1&type=0&data=${bodySha256}`;

  // 3) HMAC-SHA256
  const expected = createHmac('sha256', secret).update(message).digest('hex');

  // 4) 恒时比较
  return timingSafeEqual(sigHeader, expected);
}

/** 恒时字符串比较，防止 timing attack */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function POST(req: NextRequest) {
  try {
    // 先把 body 读成字符串用于验签
    const body = await req.text();

    const valid = await verifyHeliusSignature(req, body);
    if (!valid) {
      return NextResponse.json({ ok: false, error: 'signature verification failed' }, { status: 401 });
    }

    // 验签通过后再 parse JSON
    const events = JSON.parse(body);
    const list = Array.isArray(events) ? events : [events];

    // 不 await，让响应尽快返回
    handleWebhookEvent(list).catch((err) => console.error('[webhook] handler error', err));
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    // JSON parse 失败
    return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
  }
}
