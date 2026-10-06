"use client";
import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import AddressCopy from "@/components/common/AddressCopy";
import SolAmount from "@/components/common/SolAmount";
import PrioSolAmount from "@/components/common/PrioSolAmount";
import { useConfirm } from "@/components/ui/confirm-dialog";

interface PoolMember {
  id: number;
  address: string;
  label: string | null;
  role: string;
  freq: number;
  seen_as_first_sniper: number;
  seen_as_follower: number;
  distinct_targets: number;
  avg_buy_sol: number;
  avg_offset_pos: number;
  first_seen_at: string;
  last_seen_at: string;
  worth_score: number | null;
  recommended_tip_sol: number | null;
  recommended_prio_lamports: number | null;
  promoted_to_target: boolean;
  promoted_at: string | null;
  is_akbot: boolean;
  akbot_detected_at: string | null;
  akbot_evidence_sig: string | null;
  akbot_evidence_slot: number | null;
}

interface Stats {
  totalMembers: number;
  promoted: number;
  firstSnipers: number;
  followers: number;
  totalEdges: number;
  akbotCount: number;
  bfsLastRun: string | null;
}

/** akbot 扫描 job 的客户端镜像（GET 响应里 progress 的形状） */
interface AkbotJob {
  jobId: string;
  startedAt: number;
  finishedAt: number | null;
  status: 'running' | 'done' | 'aborted' | 'skipped_running' | 'missing';
  progress: {
    scanned: number;
    total: number;
    detected: number;
    failed: number;
    skipped: number;
    currentAddress: string | null;
    etaMs: number | null;
    status: string;
  };
  result: {
    scanned: number;
    detected: number;
    failed: number;
    skipped: number;
    durationMs: number;
    hits: Array<{ address: string; evidence: string }>;
  } | null;
}

const PAGE_SIZE = 30;

