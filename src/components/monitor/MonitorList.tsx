"use client";
import React, { useState, useEffect, useCallback } from "react";
import { useConfirm } from "@/components/ui/confirm-dialog";
import AddTargetForm from "./AddTargetForm";
import TargetRow from "./TargetRow";

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
   * 最近一笔 first_sniper 不为 null 的 trade（= 真正被抢过的最新一笔）。
   * 之所以不直接用「最新一笔 trade」是因为那一笔的 first_sniper 经常是 null：
   * 刚发生没分析完 / target 本身就是第一个买入的。null 表示"从来没被抢过"或"还没 trade"。
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
  decision?: {
    /** null = 样本不足算不出分，不是 0 分 */
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

interface Stats {
  activeTargets: number;
  recordedBuys: number;
  pending: number;
  analyzed: number;
}

/** 弹框里显示地址时省略中间，避免撑破布局 */
const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

export default function MonitorList() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false); // 静默刷新，不遮挡列表
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'paused'>('all');
  const [busy, setBusy] = useState<null | 'cleanup' | 'clearAll'>(null);
  const { confirm, alert } = useConfirm();

  const load = useCallback(async (isSilent = false) => {
    if (isSilent) setRefreshing(true);
    else setLoading(true);
    try {
      const [tRes, sRes] = await Promise.all([
        fetch('/api/targets').then((r) => r.json()),
        fetch('/api/stats').then((r) => r.json()),
      ]);
      if (tRes.ok) setTargets(tRes.data);
      if (sRes.ok) setStats(sRes.data);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load(false);
    const t = setInterval(() => load(true), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const handleAdd = async (data: { address: string; label?: string; threshold_sol: number }) => {
    const res = await fetch('/api/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);
    await load(false);
  };

  const handlePause = async (id: number) => { await fetch(`/api/targets/${id}/pause`, { method: 'POST' }); load(true); };
  const handleResume = async (id: number) => { await fetch(`/api/targets/${id}/resume`, { method: 'POST' }); load(true); };

  const handleDelete = async (t: Target) => {
    const ok = await confirm({
      title: '删除监控目标？',
      description: (
        <>
          即将删除 <span className="font-mono">{short(t.address)}</span>
          {t.label && !t.label.startsWith('pool:') && !t.label.startsWith('auto:') && <> （{t.label}）</>} 及其名下的全部 buy 记录，此操作不可撤销。
        </>
      ),
      confirmText: '删除',
      variant: 'danger',
    });
    if (!ok) return;
    const res = await fetch(`/api/targets/${t.id}`, { method: 'DELETE' });
    const json = await res.json().catch(() => null);
    if (json && json.ok === false) {
      await alert({ title: '删除失败', description: json.error, variant: 'danger' });
    }
    load(true);
  };

  const handleClear = async (t: Target) => {
    const ok = await confirm({
      title: '清空该目标的记录？',
      description: (
        <>
          将删除 <span className="font-mono">{short(t.address)}</span> 名下的{' '}
          <span className="font-semibold">{t.record_count}</span> 条 buy 记录，监控目标本身会保留。此操作不可撤销。
        </>
      ),
      confirmText: '清空记录',
      variant: 'warning',
    });
    if (!ok) return;
    const res = await fetch(`/api/targets/${t.id}/clear`, { method: 'POST' });
    const json = await res.json().catch(() => null);
    if (json && json.ok === false) {
      await alert({ title: '清空失败', description: json.error, variant: 'danger' });
    }
    load(true);
  };

  const handleThreshold = async (id: number, val: number) => {
    await fetch(`/api/targets/${id}/threshold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threshold_sol: val }),
    });
    load(true);
  };

  const handleCleanup = async () => {
    const ok = await confirm({
      title: '清理 30 天前的旧记录？',
      description: '会删除全部监控目标中 30 天前的 buy 记录，保留监控目标本身。此操作不可撤销。',
      confirmText: '开始清理',
      variant: 'warning',
    });
    if (!ok) return;
    setBusy('cleanup');
    try {
      const res = await fetch('/api/targets/cleanup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const json = await res.json();
      if (json.ok) {
        await alert({ title: '清理完成', description: `已清理 ${json.deleted} 条旧记录`, variant: 'success' });
      } else {
        await alert({ title: '清理失败', description: json.error, variant: 'danger' });
      }
      await load(false);
    } finally {
      setBusy(null);
    }
  };

  const handleClearAll = async () => {
    const ok = await confirm({
      title: '清空全部监控记录？',
      description: '会删除所有监控目标下的全部 buy 记录与分析结果，监控目标本身保留。此操作不可撤销。',
      confirmText: '我确定，全部清空',
      variant: 'danger',
    });
    if (!ok) return;
    setBusy('clearAll');
    try {
      const res = await fetch('/api/targets/clear-all', { method: 'POST' });
      const json = await res.json();
      if (json.ok) {
        await alert({
          title: '已清空',
          description: `共删除 ${json.deleted.trades} 条交易、${json.deleted.analyses} 条分析`,
          variant: 'success',
        });
      } else {
        await alert({ title: '清空失败', description: json.error, variant: 'danger' });
      }
      await load(false);
    } finally {
      setBusy(null);
    }
  };

  // 监控列表按「距现在时间」降序：最近买过的目标排前；
  // last_buy_at 为 null 的目标（从未触发 buy）排到末尾。
  const filtered = targets
    .filter((t) => statusFilter === 'all' || t.status === statusFilter)
    .sort((a, b) => {
      const ta = a.last_buy_at ? Date.parse(a.last_buy_at) : null;
      const tb = b.last_buy_at ? Date.parse(b.last_buy_at) : null;
      if (ta === null && tb === null) return 0;
      if (ta === null) return 1;   // a 没数据 → 排后
      if (tb === null) return -1;  // b 没数据 → 排后
      return tb - ta;              // 降序：越新越靠前
    });

  return (
    <div className="space-y-4">
      {/* 顶部统计 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="监控中" value={stats?.activeTargets ?? '-'} />
        <StatCard label="已记录 buy" value={stats?.recordedBuys ?? '-'} />
        <StatCard label="待分析" value={stats?.pending ?? '-'} />
        <StatCard label="已分析" value={stats?.analyzed ?? '-'} />
      </div>

      {/* 添加目标 + 全局操作 */}
      <AddTargetForm onAdd={handleAdd} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium text-gray-800 dark:text-white/90">监控列表</span>
          <span className="text-xs text-gray-500 dark:text-gray-400">共 {filtered.length} 个</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => load(true)}
            className="h-8 px-3 rounded-lg bg-slate-100 dark:bg-zinc-700 hover:bg-slate-200 dark:hover:bg-zinc-600 text-gray-600 dark:text-gray-300 text-xs flex items-center gap-1"
          >
            <span className={`inline-block w-3 h-3 rounded-full border border-current ${refreshing ? 'animate-spin' : ''}`} style={{ borderTopColor: 'transparent' }} />
            {refreshing ? '刷新中' : '刷新'}
          </button>
          <button
            onClick={handleCleanup}
            disabled={busy !== null}
            className="h-8 px-3 rounded-lg bg-slate-100 dark:bg-zinc-700 hover:bg-slate-200 dark:hover:bg-zinc-600 text-gray-600 dark:text-gray-300 text-xs disabled:opacity-50"
          >
            {busy === 'cleanup' ? '清理中...' : '清理旧记录'}
          </button>
          <button
            onClick={handleClearAll}
            disabled={busy !== null}
            className="h-8 px-3 rounded-lg bg-error-500/10 hover:bg-error-500/20 text-error-600 dark:text-error-400 text-xs disabled:opacity-50"
          >
            {busy === 'clearAll' ? '清空中...' : '清空全部记录'}
          </button>
        </div>
      </div>

      {/* 列表 */}
      <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="flex items-center justify-between p-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2 text-xs">
            {(['all', 'active', 'paused'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setStatusFilter(f)}
                className={`px-3 py-1 rounded-xl ${
                  statusFilter === f
                    ? 'bg-brand-500 text-white'
                    : 'bg-slate-100 dark:bg-zinc-700 text-gray-500 dark:text-gray-400 hover:bg-slate-200 dark:hover:bg-zinc-600'
                }`}
              >
                {f === 'all' ? '全部' : f === 'active' ? '监控中' : '已暂停'}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-zinc-800/50 text-xs text-gray-500 dark:text-gray-400">
              <tr>
                {/* 监控目标：地址仅显 6…6 缩写，固定窄宽让后续列靠左 */}
                <th className="px-3 py-2 text-left font-medium w-40 whitespace-nowrap">监控目标</th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">阈值</th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">状态</th>
                <th className="px-3 py-2 text-center font-medium whitespace-nowrap">记录数</th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">最新 buy</th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">距现在</th>
                {/* 把「最近一次 首狙」+「决策 (推荐 tip+prio / 评分)」两列合并：
                    一个目标在一行就能看清「这个狙击者是谁、抢到没、付了多少、跟单建议怎么调」 */}
                <th className="px-3 py-2 text-left font-medium">最近一次 第一个狙击者</th>
                <th className="px-3 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">加载中...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">暂无监控目标</td></tr>
              ) : (
                filtered.map((t) => (
                  <TargetRow
                    key={t.id}
                    target={t}
                    onPause={handlePause}
                    onResume={handleResume}
                    onDelete={handleDelete}
                    onClear={handleClear}
                    onThresholdChange={handleThreshold}
                    decision={t.decision}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className="text-2xl font-semibold mt-1 text-gray-800 dark:text-white/90">{value}</div>
    </div>
  );
}
