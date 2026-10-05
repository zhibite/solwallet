// scripts/reconcile-promotion.ts
// 修复 pool_members.promoted_to_target 与 monitored_targets 的状态漂移。
//
// 背景：旧的删除接口只删 monitored_targets，不重置池子里的晋升标记，导致
// 一批地址「标记为已晋升但实际已不在监控列表」。这些地址既不被监控，也过不了
// autoPromote 的候选条件，永久卡死。删除接口已修复，此脚本用于清理历史遗留。
//
// 用法（默认 dry-run，只看不改）：
//   npx tsx --env-file=.env scripts/reconcile-promotion.ts
//
// 真正执行：
//   npx tsx --env-file=.env scripts/reconcile-promotion.ts --apply
//   npx tsx --env-file=.env scripts/reconcile-promotion.ts --apply --requeue
//
// --requeue 不置 auto_promote_excluded，孤儿地址会重新具备被 autoPromote 自动
// 晋升的资格（会真实抢单、花 SOL）；默认的 exclude 则保持不监控，想恢复时手动晋升。
import { reconcilePromotionFlags } from '../src/lib/pool';
import { pool } from '../src/lib/db';

async function main() {
  const apply = process.argv.includes('--apply');
  const orphanAction = process.argv.includes('--requeue') ? 'requeue' : 'exclude';

  const res = await reconcilePromotionFlags({ dryRun: !apply, orphanAction });

  console.log(`孤儿（标记已晋升但已不在 active 监控列表）: ${res.orphans.length} 个`);
  for (const o of res.orphans) {
    console.log(
      `  ${o.address}  role=${o.role}  freq=${o.freq}  promoted_at=${o.promoted_at ?? 'null'}` +
      `  -> ${apply ? (orphanAction === 'requeue' ? '重置标记，放回候选池' : '重置标记 + 标记排除') : '（dry-run）'}`,
    );
  }

  console.log(apply ? `\n已修复 ${res.fixed} 条` : '\n这是 dry-run，加 --apply 才会写库');

  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
