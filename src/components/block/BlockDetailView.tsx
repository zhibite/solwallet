"use client";
import React, { useEffect, useState } from "react";
import AddressCopy from "@/components/common/AddressCopy";
import SolAmount from "@/components/common/SolAmount";
import PrioSolAmount from "@/components/common/PrioSolAmount";
import RelativeTime from "@/components/common/RelativeTime";

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

  const setAsCopyTrader = async (address: string) => {
    await fetch('/api/wallets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, label: `from block ${slot}` }),
    });
    alert(`已加入跟单钱包: ${address.slice(0, 8)}...`);
    await load();
  };

  /** 行级：算 / 重算 该 buyer 的 PnL */
  const calcBuyerPnL = async (buyerId: number) => {
    const res = await fetch(`/api/block/${slot}/${mint}/buyer/${buyerId}/pnl`, {
      method: 'POST',
    });
    const json = await res.json();
    if (!json.ok) {
      alert(`算收益失败: ${json.error}`);
      return;
    }
    // 局部更新
    setBuyers((prev) =>
      prev.map((b) => (b.id === buyerId ? { ...b, pnl_sol: json.pnl_sol !== null ? String(json.pnl_sol) : null } : b)),
    );
  };

  /** 行级：取消算（清空 pnl_sol） */
  const clearBuyerPnL = async (buyerId: number) => {
    const res = await fetch(`/api/block/${slot}/${mint}/buyer/${buyerId}/pnl`, {
      method: 'DELETE',
    });
    if (res.ok) {
      setBuyers((prev) => prev.map((b) => (b.id === buyerId ? { ...b, pnl_sol: null } : b)));
    }
  };

  /** 行级：取消认定（从 own_wallets 删除该地址 + 重跑 block 分析） */
  const unclaimWallet = async (buyerId: number, address: string) => {
    if (!confirm('取消对该钱包的「我的账号」认定？')) return;
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
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-white/90">
            Slot 内所有交易（{totalCount} 笔）
          </h2>
          <button
            onClick={recalc}
            disabled={recalculating}
            className="text-xs px-3 py-1 rounded-lg bg-slate-100 dark:bg-zinc-700 hover:bg-slate-200 dark:hover:bg-zinc-600 text-gray-600 dark:text-gray-300 disabled:opacity-50"
          >
            {recalculating ? '算收益中...' : '算收益'}
          </button>
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
                <th className="px-3 py-2 text-right">优先级费 (SOL)</th>
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
                      isTarget
                        ? 'bg-brand-50 dark:bg-brand-500/10'
                        : b.is_first_sniper
                          ? 'bg-success-50 dark:bg-success-500/10'
                          : b.is_own
                            ? 'bg-warning-50 dark:bg-warning-500/10'
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
                      {isTarget ? <Badge color="brand">目标</Badge> :
                       b.is_first_sniper ? <Badge color="success">首狙</Badge> :
                       b.is_own ? <Badge color="warning">我的账号</Badge> :
                       b.is_pre_target ? <Badge color="gray">前置</Badge> :
                       <Badge color="info">跟随</Badge>}
                      {b.is_bundled && (
                        <span
                          className="ml-1 text-xs text-success-500 cursor-help"
                          title={
                            `jito bundle\n` +
                            `tip: ${b.tip_sol ?? '0'} SOL\n` +
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
                      <SolAmount value={b.pnl_sol} signed />
                    </td>
                    <td className="px-3 py-2 text-center">
                      {b.result === 'success' ? (
                        <span className="inline-block w-2 h-2 rounded-full bg-success-500"></span>
                      ) : (
                        <span className="inline-block w-2 h-2 rounded-full bg-error-500"></span>
                      )}
                      <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">{b.result}</span>
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
                            {!b.pnl_sol ? (
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

function Badge({ color, children }: { color: 'brand' | 'success' | 'warning' | 'info' | 'gray'; children: React.ReactNode }) {
  const colors = {
    brand: 'bg-brand-500/20 text-brand-600 dark:text-brand-400',
    success: 'bg-success-500/20 text-success-700 dark:text-success-400',
    warning: 'bg-warning-500/20 text-warning-700 dark:text-warning-400',
    info: 'bg-blue-500/20 text-blue-700 dark:text-blue-400',
    gray: 'bg-gray-200 dark:bg-zinc-700 text-gray-600 dark:text-gray-300',
  };
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs ${colors[color]}`}>
      {children}
    </span>
  );
}