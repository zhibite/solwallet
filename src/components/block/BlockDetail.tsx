"use client";
import React, { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import AddressCopy from "@/components/common/AddressCopy";
import SolAmount from "@/components/common/SolAmount";
import RelativeTime from "@/components/common/RelativeTime";

interface Buyer {
  id: number;
  block_index: number;
  offset_ms: number;
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
}

interface Analysis {
  id: number;
  slot: number;
  mint: string;
  target_signature: string;
  block_time: string;
}

export default function BlockDetail() {
  const params = useParams<{ slot: string; mint: string }>();
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [buyers, setBuyers] = useState<Buyer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recalculating, setRecalculating] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/block/${params.slot}/${params.mint}`);
      const json = await res.json();
      if (!json.ok) {
        setError(json.error || '未找到该 block 分析');
        return;
      }
      setAnalysis(json.data.analysis);
      setBuyers(json.data.buyers);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [params.slot, params.mint]);

  const recalc = async (buyerId: number) => {
    setRecalculating(buyerId);
    try {
      // 简化：直接重跑 analyzeBlock 并刷新
      await fetch('/api/analyze/block', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot: parseInt(params.slot, 10), mint: params.mint }),
      });
      await load();
    } finally {
      setRecalculating(null);
    }
  };

  const setAsCopyTrader = async (address: string) => {
    await fetch('/api/wallets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, label: `from block ${params.slot}` }),
    });
    alert(`已加入自己钱包: ${address.slice(0, 8)}...`);
  };

  if (loading) return <div className="p-6 text-center text-gray-500 dark:text-gray-400">加载中...</div>;
  if (error) return <div className="p-6 text-center text-error-500">{error}</div>;
  if (!analysis) return null;

  // 统计
  const targetIdx = buyers.findIndex((b) => b.signature === analysis.target_signature);
  const sameSlotCount = buyers.length;
  const firstSniper = buyers.find((b) => b.is_first_sniper);
  const myWallets = buyers.filter((b) => b.is_own);

  return (
    <div className="space-y-4">
      {/* 头部信息 */}
      <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <h1 className="text-lg font-semibold text-gray-800 dark:text-white/90 mb-3">
          Block 级深度分析
        </h1>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <div>
            <span className="text-gray-500 dark:text-gray-400">目标交易：</span>
            <span className="font-mono text-xs text-gray-800 dark:text-white/90">{analysis.target_signature}</span>
          </div>
          <div>
            <span className="text-gray-500 dark:text-gray-400">MINT：</span>
            <AddressCopy address={analysis.mint} length={6} />
          </div>
          <div>
            <span className="text-gray-500 dark:text-gray-400">SLOT：</span>
            <span className="font-mono text-gray-800 dark:text-white/90">{analysis.slot}</span>
            <a
              href={`https://solscan.io/block/${analysis.slot}`}
              target="_blank"
              rel="noreferrer"
              className="ml-2 text-brand-500 hover:underline text-xs"
            >
              在 Solscan 查看
            </a>
          </div>
          <div>
            <span className="text-gray-500 dark:text-gray-400">时间：</span>
            <RelativeTime iso={analysis.block_time} />
            <span className="ml-1 text-gray-400 text-xs">
              ({new Date(analysis.block_time).toLocaleString()})
            </span>
          </div>
        </div>

        {/* 上下文统计 */}
        <div className="mt-4 pt-3 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-600 dark:text-gray-400">
          <p>
            <span className="font-semibold text-gray-800 dark:text-white/90">{sameSlotCount}</span> 笔交易 (含失败的) 在同一个 slot 内。
            {myWallets.length > 0 && (
              <span className="ml-2">
                我的账号排位: {myWallets.map((w) => `#${w.block_index + 1}`).join(', ')}
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Block 内每笔交易 */}
      <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-white/90">Slot 内所有交易（{buyers.length} 笔）</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-zinc-700/50 text-xs text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 text-left">块内序</th>
                <th className="px-3 py-2 text-right">偏移 (ms)</th>
                <th className="px-3 py-2 text-left">标记</th>
                <th className="px-3 py-2 text-left">地址</th>
                <th className="px-3 py-2 text-right">买入 SOL</th>
                <th className="px-3 py-2 text-right">TIP</th>
                <th className="px-3 py-2 text-right">优先级费</th>
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
                    <td className="px-3 py-2 font-mono text-xs text-gray-800 dark:text-white/90">{b.block_index + 1}</td>
                    <td className={`px-3 py-2 text-right font-mono text-xs ${b.offset_ms > 0 ? 'text-error-500' : b.offset_ms < 0 ? 'text-success-600' : 'text-gray-500 dark:text-gray-400'}`}>
                      {b.offset_ms > 0 ? '+' : ''}{b.offset_ms}
                    </td>
                    <td className="px-3 py-2">
                      {isTarget ? <Badge color="brand">目标</Badge> :
                       b.is_first_sniper ? <Badge color="success">第一个狙击者</Badge> :
                       b.is_own ? <Badge color="warning">我的账号</Badge> :
                       b.is_pre_target ? <Badge color="gray">前置</Badge> :
                       <Badge color="info">跟随</Badge>}
                      {b.is_bundled && <span className="ml-1 text-xs text-success-500" title="bundled">⚡</span>}
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
                    <td className="px-3 py-2 text-right font-mono text-xs">{b.prio_lamports || 0}</td>
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
                      <div className="flex items-center justify-center gap-2 text-xs">
                        <button
                          onClick={() => recalc(b.id)}
                          className="text-gray-500 dark:text-gray-400 hover:text-brand-500"
                          title="重算"
                        >
                          重算
                        </button>
                        {!b.is_own && (
                          <button
                            onClick={() => setAsCopyTrader(b.address)}
                            className="text-gray-500 dark:text-gray-400 hover:text-success-500"
                            title="设为跟单者"
                          >
                            +
                          </button>
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
          <li>看 <strong>第一个狙击者</strong> 的 TIP 和 PRIO，反推合理的抢单参数</li>
          <li>对比 <strong>我的账号</strong> 的 offset，如果 +X ms 表示慢了几毫秒</li>
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
