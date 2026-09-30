"use client";
import React, { useEffect, useState } from "react";
import Link from "next/link";
import AddressCopy from "@/components/common/AddressCopy";
import SolAmount from "@/components/common/SolAmount";

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
}

interface Stats {
  totalMembers: number;
  promoted: number;
  firstSnipers: number;
  followers: number;
  totalEdges: number;
  bfsLastRun: string | null;
}

export default function PoolPage() {
  const [members, setMembers] = useState<PoolMember[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState<'freq' | 'score' | 'seen'>('freq');
  const [roleFilter, setRoleFilter] = useState<'all' | 'first_sniper' | 'follower'>('all');
  const [bfsBusy, setBfsBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const role = roleFilter === 'all' ? undefined : roleFilter;
      const params = new URLSearchParams({ sort: sortBy });
      if (role) params.set('role', role);
      const res = await fetch(`/api/pool?${params}`);
      const json = await res.json();
      if (json.ok) {
        setMembers(json.data.members);
        setStats(json.data.stats);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [sortBy, roleFilter]);

  const triggerBFS = async () => {
    setBfsBusy(true);
    try {
      const res = await fetch('/api/pool/discover', { method: 'POST' });
      const json = await res.json();
      if (json.ok) {
        alert(`BFS 完成: 扫描 ${json.data.bfs.result?.scannedTargets ?? 0} 个 target, 晋升 ${json.data.bfs.result?.totalPromoted ?? 0} 个`);
        await load();
      } else {
        alert(`失败: ${json.error}`);
      }
    } finally {
      setBfsBusy(false);
    }
  };

  const promote = async (address: string) => {
    if (!confirm(`将 ${address.slice(0, 6)}... 晋升到监控列表？`)) return;
    const res = await fetch(`/api/pool/${address}/promote`, { method: 'POST' });
    const json = await res.json();
    if (json.ok) {
      alert('已晋升');
      await load();
    } else {
      alert(`失败: ${json.reason ?? json.error}`);
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
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="池子成员" value={stats?.totalMembers ?? '-'} />
        <StatCard label="已晋升" value={stats?.promoted ?? '-'} />
        <StatCard label="first_sniper" value={stats?.firstSnipers ?? '-'} />
        <StatCard label="follower" value={stats?.followers ?? '-'} />
        <StatCard label="关系边" value={stats?.totalEdges ?? '-'} />
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
        <span className="text-xs text-gray-400">共 {members.length} 条</span>
      </div>

      {/* 列表 */}
      <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-zinc-800/50 text-xs text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium">地址</th>
                <th className="px-3 py-2 text-center font-medium">角色</th>
                <th className="px-3 py-2 text-center font-medium">出现次数</th>
                <th className="px-3 py-2 text-center font-medium">跟随目标</th>
                <th className="px-3 py-2 text-center font-medium">FS / Fol</th>
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
                <tr><td colSpan={11} className="px-3 py-6 text-center text-gray-500">加载中...</td></tr>
              ) : members.length === 0 ? (
                <tr><td colSpan={11} className="px-3 py-6 text-center text-gray-500">池子为空 — 等待监控目标产生 buy 后自动归池</td></tr>
              ) : (
                members.map((m) => (
                  <tr key={m.id} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-zinc-700/30">
                    <td className="px-3 py-2">
                      <Link href={`/pool/${m.address}`} className="hover:text-brand-500">
                        <AddressCopy address={m.address} />
                      </Link>
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
                    <td className="px-3 py-2 text-center font-mono">{m.freq}</td>
                    <td className="px-3 py-2 text-center font-mono">{m.distinct_targets}</td>
                    <td className="px-3 py-2 text-center text-xs text-gray-500">
                      {m.seen_as_first_sniper} / {m.seen_as_follower}
                    </td>
                    <td className="px-3 py-2 text-right"><SolAmount value={m.avg_buy_sol} /></td>
                    <td className="px-3 py-2 text-right">{scoreBadge(m.worth_score)}</td>
                    <td className="px-3 py-2 text-right">
                      {m.recommended_tip_sol ? <SolAmount value={m.recommended_tip_sol} /> : <span className="text-gray-400">-</span>}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {m.recommended_prio_lamports ? m.recommended_prio_lamports.toLocaleString() : <span className="text-gray-400">-</span>}
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
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className="text-2xl font-semibold mt-1 text-gray-800 dark:text-white/90">{value}</div>
    </div>
  );
}