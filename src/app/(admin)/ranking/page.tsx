"use client";
import React, { useEffect, useState } from "react";
import AddressCopy from "@/components/common/AddressCopy";
import SolAmount from "@/components/common/SolAmount";
import RelativeTime from "@/components/common/RelativeTime";

interface Row {
  address: string;
  trade_count: number;
  total_buy: string;
  total_pnl: string;
  avg_pnl: string;
  win_count: number;
  loss_count: number;
  last_active: string;
}

export default function RankingPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);

  useEffect(() => {
    setLoading(true);
    const from = new Date(Date.now() - 86400_000 * days).toISOString();
    fetch(`/api/ranking?from=${from}&limit=100`)
      .then((r) => r.json())
      .then((j) => { if (j.ok) setRows(j.data); })
      .finally(() => setLoading(false));
  }, [days]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-800 dark:text-white/90">跟单排行</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">按已确认目标的 PnL 排序，找到真正赚钱的聪明钱</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 dark:text-gray-400">时间范围</span>
          <select
            value={days}
            onChange={(e) => setDays(parseInt(e.target.value, 10))}
            className="h-9 px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-700 text-sm text-gray-800 dark:text-white/90 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value={7}>最近 7 天</option>
            <option value={30}>最近 30 天</option>
            <option value={90}>最近 90 天</option>
          </select>
        </div>
      </div>

      <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-zinc-700/50 text-xs text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 text-center">#</th>
                <th className="px-3 py-2 text-left">地址</th>
                <th className="px-3 py-2 text-right">交易次数</th>
                <th className="px-3 py-2 text-right">总买入 SOL</th>
                <th className="px-3 py-2 text-right">总 PnL</th>
                <th className="px-3 py-2 text-right">平均 PnL</th>
                <th className="px-3 py-2 text-center">胜率</th>
                <th className="px-3 py-2 text-center">最后活跃</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-500 dark:text-gray-400">加载中...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-500 dark:text-gray-400">暂无数据。请先在「跟单目标分析」中确认目标</td></tr>
              ) : (
                rows.map((r, idx) => {
                  const winRate = r.win_count + r.loss_count > 0
                    ? r.win_count / (r.win_count + r.loss_count)
                    : 0;
                  return (
                    <tr key={r.address} className="border-b border-gray-100 dark:border-gray-700/50">
                      <td className="px-3 py-2 text-center font-mono text-xs text-gray-500 dark:text-gray-400">{idx + 1}</td>
                      <td className="px-3 py-2"><AddressCopy address={r.address} length={6} /></td>
                      <td className="px-3 py-2 text-right font-mono text-gray-800 dark:text-white/90">{r.trade_count}</td>
                      <td className="px-3 py-2 text-right"><SolAmount value={r.total_buy} /></td>
                      <td className="px-3 py-2 text-right"><SolAmount value={r.total_pnl} signed /></td>
                      <td className="px-3 py-2 text-right"><SolAmount value={r.avg_pnl} signed /></td>
                      <td className="px-3 py-2 text-center">
                        <span className={`font-mono text-xs ${winRate >= 0.5 ? 'text-success-500' : 'text-error-500'}`}>
                          {(winRate * 100).toFixed(1)}%
                        </span>
                        <span className="text-xs text-gray-400 dark:text-gray-500 ml-1">({r.win_count}/{r.win_count + r.loss_count})</span>
                      </td>
                      <td className="px-3 py-2 text-center"><RelativeTime iso={r.last_active} /></td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
