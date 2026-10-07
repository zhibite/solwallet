"use client";
import React, { useEffect, useState } from "react";
import Link from "next/link";
import AddressCopy from "@/components/common/AddressCopy";
import SolAmount from "@/components/common/SolAmount";
import PrioSolAmount from "@/components/common/PrioSolAmount";
import RelativeTime from "@/components/common/RelativeTime";
import { useConfirm } from "@/components/ui/confirm-dialog";

interface Row {
  address: string;
  snipe_count: number;
  mint_count: number;
  win_count: number;
  win_rate: string | null;
  total_buy: string;
  total_tip: string;
  total_prio: string;
  avg_offset: string | null;
  total_pnl: string | null;
  avg_pnl: string | null;
  last_active: string;
  // 池子 AkBot 标注——LEFT JOIN pool_members，sniper-only 地址为 (false, null, null, null)
  is_akbot: boolean;
  akbot_detected_at: string | null;
  akbot_evidence_sig: string | null;
  akbot_evidence_slot: number | null;
  // 真实监控状态（monitored_targets.status='active'）。与 pool_members.promoted_to_target
  // 不同：手动加过监控的 sniper 不一定走过 pool promote 流程。
  is_monitored: boolean;
}

const SORTS = [
  { id: 'count',      label: '狙击次数' },
  { id: 'pnl',        label: '总收益' },
  { id: 'win_rate',   label: '胜率' },
  { id: 'avg_offset', label: '平均偏移（越早越好）' },
] as const;
type SortId = typeof SORTS[number]['id'];

const PAGE_SIZE = 30;

