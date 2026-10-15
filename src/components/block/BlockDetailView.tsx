"use client";
import React, { useEffect, useState } from "react";
import AddressCopy from "@/components/common/AddressCopy";
import SolAmount from "@/components/common/SolAmount";
import PrioSolAmount from "@/components/common/PrioSolAmount";
import RelativeTime from "@/components/common/RelativeTime";
import { useConfirm } from "@/components/ui/confirm-dialog";

interface BlockDetailViewProps {
  slot: number;
  mint: string;
}

interface Buyer {
  id: number;
  block_index: number;
  offset_pos: number | null;
  offset_ms: number | null;
  slot_offset: number;
  signature: string;
  address: string;
  buy_sol: string;
  tip_sol: string | null;
  prio_lamports: number | null;
  pnl_sol: string | null;
  pnl_status: string | null;
  pnl_sold_ratio: string | null;
  token_amount: string | null;
  is_first_sniper: boolean;
  is_follower: boolean;
  is_own: boolean;
  is_pre_target: boolean;
  /** 目标本人（= 跟单目标的那个地址） */
  is_self: boolean;
  result: string;
  version: string;
  is_bundled: boolean;
  has_alt: boolean | null;
  bundle_id: string | null;
  bundle_size: number | null;
  tip_source: import('@/lib/types').TipSource | null;
  /** 0021: 狙击者竞争态势 */
  mine_rank: number | null;
  sniper_slot_delta: number | null;
  competitor_rank: number | null;
}

interface Analysis {
  id: number;
  slot: number;
  mint: string;
  target_signature: string;
  target_address?: string;
  target_buy_sol?: string;
  block_time: string;
  target_block_index: number | null;
  same_slot_count: number;
  next_slot_count: number;
  /** 0021: 狙击者竞争态势（块级） */
  competitor_count: number | null;
  chosen_address: string | null;
  competitor_rank: Record<string, number> | null;
}

