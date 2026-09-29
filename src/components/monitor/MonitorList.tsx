"use client";
import React, { useState, useEffect, useCallback } from "react";
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
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'paused'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tRes, sRes] = await Promise.all([
        fetch('/api/targets').then((r) => r.json()),
        fetch('/api/stats').then((r) => r.json()),
      ]);
      if (tRes.ok) setTargets(tRes.data);
      if (sRes.ok) setStats(sRes.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
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
    await load();
  };

  const handlePause = async (id: number) => { await fetch(`/api/targets/${id}/pause`, { method: 'POST' }); load(); };
  const handleResume = async (id: number) => { await fetch(`/api/targets/${id}/resume`, { method: 'POST' }); load(); };
  const handleDelete = async (id: number) => { if (!confirm('确定删除？')) return; await fetch(`/api/targets/${id}`, { method: 'DELETE' }); load(); };
  const handleClear = async (id: number) => { if (!confirm('清除所有记录？')) return; await fetch(`/api/targets/${id}/clear`, { method: 'POST' }); load(); };
  const handleThreshold = async (id: number, val: number) => {
    await fetch(`/api/targets/${id}/threshold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threshold_sol: val }),
    });
    load();
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

      {/* 添加目标 */}
      <AddTargetForm onAdd={handleAdd} />

      {/* 列表 */}
      <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="flex items-center justify-between p-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-gray-800 dark:text-white/90">监控列表</span>
            <span className="text-xs text-gray-500 dark:text-gray-400">共 {filtered.length} 个</span>
          </div>
          <div className="flex items-center gap-1 text-xs">
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
                <th className="px-3 py-2 text-left font-medium">最近狙击者</th>
                <th className="px-3 py-2 text-left font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">加载中...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">暂无监控目标</td></tr>
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

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className="text-2xl font-semibold mt-1 text-gray-800 dark:text-white/90">{value}</div>
    </div>
  );
}
