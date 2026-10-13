"use client";
import React, { useEffect, useState } from "react";
import AddressCopy from "@/components/common/AddressCopy";
import SolAmount from "@/components/common/SolAmount";
import PrioSolAmount from "@/components/common/PrioSolAmount";
import RelativeTime from "@/components/common/RelativeTime";
import { useConfirm } from "@/components/ui/confirm-dialog";

interface BlockDetailViewProps {
  /** Slot 编号 */
  slot: number;
  /** Token mint */
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
  result: string;
  version: string;
  is_bundled: boolean;
  has_alt: boolean | null;
  bundle_id: string | null;
  bundle_size: number | null;
  /** 0010: 该笔的 tip 渠道（null = 未付 tip；'unknown' = 付了但不在 4 通道列表里） */
  tip_source: import('@/lib/types').TipSource | null;
}

interface Analysis {
  id: number;
  slot: number;
  mint: string;
  target_signature: string;
  block_time: string;
  target_block_index: number | null;
  same_slot_count: number;
  next_slot_count: number;
}

/**
 * 纯展示版：从 props 接收 slot + mint（路由层 / 监控页内联展开都用同一个）
 * 不依赖 useParams，便于在任意父组件里内联调用。
 */
export default function BlockDetailView({ slot, mint }: BlockDetailViewProps) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recalculating, setRecalculating] = useState(false);
  const [bulkPnl, setBulkPnl] = useState<{
    running: boolean;
    /** 上次跑完的结果摘要（错误也记） */
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
        body: JSON.stringify({
          slot,
          mint,
          targetSig: analysis?.target_signature,
        }),
      });
      await load();
    } finally {
      setRecalculating(false);
    }
  };

  /**
   * 批量算所有 buyer 的跟单收益（受 BULK_PNL_CONCURRENCY=4 控制）
   *
   * 行为：
   *   - 默认跳过已经算过的（pnl_status 非空）
   *   - force=true 时重算所有人
   *   - 失败 tx (result='failed') 永远跳过
   *
   * 不在 UI 上显示「n/total」进度 —— 这个接口是 HTTP 单次返回，
   * 没法流式推回进度。给用户一个转圈 + 「算收益中…」即可，结果出来后
   * 直接合并进本地 state（避免再 load() 闪一下）。
   */
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
      // 把后端返回的结果合并进本地 buyers list —— 避免再 load() 闪一下
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
      setBulkPnl({
        running: false,
        lastSummary: { computed: json.computed, skipped: json.skipped, errors },
      });
      if (errors > 0) {
        await alert({
          title: '批量算收益完成（有错误）',
          description: `算 ${json.computed} · 跳 ${json.skipped} · 失败 ${errors}（查看浏览器 console）`,
          variant: 'warning',
        });
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
    await alert({
      title: '已加入跟单库',
      description: `${address.slice(0, 8)}... 已标记为跟单钱包`,
      variant: 'success',
    });
    await load();
  };

  /** 行级：算 / 重算 该 buyer 的单笔跟单收益 */
  const calcBuyerPnL = async (buyerId: number) => {
    const res = await fetch(`/api/block/${slot}/${mint}/buyer/${buyerId}/pnl`, {
      method: 'POST',
    });
    const json = await res.json();
    if (!json.ok) {
      await alert({ title: '算收益失败', description: json.error, variant: 'danger' });
      return;
    }
    // 局部更新
    setBuyers((prev) =>
      prev.map((b) =>
        b.id === buyerId
          ? {
              ...b,
              pnl_sol: json.pnl_sol !== null ? String(json.pnl_sol) : null,
              pnl_status: json.pnl_status ?? null,
              pnl_sold_ratio: json.sold_ratio != null ? String(json.sold_ratio) : null,
            }
          : b,
      ),
    );
  };

  /** 行级：取消算（清空 pnl_sol / pnl_status / pnl_sold_ratio） */
  const clearBuyerPnL = async (buyerId: number) => {
    const res = await fetch(`/api/block/${slot}/${mint}/buyer/${buyerId}/pnl`, {
      method: 'DELETE',
    });
    if (res.ok) {
      setBuyers((prev) =>
        prev.map((b) =>
          b.id === buyerId ? { ...b, pnl_sol: null, pnl_status: null, pnl_sold_ratio: null } : b,
        ),
      );
    }
  };

  /** 行级：取消认定（从 own_wallets 删除该地址 + 重跑 block 分析） */
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
      // 重跑分析，让 is_own 标记更新
      const sig = analysis?.target_signature;
      await fetch('/api/analyze/block', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slot,
          mint,
          targetSig: sig,
        }),
      });
      await load();
    } finally {
      setRecalculating(false);
    }
  };

  if (loading) return <div className="p-6 text-center text-gray-500 dark:text-gray-400">加载中...</div>;
  if (error) return <div className="p-6 text-center text-error-500">{error}</div>;
  if (!analysis) return null;

  const targetIdx = analysis.target_block_index;
  const sameSlotCount = analysis.same_slot_count || buyers.filter((b) => b.slot_offset === 0).length;
  const nextSlotCount = analysis.next_slot_count || buyers.filter((b) => b.slot_offset === 1).length;
  const totalCount = buyers.length;
  const myWallets = buyers.filter((b) => b.is_own);
  const firstSniper = buyers.find((b) => b.is_first_sniper);

  return (
    <div className="space-y-4">
      {/* 头部信息 */}
      <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <h1 className="text-lg font-semibold text-gray-800 dark:text-white/90 mb-3">
          Block 级深度分析
        </h1>
        <div className="text-sm text-gray-700 dark:text-gray-300 space-y-1.5">
          <p>
            目标{' '}
            {(() => {
              const target = buyers.find((b) => b.signature === analysis.target_signature);
              return target ? <AddressCopy address={target.address} length={6} /> : <span className="font-mono text-xs">{analysis.target_signature.slice(0, 8)}...</span>;
            })()}
            {' '}在 slot{' '}
            <span className="font-mono">{analysis.slot}</span>
            {targetIdx !== null && (
              <>
                {' '}
                (块内第 <span className="font-mono text-brand-500 font-semibold">{targetIdx + 1}</span> 笔) 买入{' '}
              </>
            )}
            <a
              href={`https://solscan.io/block/${analysis.slot}`}
              target="_blank"
              rel="noreferrer"
              className="ml-1 text-brand-500 hover:underline text-xs"
            >
              solscan ↗
            </a>
          </p>
          <p className="text-xs text-gray-600 dark:text-gray-400">
            同一 slot 里 <span className="font-semibold text-gray-800 dark:text-white/90">{sameSlotCount}</span> 笔
            {nextSlotCount > 0 && (
              <>
                ，下一个 slot 里 <span className="font-semibold text-gray-800 dark:text-white/90">{nextSlotCount}</span> 笔
              </>
            )}
            ，共 <span className="font-semibold text-gray-800 dark:text-white/90">{totalCount}</span> 笔（含失败的）
            {myWallets.length > 0 && (
              <span className="ml-2">
                · 我的账号排位: {myWallets.map((w) => {
                  const relPos = targetIdx !== null ? w.block_index - targetIdx : w.block_index + 1;
                  return `#${w.block_index + 1} (${relPos > 0 ? '+' : ''}${relPos})`;
                }).join(', ')}
              </span>
            )}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            时间: <RelativeTime iso={analysis.block_time} />{' '}
            <span className="text-gray-400">({new Date(analysis.block_time).toLocaleString()})</span>
          </p>
        </div>
      </div>

      {/* Block 内每笔交易 */}
      <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-white/90">
            Slot 内所有交易（{totalCount} 笔）
          </h2>
          <div className="flex items-center gap-2 flex-wrap">
            {bulkPnl.running && (
              <span className="text-xs text-brand-600 dark:text-brand-400 inline-flex items-center gap-1.5">
                <span className="inline-block w-3 h-3 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                批量算收益中（10-40s，受 Helius 速度影响）…
              </span>
            )}
            {!bulkPnl.running && bulkPnl.lastSummary && (
              <span
                className="text-xs text-gray-500 dark:text-gray-400"
                title={`重算 ${bulkPnl.lastSummary.computed} 笔 · 跳过 ${bulkPnl.lastSummary.skipped} 笔 · 失败 ${bulkPnl.lastSummary.errors} 笔`}
              >
                上次: 算 {bulkPnl.lastSummary.computed} · 跳 {bulkPnl.lastSummary.skipped}
                {bulkPnl.lastSummary.errors > 0 && (
                  <span className="text-error-500 ml-1">· 失败 {bulkPnl.lastSummary.errors}</span>
                )}
              </span>
            )}
            <button
              onClick={() => runBulkPnl(false)}
              disabled={bulkPnl.running || recalculating}
              className="text-xs px-3 py-1 rounded-lg bg-brand-500/10 text-brand-700 dark:text-brand-400 hover:bg-brand-500/20 disabled:opacity-50"
              title="并行算所有 buyer 的 PnL，跳过已算过/失败的"
            >
              批量算收益
            </button>
            <button
              onClick={() => runBulkPnl(true)}
              disabled={bulkPnl.running || recalculating}
              className="text-xs px-3 py-1 rounded-lg bg-slate-100 dark:bg-zinc-700 hover:bg-slate-200 dark:hover:bg-zinc-600 text-gray-600 dark:text-gray-300 disabled:opacity-50"
              title="强制重算所有 buyer（包含已算过的）"
            >
              重算全部
            </button>
            <button
              onClick={recalc}
              disabled={recalculating || bulkPnl.running}
              className="text-xs px-3 py-1 rounded-lg bg-slate-100 dark:bg-zinc-700 hover:bg-slate-200 dark:hover:bg-zinc-600 text-gray-600 dark:text-gray-300 disabled:opacity-50"
              title="重跑 block 分析（重识别首狙/跟随/自己账号）"
            >
              {recalculating ? '分析中…' : '重分析'}
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-zinc-700/50 text-xs text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 text-left">块内序</th>
                <th className="px-3 py-2 text-right">偏移</th>
                <th className="px-3 py-2 text-left">标记</th>
                <th className="px-3 py-2 text-left">地址</th>
                <th className="px-3 py-2 text-right">买入 SOL</th>
                <th className="px-3 py-2 text-right">TIP</th>
                <th className="px-3 py-2 text-right">优先费</th>
                <th className="px-3 py-2 text-right">跟单收益</th>
                <th className="px-3 py-2 text-center">结果</th>
                <th className="px-3 py-2 text-center">版本</th>
                <th className="px-3 py-2 text-center">TX</th>
                <th className="px-3 py-2 text-center">操作</th>
              </tr>
            </thead>
            <tbody>
              {buyers.map((b) => {
                const isTarget = b.signature === analysis.target_signature;
                const offsetColor =
                  b.slot_offset === 1
                    ? 'text-purple-500'
                    : b.offset_pos === null
                      ? 'text-gray-500 dark:text-gray-400'
                      : b.offset_pos > 0
                        ? 'text-error-500'
                        : b.offset_pos < 0
                          ? 'text-success-600'
                          : 'text-gray-500 dark:text-gray-400';
                return (
                  <tr
                    key={b.id}
                    className={`border-b border-gray-100 dark:border-gray-700/50 ${
                      // 截图风格：目标 = 浅品牌色、首狙 = 浅红、我的账号 = 浅绿
                      // 标记 pill 已在"标记"列里，行底色作为辅助视觉
                      isTarget
                        ? 'bg-brand-50 dark:bg-brand-500/10'
                        : b.is_first_sniper
                          ? 'bg-red-50 dark:bg-red-500/10'
                          : b.is_own
                            ? 'bg-success-50 dark:bg-success-500/10'
                            : ''
                    }`}
                  >
                    <td className="px-3 py-2 font-mono text-xs text-gray-800 dark:text-white/90">
                      {b.block_index + 1}
                      {b.slot_offset === 1 && <span className="ml-1 text-purple-500" title="下一 slot">+1</span>}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono text-xs ${offsetColor}`}>
                      {b.slot_offset === 1
                        ? 'slot+1'
                        : b.offset_pos === null
                          ? '0'
                          : b.offset_pos > 0
                            ? `+${b.offset_pos}`
                            : b.offset_pos}
                    </td>
                    <td className="px-3 py-2">
                      {/* 标记：截图风格 —— 第一个狙击者(红)、我的账号(绿)、跟随(蓝)
                          目标 / 前置 不打 pill，靠行底色区分（见上面 tr 的 className） */}
                      {b.is_first_sniper ? <Badge color="red">第一个狙击者</Badge> :
                       b.is_own ? <Badge color="success">我的账号</Badge> :
                       <Badge color="info">跟随</Badge>}
                      {b.is_bundled && (
                        <span
                          className="ml-1 text-xs text-success-500 cursor-help"
                          title={
                            `bundle\n` +
                            `tip: ${b.tip_sol ?? '0'} SOL\n` +
                            (b.tip_source ? `channel: ${b.tip_source}\n` : '') +
                            `has_alt: ${b.has_alt === true ? '✓' : b.has_alt === false ? '×' : '?'}\n` +
                            (b.bundle_id ? `bundle_id: ${b.bundle_id}\n` : '') +
                            (b.bundle_size && b.bundle_size > 1
                              ? `同 bundle 共 ${b.bundle_size} 笔`
                              : '')
                          }
                        >
                          ⚡{b.bundle_size && b.bundle_size > 1 ? (
                            <span className="font-mono text-[10px] ml-0.5">{b.bundle_size}</span>
                          ) : null}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <AddressCopy address={b.address} length={4} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <SolAmount value={b.buy_sol} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <SolAmount value={b.tip_sol} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <PrioSolAmount value={b.prio_lamports} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      {b.pnl_status === 'open' ? (
                        <span className="font-mono text-xs text-warning-500" title="这笔买入的 token 还没卖出，收益未实现">
                          持仓中
                        </span>
                      ) : b.pnl_status === 'buy_failed' ? (
                        <span className="font-mono text-xs text-error-500" title="买入交易失败，成本只有手续费">
                          买入失败
                        </span>
                      ) : b.pnl_sol ? (
                        <>
                          <SolAmount value={b.pnl_sol} signed />
                          {b.pnl_status === 'partial' && b.pnl_sold_ratio && (
                            <span
                              className="ml-1 text-[10px] text-brand-500"
                              title={`这笔买入的 token 只卖出了 ${(parseFloat(b.pnl_sold_ratio) * 100).toFixed(0)}%，这里只统计已实现部分`}
                            >
                              {(parseFloat(b.pnl_sold_ratio) * 100).toFixed(0)}%
                            </span>
                          )}
                        </>
                      ) : (
                        <SolAmount value={b.pnl_sol} signed />
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {/* 截图风格：成功/失败 用中文 pill 替代圆点+英文 */}
                      {b.result === 'success' ? (
                        <span className="inline-block px-1.5 py-0.5 rounded text-xs bg-success-500/20 text-success-700 dark:text-success-400">
                          成功
                        </span>
                      ) : (
                        <span className="inline-block px-1.5 py-0.5 rounded text-xs bg-red-500/20 text-red-700 dark:text-red-400">
                          失败
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center text-xs text-gray-500 dark:text-gray-400">{b.version}</td>
                    <td className="px-3 py-2 text-center">
                      <a
                        href={`https://solscan.io/tx/${b.signature}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-brand-500 hover:underline text-xs"
                      >
                        TX
                      </a>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <div className="flex items-center justify-center gap-2 text-xs flex-wrap">
                        {isTarget ? (
                          <span className="text-gray-400">—</span>
                        ) : b.is_own ? (
                          <button
                            onClick={() => unclaimWallet(b.id, b.address)}
                            disabled={recalculating}
                            className="text-warning-600 dark:text-warning-400 hover:text-error-500 disabled:opacity-50"
                            title="从我的账号中移除"
                          >
                            取消认定
                          </button>
                        ) : (
                          <>
                            {!b.pnl_status ? (
                              <button
                                onClick={() => calcBuyerPnL(b.id)}
                                className="text-gray-500 dark:text-gray-400 hover:text-brand-500"
                                title="对该地址算 PnL"
                              >
                                算收益
                              </button>
                            ) : (
                              <>
                                <button
                                  onClick={() => calcBuyerPnL(b.id)}
                                  className="text-gray-500 dark:text-gray-400 hover:text-brand-500"
                                  title="重新算 PnL"
                                >
                                  重算
                                </button>
                                <button
                                  onClick={() => clearBuyerPnL(b.id)}
                                  className="text-gray-500 dark:text-gray-400 hover:text-error-500"
                                  title="清空 PnL"
                                >
                                  取消算
                                </button>
                              </>
                            )}
                            <button
                              onClick={() => setAsCopyTrader(b.address)}
                              className="text-gray-500 dark:text-gray-400 hover:text-success-500"
                              title="设为跟单者"
                            >
                              设为跟单者
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* 提示卡 */}
      <div className="bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/30 rounded-lg p-4 text-xs text-blue-900 dark:text-blue-300">
        <p className="font-medium mb-1">💡 复盘建议</p>
        <ul className="list-disc list-inside space-y-1">
          <li>看 <strong>首狙</strong> 的 TIP 和 PRIO，反推合理的抢单参数</li>
          <li><strong>偏移</strong>列：正值（红）= 在目标之后多花了 N 笔 tx 才轮到他；负值（绿）= 抢先了 N 笔 tx</li>
          <li><strong>slot+1</strong>（紫）= 跟随者落在了下一个 slot</li>
          <li>关注 <strong>跟随者</strong> 的 buy_sol，看市场跟随热度</li>
          <li><strong>失败</strong> 的交易会损失 priority fee + tip</li>
        </ul>
      </div>
    </div>
  );
}

function Badge({ color, children }: { color: 'red' | 'success' | 'warning' | 'info'; children: React.ReactNode }) {
  const colors = {
    // 红：第一个狙击者（醒目，跟"成功/跟单"色系拉开）
    red: 'bg-red-500/20 text-red-700 dark:text-red-400 border border-red-500/30',
    // 绿：我的账号（用户视角的"我"，用中性成功色）
    success: 'bg-success-500/20 text-success-700 dark:text-success-400',
    // 黄：保留 —— 万一以后要复用
    warning: 'bg-warning-500/20 text-warning-700 dark:text-warning-400',
    // 蓝：跟随者
    info: 'bg-blue-500/20 text-blue-700 dark:text-blue-400',
  };
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs ${colors[color]}`}>
      {children}
    </span>
  );
}