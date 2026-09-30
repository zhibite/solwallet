// scripts/check-buys.ts
// Usage: npx tsx --env-file=.env scripts/check-buys.ts
import { query, queryOne, pool } from '../src/lib/db';

async function main() {
  console.log('===== 监控 buy 记录概览 =====\n');

  // 1) 总数
  const total = await queryOne<{ count: string }>(`
    SELECT COUNT(*) AS count FROM target_trades
  `);
  console.log(`总 buy 记录数: ${total?.count ?? 0}\n`);

  // 2) 最近 10 条
  const recent = await query<any>(`
    SELECT
      t.id,
      t.signature,
      t.mint,
      t.target_address,
      t.buy_sol,
      t.target_tip_sol,
      t.is_bundled,
      t.first_sniper,
      t.first_sniper_buy_sol,
      t.block_time,
      mt.label AS target_label,
      mt.status AS target_status
    FROM target_trades t
    LEFT JOIN monitored_targets mt ON mt.id = t.target_id
    ORDER BY t.id DESC
    LIMIT 10
  `);

  if (recent.length === 0) {
    console.log('暂无 buy 记录');
  } else {
    console.log('--- 最近 10 条 buy ---');
    for (const r of recent) {
      const t = r.block_time ? new Date(r.block_time).toISOString() : '-';
      console.log(
        `#${r.id} | ${t} | target=${r.target_label || '-'} [${r.target_status}]`,
      );
      console.log(`    addr=${r.target_address}`);
      console.log(`    mint=${r.mint}`);
      console.log(`    sig=${r.signature}`);
      console.log(
        `    buy=${r.buy_sol} SOL | tip=${r.target_tip_sol} | bundled=${r.is_bundled}`,
      );
      if (r.first_sniper) {
        console.log(
          `    first_sniper=${r.first_sniper} (buy ${r.first_sniper_buy_sol} SOL)`,
        );
      }
      console.log('');
    }
  }

  // 3) 按目标聚合
  console.log('--- 按目标聚合 ---');
  const byTarget = await query<any>(`
    SELECT
      mt.id,
      mt.address,
      mt.label,
      mt.status,
      mt.threshold_sol,
      mt.record_count,
      mt.last_buy_at,
      COUNT(t.id) AS actual_count
    FROM monitored_targets mt
    LEFT JOIN target_trades t ON t.target_id = mt.id
    GROUP BY mt.id, mt.address, mt.label, mt.status, mt.threshold_sol, mt.record_count, mt.last_buy_at
    ORDER BY mt.id
  `);
  for (const t of byTarget) {
    const last = t.last_buy_at ? new Date(t.last_buy_at).toISOString() : 'never';
    console.log(
      `target#${t.id} ${t.label || '-'} [${t.status}] threshold=${t.threshold_sol} SOL | stored_count=${t.record_count} actual=${t.actual_count} | last=${last}`,
    );
    console.log(`    ${t.address}`);
  }

  // 4) Webhook 推送情况
  console.log('\n--- Webhook 事件 ---');
  const wh = await queryOne<{ total: string; errors: string; processed: string }>(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE error IS NOT NULL) AS errors,
      COUNT(*) FILTER (WHERE processed = true) AS processed
    FROM webhook_events
  `);
  console.log(`总数=${wh?.total ?? 0} | 已处理=${wh?.processed ?? 0} | 错误=${wh?.errors ?? 0}`);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});