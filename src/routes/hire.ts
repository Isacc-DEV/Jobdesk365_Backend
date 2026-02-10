import express from 'express';
import { query } from '../db.js';
import { authRequired, fetchCurrentUser } from '../middleware/auth.js';
import {
  notifyAssignBidderRequest,
  notifyAssignCallerRequest,
  notifyCallerRequestDecision,
  notifyReassignBidderRequest,
  notifyTalentAdded,
  notifyUnassignBidderRequest
} from '../services/notifications.js';

const router = express.Router();
type RouteScope = 'user' | 'manager' | 'admin';

const hasRole = (roles: string[] | null | undefined, role: string) =>
  Array.isArray(roles) && roles.includes(role);

const getRouteScope = (baseUrl: string | undefined): RouteScope => {
  if (!baseUrl) return 'user';
  if (baseUrl.startsWith('/admin/')) return 'admin';
  if (baseUrl.startsWith('/manager/')) return 'manager';
  return 'user';
};

const getScopeContext = (req: express.Request) => {
  const scope = getRouteScope(req.baseUrl);
  return { scope, allowAll: scope !== 'user' };
};

const requireScopeAccess: express.RequestHandler = (req, res, next) => {
  const scope = getRouteScope(req.baseUrl);
  if (scope === 'admin' && !hasRole(req.currentUser?.roles, 'admin')) {
    return res.status(403).json({ error: 'admin_required' });
  }
  if (scope === 'manager' && !hasRole(req.currentUser?.roles, 'manager')) {
    return res.status(403).json({ error: 'manager_required' });
  }
  return next();
};

let hireSchemaPromise: Promise<void> | null = null;

