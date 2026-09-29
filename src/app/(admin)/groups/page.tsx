"use client";
import React, { useEffect, useState } from "react";
import AddressCopy from "@/components/common/AddressCopy";
import SolAmount from "@/components/common/SolAmount";

interface Row {
  addr_a: string;
  addr_b: string;
  shared_mints: number;
  co_occurrences: number;
  first_slot: number;
  last_slot: number;
  pnl_a: string | null;
  pnl_b: string | null;
}

export default function GroupsPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch('/api/groups')
      .then((r) => r.json())
      .then((j) => { if (j.ok) setRows(j.data); })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">组合排行</h1>
        <p className="text-sm text-gray-500 mt-1">
          找出经常在同 slot 内同时买入相同 mint 的地址组合（可能是同一团队 / 机器人组）
        </p>
      </div>

      <div className="bg-white dark:bg-zinc-900 rounded-lg border border-gray-200 dark:border-zinc-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-zinc-800/50 text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">地址 A</th>
                <th className="px-3 py-2 text-right">PnL A</th>
                <th className="px-3 py-2 text-left">地址 B</th>
                <th className="px-3 py-2 text-right">PnL B</th>
                <th className="px-3 py-2 text-center">共同 mint</th>
                <th className="px-3 py-2 text-center">同 slot 次数</th>
                <th className="px-3 py-2 text-right">最近 slot</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-500">加载中...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-500">暂无数据。先监控一段时间积累 block 分析</td></tr>
              ) : (
                rows.map((r, idx) => (
                  <tr key={`${r.addr_a}-${r.addr_b}-${idx}`} className="border-b border-gray-100 dark:border-zinc-700/50">
                    <td className="px-3 py-2"><AddressCopy address={r.addr_a} length={4} /></td>
                    <td className="px-3 py-2 text-right"><SolAmount value={r.pnl_a} signed /></td>
                    <td className="px-3 py-2"><AddressCopy address={r.addr_b} length={4} /></td>
                    <td className="px-3 py-2 text-right"><SolAmount value={r.pnl_b} signed /></td>
                    <td className="px-3 py-2 text-center font-mono">{r.shared_mints}</td>
                    <td className="px-3 py-2 text-center font-mono">{r.co_occurrences}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{r.last_slot}</td>
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
