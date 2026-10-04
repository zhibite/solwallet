"use client";
import React, { useState, useMemo } from "react";
import AddressCopy from "@/components/common/AddressCopy";
import SolAmount from "@/components/common/SolAmount";
import PrioSolAmount from "@/components/common/PrioSolAmount";
import RelativeTime from "@/components/common/RelativeTime";
import { CheckLineIcon, CloseLineIcon } from "@/icons";
import { useConfirm } from "@/components/ui/confirm-dialog";

interface Trade {
  signature: string;
  slot: number;
  blockTime: number;
  mint: string;
  sol: number;
  /** 单笔跟单收益；持仓中为 null（还没卖，收益未实现） */
  pnl: number | null;
  tokenAmount: number;
  status: 'closed' | 'partial' | 'open' | 'buy_failed';
  /** 这笔买入的 token 已卖出比例 0~1 */
  soldRatio: number;
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
  /** 已实现跟单收益合计（持仓中的买入不计入） */
  realizedPnl: number;
  /** 窗口内失败交易的手续费，不并入 realizedPnl */
  failedFee: number;
  buyCount: number;
  closedCount: number;
  openCount: number;
  /** 部分平仓；前端「已平仓」标签含它 */
  partialCount: number;
  /** 买入失败；前端「持仓中」标签含它 */
  buyFailedCount: number;
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
  const [filter, setFilter] = useState<'all' | 'closed' | 'open'>('all');
  const [page, setPage] = useState(1);
  const [confirming, setConfirming] = useState(false);
  const { alert } = useConfirm();

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
      await alert({ title: '已加入跟单库', description: `${address} 已确认`, variant: 'success' });
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

  // 衍生指标：胜率 / 包赚钱率 / 最大单笔盈亏
  const extraStats = useMemo(() => {
    if (!result) return null;
    const trades = result.trades;
    // pnl 为 null = 持仓中，收益未实现，不进胜率
    const wins = trades.filter((t) => (t.pnl ?? 0) > 0).length;
    const losses = trades.filter((t) => (t.pnl ?? 0) < 0).length;
    const settled = wins + losses; // 已结案（不含持仓中）
    const winRate = settled > 0 ? (wins / settled) * 100 : 0;
    const coverageRate = result.buyCount > 0 ? (settled / result.buyCount) * 100 : 0;
    const pnls = trades.map((t) => t.pnl).filter((p): p is number => p != null);
    const maxWin = pnls.reduce((m, p) => (p > m ? p : m), 0);
    const maxLoss = pnls.reduce((m, p) => (p < m ? p : m), 0);
    return { winRate, coverageRate, maxWin, maxLoss };
  }, [result]);

