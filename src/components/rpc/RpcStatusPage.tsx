"use client";
import React, { useEffect, useState } from "react";

interface Endpoint {
  url: string;
  shortUrl: string;
  weight: number;
  fails: number;
  successRate: string;
  circuitOpen: 'OK' | 'OPEN';
  totalRequests: number;
  p50ms: number;
  p95ms: number;
  lastError: string;
}

interface CacheStats {
  backend: 'redis' | 'memory';
  keys: number;
  redisReady: boolean;
}

interface RpcStatus {
  endpoints: Endpoint[];
  cache: CacheStats;
  ts: string;
}

export default function RpcStatusPage() {
  const [status, setStatus] = useState<RpcStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);

  const load = async () => {
    try {
      const res = await fetch('/api/rpc/status');
      const json = await res.json();
      if (json.ok) setStatus(json.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    if (!autoRefresh) return;
    const t = setInterval(load, 5_000);
    return () => clearInterval(t);
  }, [autoRefresh]);

  const clearCache = async () => {
    if (!confirm('确认清空所有缓存？')) return;
    setClearing(true);
    try {
      await fetch('/api/cache/stats', { method: 'POST' });
      await load();
    } finally {
      setClearing(false);
    }
  };

  const runTest = async () => {
    setTestResult(null);
    setTesting(true);
    try {
      const res = await fetch('/api/rpc/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'getSlot' }),
      });
      const json = await res.json();
      setTestResult(json.ok ? json.data : null);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">RPC & 缓存状态</h1>
          <p className="text-sm text-gray-500 mt-1">实时监控所有 Solana RPC 端点和 Redis 缓存</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded"
            />
            自动刷新 (5s)
          </label>
          <button
            onClick={runTest}
            disabled={testing}
            className="h-8 px-3 rounded bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-xs"
          >
            {testing ? '测试中...' : '测试一次 getSlot'}
          </button>
          <button
            onClick={load}
            className="h-8 px-3 rounded bg-gray-200 dark:bg-zinc-700 hover:bg-gray-300 dark:hover:bg-zinc-600 text-xs"
          >
            立即刷新
          </button>
          <button
            onClick={clearCache}
            disabled={clearing}
            className="h-8 px-3 rounded bg-error-500 hover:bg-error-600 text-white text-xs disabled:opacity-50"
          >
            {clearing ? '清空中...' : '清空缓存'}
          </button>
        </div>
      </div>

      {/* 测试结果 */}
      {testResult && (
        <div className={`rounded-lg border p-3 ${
          testResult.warm.hit
            ? 'bg-success-50 dark:bg-success-500/10 border-success-200 dark:border-success-500/30'
            : 'bg-gray-50 dark:bg-zinc-800 border-gray-200 dark:border-zinc-700'
        }`}>
          <p className="text-sm font-medium mb-1">
            {testResult.warm.hit ? '✓ 缓存生效' : '⚠️ 缓存未命中'}
          </p>
          <div className="grid grid-cols-3 gap-3 text-xs">
            <div>冷请求: <span className="font-mono">{testResult.cold.ms}ms</span></div>
            <div>热请求: <span className="font-mono">{testResult.warm.ms}ms</span></div>
            <div>加速比: <span className="font-mono">{(testResult.cold.ms / Math.max(1, testResult.warm.ms)).toFixed(1)}x</span></div>
          </div>
        </div>
      )}

      {/* 缓存总览 */}
      {status && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SummaryCard
            label="缓存后端"
            value={status.cache.backend === 'redis' ? 'Redis' : '内存'}
            status={status.cache.redisReady ? 'success' : 'warning'}
          />
          <SummaryCard
            label="缓存键数量"
            value={status.cache.keys}
          />
          <SummaryCard
            label="活跃端点"
            value={status.endpoints.filter((e) => e.circuitOpen === 'OK').length}
            total={status.endpoints.length}
          />
          <SummaryCard
            label="平均 P50"
            value={
              status.endpoints.length > 0
                ? Math.round(
                    status.endpoints.reduce((s, e) => s + (e.p50ms || 0), 0) /
                      status.endpoints.length,
                  ) + 'ms'
                : '-'
            }
          />
        </div>
      )}

      {/* 端点卡片 */}
      {loading && !status ? (
        <div className="bg-white dark:bg-zinc-900 rounded-lg border border-gray-200 dark:border-zinc-700 p-6 text-center text-gray-500">
          加载中...
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {status?.endpoints.map((ep) => (
            <EndpointCard key={ep.url} ep={ep} />
          ))}
        </div>
      )}

      {status && status.cache.backend === 'memory' && (
        <div className="bg-warning-50 dark:bg-warning-500/10 border border-warning-200 dark:border-warning-500/30 rounded-lg p-4 text-xs">
          <p className="font-medium text-warning-700 dark:text-warning-400 mb-1">⚠️ 当前使用内存缓存</p>
          <p className="text-warning-600 dark:text-warning-500">
            多实例部署时会失去缓存共享。在 <code className="bg-warning-100 dark:bg-warning-500/20 px-1 rounded">.env</code> 中设置
            <code className="bg-warning-100 dark:bg-warning-500/20 px-1 rounded mx-1">REDIS_URL=redis://localhost:6379</code>
            启用 Redis 共享缓存。
          </p>
        </div>
      )}

      <p className="text-xs text-gray-400 text-center">
        最后更新: {status ? new Date(status.ts).toLocaleString() : '-'}
      </p>
    </div>
  );
}

