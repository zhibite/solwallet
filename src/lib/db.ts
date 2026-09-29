/**
 * PostgreSQL 连接池 - 单例模式
 * Next.js 16 + App Router 环境下，global 单例避免 dev 模式 HMR 重连
 */

import { Pool, PoolConfig } from 'pg';

declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
}

const config: PoolConfig = {
  host: process.env.POSTGRES_HOST || '127.0.0.1',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'solwallet',
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
  max: parseInt(process.env.POSTGRES_POOL_MAX || '10', 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
};

function createPool(): Pool {
  const pool = new Pool(config);
  pool.on('error', (err) => {
    console.error('[pg] unexpected error on idle client', err);
  });
  return pool;
}

export const pool: Pool =
  global.__pgPool ?? (global.__pgPool = createPool());

/** 执行 SQL 查询（带参数） */
export async function query<T = any>(sql: string, params?: any[]): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}

/** 执行单行查询 */
export async function queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/** 执行非查询语句，返回影响的行数 */
export async function execute(sql: string, params?: any[]): Promise<number> {
  const res = await pool.query(sql, params);
  return res.rowCount ?? 0;
}

/** 事务包装 */
export async function withTransaction<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
