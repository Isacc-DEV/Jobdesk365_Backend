import express from 'express';
import { config } from '../config.js';
import { getClient, query } from '../db.js';
import { authRequired, fetchCurrentUser } from '../middleware/auth.js';
import { canAccessManagerScope, isAdmin } from '../lib/accessControl.js';

const router = express.Router();
type RouteScope = 'user' | 'manager' | 'admin';
type TalentRole = 'bidder' | 'caller';
type ManualCallStatus = 'unassigned' | 'pending' | 'assigned' | 'rejected';
type RequestStatus = 'pending' | 'working' | 'closed' | null;

type CalendarEventRow = {
  id: string;
  email_account_id: string;
  profile_id: string | null;
  title: string | null;
  start_at: string | Date | null;
  end_at: string | Date | null;
  assigned_user_id: string | null;
};

type ManualCalendarEventRow = {
  id: string;
  owner_user_id: string;
  title: string | null;
  start_at: string | Date | null;
  end_at: string | Date | null;
  profile_id: string | null;
  requested_caller_user_id: string | null;
  assigned_caller_user_id: string | null;
  caller_request_id: string | null;
  call_status: ManualCallStatus;
  note: string | null;
  request_status: RequestStatus;
  profile_name: string | null;
};

const BIDDER_BASE_RATE = 0.07;
const CALLER_BASE_RATE = 0.5;

const getRoleBaseRate = (role: TalentRole): number =>
  role === 'caller' ? CALLER_BASE_RATE : BIDDER_BASE_RATE;

const normalizeRateForRole = (role: TalentRole, rawRate: unknown): number => {
  const parsed = Number(rawRate);
  if (!Number.isFinite(parsed) || parsed < 0) return getRoleBaseRate(role);
  return Math.round(parsed * 100) / 100;
};

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
  if (scope === 'admin' && !isAdmin(req.currentUser?.roles)) {
    return res.status(403).json({ error: 'admin_required' });
  }
  if (scope === 'manager' && !canAccessManagerScope(req.currentUser)) {
    return res.status(403).json({ error: 'manager_required' });
  }
  return next();
};
let calendarSchemaPromise: Promise<void> | null = null;

const ensureCalendarSchema = async () => {
  if (calendarSchemaPromise) return calendarSchemaPromise;
  calendarSchemaPromise = (async () => {
    await query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    await query(`
      CREATE TABLE IF NOT EXISTS calendar_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email_account_id uuid NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
        profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
        assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        external_event_id text NOT NULL,
        title text,
        start_at timestamptz,
        end_at timestamptz,
        synced_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT calendar_events_external_event_id_unique UNIQUE (external_event_id)
      )
    `);
    await query(`
      ALTER TABLE calendar_events
      ADD COLUMN IF NOT EXISTS assigned_user_id uuid
    `);
    await query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'calendar_events_assigned_user_fk'
            AND table_name = 'calendar_events'
        ) THEN
          ALTER TABLE calendar_events
          ADD CONSTRAINT calendar_events_assigned_user_fk
          FOREIGN KEY (assigned_user_id)
          REFERENCES users(id)
          ON DELETE SET NULL;
        END IF;
      END
      $$;
    `);
    await query(
      `CREATE INDEX IF NOT EXISTS idx_calendar_events_assigned_user_id ON calendar_events (assigned_user_id)`
    );
    await query(`
      CREATE TABLE IF NOT EXISTS manual_calendar_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title text NOT NULL,
        start_at timestamptz NOT NULL,
        end_at timestamptz NOT NULL,
        profile_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
        requested_caller_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        assigned_caller_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        caller_request_id uuid,
        call_status text NOT NULL DEFAULT 'unassigned',
        note text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT manual_calendar_events_call_status_allowed
          CHECK (call_status IN ('unassigned', 'pending', 'assigned', 'rejected')),
        CONSTRAINT manual_calendar_events_time_range_valid CHECK (end_at > start_at)
      )
    `);
    await query(
      `CREATE INDEX IF NOT EXISTS idx_manual_calendar_events_owner_user_id ON manual_calendar_events (owner_user_id)`
    );
    await query(
      `CREATE INDEX IF NOT EXISTS idx_manual_calendar_events_assigned_caller_user_id ON manual_calendar_events (assigned_caller_user_id)`
    );
    await query(
      `CREATE INDEX IF NOT EXISTS idx_manual_calendar_events_start_at ON manual_calendar_events (start_at)`
    );
    await query(
      `CREATE INDEX IF NOT EXISTS idx_manual_calendar_events_caller_request_id ON manual_calendar_events (caller_request_id)`
    );
    await query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_name = 'requests'
        ) AND NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'manual_calendar_events_caller_request_id_fkey'
            AND table_name = 'manual_calendar_events'
        ) THEN
          ALTER TABLE manual_calendar_events
          ADD CONSTRAINT manual_calendar_events_caller_request_id_fkey
          FOREIGN KEY (caller_request_id)
          REFERENCES requests(id)
          ON DELETE SET NULL;
        END IF;
      END
      $$;
    `);
  })();

  try {
    await calendarSchemaPromise;
  } catch (err) {
    calendarSchemaPromise = null;
    throw err;
  }

  return calendarSchemaPromise;
};

