/**
 * 数据库迁移：自动执行 schema.sql
 * 使用一个简单的 migrations 表跟踪是否执行过
 */

import { pool } from './db';
import { readFileSync } from 'fs';
import { join } from 'path';

const MIGRATION_NAME = '0001_init_schema';

export async function runMigrations(): Promise<void> {
  // 1) 确保 migrations 表存在
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // 2) 检查是否已应用
  const existing = await pool.query('SELECT 1 FROM _migrations WHERE name = $1', [MIGRATION_NAME]);
  if (existing.rowCount && existing.rowCount > 0) {
    console.log('[migrate] already applied:', MIGRATION_NAME);
    return;
  }

  // 3) 读取并执行 schema.sql
  let sql: string;
  try {
    const schemaPath = join(process.cwd(), 'src', 'lib', 'schema.sql');
    sql = readFileSync(schemaPath, 'utf-8');
  } catch (err) {
    console.warn('[migrate] schema.sql not found, skipping');
    return;
  }

  await pool.query(sql);
  await pool.query('INSERT INTO _migrations (name) VALUES ($1)', [MIGRATION_NAME]);
  console.log('[migrate] applied:', MIGRATION_NAME);
}
