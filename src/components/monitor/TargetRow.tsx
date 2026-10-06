"use client";
import React, { useState, useEffect } from "react";
import AddressCopy from "@/components/common/AddressCopy";
import SolAmount from "@/components/common/SolAmount";
import PrioSolAmount from "@/components/common/PrioSolAmount";
import TipSourceBadge from "@/components/common/TipSourceBadge";
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
  /**
   * 来自 /api/targets 的 LATERAL JOIN：最近一笔 first_sniper 不为 null 的 trade。
   * 用来在未展开 row 的情况下也能直接渲染"最近一次第一个狙击者"列。
   * —— 见 MonitorList 里同名字段的说明。
   */
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
  /** 解析时是否观察到 Address Lookup Table（v0 才有，Helius 路径可能为 null） */
  has_alt: boolean | null;
  /** 同 bundle 多笔共享的 ID */
  bundle_id: string | null;
  /** 同 bundle 的笔数（≥2 才有意义） */
  bundle_size: number | null;
  /** 0010: 自己这笔 buy 的 tip 渠道（null = 未付 tip） */
  tip_source: import('@/lib/types').TipSource | null;
  first_sniper: string | null;
  first_sniper_buy_sol: string | null;
  first_sniper_tip_sol: string | null;
  first_sniper_prio_lamports: number | null;
  /** 0010: 狙击者的 tip 渠道（来自 block_buyers.tip_source 通过 first_sniper_buyer_signature JOIN 拿到的） */
  first_sniper_tip_source?: import('@/lib/types').TipSource | null;
  first_sniper_signature: string | null;
  first_sniper_offset_pos: number | null;
  first_sniper_offset_ms: number | null;
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
  same_slot_count?: number | null;         // 同 slot 买入数（含 target 自己）
  next_slot_count?: number | null;         // 下一 slot 买入数
}

interface Props {
  target: Target;
  onPause: (id: number) => void;
  onResume: (id: number) => void;
  onDelete: (t: Target) => void;
  onClear: (t: Target) => void;
  onThresholdChange: (id: number, val: number) => void;
  /**
   * 该目标的跟单决策（推荐 tip+prio / 评分 / 收益 / 胜率）。
   * undefined = 还在算 / 还没样本，由 TargetRow 决定具体行渲染。
   */
  decision?: {
    worth_score: number | null;
    win_rate: number;
    avg_pnl_sol: number;
    p50_tip_sol: number;
    p50_prio_lamports: number;
    p75_tip_sol: number;
    p75_prio_lamports: number;
    success_count: number;
    failed_count: number;
    sample_size: number;
  };
}

