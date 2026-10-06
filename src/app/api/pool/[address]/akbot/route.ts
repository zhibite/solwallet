/**
 * /api/pool/[address]/akbot
 *
 * 手动标注 / 撤销 akbot —— 给池子页面的「标 AkBot / 撤销」按钮用。
 *
 *  - POST   → 手动标为 akbot。会让 monitor 实时检测也认这一笔。
 *             evidence sig 必填（哪怕是手动标，证据字段也要写一个能定位的回链），
 *             否则历史里看不出「为什么这一行是 akbot」。
 *             注意：自动检测的 evidence sig 是真实 tx 签名，手动标注的则用
 *             `manual:<tagger>:<iso8601>` 这种约定串，避免和真签名冲突。
 *  - DELETE → 撤销 akbot 标记。清空三个证据字段。
 *             monitor 之后如果再发现该地址使用 akbot program，会重新写回 TRUE。
 */
import { NextRequest, NextResponse } from 'next/server';
import { markAsAkbot, unmarkAsAkbot, getPoolMember } from '@/lib/pool';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  try {
    const { address } = await params;
    if (!address || address.length < 32 || address.length > 44) {
      return NextResponse.json({ ok: false, error: 'address 非法' }, { status: 400 });
    }
    const body = await req.json().catch(() => ({} as any));
    const tagger: string =
      typeof body?.tagger === 'string' && body.tagger.trim()
        ? body.tagger.trim().slice(0, 64)
        : 'ui';
    const note: string | null =
      typeof body?.note === 'string' && body.note.trim()
        ? body.note.trim().slice(0, 256)
        : null;

    // 手动标注也写到 akbot_evidence_sig 里，约定前缀 `manual:` 以便和真实 sig 区分。
    // 真实 sig 形如 5ZRqdvTtqQ3sRKBv...，manual sig 形如 manual:ui:2026-10-06T17:00:00Z
    const evidenceSig = `manual:${tagger}:${new Date().toISOString()}${note ? `:${note}` : ''}`;

    // 先确认地址在池子里（不在的话 INSERT 兜底写入一条 follower 行）
    const existed = await getPoolMember(address);
    if (!existed) {
      // 池外地址用 INSERT 拉进来 —— 与 markAsAkbot 内部行为一致（它本身就是 ON CONFLICT）
      // 但 getPoolMember 已查过 = 不存在，所以一定能走到 INSERT 分支。
    }
    const flipped = await markAsAkbot(address, evidenceSig, Math.floor(Date.now() / 1000), null);
    return NextResponse.json({
      ok: true,
      data: { address, flipped, evidence: evidenceSig, wasNew: !existed },
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  try {
    const { address } = await params;
    if (!address || address.length < 32 || address.length > 44) {
      return NextResponse.json({ ok: false, error: 'address 非法' }, { status: 400 });
    }
    const r = await unmarkAsAkbot(address);
    return NextResponse.json({ ok: true, data: { address, ...r } });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
