import { Pool } from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from './config.js';

export const pool = new Pool(config.db);

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  const start = Date.now();
  const res = await pool.query<T>(text, params);
  const duration = Date.now() - start;
  if (duration > 200) {
    // Quick visibility if queries get slow in dev.
    console.warn(`[db] slow query ${duration}ms: ${text}`);
  }
  return res;
}

export async function getClient(): Promise<PoolClient> {
  return pool.connect();
}