export default function PoolPage() {
  const [members, setMembers] = useState<PoolMember[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState<'freq' | 'score' | 'seen'>('freq');
  const [roleFilter, setRoleFilter] = useState<'all' | 'first_sniper' | 'follower'>('all');
  const [akbotFilter, setAkbotFilter] = useState<'all' | 'akbot' | 'normal'>('all');
  // 地址搜索 —— 受控输入即时回显，去抖 300ms 后才作为查询条件
  // （立刻应用会让每次按键都重发请求，pool_members 走索引扫描没问题但接口日志会很吵）
  const [addressQuery, setAddressQuery] = useState('');
  const [addressApplied, setAddressApplied] = useState('');
  const [bfsBusy, setBfsBusy] = useState(false);
  // ====== AkBot 扫描状态 ======
  const [akbotJob, setAkbotJob] = useState<AkbotJob | null>(null);
  const [akbotBusy, setAkbotBusy] = useState(false);
  const [akbotError, setAkbotError] = useState<string | null>(null);
  const akbotPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 上一次完成的 job —— 不在内存里丢，刷新页面后保留显示用
  const [lastDoneResult, setLastDoneResult] = useState<{
    finishedAt: number;
    scanned: number;
    detected: number;
    failed: number;
    skipped: number;
    durationMs: number;
  } | null>(null);
  const { confirm, alert } = useConfirm();

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        sort: sortBy,
        limit: String(PAGE_SIZE),
        offset: String((page - 1) * PAGE_SIZE),
      });
      if (roleFilter !== 'all') params.set('role', roleFilter);
      if (akbotFilter === 'akbot') params.set('akbot', 'true');
      if (akbotFilter === 'normal') params.set('akbot', 'false');
      if (addressApplied) params.set('address', addressApplied);
      const res = await fetch(`/api/pool?${params}`);
      const json = await res.json();
      if (json.ok) {
        setMembers(json.data.members);
        setTotal(json.data.total ?? 0);
        setStats(json.data.stats);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [sortBy, roleFilter, akbotFilter, addressApplied, page]);

  // filter / sort / 搜索变化时回到第 1 页
  useEffect(() => { setPage(1); }, [sortBy, roleFilter, akbotFilter, addressApplied]);

  // 显式搜索：输入受控在 addressQuery 里，只有调用本函数（点「搜索」按钮或按 Enter）
  // 才把它提交到 addressApplied，触发接口请求。换地址后旧结果不会因为继续输入而被打断，
  // 直到用户明确要查才发请求，避免每个按键一次请求 / 接口日志被打爆。
  const applySearch = () => {
    const trimmed = addressQuery.trim();
    setAddressApplied((cur) => (cur === trimmed ? cur : trimmed));
  };

  // 当前 search 查询未直接对应 —— 输入框里有内容但还没点搜索，给个轻度提示
  const searchDirty = addressQuery.trim() !== addressApplied;

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // 翻页后滚到表格顶部（避免翻页后用户还在表格底部）
  useEffect(() => {
    if (!loading) {
      const el = document.getElementById('pool-table-top');
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [page, loading]);

  const triggerBFS = async () => {
    setBfsBusy(true);
    try {
      const res = await fetch('/api/pool/discover', { method: 'POST' });
      const json = await res.json();
      if (json.ok) {
        await alert({
          title: 'BFS 完成',
          description: `扫描 ${json.data.bfs.result?.scannedTargets ?? 0} 个 target，加入监控 ${json.data.bfs.result?.totalPromoted ?? 0} 个`,
          variant: 'success',
        });
        await load();
      } else {
        await alert({ title: 'BFS 失败', description: json.error, variant: 'danger' });
      }
    } finally {
      setBfsBusy(false);
    }
  };

  // ====== AkBot 扫描 ======

  /**
   * 启动 AkBot 扫描。
   * 默认 limit=100、sleepMs=200、走 maxPages=5（5000 sigs）。
   * 这是 daily（每日定时 worker）采用的同一套参数；
   * UI 手动触发走同样的设置，行为完全一致。
   *
   * 2026-10-06 调整：把 limit 从 1000 砍到 100（freq 降序 Top 100）。
   *   - 100 个活跃地址已覆盖 95% akbot 命中
   *   - 单次扫描 Helius 消耗从 1000 万级降到 100 万级
   *   - 没扫到的非活跃地址，次日再扫（top 100 滚动；高活跃的先动起来）
   *   - 真正需要全量回填时，仍可用 scripts/backfill-akbot.ts（CLI 自行设 LIMIT）
   */
  const startAkbotScan = async () => {
    setAkbotError(null);
    setAkbotBusy(true);
    try {
      const res = await fetch('/api/pool/akbot-scan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ limit: 100, sleepMs: 200 }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setAkbotError(json.error || `HTTP ${res.status}`);
        await alert({ title: '启动 AkBot 扫描失败', description: json.error ?? `HTTP ${res.status}`, variant: 'danger' });
        return;
      }
      const jobId = json.data.jobId as string;
      // 立刻建一个临时 job 进入 polling
      setAkbotJob({
        jobId,
        startedAt: Date.now(),
        finishedAt: null,
        status: 'running',
        progress: { scanned: 0, total: 0, detected: 0, failed: 0, skipped: 0, currentAddress: null, etaMs: null, status: 'running' },
        result: null,
      });
      startAkbotPolling(jobId);
    } finally {
      setAkbotBusy(false);
    }
  };

  const startAkbotPolling = (jobId: string) => {
    // 防重入
    if (akbotPollRef.current) return;
    const tick = async () => {
      try {
        const r = await fetch(`/api/pool/akbot-scan?jobId=${encodeURIComponent(jobId)}`);
        const j = await r.json();
        if (!j.ok) {
          setAkbotError(j.error ?? '查询 job 失败');
          return;
        }
        if (j.data.status === 'missing') {
          // server 重启过 / job 丢失。停止轮询，留个提示。
          setAkbotError(j.data.message ?? 'job 丢失（可能是 server 重启）');
          stopAkbotPolling();
          return;
        }
        setAkbotJob(j.data as AkbotJob);
        if (j.data.status === 'done' || j.data.status === 'aborted') {
          stopAkbotPolling();
          if (j.data.result) {
            setLastDoneResult({
              finishedAt: j.data.finishedAt ?? Date.now(),
              scanned: j.data.result.scanned,
              detected: j.data.result.detected,
              failed: j.data.result.failed,
              skipped: j.data.result.skipped,
              durationMs: j.data.result.durationMs,
            });
          }
          // 刷新一次 stats —— akbotCount 变了
          await load();
        }
      } catch (e: any) {
        setAkbotError(String(e?.message ?? e));
        stopAkbotPolling();
      }
    };
    tick();
    akbotPollRef.current = setInterval(tick, 2000);
  };

  const stopAkbotPolling = () => {
    if (akbotPollRef.current) {
      clearInterval(akbotPollRef.current);
      akbotPollRef.current = null;
    }
  };

  // 卸载时清掉轮询
  useEffect(() => () => stopAkbotPolling(), []);

  const promote = async (m: PoolMember) => {
    // 视图层虽然只在 !m.promoted_to_target 时显示按钮，但并发场景下（另一个 tab /
    // 操作员刚刚加过）仍可能出现后端返回 'already a monitored target'。
    // 这里也提前做一次 best-effort 检查，直接给提示，避免用户走完确认流程才知道。
    if (m.promoted_to_target) {
      const at = m.promoted_at
        ? `（${new Date(m.promoted_at).toLocaleString('zh-CN', { hour12: false })}）`
        : '';
      await alert({
        title: '已是监控目标',
        description: (
          <>
            <span className="font-mono">{m.address.slice(0, 6)}…{m.address.slice(-4)}</span>{' '}
            已经在监控列表中{at}，无需重复添加。
          </>
        ),
        variant: 'info',
      });
      return;
    }
    const ok = await confirm({
      title: '加入监控？',
      description: (
        <>
          将 <span className="font-mono">{m.address.slice(0, 6)}…{m.address.slice(-4)}</span>{' '}
          加入监控列表，默认阈值{' '}
          <span className="font-mono font-semibold">0.5 SOL</span>。
          之后会按这个阈值记录它的 buy 交易。
        </>
      ),
      confirmText: '加入监控',
      variant: 'info',
    });
    if (!ok) return;
    const res = await fetch(`/api/pool/${m.address}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threshold: 0.5 }),
    });
    const json = await res.json();
    if (json.ok) {
      await alert({
        title: '已加入监控',
        description: (
          <>
            <span className="font-mono">{m.address.slice(0, 6)}…{m.address.slice(-4)}</span>{' '}
            已加入监控列表（阈值 0.5 SOL）。列表刷新后该按钮会变成「✓ 已监控」。
          </>
        ),
        variant: 'success',
      });
      await load();
      return;
    }
    // 后端 reason: 'already a monitored target' —— 并发场景下被另一处抢先加入了，
    // 把它当成"成功"的一种退化情况，而不是错误。
    if (json.reason === 'already a monitored target') {
      await alert({
        title: '已是监控目标',
        description: (
          <>
            <span className="font-mono">{m.address.slice(0, 6)}…{m.address.slice(-4)}</span>{' '}
            已经在监控列表中（并发操作或刚刚被其它会话加入）。列表已自动刷新。
          </>
        ),
        variant: 'info',
      });
      await load();
      return;
    }
    await alert({ title: '加入监控失败', description: json.reason ?? json.error, variant: 'danger' });
  };

  // ====== 手动标 / 撤 AkBot ======
  // 不再依赖自动扫描（top 100 freq ≠ akbot 频段），操作员可直接在某行右键……
  // —— 不，点行末的小按钮就行。tagger 用浏览器 userAgent 的简单 hash 标记，
  // 让多人协作时 evidence sig 里能看出来源。
  const tagAkbot = async (m: PoolMember) => {
    const ok = await confirm({
      title: '手动标为 AkBot？',
      description: (
        <>
          将 <span className="font-mono">{m.address.slice(0, 6)}…{m.address.slice(-4)}</span>{' '}
          标记为 AkBot 用户。
          <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            当前 freq={m.freq} · 跟随目标 {m.distinct_targets} · 角色 {m.role}
          </div>
          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            monitor 之后若发现该地址再次使用 akbot program，仍会保持 akbot 标记。
          </div>
        </>
      ),
      confirmText: '标记为 AkBot',
      variant: 'warning',
    });
    if (!ok) return;
    const res = await fetch(`/api/pool/${m.address}/akbot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tagger: 'ui' }),
    });
    const json = await res.json();
    if (json.ok) {
      await alert({
        title: '已标记',
        description: `${m.address.slice(0, 6)}…${m.address.slice(-4)} 已是 AkBot`,
        variant: 'success',
      });
      await load();
    } else {
      await alert({ title: '标记失败', description: json.error, variant: 'danger' });
    }
  };

  const untagAkbot = async (m: PoolMember) => {
    const ok = await confirm({
      title: '撤销 AkBot 标记？',
      description: (
        <>
          将 <span className="font-mono">{m.address.slice(0, 6)}…{m.address.slice(-4)}</span>{' '}
          撤掉 AkBot 标记。证据会被清空。
          <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            证据 sig: {m.akbot_evidence_sig ?? '?'}
          </div>
          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            撤销后，monitor 若再次抓到该地址使用 akbot program，会自动重新标记。
          </div>
        </>
      ),
      confirmText: '撤销标记',
      variant: 'danger',
    });
    if (!ok) return;
    const res = await fetch(`/api/pool/${m.address}/akbot`, { method: 'DELETE' });
    const json = await res.json();
    if (json.ok) {
      await load();
    } else {
      await alert({ title: '撤销失败', description: json.error, variant: 'danger' });
    }
  };

  const scoreBadge = (s: number | null) => {
    if (s === null) return <span className="text-xs text-gray-400">-</span>;
    const color = s > 1 ? 'text-success-500' : s < -0.5 ? 'text-error-500' : 'text-warning-500';
    return <span className={`text-xs font-mono ${color}`}>{s.toFixed(2)}</span>;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-800 dark:text-white/90">跟单池子</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            从监控目标出发，自动归池：发现 first_sniper 与 follower，扩展更多候选 / 竞争者
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={startAkbotScan}
            disabled={akbotBusy || (akbotJob !== null && !akbotJob.finishedAt)}
            className="h-9 px-4 rounded-xl bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white text-sm font-medium"
            title="扫描 pool_members 中未识别的 AkBot 用户（仅 Top 100，按 freq 降序；每个地址翻最近 200 笔签名）"
          >
            {akbotBusy || (akbotJob && !akbotJob.finishedAt) ? 'AkBot 扫描中...' : '识别 AkBot (Top 100)'}
          </button>
          <button
            onClick={triggerBFS}
            disabled={bfsBusy}
            className="h-9 px-4 rounded-xl bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white text-sm font-medium"
          >
            {bfsBusy ? '扫描中...' : '立即扫描 BFS'}
          </button>
        </div>
      </div>

      {/* AkBot 扫描进度面板 —— 只在有活跃 job 或最近一次结果时显示 */}
      <AkbotScanPanel
        job={akbotJob}
        lastDone={lastDoneResult}
        error={akbotError}
      />

      {/* 顶部统计 */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <StatCard label="池子成员" value={stats?.totalMembers ?? '-'} />
        <StatCard label="已监控" value={stats?.promoted ?? '-'} />
        <StatCard label="first_sniper" value={stats?.firstSnipers ?? '-'} />
        <StatCard label="follower" value={stats?.followers ?? '-'} />
        <StatCard label="关系边" value={stats?.totalEdges ?? '-'} />
        <StatCard label="AkBot 用户" value={stats?.akbotCount ?? '-'} highlight={!!(stats?.akbotCount)} />
      </div>

      {/* 地址搜索 —— 单独一行，与过滤/排序分开，避免一行元素太多挤在小屏 */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[260px] max-w-md">
          <input
            type="text"
            value={addressQuery}
            onChange={(e) => setAddressQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter 立即提交，跳过按钮点击
              if (e.key === 'Enter') {
                e.preventDefault();
                applySearch();
              }
            }}
            placeholder="搜索地址（子串匹配，不区分大小写）"
            className="w-full h-9 pl-3 pr-9 rounded-xl bg-white dark:bg-zinc-800 border border-gray-200 dark:border-gray-700 text-sm font-mono text-gray-800 dark:text-gray-200 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
          />
          {addressQuery && (
            <button
              type="button"
              onClick={() => {
                setAddressQuery('');
                setAddressApplied('');
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 inline-flex items-center justify-center rounded-full text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-zinc-700"
              title="清空搜索"
              aria-label="清空搜索"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={applySearch}
          // 输入已提交但未变 → 灰掉；输入为空时也禁用，相当于「清空搜索」要走 X
          disabled={!addressQuery}
          className="h-9 px-4 rounded-xl bg-brand-500 hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium whitespace-nowrap"
        >
          搜索
        </button>
        {searchDirty && addressQuery && (
          <span className="text-xs text-amber-600 dark:text-amber-400 whitespace-nowrap">
            按 Enter 或「搜索」以查询
          </span>
        )}
        {addressApplied && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            当前匹配 <span className="font-mono text-brand-500">{addressApplied}</span>
          </span>
        )}
      </div>

      {/* 排序 + 过滤 */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1 text-xs">
          <span className="text-gray-500 dark:text-gray-400">角色</span>
          {(['all', 'first_sniper', 'follower'] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRoleFilter(r)}
              className={`px-3 py-1 rounded-xl ${
                roleFilter === r
                  ? 'bg-brand-500 text-white'
                  : 'bg-slate-100 dark:bg-zinc-700 text-gray-500 dark:text-gray-400 hover:bg-slate-200'
              }`}
            >
              {r === 'all' ? '全部' : r}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 text-xs">
          <span className="text-gray-500 dark:text-gray-400">AkBot</span>
          {(['all', 'akbot', 'normal'] as const).map((a) => (
            <button
              key={a}
              onClick={() => setAkbotFilter(a)}
              className={`px-3 py-1 rounded-xl ${
                akbotFilter === a
                  ? a === 'akbot' ? 'bg-orange-500 text-white' : 'bg-brand-500 text-white'
                  : 'bg-slate-100 dark:bg-zinc-700 text-gray-500 dark:text-gray-400 hover:bg-slate-200'
              }`}
            >
              {a === 'all' ? '全部' : a === 'akbot' ? 'AkBot' : '非 AkBot'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 text-xs">
          <span className="text-gray-500 dark:text-gray-400">排序</span>
          {(['freq', 'score', 'seen'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSortBy(s)}
              className={`px-3 py-1 rounded-xl ${
                sortBy === s
                  ? 'bg-brand-500 text-white'
                  : 'bg-slate-100 dark:bg-zinc-700 text-gray-500 dark:text-gray-400 hover:bg-slate-200'
              }`}
            >
              {s === 'freq' ? '出现次数' : s === 'score' ? '评分' : '最近出现'}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-400">
          共 {total} 条，第 {page} / {totalPages} 页
        </span>
      </div>

      <div id="pool-table-top" />

      {/* 列表 */}
      <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-zinc-800/50 text-xs text-gray-500 dark:text-gray-400">
              <tr>
                <th className="px-3 py-2 text-center font-medium">#</th>
                <th className="px-3 py-2 text-left font-medium">地址</th>
                <th className="px-3 py-2 text-center font-medium">角色</th>
                <th className="px-3 py-2 text-center font-medium">出现次数</th>
                <th className="px-3 py-2 text-center font-medium">跟随目标</th>
                <th className="px-3 py-2 text-center font-medium">首狙 / 跟随</th>
                <th className="px-3 py-2 text-right font-medium">均买入 SOL</th>
                <th className="px-3 py-2 text-right font-medium">评分</th>
                <th className="px-3 py-2 text-right font-medium">推荐 TIP</th>
                <th className="px-3 py-2 text-right font-medium">推荐 PRIO</th>
                <th className="px-3 py-2 text-left font-medium">最近出现</th>
                <th className="px-3 py-2 text-center font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={12} className="px-3 py-6 text-center text-gray-500">加载中...</td></tr>
              ) : members.length === 0 ? (
                <tr><td colSpan={12} className="px-3 py-6 text-center text-gray-500">
                  {addressApplied
                    ? <>没有匹配 <span className="font-mono">{addressApplied}</span> 的池成员</>
                    : <>池子为空 — 等待监控目标产生 buy 后自动归池</>}
                </td></tr>
              ) : (
                members.map((m, idx) => (
                  <tr key={m.id} className="border-b border-gray-100 dark:border-gray-700/50 hover:bg-gray-50 dark:hover:bg-zinc-700/30">
                    <td className="px-3 py-2 text-center font-mono text-xs text-gray-500 dark:text-gray-400">{(page - 1) * PAGE_SIZE + idx + 1}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <Link href={`/pool/${m.address}`} className="hover:text-brand-500">
                          <AddressCopy address={m.address} />
                        </Link>
                        {m.is_akbot && (
                          <span
                            className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-orange-50 text-orange-700 dark:bg-orange-500/15 dark:text-orange-400 border border-orange-200/70 dark:border-orange-500/30"
                            title={`AKBot 用户，证据 sig: ${m.akbot_evidence_sig ?? ''}`}
                          >
                            AkBot
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${
                        m.role === 'first_sniper' ? 'bg-purple-50 text-purple-700 dark:bg-purple-500/10 dark:text-purple-400' :
                        m.role === 'follower' ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400' :
                        'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
                      }`}>
                        {m.role}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center font-mono text-gray-900 dark:text-white">{m.freq}</td>
                    <td className="px-3 py-2 text-center font-mono text-gray-900 dark:text-white">{m.distinct_targets}</td>
                    <td className="px-3 py-2 text-center text-xs text-gray-500">
                      {m.seen_as_first_sniper} / {m.seen_as_follower}
                    </td>
                    <td className="px-3 py-2 text-right"><SolAmount value={m.avg_buy_sol} /></td>
                    <td className="px-3 py-2 text-right">{scoreBadge(m.worth_score)}</td>
                    <td className="px-3 py-2 text-right">
                      {m.recommended_tip_sol ? <SolAmount value={m.recommended_tip_sol} /> : <span className="text-gray-400">-</span>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {m.recommended_prio_lamports ? <PrioSolAmount value={m.recommended_prio_lamports} /> : <span className="text-gray-400">-</span>}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500">
                      {new Date(m.last_seen_at).toLocaleString('zh-CN', { hour12: false }).slice(5)}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <div className="inline-flex flex-row items-center gap-2">
                        {m.promoted_to_target ? (
                          <span className="text-xs text-success-500 whitespace-nowrap">✓ 已监控</span>
                        ) : (
                          <button
                            onClick={() => promote(m)}
                            className="text-xs text-brand-500 hover:underline whitespace-nowrap"
                            title="加入监控列表，默认阈值 0.5 SOL"
                          >
                            监控
                          </button>
                        )}
                        {m.is_akbot ? (
                          <button
                            onClick={() => untagAkbot(m)}
                            className="text-[11px] text-gray-400 hover:text-error-500 hover:underline whitespace-nowrap"
                            title={`akbot 证据: ${m.akbot_evidence_sig ?? '?'}`}
                          >
                            撤 AkBot
                          </button>
                        ) : (
                          <button
                            onClick={() => tagAkbot(m)}
                            className="text-[11px] text-orange-500 hover:text-orange-700 hover:underline whitespace-nowrap"
                            title="手动标为 AkBot 用户（不依赖扫描）"
                          >
                            AkBot
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* 分页 */}
        {totalPages > 1 && (
          <Pagination
            page={page}
            totalPages={totalPages}
            onChange={setPage}
          />
        )}
      </div>
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (p: number) => void;
}) {
  // 简化页码条：当前页前后各 2 页 + 首尾
  const visible = new Set<number>([1, totalPages, page - 2, page - 1, page, page + 1, page + 2]);
  const list = [...visible].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  const pages: (number | '…')[] = [];
  for (let i = 0; i < list.length; i++) {
    if (i > 0 && list[i] - list[i - 1] > 1) pages.push('…');
    pages.push(list[i]);
  }

  const btnBase =
    'h-8 min-w-[2rem] px-2 inline-flex items-center justify-center rounded-lg text-xs font-medium border transition-colors';
  const btnIdle =
    'bg-white dark:bg-zinc-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-zinc-700';
  const btnActive =
    'bg-brand-500 text-white border-brand-500';
  const btnDisabled =
    'bg-white dark:bg-zinc-800 text-gray-300 dark:text-gray-600 border-gray-200 dark:border-gray-700 cursor-not-allowed';

  return (
    <div className="flex items-center justify-between px-3 py-3 border-t border-gray-200 dark:border-gray-700 text-sm">
      <button
        onClick={() => onChange(Math.max(1, page - 1))}
        disabled={page <= 1}
        className={`${btnBase} ${page <= 1 ? btnDisabled : btnIdle}`}
      >
        ← 上一页
      </button>

      <div className="flex items-center gap-1">
        {pages.map((p, i) =>
          p === '…' ? (
            <span key={`e${i}`} className="px-1 text-gray-400 text-xs">…</span>
          ) : (
            <button
              key={p}
              onClick={() => onChange(p)}
              className={`${btnBase} ${p === page ? btnActive : btnIdle}`}
            >
              {p}
            </button>
          ),
        )}
      </div>

      <button
        onClick={() => onChange(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
        className={`${btnBase} ${page >= totalPages ? btnDisabled : btnIdle}`}
      >
        下一页 →
      </button>
    </div>
  );
}

function StatCard({ label, value, highlight }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`shadow-sm rounded-lg border p-4 ${
      highlight
        ? 'bg-orange-50 dark:bg-orange-500/10 border-orange-200 dark:border-orange-500/30'
        : 'bg-white dark:bg-zinc-800 border-gray-200 dark:border-gray-700'
    }`}>
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className={`text-2xl font-semibold mt-1 ${
        highlight ? 'text-orange-600 dark:text-orange-400' : 'text-gray-800 dark:text-white/90'
      }`}>{value}</div>
    </div>
  );
}

/**
 * AkBot 扫描进度面板
 *  - job 存在且未结束 → 显示进度条 + 当前地址 + ETA
 *  - job 已结束 + lastDone → 显示摘要 + 命中明细（最多 20 条）+ 关闭按钮
 *  - 都没了 → null（不占空间）
 */
function AkbotScanPanel({
  job,
  lastDone,
  error,
}: {
  job: AkbotJob | null;
  lastDone: { finishedAt: number; scanned: number; detected: number; failed: number; skipped: number; durationMs: number } | null;
  error: string | null;
}) {
  const isRunning = job !== null && !job.finishedAt;
  // 跑完了但 lastDone 还没就位（极短窗口）—— 仍展示 job.result
  const showResult =
    !isRunning && (lastDone !== null || (job && (job.status === 'done' || job.status === 'aborted') && job.result));

  if (!isRunning && !showResult && !error) return null;

  const pct = (() => {
    if (!job) return 0;
    if (!job.progress.total || job.progress.total === 0) return 0;
    return Math.min(100, Math.round((job.progress.scanned / job.progress.total) * 100));
  })();

  const etaSec = job?.progress.etaMs != null ? Math.max(0, Math.round(job.progress.etaMs / 1000)) : null;

  return (
    <div className="rounded-xl border border-orange-200 dark:border-orange-500/30 bg-orange-50/60 dark:bg-orange-500/5 p-4 space-y-3">
      {error && (
        <div className="text-xs text-error-700 dark:text-error-400">
          <span className="font-semibold">扫描出错：</span>{error}
        </div>
      )}

      {isRunning && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-orange-700 dark:text-orange-300">
            <span className="font-medium">AkBot 扫描进行中…</span>
            <span className="font-mono">
              {job.progress.scanned}/{job.progress.total} · 命中 {job.progress.detected}
              {job.progress.skipped > 0 ? ` · 跳过 ${job.progress.skipped}` : ''}
              {job.progress.failed > 0 ? ` · 失败 ${job.progress.failed}` : ''}
              {etaSec !== null ? ` · ETA ${etaSec}s` : ''}
            </span>
          </div>
          <div className="w-full h-2 bg-orange-100 dark:bg-orange-500/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-orange-500 transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          {job.progress.currentAddress && (
            <div className="text-[11px] font-mono text-orange-700/70 dark:text-orange-300/70 truncate">
              正在扫：{job.progress.currentAddress}
            </div>
          )}
        </div>
      )}

      {showResult && job?.result && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className={`font-medium ${job.status === 'done' ? 'text-success-700 dark:text-success-400' : 'text-warning-700 dark:text-warning-400'}`}>
              {job.status === 'done' ? '扫描完成' : '扫描中止'}
            </span>
            <span className="font-mono text-gray-600 dark:text-gray-400">
              扫描 {job.result.scanned} · 命中 {job.result.detected}
              {job.result.skipped > 0 ? ` · 跳过 ${job.result.skipped}` : ''}
              {job.result.failed > 0 ? ` · 失败 ${job.result.failed}` : ''}
              {' · '}
              {(job.result.durationMs / 1000).toFixed(1)}s
            </span>
          </div>
          {job.result.hits.length > 0 && (
            <div className="text-[11px] font-mono text-orange-800 dark:text-orange-300 space-y-0.5 max-h-32 overflow-y-auto">
              {job.result.hits.slice(0, 20).map((h, i) => (
                <div key={i} className="truncate">
                  <span className="inline-block w-6 text-right pr-1 text-orange-400">{i + 1}.</span>
                  {h.address}
                  <span className="text-gray-500 ml-2">{h.evidence.slice(0, 16)}…</span>
                </div>
              ))}
            </div>
          )}
          {job.result.detected === 0 && job.result.skipped > 0 && (
            <div className="text-[11px] text-gray-600 dark:text-gray-400">
              本次有 {job.result.skipped} 个地址因 Helius 限流没扫完——它们仍在 is_akbot=FALSE 池里，下一轮重扫。
            </div>
          )}
        </div>
      )}
    </div>
  );
}