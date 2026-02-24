import express from 'express';
import { config } from '../config.js';
import { getClient, query } from '../db.js';
import { authRequired, fetchCurrentUser } from '../middleware/auth.js';

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
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

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
  const assignedOnlyRaw = req.query?.assigned_only;
  const assignedOnly =
    !allowAll &&
    (assignedOnlyRaw === '1' ||
      assignedOnlyRaw === 'true' ||
      assignedOnlyRaw === 'yes');

  if (!accountId && !assignedOnly) {
    return res.status(400).json({ error: 'missing_account_id' });
  }
  const limit = parseLimit(req.query?.limit);
  const start = parseDate(req.query?.start);
  const end = parseDate(req.query?.end);

  const filters: string[] = ['p.deleted_at IS NULL'];
  const params: Array<string | number | Date> = [];
  if (allowAll) {
    if (!accountId) {
      return res.status(400).json({ error: 'missing_account_id' });
    }
    params.push(accountId);
    filters.push('ce.email_account_id = $1');
  } else {
    params.push(req.currentUser.id);
    if (assignedOnly) {
      filters.push('ce.assigned_user_id = $1');
    } else {
      filters.push('(p.user_id = $1 OR ce.assigned_user_id = $1)');
      params.push(accountId as string);
      filters.push('ce.email_account_id = $2');
    }
  }
  let idx = params.length;

  if (start) {
    idx += 1;
    filters.push(`ce.start_at >= $${idx}`);
    params.push(start);
  }
  if (end) {
    idx += 1;
    filters.push(`ce.end_at <= $${idx}`);
    params.push(end);
  }

  try {
    const { rows } = await query(
      `SELECT ce.id,
              ce.email_account_id,
              ce.title,
              ce.start_at,
              ce.end_at,
              ce.assigned_user_id
       FROM calendar_events ce
       JOIN profiles p ON p.email_account_id = ce.email_account_id
       WHERE ${filters.join(' AND ')}
       ORDER BY ce.start_at ASC NULLS LAST
       LIMIT $${idx + 1}`,
      [...params, limit]
    );
    return res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/events/:eventId/assign', authRequired, fetchCurrentUser, requireScopeAccess, async (req, res, next) => {
  const { allowAll } = getScopeContext(req);
  if (!allowAll) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const eventId = req.params.eventId;
  const assigneeRaw = req.body?.assignee_user_id;
  const assigneeId = assigneeRaw ? String(assigneeRaw) : null;

  const client = await getClient();
  try {
    await client.query('BEGIN');

    if (assigneeId) {
      const { rows } = await client.query(
        `SELECT 1
         FROM talents t
         WHERE COALESCE(t.user_id, t.id) = $1
           AND t.talent_role = 'caller'
         LIMIT 1`,
        [assigneeId]
      );
      if (!rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'assignee_not_caller' });
      }
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
      const cost = Math.round(durationMinutes * 100) / 100;
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
