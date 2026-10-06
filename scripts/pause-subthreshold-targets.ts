// scripts/pause-subthreshold-targets.ts
// 把「存量自动晋升、但按当前晋升门槛已不合格」的监控目标置为 paused。
//
// 背景（2026-10-05）：
//   晋升门槛从 freq>=3/dt>=2 收紧到 freq>=8/dt>=4 之后，收紧只挡未来晋升，
//   不会追溯降级已经进库的 target。当时 115 个监控目标里 111 个是池自动晋升的，
//   其中 95 个不满足新门槛，且 67 个 record_count=0（一笔交易都没录到）——
//   它们仍会每轮轮询签名、解析交易，白白吃 Helius 配额。
//
// 为什么用 paused 而不是删除：
//   1. 可逆 —— 改回 status='active' 就恢复，历史 target_trades 全部保留；
//   2. 停止轮询即释放配额，不需要动任何历史数据。
//   删除会走 /api/targets/[id] 的 DELETE 逻辑连带重置池内晋升标记并置
//   auto_promote_excluded，属于不可逆的语义变更，不适合批量清理。
//
// 安全性：
//   - 只碰 label LIKE 'auto:%' 的行，手动添加的目标（label 为空）一律不动；
//   - 只碰「在池里有记录且不满足门槛」的，池里查不到成员的 target 也不动；
//   - paused 之后 autoPromote 的候选条件（promoted_to_target = false）已不成立，
//     不会被自动拉回；再跑 reconcile-promotion.ts --apply 可额外打上
//     auto_promote_excluded 标记做双重保险。
//   - 执行前把地址清单写进 backup CSV，可据此恢复。
//
// 用法（默认 dry-run，只看不改）：
//   npx tsx --env-file=.env scripts/pause-subthreshold-targets.ts
//
// 真正执行：
//   npx tsx --env-file=.env scripts/pause-subthreshold-targets.ts --apply
//
// 恢复（把清单里的地址改回 active）：
//   npx tsx --env-file=.env scripts/pause-subthreshold-targets.ts --restore
import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../src/lib/db';

const FREQ_MIN = parseInt(process.env.POOL_PROMOTE_FREQ || '8', 10);
const DIST_MIN = parseInt(process.env.POOL_PROMOTE_DISTINCT || '4', 10);
const BACKUP_FILE = path.join(__dirname, '..', 'data', 'paused-subthreshold-targets.csv');

async function main() {
  const apply = process.argv.includes('--apply');
  const restore = process.argv.includes('--restore');

  if (restore) {
    if (!fs.existsSync(BACKUP_FILE)) {
      console.error(`找不到备份文件 ${BACKUP_FILE}，无法恢复`);
      process.exit(1);
    }
    const addrs = fs.readFileSync(BACKUP_FILE, 'utf8')
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.split(',')[0])
      .filter(Boolean);
    const res = await pool.query(
      `UPDATE monitored_targets SET status = 'active', updated_at = NOW()
        WHERE address = ANY($1) AND status = 'paused'`,
      [addrs],
    );
    console.log(`已恢复 ${res.rowCount} 个监控目标为 active`);
    await pool.end();
    return;
  }

  // 不满足当前晋升门槛的自动晋升 target。
  // 用 EXISTS 关联池内记录：池里查不到成员的 target 视为「非池来源或已无记录」，不动。
  const { rows: targets } = await pool.query(
    `SELECT mt.address,
            mt.label,
            mt.status,
            mt.record_count,
            pm.freq,
            pm.distinct_targets,
            pm.role
       FROM monitored_targets mt
       JOIN pool_members pm ON pm.address = mt.address
      WHERE mt.label LIKE 'auto:%'
        AND NOT (pm.freq >= $1 AND pm.distinct_targets >= $2)
      ORDER BY pm.distinct_targets ASC, pm.freq ASC`,
    [FREQ_MIN, DIST_MIN],
  );

  console.log(`当前门槛: freq >= ${FREQ_MIN} 且 distinct_targets >= ${DIST_MIN}`);
  console.log(`命中「自动晋升但已不合格」的监控目标: ${targets.length} 个\n`);

  const byDt = new Map<number, number>();
  let zeroRecord = 0;
  for (const t of targets) {
    byDt.set(Number(t.distinct_targets), (byDt.get(Number(t.distinct_targets)) ?? 0) + 1);
    if (Number(t.record_count) === 0) zeroRecord++;
  }
  console.log('按 distinct_targets 分布:');
  for (const [dt, n] of [...byDt.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  dt=${dt}: ${n} 个`);
  }
  console.log(`其中 record_count=0（从未录到交易）: ${zeroRecord} 个`);
  console.log(`合计已记录交易: ${targets.reduce((s, t) => s + Number(t.record_count), 0)} 笔\n`);

  if (!apply) {
    for (const t of targets) {
      console.log(
        `  ${t.address}  dt=${t.distinct_targets}  freq=${t.freq}  ` +
        `role=${t.role}  record_count=${t.record_count}  status=${t.status}`,
      );
    }
    console.log('\n这是 dry-run，加 --apply 才会写库');
    await pool.end();
    return;
  }

  const addrs = targets.map((t: any) => t.address);

  // 先落备份再改库：地址清单是唯一的恢复依据。
  fs.mkdirSync(path.dirname(BACKUP_FILE), { recursive: true });
  fs.writeFileSync(
    BACKUP_FILE,
    'address,label,distinct_targets,freq,role,record_count\n' +
      targets
        .map((t: any) =>
          [t.address, t.label, t.distinct_targets, t.freq, t.role, t.record_count].join(','),
        )
        .join('\n') + '\n',
    'utf8',
  );
  console.log(`备份已写入 ${BACKUP_FILE}`);

  const res = await pool.query(
    `UPDATE monitored_targets
        SET status = 'paused', updated_at = NOW()
      WHERE address = ANY($1) AND status = 'active'`,
    [addrs],
  );
  console.log(`\n已暂停 ${res.rowCount} 个监控目标（停止轮询，历史数据保留）`);
  console.log('恢复: npx tsx --env-file=.env scripts/pause-subthreshold-targets.ts --restore');
  console.log('打排除标记: npx tsx --env-file=.env scripts/reconcile-promotion.ts --apply');

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
