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

/**
 * 把任意字符串 hex 编码，用于安全嵌入带分隔符的字符串。
 * 防止 note 里的 `:` 或其他特殊字符干扰 evidenceSig 的格式约定。
 */
function hexEncode(raw: string): string {
  const buf = Buffer.from(raw, 'utf8');
  return buf.toString('hex');
}

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

    // 安全修复（HIGH #7）：note 字段 hex 编码后嵌入签名串，避免内容注入污染格式
    const rawNote: string | null =
      typeof body?.note === 'string' && body.note.trim()
        ? body.note.trim().slice(0, 256)
        : null;
    const encodedNote = rawNote ? hexEncode(rawNote) : null;

    // evidenceSig 格式：manual:<tagger>:<iso8601>[:<hex_note>]
    // hex 编码后不含 : 和空格，不会破坏格式解析
    const evidenceSig = `manual:${tagger}:${new Date().toISOString()}${encodedNote ? `:${encodedNote}` : ''}`;

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
