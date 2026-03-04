import express from 'express';
import { getClient, query } from '../db.js';
import { authRequired, fetchCurrentUser } from '../middleware/auth.js';

const router = express.Router();

const isAdmin = (roles?: string[] | null) =>
  Array.isArray(roles) && roles.includes('admin');

router.use(authRequired, fetchCurrentUser);
router.use((req, res, next) => {
  if (!isAdmin(req.currentUser?.roles)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
});

let userBadgesSchemaPromise: Promise<void> | null = null;
const ensureUserBadgesSchema = async () => {
  if (userBadgesSchemaPromise) return userBadgesSchemaPromise;
  userBadgesSchemaPromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS user_badges (
        id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_id uuid REFERENCES users(id) ON DELETE CASCADE,
        badge_key text,
        talent_role text,
        name text,
        bio text,
        skill text,
        email text,
        phone_number text,
        whatsapp text,
        telegram text,
        rate numeric(10, 2),
        img_url text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT user_badges_user_badge_unique UNIQUE (id, badge_key)
      )
    `);
    await query(`
      UPDATE user_badges
      SET badge_key = COALESCE(badge_key, talent_role)
      WHERE badge_key IS NULL
    `);
  })();
  try {
    await userBadgesSchemaPromise;
  } catch (err) {
    userBadgesSchemaPromise = null;
    throw err;
  }
};

router.use(async (_req, _res, next) => {
  try {
    await ensureUserBadgesSchema();
    next();
  } catch (err) {
    next(err);
  }
});

router.get('/users', async (req, res, next) => {
  const q = typeof req.query?.q === 'string' ? req.query.q.trim() : '';
  const scope = typeof req.query?.scope === 'string' ? req.query.scope.trim().toLowerCase() : '';
  const excludeSelf = String(req.query?.exclude_self || '').toLowerCase() === 'true';
  const params: Array<string> = [];
  let filter = 'u.deleted_at IS NULL';
  if (q) {
    params.push(`%${q}%`);
    const index = params.length;
    filter += ` AND (u.email ILIKE $${index} OR u.username ILIKE $${index} OR u.display_name ILIKE $${index})`;
  }
  if (scope === 'external') {
    filter += ` AND NOT EXISTS (
      SELECT 1
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = u.id
        AND r.key IN ('admin', 'worker')
    )`;
  } else if (scope === 'internal') {
    filter += ` AND EXISTS (
      SELECT 1
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = u.id
        AND r.key IN ('admin', 'worker')
    )`;
  }
  if (excludeSelf && req.currentUser?.id) {
    params.push(req.currentUser.id);
    const index = params.length;
    filter += ` AND u.id <> $${index}`;
  }
  try {
    const { rows: badgeTableRows } = await query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'user_badges'
      ) AS exists`
    );
    const includeBadges = Boolean(badgeTableRows?.[0]?.exists);
    const badgeSelect = includeBadges
      ? `ARRAY(
          SELECT DISTINCT COALESCE(ub.badge_key, ub.talent_role)
          FROM user_badges ub
          WHERE COALESCE(ub.user_id, ub.id) = u.id
            AND COALESCE(ub.badge_key, ub.talent_role) IS NOT NULL
        ) AS badges`
      : `ARRAY[]::text[] AS badges`;

    const { rows } = await query(
      `SELECT u.id,
              u.email,
              u.username,
              u.display_name,
              u.verified,
              u.created_at,
              u.blocked_at,
              (u.blocked_at IS NOT NULL) AS is_blocked,
              ARRAY(
                SELECT r.key
                FROM user_roles ur
                JOIN roles r ON r.id = ur.role_id
                WHERE ur.user_id = u.id
              ) AS roles,
              ${badgeSelect}
       FROM users u
       WHERE ${filter}
       ORDER BY u.created_at DESC
       LIMIT 100`,
      params
    );
    return res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/users/:userId/badges', async (req, res, next) => {
  const badgeKey = String(req.body?.badge || '').toLowerCase();
  const action = String(req.body?.action || 'add').toLowerCase();
  if (!badgeKey) {
    return res.status(400).json({ error: 'missing_badge' });
  }
  if (!['add', 'remove'].includes(action)) {
    return res.status(400).json({ error: 'invalid_action' });
  }
  try {
    if (action === 'add') {
      await query(
        `INSERT INTO user_badges (id, user_id, badge_key, name, email)
         SELECT u.id, u.id, $2, COALESCE(u.display_name, u.username), u.email
         FROM users u
         WHERE u.id = $1
         ON CONFLICT (id, badge_key) DO NOTHING`,
        [req.params.userId, badgeKey]
      );
    } else {
      await query(
        `DELETE FROM user_badges
         WHERE COALESCE(user_id, id) = $1
           AND COALESCE(badge_key, talent_role) = $2`,
        [req.params.userId, badgeKey]
      );
    }

    const { rows: badgeRows } = await query<{ key: string }>(
      `SELECT DISTINCT COALESCE(badge_key, talent_role) AS key
       FROM user_badges
       WHERE COALESCE(user_id, id) = $1
         AND COALESCE(badge_key, talent_role) IS NOT NULL`,
      [req.params.userId]
    );

    return res.json({ user_id: req.params.userId, badges: badgeRows.map((r) => r.key) });
  } catch (err) {
    next(err);
  }
});

