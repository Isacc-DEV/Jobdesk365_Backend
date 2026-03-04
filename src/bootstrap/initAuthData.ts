import { randomUUID } from 'node:crypto';
import { query } from '../db.js';

const ADMIN_ROLE_ID = '4413d466-f31d-46c1-9bef-4680f50c2de8';
const ADMIN_USERNAME = 'isacc1993';
const ADMIN_EMAIL = 'wrenikey.dev@gmail.com';
const ADMIN_PASSWORD_HASH = '$2b$12$ODosbOihRBR6VYpb3zN5SemaGswFYgOCKrLhQiOstLC19YZSjdS/.';

export async function initAuthData(): Promise<void> {
  await query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

  // Ensure role keys exist. Keep fixed id for admin role.
  await query(
    `INSERT INTO roles (id, key)
     VALUES ($1, 'admin')
     ON CONFLICT (id) DO UPDATE SET key = EXCLUDED.key`,
    [ADMIN_ROLE_ID]
  );
  await query(
    `INSERT INTO roles (id, key)
     VALUES (gen_random_uuid(), 'worker')
     ON CONFLICT (key) DO NOTHING`
  );
  await query(
    `INSERT INTO roles (id, key)
     VALUES (gen_random_uuid(), 'user')
     ON CONFLICT (key) DO NOTHING`
  );

  const existing = await query<{ id: string }>(
    `SELECT id
     FROM users
     WHERE lower(username) = lower($1::text)
     LIMIT 1`,
    [ADMIN_USERNAME]
  );

  let adminUserId = existing.rows[0]?.id || '';
  if (!adminUserId) {
    const inserted = await query<{ id: string }>(
      `INSERT INTO users (id, email, username, password_hash, display_name, plan, verified)
       VALUES ($1, $2, $3, $4, $5, 'free', true)
       RETURNING id`,
      [randomUUID(), ADMIN_EMAIL, ADMIN_USERNAME, ADMIN_PASSWORD_HASH, ADMIN_USERNAME]
    );
    adminUserId = inserted.rows[0]?.id || '';
  } else {
    await query(
      `UPDATE users
       SET deleted_at = NULL,
           email = $2,
           password_hash = $3
       WHERE id = $1`,
      [adminUserId, ADMIN_EMAIL, ADMIN_PASSWORD_HASH]
    );
  }

  await query(
    `INSERT INTO user_roles (user_id, role_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [adminUserId, ADMIN_ROLE_ID]
  );
}