function parseLimit(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 50;
  return Math.min(Math.floor(num), 200);
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value;
  }
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function parseBooleanFlag(value: unknown): boolean {
  return value === '1' || value === 'true' || value === 'yes' || value === true;
}

function parseNonEmptyText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const next = String(value).trim();
  return next ? next : null;
}

function mapRequestStatusToCallStatus(status: RequestStatus, fallback: ManualCallStatus): ManualCallStatus {
  if (status === 'pending') return 'pending';
  if (status === 'working') return 'assigned';
  if (status === 'closed') return 'rejected';
  return fallback;
}

const resolveManualVisibilityWhere = (allowAll: boolean, userParamIndex = 1): string =>
  allowAll
    ? '1=1'
    : `(m.owner_user_id = $${userParamIndex} OR m.assigned_caller_user_id = $${userParamIndex})`;

const parseDateRangeOrNull = (rawStart: unknown, rawEnd: unknown) => {
  const start = rawStart !== undefined ? parseDate(rawStart) : null;
  const end = rawEnd !== undefined ? parseDate(rawEnd) : null;
  if (rawStart !== undefined && !start) return { error: 'invalid_start_at', start: null, end: null };
  if (rawEnd !== undefined && !end) return { error: 'invalid_end_at', start: null, end: null };
  if (start && end && end <= start) return { error: 'invalid_time_range', start: null, end: null };
  return { error: null as string | null, start, end };
};

const canApproveCallerRequest = (req: express.Request): boolean =>
  isAdmin(req.currentUser?.roles) || canAccessManagerScope(req.currentUser);

const resolveManualEventOwnerUserId = async (
  req: express.Request,
  allowAll: boolean,
  requestedOwnerUserId: string | null
): Promise<string | null> => {
  if (!allowAll) return req.currentUser.id;
  if (!requestedOwnerUserId) return req.currentUser.id;

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
  if (!rows.length) return null;
  const target = rows[0];
  const isSelf = target.id === req.currentUser.id;
  const isElevatedTarget = Boolean(target.is_admin || target.is_worker);
  if (!isSelf && isElevatedTarget) return null;
  return target.id;
};

const ensureProfileAccessible = async (
  profileId: string,
  req: express.Request,
  allowAll: boolean
): Promise<{ id: string; name: string; user_id: string } | null> => {
  const { rows } = await query<{ id: string; name: string; user_id: string }>(
    allowAll
      ? `SELECT id, name, user_id
         FROM profiles
         WHERE id = $1 AND deleted_at IS NULL
         LIMIT 1`
      : `SELECT id, name, user_id
         FROM profiles
         WHERE id = $1
           AND (user_id = $2 OR assigned_bidder_user_id = $2)
           AND deleted_at IS NULL
         LIMIT 1`,
    allowAll ? [profileId] : [profileId, req.currentUser.id]
  );
  return rows[0] || null;
};

const ensureCallerEligible = async (callerUserId: string): Promise<boolean> => {
  const { rows } = await query(
    `SELECT u.id
     FROM users u
     WHERE u.id = $1
       AND u.deleted_at IS NULL
       AND EXISTS (
         SELECT 1
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = u.id
           AND r.key = 'worker'
       )
       AND EXISTS (
         SELECT 1
         FROM user_badges ub
         WHERE COALESCE(ub.user_id, ub.id) = u.id
           AND COALESCE(ub.badge_key, ub.talent_role) = 'caller'
       )
     LIMIT 1`,
    [callerUserId]
  );
  return rows.length > 0;
};

const fetchManualEventById = async (
  eventId: string,
  req: express.Request,
  allowAll: boolean
): Promise<ManualCalendarEventRow | null> => {
  const { rows } = await query<ManualCalendarEventRow>(
    `SELECT m.id,
            m.owner_user_id,
            m.title,
            m.start_at,
            m.end_at,
            m.profile_id,
            p.name AS profile_name,
            m.requested_caller_user_id,
            m.assigned_caller_user_id,
            m.caller_request_id,
            m.call_status,
            m.note,
            r.status AS request_status
     FROM manual_calendar_events m
     LEFT JOIN requests r ON r.id = m.caller_request_id
     LEFT JOIN profiles p ON p.id = m.profile_id
     WHERE m.id = $1
       AND ${resolveManualVisibilityWhere(allowAll, 2)}
     LIMIT 1`,
    allowAll ? [eventId] : [eventId, req.currentUser.id]
  );
  if (!rows.length) return null;
  const item = rows[0];
  return {
    ...item,
    call_status: mapRequestStatusToCallStatus(item.request_status, item.call_status)
  };
};

