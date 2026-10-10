"use client";
import React, { useEffect, useMemo, useState } from "react";
import AddressCopy from "@/components/common/AddressCopy";
import SolAmount from "@/components/common/SolAmount";
import { ChevronDownIcon, ChevronUpIcon, GroupIcon } from "@/icons";

interface Member {
  address: string;
  trades: number;
  total_buy_sol: number;
  first_slot: number;
  last_slot: number;
}

interface Group {
  group_id: number;
  size: number;
  common_mints: number;
  common_mint_samples: string[];
  avg_shared: number;
  total_trades: number;
  total_buy_sol: number;
  first_slot: number;
  last_slot: number;
  members: Member[];
}

interface Stats {
  pairs: number;
  addresses: number;
  groups: number;
  min_shared: number;
  min_size: number;
}

export default function GroupsPage() {
  const [rows, setRows] = useState<Group[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // 过滤参数
  const [minShared, setMinShared] = useState(5);
  const [minSize, setMinSize] = useState(3);
  const [limit, setLimit] = useState(30);

  const queryString = useMemo(
    () => `min_shared=${minShared}&min_size=${minSize}&limit=${limit}`,
    [minShared, minSize, limit]
  );

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/groups?${queryString}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) {
          setRows(j.data);
          setStats(j.stats);
        } else {
          setError(j.error || "查询失败");
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [queryString]);

  const toggle = (gid: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid);
      else next.add(gid);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-gray-800 dark:text-white/90 flex items-center gap-2">
            <GroupIcon className="w-5 h-5" />
            组合排行
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            找出经常在同 slot 内同时买入相同 mint 的地址群组（团队 / 机器人组）——
            基于图连通分量（DFS）+ 成员 mint 集合交集。
          </p>
        </div>

        {/* 参数 */}
        <div className="flex items-end gap-3 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-gray-500 dark:text-gray-400">最小共同 mint</span>
            <input
              type="number"
              min={2}
              max={50}
              value={minShared}
              onChange={(e) => setMinShared(parseInt(e.target.value, 10) || 2)}
              className="w-20 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-zinc-800 text-gray-800 dark:text-white/90"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-gray-500 dark:text-gray-400">最小群组规模</span>
            <input
              type="number"
              min={2}
              max={20}
              value={minSize}
              onChange={(e) => setMinSize(parseInt(e.target.value, 10) || 2)}
              className="w-20 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-zinc-800 text-gray-800 dark:text-white/90"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-gray-500 dark:text-gray-400">返回条数</span>
            <input
              type="number"
              min={1}
              max={200}
              value={limit}
              onChange={(e) => setLimit(parseInt(e.target.value, 10) || 30)}
              className="w-20 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-zinc-800 text-gray-800 dark:text-white/90"
            />
          </label>
        </div>
      </div>

      {/* 统计信息 */}
      {stats && !loading && (
        <div className="text-xs text-gray-500 dark:text-gray-400 flex flex-wrap gap-x-4 gap-y-1">
          <span>边 (pair): <b className="text-gray-700 dark:text-white/90">{stats.pairs}</b></span>
          <span>地址数: <b className="text-gray-700 dark:text-white/90">{stats.addresses}</b></span>
          <span>群组数: <b className="text-gray-700 dark:text-white/90">{stats.groups}</b></span>
          <span>阈值: shared ≥ {stats.min_shared}，size ≥ {stats.min_size}</span>
        </div>
      )}

      {error && (
        <div className="text-sm text-error-500 bg-error-500/10 border border-error-500/30 rounded px-3 py-2">
          {error}
        </div>
      )}

      <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-zinc-700/50 text-xs text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 text-center w-10"></th>
                <th className="px-3 py-2 text-center">群组规模</th>
                <th className="px-3 py-2 text-center">共同 mint</th>
                <th className="px-3 py-2 text-center">平均关系强度</th>
                <th className="px-3 py-2 text-center">成员总买入笔数</th>
                <th className="px-3 py-2 text-center">成员总买入 SOL</th>
                <th className="px-3 py-2 text-right">活跃 slot 跨度</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-500 dark:text-gray-400">加载中...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-500 dark:text-gray-400">
                  {error ? "查询失败" : "暂无数据。降低「最小共同 mint」或继续监控积累数据"}
                </td></tr>
              ) : (
                rows.map((g) => {
                  const isOpen = expanded.has(g.group_id);
                  return (
                    <React.Fragment key={g.group_id}>
                      <tr
                        onClick={() => toggle(g.group_id)}
                        className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-zinc-700/30 cursor-pointer"
                      >
                        <td className="px-3 py-2 text-center">
                          {isOpen
                            ? <ChevronUpIcon className="w-4 h-4 inline text-gray-500" />
                            : <ChevronDownIcon className="w-4 h-4 inline text-gray-500" />}
                        </td>
                        <td className="px-3 py-2 text-center font-mono text-gray-800 dark:text-white/90 font-semibold">
                          {g.size}
                        </td>
                        <td className="px-3 py-2 text-center font-mono text-gray-800 dark:text-white/90">
                          {g.common_mints}
                          {g.common_mints > 0 && g.common_mint_samples.length > 0 && (
                            <div className="text-[10px] text-gray-400 truncate max-w-[200px]" title={g.common_mint_samples.join('\n')}>
                              {g.common_mint_samples.map(m => `${m.slice(0, 4)}…${m.slice(-4)}`).join(', ')}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center font-mono text-gray-800 dark:text-white/90">
                          {g.avg_shared}
                        </td>
                        <td className="px-3 py-2 text-center font-mono text-gray-800 dark:text-white/90">
                          {g.total_trades}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <SolAmount value={g.total_buy_sol} />
                        </td>
                        <td className="px-3 py-2 text-right text-xs text-gray-500 dark:text-gray-400 font-mono">
                          {g.first_slot} → {g.last_slot}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-gray-50/50 dark:bg-zinc-900/40">
                          <td colSpan={7} className="px-3 py-3">
                            <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                              成员列表（按交易数排序，共 {g.members.length} 个）
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-1">
                              {g.members.map((m) => (
                                <div
                                  key={m.address}
                                  className="flex items-center justify-between gap-2 px-2 py-1 rounded border border-gray-200 dark:border-gray-700/50 bg-white dark:bg-zinc-800"
                                >
                                  <AddressCopy address={m.address} length={4} />
                                  <span className="text-[11px] text-gray-500 dark:text-gray-400 font-mono">
                                    {m.trades} 笔 · <SolAmount value={m.total_buy_sol} />
                                  </span>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
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