const ensureHireSchema = async () => {
  if (hireSchemaPromise) return hireSchemaPromise;
  hireSchemaPromise = (async () => {
    await query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

    await query(`
      CREATE OR REPLACE FUNCTION set_row_updated_at()
      RETURNS trigger AS $$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables WHERE table_name = 'hire_people'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.tables WHERE table_name = 'talents'
        ) THEN
          ALTER TABLE hire_people RENAME TO talents;
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.tables WHERE table_name = 'hire_requests'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.tables WHERE table_name = 'requests'
        ) THEN
          ALTER TABLE hire_requests RENAME TO requests;
        END IF;
      END
      $$;
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS talents (
        id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_id uuid REFERENCES users(id) ON DELETE CASCADE,
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
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await query(`
      ALTER TABLE talents
      ADD COLUMN IF NOT EXISTS img_url text
    `);

    await query(`
      ALTER TABLE talents
      ADD COLUMN IF NOT EXISTS talent_role text
    `);

    await query(`
      ALTER TABLE talents
      ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE CASCADE
    `);

    await query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE table_name = 'talents'
            AND constraint_type = 'PRIMARY KEY'
        ) THEN
          ALTER TABLE talents DROP CONSTRAINT IF EXISTS talents_pkey;
        END IF;
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'talents_user_role_unique'
            AND table_name = 'talents'
        ) THEN
          ALTER TABLE talents
          ADD CONSTRAINT talents_user_role_unique UNIQUE (id, talent_role);
        END IF;
      END
      $$;
    `);

    await query(`
      UPDATE talents
      SET user_id = id
      WHERE user_id IS NULL
    `);

    await query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'talents_role_allowed'
            AND table_name = 'talents'
        ) THEN
          ALTER TABLE talents
          ADD CONSTRAINT talents_role_allowed
          CHECK (talent_role IN ('bidder', 'caller'));
        END IF;
      END
      $$;
    `);

    await query(`
      UPDATE talents t
      SET talent_role = r.key
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      WHERE t.talent_role IS NULL
        AND ur.user_id = COALESCE(t.user_id, t.id)
        AND r.key IN ('bidder', 'caller')
    `);

    await query(`
      DROP TRIGGER IF EXISTS trg_hire_people_updated_at ON talents;
      DROP TRIGGER IF EXISTS trg_talents_updated_at ON talents;
      CREATE TRIGGER trg_talents_updated_at
      BEFORE UPDATE ON talents
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await query(`DROP INDEX IF EXISTS idx_hire_people_email`);
    await query(`CREATE INDEX IF NOT EXISTS idx_talents_email ON talents (email)`);

    await query(`
      INSERT INTO talents (id, user_id, talent_role, name, bio, skill, email, phone_number, whatsapp, telegram, rate, img_url)
      SELECT u.id,
             u.id,
             r.key,
             COALESCE(u.display_name, u.username),
             u.bio,
             CASE WHEN r.key = 'caller' THEN 'Calling' ELSE 'Applications' END,
             u.email,
             NULL,
             NULL,
             NULL,
             CASE WHEN r.key = 'caller' THEN 35 ELSE 3 END,
             NULL
      FROM users u
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN roles r ON r.id = ur.role_id
      WHERE r.key IN ('bidder', 'caller')
      ON CONFLICT (id, talent_role) DO NOTHING
    `);

    await query(
      `
      WITH mock_talents (email, username, display_name, bio, role_key, rate, img_url, phone_number, whatsapp, telegram, skill) AS (
        VALUES
          ('mock.caller1@jobdesk.local', 'caller.one', 'Callie Stone', 'Customer-focused caller with a calm tone.', 'caller', 32, 'https://your-project.supabase.co/storage/v1/object/public/talents/caller-1.jpg', '555-0101', '555-0101', 'caller.one', 'Outbound calling'),
          ('mock.caller2@jobdesk.local', 'caller.two', 'Noah Reed', 'Fast, friendly outreach and follow-up specialist.', 'caller', 28, 'https://your-project.supabase.co/storage/v1/object/public/talents/caller-2.jpg', '555-0102', '555-0102', 'caller.two', 'Lead follow-up'),
          ('mock.caller3@jobdesk.local', 'caller.three', 'Ava Brooks', 'Empathetic caller with experience in pipelines.', 'caller', 30, 'https://your-project.supabase.co/storage/v1/object/public/talents/caller-3.jpg', '555-0103', '555-0103', 'caller.three', 'Pipeline outreach'),
          ('mock.bidder1@jobdesk.local', 'bidder.one', 'Ethan Park', 'High-volume application specialist.', 'bidder', 4, 'https://your-project.supabase.co/storage/v1/object/public/talents/bidder-1.jpg', '555-0201', '555-0201', 'bidder.one', 'Applications'),
          ('mock.bidder2@jobdesk.local', 'bidder.two', 'Mia Patel', 'Accurate and fast bidder with ATS expertise.', 'bidder', 5, 'https://your-project.supabase.co/storage/v1/object/public/talents/bidder-2.jpg', '555-0202', '555-0202', 'bidder.two', 'ATS bids'),
          ('mock.bidder3@jobdesk.local', 'bidder.three', 'Lucas Ortiz', 'Detail-oriented application optimizer.', 'bidder', 3, 'https://your-project.supabase.co/storage/v1/object/public/talents/bidder-3.jpg', '555-0203', '555-0203', 'bidder.three', 'Application targeting')
      ),
      ensured_users AS (
        INSERT INTO users (email, username, password_hash, display_name, bio, photo_link, plan)
        SELECT mt.email, mt.username, $1, mt.display_name, mt.bio, NULL, 'free'
        FROM mock_talents mt
        WHERE NOT EXISTS (
          SELECT 1 FROM users u WHERE lower(u.email) = lower(mt.email)
        )
        RETURNING id, email
      ),
      all_users AS (
        SELECT u.id, u.email
        FROM users u
        JOIN mock_talents mt ON lower(u.email) = lower(mt.email)
      ),
      role_links AS (
        INSERT INTO user_roles (user_id, role_id)
        SELECT au.id, r.id
        FROM all_users au
        JOIN mock_talents mt ON lower(mt.email) = lower(au.email)
        JOIN roles r ON r.key = 'worker'
        ON CONFLICT DO NOTHING
      )
      INSERT INTO talents (id, user_id, talent_role, name, bio, skill, email, phone_number, whatsapp, telegram, rate, img_url)
      SELECT au.id,
             au.id,
             mt.role_key,
             mt.display_name,
             mt.bio,
             mt.skill,
             mt.email,
             mt.phone_number,
             mt.whatsapp,
             mt.telegram,
             mt.rate,
             mt.img_url
      FROM all_users au
      JOIN mock_talents mt ON lower(mt.email) = lower(au.email)
      ON CONFLICT (id, talent_role) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        talent_role = EXCLUDED.talent_role,
        name = EXCLUDED.name,
        bio = EXCLUDED.bio,
        skill = EXCLUDED.skill,
        email = EXCLUDED.email,
        phone_number = EXCLUDED.phone_number,
        whatsapp = EXCLUDED.whatsapp,
        telegram = EXCLUDED.telegram,
        rate = EXCLUDED.rate,
        img_url = EXCLUDED.img_url
      `,
      ['$2b$10$N9qo8uLOickgx2ZMRZo5e.Puq8No3BFEtGYwd5j9Vn0iJrO9wBLs.']
    );

    await query(`
      CREATE TABLE IF NOT EXISTS requests (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role text NOT NULL CHECK (role IN ('bidder', 'caller')),
        detail jsonb,
        assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        hourly_rate numeric(10, 2),
        when_at timestamptz,
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'working', 'closed')),
        archived boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await query(`
      ALTER TABLE requests
      ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false
    `);

    await query(`
      UPDATE requests
      SET archived = true
      WHERE archived = false
        AND status IN ('working', 'closed')
    `);

    await query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'requests'
            AND column_name = 'detail'
            AND data_type <> 'jsonb'
        ) THEN
          ALTER TABLE requests
          ALTER COLUMN detail TYPE jsonb
          USING CASE WHEN detail IS NULL THEN NULL ELSE to_jsonb(detail) END;
        END IF;
      END
      $$;
    `);

    await query(`
      DROP TRIGGER IF EXISTS trg_hire_requests_updated_at ON requests;
      DROP TRIGGER IF EXISTS trg_requests_updated_at ON requests;
      CREATE TRIGGER trg_requests_updated_at
      BEFORE UPDATE ON requests
      FOR EACH ROW
      EXECUTE FUNCTION set_row_updated_at();
    `);

    await query(`DROP INDEX IF EXISTS idx_hire_requests_user_id`);
    await query(`DROP INDEX IF EXISTS idx_hire_requests_status`);
    await query(`DROP INDEX IF EXISTS idx_hire_requests_role`);
    await query(`CREATE INDEX IF NOT EXISTS idx_requests_user_id ON requests (user_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_requests_role ON requests (role)`);
  })();

  try {
    await hireSchemaPromise;
  } catch (err) {
    hireSchemaPromise = null;
    throw err;
  }

  return hireSchemaPromise;
};

