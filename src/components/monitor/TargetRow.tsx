"use client";
import React, { useState, useEffect } from "react";
import AddressCopy from "@/components/common/AddressCopy";
import SolAmount from "@/components/common/SolAmount";
import RelativeTime from "@/components/common/RelativeTime";
import { ChevronDownIcon, ChevronUpIcon } from "@/icons";
import BlockDetailView from "@/components/block/BlockDetailView";
import type { Target, TargetDecision } from "@/lib/types";

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
  /** 狙击者那笔买入的 PnL（=「如果跟单这个狙击者能赚多少」）。null = 还在算或没卖出。 */
  sniper_pnl_sol?: string | null;
  sniper_pnl_status?: string | null;
  sniper_pnl_sold_ratio?: string | null;
  // 0020: 三段式
  sniper_unrealized_sol?: string | null;
  sniper_total_pnl_sol?: string | null;
  sniper_current_price_sol?: string | null;
  sniper_price_updated_at?: string | null;
  pnl_sol?: string | null;  // 兼容字段：仍保留，UI 优先用 sniper_pnl_sol
  // 0020: 三段式（主行 JSX 用非前缀名与 last_sniper 共用；底层 API 用 sniper_* 前缀字段填充，
  // JSX 通过可选链嗅到 undefined 时退化显示 "—"，所以这两个语义层都对得上）
  unrealized_sol?: string | null;
  total_pnl_sol?: string | null;
  pnl_status?: string | null;
  price_updated_at?: string | null;
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
  decision?: TargetDecision;
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
      const res = await fetch(`/api/transactions?target_id=${target.id}&limit=30&first_only=${firstOnly ? 1 : 0}`);
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
        first_sniper_offset_ms: target.last_sniper.offset_ms,
        first_sniper_slot: target.last_sniper.slot,
        first_sniper_tip_sol: target.last_sniper.tip_sol,
        first_sniper_prio_lamports: target.last_sniper.prio_lamports,
        pnl_sol: target.last_sniper.pnl_sol,
        // 0020: 浮盈 + 总 PnL 三段式
        unrealized_sol: target.last_sniper.unrealized_sol ?? null,
        total_pnl_sol: target.last_sniper.total_pnl_sol ?? null,
        current_price_sol: target.last_sniper.current_price_sol ?? null,
        price_updated_at: target.last_sniper.price_updated_at ?? null,
        pnl_status: target.last_sniper.pnl_status ?? null,
        slot: target.last_sniper.slot,
        mint: target.last_sniper.mint,
        block_time: target.last_sniper.block_time,
        // 【P1-#3】目标自己在这一笔的 tip / prio（不是狙击者的）
        target_tip_sol: target.last_sniper.target_tip_sol,
        target_prio_lamports: target.last_sniper.target_prio_lamports,
      }
    : latest;

  // 狙击者分两种状态（参考站）：
  //   - 同 slot 抢到 (offset_pos !== null)：显示「抢到 +N」（N 可正可负；
  //     负数 = 狙击者抢在目标之前，jito bundle 内联场景）
  //   - 跨 slot 抢到 (offset_pos === null, sniper 存在)：只显示「下slot +N」徽章，
  //     不再叠加「失败」标签 —— 「first_sniper」按定义就是「target 之后第一笔非 target 买入」，
  //     跨 slot 不算失败，只是时机不同。
  // 没记录 pos 时 fallback 到 offset_ms（同 slot 下 ms 不可信，但 fallback 时还是给方向）。
  const sniperOffset = (() => {
    if (sniper?.first_sniper_offset_pos != null) return sniper.first_sniper_offset_pos;
    if (sniper?.first_sniper_offset_ms != null) return sniper.first_sniper_offset_ms;
    return 0;
  })();
  // 跨 slot 时的 slot 差（sniper_slot - target_slot），单位是 slot 数量
  const sniperSlotDiff = (() => {
    if (sniper?.first_sniper_slot == null || sniper?.slot == null) return null;
    const diff = sniper.first_sniper_slot - sniper.slot;
    return diff !== 0 ? diff : null; // 0 = 同 slot（走同 slot 分支），不显示
  })();
  // 「下slot」标签 = 狙击者存在但跨 slot（offset_pos=null）
  const sniperNextSlot = !!sniper?.first_sniper && sniper.first_sniper_offset_pos == null;
  // 「同 slot 抢到」徽章 = 狙击者存在且有块内位置差
  const sniperInSameSlot = !!sniper?.first_sniper && sniper.first_sniper_offset_pos != null;

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
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/30 whitespace-nowrap">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              监控中
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-zinc-700 dark:text-gray-300 border border-gray-200 dark:border-zinc-600 whitespace-nowrap">
              已暂停
            </span>
          )}
        </td>

        {/* 自动跟单 */}
        <td className="px-3 py-3 text-center" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => onToggleAutoFollow(target.id, !target.auto_follow)}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border whitespace-nowrap transition-colors ${
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
        <td className="px-3 py-3 whitespace-nowrap">
          <span className="text-xs font-mono text-gray-500 dark:text-gray-400 tabular-nums">
            {target.last_buy_at ? fmtTime(target.last_buy_at) : '-'}
          </span>
        </td>

        {/* 距现在 */}
        <td className="px-3 py-3 whitespace-nowrap">
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
              <span className="inline-flex items-center gap-0.5 shrink-0">
                {sniperInSameSlot ? (
                  // 同 slot：块内位置差（可正可负；负数 = 抢在目标前 jito bundle 内联）
                  <span
                    className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/30"
                    title={`狙击者块内位置差（负数 = 抢在目标之前）`}
                  >
                    抢到 {sniperOffset > 0 ? '+' : ''}{sniperOffset}
                  </span>
                ) : (
                  // 跨 slot：显示 slot 差
                  <span
                    className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-100 dark:bg-zinc-700 text-gray-600 dark:text-gray-300 border border-slate-200 dark:border-zinc-600 font-mono"
                    title={`狙击者在第 ${sniperSlotDiff} 个 slot 追入`}
                  >
                    下slot {sniperSlotDiff != null && sniperSlotDiff > 0 ? '+' : ''}{sniperSlotDiff}
                  </span>
                )}
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

        {/* 收益（第4列）：三段式 = 已实现 + 浮盈 = 总 PnL */}
        <td className="px-3 py-3 text-right">
          {(() => {
            // 三段式字段（sniper 只有 last_sniper 时才有这套，未连上 sniper 时退化到 trades 表）
            const realized = sniper?.pnl_sol != null ? parseFloat(sniper.pnl_sol) : null;
            const unreal = sniper?.unrealized_sol != null ? parseFloat(sniper.unrealized_sol) : null;
            const total = sniper?.total_pnl_sol != null ? parseFloat(sniper.total_pnl_sol) : realized;
            const status = sniper?.pnl_status ?? null;
            const priceUpd = sniper?.price_updated_at ?? null;
            // 价格 > 90s 没刷新：标 ~ 表示可能过期。
            //   注意：price_updated_at 异常（'abc' 等）时 new Date(...).getTime() = NaN，
            //   Date.now() - NaN = NaN，NaN > 90_000 = false ——会让 stale 误判为 false。
            //   因此要显式 catch invalid date。
            const priceUpdTs = priceUpd ? new Date(priceUpd).getTime() : NaN;
            const stale = !priceUpd || !Number.isFinite(priceUpdTs) || Date.now() - priceUpdTs > 90_000;
            const isOpen = status === 'open';
            const isPartial = status === 'partial';
            // 颜色的优先级按 total 决定（最贴近用户的真实判断）
            const tone =
              total != null
                ? total > 0 ? 'text-emerald-500'
                : total < 0 ? 'text-red-500'
                : 'text-gray-400'
                : 'text-gray-400';

            if (total == null) {
              // pnl_sol / total_pnl_sol 都还是 NULL：FIFO 还没跑完、浮盈也还没写出来。
              //   ① 之后这条分支基本只会闪一下（< 1s），② 之后只对 follower 短暂出现。
              //   用脉冲圆点 + 浅灰文字告诉用户「在算」，比「—」更直观。
              return (
                <span
                  className="inline-flex items-center gap-1 text-gray-300 dark:text-gray-600 text-xs font-mono tabular-nums"
                  title="pnl 还在计算中（先看浮盈，30s 内必有结果）"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                  <span>算中</span>
                </span>
              );
            }

            // closed 或 buy_failed：直接一个数字
            if (!isOpen && !isPartial) {
              return (
                <span className={`text-xs font-mono font-semibold tabular-nums ${tone}`} title={`已实现收益（${status ?? 'closed'}）`}>
                  {`${total >= 0 ? '+' : ''}${total.toFixed(4)}`}
                </span>
              );
            }

            // open / partial：三段式展示
            return (
              <div className="flex flex-col items-end leading-tight">
                <span className={`text-xs font-mono font-semibold tabular-nums ${tone}`}>
                  {`${total >= 0 ? '+' : ''}${total.toFixed(4)}`}
                  {isOpen ? '*' : ''}
                </span>
                {(realized != null || unreal != null) && (
                  <span
                    className="text-[10px] font-mono tabular-nums text-gray-400 dark:text-gray-500"
                    title={`已实现 ${realized?.toFixed(4) ?? '-'}，浮盈 ${unreal?.toFixed(4) ?? '-'}`}
                  >
                    {`实${realized != null ? (realized >= 0 ? '+' : '') + realized.toFixed(3) : '-'} + 浮${unreal != null ? (unreal >= 0 ? '+' : '') + unreal.toFixed(3) : '-'}`}
                    {stale ? ' ~' : ''}
                  </span>
                )}
              </div>
            );
          })()}
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
          <td colSpan={11} className="px-6 py-5">
            {loadingTrades ? (
              <div className="flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500 py-6">
                <span className="w-4 h-4 rounded-full border-2 border-current animate-spin" style={{ borderTopColor: 'transparent' }} />
                <span>加载中...</span>
              </div>
            ) : !trades || trades.length === 0 ? (
              <div className="text-xs text-gray-400 dark:text-gray-500 py-6 italic text-center">
                暂无 buy 记录（阈值 {parseFloat(target.threshold_sol).toFixed(4)} SOL）
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-gray-200/80 dark:border-gray-700/50 shadow-sm bg-white dark:bg-zinc-800">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gradient-to-r from-slate-100 to-gray-50 dark:from-zinc-700 dark:to-zinc-700/80 text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                      {/* 时间 / mint / slot / 买入SOL / 第一个狙击者 / 狙击tip / 狙击prio / 跟单收益 / 买家 / 我的排位 / 我的tip / 我的prio */}
                      <th className="py-2.5 px-3 text-left font-semibold">时间</th>
                      <th className="py-2.5 px-3 text-left font-semibold">mint</th>
                      <th className="py-2.5 px-3 text-left font-semibold">slot</th>
                      <th className="py-2.5 px-3 text-right font-semibold">买入SOL</th>
                      <th className="py-2.5 px-3 text-left font-semibold">第一个狙击者</th>
                      <th className="py-2.5 px-3 text-right font-semibold">tip</th>
                      <th className="py-2.5 px-3 text-right font-semibold">prio</th>
                      <th className="py-2.5 px-3 text-right font-semibold">跟单收益</th>
                      <th className="py-2.5 px-3 text-right font-semibold" title="同 slot + 下一 slot 买这个 token 的总笔数">买家</th>
                      <th className="py-2.5 px-3 text-center font-semibold" title="在所有跟这个目标的人里，我是第几个跟上的">我的排位</th>
                      <th className="py-2.5 px-3 text-right font-semibold" title="我的 tip">我的tip</th>
                      <th className="py-2.5 px-3 text-right font-semibold" title="我的 prio">我的prio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t, i) => {
                      const snInSameSlot = !!t.first_sniper && t.first_sniper_offset_pos != null;
                      const snNextSlot = !!t.first_sniper && t.first_sniper_offset_pos == null;
                      // 优先用块内位置差（与参考站一致 = 狙击者比目标在块内晚几笔 tx，
                      // 负数 = jito bundle 内联抢在目标前）。fallback 到 offset_ms 时保留符号。
                      const snOffset = (() => {
                        if (t.first_sniper_offset_pos != null) return t.first_sniper_offset_pos;
                        if (t.first_sniper_offset_ms != null) return t.first_sniper_offset_ms;
                        return 0;
                      })();
                      // 跨 slot 时的 slot 差（sniper_slot - target_slot），单位是 slot 数量
                      const snSlotDiff = (() => {
                        if (t.first_sniper_slot == null || t.slot == null) return null;
                        const diff = t.first_sniper_slot - t.slot;
                        return diff !== 0 ? diff : null;
                      })();
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
                          className={`group border-b border-gray-100 dark:border-gray-700/50 hover:bg-brand-50/60 dark:hover:bg-brand-500/15 cursor-pointer transition-all duration-150 ${
                            i % 2 === 0 ? 'bg-white dark:bg-zinc-800' : 'bg-gray-50/50 dark:bg-zinc-800/40'
                          } ${isThisTradeExpanded ? 'bg-blue-50/50 dark:bg-blue-500/10 ring-1 ring-blue-200 dark:ring-blue-500/30 shadow-sm' : ''}`}
                          onClick={() => toggleTradeExpand(t.id)}
                        >
                          <td className="py-2 px-3 font-mono text-gray-500 dark:text-gray-400 tabular-nums">{fmtTime(t.block_time)}</td>
                          <td className="py-2 px-3">
                            <div className="flex items-center gap-1.5">
                              <AddressCopy address={t.mint} length={5} />
                              {isDevBuy && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/30" title="dev 单：create 和 buy 在同一个 tx">
                                  dev
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="py-2 px-3 font-mono text-gray-400 dark:text-gray-500 tabular-nums">{t.slot}</td>
                          <td className="py-2 px-3 text-right"><SolAmount value={t.buy_sol} /></td>

                          {/* 第一个狙击者 */}
                          <td className="py-2 px-3">
                            {t.first_sniper ? (
                              <div className="flex items-center gap-1.5">
                                <AddressCopy address={t.first_sniper} length={4} />
                                {snInSameSlot ? (
                                  // 同 slot：块内位置差
                                  <span
                                    className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/30"
                                    title="狙击者块内位置差（负数 = 抢在目标之前）"
                                  >
                                    抢到 {snOffset > 0 ? '+' : ''}{snOffset}
                                  </span>
                                ) : (
                                  // 跨 slot：显示 slot 差
                                  <span
                                    className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-100 dark:bg-zinc-700 text-gray-600 dark:text-gray-300 border border-slate-200 dark:border-zinc-600 font-mono"
                                    title={`狙击者在第 ${snSlotDiff} 个 slot 追入`}
                                  >
                                    下slot {snSlotDiff != null && snSlotDiff > 0 ? '+' : ''}{snSlotDiff}
                                  </span>
                                )}
                              </div>
                            ) : <span className="text-gray-300 dark:text-gray-600">—</span>}
                          </td>

                          <td className="py-2 px-3 text-right font-mono text-amber-600 dark:text-amber-400 tabular-nums">
                            {t.first_sniper_tip_sol != null
                              ? Number(t.first_sniper_tip_sol).toFixed(6)
                              : <span className="text-gray-300 dark:text-gray-600">—</span>}
                          </td>
                          <td className="py-2 px-3 text-right font-mono text-purple-600 dark:text-purple-400 tabular-nums">
                            {t.first_sniper_prio_lamports != null
                              ? (Number(t.first_sniper_prio_lamports) / 1e9).toFixed(6)
                              : <span className="text-gray-300 dark:text-gray-600">—</span>}
                          </td>
                          {(() => {
                            // 跟单收益：监控列表展示的是「如果跟单这个狙击者能赚多少」。
                            // 优先读 sniper_pnl_sol（= b_first.pnl_sol，狙击者那笔的 PnL），
                            // sniper_pnl_status='open' 时也显示数字（已实现部分），'—' 表示还没卖出。
                            // 0020: 三段式 = 已实现 + 浮盈 = 总 PnL（狙击主行也是这套）。
                            const realized = t.sniper_pnl_sol != null ? parseFloat(t.sniper_pnl_sol) : null;
                            const unreal = t.sniper_unrealized_sol != null ? parseFloat(t.sniper_unrealized_sol) : null;
                            const total = t.sniper_total_pnl_sol != null ? parseFloat(t.sniper_total_pnl_sol) : realized;
                            const status = t.sniper_pnl_status;
                            const isOpen = status === 'open';
                            const isPartial = status === 'partial';
                            const tone = total != null
                              ? total > 0 ? 'text-emerald-500'
                              : total < 0 ? 'text-red-500'
                              : 'text-gray-400'
                              : 'text-gray-400';

                            if (total == null) {
                              return (
                                <td className="py-2 px-3 text-right font-mono text-gray-300 dark:text-gray-600 tabular-nums" title="pnl 还在计算中（先看浮盈，30s 内必有结果）">
                                  <span className="inline-flex items-center gap-1 justify-end">
                                    <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                                    <span>算中</span>
                                  </span>
                                </td>
                              );
                            }

                            if (!isOpen && !isPartial) {
                              // closed / buy_failed：单段
                              return (
                                <td className="py-2 px-3 text-right font-mono tabular-nums" title="狙击者已实现收益">
                                  <span className={tone}>
                                    {`${total >= 0 ? '+' : ''}${total.toFixed(4)}`}
                                  </span>
                                </td>
                              );
                            }

                            // open / partial：三段式（小屏用紧凑形式：总额 + 副行说明「实+浮」）
                            return (
                              <td className="py-2 px-3 text-right font-mono tabular-nums" title={`已实现 ${realized?.toFixed(4) ?? '-'}，浮盈 ${unreal?.toFixed(4) ?? '-'}`}>
                                <div className="flex flex-col items-end leading-tight">
                                  <span className={`${tone}`}>{`${total >= 0 ? '+' : ''}${total.toFixed(4)}${isOpen ? '*' : ''}`}</span>
                                  <span className="text-[10px] text-gray-400 dark:text-gray-500">
                                    {`实${realized != null ? (realized >= 0 ? '+' : '') + realized.toFixed(3) : '-'} + 浮${unreal != null ? (unreal >= 0 ? '+' : '') + unreal.toFixed(3) : '-'}`}
                                  </span>
                                </div>
                              </td>
                            );
                          })()}

                          {/* 买家总数 */}
                          <td className="py-2 px-3 text-right font-mono text-gray-400 dark:text-gray-500 tabular-nums">
                            {competitorCount > 0
                              ? <span className="text-gray-600 dark:text-gray-300">{competitorCount}</span>
                              : <span className="text-gray-300 dark:text-gray-600">—</span>}
                          </td>

                          {/* 我的排位 */}
                          <td className="py-2 px-3 text-center">
                            {myRank ? (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-500/15 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-500/30">
                                {myRank}
                              </span>
                            ) : (
                              <span className="text-gray-300 dark:text-gray-600">—</span>
                            )}
                          </td>

                          {/* 我的 tip */}
                          <td className="py-2 px-3 text-right font-mono text-amber-600 dark:text-amber-400 tabular-nums">
                            {t.my_tip_sol != null
                              ? Number(t.my_tip_sol).toFixed(6)
                              : <span className="text-gray-300 dark:text-gray-600">—</span>}
                          </td>

                          {/* 我的 prio */}
                          <td className="py-2 px-3 text-right font-mono text-purple-600 dark:text-purple-400 tabular-nums">
                            {t.my_prio_lamports != null
                              ? (Number(t.my_prio_lamports) / 1e9).toFixed(6)
                              : <span className="text-gray-300 dark:text-gray-600">—</span>}
                          </td>
                        </tr>,

                        // ===== 第3层：内嵌于第2层内部的 block 级买家分布（手风琴展开行） =====
                        isThisTradeExpanded && (
                          <tr key={`detail-${t.id}`} className="bg-gradient-to-r from-slate-50 to-blue-50/30 dark:from-zinc-700/30 dark:to-blue-500/10 border-b border-gray-200 dark:border-gray-700">
                            <td colSpan={12} className="px-5 py-4">
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
