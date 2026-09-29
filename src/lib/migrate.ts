/**
 * 数据库迁移：按顺序执行 migrations 目录下的 .sql 文件
 * 使用 _migrations 表跟踪已执行的迁移名
 */

import { pool } from './db';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(process.cwd(), 'src', 'lib', 'migrations');

export async function runMigrations(): Promise<void> {
  // 1) 确保 migrations 表存在
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 2) 收集 migrations 文件
  let files: string[];
  try {
    files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch {
    console.log('[migrate] migrations dir not found, skipping');
    return;
  }

  // 3) 检查已执行的
  const applied = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM _migrations')).rows.map((r) => r.name),
  );

  // 4) 依次执行未执行的
  for (const file of files) {
    if (applied.has(file)) {
      console.log('[migrate] skip (already applied):', file);
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
    console.log('[migrate] applying:', file);
    await pool.query('BEGIN');
    try {
      await pool.query(sql);
      await pool.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      await pool.query('COMMIT');
      console.log('[migrate] applied:', file);
    } catch (err) {
      await pool.query('ROLLBACK');
      console.error('[migrate] failed:', file, err);
      throw err;
    }
  }
}