router.use(authRequired, fetchCurrentUser);
router.use(requireScopeAccess);
router.use(async (_req, _res, next) => {
  try {
    await ensureHireSchema();
    next();
  } catch (err) {
    next(err);
  }
});

const formatRole = (value?: string) => {
  if (!value) return null;
  const normalized = String(value).toLowerCase();
  if (normalized === 'bidder' || normalized === 'caller') return normalized;
  return null;
};

const formatStatus = (value?: string) => {
  if (!value) return null;
  const normalized = String(value).toLowerCase();
  if (['pending', 'working', 'closed'].includes(normalized)) return normalized;
  return null;
};

const normalizeDetail = (value: unknown) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      return { text: trimmed };
    }
  }
  return value;
};

const normalizeCallerDetail = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const jobUrl = raw.job_url ?? raw.jobUrl ?? '';
  const meetingUrl = raw.meeting_url ?? raw.meetingUrl ?? '';
  const other = raw.other ?? raw.notes ?? '';
  const jobValue = String(jobUrl || '').trim();
  const meetingValue = String(meetingUrl || '').trim();
  if (!jobValue || !meetingValue) return null;
  const otherValue = other ? String(other).trim() : '';
  return {
    job_url: jobValue,
    meeting_url: meetingValue,
    other: otherValue
  };
};

const runNotificationTask = async (label: string, task: () => Promise<void>) => {
  try {
    await task();
  } catch (err) {
    console.error(`[notifications] ${label} failed`, err);
  }
};

