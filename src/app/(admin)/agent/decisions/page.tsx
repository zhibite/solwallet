'use client';

import { useEffect, useState } from 'react';
import Badge from '@/components/ui/badge/Badge';
import Alert from '@/components/ui/alert/Alert';

interface Decision {
  id: number;
  round_id: number;
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
  round_started_at: string;
  created_at: string;
}

export default function DecisionsPage() {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterAction, setFilterAction] = useState<string>('');
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  const load = async () => {
    setLoading(true);
    try {
      const url = new URL('/api/agent/decisions', window.location.origin);
      url.searchParams.set('limit', '200');
      if (filterAction) url.searchParams.set('action', filterAction);
      
      const res = await fetch(url.toString());
      const data = await res.json();
      if (data.ok) {
        setDecisions(data.data);
      } else {
        setError(data.error || 'Failed to load');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [filterAction]);

  const toggleExpanded = (id: number) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading) {
    return <div className="p-6">加载中...</div>;
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">最近决策</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500">共 {decisions.length} 条</span>
          <select
            value={filterAction}
            onChange={(e) => setFilterAction(e.target.value)}
            className="border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-700"
          >
            <option value="">全部动作</option>
            <option value="enable">enable</option>
            <option value="disable">disable</option>
            <option value="delete">delete</option>
            <option value="limit_update">limit_update</option>
            <option value="hold">hold</option>
          </select>
        </div>
      </div>

      {error && <Alert variant="error" title="错误" message={error} />}

      <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50 dark:bg-gray-700">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">时间</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">轮次</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">目标</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">动作</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">参数</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">依据</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">置信</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">状态</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {decisions.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                  暂无决策
                </td>
              </tr>
            ) : (
              decisions.map((decision) => (
                <DecisionRow
                  key={decision.id}
                  decision={decision}
                  expanded={expandedIds.has(decision.id)}
                  onToggle={() => toggleExpanded(decision.id)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DecisionRow({
  decision,
  expanded,
  onToggle,
}: {
  decision: Decision;
  expanded: boolean;
  onToggle: () => void;
}) {
  const shortAddr = `${decision.target_address.slice(0, 4)}...${decision.target_address.slice(-4)}`;
  const paramStr = decision.params
    ? JSON.stringify(decision.params)
    : '';
  const truncatedParams = paramStr.length > 30
    ? paramStr.slice(0, 30) + '...'
    : paramStr;
  const truncatedReason = decision.reasoning.length > 50
    ? decision.reasoning.slice(0, 50) + '...'
    : decision.reasoning;

  return (
    <>
      <tr
        className="hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
        onClick={onToggle}
      >
        <td className="px-4 py-3 text-sm">
          {new Date(decision.created_at).toLocaleString('zh-CN')}
        </td>
        <td className="px-4 py-3 text-sm font-mono">
          <a
            href={`/agent/rounds/${decision.round_id}`}
            onClick={(e) => e.stopPropagation()}
            className="text-blue-600 hover:underline"
          >
            #{decision.round_id}
          </a>
        </td>
        <td className="px-4 py-3 text-sm font-mono" title={decision.target_address}>
          {shortAddr}
        </td>
        <td className="px-4 py-3">
          <Badge color={getActionColor(decision.action)} size="sm">
            {decision.action}
          </Badge>
        </td>
        <td className="px-4 py-3 text-xs font-mono">
          {truncatedParams || '-'}
        </td>
        <td className="px-4 py-3 text-sm" title={decision.reasoning}>
          {truncatedReason}
        </td>
        <td className="px-4 py-3 text-sm font-mono">
          {decision.confidence.toFixed(2)}
        </td>
        <td className="px-4 py-3">
          {decision.executed ? (
            <Badge color="success" size="sm">已执行</Badge>
          ) : decision.shadow ? (
            <Badge color="warning" size="sm">影子</Badge>
          ) : (
            <Badge color="light" size="sm">未执行</Badge>
          )}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8} className="px-4 py-3 bg-gray-50 dark:bg-gray-900">
            <div className="space-y-3">
              {decision.params && (
                <div>
                  <div className="text-sm font-medium text-gray-500 mb-1">参数</div>
                  <pre className="text-sm bg-white dark:bg-gray-800 p-3 rounded overflow-auto">
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
              <div className="text-xs text-gray-400">
                目标地址: {decision.target_address}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
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