export default function TargetRow({ target, onPause, onResume, onDelete, onClear, onThresholdChange, decision }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [sniperExpanded, setSniperExpanded] = useState(false);
  const [sniperKey, setSniperKey] = useState<{ slot: number; mint: string } | null>(null);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [loadingTrades, setLoadingTrades] = useState(false);
  const [editingThreshold, setEditingThreshold] = useState(false);
  const [thresholdVal, setThresholdVal] = useState(target.threshold_sol);

  // 同步：target.threshold_sol 变化时（保存后 refetch、其它入口修改、暂停/恢复等），
  // 同步刷新本地编辑态。否则在单元格点击编辑时，输入框里残留的是上一次的输入
  // （甚至清空后的 ""），不是"这条 target 的当前真实阈值"。
  useEffect(() => {
    setThresholdVal(target.threshold_sol);
  }, [target.threshold_sol]);

  // 首狙展开：内联显示该 trade 对应 slot+mint 的 block 级详情

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

  /**
   * 优先用 /api/targets 自带的 last_sniper（最近一笔 first_sniper 不为 null 的 trade），
   * 这样 row 没展开也能直接看到上次的狙击者——而不是「最新一笔 trade」（最新那一笔往往
   * sniper 还在分析中、first_sniper 还是 null，或者 target 本身就是第一个买入没被抢）。
   * 取值优先级：target.last_sniper > trades?.[0] > null
   */
  const sniper = target.last_sniper
    ? {
        first_sniper: target.last_sniper.address,
        first_sniper_signature: target.last_sniper.signature,
        first_sniper_offset_pos: target.last_sniper.offset_pos,
        first_sniper_offset_ms: target.last_sniper.offset_ms,
        first_sniper_tip_sol: target.last_sniper.tip_sol,
        first_sniper_prio_lamports: target.last_sniper.prio_lamports,
        first_sniper_buy_sol: target.last_sniper.buy_sol,
        first_sniper_tip_source: target.last_sniper.tip_source,
        first_sniper_slot: target.last_sniper.slot,
        first_sniper_buyer_signature: target.last_sniper.signature,
        slot: target.last_sniper.slot,
        mint: target.last_sniper.mint,
        block_time: target.last_sniper.block_time,
        // 这个 cell 不展开时 next_slot_count 没意义；展开时用户看的是 latest trade 的
        next_slot_count: latest?.next_slot_count ?? 0,
      }
    : latest;

  // 失败判定：找不到首狙、或首狙 offset 计算不出来（同 slot 没抢到、只在下一 slot 跟随）
  const sniperFailed = !!sniper && (!sniper.first_sniper || sniper.first_sniper_offset_pos === null);

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

  // 格式化「抢到 +Nms」——狙击者相对目标 tx 的时间偏移
  // 正值 = 狙击者更早（先抢到），负值 = 狙击者比目标晚（跟单）
  const renderOffsetMs = (ms: number | null | undefined) => {
    if (ms === null || ms === undefined) return null;
    // +N → 抢到（早），-N → 落后（晚）
    const color = ms > 0 ? 'text-success-600' : ms < 0 ? 'text-error-500' : 'text-gray-500';
    const prefix = ms > 0 ? '抢到' : ms < 0 ? '落后' : '同步';
    return (
      <span className={`font-mono ${color}`} title="狙击者相对目标 tx 的时间差 (ms)">
        {prefix} {ms > 0 ? '+' : ''}{ms}ms
      </span>
    );
  };

  // 时间戳格式：MM-DD HH:mm:ss（参考目标行的"最新 buy"列）
  const formatTime = (iso: string) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  return (
    <>
      <tr className="border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-zinc-700/50">
        <td className="px-3 py-3 w-40 max-w-40">
          <div className="flex items-center gap-2 min-w-0">
            <button onClick={toggleExpand} className="text-gray-500 dark:text-gray-400 shrink-0">
              {expanded ? <ChevronUpIcon className="w-4 h-4" /> : <ChevronDownIcon className="w-4 h-4" />}
            </button>
            <AddressCopy address={target.address} />
            {/* pool:xxx / auto:xxx 标签分别是 BFS 自动 promote / 自动晋升时塞进
                monitored_targets.label 的来源标记，对监控运营没有参考价值，
                只会让「监控目标」列变宽，所以这里统一隐藏。
                其他用户手动打的标签照常显示。 */}
            {target.label && !target.label.startsWith('pool:') && !target.label.startsWith('auto:') && (
              <span className="text-xs text-gray-500 dark:text-gray-400 truncate">({target.label})</span>
            )}
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
              onClick={() => {
                // 每次进入编辑都从最新 target 同步一下，避免 useEffect 还没跑或父组件传来旧值时
                // 输入框停留在上一次输入（甚至清空后的空值）。
                setThresholdVal(target.threshold_sol);
                setEditingThreshold(true);
              }}
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
        <td className="px-3 py-3 min-w-[320px]">
          {sniper ? (
            <div
              role="button"
              tabIndex={0}
              onClick={toggleSniperPanel}
              onKeyDown={(e) => e.key === 'Enter' && toggleSniperPanel()}
              className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-xs rounded-md px-1.5 py-1 -mx-1.5 hover:bg-slate-100 dark:hover:bg-zinc-700/60 transition-colors cursor-pointer ${
                sniperExpanded ? 'bg-brand-50 dark:bg-brand-500/10' : ''
              }`}
              title="点击展开该 slot 的 block 级详情"
            >
              {/* 短地址（4...4），点 cell 整体就能展开块内序面板 */}
              {sniper.first_sniper ? (
                <AddressCopy address={sniper.first_sniper} length={4} />
              ) : (
                <span className="font-mono text-gray-400">-</span>
              )}

              {/* 状态：抢到 / 落后 / 同步 / 失败 */}
              {sniperFailed ? (
                <span
                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-error-50 text-error-700 dark:bg-error-500/15 dark:text-error-400"
                  title="未在同 slot 抢到首狙（要么 sniper offset 算不出、要么只在下一 slot 跟随）"
                >
                  失败
                </span>
              ) : (
                renderOffsetMs(sniper.first_sniper_offset_ms)
              )}

              {/* tip / prio（仅在有首狙且非失败时显示） */}
              {sniper.first_sniper && !sniperFailed && (
                <span className="font-mono text-gray-600 dark:text-gray-300">
                  tip <SolAmount value={sniper.first_sniper_tip_sol} />
                  <TipSourceBadge value={sniper.first_sniper_tip_source} compact />
                  {' '}prio <PrioSolAmount value={sniper.first_sniper_prio_lamports} />
                </span>
              )}

              {/* 收益：只在样本足够（worth_score != null）且 avg_pnl_sol 非零时显示。
                    样本不足或 0 收益都直接不渲染（用户反馈：这两类不需要看）。 */}
              {decision &&
                decision.worth_score != null &&
                decision.avg_pnl_sol !== 0 && (
                  <span className="font-mono text-gray-600 dark:text-gray-300">
                    收益 <SolAmount value={decision.avg_pnl_sol} signed />
                  </span>
                )}

              {/* 块内序 +X */}
              {!sniperFailed && renderOffset(sniper.first_sniper_offset_pos)}

              {/* 下slot = 跟随者落到了 slot+1 */}
              {(sniper.next_slot_count ?? 0) > 0 && (
                <span
                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-warning-50 text-warning-700 dark:bg-warning-500/15 dark:text-warning-400"
                  title={`下一 slot 还有 ${sniper.next_slot_count} 个跟随者买入`}
                >
                  下slot
                </span>
              )}

              {/* 块内序 展开/收起 标签（置右） */}
              <span className={`text-[10px] ml-auto ${sniperExpanded ? 'text-brand-500' : 'text-gray-400'}`}>
                {sniperExpanded ? '收起 ▴' : '块内序 ▾'}
              </span>
            </div>
          ) : (
            <span className="text-xs text-gray-400">-</span>
          )}
        </td>
        <td className="px-3 py-3 text-right">
          <div className="flex items-center justify-end gap-1 text-xs">
            <button onClick={toggleExpand} className="text-gray-500 dark:text-gray-400 hover:text-brand-500">{expanded ? '收起' : '展开'}</button>
            <span className="text-gray-300">|</span>
            <button
              onClick={() => {
                setThresholdVal(target.threshold_sol);
                setEditingThreshold(true);
              }}
              className="text-gray-500 dark:text-gray-400 hover:text-brand-500"
            >阈值</button>
            <span className="text-gray-300">|</span>
            {target.status === 'active' ? (
              <button onClick={() => onPause(target.id)} className="text-gray-500 dark:text-gray-400 hover:text-warning-500">暂停</button>
            ) : (
              <button onClick={() => onResume(target.id)} className="text-gray-500 dark:text-gray-400 hover:text-success-500">继续</button>
            )}
            <span className="text-gray-300">|</span>
            <button onClick={() => onClear(target)} className="text-gray-500 dark:text-gray-400 hover:text-brand-500">清记录</button>
            <span className="text-gray-300">|</span>
            <button onClick={() => onDelete(target)} className="text-gray-500 dark:text-gray-400 hover:text-error-500">删除</button>
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
                      <th className="py-2 px-2 text-center">tip 渠道</th>
                      <th className="py-2 px-2 text-left">首狙</th>
                      <th className="py-2 px-2 text-right">狙击 TIP</th>
                      <th className="py-2 px-2 text-right">狙击 PRIO</th>
                      <th className="py-2 px-2 text-right">跟单 SLOT</th>
                      <th className="py-2 px-2 text-center">狙击→</th>
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
                          {t.is_bundled ? (
                            <span
                              className="inline-flex items-center gap-1 text-success-600 dark:text-success-400 cursor-help"
                              title={
                                `jito bundle\n` +
                                `tip: ${t.target_tip_sol ?? '0'} SOL\n` +
                                `has_alt: ${t.has_alt === true ? '✓' : t.has_alt === false ? '×' : '?'}\n` +
                                (t.bundle_id ? `bundle_id: ${t.bundle_id}\n` : '') +
                                (t.bundle_size && t.bundle_size > 1
                                  ? `同 bundle 共 ${t.bundle_size} 笔`
                                  : '')
                              }
                            >
                              <span>✓</span>
                              {t.bundle_size && t.bundle_size > 1 && (
                                <span className="font-mono text-[10px] text-gray-600 dark:text-gray-400">
                                  {t.bundle_size}笔
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-gray-300">-</span>
                          )}
                        </td>
                        <td className="py-1.5 px-2 text-center">
                          <TipSourceBadge value={t.tip_source} compact />
                        </td>
                        <td className="py-1.5 px-2">
                          {t.first_sniper ? (
                            <div className="flex flex-col gap-0.5">
                              <AddressCopy address={t.first_sniper} />
                              <SolAmount value={t.first_sniper_buy_sol} />
                              {renderOffsetMs(t.first_sniper_offset_ms)}
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
                        <td className="py-1.5 px-2 text-center font-mono text-xs">
                          {(() => {
                            const same = t.same_slot_count ?? 0;
                            const next = t.next_slot_count ?? 0;
                            const total = same + next;
                            if (total === 0) return <span className="text-gray-300">-</span>;
                            return (
                              <span title={`同 slot ${same} + 下一 slot ${next}`} className="text-gray-700 dark:text-gray-300">
                                {total}
                              </span>
                            );
                          })()}
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
