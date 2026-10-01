"use client";
import React, { useEffect, useState } from "react";
import AddressCopy from "@/components/common/AddressCopy";
import SolAmount from "@/components/common/SolAmount";
import PrioSolAmount from "@/components/common/PrioSolAmount";
import RelativeTime from "@/components/common/RelativeTime";

interface Row {
  address: string;
  snipe_count: number;
  mint_count: number;
  win_count: number;
  win_rate: string | null;
  total_buy: string;
  total_tip: string;
  total_prio: string;
  avg_offset: string | null;
  total_pnl: string | null;
  avg_pnl: string | null;
  last_active: string;
}

const SORTS = [
  { id: 'count',      label: '狙击次数' },
  { id: 'pnl',        label: '总收益' },
  { id: 'win_rate',   label: '胜率' },
  { id: 'avg_offset', label: '平均偏移（越早越好）' },
] as const;
type SortId = typeof SORTS[number]['id'];

const PAGE_SIZE = 30;

export default function SniperRankingPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);
  const [sort, setSort] = useState<SortId>('count');
  const [page, setPage] = useState(1);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    setLoading(true);
    const from = new Date(Date.now() - 86400_000 * days).toISOString();
    const offset = (page - 1) * PAGE_SIZE;
    fetch(`/api/sniper-ranking?from=${from}&limit=${PAGE_SIZE}&offset=${offset}&sort=${sort}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) {
          setRows(j.data);
          setTotal(j.total ?? 0);
        }
      })
      .finally(() => setLoading(false));
  }, [days, sort, page]);

  // 切换 days/sort 后回到第 1 页
  const handleDaysChange = (v: number) => { setDays(v); setPage(1); };
  const handleSortChange = (v: SortId) => { setSort(v); setPage(1); };

  // 当 total 缩小，避免 page 超出范围
  useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [totalPages, page]);

  const start = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const end = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-semibold text-gray-800 dark:text-white/90">狙击排行</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            在跟单抢单中第一个冲进去的地址（is_first_sniper），看谁最爱抢、谁最会抢
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 dark:text-gray-400">时间范围</span>
            <select
              value={days}
              onChange={(e) => handleDaysChange(parseInt(e.target.value, 10))}
              className="h-9 px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-700 text-sm text-gray-800 dark:text-white/90 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value={7}>最近 7 天</option>
              <option value={30}>最近 30 天</option>
              <option value={90}>最近 90 天</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 dark:text-gray-400">排序</span>
            <select
              value={sort}
              onChange={(e) => handleSortChange(e.target.value as SortId)}
              className="h-9 px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-700 text-sm text-gray-800 dark:text-white/90 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-zinc-700/50 text-xs text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 text-center">#</th>
                <th className="px-3 py-2 text-left">地址</th>
                <th className="px-3 py-2 text-right">狙击次数</th>
                <th className="px-3 py-2 text-right">mint 数</th>
                <th className="px-3 py-2 text-right">胜率</th>
                <th className="px-3 py-2 text-right">总买入 SOL</th>
                <th className="px-3 py-2 text-right">总 TIP</th>
                <th className="px-3 py-2 text-right">总优先费</th>
                <th className="px-3 py-2 text-right">平均偏移</th>
                <th className="px-3 py-2 text-right">总 PnL</th>
                <th className="px-3 py-2 text-right">平均 PnL</th>
                <th className="px-3 py-2 text-center">最后活跃</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={12} className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">加载中...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={12} className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">暂无狙击数据。需要先有 block 级分析记录</td></tr>
              ) : (
                rows.map((r, idx) => {
                  const winRate = r.win_rate ? parseFloat(r.win_rate) : 0;
                  const avgOffset = r.avg_offset !== null ? parseFloat(r.avg_offset) : null;
                  const offsetColor = avgOffset === null
                    ? 'text-gray-500 dark:text-gray-400'
                    : avgOffset > 0
                      ? 'text-error-500'
                      : avgOffset < 0
                        ? 'text-success-600'
                        : 'text-gray-500 dark:text-gray-400';
                  return (
                    <tr key={r.address} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-zinc-700/30">
                      <td className="px-3 py-2 text-center font-mono text-xs text-gray-500 dark:text-gray-400">{(page - 1) * PAGE_SIZE + idx + 1}</td>
                      <td className="px-3 py-2"><AddressCopy address={r.address} length={6} /></td>
                      <td className="px-3 py-2 text-right font-mono text-gray-800 dark:text-white/90">{r.snipe_count}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-600 dark:text-gray-300">{r.mint_count}</td>
                      <td className="px-3 py-2 text-center">
                        <span className={`font-mono text-xs ${winRate >= 0.5 ? 'text-success-500' : 'text-error-500'}`}>
                          {(winRate * 100).toFixed(1)}%
                        </span>
                        <span className="text-xs text-gray-400 dark:text-gray-500 ml-1">
                          ({r.win_count}/{r.snipe_count})
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right"><SolAmount value={r.total_buy} /></td>
                      <td className="px-3 py-2 text-right"><SolAmount value={r.total_tip} /></td>
                      <td className="px-3 py-2 text-right"><PrioSolAmount value={r.total_prio} /></td>
                      <td className={`px-3 py-2 text-right font-mono ${offsetColor}`}>
                        {avgOffset === null
                          ? '-'
                          : `${avgOffset > 0 ? '+' : ''}${avgOffset.toFixed(1)}`}
                      </td>
                      <td className="px-3 py-2 text-right"><SolAmount value={r.total_pnl} signed /></td>
                      <td className="px-3 py-2 text-right"><SolAmount value={r.avg_pnl} signed /></td>
                      <td className="px-3 py-2 text-center"><RelativeTime iso={r.last_active} /></td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* 分页 */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-gray-200 dark:border-gray-700 text-sm">
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {total === 0
              ? '共 0 条'
              : `第 ${start}–${end} 条 / 共 ${total} 条`}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
              className="h-8 px-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/[0.03] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              上一页
            </button>
            <span className="text-xs text-gray-600 dark:text-gray-400 font-mono">
              {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
              className="h-8 px-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/[0.03] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              下一页
            </button>
            <div className="flex items-center gap-1 ml-2">
              <span className="text-xs text-gray-500 dark:text-gray-400">跳至</span>
              <input
                type="number"
                min={1}
                max={totalPages}
                value={page}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (Number.isFinite(v)) {
                    setPage(Math.min(totalPages, Math.max(1, v)));
                  }
                }}
                className="w-14 h-8 px-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-800 text-center text-gray-800 dark:text-white/90 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <span className="text-xs text-gray-500 dark:text-gray-400">页</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}