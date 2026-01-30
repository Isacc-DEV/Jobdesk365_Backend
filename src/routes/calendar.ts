import express from 'express';
import { config } from '../config.js';
import { query } from '../db.js';
import { authRequired, fetchCurrentUser } from '../middleware/auth.js';

const router = express.Router();

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

router.get('/accounts', authRequired, fetchCurrentUser, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT p.id AS profile_id,
              p.name AS profile_name,
              p.email_account_id,
              ea.email_address,
              ea.status,
              COUNT(ce.id) AS event_count
       FROM profiles p
       JOIN email_accounts ea ON ea.id = p.email_account_id
       LEFT JOIN calendar_events ce ON ce.email_account_id = p.email_account_id
       WHERE p.user_id = $1 AND p.deleted_at IS NULL
       GROUP BY p.id, ea.id
       ORDER BY p.created_at DESC`,
      [req.currentUser.id]
    );
    return res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/events', authRequired, fetchCurrentUser, async (req, res, next) => {
  const accountId = typeof req.query?.account_id === 'string' ? req.query.account_id : null;
  if (!accountId) {
    return res.status(400).json({ error: 'missing_account_id' });
  }
  const limit = parseLimit(req.query?.limit);
  const start = parseDate(req.query?.start);
  const end = parseDate(req.query?.end);

  const filters = [
    'p.user_id = $1',
    'p.deleted_at IS NULL',
    'ce.email_account_id = $2'
  ];
  const params: Array<string | number | Date> = [req.currentUser.id, accountId];
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
              ce.end_at
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

router.post('/sync', authRequired, fetchCurrentUser, async (req, res, next) => {
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

  try {
    const { rows } = await query(
      `SELECT ea.id,
              ea.provider,
              ea.access_token,
              ea.refresh_token,
              ea.token_expires_at,
              p.id AS profile_id
       FROM profiles p
       JOIN email_accounts ea ON ea.id = p.email_account_id
       WHERE p.user_id = $1 AND p.deleted_at IS NULL AND ea.id = $2
       LIMIT 1`,
      [req.currentUser.id, accountId]
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
        const offset = index * 7;
        values.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`
        );
        params.push(
          accountId,
          account.profile_id,
          event.id,
          event.subject ?? null,
          event.start?.dateTime ? new Date(event.start.dateTime) : null,
          event.end?.dateTime ? new Date(event.end.dateTime) : null,
          now
        );
      });

      const result = await query(
        `INSERT INTO calendar_events
         (email_account_id, profile_id, external_event_id, title, start_at, end_at, synced_at)
         VALUES ${values.join(', ')}
         ON CONFLICT (external_event_id)
         DO UPDATE SET
           title = EXCLUDED.title,
           start_at = EXCLUDED.start_at,
           end_at = EXCLUDED.end_at,
           synced_at = EXCLUDED.synced_at,
           profile_id = EXCLUDED.profile_id
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
