"use client";
import React, { useState, useEffect, useCallback } from "react";
import { useConfirm } from "@/components/ui/confirm-dialog";
import AddressCopy from "@/components/common/AddressCopy";
import SolAmount from "@/components/common/SolAmount";
import PrioSolAmount from "@/components/common/PrioSolAmount";
import RelativeTime from "@/components/common/RelativeTime";
import AddTargetForm from "./AddTargetForm";
import TargetRow from "./TargetRow";
import type { Target } from "@/lib/types";

interface Stats {
  activeTargets: number;
  recordedBuys: number;
  pending: number;
  analyzed: number;
  failed?: number;
  last_error?: string;
  running?: number;
  subs?: number;
  started?: boolean;
  seen?: number;
  last_tx_at?: number;
}

interface WsStatus {
  running: boolean;
  connected: boolean;
  lastConnectedAt: string | null;
  reconnectAttempts: number;
  subscribedTargetsCount: number;
  subscriptionsCount: number;
  akbotRetryQueueSize: number;
}

const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

export default function MonitorList() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [wsStatus, setWsStatus] = useState<WsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'paused'>('all');
  const [busy, setBusy] = useState<null | 'cleanup' | 'clearAll'>(null);
  // 同一 token 只看首单（参考页 cm_first_only）
  const [firstOnly, setFirstOnly] = useState(true);
  const { confirm, alert } = useConfirm();

  const load = useCallback(async (isSilent = false) => {
    if (isSilent) setRefreshing(true);
    else setLoading(true);
    try {
      const [tRes, sRes, wsRes] = await Promise.all([
        fetch('/api/targets').then((r) => r.json()),
        fetch('/api/stats').then((r) => r.json()),
        fetch('/api/ws-monitor/status').then((r) => r.json()).catch(() => null),
      ]);
      if (tRes.ok) setTargets(tRes.data);
      if (sRes.ok) setStats(sRes.data);
      if (wsRes?.success) setWsStatus(wsRes.data);
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
    if (!json.isNew) {
      await alert({
        title: '已在监控列表',
        description: (
          <>
            <span className="font-mono">{short(data.address)}</span> 已经在监控列表中，阈值已更新为 <span className="font-semibold">{data.threshold_sol} SOL</span>。
          </>
        ),
        variant: 'info',
      });
    }
    await load(false);
  };

  const handlePause = async (id: number) => { await fetch(`/api/targets/${id}/pause`, { method: 'POST' }); load(true); };
  const handleResume = async (id: number) => { await fetch(`/api/targets/${id}/resume`, { method: 'POST' }); load(true); };

  const handleToggleAutoFollow = async (id: number, on: boolean) => {
    await fetch(`/api/targets/${id}/auto-follow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on }),
    });
    load(true);
  };

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
      const res = await fetch('/api/targets/clear-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      const json = await res.json();
      if (json.ok) {
        await load(false);
        await alert({
          title: '已清空',
          description: `共删除 ${json.deleted.trades} 条交易、${json.deleted.analyses} 条分析`,
          variant: 'success',
        });
      } else {
        await alert({ title: '清空失败', description: json.error, variant: 'danger' });
      }
    } finally {
      setBusy(null);
    }
  };

  // 按「距现在时间」降序：最近买过的目标排前；last_buy_at 为 null 的沉底
  const filtered = targets
    .filter((t) => statusFilter === 'all' || t.status === statusFilter)
    .sort((a, b) => {
      const ta = a.last_buy_at ? Date.parse(a.last_buy_at) : null;
      const tb = b.last_buy_at ? Date.parse(b.last_buy_at) : null;
      if (ta === null && tb === null) return 0;
      if (ta === null) return 1;
      if (tb === null) return -1;
      return tb - ta;
    });

  // 参考页格式：MM-DD HH:mm:ss
  const fmtTime = (iso: string | null) => {
    if (!iso) return '-';
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  // 参考页风格：运行状态文字
  const statusText: string[] = [];
  if (stats?.started) statusText.push('监控运行中');
  if (stats?.running) statusText.push(`${stats.running} 个分析中`);
  if (stats?.subs) statusText.push(`${stats.subs} 个地址在订阅`);
  if (stats?.seen) statusText.push(`命中 ${stats.seen} 笔目标买单`);
  if (stats?.last_tx_at) statusText.push(`最近推送 ${new Date(stats.last_tx_at).toLocaleTimeString('zh-CN', { hour12: false })}`);

  return (
    <div className="space-y-4">
      {/* 顶部统计行 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="监控中" value={stats?.activeTargets ?? '-'} />
        <StatCard label="已记录 buy" value={stats?.recordedBuys ?? '-'} />
        <StatCard label="待分析" value={stats?.pending ?? '-'} />
        <StatCard label="已分析" value={stats?.analyzed ?? '-'} />
        {stats?.failed !== undefined && stats.failed > 0 && (
          <StatCard label="取块失败" value={stats.failed} accent="error" />
        )}
        {stats?.last_error && (
          <div className="col-span-2 text-xs text-error-500 truncate" title={stats.last_error}>
            任务报错：{stats.last_error}
          </div>
        )}
      </div>

      {statusText.length > 0 && (
        <div className="text-xs text-gray-500 dark:text-gray-400">
          {statusText.join(' · ')}
        </div>
      )}

      {/* WebSocket 实时连接状态 */}
      <WsStatusBar wsStatus={wsStatus} />

      {/* 添加目标 + 全局操作 */}
      <AddTargetForm onAdd={handleAdd} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium text-gray-800 dark:text-white/90">监控列表</span>
          <span className="text-xs text-gray-500 dark:text-gray-400">共 {filtered.length} 个</span>
          {/* WebSocket 状态（复用 WsStatusBar 的状态解析逻辑） */}
          {wsStatus && (() => {
            const isConnected = wsStatus.running && wsStatus.connected;
            const isReconnecting = wsStatus.running && !wsStatus.connected && wsStatus.reconnectAttempts > 0;
            const dotColor = isConnected ? 'bg-green-500' : isReconnecting ? 'bg-yellow-400' : 'bg-gray-400';
            const label = isConnected ? 'WS 已连接' : isReconnecting ? `WS 重连 ${wsStatus.reconnectAttempts}/10` : 'WS 断开';
            const subLabel = isConnected
              ? `${wsStatus.subscriptionsCount}订阅·${wsStatus.subscribedTargetsCount}目标`
              : '';
            return (
              <>
                <span className={`inline-block w-2 h-2 rounded-full ${dotColor} ${isReconnecting ? 'animate-pulse' : ''}`} />
                <span className="text-xs font-medium text-gray-700 dark:text-gray-200">{label}</span>
                {subLabel && <span className="text-xs text-gray-400 dark:text-gray-500">{subLabel}</span>}
              </>
            );
          })()}
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
            <label className="flex items-center gap-1.5 ml-2 text-gray-500 dark:text-gray-400 cursor-pointer select-none" title="同一个 token 被目标买了多次时，只显示最早那一笔（首单）">
              <input
                type="checkbox"
                checked={firstOnly}
                onChange={(e) => setFirstOnly(e.target.checked)}
                className="w-3.5 h-3.5 rounded accent-brand-500"
              />
              同一 token 只看首单
            </label>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-zinc-800/50 text-xs text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">监控目标</th>
                <th className="px-3 py-2 text-center font-medium w-32 whitespace-nowrap">状态</th>
                <th className="px-3 py-2 text-center font-medium w-24 whitespace-nowrap">自动跟单</th>
                <th className="px-3 py-2 text-center font-medium w-14 whitespace-nowrap">记录数</th>
                <th className="px-3 py-2 text-left font-medium w-44 whitespace-nowrap">最新buy时间</th>
                <th className="px-3 py-2 text-left font-medium w-28 whitespace-nowrap">距现在</th>
                <th className="px-3 py-2 text-left font-medium w-40 whitespace-nowrap">最近狙击者</th>
                <th className="px-3 py-2 text-right font-medium w-22 whitespace-nowrap">tip</th>
                <th className="px-3 py-2 text-right font-medium w-22 whitespace-nowrap">prio</th>
                <th className="px-3 py-2 text-right font-medium w-24 whitespace-nowrap">收益</th>
                <th className="px-3 py-2 text-center font-medium w-52 whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={11} className="px-3 py-6 text-center text-sm text-gray-400 dark:text-gray-500">加载中...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={11} className="px-3 py-6 text-center text-sm text-gray-400 dark:text-gray-500 italic">暂无监控目标</td></tr>
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
                    onToggleAutoFollow={handleToggleAutoFollow}
                    decision={t.decision}
                    firstOnly={firstOnly}
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

function WsStatusBar({ wsStatus }: { wsStatus: WsStatus | null }) {
  if (!wsStatus) return null;

  const isConnected = wsStatus.running && wsStatus.connected;
  const isReconnecting = wsStatus.running && !wsStatus.connected && wsStatus.reconnectAttempts > 0;
  const isStopped = !wsStatus.running;

  const dotColor = isConnected
    ? 'bg-green-500'
    : isReconnecting
    ? 'bg-yellow-400'
    : 'bg-gray-400';

  const label = isConnected
    ? 'WebSocket 已连接'
    : isReconnecting
    ? `WebSocket 重连中 (${wsStatus.reconnectAttempts}/10)`
    : 'WebSocket 已断开';

  const subLabel = isConnected
    ? `${wsStatus.subscriptionsCount} 个订阅 · ${wsStatus.subscribedTargetsCount} 个目标`
    : isReconnecting
    ? `最近连接 ${wsStatus.lastConnectedAt ? new Date(wsStatus.lastConnectedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '-'}`
    : wsStatus.lastConnectedAt
    ? `断开于 ${new Date(wsStatus.lastConnectedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
    : '';

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-50 dark:bg-zinc-800 border border-gray-200 dark:border-gray-700">
      <span className={`inline-block w-2.5 h-2.5 rounded-full ${dotColor} ${isReconnecting ? 'animate-pulse' : ''}`} />
      <span className="text-xs font-medium text-gray-700 dark:text-gray-200">{label}</span>
      {subLabel && (
        <span className="text-xs text-gray-400 dark:text-gray-500 ml-1">{subLabel}</span>
      )}
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number | string; accent?: string }) {
  return (
    <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${accent === 'error' ? 'text-error-500' : 'text-gray-800 dark:text-white/90'}`}>
        {value}
      </div>
    </div>
  );
}
