"use client";
import React, { useState } from "react";
import { PlusIcon } from "@/icons";

interface Props {
  onAdd: (data: { address: string; label?: string; threshold_sol: number }) => Promise<void>;
}

export default function AddTargetForm({ onAdd }: Props) {
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [threshold, setThreshold] = useState("0.5");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!address || address.length < 32 || address.length > 44) {
      setError('请输入合法的 Solana 地址 (32-44 字符)');
      return;
    }
    setLoading(true);
    try {
      await onAdd({ address, label: label || undefined, threshold_sol: parseFloat(threshold) || 0.5 });
      setAddress("");
      setLabel("");
    } catch (err: any) {
      setError(err.message || '添加失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={submit} className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[280px]">
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">监控目标地址</label>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value.trim())}
            placeholder="Solana 地址..."
            className="w-full px-4 py-2 pr-10 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-700 text-sm font-mono text-gray-800 dark:text-white/90 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="w-40">
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">标签 (可选)</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="备注"
            className="w-full px-4 py-2 pr-10 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-700 text-sm text-gray-800 dark:text-white/90 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="w-32">
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">阈值 (SOL)</label>
          <input
            type="number"
            step="0.1"
            min="0"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            className="w-full px-4 py-2 pr-10 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-700 text-sm text-gray-800 dark:text-white/90 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="h-10 px-4 rounded-xl bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-sm font-medium flex items-center gap-1.5"
        >
          <PlusIcon className="w-4 h-4" />
          {loading ? '添加中...' : '添加监控'}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-error-500">{error}</p>}
    </form>
  );
}