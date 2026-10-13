"use client";
import React, { useState, useEffect } from "react";
import AddressCopy from "@/components/common/AddressCopy";
import SolAmount from "@/components/common/SolAmount";
import RelativeTime from "@/components/common/RelativeTime";
import { ChevronDownIcon, ChevronUpIcon } from "@/icons";
import BlockDetailView from "@/components/block/BlockDetailView";

interface Target {
  id: number;
  address: string;
  label: string | null;
  threshold_sol: string;
  status: 'active' | 'paused';
  record_count: number;
  last_buy_at: string | null;
  updated_at: string;
  auto_follow: boolean;
  last_sniper?: {
    address: string;
    signature: string;
    offset_pos: number | null;
    offset_ms: number | null;
    tip_sol: string | null;
    prio_lamports: number | null;
    buy_sol: string | null;
    tip_source: import('@/lib/types').TipSource | null;
    slot: number;
    mint: string;
    block_time: string;
    pnl_sol?: string | null;
  } | null;
}

interface Trade {
  id: number;
  signature: string;
  slot: number;
  block_time: string;
  mint: string;
  buy_sol: string;
  target_tip_sol: string | null;
  target_prio_lamports: number | null;
  is_bundled: boolean;
  has_alt: boolean | null;
  bundle_id: string | null;
  bundle_size: number | null;
  tip_source: import('@/lib/types').TipSource | null;
  first_sniper: string | null;
  first_sniper_buy_sol: string | null;
  first_sniper_tip_sol: string | null;
  first_sniper_prio_lamports: number | null;
  first_sniper_tip_source?: import('@/lib/types').TipSource | null;
  first_sniper_signature: string | null;
  first_sniper_offset_pos: number | null;
  first_sniper_offset_ms: number | null;
  pnl_sol?: string | null;
  status: string;
  first_sniper_slot?: number | null;
  first_sniper_buyer_signature?: string | null;
  my_block_index?: number | null;
  my_tip_sol?: string | null;
  my_prio_lamports?: number | null;
  my_signature?: string | null;
  my_result?: string | null;
  same_slot_count?: number | null;
  next_slot_count?: number | null;
  // 手动认定的跟单者
  chosen_address?: string | null;
  chosen_txid?: string | null;
  // dev 单标记（create + buy 同 tx）
  is_dev_buy?: boolean;
}

interface Props {
  target: Target;
  onPause: (id: number) => void;
  onResume: (id: number) => void;
  onDelete: (t: Target) => void;
  onClear: (t: Target) => void;
  onThresholdChange: (id: number, val: number) => void;
  onToggleAutoFollow: (id: number, on: boolean) => void;
  firstOnly?: boolean;
  decision?: {
    worth_score: number | null;
    win_rate: number;
    avg_pnl_sol: number;
    p50_tip_sol: number | null;
    p50_prio_lamports: number | null;
    p75_tip_sol: number | null;
    p75_prio_lamports: number | null;
    success_count: number;
    failed_count: number;
    sample_size: number;
  };
}

