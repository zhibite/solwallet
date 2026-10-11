import { NextRequest, NextResponse } from 'next/server';
import { checkAgentAuth } from '@/lib/agent/auth';
import {
  startScheduler,
  stopScheduler,
  updateSchedulerSettings,
  triggerImmediateRound,
  getSchedulerState,
  getSchedulerHealth,
} from '@/lib/agent';

export async function GET(request: NextRequest) {
  const auth = checkAgentAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const state = await getSchedulerState();
    const health = await getSchedulerHealth();

    return NextResponse.json({
      ok: true,
      data: {
        state,
        health,
      },
    });
  } catch (error) {
    console.error('GET /api/agent/scheduler error:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = checkAgentAuth(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const body = await request.json();
    const action = body.action;

    let result;

    switch (action) {
      case 'start':
        result = await startScheduler();
        break;

      case 'stop':
        result = await stopScheduler();
        break;

      case 'update':
        result = await updateSchedulerSettings({
          interval_minutes: body.interval_minutes,
          shadow_mode: body.shadow_mode,
        });
        break;

      case 'trigger':
        const roundResult = await triggerImmediateRound();
        return NextResponse.json({
          ok: true,
          data: {
            action: 'trigger',
            round: roundResult,
          },
        });

      default:
        return NextResponse.json(
          { ok: false, error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }

    return NextResponse.json({
      ok: true,
      data: {
        action,
        state: result,
      },
    });
  } catch (error) {
    console.error('POST /api/agent/scheduler error:', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
