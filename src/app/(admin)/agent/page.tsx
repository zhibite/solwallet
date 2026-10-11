'use client';

import { useEffect, useState, useCallback } from 'react';
import Button from '@/components/ui/button/Button';
import Badge from '@/components/ui/badge/Badge';
import Alert from '@/components/ui/alert/Alert';

interface AgentStats {
  totalRounds: number;
  totalDecisions: number;
  totalExecuted: number;
  actionBreakdown: Record<string, number>;
  avgConfidence: number;
  lastRound: {
    id: number;
    started_at: string;
    finished_at: string;
    target_count: number;
    decision_count: number;
    executed_count: number;
    attempted_count: number;
    error_count: number;
    total_ms: number;
    status: string;
  } | null;
}

interface SchedulerState {
  isRunning: boolean;
  intervalMinutes: number;
  shadowMode: boolean;
  lastRunTime: string | null;
  lastRunResult: {
    status: string;
    targetCount: number;
    decisionCount: number;
    executedCount: number;
    attemptedCount: number;
    errorCount: number;
    totalMs: number;
  } | null;
  nextRunTime: string | null;
}

interface AgentRound {
  id: number;
  started_at: string;
  finished_at: string | null;
  llm_model: string;
  status: string;
  target_count: number;
  decision_count: number;
  executed_count: number;
  attempted_count: number;
  error_count: number;
  total_ms: number;
}

