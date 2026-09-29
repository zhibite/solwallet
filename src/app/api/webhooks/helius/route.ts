/**
 * /api/webhooks/helius
 * POST - 接收 Helius Enhanced Webhook 推送
 */
import { NextRequest, NextResponse } from 'next/server';
import { handleWebhookEvent } from '@/lib/monitor';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const events = Array.isArray(body) ? body : [body];
    // 不 await，让响应尽快返回
    handleWebhookEvent(events).catch((err) => console.error('[webhook] handler error', err));
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
  }
}
