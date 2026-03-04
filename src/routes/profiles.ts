import express from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getClient, query } from '../db.js';
import { config } from '../config.js';
import { authRequired, fetchCurrentUser } from '../middleware/auth.js';
import { notifyAssignBidderToProfile, notifyProfileCreated } from '../services/notifications.js';
import { canAccessManagerScope, isAdmin } from '../lib/accessControl.js';
import {
  normalizeBaseResumeExperienceDates,
  type ResumeDateIssue
} from '../utils/resumeDate.js';

type ProfilesAccessMode = 'user' | 'manager' | 'admin';

function parseLimit(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 20;
  return Math.min(Math.floor(num), 100);
}

type CursorRow = { created_at: string | Date; id: string };

function encodeCursor(row?: CursorRow | null): string | null {
  if (!row) return null;
  return Buffer.from(JSON.stringify({ created_at: row.created_at, id: row.id })).toString('base64');
}

function decodeCursor(token: unknown): CursorRow | null {
  try {
    const json = Buffer.from(String(token), 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    if (parsed && parsed.created_at && parsed.id) return parsed;
  } catch (err) {
    return null;
  }
  return null;
}

const mapResumeDateIssues = (issues: ResumeDateIssue[]) =>
  issues.map((issue) => ({
    key: issue.key,
    index: issue.index,
    field: issue.field,
    path: `${issue.key}[${issue.index}].${issue.field}`,
    value: issue.value,
    message: issue.message
  }));

function isOutlookConfigured(): boolean {
  return Boolean(config.outlook.clientId && config.outlook.clientSecret && config.outlook.redirectUri);
}

function buildOutlookAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.outlook.clientId,
    response_type: 'code',
    redirect_uri: config.outlook.redirectUri,
    response_mode: 'query',
    scope: config.outlook.scopes.join(' '),
    prompt: 'login',
    state
  });
  return `https://login.microsoftonline.com/${config.outlook.tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
}

function toOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new URL(value).origin;
  } catch (err) {
    return null;
  }
}

function logOutlookAuthorize(event: string, payload: Record<string, unknown>): void {
  console.info(`[outlook-connect][authorize][${event}] ${JSON.stringify(payload)}`);
}

const createProfilesRouter = (mode: ProfilesAccessMode = 'user') => {
  const router = express.Router();
  const allowAll = mode !== 'user';
  const isElevatedRoute = mode === 'manager' || mode === 'admin';

  router.use(authRequired, fetchCurrentUser);
  router.use((req, res, next) => {
    if (mode === 'admin' && !isAdmin(req.currentUser?.roles)) {
      return res.status(403).json({ error: 'admin_required' });
    }
    if (mode === 'manager' && !canAccessManagerScope(req.currentUser)) {
      return res.status(403).json({ error: 'manager_required' });
    }
    return next();
  });

  // 1) List profiles
  router.get('/', async (req, res, next) => {
  const { q, cursor, include_deleted } = req.query || {};
  const limit = parseLimit(req.query?.limit);
  const filters = allowAll ? ['1=1'] : ['(p.user_id = $1 OR p.assigned_bidder_user_id = $1)'];
  const params: Array<string | number | Date | null> = allowAll ? [] : [req.currentUser.id];
  let idx = params.length;

  if (!include_deleted || include_deleted === 'false') {
    filters.push('p.deleted_at IS NULL');
  }

  if (q) {
    idx += 1;
    filters.push(`p.name ILIKE $${idx}`);
    params.push(`%${q}%`);
  }

  const decoded = cursor ? decodeCursor(cursor) : null;
  if (decoded) {
    idx += 1;
    const createdAtParam = idx;
    params.push(decoded.created_at);
    idx += 1;
    params.push(decoded.id);
    filters.push(`(p.created_at, p.id) < ($${createdAtParam}, $${idx})`);
  }

  try {
    const { rows } = await query(
      `SELECT p.id, p.user_id, p.name, p.description, p.base_info, p.base_resume, p.resume_template_id,
              rt.title AS resume_template_title,
              p.email_account_id, ea.email_address, ea.status AS email_connection_status,
              (SELECT COUNT(1)
               FROM emails e
               WHERE e.email_account_id = p.email_account_id
                 AND e.is_unread) AS unread_count,
              (SELECT MIN(ce.start_at)
               FROM calendar_events ce
               WHERE ce.email_account_id = p.email_account_id
                 AND ce.start_at >= now()) AS next_interview,
              p.assigned_bidder_user_id, p.assigned_at, p.created_at, p.updated_at, p.deleted_at,
              u.username AS owner_username,
              u.display_name AS owner_display_name,
              u.email AS owner_email,
              b.display_name AS assigned_bidder_display_name,
              b.username AS assigned_bidder_username,
              b.email AS assigned_bidder_email,
              ${allowAll ? 'false' : '(p.user_id = $1)'} AS is_owner,
              ${allowAll ? 'false' : '(p.assigned_bidder_user_id = $1)'} AS is_assigned_to_current_user
       FROM profiles p
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN resume_templates rt ON rt.id = p.resume_template_id
       LEFT JOIN email_accounts ea ON ea.id = p.email_account_id
       LEFT JOIN users b ON b.id = p.assigned_bidder_user_id
       WHERE ${filters.join(' AND ')}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $${params.length + 1}`,
      [...params, limit + 1]
    );

    const items = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeCursor(rows[limit] as CursorRow) : null;
    return res.json({ items, next_cursor: nextCursor });
  } catch (err) {
    next(err);
  }
  });

  // 2) Create profile
  router.post('/', async (req, res, next) => {
  const { name, description, base_info, base_resume, resume_template_id, user_id } = req.body || {};
  if (!name || !resume_template_id) {
    return res.status(400).json({ error: 'missing_required_fields' });
  }

  let normalizedBaseResume = base_resume;
  if (base_resume !== undefined) {
    const normalized = normalizeBaseResumeExperienceDates(base_resume);
    if (normalized.issues.length > 0) {
      return res.status(400).json({
        error: 'invalid_resume_date',
        message: 'Invalid work experience date format. Use MM/YYYY, and use Present only for endDate.',
        issues: mapResumeDateIssues(normalized.issues)
      });
    }
    normalizedBaseResume = normalized.resume;
  }

  const requestedOwnerUserId = user_id ? String(user_id).trim() : '';
  let targetOwnerUserId = req.currentUser.id;

  if (isElevatedRoute && requestedOwnerUserId) {
    try {
      const { rows } = await query<{ id: string; is_admin: boolean; is_worker: boolean }>(
        `SELECT u.id,
                COALESCE(BOOL_OR(r.key = 'admin'), false) AS is_admin,
                COALESCE(BOOL_OR(r.key = 'worker'), false) AS is_worker
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         LEFT JOIN roles r ON r.id = ur.role_id
         WHERE u.id = $1
           AND u.deleted_at IS NULL
         GROUP BY u.id
         LIMIT 1`,
        [requestedOwnerUserId]
      );
      if (!rows.length) {
        return res.status(404).json({ error: 'not_found' });
      }
      const target = rows[0];
      const isSelf = target.id === req.currentUser.id;
      const isElevatedTarget = Boolean(target.is_admin || target.is_worker);
      if (!isSelf && isElevatedTarget) {
        return res.status(404).json({ error: 'not_found' });
      }
      targetOwnerUserId = target.id;
    } catch (err) {
      return next(err);
    }
  }

  try {
    const { rows } = await query(
      `INSERT INTO profiles (user_id, name, description, base_info, base_resume, resume_template_id)
       VALUES ($1, $2, $3, COALESCE($4::jsonb, '{}'::jsonb), COALESCE($5::jsonb, '{}'::jsonb), $6)
      RETURNING id`,
      [
        targetOwnerUserId,
        name,
        description ?? null,
        base_info ?? null,
        normalizedBaseResume ?? null,
        resume_template_id
      ]
    );
    const createdId = rows[0]?.id;
    const created = await fetchProfileOr404(createdId, true, req.currentUser.id);
    try {
      await notifyProfileCreated(req.currentUser.id, created?.name || name);
    } catch (notifyErr) {
      console.error('[notifications] profile created event failed', notifyErr);
    }
    return res.status(201).json(created);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'duplicate_name' });
    }
    next(err);
  }
  });

  async function fetchProfileOr404(
    profileId: string,
    includeDeleted: boolean,
    userId: string
  ): Promise<any | null> {
  const { rows } = await query(
    `SELECT p.id, p.user_id, p.name, p.description, p.base_info, p.base_resume, p.resume_template_id,
            rt.title AS resume_template_title,
            p.email_account_id, ea.email_address, ea.status AS email_connection_status,
            (SELECT COUNT(1)
             FROM emails e
             WHERE e.email_account_id = p.email_account_id
               AND e.is_unread) AS unread_count,
            (SELECT MIN(ce.start_at)
             FROM calendar_events ce
             WHERE ce.email_account_id = p.email_account_id
               AND ce.start_at >= now()) AS next_interview,
            p.assigned_bidder_user_id, p.assigned_at, p.created_at, p.updated_at, p.deleted_at,
            u.username AS owner_username,
            u.display_name AS owner_display_name,
            u.email AS owner_email,
            b.display_name AS assigned_bidder_display_name,
            b.username AS assigned_bidder_username,
            b.email AS assigned_bidder_email,
            ${allowAll ? 'false' : '(p.user_id = $2)'} AS is_owner,
            ${allowAll ? 'false' : '(p.assigned_bidder_user_id = $2)'} AS is_assigned_to_current_user
     FROM profiles p
     LEFT JOIN users u ON u.id = p.user_id
     LEFT JOIN resume_templates rt ON rt.id = p.resume_template_id
     LEFT JOIN email_accounts ea ON ea.id = p.email_account_id
     LEFT JOIN users b ON b.id = p.assigned_bidder_user_id
     WHERE p.id = $1 ${allowAll ? '' : 'AND (p.user_id = $2 OR p.assigned_bidder_user_id = $2)'} ${includeDeleted ? '' : 'AND p.deleted_at IS NULL'}
     LIMIT 1`,
    allowAll ? [profileId] : [profileId, userId]
  );
  return rows[0] ?? null;
  }

  // 3) Get profile
  router.get('/:profileId', async (req, res, next) => {
  const includeDeleted = req.query?.include_deleted === 'true';
  try {
    const profile = await fetchProfileOr404(
      req.params.profileId,
      includeDeleted,
      req.currentUser.id
    );
    if (!profile) return res.status(404).json({ error: 'not_found' });
    return res.json(profile);
  } catch (err) {
    next(err);
  }
  });

  // 4) Update profile
  router.patch('/:profileId', async (req, res, next) => {
  const { name, description, base_info, base_resume, resume_template_id } = req.body || {};
  const updates = [];
  const params = [];
  const updateParamStart = allowAll ? 2 : 3;
  let normalizedBaseResume = base_resume;

  if (name !== undefined) {
    updates.push(`name = $${updates.length + updateParamStart}`);
    params.push(name);
  }
  if (description !== undefined) {
    updates.push(`description = $${updates.length + updateParamStart}`);
    params.push(description ?? null);
  }
  if (base_info !== undefined) {
    updates.push(`base_info = COALESCE($${updates.length + updateParamStart}::jsonb, '{}'::jsonb)`);
    params.push(base_info);
  }
  if (base_resume !== undefined) {
    const normalized = normalizeBaseResumeExperienceDates(base_resume);
    if (normalized.issues.length > 0) {
      return res.status(400).json({
        error: 'invalid_resume_date',
        message: 'Invalid work experience date format. Use MM/YYYY, and use Present only for endDate.',
        issues: mapResumeDateIssues(normalized.issues)
      });
    }
    normalizedBaseResume = normalized.resume;
    updates.push(`base_resume = COALESCE($${updates.length + updateParamStart}::jsonb, '{}'::jsonb)`);
    params.push(normalizedBaseResume);
  }
  if (resume_template_id !== undefined) {
    updates.push(`resume_template_id = $${updates.length + updateParamStart}`);
    params.push(resume_template_id);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'no_fields_to_update' });
  }

  try {
    const { rows } = await query(
      `UPDATE profiles
       SET ${updates.join(', ')}
       WHERE id = $1 ${allowAll ? '' : 'AND user_id = $2'} AND deleted_at IS NULL
       RETURNING id`,
      allowAll ? [req.params.profileId, ...params] : [req.params.profileId, req.currentUser.id, ...params]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
    const updated = await fetchProfileOr404(
      req.params.profileId,
      false,
      req.currentUser.id
    );
    return res.json(updated);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'duplicate_name' });
    next(err);
  }
  });

  // 5) Soft delete profile
  router.delete('/:profileId', async (req, res, next) => {
  try {
    const { rowCount } = await query(
      `UPDATE profiles
       SET deleted_at = now(), assigned_bidder_user_id = NULL, assigned_at = NULL
       WHERE id = $1 ${allowAll ? '' : 'AND user_id = $2'} AND deleted_at IS NULL`,
      allowAll ? [req.params.profileId] : [req.params.profileId, req.currentUser.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'not_found' });
    return res.status(204).send();
  } catch (err) {
    next(err);
  }
  });

  async function ensureBidderRole(userId: string): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1
     FROM talents t
     JOIN users u ON u.id = COALESCE(t.user_id, t.id)
     WHERE COALESCE(t.user_id, t.id) = $1
       AND t.talent_role = 'bidder'
       AND u.deleted_at IS NULL
     LIMIT 1`,
    [userId]
  );
  return rows.length > 0;
  }

  async function updateAssignment(
    profileId: string,
    userId: string,
    bidderUserId: string | null
  ): Promise<any | null> {
  const setClause = bidderUserId
    ? allowAll
      ? 'assigned_bidder_user_id = $2, assigned_at = now()'
      : 'assigned_bidder_user_id = $3, assigned_at = now()'
    : 'assigned_bidder_user_id = NULL, assigned_at = NULL';

  const params = allowAll
    ? bidderUserId
      ? [profileId, bidderUserId]
      : [profileId]
    : bidderUserId
      ? [profileId, userId, bidderUserId]
      : [profileId, userId];

  const { rows } = await query(
    `UPDATE profiles
     SET ${setClause}
     WHERE id = $1 ${allowAll ? '' : 'AND user_id = $2'} AND deleted_at IS NULL
     RETURNING id`,
    params
  );
  const updatedId = rows[0]?.id;
  if (!updatedId) return null;

  await query(
    `UPDATE calendar_events
     SET assigned_user_id = $2
     WHERE profile_id = $1`,
    [updatedId, bidderUserId]
  );

  return fetchProfileOr404(updatedId, false, userId);
  }

  // 6) Assign bidder
  router.post('/:profileId/assign-bidder', async (req, res, next) => {
  const { bidder_user_id } = req.body || {};
  if (!bidder_user_id) return res.status(400).json({ error: 'missing_bidder_user_id' });

  try {
    const hasRole = await ensureBidderRole(bidder_user_id);
    if (!hasRole) return res.status(400).json({ error: 'bidder_user_missing_role' });

    const profile = await updateAssignment(
      req.params.profileId,
      req.currentUser.id,
      bidder_user_id
    );
    if (!profile) return res.status(404).json({ error: 'not_found' });
    try {
      await notifyAssignBidderToProfile({
        profileId: profile.id,
        profileName: profile.name || 'Profile',
        profileOwnerUserId: profile.user_id,
        bidderUserId: bidder_user_id
      });
    } catch (notifyErr) {
      console.error('[notifications] assign bidder event failed', notifyErr);
    }
    return res.json(profile);
  } catch (err) {
    next(err);
  }
  });

  // 7) Unassign bidder
  router.post('/:profileId/unassign-bidder', async (req, res, next) => {
  try {
    const profile = await updateAssignment(req.params.profileId, req.currentUser.id, null);
    if (!profile) return res.status(404).json({ error: 'not_found' });
    return res.json(profile);
  } catch (err) {
    next(err);
  }
  });

  // 8) Disconnect Outlook email connection
  router.post('/:profileId/email/outlook/disconnect', async (req, res, next) => {
  const isAdminRoute = mode === 'admin';

  let client: PoolClient | null = null;
  try {
    client = await getClient();
    await client.query('BEGIN');

    const { rows } = await client.query<{ id: string; email_account_id: string | null }>(
      isAdminRoute
        ? `SELECT id, email_account_id
           FROM profiles
           WHERE id = $1 AND deleted_at IS NULL
           LIMIT 1`
        : `SELECT id, email_account_id
           FROM profiles
           WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
           LIMIT 1`,
      isAdminRoute ? [req.params.profileId] : [req.params.profileId, req.currentUser.id]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found' });
    }

    const profileId = rows[0]?.id;
    const emailAccountId = rows[0]?.email_account_id;

    if (emailAccountId) {
      await client.query(
        `UPDATE profiles
         SET email_account_id = NULL
         WHERE id = $1`,
        [profileId]
      );
      await client.query(
        `DELETE FROM email_accounts
         WHERE id = $1`,
        [emailAccountId]
      );
    }

    await client.query('COMMIT');

    const updated = await fetchProfileOr404(
      req.params.profileId,
      false,
      req.currentUser.id
    );
    if (!updated) return res.status(404).json({ error: 'not_found' });
    return res.json(updated);
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        // ignore rollback errors
      }
    }
    next(err);
  } finally {
    if (client) client.release();
  }
  });

  // 9) Start Outlook email connection
  router.post('/:profileId/email/outlook/authorize', async (req, res, next) => {
  const connectTraceId = randomUUID();
  const requestOrigin = toOrigin(req.get('origin'));
  const routeScope = mode;
  const isAdminRoute = mode === 'admin';

  if (!isOutlookConfigured()) {
    logOutlookAuthorize('outlook_not_configured', {
      trace_id: connectTraceId,
      profile_id: req.params.profileId,
      user_id: req.currentUser.id,
      route_scope: routeScope,
      origin: requestOrigin
    });
    return res.status(503).json({ error: 'outlook_not_configured' });
  }

  try {
    const { rows } = await query<{ id: string; user_id: string }>(
      isAdminRoute
        ? `SELECT id, user_id
           FROM profiles
           WHERE id = $1 AND deleted_at IS NULL
           LIMIT 1`
        : `SELECT id, user_id
           FROM profiles
           WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
           LIMIT 1`,
      isAdminRoute ? [req.params.profileId] : [req.params.profileId, req.currentUser.id]
    );
    if (rows.length === 0) {
      logOutlookAuthorize('owner_scope_guard_not_found', {
        trace_id: connectTraceId,
        profile_id: req.params.profileId,
        user_id: req.currentUser.id,
        route_scope: routeScope,
        origin: requestOrigin
      });
      return res.status(404).json({ error: 'not_found' });
    }
    const profileOwnerUserId = rows[0]?.user_id || req.currentUser.id;

    const state = jwt.sign(
      {
        purpose: 'outlook_connect',
        profile_id: req.params.profileId,
        user_id: profileOwnerUserId,
        actor_user_id: req.currentUser.id,
        frontend_origin: requestOrigin,
        connect_trace_id: connectTraceId
      },
      config.jwt.secret,
      { expiresIn: '10m' }
    );

    logOutlookAuthorize('authorize_ready', {
      trace_id: connectTraceId,
      profile_id: req.params.profileId,
      user_id: req.currentUser.id,
      route_scope: routeScope,
      origin: requestOrigin
    });

    const url = buildOutlookAuthorizeUrl(state);
    return res.json({ url });
  } catch (err) {
    logOutlookAuthorize('authorize_failed', {
      trace_id: connectTraceId,
      profile_id: req.params.profileId,
      user_id: req.currentUser.id,
      route_scope: routeScope,
      origin: requestOrigin,
      error: err instanceof Error ? err.message : String(err)
    });
    next(err);
  }
  });

  return router;
};

export { createProfilesRouter };
export default createProfilesRouter();