router.patch('/users/:userId/verify', async (req, res, next) => {
  const userId = String(req.params.userId || '');
  const verified = Boolean(req.body?.verified);
  if (!userId) {
    return res.status(400).json({ error: 'missing_user' });
  }
  if (req.currentUser?.id && req.currentUser.id === userId) {
    return res.status(403).json({ error: 'forbidden_self_action' });
  }
  try {
    const { rows } = await query(
      `UPDATE users
       SET verified = $2
       WHERE id = $1
         AND deleted_at IS NULL
       RETURNING id, verified`,
      [userId, verified]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'not_found' });
    }
    return res.json({
      user_id: rows[0].id,
      verified: Boolean(rows[0].verified)
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/users/:userId/block', async (req, res, next) => {
  const userId = String(req.params.userId || '');
  const blocked = Boolean(req.body?.blocked);
  if (!userId) {
    return res.status(400).json({ error: 'missing_user' });
  }
  if (req.currentUser?.id && req.currentUser.id === userId) {
    return res.status(403).json({ error: 'forbidden_self_action' });
  }
  try {
    const { rows } = await query(
      `UPDATE users
       SET blocked_at = CASE WHEN $2 THEN now() ELSE NULL END
       WHERE id = $1
         AND deleted_at IS NULL
       RETURNING id, blocked_at`,
      [userId, blocked]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'not_found' });
    }
    return res.json({
      user_id: rows[0].id,
      blocked_at: rows[0].blocked_at,
      is_blocked: Boolean(rows[0].blocked_at)
    });
  } catch (err) {
    next(err);
  }
});

router.post('/users/:userId/roles', async (req, res, next) => {
  const roleKey = String(req.body?.role || '').toLowerCase();
  const action = String(req.body?.action || 'add').toLowerCase();
  if (!roleKey) {
    return res.status(400).json({ error: 'missing_role' });
  }
  if (!['add', 'remove'].includes(action)) {
    return res.status(400).json({ error: 'invalid_action' });
  }
  try {
    const { rows } = await query(
      `SELECT id FROM roles WHERE key = $1 LIMIT 1`,
      [roleKey]
    );
    if (!rows.length) return res.status(404).json({ error: 'role_not_found' });
    const roleId = rows[0].id;

    if (action === 'add') {
      await query(
        `INSERT INTO user_roles (user_id, role_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [req.params.userId, roleId]
      );
    } else {
      await query(
        `DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2`,
        [req.params.userId, roleId]
      );
    }

    const { rows: roleRows } = await query(
      `SELECT r.key
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1`,
      [req.params.userId]
    );

    return res.json({ user_id: req.params.userId, roles: roleRows.map((r) => r.key) });
  } catch (err) {
    next(err);
  }
});

router.delete('/users/:userId', async (req, res, next) => {
  const userId = String(req.params.userId || '');
  if (!userId) {
    return res.status(400).json({ error: 'missing_user' });
  }
  if (req.currentUser?.id && req.currentUser.id === userId) {
    return res.status(403).json({ error: 'forbidden_self_action' });
  }
  const client = await getClient();
  let hasTransaction = false;
  try {
    const { rowCount } = await client.query(
      `SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId]
    );
    if (!rowCount) return res.status(404).json({ error: 'not_found' });

    const { rows: talentTableRows } = await client.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'talents'
      ) AS exists`
    );
    const includeTalents = Boolean(talentTableRows?.[0]?.exists);

    await client.query('BEGIN');
    hasTransaction = true;
    await client.query(
      `DELETE FROM user_badges
       WHERE COALESCE(user_id, id) = $1`,
      [userId]
    );
    if (includeTalents) {
      await client.query(
        `DELETE FROM talents
         WHERE user_id = $1 OR id = $1`,
        [userId]
      );
    }
    await client.query(`DELETE FROM user_roles WHERE user_id = $1`, [userId]);
    await client.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [userId]);
    await client.query('COMMIT');

    return res.status(204).send();
  } catch (err) {
    try {
      if (hasTransaction) {
        await client.query('ROLLBACK');
      }
    } catch (_err) {
      // ignore rollback errors
    }
    next(err);
  } finally {
    client.release();
  }
});

export default router;
