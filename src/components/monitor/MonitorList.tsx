"use client";
import React, { useState, useEffect, useCallback } from "react";
import AddressCopy from "@/components/common/AddressCopy";
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

interface OwnWallet {
  id: number;
  address: string;
  label: string | null;
}

export default function MonitorList() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'paused'>('all');
  const [busy, setBusy] = useState<null | 'cleanup' | 'clearAll'>(null);

  // 我的钱包
  const [ownWallets, setOwnWallets] = useState<OwnWallet[]>([]);
  const [walletAddr, setWalletAddr] = useState('');
  const [walletLabel, setWalletLabel] = useState('');
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tRes, sRes, wRes] = await Promise.all([
        fetch('/api/targets').then((r) => r.json()),
        fetch('/api/stats').then((r) => r.json()),
        fetch('/api/wallets').then((r) => r.json()),
      ]);
      if (tRes.ok) setTargets(tRes.data);
      if (sRes.ok) setStats(sRes.data);
      if (wRes.ok) setOwnWallets(wRes.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const addWallet = async () => {
    setWalletError(null);
    if (!walletAddr || walletAddr.length < 32 || walletAddr.length > 44) {
      setWalletError('请输入合法的 Solana 地址 (32-44 字符)');
      return;
    }
    setWalletBusy(true);
    try {
      const res = await fetch('/api/wallets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: walletAddr, label: walletLabel || undefined }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      setWalletAddr('');
      setWalletLabel('');
      await load();
    } catch (err: any) {
      setWalletError(err.message || '添加失败');
    } finally {
      setWalletBusy(false);
    }
  };

  const removeWallet = async (id: number) => {
    if (!confirm('删除此跟单钱包？')) return;
    await fetch(`/api/wallets?id=${id}`, { method: 'DELETE' });
    await load();
  };

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

  const handleCleanup = async () => {
    if (!confirm('清理 30 天前的旧记录？此操作不可撤销')) return;
    setBusy('cleanup');
    try {
      const res = await fetch('/api/targets/cleanup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const json = await res.json();
      if (json.ok) alert(`已清理 ${json.deleted} 条旧记录`);
      else alert(`失败: ${json.error}`);
      await load();
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
      await load();
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

      {/* 我的钱包 */}
      <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-white/90">我的钱包</h2>
          <span className="text-xs text-gray-500 dark:text-gray-400">我自己跟单的地址（用来算我在抢单里的排位）</span>
        </div>
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex-1 min-w-[280px]">
            <input
              type="text"
              value={walletAddr}
              onChange={(e) => setWalletAddr(e.target.value.trim())}
              placeholder="Solana 地址..."
              className="w-full px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-700 text-sm font-mono text-gray-800 dark:text-white/90 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="w-32">
            <input
              type="text"
              value={walletLabel}
              onChange={(e) => setWalletLabel(e.target.value)}
              placeholder="备注"
              className="w-full px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-700 text-sm text-gray-800 dark:text-white/90 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button
            onClick={addWallet}
            disabled={walletBusy}
            className="h-10 px-4 rounded-xl bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-sm font-medium flex items-center gap-1"
          >
            <span>+</span>
            {walletBusy ? '添加中...' : '添加'}
          </button>
        </div>
        {walletError && <p className="mt-2 text-xs text-error-500">{walletError}</p>}
        {ownWallets.length > 0 ? (
          <div className="flex flex-wrap gap-2 mt-3">
            {ownWallets.map((w) => (
              <div
                key={w.id}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-warning-50 dark:bg-warning-500/10 border border-warning-200 dark:border-warning-500/30"
              >
                <AddressCopy address={w.address} length={6} />
                {w.label && <span className="text-xs text-gray-500 dark:text-gray-400">({w.label})</span>}
                <button
                  onClick={() => removeWallet(w.id)}
                  className="text-xs text-gray-400 hover:text-error-500 ml-1"
                  title="删除此钱包"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-xs text-gray-400">尚未添加任何钱包</p>
        )}
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
            onClick={() => load()}
            className="h-8 px-3 rounded-lg bg-slate-100 dark:bg-zinc-700 hover:bg-slate-200 dark:hover:bg-zinc-600 text-gray-600 dark:text-gray-300 text-xs"
          >
            刷新
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
                <th className="px-3 py-2 text-left font-medium">最近一次 第一个狙击者</th>
                <th className="px-3 py-2 text-left font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">加载中...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">暂无监控目标</td></tr>
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
