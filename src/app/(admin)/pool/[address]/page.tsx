"use client";
import React, { useEffect, useState } from "react";
import Link from "next/link";
import AddressCopy from "@/components/common/AddressCopy";
import SolAmount from "@/components/common/SolAmount";
import RelativeTime from "@/components/common/RelativeTime";

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
  promoted_to_target: boolean;
  promoted_at: string | null;
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
  p50_tip_sol: number;
  p50_prio_lamports: number;
  p75_tip_sol: number;
  p75_prio_lamports: number;
  success_count: number;
  failed_p50_tip_sol: number;
  failed_p50_prio_lamports: number;
  failed_count: number;
  sample_size: number;
  last_buy_at: string | null;
}

interface WorthScore {
  offered: number;
  win_rate: number;
  avg_pnl_sol: number;
  total_pnl_sol: number;
  avg_fee_sol: number;
  cost_ratio: number;
  trade_count: number;
}

export default function PoolDetailPage({ params }: { params: Promise<{ address: string }> }) {
  const [address, setAddress] = useState<string | null>(null);
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

  const promote = async () => {
    if (!address) return;
    if (!confirm(`将 ${address.slice(0, 6)}... 晋升到监控列表？`)) return;
    const res = await fetch(`/api/pool/${address}/promote`, { method: 'POST' });
    const json = await res.json();
    if (json.ok) alert('已晋升'); else alert(`失败: ${json.reason ?? json.error}`);
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
              <span className="text-xs text-success-500">已晋升监控</span>
            )}
          </div>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            出现 {member.freq} 次 · 跟随 {member.distinct_targets} 个独立目标
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!member.promoted_to_target && (
            <button
              onClick={promote}
              className="h-9 px-4 rounded-xl bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium"
            >
              晋升到监控
            </button>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card label="最近交易数" value={score?.trade_count ?? 0} />
        <Card label="平均 PnL" value={<SolAmount value={score?.avg_pnl_sol} signed />} />
        <Card label="总 PnL" value={<SolAmount value={score?.total_pnl_sol} signed />} />
        <Card label="胜率" value={`${((score?.win_rate ?? 0) * 100).toFixed(1)}%`} />
        <Card label="跟单评分" value={
          score ? (
            <span className={score.offered > 1 ? 'text-success-500' : score.offered < -0.5 ? 'text-error-500' : 'text-warning-500'}>
              {score.offered.toFixed(2)}
            </span>
          ) : '-'
        } />
      </div>

      {/* 决策推荐卡 */}
      <div className="bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-500/10 dark:to-purple-500/10 border border-blue-200 dark:border-blue-500/30 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-gray-800 dark:text-white/90 mb-3">📊 决策建议</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          {/* 手续费推荐 */}
          <div>
            <div className="text-xs text-gray-500 mb-1">手续费推荐（基于 {fee?.sample_size ?? 0} 个样本）</div>
            <div className="space-y-1">
              <div className="flex justify-between">
                <span className="text-gray-600">保守 (P50 success):</span>
                <span className="font-mono">
                  tip <SolAmount value={fee?.p50_tip_sol} /> + prio {fee?.p50_prio_lamports?.toLocaleString() ?? 0}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">激进 (P75 success):</span>
                <span className="font-mono">
                  tip <SolAmount value={fee?.p75_tip_sol} /> + prio {fee?.p75_prio_lamports?.toLocaleString() ?? 0}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-gray-400">抢单失败的下界参考:</span>
                <span className="font-mono text-gray-400">
                  tip <SolAmount value={fee?.failed_p50_tip_sol} /> + prio {fee?.failed_p50_prio_lamports?.toLocaleString() ?? 0}
                </span>
              </div>
              <div className="text-xs text-gray-400 mt-1">
                抢单成功 {fee?.success_count ?? 0} 笔 / 失败 {fee?.failed_count ?? 0} 笔 ·
                数据样本 <RelativeTime iso={fee?.last_buy_at} />
              </div>
            </div>
          </div>
          {/* 价值评分 */}
          <div>
            <div className="text-xs text-gray-500 mb-1">是否值得跟 (Worth Score)</div>
            <div className="space-y-1">
              <div className="flex justify-between">
                <span className="text-gray-600">综合评分:</span>
                <span className={`font-mono text-lg font-semibold ${
                  (score?.offered ?? 0) > 1 ? 'text-success-500' :
                  (score?.offered ?? 0) < -0.5 ? 'text-error-500' : 'text-warning-500'
                }`}>
                  {score ? score.offered.toFixed(2) : '-'}
                </span>
              </div>
              <div className="flex justify-between text-xs text-gray-500">
                <span>成本占比 fee/buy_sol:</span>
                <span className="font-mono">{((score?.cost_ratio ?? 0) * 100).toFixed(2)}%</span>
              </div>
              <div className="flex justify-between text-xs text-gray-500">
                <span>平均手续费:</span>
                <span className="font-mono"><SolAmount value={score?.avg_fee_sol} /></span>
              </div>
              {score && score.offered > 1 && (
                <div className="text-xs text-success-600 dark:text-success-400">✓ 推荐跟单</div>
              )}
              {score && score.offered < -0.5 && (
                <div className="text-xs text-error-600 dark:text-error-400">✗ 不推荐 — PnL 为负</div>
              )}
            </div>
          </div>
        </div>
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
          <Section title="抢单手续费 PRIO 分布（success vs failed）">
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
                      <td className="py-1.5 px-2 text-right font-mono">{Math.round(c.avg_prio_lamports).toLocaleString()}</td>
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
                        <td className="py-1.5 px-2 text-right font-mono">{t.top_prio_lamports.toLocaleString()}</td>
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
                    <td className="py-1.5 px-2 text-center font-mono">{e.freq}</td>
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
                    <td className="py-1.5 px-2 text-center font-mono">{e.freq}</td>
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