export default function SniperRankingPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);
  const [sort, setSort] = useState<SortId>('count');
  const [page, setPage] = useState(1);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const load = async () => {
    setLoading(true);
    try {
      const from = new Date(Date.now() - 86400_000 * days).toISOString();
      const offset = (page - 1) * PAGE_SIZE;
      const res = await fetch(
        `/api/sniper-ranking?from=${from}&limit=${PAGE_SIZE}&offset=${offset}&sort=${sort}`,
      );
      const json = await res.json();
      if (json.ok) {
        setRows(json.data);
        setTotal(json.total ?? 0);
      }
    } finally {
      setLoading(false);
    }
  };

  const { confirm, alert } = useConfirm();

  useEffect(() => { load(); }, [days, sort, page]);

  // 切换 days/sort 后回到第 1 页
  const handleDaysChange = (v: number) => { setDays(v); setPage(1); };
  const handleSortChange = (v: SortId) => { setSort(v); setPage(1); };

  // 当 total 缩小，避免 page 超出范围
  useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [totalPages, page]);

  const start = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const end = Math.min(page * PAGE_SIZE, total);

  // ====== 监控 + AkBot 操作 ======
  // 与 pool page 的 promote / tag / untag 走同一套接口，行为完全一致。
  // sniper 地址可能根本不在 pool_members（只抢不跟单），promotePoolMember
  // 会拒绝 ('pool member not found')，所以先 addPoolMember 兜底——INSERT
  // ON CONFLICT DO UPDATE 的语义，重复调用无副作用。

  const ensurePoolMember = async (address: string) => {
    // 200/201 视为成功；4xx/5xx 抛错由调用方处理
    const res = await fetch('/api/pool', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address }),
    });
    const j = await res.json().catch(() => ({} as any));
    if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
  };

  const promote = async (r: Row) => {
    if (r.is_monitored) {
      await alert({
        title: '已是监控目标',
        description: (
          <>
            <span className="font-mono">{r.address.slice(0, 6)}…{r.address.slice(-4)}</span>{' '}
            已在监控列表中。
          </>
        ),
        variant: 'info',
      });
      return;
    }
    const ok = await confirm({
      title: '加入监控？',
      description: (
        <>
          将 <span className="font-mono">{r.address.slice(0, 6)}…{r.address.slice(-4)}</span>{' '}
          加入监控列表，默认阈值{' '}
          <span className="font-mono font-semibold">0.5 SOL</span>。
        </>
      ),
      confirmText: '加入监控',
      variant: 'info',
    });
    if (!ok) return;
    try {
      // 先确保在 pool_members（sniper-only 地址可能完全没归过池）
      await ensurePoolMember(r.address);
    } catch (e: any) {
      await alert({ title: '加入监控失败', description: `拉入池子失败: ${e.message ?? e}`, variant: 'danger' });
      return;
    }
    const res = await fetch(`/api/pool/${r.address}/promote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threshold: 0.5 }),
    });
    const json = await res.json().catch(() => ({} as any));
    if (json.ok) {
      await alert({
        title: '已加入监控',
        description: (
          <>
            <span className="font-mono">{r.address.slice(0, 6)}…{r.address.slice(-4)}</span>{' '}
            已加入监控列表（阈值 0.5 SOL）。
          </>
        ),
        variant: 'success',
      });
      await load();
      return;
    }
    // 并发场景：另一个 tab / 操作员抢先加了。pool page 同样路径，把
    // 'already a monitored target' 当作"成功"退化处理。
    if (json.reason === 'already a monitored target') {
      await alert({
        title: '已是监控目标',
        description: `${r.address.slice(0, 6)}…${r.address.slice(-4)} 已被加入监控（并发/其它会话）。`,
        variant: 'info',
      });
      await load();
      return;
    }
    await alert({ title: '加入监控失败', description: json.reason ?? json.error, variant: 'danger' });
  };

  const tagAkbot = async (r: Row) => {
    const ok = await confirm({
      title: '手动标为 AkBot？',
      description: (
        <>
          将 <span className="font-mono">{r.address.slice(0, 6)}…{r.address.slice(-4)}</span>{' '}
          标记为 AkBot 用户。
          <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            狙击次数 {r.snipe_count} · 胜率{' '}
            {r.win_rate ? `${(parseFloat(r.win_rate) * 100).toFixed(1)}%` : '-'}
          </div>
          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            标记后若该地址再使用 akbot program，monitor 会保持 akbot 标记。
          </div>
        </>
      ),
      confirmText: '标记为 AkBot',
      variant: 'warning',
    });
    if (!ok) return;
    const res = await fetch(`/api/pool/${r.address}/akbot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tagger: 'ui' }),
    });
    const json = await res.json().catch(() => ({} as any));
    if (json.ok) {
      await alert({
        title: '已标记',
        description: `${r.address.slice(0, 6)}…${r.address.slice(-4)} 已是 AkBot`,
        variant: 'success',
      });
      await load();
    } else {
      await alert({ title: '标记失败', description: json.error ?? `HTTP ${res.status}`, variant: 'danger' });
    }
  };

  const untagAkbot = async (r: Row) => {
    const ok = await confirm({
      title: '撤销 AkBot 标记？',
      description: (
        <>
          将 <span className="font-mono">{r.address.slice(0, 6)}…{r.address.slice(-4)}</span>{' '}
          撤掉 AkBot 标记。证据会被清空。
          <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            证据 sig: {r.akbot_evidence_sig ?? '?'}
          </div>
        </>
      ),
      confirmText: '撤销标记',
      variant: 'danger',
    });
    if (!ok) return;
    const res = await fetch(`/api/pool/${r.address}/akbot`, { method: 'DELETE' });
    const json = await res.json().catch(() => ({} as any));
    if (json.ok) {
      await alert({
        title: '已撤销 AkBot',
        description: `${r.address.slice(0, 6)}…${r.address.slice(-4)} 已撤销 AkBot 标记`,
        variant: 'success',
      });
      await load();
    } else {
      await alert({ title: '撤销失败', description: json.error ?? `HTTP ${res.status}`, variant: 'danger' });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-semibold text-gray-800 dark:text-white/90">狙击排行</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            在跟单抢单中第一个冲进去的地址（is_first_sniper），看谁最爱抢、谁最会抢
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 dark:text-gray-400">时间范围</span>
            <select
              value={days}
              onChange={(e) => handleDaysChange(parseInt(e.target.value, 10))}
              className="h-9 px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-700 text-sm text-gray-800 dark:text-white/90 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value={7}>最近 7 天</option>
              <option value={30}>最近 30 天</option>
              <option value={90}>最近 90 天</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 dark:text-gray-400">排序</span>
            <select
              value={sort}
              onChange={(e) => handleSortChange(e.target.value as SortId)}
              className="h-9 px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-700 text-sm text-gray-800 dark:text-white/90 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-zinc-700/50 text-xs text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 text-center">#</th>
                <th className="px-3 py-2 text-left">地址</th>
                <th className="px-3 py-2 text-right">狙击次数</th>
                <th className="px-3 py-2 text-right">mint 数</th>
                <th className="px-3 py-2 text-right">胜率</th>
                <th className="px-3 py-2 text-right">总买入 SOL</th>
                <th className="px-3 py-2 text-right">总 TIP</th>
                <th className="px-3 py-2 text-right">总优先费</th>
                <th className="px-3 py-2 text-right">平均偏移</th>
                <th className="px-3 py-2 text-right">总 PnL</th>
                <th className="px-3 py-2 text-right">平均 PnL</th>
                <th className="px-3 py-2 text-center">最后活跃</th>
                <th className="px-3 py-2 text-center">AkBot</th>
                <th className="px-3 py-2 text-center">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={14} className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">加载中...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={14} className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">暂无狙击数据。需要先有 block 级分析记录</td></tr>
              ) : (
                rows.map((r, idx) => {
                  const winRate = r.win_rate ? parseFloat(r.win_rate) : 0;
                  const avgOffset = r.avg_offset !== null ? parseFloat(r.avg_offset) : null;
                  const offsetColor = avgOffset === null
                    ? 'text-gray-500 dark:text-gray-400'
                    : avgOffset > 0
                      ? 'text-error-500'
                      : avgOffset < 0
                        ? 'text-success-600'
                        : 'text-gray-500 dark:text-gray-400';
                  return (
                    <tr key={r.address} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-zinc-700/30">
                      <td className="px-3 py-2 text-center font-mono text-xs text-gray-500 dark:text-gray-400">{(page - 1) * PAGE_SIZE + idx + 1}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <Link href={`/pool/${r.address}`} prefetch={false} className="hover:text-brand-500">
                            <AddressCopy address={r.address} length={6} />
                          </Link>
                          {r.is_akbot && (
                            <span
                              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-50 text-orange-700 dark:bg-orange-500/15 dark:text-orange-400 border border-orange-200/70 dark:border-orange-500/30"
                              title={`AKBot 用户，证据 sig: ${r.akbot_evidence_sig ?? ''}`}
                            >
                              AkBot
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-gray-800 dark:text-white/90">{r.snipe_count}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-600 dark:text-gray-300">{r.mint_count}</td>
                      <td className="px-3 py-2 text-center">
                        <span className={`font-mono text-xs ${winRate >= 0.5 ? 'text-success-500' : 'text-error-500'}`}>
                          {(winRate * 100).toFixed(1)}%
                        </span>
                        <span className="text-xs text-gray-400 dark:text-gray-500 ml-1">
                          ({r.win_count}/{r.snipe_count})
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right"><SolAmount value={r.total_buy} /></td>
                      <td className="px-3 py-2 text-right"><SolAmount value={r.total_tip} /></td>
                      <td className="px-3 py-2 text-right"><PrioSolAmount value={r.total_prio} /></td>
                      <td className={`px-3 py-2 text-right font-mono ${offsetColor}`}>
                        {avgOffset === null
                          ? '-'
                          : `${avgOffset > 0 ? '+' : ''}${avgOffset.toFixed(1)}`}
                      </td>
                      <td className="px-3 py-2 text-right"><SolAmount value={r.total_pnl} signed /></td>
                      <td className="px-3 py-2 text-right"><SolAmount value={r.avg_pnl} signed /></td>
                      <td className="px-3 py-2 text-center"><RelativeTime iso={r.last_active} /></td>
                      <td className="px-3 py-2 text-center">
                        {r.is_akbot ? (
                          <span
                            className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-50 text-orange-700 dark:bg-orange-500/15 dark:text-orange-400 border border-orange-200/70 dark:border-orange-500/30"
                            title={`证据 sig: ${r.akbot_evidence_sig ?? ''}`}
                          >
                            AkBot
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <div className="inline-flex flex-row items-center gap-2">
                          {r.is_monitored ? (
                            <span className="text-xs text-success-500 whitespace-nowrap">✓ 已监控</span>
                          ) : (
                            <button
                              onClick={() => promote(r)}
                              className="text-xs text-brand-500 hover:underline whitespace-nowrap"
                              title="加入监控列表，默认阈值 0.5 SOL（与池子页一致）"
                            >
                              监控
                            </button>
                          )}
                          {r.is_akbot ? (
                            <button
                              onClick={() => untagAkbot(r)}
                              className="text-[11px] text-gray-400 hover:text-error-500 hover:underline whitespace-nowrap"
                              title={`撤 AkBot（证据: ${r.akbot_evidence_sig ?? '?'}）`}
                            >
                              撤 AkBot
                            </button>
                          ) : (
                            <button
                              onClick={() => tagAkbot(r)}
                              className="text-[11px] text-orange-500 hover:text-orange-700 hover:underline whitespace-nowrap"
                              title="手动标为 AkBot 用户（不依赖扫描）"
                            >
                              AkBot
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* 分页 —— 底部居中：上方小字显示范围，水平方向用工具条布局 */}
        <div className="flex flex-col items-center gap-2 px-4 py-3 border-t border-gray-200 dark:border-gray-700 text-sm">
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {total === 0
              ? '共 0 条'
              : `第 ${start}–${end} 条 / 共 ${total} 条`}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              className="h-8 px-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/[0.03] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              上一页
            </button>
            <span className="text-xs text-gray-600 dark:text-gray-400 font-mono">
              {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
              className="h-8 px-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/[0.03] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              下一页
            </button>
            <div className="flex items-center gap-1 ml-2">
              <span className="text-xs text-gray-500 dark:text-gray-400">跳至</span>
              <input
                type="number"
                min={1}
                max={totalPages}
                value={page}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (Number.isFinite(v)) {
                    setPage(Math.min(totalPages, Math.max(1, v)));
                  }
                }}
                className="w-14 h-8 px-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-800 text-center text-gray-800 dark:text-white/90 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <span className="text-xs text-gray-500 dark:text-gray-400">页</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}