export default function TargetRow({ target, onPause, onResume, onDelete, onClear, onThresholdChange, onToggleAutoFollow, firstOnly = true, decision }: Props) {
  const [expanded, setExpanded] = useState(false);
  // 记录当前展开的 trade id（null = 全部收起）
  const [expandedTradeId, setExpandedTradeId] = useState<number | null>(null);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [loadingTrades, setLoadingTrades] = useState(false);
  const [editingThreshold, setEditingThreshold] = useState(false);
  const [thresholdVal, setThresholdVal] = useState(target.threshold_sol);

  useEffect(() => {
    setThresholdVal(target.threshold_sol);
  }, [target.threshold_sol]);

  // 收起目标时同步收起 trade 行
  useEffect(() => {
    if (!expanded) setExpandedTradeId(null);
  }, [expanded]);

  // firstOnly 切换时清空并重新加载交易列表
  useEffect(() => {
    if (expanded) {
      setTrades(null);
      setExpandedTradeId(null);
      loadTrades();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstOnly]);

  const loadTrades = async (): Promise<boolean> => {
    if (trades !== null) return true;
    setLoadingTrades(true);
    try {
      const res = await fetch(`/api/transactions?target_id=${target.id}&limit=20&first_only=${firstOnly ? 1 : 0}`);
      const json = await res.json();
      if (json.ok) {
        setTrades(json.data);
        return true;
      }
      return false;
    } catch (err) {
      console.error(err);
      return false;
    } finally {
      setLoadingTrades(false);
    }
  };

  const toggleExpand = async () => {
    if (!expanded) {
      await loadTrades();
    }
    setExpanded(!expanded);
  };

  // 手风琴：点击 trade 行时展开/收起内嵌的 BlockDetailView
  const toggleTradeExpand = (tradeId: number) => {
    setExpandedTradeId((prev) => (prev === tradeId ? null : tradeId));
  };

  const handleSaveThreshold = async () => {
    const n = parseFloat(thresholdVal);
    if (Number.isNaN(n) || n < 0) return;
    await onThresholdChange(target.id, n);
    setEditingThreshold(false);
  };

  // 时间格式：MM-DD HH:mm:ss（参考页格式）
  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  const latest = trades?.[0];

  // 优先用 last_sniper（最近有狙击者的那笔），不是「最新那笔」
  const sniper = target.last_sniper
    ? {
        first_sniper: target.last_sniper.address,
        first_sniper_signature: target.last_sniper.signature,
        first_sniper_offset_pos: target.last_sniper.offset_pos,
        first_sniper_tip_sol: target.last_sniper.tip_sol,
        first_sniper_prio_lamports: target.last_sniper.prio_lamports,
        pnl_sol: target.last_sniper.pnl_sol,
        slot: target.last_sniper.slot,
        mint: target.last_sniper.mint,
        block_time: target.last_sniper.block_time,
      }
    : latest;

  const sniperFailed = !!sniper && (!sniper.first_sniper || sniper.first_sniper_offset_pos === null);
  const sniperOffset = sniper?.first_sniper_offset_pos !== null && sniper?.first_sniper_offset_pos !== undefined
    ? Math.abs(sniper.first_sniper_offset_pos)
    : 0;

  return (
    <>
      {/* ===== 第1层：监控目标主行 ===== */}
      <tr className="border-b border-gray-100 dark:border-gray-700 hover:bg-blue-50/60 dark:hover:bg-brand-500/10 transition-colors">
        {/* 监控目标 */}
        <td className="px-3 py-3 w-44">
          <div className="flex items-center gap-2 min-w-0">
            <button onClick={toggleExpand} className="text-gray-400 dark:text-gray-500 hover:text-brand-500 shrink-0 transition-colors">
              {expanded ? <ChevronUpIcon className="w-4 h-4" /> : <ChevronDownIcon className="w-4 h-4" />}
            </button>
            <AddressCopy address={target.address} />
            {target.label && !target.label.startsWith('pool:') && !target.label.startsWith('auto:') && (
              <span className="text-xs text-gray-400 dark:text-gray-500 truncate">{target.label}</span>
            )}
          </div>
        </td>

        {/* 状态 */}
        <td className="px-3 py-3 text-center">
          {target.status === 'active' ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/30">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              监控中
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-zinc-700 dark:text-gray-300 border border-gray-200 dark:border-zinc-600">
              已暂停
            </span>
          )}
        </td>

        {/* 自动跟单 */}
        <td className="px-3 py-3 text-center" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => onToggleAutoFollow(target.id, !target.auto_follow)}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border transition-colors ${
              target.auto_follow
                ? 'border-emerald-400/50 text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 hover:bg-emerald-100 dark:hover:bg-emerald-500/20'
                : 'border-gray-200 dark:border-gray-600 text-gray-400 dark:text-gray-500 hover:bg-slate-100 dark:hover:bg-zinc-700'
            }`}
            title="勾选后，trading_agent 的跟单 agent 才会自动决策这个目标"
          >
            {target.auto_follow
              ? <><span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />自动</>
              : '手动'}
          </button>
        </td>

        {/* 记录数 */}
        <td className="px-3 py-3 text-center">
          <span className="font-mono text-sm font-semibold tabular-nums text-brand-600 dark:text-brand-400">
            {target.record_count}
          </span>
        </td>

        {/* 最新buy时间 */}
        <td className="px-3 py-3">
          <span className="text-xs font-mono text-gray-500 dark:text-gray-400 tabular-nums">
            {target.last_buy_at ? fmtTime(target.last_buy_at) : '-'}
          </span>
        </td>

        {/* 距现在 */}
        <td className="px-3 py-3">
          <RelativeTime iso={target.last_buy_at} />
        </td>

        {/* 狙击者 */}
        <td className="px-3 py-3 min-w-[260px]">
          <div
            role="button"
            tabIndex={0}
            onClick={toggleExpand}
            onKeyDown={(e) => e.key === 'Enter' && toggleExpand()}
            className={`flex flex-nowrap items-center gap-x-2 text-xs rounded-lg px-2 py-1.5 -mx-2 transition-colors cursor-pointer hover:bg-slate-100 dark:hover:bg-zinc-700 whitespace-nowrap ${
              expanded ? 'bg-slate-100 dark:bg-zinc-700 ring-1 ring-slate-300 dark:ring-zinc-600' : ''
            }`}
            title="点击展开该目标的交易列表"
          >
            {sniper?.first_sniper ? (
              <AddressCopy address={sniper.first_sniper} length={4} />
            ) : (
              <span className="font-mono text-gray-400">—</span>
            )}
            {sniper?.first_sniper && (
              <span
                className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0 ${
                  sniperFailed
                    ? 'bg-red-500/15 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-500/30'
                    : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/30'
                }`}
              >
                {sniperFailed ? '失败' : '抢到'} +{sniperOffset}
              </span>
            )}
            {(latest?.next_slot_count ?? 0) > 0 && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] bg-slate-100 dark:bg-zinc-600 text-gray-500 dark:text-gray-300 font-medium shrink-0">
                下slot <span className="font-mono font-semibold">{latest!.next_slot_count}</span>
              </span>
            )}
          </div>
        </td>

        {/* 狙击 tip（第2列） */}
        <td className="px-3 py-3 text-right">
          <span className="font-mono text-xs text-amber-600 dark:text-amber-400 font-semibold tabular-nums">
            {sniper?.first_sniper_tip_sol != null
              ? Number(sniper.first_sniper_tip_sol).toFixed(6)
              : <span className="text-gray-300 dark:text-gray-600">—</span>}
          </span>
        </td>

        {/* 狙击 prio（第3列） */}
        <td className="px-3 py-3 text-right">
          <span className="font-mono text-xs text-purple-600 dark:text-purple-400 font-semibold tabular-nums">
            {sniper?.first_sniper_prio_lamports != null
              ? (Number(sniper.first_sniper_prio_lamports) / 1e9).toFixed(6)
              : <span className="text-gray-300 dark:text-gray-600">—</span>}
          </span>
        </td>

        {/* 收益（第4列） */}
        <td className="px-3 py-3 text-right">
          <span className={`text-xs font-mono font-semibold tabular-nums ${
            sniper?.pnl_sol != null
              ? parseFloat(sniper.pnl_sol) > 0
                ? 'text-emerald-500'
                : parseFloat(sniper.pnl_sol) < 0
                  ? 'text-red-500'
                  : 'text-gray-400'
              : 'text-gray-400'
          }`}>
            {sniper?.pnl_sol != null
              ? `${parseFloat(sniper.pnl_sol) >= 0 ? '+' : ''}${parseFloat(sniper.pnl_sol).toFixed(4)}`
              : '—'}
          </span>
        </td>

        {/* 操作 */}
        <td className="px-3 py-3 text-center w-52">
          <div className="flex items-center justify-center gap-0 text-xs flex-nowrap whitespace-nowrap text-gray-400 dark:text-gray-500">
            <button onClick={toggleExpand} className="px-1.5 py-0.5 rounded-md text-gray-500 dark:text-gray-400 hover:text-brand-500 hover:bg-brand-50 dark:hover:bg-brand-500/10 transition-colors">{expanded ? '收起' : '详情'}</button>
            <span className="select-none">|</span>
            <button
              onClick={() => {
                setThresholdVal(target.threshold_sol);
                setEditingThreshold(true);
              }}
              className="px-1.5 py-0.5 rounded-md text-gray-500 dark:text-gray-400 hover:text-brand-500 hover:bg-brand-50 dark:hover:bg-brand-500/10 transition-colors"
            >阈值</button>
            <span className="select-none">|</span>
            {target.status === 'active' ? (
              <button onClick={() => onPause(target.id)} className="px-1.5 py-0.5 rounded-md text-gray-500 dark:text-gray-400 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-500/10 transition-colors">暂停</button>
            ) : (
              <button onClick={() => onResume(target.id)} className="px-1.5 py-0.5 rounded-md text-gray-500 dark:text-gray-400 hover:text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition-colors">继续</button>
            )}
            <span className="select-none">|</span>
            <button onClick={() => onClear(target)} className="px-1.5 py-0.5 rounded-md text-gray-500 dark:text-gray-400 hover:text-brand-500 hover:bg-brand-50 dark:hover:bg-brand-500/10 transition-colors">清记录</button>
            <span className="select-none">|</span>
            <button onClick={() => onDelete(target)} className="px-1.5 py-0.5 rounded-md text-gray-400 dark:text-gray-500 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors">删除</button>
          </div>
        </td>
      </tr>

      {/* 阈值编辑浮层（参考页用 prompt，这里用 inline input 替代） */}
      {editingThreshold && (
        <tr className="bg-blue-50/80 dark:bg-blue-500/10">
          <td colSpan={11} className="px-3 py-2.5">
            <div className="flex items-center gap-3 text-sm">
              <span className="text-gray-500 dark:text-gray-300 font-medium">阈值 (SOL)：</span>
              <input
                type="number"
                step="0.1"
                min="0"
                value={thresholdVal}
                onChange={(e) => setThresholdVal(e.target.value)}
                className="w-20 h-7 px-2 text-xs rounded-lg border border-blue-300 dark:border-blue-500/50 bg-white dark:bg-zinc-700 text-gray-800 dark:text-white/90 focus:outline-none focus:ring-2 focus:ring-blue-400 transition-shadow"
                autoFocus
              />
              <button onClick={handleSaveThreshold} className="h-7 px-3 text-xs font-medium rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors">保存</button>
              <button onClick={() => { setEditingThreshold(false); setThresholdVal(target.threshold_sol); }} className="h-7 px-2 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors">取消</button>
            </div>
          </td>
        </tr>
      )}

      {/* ===== 第2层：买入交易列表 ===== */}
      {expanded && (
        <tr>
          <td colSpan={12} className="bg-slate-50/70 dark:bg-zinc-700/20 px-6 py-4">
            {loadingTrades ? (
              <div className="flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500 py-4">
                <span className="w-4 h-4 rounded-full border-2 border-current animate-spin" style={{ borderTopColor: 'transparent' }} />
                加载中...
              </div>
            ) : !trades || trades.length === 0 ? (
              <div className="text-xs text-gray-400 dark:text-gray-500 py-4 italic">
                暂无 buy 记录（阈值 {parseFloat(target.threshold_sol).toFixed(4)} SOL）
              </div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 dark:bg-zinc-700/50 text-gray-500 dark:text-gray-400">
                    <tr className="border-b border-gray-200 dark:border-gray-700">
                      {/* 时间 / mint / slot / 买入SOL / 第一个狙击者 / 狙击tip / 狙击prio / 跟单收益 / 买家 / 我的排位 / 我的tip / 我的prio */}
                      <th className="py-2 px-2 text-left font-medium">时间</th>
                      <th className="py-2 px-2 text-left font-medium">mint</th>
                      <th className="py-2 px-2 text-left font-medium">slot</th>
                      <th className="py-2 px-2 text-right font-medium">买入SOL</th>
                      <th className="py-2 px-2 text-left font-medium">第一个狙击者</th>
                      <th className="py-2 px-2 text-right font-medium">tip</th>
                      <th className="py-2 px-2 text-right font-medium">prio</th>
                      <th className="py-2 px-2 text-right font-medium">跟单收益</th>
                      <th className="py-2 px-2 text-right font-medium" title="同 slot + 下一 slot 买这个 token 的总笔数">买家</th>
                      <th className="py-2 px-2 text-center font-medium" title="在所有跟这个目标的人里，我是第几个跟上的">我的排位</th>
                      <th className="py-2 px-2 text-right font-medium" title="我的 tip">我的tip</th>
                      <th className="py-2 px-2 text-right font-medium" title="我的 prio">我的prio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t, i) => {
                      const snFailed = !t.first_sniper || t.first_sniper_offset_pos === null;
                      const snOffset = t.first_sniper_offset_pos != null
                        ? Math.abs(t.first_sniper_offset_pos)
                        : 0;
                      const competitorCount = (t.same_slot_count ?? 0) + (t.next_slot_count ?? 0);

                      // 我的排位：my_block_index 相对于目标（first_sniper_slot / slot）计算
                      const myRank = t.my_block_index != null ? `#${t.my_block_index + 1}` : null;

                      // 参考页格式：mint 带 dev badge
                      const isDevBuy = t.is_dev_buy === true;

                      const isThisTradeExpanded = expandedTradeId === t.id;

                      return [
                        // ===== 第2层：交易行（可点击展开） =====
                        <tr
                          key={`trade-${t.id}`}
                          className={`border-b border-gray-100 dark:border-gray-700/50 hover:bg-brand-50/40 dark:hover:bg-brand-500/10 cursor-pointer transition-colors ${
                            i % 2 === 0 ? 'bg-white dark:bg-zinc-800' : 'bg-gray-50/60 dark:bg-zinc-800/60'
                          } ${isThisTradeExpanded ? 'bg-blue-50/40 dark:bg-blue-500/10 ring-1 ring-blue-200 dark:ring-blue-500/30' : ''}`}
                          onClick={() => toggleTradeExpand(t.id)}
                        >
                          <td className="py-1.5 px-2 font-mono text-gray-500 dark:text-gray-400 tabular-nums">{fmtTime(t.block_time)}</td>
                          <td className="py-1.5 px-2">
                            <div className="flex items-center gap-1">
                              <AddressCopy address={t.mint} length={5} />
                              {isDevBuy && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/30" title="dev 单：create 和 buy 在同一个 tx">
                                  dev
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="py-1.5 px-2 font-mono text-gray-400 dark:text-gray-500 tabular-nums">{t.slot}</td>
                          <td className="py-1.5 px-2 text-right"><SolAmount value={t.buy_sol} /></td>

                          {/* 第一个狙击者 */}
                          <td className="py-1.5 px-2">
                            {t.first_sniper ? (
                              <div className="flex items-center gap-1.5">
                                <AddressCopy address={t.first_sniper} length={4} />
                                <span
                                  className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                    snFailed
                                      ? 'bg-red-500/15 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-500/30'
                                      : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/30'
                                  }`}
                                >
                                  {snFailed ? '失败' : '抢到'} +{snOffset}
                                </span>
                              </div>
                            ) : <span className="text-gray-300 dark:text-gray-600">—</span>}
                          </td>

                          <td className="py-1.5 px-2 text-right font-mono text-amber-600 dark:text-amber-400 tabular-nums">
                            {t.first_sniper_tip_sol != null
                              ? Number(t.first_sniper_tip_sol).toFixed(6)
                              : <span className="text-gray-300 dark:text-gray-600">—</span>}
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono text-purple-600 dark:text-purple-400 tabular-nums">
                            {t.first_sniper_prio_lamports != null
                              ? (Number(t.first_sniper_prio_lamports) / 1e9).toFixed(6)
                              : <span className="text-gray-300 dark:text-gray-600">—</span>}
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono tabular-nums">
                            <span className={`${
                              t.pnl_sol != null
                                ? parseFloat(t.pnl_sol) > 0
                                  ? 'text-emerald-500'
                                  : parseFloat(t.pnl_sol) < 0
                                    ? 'text-red-500'
                                    : 'text-gray-400'
                                : 'text-gray-400'
                            }`}>
                              {t.pnl_sol != null
                                ? `${parseFloat(t.pnl_sol) >= 0 ? '+' : ''}${parseFloat(t.pnl_sol).toFixed(4)}`
                                : '—'}
                            </span>
                          </td>

                          {/* 买家总数 */}
                          <td className="py-1.5 px-2 text-right font-mono text-gray-400 dark:text-gray-500 tabular-nums">
                            {competitorCount > 0
                              ? <span className="text-gray-600 dark:text-gray-300">{competitorCount}</span>
                              : <span className="text-gray-300 dark:text-gray-600">—</span>}
                          </td>

                          {/* 我的排位 */}
                          <td className="py-1.5 px-2 text-center">
                            {myRank ? (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-500/15 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-500/30">
                                {myRank}
                              </span>
                            ) : (
                              <span className="text-gray-300 dark:text-gray-600">—</span>
                            )}
                          </td>

                          {/* 我的 tip */}
                          <td className="py-1.5 px-2 text-right font-mono text-amber-600 dark:text-amber-400 tabular-nums">
                            {t.my_tip_sol != null
                              ? Number(t.my_tip_sol).toFixed(6)
                              : <span className="text-gray-300 dark:text-gray-600">—</span>}
                          </td>

                          {/* 我的 prio */}
                          <td className="py-1.5 px-2 text-right font-mono text-purple-600 dark:text-purple-400 tabular-nums">
                            {t.my_prio_lamports != null
                              ? (Number(t.my_prio_lamports) / 1e9).toFixed(6)
                              : <span className="text-gray-300 dark:text-gray-600">—</span>}
                          </td>
                        </tr>,

                        // ===== 第3层：内嵌于第2层内部的 block 级买家分布（手风琴展开行） =====
                        isThisTradeExpanded && (
                          <tr key={`detail-${t.id}`} className="bg-slate-100/60 dark:bg-zinc-700/20 border-b border-gray-200 dark:border-gray-700">
                            <td colSpan={12} className="px-4 py-3">
                              <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                  <span className="w-1.5 h-1.5 rounded-full bg-brand-500" />
                                  <div className="text-[11px] font-semibold text-gray-700 dark:text-gray-200">
                                    Slot <span className="font-mono text-brand-600 dark:text-brand-400">{t.slot}</span>
                                    <span className="text-gray-400 mx-1">·</span>
                                    Mint <span className="font-mono text-brand-600 dark:text-brand-400">{t.mint.slice(0, 6)}…{t.mint.slice(-4)}</span>
                                  </div>
                                  <span className="text-[11px] text-gray-400 dark:text-gray-500">的 block 级买家分布</span>
                                </div>
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); setExpandedTradeId(null); }}
                                  className="inline-flex items-center gap-1 text-[11px] text-gray-400 dark:text-gray-500 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 px-1.5 py-0.5 rounded transition-colors"
                                >
                                  <ChevronUpIcon className="w-3 h-3" />收起
                                </button>
                              </div>
                              <BlockDetailView
                                key={`block-${t.slot}-${t.mint}`}
                                slot={t.slot}
                                mint={t.mint}
                              />
                            </td>
                          </tr>
                        ),
                      ];
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