function SummaryCard({ label, value, total, status }: { label: string; value: React.ReactNode; total?: number; status?: 'success' | 'warning' | 'error' }) {
  const colorMap = {
    success: 'text-success-600 dark:text-success-400',
    warning: 'text-warning-600 dark:text-warning-400',
    error: 'text-error-600 dark:text-error-400',
  };
  return (
    <div className="bg-white dark:bg-zinc-900 rounded-lg border border-gray-200 dark:border-zinc-700 p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-lg font-semibold mt-0.5 ${status ? colorMap[status] : ''}`}>
        {value}
        {total !== undefined && <span className="text-sm text-gray-400">/{total}</span>}
      </div>
    </div>
  );
}

function EndpointCard({ ep }: { ep: Endpoint }) {
  const isOpen = ep.circuitOpen === 'OPEN';
  const successNum = parseFloat(ep.successRate);

  let statusColor = 'border-gray-200 dark:border-zinc-700';
  let badgeBg = 'bg-gray-100 dark:bg-zinc-800 text-gray-600 dark:text-gray-400';
  if (isOpen) {
    statusColor = 'border-error-300 dark:border-error-500/50';
    badgeBg = 'bg-error-100 dark:bg-error-500/20 text-error-700 dark:text-error-400';
  } else if (successNum >= 95) {
    statusColor = 'border-success-300 dark:border-success-500/50';
    badgeBg = 'bg-success-100 dark:bg-success-500/20 text-success-700 dark:text-success-400';
  } else if (successNum < 80) {
    statusColor = 'border-warning-300 dark:border-warning-500/50';
    badgeBg = 'bg-warning-100 dark:bg-warning-500/20 text-warning-700 dark:text-warning-400';
  }

  return (
    <div className={`bg-white dark:bg-zinc-900 rounded-lg border-2 ${statusColor} p-4`}>
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex-1 min-w-0">
          <div className="font-mono text-sm truncate" title={ep.url}>{ep.shortUrl}</div>
          {ep.url !== ep.shortUrl && (
            <div className="font-mono text-xs text-gray-400 truncate" title={ep.url}>{ep.url}</div>
          )}
        </div>
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${badgeBg}`}>
          {ep.circuitOpen}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs">
        <Metric label="成功率" value={ep.successRate} highlight={successNum < 80} />
        <Metric label="权重" value={ep.weight.toFixed(1)} />
        <Metric label="请求数" value={ep.totalRequests} />
        <Metric label="P50" value={`${ep.p50ms}ms`} />
        <Metric label="P95" value={`${ep.p95ms}ms`} />
        <Metric label="连续失败" value={ep.fails} highlight={ep.fails > 2} />
      </div>

      {ep.lastError && isOpen && (
        <div className="mt-3 p-2 bg-error-50 dark:bg-error-500/10 rounded text-xs text-error-700 dark:text-error-400 font-mono truncate" title={ep.lastError}>
          {ep.lastError}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, highlight }: { label: string; value: React.ReactNode; highlight?: boolean }) {
  return (
    <div className={`flex flex-col ${highlight ? 'text-error-600 dark:text-error-400' : 'text-gray-700 dark:text-gray-300'}`}>
      <span className="text-gray-400 dark:text-gray-500 text-[10px]">{label}</span>
      <span className="font-mono font-medium">{value}</span>
    </div>
  );
}