const serializeManualEvent = (item: ManualCalendarEventRow) => ({
  id: item.id,
  source: 'manual' as const,
  manual_event_id: item.id,
  email_account_id: null,
  title: item.title,
  start_at: item.start_at,
  end_at: item.end_at,
  assigned_user_id: item.assigned_caller_user_id,
  owner_user_id: item.owner_user_id,
  profile_id: item.profile_id,
  profile_name: item.profile_name,
  requested_caller_user_id: item.requested_caller_user_id,
  assigned_caller_user_id: item.assigned_caller_user_id,
  caller_request_id: item.caller_request_id,
  call_status: mapRequestStatusToCallStatus(item.request_status, item.call_status),
  request_status: item.request_status,
  note: item.note
});

const buildCalendarManualRequestDetail = (input: {
  eventId: string;
  title: string;
  profileId: string | null;
  profileName: string | null;
  note: string | null;
}) => ({
  source: 'calendar_manual',
  event_id: input.eventId,
  title: input.title,
  profile_id: input.profileId,
  profile_name: input.profileName,
  note: input.note || ''
});

const fetchJson = async (response: Response): Promise<Record<string, any>> => {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    return { error: 'invalid_json', error_description: text };
  }
};

const buildRefreshRequest = (refreshToken: string): string => {
  const params = new URLSearchParams({
    client_id: config.outlook.clientId,
    client_secret: config.outlook.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: config.outlook.scopes.join(' ')
  });
  return params.toString();
};

const isTokenExpiring = (tokenExpiresAt: string | Date | null, bufferSeconds = 120): boolean => {
  if (!tokenExpiresAt) return false;
  const expiresAt = new Date(tokenExpiresAt).getTime();
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt - Date.now() <= bufferSeconds * 1000;
};

const fetchOutlookEvents = async (accessToken: string, start: Date, end: Date, limit: number) => {
  const url = new URL('https://graph.microsoft.com/v1.0/me/calendarView');
  url.searchParams.set('startDateTime', start.toISOString());
  url.searchParams.set('endDateTime', end.toISOString());
  url.searchParams.set('$select', 'id,subject,start,end');
  url.searchParams.set('$orderby', 'start/dateTime');
  url.searchParams.set('$top', String(limit));
  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  const data = await fetchJson(response);
  return { response, data };
};

router.use(async (_req, _res, next) => {
  try {
    await ensureCalendarSchema();
    next();
  } catch (err) {
    next(err);
  }
});

