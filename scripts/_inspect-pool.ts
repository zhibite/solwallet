import { query, pool } from '../src/lib/db';

async function main() {
  // 拿一个非 akbot 的真实地址用来测试手动标
  const sample = await query<{ address: string; freq: string; is_akbot: boolean }>(
    "SELECT address, freq::text, is_akbot FROM pool_members " +
      "WHERE is_akbot = FALSE AND freq >= 2 ORDER BY freq DESC LIMIT 1",
  );
  if (sample[0]) {
    console.log('TEST_TARGET:', sample[0].address, 'freq=' + sample[0].freq, 'is_akbot=' + sample[0].is_akbot);
  } else {
    console.log('TEST_TARGET: NONE');
  }

  // 拿一个 akbot 的真实地址用来测试撤销
  const akb = await query<{ address: string; sig: string }>(
    "SELECT address, akbot_evidence_sig as sig FROM pool_members " +
      "WHERE is_akbot = TRUE LIMIT 1",
  );
  if (akb[0]) {
    console.log('TEST_AKBOT:', akb[0].address, 'sig=' + akb[0].sig);
  } else {
    console.log('TEST_AKBOT: NONE');
  }

  // 顺带统计
  const total = await query<{ c: string }>(
    'SELECT COUNT(*)::text as c FROM pool_members',
  );
  const ak = await query<{ c: string }>(
    'SELECT COUNT(*)::text as c FROM pool_members WHERE is_akbot = true',
  );
  console.log('total=' + total[0].c, 'akbot=' + ak[0].c);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