export default function AgentPage() {
  const [stats, setStats] = useState<AgentStats | null>(null);
  const [schedulerState, setSchedulerState] = useState<SchedulerState | null>(null);
  const [rounds, setRounds] = useState<AgentRound[]>([]);
  const [loading, setLoading] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'rounds' | 'settings'>('overview');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [roundsRes, schedulerRes] = await Promise.all([
        fetch('/api/agent/rounds'),
        fetch('/api/agent/scheduler'),
      ]);

      const roundsData = await roundsRes.json();
      const schedulerData = await schedulerRes.json();

      if (roundsData.ok) {
        setStats(roundsData.data.stats);
        setRounds(roundsData.data.rounds);
      } else {
        setError(roundsData.error || 'Failed to load rounds');
      }

      if (schedulerData.ok) {
        setSchedulerState(schedulerData.data.state);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    // Refresh every 10 seconds
    const interval = setInterval(loadData, 10000);
    return () => clearInterval(interval);
  }, [loadData]);

  const triggerRound = async () => {
    setTriggering(true);
    setError(null);
    try {
      const res = await fetch('/api/agent/rounds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const data = await res.json();

      if (data.ok) {
        await loadData();
      } else {
        setError(data.error || 'Failed to trigger round');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setTriggering(false);
    }
  };

  const toggleScheduler = async (action: 'start' | 'stop') => {
    try {
      const res = await fetch('/api/agent/scheduler', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });

      const data = await res.json();

      if (data.ok) {
        setSchedulerState(data.data.state);
      } else {
        setError(data.error || `Failed to ${action} scheduler`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    }
  };

  const toggleShadowMode = async () => {
    if (!schedulerState) return;

    try {
      const res = await fetch('/api/agent/scheduler', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          shadow_mode: !schedulerState.shadowMode,
        }),
      });

      const data = await res.json();

      if (data.ok) {
        setSchedulerState(data.data.state);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    }
  };

  const statsCards = stats
    ? [
        { label: '总轮次', value: stats.totalRounds, accent: 'text-gray-800 dark:text-white/90' },
        { label: '总决策', value: stats.totalDecisions, accent: 'text-blue-light-500' },
        { label: '已执行', value: stats.totalExecuted, accent: 'text-success-500' },
        { label: '平均置信度', value: `${(stats.avgConfidence * 100).toFixed(0)}%`, accent: 'text-warning-500' },
      ]
    : [];

  return (
    <div className="space-y-4 p-6">
      {/* Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-800 dark:text-white/90">跟单 Agent</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            AI 驱动的跟单决策引擎，自动评估监控目标并执行动作
          </p>
        </div>
        <div className="flex items-center gap-2">
          {schedulerState && (
            <>
              <Badge
                color={schedulerState.isRunning ? 'success' : 'light'}
                size="sm"
                startIcon={
                  <span className="relative flex h-2 w-2">
                    {schedulerState.isRunning && (
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success-500 opacity-75" />
                    )}
                    <span
                      className={`relative inline-flex h-2 w-2 rounded-full ${
                        schedulerState.isRunning ? 'bg-success-500' : 'bg-gray-400'
                      }`}
                    />
                  </span>
                }
              >
                {schedulerState.isRunning ? '调度运行中' : '已停止'}
              </Badge>
              {schedulerState.isRunning && (
                <Badge color={schedulerState.shadowMode ? 'warning' : 'info'} size="sm">
                  {schedulerState.shadowMode ? '影子模式' : '实盘模式'}
                </Badge>
              )}
            </>
          )}
          <Button variant="primary" onClick={triggerRound} disabled={triggering}>
            {triggering ? (
              <>
                <svg
                  className="animate-spin -ml-1 mr-2 h-4 w-4 text-white"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                运行中...
              </>
            ) : (
              <>
                <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                立即跑一次
              </>
            )}
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="error" title="错误" message={error} />
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statsCards.map((card) => (
          <div
            key={card.label}
            className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 p-4"
          >
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              {card.label}
            </div>
            <div className={`mt-2 text-2xl font-semibold font-mono ${card.accent}`}>
              {card.value}
            </div>
          </div>
        ))}
        {statsCards.length === 0 && !loading && (
          <div className="col-span-full bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 p-6 text-center text-sm text-gray-500 dark:text-gray-400">
            暂无数据
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="flex space-x-6">
          {(
            [
              { key: 'overview', label: '概览' },
              { key: 'rounds', label: '轮次历史' },
              { key: 'settings', label: '设置' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`relative py-2.5 px-1 text-sm font-medium transition-colors ${
                activeTab === tab.key
                  ? 'text-brand-500 dark:text-brand-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              {tab.label}
              {activeTab === tab.key && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand-500 dark:bg-brand-400 rounded-t" />
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Scheduler Status */}
          <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700">
            <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-800 dark:text-white/90">调度器状态</h3>
                {schedulerState && (
                  <Badge
                    color={schedulerState.isRunning ? 'success' : 'light'}
                    size="sm"
                  >
                    {schedulerState.isRunning ? '运行中' : '已停止'}
                  </Badge>
                )}
              </div>
            </div>
            <div className="p-5">
              {schedulerState ? (
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-500 dark:text-gray-400">运行间隔</span>
                    <span className="text-sm font-mono text-gray-800 dark:text-white/90">
                      {schedulerState.intervalMinutes} 分钟
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-500 dark:text-gray-400">运行模式</span>
                    <Badge color={schedulerState.shadowMode ? 'warning' : 'info'} size="sm">
                      {schedulerState.shadowMode ? '影子模式' : '实盘模式'}
                    </Badge>
                  </div>
                  {schedulerState.lastRunTime && (
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-gray-500 dark:text-gray-400">上次运行</span>
                      <span className="text-xs font-mono text-gray-700 dark:text-gray-300">
                        {new Date(schedulerState.lastRunTime).toLocaleString('zh-CN', { hour12: false })}
                      </span>
                    </div>
                  )}
                  {schedulerState.nextRunTime && schedulerState.isRunning && (
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-gray-500 dark:text-gray-400">下次运行</span>
                      <span className="text-xs font-mono text-gray-700 dark:text-gray-300">
                        {new Date(schedulerState.nextRunTime).toLocaleString('zh-CN', { hour12: false })}
                      </span>
                    </div>
                  )}
                  {schedulerState.lastRunResult && (
                    <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-700">
                      <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">最近一次结果</div>
                      <div className="grid grid-cols-4 gap-2 text-center">
                        <div className="bg-gray-50 dark:bg-zinc-700/50 rounded p-2">
                          <div className="text-xs text-gray-500 dark:text-gray-400">目标</div>
                          <div className="text-sm font-mono font-semibold text-gray-800 dark:text-white/90">
                            {schedulerState.lastRunResult.targetCount}
                          </div>
                        </div>
                        <div className="bg-gray-50 dark:bg-zinc-700/50 rounded p-2">
                          <div className="text-xs text-gray-500 dark:text-gray-400">决策</div>
                          <div className="text-sm font-mono font-semibold text-blue-light-500">
                            {schedulerState.lastRunResult.decisionCount}
                          </div>
                        </div>
                        <div className="bg-gray-50 dark:bg-zinc-700/50 rounded p-2">
                          <div className="text-xs text-gray-500 dark:text-gray-400">执行</div>
                          <div className="text-sm font-mono font-semibold text-success-500">
                            {schedulerState.lastRunResult.executedCount}
                          </div>
                        </div>
                        <div
                          className="bg-gray-50 dark:bg-zinc-700/50 rounded p-2"
                          title="本地写库成功但 akbot 调用失败的次数"
                        >
                          <div className="text-xs text-gray-500 dark:text-gray-400">尝试</div>
                          <div className="text-sm font-mono font-semibold text-warning-500">
                            {schedulerState.lastRunResult.attemptedCount}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="pt-3 border-t border-gray-100 dark:border-gray-700 flex flex-wrap gap-2">
                    {schedulerState.isRunning ? (
                      <Button variant="outline" size="sm" onClick={() => toggleScheduler('stop')}>
                        停止调度
                      </Button>
                    ) : (
                      <Button variant="primary" size="sm" onClick={() => toggleScheduler('start')}>
                        启动调度
                      </Button>
                    )}
                    <Button variant="outline" size="sm" onClick={toggleShadowMode}>
                      {schedulerState.shadowMode ? '关闭影子' : '开启影子'}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-gray-400 dark:text-gray-500 text-center py-4">加载中...</div>
              )}
            </div>
          </div>

          {/* Action Breakdown */}
          <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700">
            <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700">
              <h3 className="text-sm font-semibold text-gray-800 dark:text-white/90">动作分布</h3>
            </div>
            <div className="p-5">
              {stats && Object.keys(stats.actionBreakdown).length > 0 ? (
                <div className="space-y-2.5">
                  {Object.entries(stats.actionBreakdown).map(([action, count]) => {
                    const total = Object.values(stats.actionBreakdown).reduce((a, b) => a + b, 0);
                    const pct = total > 0 ? (count / total) * 100 : 0;
                    return (
                      <div key={action}>
                        <div className="flex justify-between items-center mb-1">
                          <Badge color={getActionColor(action)} size="sm">
                            {action}
                          </Badge>
                          <span className="text-sm font-mono text-gray-800 dark:text-white/90">
                            {count} <span className="text-xs text-gray-400">({pct.toFixed(0)}%)</span>
                          </span>
                        </div>
                        <div className="h-1.5 w-full bg-gray-100 dark:bg-zinc-700 rounded overflow-hidden">
                          <div
                            className={`h-full ${getActionBarColor(action)} transition-all`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-sm text-gray-400 dark:text-gray-500 text-center py-4">暂无数据</div>
              )}
            </div>
          </div>

          {/* Last Round */}
          {stats?.lastRound && (
            <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 lg:col-span-2">
              <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-800 dark:text-white/90">最近一轮</h3>
                <a
                  href={`/agent/rounds/${stats.lastRound.id}`}
                  className="text-xs text-brand-500 hover:text-brand-600 dark:text-brand-400"
                >
                  查看详情 →
                </a>
              </div>
              <div className="p-5 grid grid-cols-2 md:grid-cols-4 gap-4">
                <Field label="轮次 ID" value={`#${stats.lastRound.id}`} mono />
                <Field label="目标数" value={String(stats.lastRound.target_count)} mono />
                <Field
                  label="决策数"
                  value={String(stats.lastRound.decision_count)}
                  accent="text-blue-light-500"
                  mono
                />
                <Field
                  label="执行数"
                  value={String(stats.lastRound.executed_count)}
                  accent="text-success-500"
                  mono
                />
                <Field
                  label="尝试数"
                  value={String(stats.lastRound.attempted_count)}
                  accent={stats.lastRound.attempted_count > 0 ? 'text-warning-500' : 'text-gray-800 dark:text-white/90'}
                  mono
                  title="本地写库成功但 akbot 调用失败的次数"
                />
                <Field label="耗时" value={`${stats.lastRound.total_ms}ms`} mono />
                <Field
                  label="错误"
                  value={String(stats.lastRound.error_count)}
                  accent={stats.lastRound.error_count > 0 ? 'text-error-500' : 'text-gray-800 dark:text-white/90'}
                  mono
                />
                <div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">状态</div>
                  <Badge
                    color={stats.lastRound.status === 'completed' ? 'success' : 'error'}
                    size="sm"
                  >
                    {stats.lastRound.status}
                  </Badge>
                </div>
                <Field
                  label="开始时间"
                  value={new Date(stats.lastRound.started_at).toLocaleString('zh-CN', { hour12: false })}
                  small
                />
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'rounds' && (
        <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-zinc-700/50 text-xs text-gray-500 dark:text-gray-400 uppercase">
                <tr>
                  <th className="px-3 py-2.5 text-left font-medium">ID</th>
                  <th className="px-3 py-2.5 text-left font-medium">时间</th>
                  <th className="px-3 py-2.5 text-left font-medium">状态</th>
                  <th className="px-3 py-2.5 text-right font-medium">目标</th>
                  <th className="px-3 py-2.5 text-right font-medium">决策</th>
                  <th className="px-3 py-2.5 text-right font-medium">执行</th>
                  <th
                    className="px-3 py-2.5 text-right font-medium"
                    title="本地写库成功但 akbot 调用失败的次数"
                  >
                    尝试
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">耗时</th>
                  <th className="px-3 py-2.5 text-right font-medium">错误</th>
                  <th className="px-3 py-2.5 text-left font-medium">模型</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {loading && rounds.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-3 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                      加载中...
                    </td>
                  </tr>
                ) : rounds.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-3 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                      暂无轮次
                    </td>
                  </tr>
                ) : (
                  rounds.map((round) => (
                    <tr
                      key={round.id}
                      className="hover:bg-gray-50 dark:hover:bg-zinc-700/30 transition-colors"
                    >
                      <td className="px-3 py-2.5 font-mono text-xs">
                        <a
                          href={`/agent/rounds/${round.id}`}
                          className="text-brand-500 hover:text-brand-600 dark:text-brand-400"
                        >
                          #{round.id}
                        </a>
                      </td>
                      <td className="px-3 py-2.5 text-xs font-mono text-gray-700 dark:text-gray-300">
                        {new Date(round.started_at).toLocaleString('zh-CN', { hour12: false })}
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge
                          color={round.status === 'completed' ? 'success' : 'error'}
                          size="sm"
                        >
                          {round.status}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-gray-800 dark:text-white/90">
                        {round.target_count}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-blue-light-500">
                        {round.decision_count}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-success-500">
                        {round.executed_count}
                      </td>
                      <td
                        className={`px-3 py-2.5 text-right font-mono text-xs ${
                          round.attempted_count > 0
                            ? 'text-warning-500 font-semibold'
                            : 'text-gray-400 dark:text-gray-500'
                        }`}
                      >
                        {round.attempted_count || 0}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-xs text-gray-700 dark:text-gray-300">
                        {round.total_ms}ms
                      </td>
                      <td
                        className={`px-3 py-2.5 text-right font-mono text-xs ${
                          round.error_count > 0
                            ? 'text-error-500 font-semibold'
                            : 'text-gray-400 dark:text-gray-500'
                        }`}
                      >
                        {round.error_count || 0}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-gray-500 dark:text-gray-400 font-mono">
                        {round.llm_model}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'settings' && (
        <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 p-6">
          <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            <span className="text-sm">设置面板正在开发中...</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
  small = false,
  accent = 'text-gray-800 dark:text-white/90',
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
  accent?: string;
  title?: string;
}) {
  return (
    <div title={title}>
      <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">{label}</div>
      <div
        className={`${accent} ${mono ? 'font-mono' : ''} ${
          small ? 'text-xs' : 'text-sm'
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function getActionColor(action: string): 'success' | 'warning' | 'error' | 'info' | 'light' {
  switch (action) {
    case 'enable':
      return 'success';
    case 'disable':
      return 'warning';
    case 'delete':
      return 'error';
    case 'limit_update':
      return 'info';
    default:
      return 'light';
  }
}

function getActionBarColor(action: string): string {
  switch (action) {
    case 'enable':
      return 'bg-success-500';
    case 'disable':
      return 'bg-warning-500';
    case 'delete':
      return 'bg-error-500';
    case 'limit_update':
      return 'bg-blue-light-500';
    default:
      return 'bg-gray-400';
  }
}