router.get('/accounts', authRequired, fetchCurrentUser, requireScopeAccess, async (req, res, next) => {
  try {
    const { allowAll } = getScopeContext(req);
    const filters = allowAll ? ['p.deleted_at IS NULL'] : ['(p.user_id = $1 OR p.assigned_bidder_user_id = $1)', 'p.deleted_at IS NULL'];
    const params: Array<string> = allowAll ? [] : [req.currentUser.id];
    const { rows } = await query(
      `SELECT p.id AS profile_id,
              p.name AS profile_name,
              u.username AS owner_username,
              u.display_name AS owner_display_name,
              u.email AS owner_email,
              p.email_account_id,
              ea.email_address,
              ea.status,
              COUNT(ce.id) AS event_count
       FROM profiles p
       LEFT JOIN users u ON u.id = p.user_id
       JOIN email_accounts ea ON ea.id = p.email_account_id
       LEFT JOIN calendar_events ce ON ce.email_account_id = p.email_account_id
       WHERE ${filters.join(' AND ')}
       GROUP BY p.id, ea.id, u.username, u.display_name, u.email
       ORDER BY p.created_at DESC`,
      params
    );
    return res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/events', authRequired, fetchCurrentUser, requireScopeAccess, async (req, res, next) => {
  const { allowAll } = getScopeContext(req);
  const accountId = typeof req.query?.account_id === 'string' ? req.query.account_id : null;
  const assignedOnly = !allowAll && parseBooleanFlag(req.query?.assigned_only);
  const limit = parseLimit(req.query?.limit);
  const start = parseDate(req.query?.start);
  const end = parseDate(req.query?.end);

  try {
    const outlookFilters: string[] = ['p.deleted_at IS NULL'];
    const outlookParams: Array<string | Date | number> = [];

    if (allowAll) {
      if (accountId) {
        outlookParams.push(accountId);
        outlookFilters.push(`ce.email_account_id = $${outlookParams.length}`);
      } else {
        outlookFilters.push('1=0');
      }
    } else {
      outlookParams.push(req.currentUser.id);
      if (assignedOnly) {
        outlookFilters.push('ce.assigned_user_id = $1');
      } else {
        outlookFilters.push('(p.user_id = $1 OR ce.assigned_user_id = $1)');
        if (accountId) {
          outlookParams.push(accountId);
          outlookFilters.push(`ce.email_account_id = $${outlookParams.length}`);
        }
      }
    }

    if (start) {
      outlookParams.push(start);
      outlookFilters.push(`ce.start_at >= $${outlookParams.length}`);
    }
    if (end) {
      outlookParams.push(end);
      outlookFilters.push(`ce.end_at <= $${outlookParams.length}`);
    }

    const manualFilters: string[] = [];
    const manualParams: Array<string | Date | number> = [req.currentUser.id];
    if (allowAll) {
      manualFilters.push(
        `(m.owner_user_id = $1 OR m.requested_caller_user_id IS NOT NULL OR m.assigned_caller_user_id IS NOT NULL OR m.caller_request_id IS NOT NULL)`
      );
    } else {
      manualFilters.push(resolveManualVisibilityWhere(false, 1));
    }
    if (start) {
      manualParams.push(start);
      manualFilters.push(`m.start_at >= $${manualParams.length}`);
    }
    if (end) {
      manualParams.push(end);
      manualFilters.push(`m.end_at <= $${manualParams.length}`);
    }

    const [outlookResult, manualResult] = await Promise.all([
      query<CalendarEventRow>(
        `SELECT ce.id,
                ce.email_account_id,
                ce.profile_id,
                ce.title,
                ce.start_at,
                ce.end_at,
                ce.assigned_user_id
         FROM calendar_events ce
         JOIN profiles p ON p.email_account_id = ce.email_account_id
         WHERE ${outlookFilters.join(' AND ')}
         ORDER BY ce.start_at ASC NULLS LAST
         LIMIT $${outlookParams.length + 1}`,
        [...outlookParams, limit]
      ),
      query<ManualCalendarEventRow>(
        `SELECT m.id,
                m.owner_user_id,
                m.title,
                m.start_at,
                m.end_at,
                m.profile_id,
                p.name AS profile_name,
                m.requested_caller_user_id,
                m.assigned_caller_user_id,
                m.caller_request_id,
                m.call_status,
                m.note,
                r.status AS request_status
         FROM manual_calendar_events m
         LEFT JOIN requests r ON r.id = m.caller_request_id
         LEFT JOIN profiles p ON p.id = m.profile_id
         WHERE ${manualFilters.join(' AND ')}
         ORDER BY m.start_at ASC NULLS LAST
         LIMIT $${manualParams.length + 1}`,
        [...manualParams, limit]
      )
    ]);

    const outlookItems = outlookResult.rows.map((item) => ({
      id: item.id,
      source: 'outlook' as const,
      email_account_id: item.email_account_id,
      manual_event_id: null,
      title: item.title,
      start_at: item.start_at,
      end_at: item.end_at,
      assigned_user_id: item.assigned_user_id,
      profile_id: item.profile_id ?? null,
      profile_name: null,
      requested_caller_user_id: null,
      assigned_caller_user_id: null,
      caller_request_id: null,
      call_status: null,
      request_status: null,
      note: null
    }));
    const manualItems = manualResult.rows.map(serializeManualEvent);
    const merged = [...outlookItems, ...manualItems]
      .sort((a, b) => {
        const aTime = a.start_at ? new Date(a.start_at).getTime() : Number.MAX_SAFE_INTEGER;
        const bTime = b.start_at ? new Date(b.start_at).getTime() : Number.MAX_SAFE_INTEGER;
        return aTime - bTime;
      })
      .slice(0, limit);
    return res.json({ items: merged });
  } catch (err) {
    next(err);
  }
});

router.post('/events/manual', authRequired, fetchCurrentUser, requireScopeAccess, async (req, res, next) => {
  const { allowAll } = getScopeContext(req);
  const title = parseNonEmptyText(req.body?.title);
  const note = parseNonEmptyText(req.body?.note);
  const requestedOwnerUserId =
    parseNonEmptyText(req.body?.owner_user_id) || parseNonEmptyText(req.body?.user_id);
  const profileId = parseNonEmptyText(req.body?.profile_id);
  const callerUserId =
    parseNonEmptyText(req.body?.caller_user_id) || parseNonEmptyText(req.body?.requested_caller_user_id);
  const range = parseDateRangeOrNull(req.body?.start_at, req.body?.end_at);

  if (!title) return res.status(400).json({ error: 'title_required' });
  if (range.error || !range.start || !range.end) {
    return res.status(400).json({ error: range.error || 'invalid_time_range' });
  }

  try {
    const targetOwnerUserId = await resolveManualEventOwnerUserId(req, allowAll, requestedOwnerUserId);
    if (!targetOwnerUserId) {
      return res.status(404).json({ error: 'not_found' });
    }
    const profile = profileId ? await ensureProfileAccessible(profileId, req, allowAll) : null;
    if (profileId && !profile) {
      return res.status(404).json({ error: 'profile_not_found' });
    }
    if (profile && String(profile.user_id) !== String(targetOwnerUserId)) {
      return res.status(404).json({ error: 'profile_not_found' });
    }
    if (callerUserId) {
      const isEligible = await ensureCallerEligible(callerUserId);
      if (!isEligible) return res.status(400).json({ error: 'assignee_not_caller' });
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');

      const createdResult = await client.query<{ id: string }>(
        `INSERT INTO manual_calendar_events
         (owner_user_id, title, start_at, end_at, profile_id, requested_caller_user_id, assigned_caller_user_id, call_status, note)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8)
         RETURNING id`,
        [
          targetOwnerUserId,
          title,
          range.start,
          range.end,
          profile?.id || null,
          callerUserId,
          callerUserId ? 'pending' : 'unassigned',
          note
        ]
      );

      const manualEventId = createdResult.rows[0]?.id;
      if (!manualEventId) {
        await client.query('ROLLBACK');
        return res.status(500).json({ error: 'create_failed' });
      }

      if (callerUserId) {
        const detail = buildCalendarManualRequestDetail({
          eventId: manualEventId,
          title,
          profileId: profile?.id || null,
          profileName: profile?.name || null,
          note
        });
        const requestResult = await client.query<{ id: string }>(
          `INSERT INTO requests (user_id, role, detail, assignee_user_id, when_at, status, archived)
           VALUES ($1, 'caller', $2::jsonb, $3, $4, 'pending', false)
           RETURNING id`,
          [targetOwnerUserId, JSON.stringify(detail), callerUserId, range.start]
        );
        const requestId = requestResult.rows[0]?.id || null;
        if (requestId) {
          await client.query(
            `UPDATE manual_calendar_events
             SET caller_request_id = $2,
                 updated_at = now()
             WHERE id = $1`,
            [manualEventId, requestId]
          );
        }
      }

      await client.query('COMMIT');
      const item = await fetchManualEventById(manualEventId, req, allowAll);
      if (!item) return res.status(404).json({ error: 'not_found' });
      return res.status(201).json(serializeManualEvent(item));
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

router.patch('/events/manual/:eventId', authRequired, fetchCurrentUser, requireScopeAccess, async (req, res, next) => {
  const { allowAll } = getScopeContext(req);
  const eventId = req.params.eventId;
  const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(req.body || {}, key);
  const titleProvided = hasOwn('title');
  const startProvided = hasOwn('start_at');
  const endProvided = hasOwn('end_at');
  const profileProvided = hasOwn('profile_id');
  const callerProvided = hasOwn('caller_user_id') || hasOwn('requested_caller_user_id');
  const noteProvided = hasOwn('note');

  if (!titleProvided && !startProvided && !endProvided && !profileProvided && !callerProvided && !noteProvided) {
    return res.status(400).json({ error: 'no_fields_to_update' });
  }

  try {
    const { rows: existingRows } = await query<ManualCalendarEventRow>(
      `SELECT m.id,
              m.owner_user_id,
              m.title,
              m.start_at,
              m.end_at,
              m.profile_id,
              p.name AS profile_name,
              m.requested_caller_user_id,
              m.assigned_caller_user_id,
              m.caller_request_id,
              m.call_status,
              m.note,
              r.status AS request_status
       FROM manual_calendar_events m
       LEFT JOIN requests r ON r.id = m.caller_request_id
       LEFT JOIN profiles p ON p.id = m.profile_id
       WHERE m.id = $1
         AND ${allowAll ? '1=1' : 'm.owner_user_id = $2'}
       LIMIT 1`,
      allowAll ? [eventId] : [eventId, req.currentUser.id]
    );
    if (!existingRows.length) return res.status(404).json({ error: 'not_found' });

    const existing = existingRows[0];
    const nextTitle = titleProvided ? parseNonEmptyText(req.body?.title) : String(existing.title || '');
    if (!nextTitle) return res.status(400).json({ error: 'title_required' });

    const range = parseDateRangeOrNull(
      startProvided ? req.body?.start_at : existing.start_at,
      endProvided ? req.body?.end_at : existing.end_at
    );
    if (range.error || !range.start || !range.end) {
      return res.status(400).json({ error: range.error || 'invalid_time_range' });
    }

    const defaultProfile = existing.profile_id
      ? { id: existing.profile_id, name: existing.profile_name || null }
      : null;
    let nextProfile = defaultProfile;
    if (profileProvided) {
      const requestedProfileId = parseNonEmptyText(req.body?.profile_id);
      if (requestedProfileId) {
        nextProfile = await ensureProfileAccessible(requestedProfileId, req, allowAll);
        if (!nextProfile) {
          return res.status(404).json({ error: 'profile_not_found' });
        }
      } else {
        nextProfile = null;
      }
    }

    const rawCallerId = callerProvided
      ? parseNonEmptyText(req.body?.caller_user_id) || parseNonEmptyText(req.body?.requested_caller_user_id)
      : existing.requested_caller_user_id;
    if (rawCallerId) {
      const isEligible = await ensureCallerEligible(rawCallerId);
      if (!isEligible) return res.status(400).json({ error: 'assignee_not_caller' });
    }

    const nextNote = noteProvided ? parseNonEmptyText(req.body?.note) : existing.note;
    const existingRequestedCallerId = existing.requested_caller_user_id ? String(existing.requested_caller_user_id) : null;
    const callerChanged = callerProvided && String(rawCallerId || '') !== String(existingRequestedCallerId || '');

    const client = await getClient();
    try {
      await client.query('BEGIN');

      let nextCallerRequestId = existing.caller_request_id;
      let nextRequestedCallerId = existing.requested_caller_user_id;
      let nextAssignedCallerId = existing.assigned_caller_user_id;
      let nextCallStatus = mapRequestStatusToCallStatus(existing.request_status, existing.call_status);

      if (callerChanged && existing.caller_request_id) {
        await client.query(
          `UPDATE requests
           SET status = 'closed',
               archived = true,
               updated_at = now()
           WHERE id = $1`,
          [existing.caller_request_id]
        );
        nextCallerRequestId = null;
        nextAssignedCallerId = null;
        nextCallStatus = 'unassigned';
      }

      if (callerProvided) {
        if (rawCallerId) {
          const requestDetail = buildCalendarManualRequestDetail({
            eventId,
            title: nextTitle,
            profileId: nextProfile?.id || null,
            profileName: nextProfile?.name || null,
            note: nextNote
          });

          if (callerChanged || !nextCallerRequestId) {
            const inserted = await client.query<{ id: string }>(
              `INSERT INTO requests (user_id, role, detail, assignee_user_id, when_at, status, archived)
               VALUES ($1, 'caller', $2::jsonb, $3, $4, 'pending', false)
               RETURNING id`,
              [existing.owner_user_id, JSON.stringify(requestDetail), rawCallerId, range.start]
            );
            nextCallerRequestId = inserted.rows[0]?.id || null;
          } else {
            await client.query(
              `UPDATE requests
               SET detail = $2::jsonb,
                   assignee_user_id = $3,
                   when_at = $4,
                   updated_at = now()
               WHERE id = $1`,
              [nextCallerRequestId, JSON.stringify(requestDetail), rawCallerId, range.start]
            );
          }

          nextRequestedCallerId = rawCallerId;
          nextAssignedCallerId = null;
          nextCallStatus = 'pending';
        } else {
          nextRequestedCallerId = null;
          nextAssignedCallerId = null;
          nextCallerRequestId = null;
          nextCallStatus = 'unassigned';
        }
      }

      const metadataChanged = titleProvided || startProvided || profileProvided || noteProvided;
      if (!callerChanged && metadataChanged && nextCallerRequestId && nextRequestedCallerId) {
        const requestDetail = buildCalendarManualRequestDetail({
          eventId,
          title: nextTitle,
          profileId: nextProfile?.id || null,
          profileName: nextProfile?.name || null,
          note: nextNote
        });
        await client.query(
          `UPDATE requests
           SET detail = $2::jsonb,
               when_at = $3,
               updated_at = now()
           WHERE id = $1
             AND status = 'pending'`,
          [nextCallerRequestId, JSON.stringify(requestDetail), range.start]
        );
      }

      await client.query(
        `UPDATE manual_calendar_events
         SET title = $2,
             start_at = $3,
             end_at = $4,
             profile_id = $5,
             requested_caller_user_id = $6,
             assigned_caller_user_id = $7,
             caller_request_id = $8,
             call_status = $9,
             note = $10,
             updated_at = now()
         WHERE id = $1`,
        [
          eventId,
          nextTitle,
          range.start,
          range.end,
          nextProfile?.id || null,
          nextRequestedCallerId,
          nextAssignedCallerId,
          nextCallerRequestId,
          nextCallStatus,
          nextNote
        ]
      );

      await client.query('COMMIT');
      const updated = await fetchManualEventById(eventId, req, allowAll);
      if (!updated) return res.status(404).json({ error: 'not_found' });
      return res.json(serializeManualEvent(updated));
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

router.post(
  '/events/manual/:eventId/request-decision',
  authRequired,
  fetchCurrentUser,
  requireScopeAccess,
  async (req, res, next) => {
    if (!canApproveCallerRequest(req)) {
      return res.status(403).json({ error: 'manager_required' });
    }

    const decisionRaw = parseNonEmptyText(req.body?.decision);
    if (decisionRaw !== 'accept' && decisionRaw !== 'reject') {
      return res.status(400).json({ error: 'invalid_decision' });
    }

    const eventId = req.params.eventId;
    const requestStatus = decisionRaw === 'accept' ? 'working' : 'closed';
    const nextCallStatus: ManualCallStatus = decisionRaw === 'accept' ? 'assigned' : 'rejected';

    const client = await getClient();
    try {
      await client.query('BEGIN');
      const eventResult = await client.query<{
        id: string;
        owner_user_id: string;
        caller_request_id: string | null;
        requested_caller_user_id: string | null;
      }>(
        `SELECT id, owner_user_id, caller_request_id, requested_caller_user_id
         FROM manual_calendar_events
         WHERE id = $1
         LIMIT 1`,
        [eventId]
      );
      if (!eventResult.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'not_found' });
      }

      const targetEvent = eventResult.rows[0];
      if (!targetEvent.caller_request_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'request_not_found' });
      }

      const requestResult = await client.query<{ assignee_user_id: string | null }>(
        `UPDATE requests
         SET status = $2,
             archived = true,
             updated_at = now()
         WHERE id = $1
           AND role = 'caller'
         RETURNING assignee_user_id`,
        [targetEvent.caller_request_id, requestStatus]
      );
      if (!requestResult.rows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'request_not_found' });
      }

      const resolvedCallerUserId =
        requestResult.rows[0]?.assignee_user_id || targetEvent.requested_caller_user_id || null;

      await client.query(
        `UPDATE manual_calendar_events
         SET call_status = $2,
             assigned_caller_user_id = $3,
             updated_at = now()
         WHERE id = $1`,
        [eventId, nextCallStatus, decisionRaw === 'accept' ? resolvedCallerUserId : null]
      );

      await client.query('COMMIT');
      const updated = await fetchManualEventById(eventId, req, true);
      if (!updated) return res.status(404).json({ error: 'not_found' });
      return res.json(serializeManualEvent(updated));
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
      next(err);
    } finally {
      client.release();
    }
  }
);

router.post('/events/:eventId/assign', authRequired, fetchCurrentUser, requireScopeAccess, async (req, res, next) => {
  const { allowAll } = getScopeContext(req);
  if (!allowAll) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const eventId = req.params.eventId;
  const assigneeRaw = req.body?.assignee_user_id;
  const assigneeId = assigneeRaw ? String(assigneeRaw) : null;
  let callerRatePerMinute = getRoleBaseRate('caller');

  const client = await getClient();
  try {
    await client.query('BEGIN');

    if (assigneeId) {
      const { rows } = await client.query(
        `SELECT ub.rate
         FROM user_badges ub
         WHERE COALESCE(ub.user_id, ub.id) = $1
            AND COALESCE(ub.badge_key, ub.talent_role) = 'caller'
         LIMIT 1`,
        [assigneeId]
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'assignee_not_caller' });
      }
      callerRatePerMinute = normalizeRateForRole('caller', rows[0].rate);
    }

    const { rows: eventRows } = await client.query(
      `SELECT ce.start_at,
              ce.end_at,
              ce.profile_id,
              p.user_id AS owner_id
       FROM calendar_events ce
       LEFT JOIN profiles p ON p.id = ce.profile_id
       WHERE ce.id = $1
       LIMIT 1`,
      [eventId]
    );
    if (!eventRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found' });
    }

    const event = eventRows[0];
    if (assigneeId) {
      if (!event.profile_id || !event.owner_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'missing_profile_owner' });
      }
      const startAt = event.start_at ? new Date(event.start_at) : null;
      const endAt = event.end_at ? new Date(event.end_at) : null;
      if (!startAt || !endAt || Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'invalid_event_duration' });
      }
      const durationMinutes = Math.max(0, (endAt.getTime() - startAt.getTime()) / 60000);
      const cost = Math.round(durationMinutes * callerRatePerMinute * 100) / 100;
      if (cost > 0) {
        const { rows: chargeRows } = await client.query(
          `UPDATE users
           SET balance = balance - $1
           WHERE id = $2 AND balance >= $1
           RETURNING balance`,
          [cost, event.owner_id]
        );
        if (!chargeRows.length) {
          await client.query('ROLLBACK');
          const { rows: balanceRows } = await query(
            `SELECT balance FROM users WHERE id = $1`,
            [event.owner_id]
          );
          const balance = balanceRows[0]?.balance ?? 0;
          return res.status(402).json({
            error: 'insufficient_balance',
            message: 'Insufficient balance to assign caller.',
            balance,
            required: cost
          });
        }
      }
    }

    const { rows } = await client.query(
      `UPDATE calendar_events
       SET assigned_user_id = $2
       WHERE id = $1
       RETURNING id, email_account_id, title, start_at, end_at, assigned_user_id`,
      [eventId, assigneeId]
    );
    await client.query('COMMIT');
    return res.json(rows[0]);
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    next(err);
  } finally {
    client.release();
  }
});

