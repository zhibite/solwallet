"use client";
import React, { useEffect, useState } from "react";
import AddressCopy from "@/components/common/AddressCopy";

interface Target {
  id: number;
  address: string;
  threshold_sol: string;
}

export default function ThresholdPage() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [defaultThreshold, setDefaultThreshold] = useState('0.5');

  useEffect(() => {
    fetch('/api/targets')
      .then((r) => r.json())
      .then((j) => { if (j.ok) setTargets(j.data); });
    fetch('/api/settings')
      .then((r) => r.json())
      .then((j) => {
        if (j.ok && j.data.DEFAULT_THRESHOLD) setDefaultThreshold(j.data.DEFAULT_THRESHOLD);
      });
  }, []);

  const saveDefault = async () => {
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ DEFAULT_THRESHOLD: defaultThreshold }),
    });
    alert('已保存');
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-800 dark:text-white/90">监控阈值</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">所有目标低于此 SOL 买入额不会触发记录</p>
      </div>

      <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex items-end gap-3">
          <div className="w-40">
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">默认阈值 (SOL)</label>
            <input
              type="number"
              step="0.1"
              value={defaultThreshold}
              onChange={(e) => setDefaultThreshold(e.target.value)}
              className="w-full px-4 py-2 pr-10 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-700 text-sm text-gray-800 dark:text-white/90 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button onClick={saveDefault} className="h-10 px-4 rounded-xl bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium">
            保存默认
          </button>
        </div>
      </div>

      <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-800 dark:text-white/90">
          各目标当前阈值
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-zinc-700/50 text-xs text-gray-500 dark:text-gray-400">
            <tr>
              <th className="px-3 py-2 text-left">地址</th>
              <th className="px-3 py-2 text-right">当前阈值</th>
            </tr>
          </thead>
          <tbody>
            {targets.length === 0 ? (
              <tr><td colSpan={2} className="px-3 py-6 text-center text-gray-500 dark:text-gray-400">未配置</td></tr>
            ) : (
              targets.map((t) => (
                <tr key={t.id} className="border-b border-gray-100 dark:border-gray-700/50">
                  <td className="px-3 py-2"><AddressCopy address={t.address} length={6} /></td>
                  <td className="px-3 py-2 text-right font-mono text-gray-800 dark:text-white/90">{parseFloat(t.threshold_sol).toFixed(4)} SOL</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
