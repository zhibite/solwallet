'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Badge from '@/components/ui/badge/Badge';
import Alert from '@/components/ui/alert/Alert';

interface RoundDetail {
  round: {
    id: number;
    started_at: string;
    finished_at: string | null;
    llm_model: string;
    llm_provider: string;
    total_ms: number;
    target_count: number;
    decision_count: number;
    executed_count: number;
    attempted_count: number;
    error_count: number;
    status: string;
    error_message: string | null;
  };
  decisions: Array<{
    id: number;
    target_id: number;
    target_address: string;
    target_label: string | null;
    action: string;
    params: Record<string, number | boolean> | null;
    reasoning: string;
    confidence: number;
    shadow: boolean;
    executed: boolean;
    execution_error: string | null;
    created_at: string;
  }>;
}

interface AkbotLog {
  id: number;
  agent_decision_id: number | null;
  monitored_target_id: number;
  action: string;
  endpoint: string;
  response_status: number | null;
  ok: boolean;
  error_message: string | null;
  duration_ms: number | null;
  request_body: unknown;
  response_body: unknown;
  created_at: string;
}

export default function RoundDetailPage() {
  const params = useParams();
  const roundId = params.id as string;
  const [data, setData] = useState<RoundDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'summary' | 'data'>('summary');
  const [expandedDecisions, setExpandedDecisions] = useState<Set<number>>(new Set());
  const [akbotLogs, setAkbotLogs] = useState<AkbotLog[]>([]);
  const [akbotLogsByDecision, setAkbotLogsByDecision] = useState<Map<number, AkbotLog[]>>(new Map());

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/agent/rounds/${roundId}`);
        const json = await res.json();
        if (json.ok) {
          setData(json.data);
        } else {
          setError(json.error || 'Failed to load');
        }
        // 顺手拉这一轮的 akbot_call_log（失败也不影响主流程）
        try {
          const logsRes = await fetch(`/api/agent/rounds/${roundId}/akbot-logs`);
          const logsJson = await logsRes.json();
          if (logsJson.ok && Array.isArray(logsJson.data)) {
            setAkbotLogs(logsJson.data);
            const grouped = new Map<number, AkbotLog[]>();
            for (const l of logsJson.data) {
              if (l.agent_decision_id == null) continue;
              const arr = grouped.get(l.agent_decision_id) ?? [];
              arr.push(l);
              grouped.set(l.agent_decision_id, arr);
            }
            setAkbotLogsByDecision(grouped);
          }
        } catch (e) {
          // 静默：akbot_logs 拉取失败不应该影响主页面
          console.warn('[round-detail] akbot-logs fetch failed:', e);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [roundId]);

  if (loading) {
    return <div className="p-6">加载中...</div>;
  }

  if (error) {
    return (
      <div className="p-6">
        <Alert variant="error" title="错误" message={error} />
      </div>
    );
  }

  if (!data) {
    return <div className="p-6">未找到</div>;
  }

  const { round, decisions } = data;
  const actionCounts = decisions.reduce((acc, d) => {
    acc[d.action] = (acc[d.action] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const toggleDecision = (id: number) => {
    setExpandedDecisions(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">跟单Agent · 决策流</h1>
          <Badge color={round.status === 'completed' ? 'success' : 'error'}>
            {round.status}
          </Badge>
        </div>
        <div className="text-sm text-gray-500 mt-2">
          轮次 #{round.id} · {new Date(round.started_at).toLocaleString('zh-CN')} ·
          目标 {round.target_count} · 决策 {round.decision_count} · 执行 {round.executed_count} ·
          {round.attempted_count > 0 && (
            <span className="text-warning-500"> 尝试 {round.attempted_count} ·</span>
          )}
          {' '}耗时 {round.total_ms}ms
          {akbotLogs.length > 0 && (() => {
            const failed = akbotLogs.filter((l) => !l.ok).length;
            return (
              <span className={failed > 0 ? 'text-red-500' : 'text-gray-500'}>
                {' '}· akbot 调用 {akbotLogs.length}（失败 {failed}）
              </span>
            );
          })()}
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 dark:border-gray-700">
        <nav className="flex space-x-8">
          {(['summary', 'data'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`py-2 px-1 border-b-2 font-medium text-sm ${
                activeTab === tab
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab === 'summary' ? '小结' : '数据'}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'summary' && (
        <div className="space-y-3">
          {/* Action counts */}
          <div className="flex flex-wrap gap-2 mb-4">
            {Object.entries(actionCounts).map(([action, count]) => (
              <Badge key={action} color={getActionColor(action)}>
                {count} {action}
              </Badge>
            ))}
          </div>

          {/* Decisions list */}
          {decisions.length === 0 ? (
            <div className="text-gray-500 text-center py-8">本轮无决策</div>
          ) : (
            decisions.map((decision) => (
              <div
                key={decision.id}
                className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden"
              >
                <button
                  onClick={() => toggleDecision(decision.id)}
                  className="w-full p-4 text-left hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Badge color={getActionColor(decision.action)}>
                        {decision.action}
                      </Badge>
                      <span className="font-mono text-sm">
                        {decision.target_address.slice(0, 4)}...{decision.target_address.slice(-4)}
                      </span>
                      {decision.target_label && (
                        <span className="text-sm text-gray-500">
                          ({decision.target_label})
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-gray-500">
                        置信度 {(decision.confidence * 100).toFixed(0)}%
                      </span>
                      {decision.executed && (
                        <Badge variant="solid" color="success">已执行</Badge>
                      )}
                      {decision.shadow && !decision.executed && (
                        <Badge variant="solid" color="warning">影子</Badge>
                      )}
                    </div>
                  </div>
                </button>

                {expandedDecisions.has(decision.id) && (
                  <div className="border-t border-gray-200 dark:border-gray-700 p-4 space-y-3">
                    {decision.params && Object.keys(decision.params).length > 0 && (
                      <div>
                        <div className="text-sm font-medium text-gray-500 mb-1">参数</div>
                        <pre className="text-sm bg-gray-50 dark:bg-gray-900 p-3 rounded overflow-auto">
                          {JSON.stringify(decision.params, null, 2)}
                        </pre>
                      </div>
                    )}
                    <div>
                      <div className="text-sm font-medium text-gray-500 mb-1">依据</div>
                      <div className="text-sm whitespace-pre-wrap">
                        {decision.reasoning}
                      </div>
                    </div>
                    {decision.execution_error && (
                      <div>
                        <div className="text-sm font-medium text-red-500 mb-1">执行错误</div>
                        <div className="text-sm text-red-600">
                          {decision.execution_error}
                        </div>
                      </div>
                    )}
                    {(() => {
                      const logs = akbotLogsByDecision.get(decision.id);
                      if (!logs || logs.length === 0) return null;
                      return (
                        <div>
                          <div className="text-sm font-medium text-gray-500 mb-1">
                            akbot 调用 ({logs.length} 步)
                          </div>
                          <div className="space-y-2">
                            {logs.map((l) => (
                              <div
                                key={l.id}
                                className={`text-xs rounded p-2 border ${
                                  l.ok
                                    ? 'border-green-200 bg-green-50 dark:bg-green-900/20'
                                    : 'border-red-200 bg-red-50 dark:bg-red-900/20'
                                }`}
                              >
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="font-mono">{l.endpoint}</span>
                                  <span className={l.ok ? 'text-green-700' : 'text-red-700'}>
                                    {l.ok ? `✓ ${l.response_status ?? ''}` : `✗ ${l.response_status ?? ''}`}
                                  </span>
                                  {l.duration_ms != null && (
                                    <span className="text-gray-500">{l.duration_ms}ms</span>
                                  )}
                                </div>
                                {l.error_message && (
                                  <div className="text-red-600 mb-1">{l.error_message}</div>
                                )}
                                {l.request_body != null && (
                                  <details className="mb-1">
                                    <summary className="cursor-pointer text-gray-500">请求</summary>
                                    <pre className="mt-1 overflow-auto">
                                      {JSON.stringify(l.request_body, null, 2)}
                                    </pre>
                                  </details>
                                )}
                                {l.response_body != null && (
                                  <details>
                                    <summary className="cursor-pointer text-gray-500">响应</summary>
                                    <pre className="mt-1 overflow-auto">
                                      {JSON.stringify(l.response_body, null, 2)}
                                    </pre>
                                  </details>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === 'data' && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <pre className="text-sm overflow-auto">
            {JSON.stringify(data, null, 2)}
          </pre>
        </div>
      )}
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