router.post('/sync', authRequired, fetchCurrentUser, requireScopeAccess, async (req, res, next) => {
  const accountId =
    typeof req.body?.account_id === 'string'
      ? req.body.account_id
      : typeof req.query?.account_id === 'string'
        ? req.query.account_id
        : null;
  if (!accountId) {
    return res.status(400).json({ error: 'missing_account_id' });
  }
  const limit = parseLimit(req.body?.limit ?? req.query?.limit);
  const start = parseDate(req.body?.start ?? req.query?.start) ?? new Date(Date.now() - 7 * 864e5);
  const end = parseDate(req.body?.end ?? req.query?.end) ?? new Date(Date.now() + 60 * 864e5);
  const { allowAll } = getScopeContext(req);

  try {
    const { rows } = await query(
      `SELECT ea.id,
              ea.provider,
              ea.access_token,
              ea.refresh_token,
              ea.token_expires_at,
              p.id AS profile_id,
              p.assigned_bidder_user_id
       FROM profiles p
       JOIN email_accounts ea ON ea.id = p.email_account_id
       WHERE ${allowAll ? 'p.deleted_at IS NULL' : '(p.user_id = $1 OR p.assigned_bidder_user_id = $1) AND p.deleted_at IS NULL'}
         AND ea.id = ${allowAll ? '$1' : '$2'}
       LIMIT 1`,
      allowAll ? [accountId] : [req.currentUser.id, accountId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'account_not_found' });
    }

    const account = rows[0];
    if (account.provider !== 'outlook') {
      return res.status(400).json({ error: 'unsupported_provider' });
    }

    let accessToken: string | null = account.access_token;
    let refreshToken: string | null = account.refresh_token;
    let tokenExpiresAt: string | Date | null = account.token_expires_at;

    const refreshTokens = async (): Promise<boolean> => {
      if (!refreshToken) return false;
      const tokenResponse = await fetch(
        `https://login.microsoftonline.com/${config.outlook.tenantId}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: buildRefreshRequest(refreshToken)
        }
      );
      const tokenData = await fetchJson(tokenResponse);
      if (!tokenResponse.ok) {
        return false;
      }
      const nextAccessToken = tokenData.access_token;
      if (!nextAccessToken) {
        return false;
      }
      const nextRefreshToken = tokenData.refresh_token || refreshToken;
      const expiresIn = Number(tokenData.expires_in || 0);
      const nextExpiresAt = Number.isFinite(expiresIn) && expiresIn > 0
        ? new Date(Date.now() + expiresIn * 1000)
        : null;
      await query(
        `UPDATE email_accounts
         SET access_token = $1,
             refresh_token = $2,
             token_expires_at = $3,
             status = 'active'
         WHERE id = $4`,
        [nextAccessToken, nextRefreshToken, nextExpiresAt, accountId]
      );
      accessToken = nextAccessToken;
      refreshToken = nextRefreshToken;
      tokenExpiresAt = nextExpiresAt;
      return true;
    };

    if (!accessToken || isTokenExpiring(tokenExpiresAt)) {
      const refreshed = await refreshTokens();
      if (!refreshed) {
        await query(`UPDATE email_accounts SET status = 'error' WHERE id = $1`, [accountId]);
        return res.status(401).json({ error: 'token_refresh_failed' });
      }
    }

    let fetchResult = await fetchOutlookEvents(accessToken as string, start, end, limit);
    if (!fetchResult.response.ok && fetchResult.response.status === 401 && refreshToken) {
      const refreshed = await refreshTokens();
      if (refreshed) {
        fetchResult = await fetchOutlookEvents(accessToken as string, start, end, limit);
      }
    }

    if (!fetchResult.response.ok) {
      await query(`UPDATE email_accounts SET status = 'error' WHERE id = $1`, [accountId]);
      const message =
        fetchResult.data?.error?.message ||
        fetchResult.data?.error_description ||
        'Failed to fetch calendar events.';
      return res.status(fetchResult.response.status).json({ error: 'sync_failed', message });
    }

    const events = Array.isArray(fetchResult.data?.value) ? fetchResult.data.value : [];
    const now = new Date();
    let upserted = 0;

    if (events.length > 0) {
      const values: string[] = [];
      const params: Array<string | Date | null> = [];

      events.forEach((event: any, index: number) => {
        const offset = index * 8;
        values.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`
        );
        params.push(
          accountId,
          account.profile_id,
          account.assigned_bidder_user_id ?? null,
          event.id,
          event.subject ?? null,
          event.start?.dateTime ? new Date(event.start.dateTime) : null,
          event.end?.dateTime ? new Date(event.end.dateTime) : null,
          now
        );
      });

      const result = await query(
        `INSERT INTO calendar_events
         (email_account_id, profile_id, assigned_user_id, external_event_id, title, start_at, end_at, synced_at)
         VALUES ${values.join(', ')}
         ON CONFLICT (external_event_id)
         DO UPDATE SET
           title = EXCLUDED.title,
           start_at = EXCLUDED.start_at,
           end_at = EXCLUDED.end_at,
           synced_at = EXCLUDED.synced_at,
           profile_id = EXCLUDED.profile_id,
           assigned_user_id = EXCLUDED.assigned_user_id
         WHERE calendar_events.email_account_id = EXCLUDED.email_account_id
         RETURNING id`,
        params
      );
      upserted = result.rowCount;
    }

    await query(`UPDATE email_accounts SET status = 'active' WHERE id = $1`, [accountId]);
    return res.json({ fetched: events.length, upserted });
  } catch (err) {
    next(err);
  }
});

export default router;