const listTalents = async (req, res, next) => {
  const role = formatRole(String(req.query?.role || ''));
  if (!role) {
    return res.status(400).json({ error: 'invalid_role' });
  }

  try {
    const { rows } = await query(
      `SELECT t.id,
              COALESCE(t.user_id, t.id) AS user_id,
              t.talent_role AS role,
              t.name,
              u.display_name,
              u.username,
              t.bio,
              t.skill,
              t.email,
              t.phone_number,
              t.whatsapp,
              t.telegram,
              t.rate,
              t.img_url
       FROM talents t
       JOIN users u ON u.id = COALESCE(t.user_id, t.id)
       WHERE t.talent_role = $1
         AND u.deleted_at IS NULL
       ORDER BY t.name NULLS LAST, t.email NULLS LAST`,
      [role]
    );
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
};

router.get('/talents', listTalents);
router.get('/people', listTalents);

router.get('/users', async (req, res, next) => {
  const { allowAll } = getScopeContext(req);
  if (!allowAll) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const q = typeof req.query?.q === 'string' ? req.query.q.trim() : '';
  if (!q) return res.json({ items: [] });
  try {
    const { rows } = await query(
      `SELECT id, email, username, display_name
       FROM users
       WHERE deleted_at IS NULL
         AND (email ILIKE $1 OR username ILIKE $1 OR display_name ILIKE $1)
       ORDER BY created_at DESC
       LIMIT 20`,
      [`%${q}%`]
    );
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/talents', async (req, res, next) => {
  const { allowAll } = getScopeContext(req);
  if (!allowAll) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const payload = req.body || {};
  const role = formatRole(payload.role);
  if (!role) return res.status(400).json({ error: 'invalid_role' });

  const rawUserId = payload.user_id ? String(payload.user_id) : '';
  const identity = String(payload.email || payload.username || '').trim();

  try {
    let userId = rawUserId;
    let userRow;
    if (userId) {
      const { rows } = await query(
        `SELECT id, email, username, display_name, bio
         FROM users
         WHERE id = $1 AND deleted_at IS NULL
         LIMIT 1`,
        [userId]
      );
      userRow = rows[0];
    } else if (identity) {
      const { rows } = await query(
        `SELECT id, email, username, display_name, bio
         FROM users
         WHERE (lower(email) = lower($1::text) OR lower(username) = lower($1::text))
           AND deleted_at IS NULL
         LIMIT 1`,
        [identity]
      );
      userRow = rows[0];
    }

    if (!userRow) {
      return res.status(404).json({ error: 'user_not_found' });
    }
    userId = userRow.id;

    const resolvedName =
      payload.name ?? userRow.display_name ?? userRow.username ?? userRow.email;
    const resolvedBio = payload.bio ?? userRow.bio ?? null;
    const resolvedEmail = payload.email ?? userRow.email ?? null;

    const { rows: roleRows } = await query(
      `SELECT id, key FROM roles WHERE key IN ('client', 'worker')`
    );
    const roleIds = roleRows.reduce<Record<string, string>>((acc, row) => {
      acc[row.key] = row.id;
      return acc;
    }, {});

    if (roleIds.client) {
      await query(
        `DELETE FROM user_roles
         WHERE user_id = $1 AND role_id = $2`,
        [userId, roleIds.client]
      );
    }

    if (roleIds.worker) {
      await query(
        `INSERT INTO user_roles (user_id, role_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [userId, roleIds.worker]
      );
    }

    const { rows } = await query(
      `INSERT INTO talents
       (id, user_id, talent_role, name, bio, skill, email, phone_number, whatsapp, telegram, rate, img_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id, talent_role) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         talent_role = EXCLUDED.talent_role,
         name = EXCLUDED.name,
         bio = EXCLUDED.bio,
         skill = EXCLUDED.skill,
         email = EXCLUDED.email,
         phone_number = EXCLUDED.phone_number,
         whatsapp = EXCLUDED.whatsapp,
         telegram = EXCLUDED.telegram,
         rate = EXCLUDED.rate,
         img_url = EXCLUDED.img_url
       RETURNING *`,
      [
        userId,
        userId,
        role,
        resolvedName,
        resolvedBio,
        payload.skill ?? null,
        resolvedEmail,
        payload.phone_number ?? null,
        payload.whatsapp ?? null,
        payload.telegram ?? null,
        payload.rate ?? null,
        payload.img_url ?? null
      ]
    );

    await runNotificationTask('talent added event', () =>
      notifyTalentAdded({ talentUserId: userId, talentRole: role })
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get('/requests', async (req, res, next) => {
  const status = formatStatus(String(req.query?.status || ''));
  const { allowAll } = getScopeContext(req);
  const filters = allowAll ? ['1=1'] : ['(r.user_id = $1 OR r.assignee_user_id = $1)'];
  const params: Array<string> = allowAll ? [] : [req.currentUser.id];
  let idx = params.length;

  if (status) {
    idx += 1;
    filters.push(`r.status = $${idx}`);
    params.push(status);
  }

  try {
    const { rows } = await query(
      `SELECT r.id,
              r.user_id,
              r.role,
              r.detail,
              r.assignee_user_id,
              r.hourly_rate,
              r.when_at,
              r.status,
              r.archived,
              r.created_at,
              r.updated_at,
              t.email AS assignee_email,
              t.name AS assignee_display_name,
              au.username AS assignee_username,
              u.email AS requester_email,
              u.username AS requester_username,
              u.display_name AS requester_display_name
       FROM requests r
       LEFT JOIN talents t ON COALESCE(t.user_id, t.id) = r.assignee_user_id
       LEFT JOIN users au ON au.id = r.assignee_user_id
       LEFT JOIN users u ON u.id = r.user_id
       WHERE ${filters.join(' AND ')}
         AND COALESCE(r.archived, false) = false
       ORDER BY r.created_at DESC, r.id DESC`,
      params
    );
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/requests', async (req, res, next) => {
  const payload = req.body || {};
  const role = formatRole(payload.role);
  if (!role) return res.status(400).json({ error: 'invalid_role' });

  const status = formatStatus(payload.status) || 'pending';
  let detail = normalizeDetail(payload.detail);
  const assigneeId = payload.assignee_user_id ? String(payload.assignee_user_id) : null;
  const whenAt = payload.when_at ? new Date(payload.when_at).toISOString() : null;
  let hourlyRate: number | null = null;

  try {
    if (role === 'caller') {
      const callerDetail = normalizeCallerDetail(detail);
      if (!callerDetail) {
        return res.status(400).json({ error: 'caller_detail_required' });
      }
      detail = callerDetail;
    }

    if (assigneeId) {
      const rateQuery = await query(
        `SELECT t.rate
         FROM talents t
         WHERE COALESCE(t.user_id, t.id) = $1 AND t.talent_role = $2`,
        [assigneeId, role]
      );
      if (!rateQuery.rows.length) {
        return res.status(400).json({ error: 'assignee_not_found' });
      }
      const rateValue = rateQuery.rows[0].rate;
      hourlyRate = rateValue === null || rateValue === undefined ? null : Number(rateValue);
    }

    const { rows } = await query(
      `INSERT INTO requests (user_id, role, detail, assignee_user_id, hourly_rate, when_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.currentUser.id, role, detail, assigneeId, hourlyRate, whenAt, status]
    );
    const createdRequest = rows[0];
    if (role === 'bidder' && assigneeId) {
      await runNotificationTask('assign bidder request event', () =>
        notifyAssignBidderRequest({ requestId: createdRequest.id })
      );
    }
    if (role === 'caller' && assigneeId) {
      await runNotificationTask('assign caller request event', () =>
        notifyAssignCallerRequest({
          requestId: createdRequest.id,
          profileOwnerUserId: createdRequest.user_id,
          assignedCallerUserId: assigneeId
        })
      );
    }
    res.status(201).json(createdRequest);
  } catch (err) {
    next(err);
  }
});

router.patch('/requests/:requestId', async (req, res, next) => {
  const payload = req.body || {};
  const updates: string[] = [];
  const { allowAll } = getScopeContext(req);
  const baseParams = allowAll ? [req.params.requestId] : [req.params.requestId, req.currentUser.id];
  const params: Array<unknown> = [...baseParams];
  let idx = params.length;

  try {
    const { rows: existingRows } = await query<{
      id: string;
      user_id: string;
      role: 'bidder' | 'caller';
      status: 'pending' | 'working' | 'closed';
      assignee_user_id: string | null;
    }>(
      `SELECT id, user_id, role, status, assignee_user_id
       FROM requests
       WHERE id = $1 ${allowAll ? '' : 'AND user_id = $2'}
       LIMIT 1`,
      baseParams
    );
    if (!existingRows.length) return res.status(404).json({ error: 'not_found' });
    const existing = existingRows[0];
    const nextRole = payload.role !== undefined ? formatRole(payload.role) : existing.role;
    if (!nextRole) return res.status(400).json({ error: 'invalid_role' });

    const addField = (column: string, value: unknown) => {
      if (value === undefined) return;
      idx += 1;
      updates.push(`${column} = $${idx}`);
      params.push(value);
    };

    if (payload.role !== undefined) {
      addField('role', nextRole);
    }

    if (payload.status !== undefined) {
      const status = formatStatus(payload.status);
      if (!status) return res.status(400).json({ error: 'invalid_status' });
      addField('status', status);
      addField('archived', status !== 'pending');
    }

    if (payload.assignee_user_id !== undefined) {
      const nextAssigneeId = payload.assignee_user_id ? String(payload.assignee_user_id) : null;
      let rateValue: number | null = null;
      if (nextAssigneeId) {
        const rateResult = await query(
          `SELECT t.rate
           FROM talents t
           WHERE COALESCE(t.user_id, t.id) = $1 AND t.talent_role = $2`,
          [nextAssigneeId, nextRole]
        );
        if (!rateResult.rows.length) {
          return res.status(400).json({ error: 'assignee_not_found' });
        }
        const rawRate = rateResult.rows[0].rate;
        rateValue = rawRate === null || rawRate === undefined ? null : Number(rawRate);
      }

      addField('assignee_user_id', nextAssigneeId);
      addField('hourly_rate', rateValue);
    }

    if (payload.when_at !== undefined) {
      addField('when_at', payload.when_at ? new Date(payload.when_at).toISOString() : null);
    }

    if (payload.detail !== undefined) {
      const normalized = normalizeDetail(payload.detail);
      if (nextRole === 'caller') {
        const callerDetail = normalizeCallerDetail(normalized);
        if (!callerDetail) return res.status(400).json({ error: 'caller_detail_required' });
        addField('detail', callerDetail);
      } else {
        addField('detail', normalized);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'no_fields_to_update' });
    }

    const { rows } = await query(
      `UPDATE requests
       SET ${updates.join(', ')}
       WHERE id = $1 ${allowAll ? '' : 'AND user_id = $2'}
       RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });

    const updated = rows[0];
    const previousAssignee = existing.assignee_user_id ? String(existing.assignee_user_id) : null;
    const nextAssignee = updated.assignee_user_id ? String(updated.assignee_user_id) : null;
    const assigneeChanged = previousAssignee !== nextAssignee;
    const statusChanged = existing.status !== updated.status;
    const roleAfterUpdate = updated.role as 'bidder' | 'caller';

    if (payload.assignee_user_id !== undefined && assigneeChanged && roleAfterUpdate === 'bidder') {
      if (!previousAssignee && nextAssignee) {
        await runNotificationTask('assign bidder request event', () =>
          notifyAssignBidderRequest({ requestId: updated.id })
        );
      } else if (previousAssignee && nextAssignee) {
        await runNotificationTask('reassign bidder request event', () =>
          notifyReassignBidderRequest({
            requestId: updated.id,
            requesterUserId: updated.user_id,
            currentAssigneeUserId: nextAssignee
          })
        );
      } else if (previousAssignee && !nextAssignee) {
        await runNotificationTask('unassign bidder request event', () =>
          notifyUnassignBidderRequest({
            requestId: updated.id,
            requesterUserId: updated.user_id,
            previousAssigneeUserId: previousAssignee
          })
        );
      }
    }

    if (payload.assignee_user_id !== undefined && assigneeChanged && nextAssignee && roleAfterUpdate === 'caller') {
      await runNotificationTask('assign caller request event', () =>
        notifyAssignCallerRequest({
          requestId: updated.id,
          profileOwnerUserId: updated.user_id,
          assignedCallerUserId: nextAssignee
        })
      );
    }

    if (payload.status !== undefined && statusChanged && roleAfterUpdate === 'caller') {
      if (updated.status === 'working') {
        await runNotificationTask('caller request accepted event', () =>
          notifyCallerRequestDecision({
            requestId: updated.id,
            profileOwnerUserId: updated.user_id,
            assignedCallerUserId: nextAssignee,
            accepted: true
          })
        );
      } else if (updated.status === 'closed') {
        await runNotificationTask('caller request rejected event', () =>
          notifyCallerRequestDecision({
            requestId: updated.id,
            profileOwnerUserId: updated.user_id,
            assignedCallerUserId: nextAssignee,
            accepted: false
          })
        );
      }
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete('/requests/:requestId', async (req, res, next) => {
  const { allowAll } = getScopeContext(req);
  try {
    const { rowCount } = await query(
      `DELETE FROM requests
       WHERE id = $1 ${allowAll ? '' : 'AND user_id = $2'}`,
      allowAll ? [req.params.requestId] : [req.params.requestId, req.currentUser.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    return res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
