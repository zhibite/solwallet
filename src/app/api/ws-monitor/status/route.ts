/**
 * WebSocket 监控状态 API
 * GET /api/ws-monitor/status
 */

import { NextResponse } from 'next/server';
import { getWsMonitorStatus } from '@/lib/ws-monitor';

export async function GET() {
  try {
    const status = getWsMonitorStatus();
    return NextResponse.json({
      success: true,
      data: status,
    });
  } catch (err) {
    console.error('[api/ws-monitor/status]', err);
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 },
    );
  }
}
