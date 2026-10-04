"use client";
import React, { useEffect, useState } from "react";
import Link from "next/link";
import AddressCopy from "@/components/common/AddressCopy";
import SolAmount from "@/components/common/SolAmount";
import PrioSolAmount from "@/components/common/PrioSolAmount";
import { useConfirm } from "@/components/ui/confirm-dialog";

interface PoolMember {
  id: number;
  address: string;
  label: string | null;
  role: string;
  freq: number;
  seen_as_first_sniper: number;
  seen_as_follower: number;
  distinct_targets: number;
  avg_buy_sol: number;
  avg_offset_pos: number;
  first_seen_at: string;
  last_seen_at: string;
  worth_score: number | null;
  recommended_tip_sol: number | null;
  recommended_prio_lamports: number | null;
  promoted_to_target: boolean;
  promoted_at: string | null;
  is_akbot: boolean;
  akbot_detected_at: string | null;
  akbot_evidence_sig: string | null;
  akbot_evidence_slot: number | null;
}

interface Stats {
  totalMembers: number;
  promoted: number;
  firstSnipers: number;
  followers: number;
  totalEdges: number;
  akbotCount: number;
  bfsLastRun: string | null;
}

const PAGE_SIZE = 30;

export default function PoolPage() {
  const [members, setMembers] = useState<PoolMember[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState<'freq' | 'score' | 'seen'>('freq');
  const [roleFilter, setRoleFilter] = useState<'all' | 'first_sniper' | 'follower'>('all');
  const [akbotFilter, setAkbotFilter] = useState<'all' | 'akbot' | 'normal'>('all');
  const [bfsBusy, setBfsBusy] = useState(false);
  const { confirm, alert } = useConfirm();

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        sort: sortBy,
        limit: String(PAGE_SIZE),
        offset: String((page - 1) * PAGE_SIZE),
      });
      if (roleFilter !== 'all') params.set('role', roleFilter);
      if (akbotFilter === 'akbot') params.set('akbot', 'true');
      if (akbotFilter === 'normal') params.set('akbot', 'false');
      const res = await fetch(`/api/pool?${params}`);
      const json = await res.json();
      if (json.ok) {
        setMembers(json.data.members);
        setTotal(json.data.total ?? 0);
        setStats(json.data.stats);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [sortBy, roleFilter, akbotFilter, page]);

  // filter / sort 变化时回到第 1 页
  useEffect(() => { setPage(1); }, [sortBy, roleFilter, akbotFilter]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // 翻页后滚到表格顶部（避免翻页后用户还在表格底部）
  useEffect(() => {
    if (!loading) {
      const el = document.getElementById('pool-table-top');
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [page, loading]);

  const triggerBFS = async () => {
    setBfsBusy(true);
    try {
      const res = await fetch('/api/pool/discover', { method: 'POST' });
      const json = await res.json();
      if (json.ok) {
        await alert({
          title: 'BFS 完成',
          description: `扫描 ${json.data.bfs.result?.scannedTargets ?? 0} 个 target，晋升 ${json.data.bfs.result?.totalPromoted ?? 0} 个`,
          variant: 'success',
        });
        await load();
      } else {
        await alert({ title: 'BFS 失败', description: json.error, variant: 'danger' });
      }
    } finally {
      setBfsBusy(false);
    }
  };

  const promote = async (address: string) => {
    const ok = await confirm({
      title: '晋升到监控列表？',
      description: (
        <>
          将 <span className="font-mono">{address.slice(0, 6)}…{address.slice(-4)}</span>{' '}
          晋升为监控目标，之后会开始按阈值记录它的 buy 交易。
        </>
      ),
      confirmText: '晋升',
      variant: 'info',
    });
    if (!ok) return;
    const res = await fetch(`/api/pool/${address}/promote`, { method: 'POST' });
    const json = await res.json();
    if (json.ok) {
      await alert({ title: '已晋升', description: `${address.slice(0, 6)}…${address.slice(-4)} 已加入监控列表`, variant: 'success' });
      await load();
    } else {
      await alert({ title: '晋升失败', description: json.reason ?? json.error, variant: 'danger' });
    }
  };

  const scoreBadge = (s: number | null) => {
    if (s === null) return <span className="text-xs text-gray-400">-</span>;
    const color = s > 1 ? 'text-success-500' : s < -0.5 ? 'text-error-500' : 'text-warning-500';
    return <span className={`text-xs font-mono ${color}`}>{s.toFixed(2)}</span>;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-800 dark:text-white/90">跟单池子</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            从监控目标出发，自动归池：发现 first_sniper 与 follower，扩展更多候选 / 竞争者
          </p>
        </div>
        <button
          onClick={triggerBFS}
          disabled={bfsBusy}
          className="h-9 px-4 rounded-xl bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-sm font-medium"
        >
          {bfsBusy ? '扫描中...' : '立即扫描 BFS'}
        </button>
      </div>

      {/* 顶部统计 */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <StatCard label="池子成员" value={stats?.totalMembers ?? '-'} />
        <StatCard label="已晋升" value={stats?.promoted ?? '-'} />
        <StatCard label="first_sniper" value={stats?.firstSnipers ?? '-'} />
        <StatCard label="follower" value={stats?.followers ?? '-'} />
        <StatCard label="关系边" value={stats?.totalEdges ?? '-'} />
        <StatCard label="AkBot 用户" value={stats?.akbotCount ?? '-'} highlight={!!(stats?.akbotCount)} />
      </div>

      {/* 排序 + 过滤 */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 text-xs">
          <span className="text-gray-500 dark:text-gray-400">角色</span>
          {(['all', 'first_sniper', 'follower'] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRoleFilter(r)}
              className={`px-3 py-1 rounded-xl ${
                roleFilter === r
                  ? 'bg-brand-500 text-white'
                  : 'bg-slate-100 dark:bg-zinc-700 text-gray-500 dark:text-gray-400 hover:bg-slate-200'
              }`}
            >
              {r === 'all' ? '全部' : r}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 text-xs">
          <span className="text-gray-500 dark:text-gray-400">AkBot</span>
          {(['all', 'akbot', 'normal'] as const).map((a) => (
            <button
              key={a}
              onClick={() => setAkbotFilter(a)}
              className={`px-3 py-1 rounded-xl ${
                akbotFilter === a
                  ? a === 'akbot' ? 'bg-orange-500 text-white' : 'bg-brand-500 text-white'
                  : 'bg-slate-100 dark:bg-zinc-700 text-gray-500 dark:text-gray-400 hover:bg-slate-200'
              }`}
            >
              {a === 'all' ? '全部' : a === 'akbot' ? 'AkBot' : '非 AkBot'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 text-xs">
          <span className="text-gray-500 dark:text-gray-400">排序</span>
          {(['freq', 'score', 'seen'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSortBy(s)}
              className={`px-3 py-1 rounded-xl ${
                sortBy === s
                  ? 'bg-brand-500 text-white'
                  : 'bg-slate-100 dark:bg-zinc-700 text-gray-500 dark:text-gray-400 hover:bg-slate-200'
              }`}
            >
              {s === 'freq' ? '出现次数' : s === 'score' ? '评分' : '最近出现'}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-400">
          共 {total} 条，第 {page} / {totalPages} 页
        </span>
      </div>

      <div id="pool-table-top" />

      {/* 列表 */}
      <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-zinc-800/50 text-xs text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 text-center font-medium">#</th>
                <th className="px-3 py-2 text-left font-medium">地址</th>
                <th className="px-3 py-2 text-center font-medium">角色</th>
                <th className="px-3 py-2 text-center font-medium">出现次数</th>
                <th className="px-3 py-2 text-center font-medium">跟随目标</th>
                <th className="px-3 py-2 text-center font-medium">首狙 / 跟随</th>
                <th className="px-3 py-2 text-right font-medium">均买入 SOL</th>
                <th className="px-3 py-2 text-right font-medium">评分</th>
                <th className="px-3 py-2 text-right font-medium">推荐 TIP</th>
                <th className="px-3 py-2 text-right font-medium">推荐 PRIO</th>
                <th className="px-3 py-2 text-left font-medium">最近出现</th>
                <th className="px-3 py-2 text-center font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={12} className="px-3 py-6 text-center text-gray-500">加载中...</td></tr>
              ) : members.length === 0 ? (
                <tr><td colSpan={12} className="px-3 py-6 text-center text-gray-500">池子为空 — 等待监控目标产生 buy 后自动归池</td></tr>
              ) : (
                members.map((m, idx) => (
                  <tr key={m.id} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-zinc-700/30">
                    <td className="px-3 py-2 text-center font-mono text-xs text-gray-500 dark:text-gray-400">{(page - 1) * PAGE_SIZE + idx + 1}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <Link href={`/pool/${m.address}`} className="hover:text-brand-500">
                          <AddressCopy address={m.address} />
                        </Link>
                        {m.is_akbot && (
                          <span
                            className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-50 text-orange-700 dark:bg-orange-500/15 dark:text-orange-400 border border-orange-200/70 dark:border-orange-500/30"
                            title={`AKBot 用户，证据 sig: ${m.akbot_evidence_sig ?? ''}`}
                          >
                            AkBot
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${
                        m.role === 'first_sniper' ? 'bg-purple-50 text-purple-700 dark:bg-purple-500/10 dark:text-purple-400' :
                        m.role === 'follower' ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400' :
                        'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
                      }`}>
                        {m.role}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center font-mono text-gray-900 dark:text-white">{m.freq}</td>
                    <td className="px-3 py-2 text-center font-mono text-gray-900 dark:text-white">{m.distinct_targets}</td>
                    <td className="px-3 py-2 text-center text-xs text-gray-500">
                      {m.seen_as_first_sniper} / {m.seen_as_follower}
                    </td>
                    <td className="px-3 py-2 text-right"><SolAmount value={m.avg_buy_sol} /></td>
                    <td className="px-3 py-2 text-right">{scoreBadge(m.worth_score)}</td>
                    <td className="px-3 py-2 text-right">
                      {m.recommended_tip_sol ? <SolAmount value={m.recommended_tip_sol} /> : <span className="text-gray-400">-</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {m.recommended_prio_lamports ? <PrioSolAmount value={m.recommended_prio_lamports} /> : <span className="text-gray-400">-</span>}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500">
                      {new Date(m.last_seen_at).toLocaleString('zh-CN', { hour12: false }).slice(5)}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {m.promoted_to_target ? (
                        <span className="text-xs text-success-500">已监控</span>
                      ) : (
                        <button
                          onClick={() => promote(m.address)}
                          className="text-xs text-brand-500 hover:underline"
                        >
                          晋升
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* 分页 */}
        {totalPages > 1 && (
          <Pagination
            page={page}
            totalPages={totalPages}
            onChange={setPage}
          />
        )}
      </div>
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (p: number) => void;
}) {
  // 简化页码条：当前页前后各 2 页 + 首尾
  const visible = new Set<number>([1, totalPages, page - 2, page - 1, page, page + 1, page + 2]);
  const list = [...visible].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  const pages: (number | '…')[] = [];
  for (let i = 0; i < list.length; i++) {
    if (i > 0 && list[i] - list[i - 1] > 1) pages.push('…');
    pages.push(list[i]);
  }

  const btnBase =
    'h-8 min-w-[2rem] px-2 inline-flex items-center justify-center rounded-lg text-xs font-medium border transition-colors';
  const btnIdle =
    'bg-white dark:bg-zinc-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-zinc-700';
  const btnActive =
    'bg-brand-500 text-white border-brand-500';
  const btnDisabled =
    'bg-white dark:bg-zinc-800 text-gray-300 dark:text-gray-600 border-gray-200 dark:border-gray-700 cursor-not-allowed';

  return (
    <div className="flex items-center justify-between px-3 py-3 border-t border-gray-200 dark:border-gray-700 text-sm">
      <button
        onClick={() => onChange(Math.max(1, page - 1))}
        disabled={page <= 1}
        className={`${btnBase} ${page <= 1 ? btnDisabled : btnIdle}`}
      >
        ← 上一页
      </button>

      <div className="flex items-center gap-1">
        {pages.map((p, i) =>
          p === '…' ? (
            <span key={`e${i}`} className="px-1 text-gray-400 text-xs">…</span>
          ) : (
            <button
              key={p}
              onClick={() => onChange(p)}
              className={`${btnBase} ${p === page ? btnActive : btnIdle}`}
            >
              {p}
            </button>
          ),
        )}
      </div>

      <button
        onClick={() => onChange(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
        className={`${btnBase} ${page >= totalPages ? btnDisabled : btnIdle}`}
      >
        下一页 →
      </button>
    </div>
  );
}

function StatCard({ label, value, highlight }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`shadow-sm rounded-lg border p-4 ${
      highlight
        ? 'bg-orange-50 dark:bg-orange-500/10 border-orange-200 dark:border-orange-500/30'
        : 'bg-white dark:bg-zinc-800 border-gray-200 dark:border-gray-700'
    }`}>
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${
        highlight ? 'text-orange-600 dark:text-orange-400' : 'text-gray-800 dark:text-white/90'
      }`}>{value}</div>
    </div>
  );
}