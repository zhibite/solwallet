'use client';

import { useEffect, useState } from 'react';
import Button from '@/components/ui/button/Button';
import Badge from '@/components/ui/badge/Badge';
import Alert from '@/components/ui/alert/Alert';

interface KnowledgeEntry {
  id: number;
  category: string;
  title: string | null;
  content: string;
  is_recommended: boolean;
  is_mandatory: boolean;
  sort_order: number;
  is_active: boolean;
}

interface KnowledgeStats {
  total: number;
  byCategory: Record<string, number>;
  mandatory: number;
  recommended: number;
}

export default function KnowledgePage() {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newContent, setNewContent] = useState('');
  const [newCategory, setNewCategory] = useState('跟单策略');
  const [newMandatory, setNewMandatory] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editContent, setEditContent] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/agent/knowledge?stats=true');
      const data = await res.json();
      if (data.ok) {
        setEntries(data.data.entries);
        setStats(data.data.stats);
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
  }, []);

  const handleAdd = async () => {
    if (!newContent.trim()) return;
    
    setSubmitting(true);
    try {
      const res = await fetch('/api/agent/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: newCategory,
          content: newContent,
          is_mandatory: newMandatory,
        }),
      });
      
      const data = await res.json();
      
      if (data.ok) {
        setNewContent('');
        await load();
      } else {
        setError(data.error || 'Failed to add');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdate = async (id: number) => {
    if (!editContent.trim()) return;
    
    try {
      const res = await fetch(`/api/agent/knowledge/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editContent }),
      });
      
      const data = await res.json();
      
      if (data.ok) {
        setEditingId(null);
        await load();
      } else {
        setError(data.error || 'Failed to update');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('确定要删除这条知识库规则吗？')) return;
    
    try {
      const res = await fetch(`/api/agent/knowledge/${id}`, {
        method: 'DELETE',
      });
      
      const data = await res.json();
      
      if (data.ok) {
        await load();
      } else {
        setError(data.error || 'Failed to delete');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    }
  };

  const toggleMandatory = async (entry: KnowledgeEntry) => {
    try {
      const res = await fetch(`/api/agent/knowledge/${entry.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_mandatory: !entry.is_mandatory }),
      });
      
      const data = await res.json();
      
      if (data.ok) {
        await load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    }
  };

  if (loading) {
    return <div className="p-6">加载中...</div>;
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">知识库</h1>
          {stats && (
            <p className="text-gray-500 mt-1">
              {stats.total} 条 · 强制 {stats.mandatory} · 推荐 {stats.recommended}
              {Object.keys(stats.byCategory).length > 0 && ' · 分类: '}
              {Object.entries(stats.byCategory).map(([cat, count]) => `${cat} ${count}`).join(', ')}
            </p>
          )}
        </div>
      </div>

      {error && <Alert variant="error" title="错误" message={error} />}

      {/* New entry form */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold mb-4">添加新规则</h3>
        <div className="space-y-3">
          <div className="flex gap-3">
            <select
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              className="border border-gray-300 dark:border-gray-600 rounded px-3 py-2 bg-white dark:bg-gray-700"
            >
              <option value="跟单策略">跟单策略</option>
              <option value="参数调整">参数调整</option>
              <option value="风控规则">风控规则</option>
              <option value="其他">其他</option>
            </select>
            <label className="flex items-center gap-2 px-3 py-2">
              <input
                type="checkbox"
                checked={newMandatory}
                onChange={(e) => setNewMandatory(e.target.checked)}
                className="rounded"
              />
              <span className="text-sm">强制规则</span>
            </label>
          </div>
          <textarea
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleAdd();
              }
            }}
            placeholder="想到什么就写一句吧...（回车提交，shift+回车换行）"
            className="w-full border border-gray-300 dark:border-gray-600 rounded p-3 bg-white dark:bg-gray-700 min-h-[80px]"
          />
          <div className="flex justify-end">
            <Button
              variant="primary"
              onClick={handleAdd}
              disabled={submitting || !newContent.trim()}
            >
              {submitting ? '保存中...' : '写进去'}
            </Button>
          </div>
        </div>
      </div>

      {/* Entries list */}
      <div className="space-y-3">
        {entries.length === 0 ? (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-8 text-center text-gray-500">
            还没有知识库规则
          </div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.id}
              className="bg-white dark:bg-gray-800 rounded-lg shadow p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <Badge color="primary" size="sm">
                      {entry.category}
                    </Badge>
                    {entry.is_mandatory && (
                      <Badge color="error" size="sm">强制</Badge>
                    )}
                    {entry.is_recommended && !entry.is_mandatory && (
                      <Badge color="warning" size="sm">推荐</Badge>
                    )}
                  </div>
                  {editingId === entry.id ? (
                    <div className="space-y-2">
                      <textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        className="w-full border border-gray-300 dark:border-gray-600 rounded p-2 bg-white dark:bg-gray-700 min-h-[60px]"
                      />
                      <div className="flex gap-2">
                        <Button
                          variant="primary"
                          onClick={() => handleUpdate(entry.id)}
                        >
                          保存
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => setEditingId(null)}
                        >
                          取消
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-gray-700 dark:text-gray-300">
                      {entry.content}
                    </p>
                  )}
                </div>
                {editingId !== entry.id && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => toggleMandatory(entry)}
                      className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1"
                    >
                      {entry.is_mandatory ? '取消强制' : '设为强制'}
                    </button>
                    <button
                      onClick={() => {
                        setEditingId(entry.id);
                        setEditContent(entry.content);
                      }}
                      className="text-xs text-blue-600 hover:text-blue-800 px-2 py-1"
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => handleDelete(entry.id)}
                      className="text-xs text-red-600 hover:text-red-800 px-2 py-1"
                    >
                      删除
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
