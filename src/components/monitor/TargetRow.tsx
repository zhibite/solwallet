"use client";
import React, { useState, useEffect } from "react";
import AddressCopy from "@/components/common/AddressCopy";
import SolAmount from "@/components/common/SolAmount";
import PrioSolAmount from "@/components/common/PrioSolAmount";
import RelativeTime from "@/components/common/RelativeTime";
import { ChevronDownIcon, ChevronUpIcon } from "@/icons";
import Link from "next/link";
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
  first_sniper: string | null;
  first_sniper_buy_sol: string | null;
  first_sniper_tip_sol: string | null;
  first_sniper_prio_lamports: number | null;
  first_sniper_signature: string | null;
  first_sniper_offset_pos: number | null;
  pnl_sol: string | null;
  status: string;
  // 子表附加列（来自 transactions API JOIN block_buyers）
  first_sniper_slot?: number | null;       // 狙击者所在 slot
  first_sniper_buyer_signature?: string | null; // 狙击者在 block_buyers 里的 sig
  my_block_index?: number | null;          // 我自己的块内序（从 0 开始，null = 没买）
  my_tip_sol?: string | null;              // 我自己的 tip
  my_prio_lamports?: number | null;        // 我自己的 prio
  my_signature?: string | null;            // 我自己的 tx sig
  my_result?: string | null;               // 我自己的 result
}

interface Props {
  target: Target;
  onPause: (id: number) => void;
  onResume: (id: number) => void;
  onDelete: (id: number) => void;
  onClear: (id: number) => void;
  onThresholdChange: (id: number, val: number) => void;
  decisionCell?: React.ReactNode;
}

