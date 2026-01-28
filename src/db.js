import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const pool = new Pool(config.db);

export async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 200) {
    // Quick visibility if queries get slow in dev.
    console.warn(`[db] slow query ${duration}ms: ${text}`);
  }
  return res;
}

export async function getClient() {
  return pool.connect();
}
