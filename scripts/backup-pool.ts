// scripts/backup-pool.ts
// 把 pool_members / pool_edges 导出成可直接回放的 SQL。
// 本地没有 pg_dump 时的替代方案；服务器上的整库备份见 scripts/backup.sh。
//
// 实现说明:
//   node-postgres 8.x 的 COPY ... TO STDOUT 会把数据丢掉（result.rows 为空），
//   且项目没装 pg-copy-streams，所以改为让 Postgres 自己生成 INSERT 语句：
//   row_to_json(t)::text  ->  单引号字面量（内部 ' 转义成 ''）  ->  jsonb_populate_record 回填。
//   转义完全交给 Postgres，避免自己拼字符串出错；jsonb_populate_record 按列名映射，
//   所以以后给表加列也不会让备份失效。
//
// 用法:
//   npx tsx --env-file=.env scripts/backup-pool.ts            # 写到 tmp/pool-backup-<ts>.sql
//   npx tsx --env-file=.env scripts/backup-pool.ts <out.sql>  # 指定输出路径
//
// 恢复:
//   psql -h <host> -U <user> -d <db> -f tmp/pool-backup-<ts>.sql
//   文件内已含 BEGIN / TRUNCATE / COMMIT，可整份直接回放。
import fs from 'fs';
import path from 'path';
import { query, pool } from '../src/lib/db';

const TABLES = ['pool_members', 'pool_edges'] as const;

/** 让 Postgres 生成该表所有行的 INSERT 语句 */
async function genInserts(table: string): Promise<string[]> {
  const rows = await query<{ stmt: string }>(
    `SELECT 'INSERT INTO ' || $1 || ' SELECT * FROM jsonb_populate_record(NULL::' || $1 || ', '''
       || replace(row_to_json(t)::text, '''', '''''')
       || '''::jsonb);' AS stmt
     FROM ${table} t`,
    [table],
  );
  return rows.map((r) => r.stmt);
}

async function main() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
  const outPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve('tmp', `pool-backup-${stamp}.sql`);

  const parts: string[] = [
    `-- solwallet pool 备份  ${new Date().toISOString()}`,
    '-- 由 scripts/backup-pool.ts 生成',
    `-- 回放: psql -h <host> -U <user> -d <db> -f ${path.basename(outPath)}`,
    '',
    'BEGIN;',
    '',
    `TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY;`,
    '',
  ];

  const expected: Record<string, number> = {};
  for (const t of TABLES) {
    const n = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${t}`);
    expected[t] = n[0].n;
    const stmts = await genInserts(t);
    if (stmts.length !== expected[t]) {
      throw new Error(`${t}: 生成 ${stmts.length} 条 INSERT，但表里是 ${expected[t]} 行，终止`);
    }
    parts.push(`-- ${t}: ${stmts.length} 行`);
    parts.push(...stmts);
    parts.push('');
  }

  parts.push('COMMIT;', '');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, parts.join('\n'), 'utf8');

  // 往返校验: 把生成的语句灌进临时表，逐列和源表比对，确认这份备份真的能还原
  console.log('往返校验中…');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const t of TABLES) {
      await client.query(`CREATE TEMP TABLE _bk_${t} (LIKE ${t} INCLUDING ALL)`);
      const text = fs.readFileSync(outPath, 'utf8');
      const section = text.split(`-- ${t}: `)[1].split('\n\n')[0];
      const stmts = section.split('\n').filter((l) => l.startsWith('INSERT INTO '));
      for (const s of stmts) {
        await client.query(s.replace(`INSERT INTO ${t} `, `INSERT INTO _bk_${t} `));
      }
      const cmp = await client.query<{ bad: number }>(
        `SELECT COUNT(*)::int AS bad FROM (
           (SELECT * FROM ${t} EXCEPT SELECT * FROM _bk_${t})
           UNION ALL
           (SELECT * FROM _bk_${t} EXCEPT SELECT * FROM ${t})
         ) d`,
      );
      const ok = cmp.rows[0].bad === 0;
      console.log(`  ${t}: ${stmts.length} 行, 差异 ${cmp.rows[0].bad} ${ok ? '✓' : '✗'}`);
      if (!ok) process.exitCode = 1;
      await client.query(`DROP TABLE _bk_${t}`);
    }
    await client.query('ROLLBACK');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  console.log(`\n备份已写入: ${outPath}`);
  for (const t of TABLES) console.log(`  ${t}: ${expected[t]} 行`);
}

main()
  .then(() => pool.end())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