  const filteredTrades = useMemo(() => {
    return result?.trades.filter((t) => {
      if (filter === 'all') return true;
      if (filter === 'closed') return t.status === 'closed' || t.status === 'partial';
      if (filter === 'open') return t.status === 'open' || t.status === 'buy_failed';
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
          {/* 统计卡片 - 第一行：核心数据 */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <StatCard
              label="已实现跟单收益 (SOL)"
              value={<SolAmount value={result.realizedPnl} signed />}
              tone={result.realizedPnl >= 0 ? 'success' : 'danger'}
            />
            <StatCard
              label="平仓率"
              value={`${result.buyCount > 0 ? ((result.closedCount / result.buyCount) * 100).toFixed(0) : '0'}%`}
              tone="default"
            />
            <StatCard label="买入笔数" value={result.buyCount} />
            <StatCard
              label="已平仓"
              value={<span className="text-success-500">{result.closedCount}</span>}
              tone={result.closedCount > 0 ? 'success' : 'default'}
            />
            <StatCard
              label="持仓中"
              value={<span className={result.openCount > 0 ? 'text-warning-500' : undefined}>{result.openCount}</span>}
              tone={result.openCount > 0 ? 'danger' : 'default'}
            />
            <StatCard label="失败手续费 (SOL)" value={<SolAmount value={result.failedFee} />} tone="danger" />
          </div>

          {/* 统计卡片 - 第二行：衍生指标 */}
          {extraStats && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard
                label="胜率"
                value={`${extraStats.winRate.toFixed(1)}%`}
                tone={extraStats.winRate >= 60 ? 'success' : extraStats.winRate < 40 ? 'danger' : 'default'}
              />
              <StatCard
                label="结案率"
                value={`${extraStats.coverageRate.toFixed(1)}%`}
                tone={extraStats.coverageRate >= 60 ? 'success' : extraStats.coverageRate < 40 ? 'danger' : 'default'}
              />
              <StatCard
                label="最大收益 (SOL)"
                value={<SolAmount value={extraStats.maxWin} signed />}
                tone={extraStats.maxWin > 0 ? 'success' : 'default'}
              />
              <StatCard
                label="最大亏损 (SOL)"
                value={<SolAmount value={extraStats.maxLoss} signed />}
                tone={extraStats.maxLoss < 0 ? 'danger' : 'default'}
              />
            </div>
          )}

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
                  onClick={() => { setFilter('closed'); setPage(1); }}
                  className={`px-3 py-1 rounded-xl text-xs ${
                    filter === 'closed' ? 'bg-success-500 text-white' : 'bg-slate-100 dark:bg-zinc-700 text-gray-500 dark:text-gray-400 hover:bg-slate-200 dark:hover:bg-zinc-600'
                  }`}
                >
                  已平仓 ({result.closedCount + result.partialCount})
                </button>
                <button
                  onClick={() => { setFilter('open'); setPage(1); }}
                  className={`px-3 py-1 rounded-xl text-xs ${
                    filter === 'open' ? 'bg-warning-500 text-white' : 'bg-slate-100 dark:bg-zinc-700 text-gray-500 dark:text-gray-400 hover:bg-slate-200 dark:hover:bg-zinc-600'
                  }`}
                >
                  持仓中 ({result.openCount + result.buyFailedCount})
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
                    <th className="px-3 py-2 text-right">优先级费 (SOL)</th>
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
                        <td className="px-3 py-2 text-right">
                          {t.pnl == null ? (
                            <span className="font-mono text-xs text-warning-500">未实现</span>
                          ) : (
                            <SolAmount value={t.pnl} signed />
                          )}
                        </td>
                        <td className="px-3 py-2 text-right"><SolAmount value={t.tip} /></td>
                        <td className="px-3 py-2 text-right"><PrioSolAmount value={t.prio} /></td>
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
                          {t.status === 'closed' ? (
                            <CheckLineIcon className="w-4 h-4 text-success-500 inline" />
                          ) : t.status === 'partial' ? (
                            <span className="text-xs text-brand-500">部分平仓 {(t.soldRatio * 100).toFixed(0)}%</span>
                          ) : t.status === 'buy_failed' ? (
                            <CloseLineIcon className="w-4 h-4 text-error-500 inline" />
                          ) : (
                            <span className="text-xs text-warning-500">持仓中</span>
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

function StatCard({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'default' | 'brand' | 'success' | 'danger';
}) {
  const toneClass = {
    default: 'bg-white dark:bg-zinc-800 border-gray-200 dark:border-gray-700',
    brand: 'bg-brand-50 dark:bg-brand-500/10 border-brand-200 dark:border-brand-500/30',
    success: 'bg-success-50 dark:bg-success-500/10 border-success-200 dark:border-success-500/30',
    danger: 'bg-error-50 dark:bg-error-500/10 border-error-200 dark:border-error-500/30',
  }[tone];
  return (
    <div className={`rounded-lg border p-3 shadow-sm ${toneClass}`}>
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className="text-lg font-semibold mt-0.5 text-gray-800 dark:text-white/90">{value}</div>
    </div>
  );
}
