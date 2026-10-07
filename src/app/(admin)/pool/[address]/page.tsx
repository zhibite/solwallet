"use client";
import React, { useEffect, useState } from "react";
import Link from "next/link";
import AddressCopy from "@/components/common/AddressCopy";
import SolAmount from "@/components/common/SolAmount";
import PrioSolAmount from "@/components/common/PrioSolAmount";
import RelativeTime from "@/components/common/RelativeTime";
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
  target_addresses: string[];
  mints_sample: string[];
  avg_buy_sol: number;
  avg_offset_pos: number;
  worth_score: number | null;
  recommended_tip_sol: number | null;
  recommended_prio_lamports: number | null;
  // 0011 迁移新增：P75 推荐（"激进推荐"），老 P50 在 recommended_tip_sol
  recommended_tip_sol_p75: number | null;
  recommended_prio_lamports_p75: number | null;
  promoted_to_target: boolean;
  promoted_at: string | null;
  is_akbot: boolean;
  akbot_detected_at: string | null;
  akbot_evidence_sig: string | null;
  akbot_evidence_slot: number | null;
}

interface PoolEdge {
  id: number;
  follower: string;
  target: string;
  freq: number;
  same_slot_count: number;
  next_slot_count: number;
  win_count: number;
  fail_count: number;
  avg_offset_pos: number | null;
  avg_buy_sol: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

interface AnalyticsTrendPoint {
  trade_signature: string;
  block_time: string;
  buyer_count: number;
  success_count: number;
  failed_count: number;
  top_tip_sol: string;
  top_prio_lamports: number;
}

interface BuyerDistribution {
  bucket: string;
  success_count: number;
  failed_count: number;
}

interface TopCompetitor {
  address: string;
  freq: number;
  win_count: number;
  fail_count: number;
  win_rate: number;
  avg_offset_pos: number;
  avg_tip_sol: number;
  avg_prio_lamports: number;
}

interface FeeRec {
  // 0011 修复：tip/prio 改为 nullable —— 样本不足时返 null，不再写 0 伪装
  p50_tip_sol: number | null;
  p50_prio_lamports: number | null;
  p75_tip_sol: number | null;
  p75_prio_lamports: number | null;
  success_count: number;
  failed_p50_tip_sol: number | null;
  failed_p50_prio_lamports: number | null;
  failed_count: number;
  sample_size: number;
  last_buy_at: string | null;
}

interface WorthScore {
  /** null = 样本不足等算不出分的情况，不是 0 分。渲染前必须判空 */
  offered: number | null;
  win_rate: number;
  avg_pnl_sol: number;
  median_pnl_sol: number;
  total_pnl_sol: number;
  avg_fee_sol: number;
  cost_ratio: number;
  /** 计入评分的样本数（已实现 pnl 的笔数） */
  trade_count: number;
  /** 回溯窗口内买入总笔数，含持仓中等算不出 pnl 的 */
  total_buys: number;
  /** 算不出分的原因 */
  reason: string | null;
}

export default function PoolDetailPage({ params }: { params: Promise<{ address: string }> }) {
  const [address, setAddress] = useState<string | null>(null);
  const { confirm, alert } = useConfirm();
  const [member, setMember] = useState<PoolMember | null>(null);
  const [following, setFollowing] = useState<PoolEdge[]>([]);
  const [followers, setFollowers] = useState<PoolEdge[]>([]);
  const [analytics, setAnalytics] = useState<{
    summary: any;
    trend: AnalyticsTrendPoint[];
    tipDistribution: BuyerDistribution[];
    prioDistribution: BuyerDistribution[];
    topCompetitors: TopCompetitor[];
    pnlDistribution: BuyerDistribution[];
  } | null>(null);
  const [fee, setFee] = useState<FeeRec | null>(null);
  const [score, setScore] = useState<WorthScore | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    params.then(async ({ address }) => {
      setAddress(address);
      setLoading(true);
      try {
        const [memRes, anaRes] = await Promise.all([
          fetch(`/api/pool/${address}`).then((r) => r.json()),
          fetch(`/api/pool/${address}/analytics`).then((r) => r.json()),
        ]);
        if (memRes.ok) {
          setMember(memRes.data.member);
          setFollowing(memRes.data.following ?? []);
          setFollowers(memRes.data.followers ?? []);
        }
        if (anaRes.ok) {
          setAnalytics(anaRes.data.analytics);
          setFee(anaRes.data.fee);
          setScore(anaRes.data.score);
        }
      } finally {
        setLoading(false);
      }
    });
  }, [params]);

  const [monitorThreshold, setMonitorThreshold] = useState<string>('0.5');
  const [markingAkbot, setMarkingAkbot] = useState(false);

  const refresh = async () => {
    if (!address) return;
    const memRes = await fetch(`/api/pool/${address}`).then((r) => r.json());
    if (memRes.ok) {
      setMember(memRes.data.member);
      setFollowing(memRes.data.following ?? []);
      setFollowers(memRes.data.followers ?? []);
    }
  };

  const addToMonitor = async () => {
    if (!address) return;
    // 阈值必须是 >= 0 的有限数字；空白走默认 0.5
    const t = monitorThreshold.trim() === '' ? 0.5 : Number(monitorThreshold);
    if (!Number.isFinite(t) || t < 0) {
      await alert({ title: '阈值无效', description: '阈值必须是 ≥ 0 的数字', variant: 'danger' });
      return;
    }
    const confirmMsg = await confirm({
      title: '加入监控？',
      description: (
        <>
          将 <span className="font-mono">{address.slice(0, 6)}…{address.slice(-4)}</span>{' '}
          加入监控列表，阈值 <span className="font-mono font-semibold">{t} SOL</span>。
          之后会按这个阈值记录它的 buy 交易。
        </>
      ),
      confirmText: '加入监控',
      variant: 'info',
    });
    if (!confirmMsg) return;
    const res = await fetch(`/api/pool/${address}/promote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threshold: t }),
    });
    const json = await res.json();
    if (json.ok) {
      await alert({ title: '已加入监控', variant: 'success' });
      refresh();
    } else {
      await alert({ title: '加入监控失败', description: json.reason ?? json.error, variant: 'danger' });
    }
  };

  const toggleAkbot = async () => {
    if (!address) return;
    if (member?.is_akbot) {
      // 撤销
      const ok = await confirm({
        title: '撤销 AkBot 标记？',
        description: (
          <>
            清除 <span className="font-mono">{address.slice(0, 6)}…{address.slice(-4)}</span>{' '}
            的 AkBot 标记（手动撤销）。如果之后 monitor 又检测到它用 akbot 合约卖币，会被重新标回。
          </>
        ),
        confirmText: '撤销',
        variant: 'warning',
      });
      if (!ok) return;
      setMarkingAkbot(true);
      try {
        const res = await fetch(`/api/pool/${address}/akbot`, { method: 'DELETE' });
        const json = await res.json();
        if (json.ok) await alert({ title: '已撤销 AkBot 标记', variant: 'success' });
        else await alert({ title: '撤销失败', description: json.error, variant: 'danger' });
      } finally {
        setMarkingAkbot(false);
        refresh();
      }
    } else {
      // 标记
      const ok = await confirm({
        title: '标记为 AkBot？',
        description: (
          <>
            把 <span className="font-mono">{address.slice(0, 6)}…{address.slice(-4)}</span>{' '}
            手动标为 AkBot 用户。证据会记录为{' '}
            <span className="font-mono text-xs">manual:&lt;时间戳&gt;</span> 以便和真实 tx 区分。
          </>
        ),
        confirmText: '标记 AkBot',
        variant: 'warning',
      });
      if (!ok) return;
      setMarkingAkbot(true);
      try {
        const res = await fetch(`/api/pool/${address}/akbot`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tagger: 'ui' }),
        });
        const json = await res.json();
        if (json.ok) await alert({ title: '已标记 AkBot', variant: 'success' });
        else await alert({ title: '标记失败', description: json.error, variant: 'danger' });
      } finally {
        setMarkingAkbot(false);
        refresh();
      }
    }
  };

  if (loading || !address) return <div className="p-6 text-center text-gray-500">加载中...</div>;
  if (!member) return <div className="p-6 text-center text-gray-500">地址不在池子中 — 触发 BFS 后再访问</div>;

  const maxDist = (arr: BuyerDistribution[]) => Math.max(1, ...arr.flatMap((b) => [b.success_count, b.failed_count]));

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <Link href="/pool" className="text-xs text-brand-500 hover:underline">← 池子</Link>
            <span className="text-xs text-gray-400">/</span>
            <h1 className="text-lg font-semibold text-gray-800 dark:text-white/90">
              <AddressCopy address={member.address} length={6} />
            </h1>
            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs ${
              member.role === 'first_sniper' ? 'bg-purple-50 text-purple-700 dark:bg-purple-500/10 dark:text-purple-400' :
              member.role === 'follower' ? 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400' :
              'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
            }`}>
              {member.role}
            </span>
            {member.promoted_to_target && (
              <span className="text-xs text-success-500">已加入监控</span>
            )}
            {member.is_akbot && (
              <span
                className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-orange-100 dark:bg-orange-500/15 text-orange-700 dark:text-orange-400 border border-orange-200 dark:border-orange-500/30"
                title={`检测时间: ${member.akbot_detected_at ?? ''}\n证据签名: ${member.akbot_evidence_sig ?? ''}`}
              >
                🤖 AkBot 用户
              </span>
            )}
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            出现 {member.freq} 次 · 跟随 {member.distinct_targets} 个独立目标
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!member.promoted_to_target ? (
            <div className="flex items-center gap-2">
              <div className="flex items-center h-9 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-zinc-800 overflow-hidden focus-within:ring-2 focus-within:ring-brand-500/40">
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  value={monitorThreshold}
                  onChange={(e) => setMonitorThreshold(e.target.value)}
                  className="w-20 px-3 py-1 text-right text-gray-800 dark:text-gray-100 bg-transparent outline-none text-sm"
                  aria-label="监控阈值"
                  title="监控阈值 (SOL)"
                />
                <span className="px-2 text-xs text-gray-400 border-l border-gray-200 dark:border-gray-700">SOL</span>
              </div>
              <button
                onClick={addToMonitor}
                className="h-9 px-4 rounded-xl bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium whitespace-nowrap"
              >
                加入监控
              </button>
            </div>
          ) : (
            <span className="inline-flex items-center h-9 px-3 rounded-xl bg-success-50 dark:bg-success-500/10 text-success-600 dark:text-success-400 text-sm border border-success-200 dark:border-success-500/30">
              ✓ 已在监控
            </span>
          )}
          <button
            onClick={toggleAkbot}
            disabled={markingAkbot}
            className={`h-9 px-4 rounded-xl text-sm font-medium whitespace-nowrap disabled:opacity-50 ${
              member.is_akbot
                ? 'bg-orange-50 hover:bg-orange-100 text-orange-700 dark:bg-orange-500/10 dark:hover:bg-orange-500/20 dark:text-orange-400 border border-orange-200 dark:border-orange-500/30'
                : 'bg-white hover:bg-gray-50 text-gray-700 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700'
            }`}
          >
            {member.is_akbot ? '✓ 已标 AkBot（点击撤销）' : '🤖 标 AkBot'}
          </button>
        </div>
      </div>

      {/* AkBot 检测详情（命中时显示，方便人工 Solscan 复核） */}
      {member.is_akbot && (
        <div className="bg-orange-50 dark:bg-orange-500/10 border border-orange-200 dark:border-orange-500/30 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-base">🤖</span>
            <h3 className="text-sm font-semibold text-orange-700 dark:text-orange-400">AkBot 用户（卖币通过统一合约）</h3>
          </div>
          <div className="text-xs text-gray-700 dark:text-gray-300 space-y-1">
            <div>
              <span className="text-gray-500">检测时间：</span>
              <span className="font-mono">{member.akbot_detected_at ? new Date(member.akbot_detected_at).toLocaleString('zh-CN', { hour12: false }) : '-'}</span>
            </div>
            <div>
              <span className="text-gray-500">证据 tx：</span>
              <a
                href={`https://solscan.io/tx/${member.akbot_evidence_sig ?? ''}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-orange-700 dark:text-orange-400 hover:underline"
              >
                {member.akbot_evidence_sig ?? '-'}
              </a>
              {member.akbot_evidence_slot != null && (
                <span className="text-gray-400 ml-2">slot {member.akbot_evidence_slot}</span>
              )}
            </div>
            <div className="text-gray-500 pt-1">
              所有 AkBot 用户都用同一合约 (AKbotMAGJmYPwV8z55Lqiqgijt2KcjLeFGue5sw1noHM) 卖币 ——
              在 Solscan 点上面这笔 tx 看 Inner Instructions 即可复核。
            </div>
          </div>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card label="最近交易数" value={score?.trade_count ?? 0} />
        <Card label="平均 PnL" value={<SolAmount value={score?.avg_pnl_sol} signed />} />
        <Card label="总 PnL" value={<SolAmount value={score?.total_pnl_sol} signed />} />
        <Card label="胜率" value={`${((score?.win_rate ?? 0) * 100).toFixed(1)}%`} />
        <Card label="跟单评分" value={
          score?.offered != null ? (
            <span className={score.offered > 1 ? 'text-success-500' : score.offered < -0.5 ? 'text-error-500' : 'text-warning-500'}>
              {score.offered.toFixed(2)}
            </span>
          ) : <span className="text-gray-400" title={score?.reason ?? undefined}>-</span>
        } />
      </div>

      {/* 决策推荐卡 */}
      <div className="bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50 dark:from-blue-500/10 dark:via-indigo-500/10 dark:to-purple-500/10 border border-blue-200/70 dark:border-blue-500/30 rounded-xl p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-800 dark:text-white/90 flex items-center gap-2">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-white/70 dark:bg-white/5 text-base shadow-sm">📊</span>
            决策建议
          </h3>
          <span className="text-xs px-2 py-0.5 rounded-full bg-white/70 dark:bg-white/5 text-gray-500 dark:text-gray-400 border border-gray-200/60 dark:border-gray-700/60">
            样本 {fee?.sample_size ?? 0}
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* 手续费推荐 */}
          <div className="bg-white/70 dark:bg-white/[0.03] rounded-lg p-3 border border-gray-200/60 dark:border-gray-700/40">
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2 flex items-center gap-1.5">
              <span className="w-1 h-3 rounded-full bg-blue-500" />
              手续费推荐
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400 border border-emerald-200/60 dark:border-emerald-500/20">
                  保守 P50
                </span>
                <span className="font-mono text-sm text-gray-800 dark:text-gray-100">
                  tip <SolAmount value={fee?.p50_tip_sol} /> + prio <PrioSolAmount value={fee?.p50_prio_lamports} />
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400 border border-amber-200/60 dark:border-amber-500/20">
                  激进 P75
                </span>
                <span className="font-mono text-sm text-gray-800 dark:text-gray-100">
                  tip <SolAmount value={fee?.p75_tip_sol} /> + prio <PrioSolAmount value={fee?.p75_prio_lamports} />
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 pt-1 border-t border-dashed border-gray-200/60 dark:border-gray-700/40">
                <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 dark:bg-gray-700/40 dark:text-gray-400 border border-gray-200/60 dark:border-gray-600/40">
                  失败参考
                </span>
                <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                  tip <SolAmount value={fee?.failed_p50_tip_sol} /> + prio <PrioSolAmount value={fee?.failed_p50_prio_lamports} />
                </span>
              </div>
              <div className="text-[11px] text-gray-400 dark:text-gray-500 pt-1">
                抢单成功 {fee?.success_count ?? 0} 笔 / 失败 {fee?.failed_count ?? 0} 笔 · 数据更新 <RelativeTime iso={fee?.last_buy_at} />
              </div>
            </div>
          </div>

          {/* 价值评分 */}
          <div className="bg-white/70 dark:bg-white/[0.03] rounded-lg p-3 border border-gray-200/60 dark:border-gray-700/40">
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2 flex items-center gap-1.5">
              <span className="w-1 h-3 rounded-full bg-purple-500" />
              是否值得跟 (Worth Score)
            </div>
            <div className="flex items-baseline gap-2 mb-2">
              <span className={`font-mono text-3xl font-bold leading-none ${
                score?.offered == null ? 'text-gray-300' :
                score.offered > 1 ? 'text-success-500' :
                score.offered < -0.5 ? 'text-error-500' : 'text-warning-500'
              }`}>
                {score?.offered != null ? score.offered.toFixed(2) : '-'}
              </span>
              <span className="text-[11px] text-gray-400">综合评分</span>
            </div>
            <div className="space-y-1 text-xs">
              <div className="flex justify-between text-gray-600 dark:text-gray-300">
                <span>成本占比 fee/buy_sol</span>
                <span className="font-mono">{((score?.cost_ratio ?? 0) * 100).toFixed(2)}%</span>
              </div>
              <div className="flex justify-between text-gray-600 dark:text-gray-300">
                <span>平均手续费</span>
                <span className="font-mono"><SolAmount value={score?.avg_fee_sol} /></span>
              </div>
            </div>
          </div>
        </div>

        {/* 结论 banner —— offered 为 null 表示算不出分，不参与三档结论 */}
        {score?.offered != null && score.offered > 1 && (
          <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-400 text-sm">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500 text-white text-xs">✓</span>
            <span className="font-medium">推荐跟单</span>
            <span className="text-xs opacity-70">综合评分 {score.offered.toFixed(2)}，预期为正</span>
          </div>
        )}
        {score?.offered != null && score.offered < -0.5 && (
          <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 text-red-700 dark:text-red-400 text-sm">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white text-xs">✗</span>
            <span className="font-medium">不推荐跟单</span>
            <span className="text-xs opacity-70">PnL 为负 ({score.offered.toFixed(2)})</span>
          </div>
        )}
        {score?.offered != null && score.offered >= -0.5 && score.offered <= 1 && (
          <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 text-amber-700 dark:text-amber-400 text-sm">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-500 text-white text-xs">!</span>
            <span className="font-medium">观望</span>
            <span className="text-xs opacity-70">收益空间有限 (评分 {score.offered.toFixed(2)})</span>
          </div>
        )}
        {score != null && score.offered == null && (
          <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-50 dark:bg-zinc-800/60 border border-gray-200 dark:border-zinc-700 text-gray-600 dark:text-gray-400 text-sm">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-gray-400 text-white text-xs">?</span>
            <span className="font-medium">样本不足，暂不评分</span>
            <span className="text-xs opacity-70">{score.reason}</span>
          </div>
        )}
      </div>

      {/* 竞争分析 */}
      {analytics && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card label="最近 30 天笔数" value={analytics.summary.total_trades} />
            <Card label="总跟单者" value={analytics.summary.total_buyers} />
            <Card label="均跟单者/笔" value={analytics.summary.avg_buyers_per_trade.toFixed(1)} />
            <Card label="平均成功率" value={`${(analytics.summary.avg_success_rate * 100).toFixed(1)}%`} />
          </div>

          {/* Tip 分布 */}
          <Section title="抢单手续费 TIP 分布（success vs failed）">
            <DistributionChart data={analytics.tipDistribution} max={maxDist(analytics.tipDistribution)} />
          </Section>

          {/* Prio 分布 */}
          <Section title="抢单手续费 PRIO 分布（SOL, success vs failed）">
            <DistributionChart data={analytics.prioDistribution} max={maxDist(analytics.prioDistribution)} />
          </Section>

          {/* PnL 分布 */}
          <Section title="跟单者 PnL 分布">
            <DistributionChart data={analytics.pnlDistribution} max={maxDist(analytics.pnlDistribution)} />
          </Section>

          {/* Top 竞争者 */}
          <Section title="常驻竞争者 (Top 15)">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-gray-500">
                  <tr className="border-b border-gray-200 dark:border-gray-700">
                    <th className="py-2 px-2 text-left">地址</th>
                    <th className="py-2 px-2 text-center">出现</th>
                    <th className="py-2 px-2 text-center">赢</th>
                    <th className="py-2 px-2 text-center">输</th>
                    <th className="py-2 px-2 text-center">胜率</th>
                    <th className="py-2 px-2 text-right">均 TIP</th>
                    <th className="py-2 px-2 text-right">均 PRIO</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.topCompetitors.map((c) => (
                    <tr key={c.address} className="border-b border-gray-100 dark:border-gray-700/50">
                      <td className="py-1.5 px-2">
                        <Link href={`/pool/${c.address}`} className="hover:text-brand-500">
                          <AddressCopy address={c.address} />
                        </Link>
                      </td>
                      <td className="py-1.5 px-2 text-center font-mono">{c.freq}</td>
                      <td className="py-1.5 px-2 text-center text-success-500 font-mono">{c.win_count}</td>
                      <td className="py-1.5 px-2 text-center text-error-500 font-mono">{c.fail_count}</td>
                      <td className="py-1.5 px-2 text-center font-mono">
                        <span className={c.win_rate >= 0.5 ? 'text-success-500' : 'text-error-500'}>
                          {(c.win_rate * 100).toFixed(0)}%
                        </span>
                      </td>
                      <td className="py-1.5 px-2 text-right"><SolAmount value={c.avg_tip_sol} /></td>
                      <td className="py-1.5 px-2 text-right"><PrioSolAmount value={c.avg_prio_lamports} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* 时序 */}
          {analytics.trend.length > 0 && (
            <Section title="最近 30 笔 buy 时序">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-gray-500">
                    <tr className="border-b border-gray-200 dark:border-gray-700">
                      <th className="py-2 px-2 text-left">时间</th>
                      <th className="py-2 px-2 text-center">买家</th>
                      <th className="py-2 px-2 text-center">成功</th>
                      <th className="py-2 px-2 text-center">失败</th>
                      <th className="py-2 px-2 text-right">最高 TIP</th>
                      <th className="py-2 px-2 text-right">最高 PRIO</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics.trend.map((t) => (
                      <tr key={t.trade_signature} className="border-b border-gray-100 dark:border-gray-700/50">
                        <td className="py-1.5 px-2"><RelativeTime iso={t.block_time} /></td>
                        <td className="py-1.5 px-2 text-center font-mono">{t.buyer_count}</td>
                        <td className="py-1.5 px-2 text-center text-success-500 font-mono">{t.success_count}</td>
                        <td className="py-1.5 px-2 text-center text-error-500 font-mono">{t.failed_count}</td>
                        <td className="py-1.5 px-2 text-right"><SolAmount value={t.top_tip_sol} /></td>
                        <td className="py-1.5 px-2 text-right"><PrioSolAmount value={t.top_prio_lamports} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          )}
        </>
      )}

      {/* 关系网络 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Section title={`跟随的目标 (${following.length})`}>
          {following.length === 0 ? (
            <div className="text-xs text-gray-400 p-3">无跟随记录</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500">
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="py-2 px-2 text-left">目标</th>
                  <th className="py-2 px-2 text-center">次数</th>
                  <th className="py-2 px-2 text-center">赢/输</th>
                  <th className="py-2 px-2 text-center">同 slot / +1</th>
                </tr>
              </thead>
              <tbody>
                {following.map((e) => (
                  <tr key={e.id} className="border-b border-gray-100 dark:border-gray-700/50">
                    <td className="py-1.5 px-2">
                      <Link href={`/pool/${e.target}`} className="hover:text-brand-500">
                        <AddressCopy address={e.target} />
                      </Link>
                    </td>
                    <td className="py-1.5 px-2 text-center font-mono font-semibold text-brand-500 dark:text-brand-400">{e.freq}</td>
                    <td className="py-1.5 px-2 text-center text-xs">
                      <span className="text-success-500">{e.win_count}</span>
                      <span className="text-gray-300 mx-1">/</span>
                      <span className="text-error-500">{e.fail_count}</span>
                    </td>
                    <td className="py-1.5 px-2 text-center text-xs text-gray-500">
                      {e.same_slot_count} / {e.next_slot_count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
        <Section title={`被跟随者 (${followers.length})`}>
          {followers.length === 0 ? (
            <div className="text-xs text-gray-400 p-3">无被跟随记录</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500">
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="py-2 px-2 text-left">跟随者</th>
                  <th className="py-2 px-2 text-center">次数</th>
                  <th className="py-2 px-2 text-center">赢/输</th>
                  <th className="py-2 px-2 text-center">同 slot / +1</th>
                </tr>
              </thead>
              <tbody>
                {followers.map((e) => (
                  <tr key={e.id} className="border-b border-gray-100 dark:border-gray-700/50">
                    <td className="py-1.5 px-2">
                      <Link href={`/pool/${e.follower}`} className="hover:text-brand-500">
                        <AddressCopy address={e.follower} />
                      </Link>
                    </td>
                    <td className="py-1.5 px-2 text-center font-mono font-semibold text-brand-500 dark:text-brand-400">{e.freq}</td>
                    <td className="py-1.5 px-2 text-center text-xs">
                      <span className="text-success-500">{e.win_count}</span>
                      <span className="text-gray-300 mx-1">/</span>
                      <span className="text-error-500">{e.fail_count}</span>
                    </td>
                    <td className="py-1.5 px-2 text-center text-xs text-gray-500">
                      {e.same_slot_count} / {e.next_slot_count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      </div>
    </div>
  );
}

function Card({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 p-4">
      <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      <div className="text-xl font-semibold mt-1 text-gray-800 dark:text-white/90">{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-zinc-800 shadow-sm rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-800 dark:text-white/90">
        {title}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function DistributionChart({ data, max }: { data: BuyerDistribution[]; max: number }) {
  return (
    <div className="space-y-1">
      {data.map((d) => (
        <div key={d.bucket} className="flex items-center gap-2 text-xs">
          <div className="w-20 text-gray-500 font-mono">{d.bucket}</div>
          <div className="flex-1 flex items-center gap-1 h-8 bg-gray-50 dark:bg-zinc-700/30 rounded overflow-hidden">
            {d.success_count > 0 && (
              <div
                className="h-full bg-success-500/80 flex items-center justify-center text-white font-mono"
                style={{ width: `${(d.success_count / max) * 100}%`, minWidth: d.success_count > 0 ? '20px' : 0 }}
                title={`success: ${d.success_count}`}
              >
                {d.success_count}
              </div>
            )}
            {d.failed_count > 0 && (
              <div
                className="h-full bg-error-500/80 flex items-center justify-center text-white font-mono"
                style={{ width: `${(d.failed_count / max) * 100}%`, minWidth: d.failed_count > 0 ? '20px' : 0 }}
                title={`failed: ${d.failed_count}`}
              >
                {d.failed_count}
              </div>
            )}
          </div>
        </div>
      ))}
      {data.every((d) => d.success_count === 0 && d.failed_count === 0) && (
        <div className="text-xs text-gray-400 py-3 text-center">无样本数据</div>
      )}
    </div>
  );
}