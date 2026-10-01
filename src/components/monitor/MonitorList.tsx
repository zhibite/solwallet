"use client";
import React, { useState, useEffect, useCallback } from "react";
import PrioSolAmount from "@/components/common/PrioSolAmount";
import AddTargetForm from "./AddTargetForm";
import TargetRow from "./TargetRow";

interface Target {
  id: number;
  address: string;
  label: string | null;
  threshold_sol: string;
  status: 'active' | 'paused';
  record_count: number;
  last_buy_at: string | null;
  updated_at: string;
  decision?: {
    worth_score: number;
    win_rate: number;
    avg_pnl_sol: number;
    p50_tip_sol: number;
    p50_prio_lamports: number;
    p75_tip_sol: number;
    p75_prio_lamports: number;
    success_count: number;
    failed_count: number;
    sample_size: number;
  };
}

interface Stats {
  activeTargets: number;
  recordedBuys: number;
  pending: number;
  analyzed: number;
}

export default function MonitorList() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false); // 静默刷新，不遮挡列表
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'paused'>('all');
  const [busy, setBusy] = useState<null | 'cleanup' | 'clearAll'>(null);

  const load = useCallback(async (isSilent = false) => {
    if (isSilent) setRefreshing(true);
    else setLoading(true);
    try {
      const [tRes, sRes] = await Promise.all([
        fetch('/api/targets').then((r) => r.json()),
        fetch('/api/stats').then((r) => r.json()),
      ]);
      if (tRes.ok) setTargets(tRes.data);
      if (sRes.ok) setStats(sRes.data);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load(false);
    const t = setInterval(() => load(true), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const handleAdd = async (data: { address: string; label?: string; threshold_sol: number }) => {
    const res = await fetch('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);
    await load(false);
  };

  const handlePause = async (id: number) => { await fetch(`/api/targets/${id}/pause`, { method: 'POST' }); load(true); };
  const handleResume = async (id: number) => { await fetch(`/api/targets/${id}/resume`, { method: 'POST' }); load(true); };
  const handleDelete = async (id: number) => { if (!confirm('确定删除？')) return; await fetch(`/api/targets/${id}`, { method: 'DELETE' }); load(true); };
  const handleClear = async (id: number) => { if (!confirm('清除所有记录？')) return; await fetch(`/api/targets/${id}/clear`, { method: 'POST' }); load(true); };
  const handleThreshold = async (id: number, val: number) => {
    await fetch(`/api/targets/${id}/threshold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threshold_sol: val }),
    });
    load(true);
  };

  const handleCleanup = async () => {
    if (!confirm('清理 30 天前的旧记录？此操作不可撤销')) return;
    setBusy('cleanup');
    try {
      const res = await fetch('/api/targets/cleanup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const json = await res.json();
      if (json.ok) alert(`已清理 ${json.deleted} 条旧记录`);
      else alert(`失败: ${json.error}`);
      await load(false);
    } finally {
      setBusy(null);
    }
  };

  const handleClearAll = async () => {
    if (!confirm('清空所有监控记录？此操作不可撤销')) return;
    if (!confirm('再次确认：会删除全部 target_trades，确定继续？')) return;
    setBusy('clearAll');
    try {
      const res = await fetch('/api/targets/clear-all', { method: 'POST' });
      const json = await res.json();
      if (json.ok) alert(`已清空 ${json.deleted.trades} 条交易、${json.deleted.analyses} 条分析`);
      else alert(`失败: ${json.error}`);
      await load(false);
    } finally {
      setBusy(null);
    }
  };

  const filtered = targets.filter((t) => statusFilter === 'all' || t.status === statusFilter);

  return (
    <div className="space-y-4">
      {/* 顶部统计 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="监控中" value={stats?.activeTargets ?? '-'} />
        <StatCard label="已记录 buy" value={stats?.recordedBuys ?? '-'} />
        <StatCard label="待分析" value={stats?.pending ?? '-'} />
        <StatCard label="已分析" value={stats?.analyzed ?? '-'} />
      </div>

      {/* 添加目标 + 全局操作 */}
      <AddTargetForm onAdd={handleAdd} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium text-gray-800 dark:text-white/90">监控列表</span>
          <span className="text-xs text-gray-500 dark:text-gray-400">共 {filtered.length} 个</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => load(true)}
            className="h-8 px-3 rounded-lg bg-slate-100 dark:bg-zinc-700 hover:bg-slate-200 dark:hover:bg-zinc-600 text-gray-600 dark:text-gray-300 text-xs flex items-center gap-1"
          >
            <span className={`inline-block w-3 h-3 rounded-full border border-current ${refreshing ? 'animate-spin' : ''}`} style={{ borderTopColor: 'transparent' }} />
            {refreshing ? '刷新中' : '刷新'}
          </button>
          <button
            onClick={handleCleanup}
            disabled={busy !== null}
            className="h-8 px-3 rounded-lg bg-slate-100 dark:bg-zinc-700 hover:bg-slate-200 dark:hover:bg-zinc-600 text-gray-600 dark:text-gray-300 text-xs disabled:opacity-50"
          >
            {busy === 'cleanup' ? '清理中...' : '清理旧记录'}
          </button>
          <button
            onClick={handleClearAll}
            disabled={busy !== null}
            className="h-8 px-3 rounded-lg bg-error-500/10 hover:bg-error-500/20 text-error-600 dark:text-error-400 text-xs disabled:opacity-50"
          >
            {busy === 'clearAll' ? '清空中...' : '清空全部记录'}
          </button>
        </div>
      </div>

      {/* 列表 */}
      <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="flex items-center justify-between p-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2 text-xs">
            {(['all', 'active', 'paused'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setStatusFilter(f)}
                className={`px-3 py-1 rounded-xl ${
                  statusFilter === f
                    ? 'bg-brand-500 text-white'
                    : 'bg-slate-100 dark:bg-zinc-700 text-gray-500 dark:text-gray-400 hover:bg-slate-200 dark:hover:bg-zinc-600'
                }`}
              >
                {f === 'all' ? '全部' : f === 'active' ? '监控中' : '已暂停'}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-zinc-800/50 text-xs text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium">监控目标</th>
                <th className="px-3 py-2 text-left font-medium">阈值</th>
                <th className="px-3 py-2 text-left font-medium">状态</th>
                <th className="px-3 py-2 text-center font-medium">记录数</th>
                <th className="px-3 py-2 text-left font-medium">最新 buy</th>
                <th className="px-3 py-2 text-left font-medium">距现在</th>
                <th className="px-3 py-2 text-left font-medium">最近一次 首狙</th>
                <th className="px-3 py-2 text-left font-medium">决策 (推荐 tip+prio / 评分)</th>
                <th className="px-3 py-2 text-left font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">加载中...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={9} className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">暂无监控目标</td></tr>
              ) : (
                filtered.map((t) => (
                  <TargetRow
                    key={t.id}
                    target={t}
                    onPause={handlePause}
                    onResume={handleResume}
                    onDelete={handleDelete}
                    onClear={handleClear}
                    onThresholdChange={handleThreshold}
                    decisionCell={<DecisionCell d={t.decision} />}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function DecisionCell({ d }: { d: Target['decision'] }) {
  if (!d) return <span className="text-xs text-gray-400">-</span>;
  const s = d.worth_score;
  const color = s > 1 ? 'text-success-500' : s < -0.5 ? 'text-error-500' : 'text-warning-500';
  const tipText = d.p75_tip_sol ? d.p75_tip_sol.toFixed(4) : '-';
  return (
    <div className="text-xs space-y-0.5">
      <div className="font-mono">
        <span className="text-gray-500">P75 tip </span>
        <span>{tipText}</span>
        <span className="text-gray-300 mx-1">+</span>
        <span className="text-gray-500">prio </span>
        <PrioSolAmount value={d.p75_prio_lamports} />
      </div>
      <div className="flex items-center gap-2">
        <span className={`font-mono font-semibold ${color}`}>{s.toFixed(2)}</span>
        <span className="text-gray-400">
          胜率 {(d.win_rate * 100).toFixed(0)}%
        </span>
        {d.sample_size === 0 && (
          <span className="text-xs text-gray-400">样本不足</span>
        )}
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
