"use client";
import React, { useEffect, useState } from "react";
import AddressCopy from "@/components/common/AddressCopy";
import RelativeTime from "@/components/common/RelativeTime";

interface Row {
  id: number;
  address: string;
  label: string | null;
  source: string;
  first_seen_at: string;
  confirmed_at: string;
  trade_count: number;
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

export default function LibraryPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [ownWallets, setOwnWallets] = useState<OwnWallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [newAddress, setNewAddress] = useState('');
  const [newLabel, setNewLabel] = useState('');

  const load = () => {
    setLoading(true);
    Promise.all([
      fetch('/api/library').then((r) => r.json()),
      fetch('/api/stats').then((r) => r.json()),
      fetch('/api/wallets').then((r) => r.json()),
    ]).then(([lib, st, ow]) => {
      if (lib.ok) setRows(lib.data);
      if (st.ok) setStats(st.data);
      if (ow.ok) setOwnWallets(ow.data);
    }).finally(() => setLoading(false));
  };

  useEffect(load, []);

  const addNew = async () => {
    if (!newAddress) return;
    await fetch('/api/library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: newAddress, label: newLabel || undefined }),
    });
    setNewAddress('');
    setNewLabel('');
    load();
  };

  const del = async (id: number) => {
    if (!confirm('确定删除？')) return;
    await fetch(`/api/library?id=${id}`, { method: 'DELETE' });
    load();
  };

  const removeOwn = async (id: number) => {
    if (!confirm('删除此跟单钱包？')) return;
    await fetch(`/api/wallets?id=${id}`, { method: 'DELETE' });
    load();
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-800 dark:text-white/90">跟单库</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">已确认的聪明钱地址池，可批量导入 Helius 监控</p>
      </div>

      {/* 顶部统计卡 */}
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
          <span className="text-xs text-gray-500 dark:text-gray-400">用于跟单时识别「我的账号」</span>
        </div>
        {ownWallets.length === 0 ? (
          <p className="text-xs text-gray-400">尚未添加，到 设置 → 自己钱包 添加</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {ownWallets.map((w) => (
              <div key={w.id} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-warning-50 dark:bg-warning-500/10 border border-warning-200 dark:border-warning-500/30">
                <AddressCopy address={w.address} length={6} />
                {w.label && <span className="text-xs text-gray-500 dark:text-gray-400">({w.label})</span>}
                <button onClick={() => removeOwn(w.id)} className="text-xs text-gray-400 hover:text-error-500">×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[300px]">
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">添加新地址</label>
            <input
              type="text"
              value={newAddress}
              onChange={(e) => setNewAddress(e.target.value.trim())}
              placeholder="Solana 地址..."
              className="w-full px-4 py-2 pr-10 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-700 text-sm font-mono text-gray-800 dark:text-white/90 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="w-40">
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">标签</label>
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="备注"
              className="w-full px-4 py-2 pr-10 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-700 text-sm text-gray-800 dark:text-white/90 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button onClick={addNew} className="h-10 px-4 rounded-xl bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium">添加</button>
        </div>
      </div>

      <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-800 dark:text-white/90">
          共 {rows.length} 个地址
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-zinc-700/50 text-xs text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 text-left">地址</th>
                <th className="px-3 py-2 text-left">标签</th>
                <th className="px-3 py-2 text-left">来源</th>
                <th className="px-3 py-2 text-center">交易数</th>
                <th className="px-3 py-2 text-left">首次发现</th>
                <th className="px-3 py-2 text-left">确认时间</th>
                <th className="px-3 py-2 text-center">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-500 dark:text-gray-400">加载中...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-500 dark:text-gray-400">跟单库为空</td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-b border-gray-100 dark:border-gray-700/50">
                    <td className="px-3 py-2"><AddressCopy address={r.address} length={6} /></td>
                    <td className="px-3 py-2 text-gray-600 dark:text-gray-300">{r.label || '-'}</td>
                    <td className="px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{r.source}</td>
                    <td className="px-3 py-2 text-center font-mono text-gray-800 dark:text-white/90">{r.trade_count}</td>
                    <td className="px-3 py-2"><RelativeTime iso={r.first_seen_at} /></td>
                    <td className="px-3 py-2"><RelativeTime iso={r.confirmed_at} /></td>
                    <td className="px-3 py-2 text-center">
                      <button onClick={() => del(r.id)} className="text-xs text-error-500 hover:underline">删除</button>
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
