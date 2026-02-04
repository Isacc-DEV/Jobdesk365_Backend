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

router.get('/users', async (req, res, next) => {
  const q = typeof req.query?.q === 'string' ? req.query.q.trim() : '';
  const params: Array<string> = [];
  let filter = 'u.deleted_at IS NULL';
  if (q) {
    params.push(`%${q}%`);
    filter += ` AND (u.email ILIKE $1 OR u.username ILIKE $1 OR u.display_name ILIKE $1)`;
  }
  try {
    const { rows: talentTableRows } = await query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'talents'
      ) AS exists`
    );
    const includeTalents = Boolean(talentTableRows?.[0]?.exists);
    const talentSelect = includeTalents
      ? `ARRAY(
          SELECT DISTINCT t.talent_role
          FROM talents t
          WHERE COALESCE(t.user_id, t.id) = u.id
            AND t.talent_role IS NOT NULL
        ) AS talents`
      : `ARRAY[]::text[] AS talents`;

    const { rows } = await query(
      `SELECT u.id,
              u.email,
              u.username,
              u.display_name,
              u.created_at,
              ARRAY(
                SELECT r.key
                FROM user_roles ur
                JOIN roles r ON r.id = ur.role_id
                WHERE ur.user_id = u.id
              ) AS roles,
              ${talentSelect}
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
