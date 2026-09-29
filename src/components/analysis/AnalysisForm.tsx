"use client";
import React, { useState, useMemo } from "react";
import AddressCopy from "@/components/common/AddressCopy";
import SolAmount from "@/components/common/SolAmount";
import RelativeTime from "@/components/common/RelativeTime";
import { CheckLineIcon, CloseLineIcon } from "@/icons";

interface Trade {
  signature: string;
  slot: number;
  blockTime: number;
  mint: string;
  sol: number;
  pnl: number;
  status: 'confirmed' | 'pending' | 'failed';
  version: string;
  tip: number;
  prio: number;
  txid: string;
  /** 跟单目标地址（用户输入的地址），用来填「跟单目标」列 */
  targetAddress?: string;
  /** 跟单目标标签（如果系统库里有） */
  targetLabel?: string | null;
}

interface AnalysisResult {
  totalPnl: number;
  failedFee: number;
  netPnl: number;
  buyCount: number;
  failed: number;
  confirmed: number;
  pending: number;
  trades: Trade[];
}

const PAGE_SIZE = 20;

export default function AnalysisForm() {
  const [address, setAddress] = useState('');
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [includeFailed, setIncludeFailed] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'confirmed' | 'failed'>('all');
  const [page, setPage] = useState(1);
  const [confirming, setConfirming] = useState(false);

  const analyze = async () => {
    if (!address || address.length < 32) {
      setError('请输入合法的 Solana 地址');
      return;
    }
    setError(null);
    setLoading(true);
    setPage(1);
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          from: new Date(from).toISOString(),
          to: new Date(to + 'T23:59:59').toISOString(),
          includeFailed,
        }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      setResult(json.data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const confirmTarget = async () => {
    setConfirming(true);
    try {
      await fetch('/api/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, source: 'analyze' }),
      });
      alert('已加入跟单库');
    } finally {
      setConfirming(false);
    }
  };

  const exportCsv = async () => {
    window.location.href = '/api/export?type=confirmed';
  };

  // 跟单目标展示：分析时目标就是用户输入的 address，标签从监控库查（简化用 address 自身）
  const targetLabel = useMemo(() => {
    if (!result || !address) return null;
    return address.slice(0, 4) + '...' + address.slice(-4);
  }, [result, address]);

  const filteredTrades = useMemo(() => {
    return result?.trades.filter((t) => {
      if (filter === 'all') return true;
      if (filter === 'confirmed') return t.status === 'confirmed';
      if (filter === 'failed') return t.status === 'failed';
      return true;
    }) ?? [];
  }, [result?.trades, filter]);

  const totalFiltered = filteredTrades.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / PAGE_SIZE));
  const pagedTrades = filteredTrades.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="space-y-4">
      {/* 输入区 */}
      <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[300px]">
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">目标钱包地址</label>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value.trim())}
              placeholder="Solana 地址..."
              className="w-full px-4 py-2 pr-10 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-700 text-sm font-mono text-gray-800 dark:text-white/90 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">开始日期</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="h-10 px-4 py-2 pr-10 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-700 text-sm text-gray-800 dark:text-white/90 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">结束日期</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-10 px-4 py-2 pr-10 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-700 text-sm text-gray-800 dark:text-white/90 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
            <input
              type="checkbox"
              checked={includeFailed}
              onChange={(e) => setIncludeFailed(e.target.checked)}
              className="rounded"
            />
            包含失败交易
          </label>
          <button
            onClick={analyze}
            disabled={loading}
            className="h-10 px-5 rounded-xl bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-sm font-medium"
          >
            {loading ? '分析中...' : '分析'}
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-error-500">{error}</p>}
      </div>

      {/* 结果 */}
      {result && (
        <>
          {/* 统计卡片 */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
            <StatCard label="总 PnL (SOL)" value={<SolAmount value={result.totalPnl} signed />} highlight />
            <StatCard label="失败手续费 (SOL)" value={<SolAmount value={result.failedFee} />} />
            <StatCard label="净 PnL (SOL)" value={<SolAmount value={result.netPnl} signed />} highlight />
            <StatCard label="Buy 数量" value={result.buyCount} />
            <StatCard label="失败" value={result.failed} />
            <StatCard label="已确认" value={result.confirmed} />
            <StatCard label="未确认" value={result.pending} />
          </div>

          {/* 操作 */}
          <div className="flex gap-2">
            <button
              onClick={confirmTarget}
              disabled={confirming}
              className="h-9 px-4 rounded-xl bg-success-500 hover:bg-success-600 disabled:opacity-50 text-white text-sm font-medium"
            >
              {confirming ? '提交中...' : '一键确认目标'}
            </button>
            <button
              onClick={exportCsv}
              className="h-9 px-4 rounded-xl bg-slate-100 dark:bg-zinc-700 hover:bg-slate-200 dark:hover:bg-zinc-600 text-gray-500 dark:text-gray-400 text-sm"
            >
              导出已确认目标
            </button>
          </div>

          {/* 交易列表 */}
          <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div className="flex items-center justify-between gap-2 p-3 border-b border-gray-200 dark:border-gray-700 text-sm flex-wrap">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setFilter('all'); setPage(1); }}
                  className={`px-3 py-1 rounded-xl text-xs ${
                    filter === 'all' ? 'bg-brand-500 text-white' : 'bg-slate-100 dark:bg-zinc-700 text-gray-500 dark:text-gray-400 hover:bg-slate-200 dark:hover:bg-zinc-600'
                  }`}
                >
                  全部 ({result.trades.length})
                </button>
                <button
                  onClick={() => { setFilter('confirmed'); setPage(1); }}
                  className={`px-3 py-1 rounded-xl text-xs ${
                    filter === 'confirmed' ? 'bg-success-500 text-white' : 'bg-slate-100 dark:bg-zinc-700 text-gray-500 dark:text-gray-400 hover:bg-slate-200 dark:hover:bg-zinc-600'
                  }`}
                >
                  只看成功 ({result.confirmed})
                </button>
                <button
                  onClick={() => { setFilter('failed'); setPage(1); }}
                  className={`px-3 py-1 rounded-xl text-xs ${
                    filter === 'failed' ? 'bg-error-500 text-white' : 'bg-slate-100 dark:bg-zinc-700 text-gray-500 dark:text-gray-400 hover:bg-slate-200 dark:hover:bg-zinc-600'
                  }`}
                >
                  只看失败 ({result.failed})
                </button>
              </div>
              <span className="text-xs text-gray-500 dark:text-gray-400">
                显示 {(page - 1) * PAGE_SIZE + (pagedTrades.length > 0 ? 1 : 0)} - {Math.min(page * PAGE_SIZE, totalFiltered)} / {totalFiltered}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-zinc-700/50 text-xs text-gray-500 dark:text-gray-400">
                  <tr>
                    <th className="px-3 py-2 text-left">时间</th>
                    <th className="px-3 py-2 text-left">SLOT</th>
                    <th className="px-3 py-2 text-left">MINT</th>
                    <th className="px-3 py-2 text-right">SOL</th>
                    <th className="px-3 py-2 text-right">收益</th>
                    <th className="px-3 py-2 text-right">TIP</th>
                    <th className="px-3 py-2 text-right">优先级费</th>
                    <th className="px-3 py-2 text-left">TXID</th>
                    <th className="px-3 py-2 text-center">状态</th>
                    <th className="px-3 py-2 text-left">跟单目标</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedTrades.length === 0 ? (
                    <tr><td colSpan={10} className="px-3 py-6 text-center text-gray-500 dark:text-gray-400">无符合条件的交易</td></tr>
                  ) : (
                    pagedTrades.map((t) => (
                      <tr key={t.signature} className="border-b border-gray-100 dark:border-gray-700/50">
                        <td className="px-3 py-2"><RelativeTime iso={new Date(t.blockTime * 1000).toISOString()} /></td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-gray-400">{t.slot}</td>
                        <td className="px-3 py-2"><AddressCopy address={t.mint} length={4} /></td>
                        <td className="px-3 py-2 text-right"><SolAmount value={t.sol} /></td>
                        <td className="px-3 py-2 text-right"><SolAmount value={t.pnl} signed /></td>
                        <td className="px-3 py-2 text-right"><SolAmount value={t.tip} /></td>
                        <td className="px-3 py-2 text-right font-mono text-xs">{t.prio}</td>
                        <td className="px-3 py-2">
                          <a
                            href={`https://solscan.io/tx/${t.txid}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-brand-500 hover:underline font-mono text-xs"
                          >
                            {t.txid.slice(0, 8)}...
                          </a>
                        </td>
                        <td className="px-3 py-2 text-center">
                          {t.status === 'confirmed' ? (
                            <CheckLineIcon className="w-4 h-4 text-success-500 inline" />
                          ) : t.status === 'failed' ? (
                            <CloseLineIcon className="w-4 h-4 text-error-500 inline" />
                          ) : (
                            <span className="text-xs text-gray-400">pending</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1">
                            <AddressCopy address={address} length={4} />
                            {targetLabel && <span className="text-xs text-gray-400">{targetLabel}</span>}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {/* 分页 */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-3 py-2 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
                <span>第 {page} / {totalPages} 页</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                    className="px-2 py-1 rounded bg-slate-100 dark:bg-zinc-700 disabled:opacity-50 hover:bg-slate-200 dark:hover:bg-zinc-600"
                  >
                    上一页
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                    className="px-2 py-1 rounded bg-slate-100 dark:bg-zinc-700 disabled:opacity-50 hover:bg-slate-200 dark:hover:bg-zinc-600"
                  >
                    下一页
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {!result && !loading && (
        <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 p-8 text-center text-gray-500 dark:text-gray-400">
          请输入目标地址和时间范围进行分析
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, highlight = false }: { label: string; value: React.ReactNode; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 shadow-sm ${
      highlight
        ? 'bg-brand-50 dark:bg-brand-500/10 border-brand-200 dark:border-brand-500/30'
        : 'bg-white dark:bg-zinc-800 border-gray-200 dark:border-gray-700'
    }`}>
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className="text-lg font-semibold mt-0.5 text-gray-800 dark:text-white/90">{value}</div>
    </div>
  );
}