export default function TargetRow({ target, onPause, onResume, onDelete, onClear, onThresholdChange, decisionCell }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [loadingTrades, setLoadingTrades] = useState(false);
  const [editingThreshold, setEditingThreshold] = useState(false);
  const [thresholdVal, setThresholdVal] = useState(target.threshold_sol);

  // 首狙展开：内联显示该 trade 对应 slot+mint 的 block 级详情
  const [sniperExpanded, setSniperExpanded] = useState(false);
  const [sniperKey, setSniperKey] = useState<{ slot: number; mint: string } | null>(null);

  const loadTrades = async () => {
    if (trades !== null) return;
    setLoadingTrades(true);
    try {
      const res = await fetch(`/api/transactions?target_id=${target.id}&limit=20`);
      const json = await res.json();
      if (json.ok) setTrades(json.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingTrades(false);
    }
  };

  const toggleExpand = () => {
    if (!expanded) loadTrades();
    setExpanded(!expanded);
  };

  /**
   * 点击「最近一次 第一个狙击者」单元格
   * - 若 target 行未展开，先展开 + 加载 trades
   * - 切换 sniper 面板的展开/收起
   * - 展开时用 latest trade 的 (slot, mint) 加载 block 详情
   */
  const toggleSniperPanel = async () => {
    const latest = trades?.[0];
    if (!latest) {
      // 没数据时不允许展开
      return;
    }
    // 确保 target 行已展开
    if (!expanded) {
      setExpanded(true);
      await loadTrades();
    }
    const willOpen = !sniperExpanded;
    setSniperExpanded(willOpen);
    if (willOpen) {
      // 用新 key 触发 BlockDetailView 内部重新加载
      setSniperKey({ slot: latest.slot, mint: latest.mint });
    }
  };

  const handleSaveThreshold = async () => {
    const n = parseFloat(thresholdVal);
    if (Number.isNaN(n) || n < 0) return;
    await onThresholdChange(target.id, n);
    setEditingThreshold(false);
  };

  // 第一个狙击者信息（从最近一笔 buy 拿）
  const latest = trades?.[0];

  // 失败判定：找不到首狙、或首狙 offset 计算不出来（同 slot 没抢到、只在下一 slot 跟随）
  const sniperFailed = !!latest && (!latest.first_sniper || latest.first_sniper_offset_pos === null);

  // 格式化"TX +X"展示
  const renderOffset = (pos: number | null | undefined) => {
    if (pos === null || pos === undefined) return null;
    const sign = pos > 0 ? '+' : pos < 0 ? '' : '';
    const color = pos > 0 ? 'text-error-500' : pos < 0 ? 'text-success-600' : 'text-gray-500';
    return (
      <span className={`font-mono ${color}`}>
        TX {sign}{pos}
      </span>
    );
  };

  return (
    <>
      <tr className="border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-zinc-700/50">
        <td className="px-3 py-3">
          <div className="flex items-center gap-2">
            <button onClick={toggleExpand} className="text-gray-500 dark:text-gray-400">
              {expanded ? <ChevronUpIcon className="w-4 h-4" /> : <ChevronDownIcon className="w-4 h-4" />}
            </button>
            <AddressCopy address={target.address} />
            {target.label && <span className="text-xs text-gray-500 dark:text-gray-400">({target.label})</span>}
          </div>
        </td>
        <td className="px-3 py-3">
          {editingThreshold ? (
            <div className="flex items-center gap-1">
              <input
                type="number"
                step="0.1"
                value={thresholdVal}
                onChange={(e) => setThresholdVal(e.target.value)}
                className="w-16 h-7 px-2 text-xs rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-700 text-gray-800 dark:text-white/90 focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
              />
              <button onClick={handleSaveThreshold} className="text-xs text-brand-500 hover:underline">保存</button>
              <button onClick={() => { setEditingThreshold(false); setThresholdVal(target.threshold_sol); }} className="text-xs text-gray-400">×</button>
            </div>
          ) : (
            <button
              onClick={() => setEditingThreshold(true)}
              className="font-mono text-xs text-gray-700 dark:text-gray-300 hover:text-brand-500"
            >
              {parseFloat(target.threshold_sol).toFixed(4)}
            </button>
          )}
        </td>
        <td className="px-3 py-3">
          {target.status === 'active' ? (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-success-50 text-success-700 dark:bg-success-500/10 dark:text-success-400">监控中</span>
          ) : (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600 dark:bg-zinc-700 dark:text-gray-300">已暂停</span>
          )}
        </td>
        <td className="px-3 py-3 text-center">
          <span className="font-mono text-sm font-semibold text-brand-600 dark:text-brand-400">
            {target.record_count}
          </span>
        </td>
        <td className="px-3 py-3">
          <span className="text-xs font-mono text-gray-600 dark:text-gray-400">
            {target.last_buy_at ? new Date(target.last_buy_at).toLocaleString('zh-CN', { hour12: false }).slice(5) : '-'}
          </span>
        </td>
        <td className="px-3 py-3">
          <RelativeTime iso={target.last_buy_at} />
        </td>
        <td className="px-3 py-3">
          {latest && latest.first_sniper && !sniperFailed ? (
            <button
              type="button"
              onClick={toggleSniperPanel}
              className={`text-left text-xs space-y-0.5 rounded-md px-1 py-0.5 -mx-1 hover:bg-slate-100 dark:hover:bg-zinc-700/60 transition-colors ${
                sniperExpanded ? 'bg-brand-50 dark:bg-brand-500/10' : ''
              }`}
              title="点击展开该 slot 的 block 级详情"
            >
              <AddressCopy address={latest.first_sniper} />
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-gray-500 dark:text-gray-400">
                {renderOffset(latest.first_sniper_offset_pos)}
                <span>
                  tip <SolAmount value={latest.first_sniper_tip_sol} />
                </span>
                <span className="font-mono">
                  prio <PrioSolAmount value={latest.first_sniper_prio_lamports} />
                </span>
                <span className={`text-[10px] ${sniperExpanded ? 'text-brand-500' : 'text-gray-400'}`}>
                  {sniperExpanded ? '收起 ▴' : '块内序 ▾'}
                </span>
              </div>
            </button>
          ) : sniperFailed ? (
            <span
              className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-error-50 text-error-700 dark:bg-error-500/15 dark:text-error-400"
              title="未在同 slot 抢到首狙（要么 sniper offset 算不出、要么只在下一 slot 跟随）"
            >
              失败
            </span>
          ) : (
            <span className="text-xs text-gray-400">-</span>
          )}
        </td>
        <td className="px-3 py-3">{decisionCell}</td>
        <td className="px-3 py-3">
          <div className="flex items-center gap-1 text-xs">
            <button onClick={toggleExpand} className="text-gray-500 dark:text-gray-400 hover:text-brand-500">{expanded ? '收起' : '展开'}</button>
            <span className="text-gray-300">|</span>
            <button onClick={() => setEditingThreshold(true)} className="text-gray-500 dark:text-gray-400 hover:text-brand-500">阈值</button>
            <span className="text-gray-300">|</span>
            {target.status === 'active' ? (
              <button onClick={() => onPause(target.id)} className="text-gray-500 dark:text-gray-400 hover:text-warning-500">暂停</button>
            ) : (
              <button onClick={() => onResume(target.id)} className="text-gray-500 dark:text-gray-400 hover:text-success-500">继续</button>
            )}
            <span className="text-gray-300">|</span>
            <button onClick={() => onClear(target.id)} className="text-gray-500 dark:text-gray-400 hover:text-brand-500">清记录</button>
            <span className="text-gray-300">|</span>
            <button onClick={() => onDelete(target.id)} className="text-gray-500 dark:text-gray-400 hover:text-error-500">删除</button>
          </div>
        </td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={9} className="bg-gray-50 dark:bg-zinc-700/30 px-6 py-4">
            {loadingTrades ? (
              <div className="text-xs text-gray-500 dark:text-gray-400">加载中...</div>
            ) : !trades || trades.length === 0 ? (
              <div className="text-xs text-gray-500 dark:text-gray-400">暂无 buy 记录</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-gray-500 dark:text-gray-400">
                    <tr className="border-b border-gray-200 dark:border-gray-700">
                      <th className="py-2 px-2 text-left">时间</th>
                      <th className="py-2 px-2 text-left">MINT</th>
                      <th className="py-2 px-2 text-left">SLOT</th>
                      <th className="py-2 px-2 text-right">买入 SOL</th>
                      <th className="py-2 px-2 text-right">自己 TIP</th>
                      <th className="py-2 px-2 text-right">自己 PRIO</th>
                      <th className="py-2 px-2 text-center">捆绑</th>
                      <th className="py-2 px-2 text-left">首狙</th>
                      <th className="py-2 px-2 text-right">狙击 TIP</th>
                      <th className="py-2 px-2 text-right">狙击 PRIO</th>
                      <th className="py-2 px-2 text-right">跟单 SLOT</th>
                      <th className="py-2 px-2 text-center">买家</th>
                      <th className="py-2 px-2 text-center">我的排位</th>
                      <th className="py-2 px-2 text-right">我的 TIP</th>
                      <th className="py-2 px-2 text-right">我的 PRIO</th>
                      <th className="py-2 px-2 text-right">跟单收益</th>
                      <th className="py-2 px-2 text-center">详情</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t) => {
                      const myPos = t.my_block_index !== null && t.my_block_index !== undefined
                        ? `第${t.my_block_index + 1}个`
                        : null;
                      const firstSniperSig = t.first_sniper_buyer_signature || t.first_sniper_signature;
                      return (
                      <tr key={t.id} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-white dark:hover:bg-zinc-700">
                        <td className="py-1.5 px-2"><RelativeTime iso={t.block_time} /></td>
                        <td className="py-1.5 px-2"><AddressCopy address={t.mint} length={4} /></td>
                        <td className="py-1.5 px-2 font-mono text-gray-500 dark:text-gray-400">{t.slot}</td>
                        <td className="py-1.5 px-2 text-right"><SolAmount value={t.buy_sol} /></td>
                        <td className="py-1.5 px-2 text-right"><SolAmount value={t.target_tip_sol} /></td>
                        <td className="py-1.5 px-2 text-right"><PrioSolAmount value={t.target_prio_lamports} /></td>
                        <td className="py-1.5 px-2 text-center">
                          {t.is_bundled ? <span className="text-success-500">✓</span> : <span className="text-gray-300">-</span>}
                        </td>
                        <td className="py-1.5 px-2">
                          {t.first_sniper ? (
                            <div className="flex flex-col gap-0.5">
                              <AddressCopy address={t.first_sniper} />
                              <SolAmount value={t.first_sniper_buy_sol} />
                              {renderOffset(t.first_sniper_offset_pos)}
                            </div>
                          ) : <span className="text-gray-400">-</span>}
                        </td>
                        <td className="py-1.5 px-2 text-right"><SolAmount value={t.first_sniper_tip_sol} /></td>
                        <td className="py-1.5 px-2 text-right"><PrioSolAmount value={t.first_sniper_prio_lamports} /></td>
                        <td className="py-1.5 px-2 text-right font-mono text-gray-500 dark:text-gray-400">
                          {t.first_sniper_slot ?? '-'}
                        </td>
                        <td className="py-1.5 px-2 text-center">
                          {firstSniperSig ? (
                            <a
                              href={`https://solscan.io/tx/${firstSniperSig}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-brand-500 hover:underline text-xs"
                              title="狙击者交易"
                            >
                              →
                            </a>
                          ) : <span className="text-gray-300">-</span>}
                        </td>
                        <td className="py-1.5 px-2 text-center">
                          {myPos ? (
                            <span className="font-mono text-xs text-warning-600 dark:text-warning-400" title={t.my_result ? `结果: ${t.my_result}` : ''}>
                              {myPos}
                            </span>
                          ) : <span className="text-gray-300">-</span>}
                        </td>
                        <td className="py-1.5 px-2 text-right">
                          {t.my_tip_sol !== null && t.my_tip_sol !== undefined ? <SolAmount value={t.my_tip_sol} /> : <span className="text-gray-300">-</span>}
                        </td>
                        <td className="py-1.5 px-2 text-right">
                          {t.my_prio_lamports !== null && t.my_prio_lamports !== undefined ? <PrioSolAmount value={t.my_prio_lamports} /> : <span className="text-gray-300">-</span>}
                        </td>
                        <td className="py-1.5 px-2 text-right"><SolAmount value={t.pnl_sol} signed /></td>
                        <td className="py-1.5 px-2 text-center">
                          <Link
                            href={`/block/${t.slot}/${t.mint}`}
                            className="text-brand-500 hover:underline text-xs"
                          >
                            查看
                          </Link>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </td>
        </tr>
      )}

      {expanded && sniperExpanded && sniperKey && (
        <tr>
          <td colSpan={9} className="bg-gray-50 dark:bg-zinc-700/30 px-6 py-4 border-t border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs font-semibold text-gray-700 dark:text-gray-200">
                Slot {sniperKey.slot} · Mint {sniperKey.mint.slice(0, 6)}…{sniperKey.mint.slice(-4)} 的 block 级买家分布
              </div>
              <button
                type="button"
                onClick={() => setSniperExpanded(false)}
                className="text-xs text-gray-500 dark:text-gray-400 hover:text-error-500"
              >
                收起 ▴
              </button>
            </div>
            <BlockDetailView key={`${sniperKey.slot}-${sniperKey.mint}`} slot={sniperKey.slot} mint={sniperKey.mint} />
          </td>
        </tr>
      )}
    </>
  );
}
