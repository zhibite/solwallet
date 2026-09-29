"use client";
import React, { useState, useEffect } from "react";
import AddressCopy from "./AddressCopy";
import SolAmount from "./SolAmount";
import RelativeTime from "./RelativeTime";
import { ChevronDownIcon, ChevronUpIcon, TrashBinIcon, TimeIcon } from "@/icons";
import Link from "next/link";

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
  pnl_sol: string | null;
  status: string;
}

interface Props {
  target: Target;
  onPause: (id: number) => void;
  onResume: (id: number) => void;
  onDelete: (id: number) => void;
  onClear: (id: number) => void;
  onThresholdChange: (id: number, val: number) => void;
}

export default function TargetRow({ target, onPause, onResume, onDelete, onClear, onThresholdChange }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [loadingTrades, setLoadingTrades] = useState(false);
  const [editingThreshold, setEditingThreshold] = useState(false);
  const [thresholdVal, setThresholdVal] = useState(target.threshold_sol);

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

  const handleSaveThreshold = async () => {
    const n = parseFloat(thresholdVal);
    if (Number.isNaN(n) || n < 0) return;
    await onThresholdChange(target.id, n);
    setEditingThreshold(false);
  };

  return (
    <>
      <tr className="border-b border-gray-200 dark:border-zinc-700 hover:bg-gray-50 dark:hover:bg-zinc-800/50">
        <td className="px-3 py-3">
          <div className="flex items-center gap-2">
            <button onClick={toggleExpand} className="text-gray-500">
              {expanded ? <ChevronUpIcon className="w-4 h-4" /> : <ChevronDownIcon className="w-4 h-4" />}
            </button>
            <AddressCopy address={target.address} />
            {target.label && <span className="text-xs text-gray-500">({target.label})</span>}
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
                className="w-16 h-7 px-2 text-xs rounded border border-gray-300 dark:border-zinc-700 bg-white dark:bg-zinc-800"
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
          <span className="font-mono text-xs">{target.record_count}</span>
        </td>
        <td className="px-3 py-3">
          <RelativeTime iso={target.last_buy_at} />
        </td>
        <td className="px-3 py-3">
          {trades && trades.length > 0 ? (
            <div className="text-xs space-y-0.5">
              <AddressCopy address={trades[0].first_sniper || trades[0].mint} />
              <div className="text-gray-500">
                抢到 <SolAmount value={trades[0].first_sniper_buy_sol} signed /> / tip{' '}
                <SolAmount value={trades[0].first_sniper_tip_sol} /> / prio{' '}
                <span className="font-mono text-gray-500">{trades[0].first_sniper_prio_lamports || 0}</span>
              </div>
            </div>
          ) : (
            <span className="text-xs text-gray-400">-</span>
          )}
        </td>
        <td className="px-3 py-3">
          <div className="flex items-center gap-1 text-xs">
            {target.status === 'active' ? (
              <button onClick={() => onPause(target.id)} className="text-gray-500 hover:text-warning-500">暂停</button>
            ) : (
              <button onClick={() => onResume(target.id)} className="text-gray-500 hover:text-success-500">继续</button>
            )}
            <span className="text-gray-300">|</span>
            <button onClick={() => onClear(target.id)} className="text-gray-500 hover:text-brand-500">清记录</button>
            <span className="text-gray-300">|</span>
            <button onClick={() => onDelete(target.id)} className="text-gray-500 hover:text-error-500">删除</button>
          </div>
        </td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={7} className="bg-gray-50 dark:bg-zinc-800/30 px-6 py-4">
            {loadingTrades ? (
              <div className="text-xs text-gray-500">加载中...</div>
            ) : !trades || trades.length === 0 ? (
              <div className="text-xs text-gray-500">暂无 buy 记录</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-gray-500">
                    <tr className="border-b border-gray-200 dark:border-zinc-700">
                      <th className="py-2 px-2 text-left">时间</th>
                      <th className="py-2 px-2 text-left">MINT</th>
                      <th className="py-2 px-2 text-left">SLOT</th>
                      <th className="py-2 px-2 text-right">买入 SOL</th>
                      <th className="py-2 px-2 text-right">自己 TIP</th>
                      <th className="py-2 px-2 text-right">自己 PRIO</th>
                      <th className="py-2 px-2 text-center">捆绑</th>
                      <th className="py-2 px-2 text-left">第一个狙击者</th>
                      <th className="py-2 px-2 text-right">狙击 TIP</th>
                      <th className="py-2 px-2 text-right">狙击 PRIO</th>
                      <th className="py-2 px-2 text-right">跟单收益</th>
                      <th className="py-2 px-2 text-center">详情</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.map((t) => (
                      <tr key={t.id} className="border-b border-gray-100 dark:border-zinc-700/50 hover:bg-white dark:hover:bg-zinc-800">
                        <td className="py-1.5 px-2"><RelativeTime iso={t.block_time} /></td>
                        <td className="py-1.5 px-2"><AddressCopy address={t.mint} length={4} /></td>
                        <td className="py-1.5 px-2 font-mono text-gray-500">{t.slot}</td>
                        <td className="py-1.5 px-2 text-right"><SolAmount value={t.buy_sol} /></td>
                        <td className="py-1.5 px-2 text-right"><SolAmount value={t.target_tip_sol} /></td>
                        <td className="py-1.5 px-2 text-right font-mono">{t.target_prio_lamports || 0}</td>
                        <td className="py-1.5 px-2 text-center">
                          {t.is_bundled ? <span className="text-success-500">✓</span> : <span className="text-gray-300">-</span>}
                        </td>
                        <td className="py-1.5 px-2">
                          {t.first_sniper ? (
                            <div className="flex flex-col gap-0.5">
                              <AddressCopy address={t.first_sniper} />
                              <SolAmount value={t.first_sniper_buy_sol} />
                            </div>
                          ) : <span className="text-gray-400">-</span>}
                        </td>
                        <td className="py-1.5 px-2 text-right"><SolAmount value={t.first_sniper_tip_sol} /></td>
                        <td className="py-1.5 px-2 text-right font-mono">{t.first_sniper_prio_lamports || 0}</td>
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
                    ))}
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