export default function BlockDetailView({ slot, mint }: BlockDetailViewProps) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recalculating, setRecalculating] = useState(false);
  const [bulkPnl, setBulkPnl] = useState<{
    running: boolean;
    lastSummary: { computed: number; skipped: number; errors: number } | null;
  }>({ running: false, lastSummary: null });
  const { confirm, alert } = useConfirm();

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/block/${slot}/${mint}`);
      const json = await res.json();
      if (!json.ok) {
        setError(json.error || '未找到该 block 分析');
        return;
      }
      setAnalysis(json.data.analysis);
      setBuyers(json.data.buyers);
    } catch (err: any) {
      setError(`网络错误: ${err?.message || String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [slot, mint]);

  const recalc = async () => {
    setRecalculating(true);
    try {
      await fetch('/api/analyze/block', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot, mint, targetSig: analysis?.target_signature }),
      });
      await load();
    } finally {
      setRecalculating(false);
    }
  };

  const runBulkPnl = async (force = false) => {
    setBulkPnl((s) => ({ ...s, running: true }));
    try {
      const res = await fetch(`/api/block/${slot}/${mint}/pnl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      });
      const json = await res.json();
      if (!json.ok) {
        await alert({ title: '批量算收益失败', description: json.error, variant: 'danger' });
        setBulkPnl((s) => ({ ...s, running: false }));
        return;
      }
      const results: Array<{ buyerId: number; pnlSol: number | null; status: string; soldRatio: number | null }> = json.results ?? [];
      const byId = new Map(results.map((r) => [r.buyerId, r]));
      const errors = results.filter((r) => r.status === 'error').length;
      setBuyers((prev) =>
        prev.map((b) => {
          const r = byId.get(b.id);
          if (!r) return b;
          return {
            ...b,
            pnl_sol: r.pnlSol !== null ? String(r.pnlSol) : null,
            pnl_status: r.status === 'error' ? null : r.status,
            pnl_sold_ratio: r.soldRatio != null ? String(r.soldRatio) : null,
          };
        }),
      );
      setBulkPnl({ running: false, lastSummary: { computed: json.computed, skipped: json.skipped, errors } });
      if (errors > 0) {
        await alert({ title: '批量算收益完成（有错误）', description: `算 ${json.computed} · 跳 ${json.skipped} · 失败 ${errors}`, variant: 'warning' });
      }
    } catch (err: any) {
      await alert({ title: '批量算收益失败', description: err?.message ?? String(err), variant: 'danger' });
      setBulkPnl((s) => ({ ...s, running: false }));
    }
  };

  const setAsCopyTrader = async (address: string) => {
    await fetch('/api/wallets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, label: `from block ${slot}` }),
    });
    await alert({ title: '已加入跟单库', description: `${address.slice(0, 8)}... 已标记为跟单钱包`, variant: 'success' });
    await load();
  };

  const calcBuyerPnL = async (buyerId: number) => {
    const res = await fetch(`/api/block/${slot}/${mint}/buyer/${buyerId}/pnl`, { method: 'POST' });
    const json = await res.json();
    if (!json.ok) { await alert({ title: '算收益失败', description: json.error, variant: 'danger' }); return; }
    setBuyers((prev) =>
      prev.map((b) =>
        b.id === buyerId
          ? { ...b, pnl_sol: json.pnl_sol !== null ? String(json.pnl_sol) : null, pnl_status: json.pnl_status ?? null, pnl_sold_ratio: json.sold_ratio != null ? String(json.sold_ratio) : null }
          : b,
      ),
    );
  };

  const clearBuyerPnL = async (buyerId: number) => {
    const res = await fetch(`/api/block/${slot}/${mint}/buyer/${buyerId}/pnl`, { method: 'DELETE' });
    if (res.ok) {
      setBuyers((prev) =>
        prev.map((b) => b.id === buyerId ? { ...b, pnl_sol: null, pnl_status: null, pnl_sold_ratio: null } : b),
      );
    }
  };

  const unclaimWallet = async (buyerId: number, address: string) => {
    const ok = await confirm({
      title: '取消「我的账号」认定？',
      description: (
        <>
          将 <span className="font-mono">{address.slice(0, 6)}…{address.slice(-4)}</span>{' '}
          从自己的钱包列表移除，并重跑该 block 的分析。此操作不可撤销。
        </>
      ),
      confirmText: '取消认定',
      variant: 'warning',
    });
    if (!ok) return;
    setRecalculating(true);
    try {
      await fetch(`/api/wallets?address=${encodeURIComponent(address)}`, { method: 'DELETE' });
      await fetch('/api/analyze/block', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot, mint, targetSig: analysis?.target_signature }),
      });
      await load();
    } finally {
      setRecalculating(false);
    }
  };

  if (loading) return <div className="p-6 text-center text-gray-500 dark:text-gray-400">加载中...</div>;
  if (error) return <div className="p-6 text-center text-error-500">{error}</div>;
  if (!analysis) return null;

  // 分组：同 slot 在前，下一 slot 在后
  const sameSlot = buyers.filter((b) => b.slot_offset === 0);
  const nextSlot = buyers.filter((b) => b.slot_offset === 1);
  const totalCount = buyers.length;

  // 参考页 badge 颜色
  const badge = (cls: string) => cls;

  // 角色判定（参考页优先级：我的账号 > 第一个狙击者 > 捆绑 > 前置 > 跟随）
  // 注：目标本人已在 API 层过滤掉，此处不再需要 is_self 分支
  const roleTag = (b: Buyer) => {
    if (b.is_own) return <span className="inline-block px-1.5 py-0.5 rounded text-xs bg-success-500/20 text-success-700 dark:text-success-400">我的账号</span>;
    if (b.is_first_sniper) return <span className="inline-block px-1.5 py-0.5 rounded text-xs bg-purple-500/20 text-purple-700 dark:text-purple-400">第一个狙击者</span>;
    if (b.is_bundled) return <span className="inline-block px-1.5 py-0.5 rounded text-xs bg-amber-500/20 text-amber-700 dark:text-amber-400">捆绑</span>;
    if (b.is_pre_target) return <span className="inline-block px-1.5 py-0.5 rounded text-xs bg-gray-500/20 text-gray-600 dark:text-gray-400">前置</span>;
    return <span className="inline-block px-1.5 py-0.5 rounded text-xs bg-blue-500/20 text-blue-700 dark:text-blue-400">跟随</span>;
  };

  // 偏移列颜色：正值 dim（失败）
  const offsetClass = (b: Buyer) => {
    if (b.slot_offset === 1) return 'text-purple-500';
    if (b.offset_pos === null) return 'text-gray-500 dark:text-gray-400';
    if (b.offset_pos > 0) return 'text-gray-400 dark:text-gray-500';
    if (b.offset_pos < 0) return 'text-success-600 dark:text-success-400';
    return 'text-gray-500 dark:text-gray-400';
  };

  // 渲染一行 buyer
  // 注：目标本人已在 API 层过滤（isTarget 永远为 false），这里也保留以防
  // 将来再次打开「展示目标本人」时无需再改模板。
  const buyerRow = (b: Buyer, isTarget: boolean) => (
    <tr
      key={b.id}
      className={`border-b border-gray-100 dark:border-gray-700/50 ${
        isTarget
          ? 'bg-brand-50 dark:bg-brand-500/10'
          : b.is_first_sniper
            ? 'bg-red-50 dark:bg-red-500/10'
            : b.is_own
              ? 'bg-success-50 dark:bg-success-500/10'
              : ''
      }`}
    >
      {/* 块内序号 */}
      <td className="px-3 py-2 font-mono text-xs text-gray-800 dark:text-white/90">
        {b.block_index + 1}
        {b.slot_offset === 1 && <span className="ml-1 text-purple-500 text-[10px]" title="下一 slot">+1槽</span>}
      </td>
      {/* 偏移 */}
      <td className={`px-3 py-2 text-right font-mono text-xs ${offsetClass(b)}`}>
        {b.slot_offset === 1
          ? 'slot+1'
          : b.offset_pos === null
            ? '0'
            : b.offset_pos > 0
              ? `+${b.offset_pos}`
              : b.offset_pos}
      </td>
      {/* slot 差（-1/0/+1） */}
      <td className="px-3 py-2 text-center">
        {b.sniper_slot_delta != null ? (
          <span className={`font-mono text-xs ${
            b.sniper_slot_delta === -1 ? 'text-blue-400' :
            b.sniper_slot_delta === 0 ? 'text-gray-400' : 'text-purple-400'
          }`}>
            {b.sniper_slot_delta === -1 ? '前' :
             b.sniper_slot_delta === 0 ? '同' : `+${b.sniper_slot_delta}`}
          </span>
        ) : <span className="text-gray-500">—</span>}
      </td>
      {/* 竞争排名 */}
      <td className="px-3 py-2 text-center">
        {b.competitor_rank != null ? (
          <span className={`inline-block min-w-[24px] text-center font-mono text-xs rounded px-1 ${
            b.competitor_rank === 1 ? 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 font-bold' :
            b.competitor_rank <= 3 ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300' :
            'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
          }`}>
            #{b.competitor_rank}
          </span>
        ) : <span className="text-gray-400">—</span>}
      </td>
      {/* 角色 */}
      <td className="px-3 py-2">{roleTag(b)}</td>
      <td className="px-3 py-2">
        <AddressCopy address={b.address} length={6} />
      </td>
      <td className="px-3 py-2 text-right">
        <span className="font-mono text-xs text-gray-700 dark:text-gray-300">
          {b.buy_sol != null ? parseFloat(b.buy_sol).toFixed(4) : '-'}
        </span>
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs text-amber-600 dark:text-amber-400 font-semibold">
        {b.tip_sol != null ? Number(b.tip_sol).toFixed(6) : '0'}
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs text-purple-600 dark:text-purple-400 font-semibold"
        title={b.prio_lamports != null ? `由 ComputeBudget 算出优先费：${(Number(b.prio_lamports) / 1e9).toFixed(6)} SOL` : undefined}
      >
        {b.prio_lamports != null ? (Number(b.prio_lamports) / 1e9).toFixed(6) : '0'}
      </td>
      <td className="px-3 py-2 text-right">
        {b.pnl_status === 'open' ? (
          <span className="font-mono text-xs text-warning-500" title="持仓中，浮盈未实现">持仓中</span>
        ) : b.pnl_status === 'buy_failed' ? (
          <span className="font-mono text-xs text-error-500" title="买入交易失败">买入失败</span>
        ) : b.pnl_sol != null ? (
          <span className={`font-mono text-xs ${
            parseFloat(b.pnl_sol) > 0 ? 'text-success-500' : parseFloat(b.pnl_sol) < 0 ? 'text-error-500' : 'text-gray-400'
          }`}>
            {parseFloat(b.pnl_sol) >= 0 ? '+' : ''}{parseFloat(b.pnl_sol).toFixed(4)}
            {b.pnl_status === 'partial' && b.pnl_sold_ratio && (
              <span className="ml-1 text-[10px] text-brand-500" title={`已卖出 ${(parseFloat(b.pnl_sold_ratio) * 100).toFixed(0)}%`}>
                {(parseFloat(b.pnl_sold_ratio) * 100).toFixed(0)}%
              </span>
            )}
          </span>
        ) : (
          <span className="font-mono text-xs text-gray-400">-</span>
        )}
      </td>
      <td className="px-3 py-2 text-center">
        {b.result === 'success' ? (
          <span className="inline-block px-1.5 py-0.5 rounded text-xs bg-success-500/20 text-success-700 dark:text-success-400">成功</span>
        ) : (
          <span className="inline-block px-1.5 py-0.5 rounded text-xs bg-red-500/20 text-red-700 dark:text-red-400">失败</span>
        )}
      </td>
      <td className="px-3 py-2 text-center text-xs text-gray-500 dark:text-gray-400">{b.version || '-'}</td>
      <td className="px-3 py-2 text-center">
        <a
          href={`https://solscan.io/tx/${b.signature}`}
          target="_blank"
          rel="noreferrer"
          className="text-brand-500 hover:underline text-xs"
          title="solscan 查看这笔交易"
        >
          ↗
        </a>
      </td>
      <td className="px-3 py-2 text-center">
        <div className="flex items-center justify-center gap-1 text-xs flex-wrap">
          {/* isTarget 永远为 false（目标本人已在 API 层过滤），保留条件仅为防御 */}
          {isTarget ? (
            <span className="text-gray-400">—</span>
          ) : b.is_own ? (
            <button
              onClick={() => unclaimWallet(b.id, b.address)}
              disabled={recalculating}
              className="text-warning-600 dark:text-warning-400 hover:text-error-500 disabled:opacity-50 text-xs"
            >
              取消认定
            </button>
          ) : (
            <>
              {!b.pnl_status ? (
                <button onClick={() => calcBuyerPnL(b.id)} className="text-gray-500 dark:text-gray-400 hover:text-brand-500 text-xs">算收益</button>
              ) : (
                <>
                  <button onClick={() => calcBuyerPnL(b.id)} className="text-gray-500 dark:text-gray-400 hover:text-brand-500 text-xs">重算</button>
                  <button onClick={() => clearBuyerPnL(b.id)} className="text-gray-500 dark:text-gray-400 hover:text-error-500 text-xs">取消算</button>
                </>
              )}
              <button onClick={() => setAsCopyTrader(b.address)} className="text-gray-500 dark:text-gray-400 hover:text-success-500 text-xs">设为跟单者</button>
            </>
          )}
        </div>
      </td>
    </tr>
  );

  // 0021: 竞争态势
  const competitorCount = analysis.competitor_count ?? 0;
  const chosenShort = analysis.chosen_address
    ? `${analysis.chosen_address.slice(0, 6)}…${analysis.chosen_address.slice(-4)}`
    : null;
  const myRank = buyers.find((b) => b.is_own && b.mine_rank != null)?.mine_rank ?? null;
  const firstSniperRank = buyers.find((b) => b.is_first_sniper)?.competitor_rank ?? null;

  return (
    <div className="space-y-3">
      {/* 参考页风格：单行摘要头 */}
      <div className="text-xs text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-zinc-700/50 rounded-lg px-3 py-2">
        目标 <span className="font-mono font-semibold">{analysis.target_address ? `${analysis.target_address.slice(0, 8)}…${analysis.target_address.slice(-4)}` : `${analysis.target_signature.slice(0, 8)}…${analysis.target_signature.slice(-4)}`}</span>{' '}
        在 slot <span className="font-mono font-semibold">{analysis.slot}</span>{' '}
        （块内第 <span className="font-mono font-semibold">{analysis.target_block_index !== null ? analysis.target_block_index + 1 : '?'}</span> 笔）买入{' '}
        {analysis.target_buy_sol != null && (
          <span className="font-mono font-semibold">{parseFloat(analysis.target_buy_sol).toFixed(4)} SOL</span>
        )}{' '}
        <a href={`https://solscan.io/block/${analysis.slot}`} target="_blank" rel="noreferrer" className="text-brand-500 hover:underline ml-1">solscan ↗</a>
        {' — '}
        同一个 slot 里 <span className="font-semibold text-gray-800 dark:text-white/90">{sameSlot.length}</span> 笔，
        下一个 slot 里 <span className="font-semibold text-gray-800 dark:text-white/90">{nextSlot.length}</span> 笔，
        共 <span className="font-semibold text-gray-800 dark:text-white/90">{totalCount}</span> 笔（含失败的）
        <span className="ml-2 text-gray-400">时间: <RelativeTime iso={analysis.block_time} /></span>

        {/* 0021: 狙击者竞争态势徽章 */}
        {competitorCount > 0 && (
          <>
            <span className="ml-3 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-300 font-medium">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
              {competitorCount} snipers
              {firstSniperRank != null && <span className="font-mono">· #1</span>}
              {chosenShort && <span className="ml-1 font-mono">{chosenShort}</span>}
            </span>
            {myRank != null && (
              <span className={`ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${
                myRank <= 3
                  ? 'bg-success-100 dark:bg-success-900/40 text-success-700 dark:text-success-300'
                  : myRank <= 7
                    ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-500'
              }`}>
                I&apos;m rank {myRank}
              </span>
            )}
          </>
        )}
        {competitorCount === 0 && (
          <span className="ml-3 text-gray-400">无竞争狙击者</span>
        )}
      </div>

      {/* 操作栏 */}
      <div className="flex items-center gap-2 flex-wrap">
        {bulkPnl.running && (
          <span className="text-xs text-brand-600 dark:text-brand-400 inline-flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
            批量算收益中…
          </span>
        )}
        {!bulkPnl.running && bulkPnl.lastSummary && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            上次: 算 {bulkPnl.lastSummary.computed} · 跳 {bulkPnl.lastSummary.skipped}
            {bulkPnl.lastSummary.errors > 0 && <span className="text-error-500 ml-1">· 失败 {bulkPnl.lastSummary.errors}</span>}
          </span>
        )}
        <button
          onClick={() => runBulkPnl(false)}
          disabled={bulkPnl.running || recalculating}
          className="text-xs px-3 py-1 rounded-lg bg-brand-500/10 text-brand-700 dark:text-brand-400 hover:bg-brand-500/20 disabled:opacity-50"
        >
          批量算收益
        </button>
        <button
          onClick={() => runBulkPnl(true)}
          disabled={bulkPnl.running || recalculating}
          className="text-xs px-3 py-1 rounded-lg bg-slate-100 dark:bg-zinc-700 hover:bg-slate-200 dark:hover:bg-zinc-600 text-gray-600 dark:text-gray-300 disabled:opacity-50"
        >
          重算全部
        </button>
        <button
          onClick={recalc}
          disabled={recalculating || bulkPnl.running}
          className="text-xs px-3 py-1 rounded-lg bg-slate-100 dark:bg-zinc-700 hover:bg-slate-200 dark:hover:bg-zinc-600 text-gray-600 dark:text-gray-300 disabled:opacity-50"
        >
          {recalculating ? '分析中…' : '重分析'}
        </button>
      </div>

      {/* 表格 */}
      <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-zinc-700/50 text-xs text-gray-500 dark:text-gray-400">
            <tr>
              <th className="px-3 py-2 text-left">#</th>
              <th className="px-3 py-2 text-right">偏</th>
              <th className="px-3 py-2 text-left">slot差</th>
              <th className="px-3 py-2 text-left">竞排名</th>
              <th className="px-3 py-2 text-left">角色</th>
              <th className="px-3 py-2 text-left">地址</th>
              <th className="px-3 py-2 text-right">SOL</th>
              <th className="px-3 py-2 text-right">tip</th>
              <th className="px-3 py-2 text-right">优先费</th>
              <th className="px-3 py-2 text-right">收益</th>
              <th className="px-3 py-2 text-center">结果</th>
              <th className="px-3 py-2 text-center">版本</th>
              <th className="px-3 py-2 text-center">tx</th>
              <th className="px-3 py-2 text-center">操作</th>
            </tr>
          </thead>
          <tbody>
            {/* 同 slot 分组 */}
            {sameSlot.map((b) => buyerRow(b, b.signature === analysis.target_signature))}
            {/* 下一 slot 分组 */}
            {nextSlot.length > 0 && (
              <>
                {/* 分组分隔行 */}
                <tr>
                  <td colSpan={14} className="px-3 py-1 text-[10px] text-purple-500 font-semibold bg-purple-50 dark:bg-purple-500/10 border-t border-gray-200 dark:border-gray-700">
                    ▼ 下一个 slot（{nextSlot.length} 笔）
                  </td>
                </tr>
                {nextSlot.map((b) => buyerRow(b, b.signature === analysis.target_signature))}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
