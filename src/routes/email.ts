import express from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { getClient, query } from '../db.js';
import { authRequired, fetchCurrentUser } from '../middleware/auth.js';
import { canAccessManagerScope, isAdmin } from '../lib/accessControl.js';

const router = express.Router();
type RouteScope = 'user' | 'manager' | 'admin';
type OutlookConnectState = {
  purpose?: string;
  profile_id?: string;
  user_id?: string;
  frontend_origin?: string | null;
  connect_trace_id?: string;
};
type DbFingerprint = {
  database: string;
  serverAddress: string;
  serverPort: string;
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

function parseLimit(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 50;
  return Math.min(Math.floor(num), 200);
}

const logOutlookCallback = (
  event: string,
  traceId: string,
  payload: Record<string, unknown>
): void => {
  console.info(
    `[outlook-connect][callback][${event}] ${JSON.stringify({
      trace_id: traceId,
      ...payload
    })}`
  );
};

let dbFingerprint: DbFingerprint | null = null;
let dbFingerprintPromise: Promise<DbFingerprint | null> | null = null;
let dbFingerprintLogged = false;

const fetchDbFingerprint = async (): Promise<DbFingerprint | null> => {
  if (dbFingerprint) return dbFingerprint;
  if (dbFingerprintPromise) return dbFingerprintPromise;

  dbFingerprintPromise = (async () => {
    try {
      const { rows } = await query<{
        db_name: string | null;
        server_addr: string | null;
        server_port: number | null;
      }>(
        `SELECT current_database()::text AS db_name,
                COALESCE(inet_server_addr()::text, 'local') AS server_addr,
                inet_server_port() AS server_port`
      );
      const row = rows[0];
      if (!row) return null;
      dbFingerprint = {
        database: row.db_name || 'unknown',
        serverAddress: row.server_addr || 'unknown',
        serverPort: row.server_port == null ? 'unknown' : String(row.server_port)
      };
      return dbFingerprint;
    } catch (err) {
      console.warn(
        `[outlook-connect][callback][db_fingerprint_failed] ${JSON.stringify({
          error: err instanceof Error ? err.message : String(err)
        })}`
      );
      return null;
    } finally {
      dbFingerprintPromise = null;
    }
  })();

  return dbFingerprintPromise;
};

const ensureDbFingerprintLogged = async (traceId: string): Promise<DbFingerprint | null> => {
  const fingerprint = await fetchDbFingerprint();
  if (!fingerprint) return null;
  if (!dbFingerprintLogged) {
    logOutlookCallback('db_fingerprint', traceId, {
      database: fingerprint.database,
      server_address: fingerprint.serverAddress,
      server_port: fingerprint.serverPort
    });
    dbFingerprintLogged = true;
  }
  return fingerprint;
};

const getFrontendOrigin = (): string => {
  const origin = toOrigin(config.frontendUrl);
  return origin || '*';
};

const toOrigin = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new URL(value).origin;
  } catch (err) {
    return null;
  }
};

const isAllowedFrontendOrigin = (origin: string): boolean => {
  if (origin === '*') return true;
  if (config.cors.allowAll) return true;
  if (origin === getFrontendOrigin()) return true;
  return config.cors.origins.includes(origin);
};

const resolveFrontendOrigin = (input?: string | null): string => {
  const requested = toOrigin(input);
  if (requested && isAllowedFrontendOrigin(requested)) {
    return requested;
  }
  return getFrontendOrigin();
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

type CallbackPageInput = {
  status: 'success' | 'error';
  profileId?: string | null;
  emailAccountId?: string | null;
  traceId?: string | null;
  message?: string | null;
  frontendOrigin?: string | null;
};

const renderCallbackPage = ({
  status,
  profileId,
  emailAccountId,
  traceId,
  message,
  frontendOrigin
}: CallbackPageInput): string => {
  const targetOrigin = resolveFrontendOrigin(frontendOrigin);
  const payload = {
    type: status === 'success' ? 'email_connected' : 'email_connect_error',
    profileId: profileId || null,
    emailAccountId: emailAccountId || null,
    traceId: traceId || null,
    message: message || null
  };
  const safePayload = JSON.stringify(payload);
  const safeOrigin = JSON.stringify(targetOrigin);
  const safeMessage = escapeHtml(
    message || (status === 'success' ? 'Email connected.' : 'Email connection failed.')
  );

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Email Connection</title>
    <style>
      body { font-family: Arial, sans-serif; background: #f8fafc; color: #0f172a; }
      .card { max-width: 420px; margin: 12vh auto; background: #fff; border-radius: 12px; border: 1px solid #e2e8f0; padding: 24px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); }
      h1 { font-size: 20px; margin: 0 0 8px; }
      p { margin: 0; font-size: 14px; color: #475569; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${status === 'success' ? 'Connected' : 'Connection issue'}</h1>
      <p>${safeMessage}</p>
      <p style="margin-top: 12px;">You can close this window.</p>
    </div>
    <script>
      (function() {
        const payload = ${safePayload};
        const origin = ${safeOrigin};
        if (window.opener && window.opener !== window) {
          try {
            window.opener.postMessage(payload, origin);
          } catch (err) {}
          if (origin !== "*") {
            try {
              window.opener.postMessage(payload, "*");
            } catch (err) {}
          }
          window.close();
        }
      })();
    </script>
  </body>
</html>`;
};

const fetchJson = async (response: Response): Promise<Record<string, any>> => {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    return { error: 'invalid_json', error_description: text };
  }
};

router.get('/accounts', authRequired, fetchCurrentUser, requireScopeAccess, async (req, res, next) => {
  try {
    const { allowAll } = getScopeContext(req);
    const filters = allowAll
      ? ['p.deleted_at IS NULL']
      : ['(p.user_id = $1 OR p.assigned_bidder_user_id = $1)', 'p.deleted_at IS NULL'];
    const params: Array<string> = allowAll ? [] : [req.currentUser.id];
    const { rows } = await query(
      `SELECT p.id AS profile_id,
              p.name AS profile_name,
              p.email_account_id,
              ea.email_address,
              ea.status,
              COUNT(e.id) FILTER (WHERE e.is_unread) AS unread_count
       FROM profiles p
       JOIN email_accounts ea ON ea.id = p.email_account_id
       LEFT JOIN emails e ON e.email_account_id = p.email_account_id
       WHERE ${filters.join(' AND ')}
       GROUP BY p.id, ea.id
       ORDER BY p.created_at DESC`,
      params
    );
    return res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/messages', authRequired, fetchCurrentUser, requireScopeAccess, async (req, res, next) => {
  const accountId = typeof req.query?.account_id === 'string' ? req.query.account_id : null;
  if (!accountId) {
    return res.status(400).json({ error: 'missing_account_id' });
  }
  const limit = parseLimit(req.query?.limit);

  try {
    const { allowAll } = getScopeContext(req);
    const filters = allowAll
      ? ['p.deleted_at IS NULL', 'e.email_account_id = $1']
      : ['(p.user_id = $1 OR p.assigned_bidder_user_id = $1)', 'p.deleted_at IS NULL', 'e.email_account_id = $2'];
    const params: Array<string | number> = allowAll
      ? [accountId, limit]
      : [req.currentUser.id, accountId, limit];
    const { rows } = await query(
      `SELECT e.id,
              e.email_account_id,
              e.subject,
              e.from_email,
              e.snippet,
              e.received_at,
              e.is_unread
       FROM emails e
       JOIN profiles p ON p.email_account_id = e.email_account_id
       WHERE ${filters.join(' AND ')}
       ORDER BY e.received_at DESC NULLS LAST, e.created_at DESC
       LIMIT $${allowAll ? 2 : 3}`,
      params
    );
    return res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/messages/:emailId', authRequired, fetchCurrentUser, requireScopeAccess, async (req, res, next) => {
  const emailId = typeof req.params?.emailId === 'string' ? req.params.emailId : null;
  if (!emailId) {
    return res.status(400).json({ error: 'missing_email_id' });
  }

  try {
    const { allowAll } = getScopeContext(req);
    const { rows } = await query(
      `SELECT e.id,
              e.email_account_id,
              e.external_message_id,
              e.subject,
              e.from_email,
              e.snippet,
              e.received_at,
              e.is_unread,
              ea.provider,
              ea.access_token,
              ea.refresh_token,
              ea.token_expires_at,
              ea.email_address
       FROM emails e
       JOIN email_accounts ea ON ea.id = e.email_account_id
       JOIN profiles p ON p.email_account_id = e.email_account_id
       WHERE e.id = $1
         AND ${allowAll ? '1=1' : '(p.user_id = $2 OR p.assigned_bidder_user_id = $2)'}
         AND p.deleted_at IS NULL
       LIMIT 1`,
      allowAll ? [emailId] : [emailId, req.currentUser.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'email_not_found' });
    }

    const record = rows[0];
    if (record.provider !== 'outlook') {
      return res.status(400).json({ error: 'unsupported_provider' });
    }

    let accessToken: string | null = record.access_token;
    let refreshToken: string | null = record.refresh_token;
    let tokenExpiresAt: string | Date | null = record.token_expires_at;

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
        [nextAccessToken, nextRefreshToken, nextExpiresAt, record.email_account_id]
      );
      accessToken = nextAccessToken;
      refreshToken = nextRefreshToken;
      tokenExpiresAt = nextExpiresAt;
      return true;
    };

    if (!accessToken || isTokenExpiring(tokenExpiresAt)) {
      const refreshed = await refreshTokens();
      if (!refreshed) {
        await query(`UPDATE email_accounts SET status = 'error' WHERE id = $1`, [
          record.email_account_id
        ]);
        return res.status(401).json({ error: 'token_refresh_failed' });
      }
    }

    let fetchResult = await fetchOutlookMessage(accessToken as string, record.external_message_id);
    if (!fetchResult.response.ok && fetchResult.response.status === 401 && refreshToken) {
      const refreshed = await refreshTokens();
      if (refreshed) {
        fetchResult = await fetchOutlookMessage(accessToken as string, record.external_message_id);
      }
    }

    if (!fetchResult.response.ok) {
      await query(`UPDATE email_accounts SET status = 'error' WHERE id = $1`, [
        record.email_account_id
      ]);
      const message =
        fetchResult.data?.error?.message ||
        fetchResult.data?.error_description ||
        'Failed to fetch email.';
      return res.status(fetchResult.response.status).json({ error: 'message_fetch_failed', message });
    }

    const mapRecipients = (recipients: any[]) =>
      Array.isArray(recipients)
        ? recipients
            .map((recipient) => ({
              name: recipient?.emailAddress?.name ?? '',
              email: recipient?.emailAddress?.address ?? ''
            }))
            .filter((recipient) => recipient.email || recipient.name)
        : [];

    return res.json({
      id: record.id,
      accountId: record.email_account_id,
      accountEmail: record.email_address,
      subject: fetchResult.data?.subject ?? record.subject ?? '(No subject)',
      from: fetchResult.data?.from?.emailAddress?.address ?? record.from_email ?? '',
      fromName: fetchResult.data?.from?.emailAddress?.name ?? null,
      to: mapRecipients(fetchResult.data?.toRecipients),
      cc: mapRecipients(fetchResult.data?.ccRecipients),
      receivedAt: fetchResult.data?.receivedDateTime ?? record.received_at ?? null,
      isRead:
        typeof fetchResult.data?.isRead === 'boolean'
          ? fetchResult.data.isRead
          : !record.is_unread,
      snippet: fetchResult.data?.bodyPreview ?? record.snippet ?? '',
      body: fetchResult.data?.body?.content ?? null,
      bodyType: fetchResult.data?.body?.contentType ?? null
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/messages/:emailId/read', authRequired, fetchCurrentUser, requireScopeAccess, async (req, res, next) => {
  const emailId = typeof req.params?.emailId === 'string' ? req.params.emailId : null;
  if (!emailId) {
    return res.status(400).json({ error: 'missing_email_id' });
  }

  try {
    const { allowAll } = getScopeContext(req);
    const { rows } = await query(
      `SELECT e.id,
              e.email_account_id,
              e.external_message_id,
              e.is_unread,
              ea.provider,
              ea.access_token,
              ea.refresh_token,
              ea.token_expires_at
       FROM emails e
       JOIN email_accounts ea ON ea.id = e.email_account_id
       JOIN profiles p ON p.email_account_id = e.email_account_id
       WHERE e.id = $1
         AND ${allowAll ? '1=1' : '(p.user_id = $2 OR p.assigned_bidder_user_id = $2)'}
         AND p.deleted_at IS NULL
       LIMIT 1`,
      allowAll ? [emailId] : [emailId, req.currentUser.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'email_not_found' });
    }

    const record = rows[0];
    if (!record.is_unread) {
      return res.json({ ok: true, updated: false });
    }

    if (record.provider === 'outlook') {
      let accessToken: string | null = record.access_token;
      let refreshToken: string | null = record.refresh_token;
      let tokenExpiresAt: string | Date | null = record.token_expires_at;

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
          [nextAccessToken, nextRefreshToken, nextExpiresAt, record.email_account_id]
        );
        accessToken = nextAccessToken;
        refreshToken = nextRefreshToken;
        tokenExpiresAt = nextExpiresAt;
        return true;
      };

      if (!accessToken || isTokenExpiring(tokenExpiresAt)) {
        const refreshed = await refreshTokens();
        if (!refreshed) {
          await query(`UPDATE email_accounts SET status = 'error' WHERE id = $1`, [
            record.email_account_id
          ]);
        }
      }

      if (accessToken) {
        let updateResult = await updateOutlookMessageRead(
          accessToken as string,
          record.external_message_id
        );
        if (!updateResult.response.ok && updateResult.response.status === 401 && refreshToken) {
          const refreshed = await refreshTokens();
          if (refreshed) {
            updateResult = await updateOutlookMessageRead(
              accessToken as string,
              record.external_message_id
            );
          }
        }

        if (!updateResult.response.ok) {
          await query(`UPDATE email_accounts SET status = 'error' WHERE id = $1`, [
            record.email_account_id
          ]);
        }
      }
    }

    await query(`UPDATE emails SET is_unread = false WHERE id = $1`, [record.id]);
    return res.json({ ok: true, updated: true });
  } catch (err) {
    next(err);
  }
});

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

const fetchOutlookMessages = async (accessToken: string, limit: number) => {
  const url = new URL('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages');
  url.searchParams.set('$select', 'id,subject,from,bodyPreview,receivedDateTime,isRead');
  url.searchParams.set('$top', String(limit));
  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  const data = await fetchJson(response);
  return { response, data };
};

const fetchOutlookMessage = async (accessToken: string, messageId: string) => {
  const url = new URL(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set(
    '$select',
    'id,subject,from,toRecipients,ccRecipients,body,bodyPreview,receivedDateTime,isRead'
  );
  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  const data = await fetchJson(response);
  return { response, data };
};

const updateOutlookMessageRead = async (accessToken: string, messageId: string) => {
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ isRead: true })
    }
  );
  const data = await fetchJson(response);
  return { response, data };
};

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

  try {
    const { allowAll } = getScopeContext(req);
    const { rows } = await query(
      `SELECT ea.id,
              ea.provider,
              ea.access_token,
              ea.refresh_token,
              ea.token_expires_at,
              p.id AS profile_id
       FROM profiles p
       JOIN email_accounts ea ON ea.id = p.email_account_id
       WHERE ${allowAll ? 'p.deleted_at IS NULL AND ea.id = $1' : '(p.user_id = $1 OR p.assigned_bidder_user_id = $1) AND p.deleted_at IS NULL AND ea.id = $2'}
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

    let fetchResult = await fetchOutlookMessages(accessToken as string, limit);
    if (!fetchResult.response.ok && fetchResult.response.status === 401 && refreshToken) {
      const refreshed = await refreshTokens();
      if (refreshed) {
        fetchResult = await fetchOutlookMessages(accessToken as string, limit);
      }
    }

    if (!fetchResult.response.ok) {
      await query(`UPDATE email_accounts SET status = 'error' WHERE id = $1`, [accountId]);
      const message =
        fetchResult.data?.error?.message ||
        fetchResult.data?.error_description ||
        'Failed to fetch emails.';
      return res.status(fetchResult.response.status).json({ error: 'sync_failed', message });
    }

    const messages = Array.isArray(fetchResult.data?.value) ? fetchResult.data.value : [];
    const now = new Date();
    let upserted = 0;

    if (messages.length > 0) {
      const values: string[] = [];
      const params: Array<string | boolean | Date | null> = [];

      messages.forEach((message: any, index: number) => {
        const offset = index * 9;
        values.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9})`
        );
        params.push(
          accountId,
          account.profile_id,
          message.id,
          message.subject ?? null,
          message.from?.emailAddress?.address ?? null,
          message.bodyPreview ?? null,
          message.receivedDateTime ? new Date(message.receivedDateTime) : null,
          !message.isRead,
          now
        );
      });

      const result = await query(
        `INSERT INTO emails
         (email_account_id, profile_id, external_message_id, subject, from_email, snippet, received_at, is_unread, synced_at)
         VALUES ${values.join(', ')}
         ON CONFLICT (external_message_id)
         DO UPDATE SET
           subject = EXCLUDED.subject,
           from_email = EXCLUDED.from_email,
           snippet = EXCLUDED.snippet,
           received_at = EXCLUDED.received_at,
           is_unread = EXCLUDED.is_unread,
           synced_at = EXCLUDED.synced_at,
           profile_id = EXCLUDED.profile_id
         WHERE emails.email_account_id = EXCLUDED.email_account_id
         RETURNING id`,
        params
      );
      upserted = result.rowCount;
    }

    await query(`UPDATE email_accounts SET status = 'active' WHERE id = $1`, [accountId]);
    return res.json({ fetched: messages.length, upserted });
  } catch (err) {
    next(err);
  }
});

const buildTokenRequest = (code: string): string => {
  const params = new URLSearchParams({
    client_id: config.outlook.clientId,
    client_secret: config.outlook.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.outlook.redirectUri
  });
  return params.toString();
};

router.get('/outlook/callback', async (req, res, next) => {
  const code = typeof req.query?.code === 'string' ? req.query.code : undefined;
  const state = typeof req.query?.state === 'string' ? req.query.state : undefined;
  const error = typeof req.query?.error === 'string' ? req.query.error : undefined;
  const errorDescription =
    typeof req.query?.error_description === 'string' ? req.query.error_description : undefined;
  let traceId: string = randomUUID();
  let callbackOrigin: string | null = null;

  if (error) {
    const message = errorDescription || error;
    logOutlookCallback('oauth_error', traceId, {
      message,
      has_code: Boolean(code),
      has_state: Boolean(state)
    });
    return res.status(400).send(renderCallbackPage({ status: 'error', message, traceId }));
  }

  if (!code || !state) {
    logOutlookCallback('missing_code_or_state', traceId, {
      has_code: Boolean(code),
      has_state: Boolean(state)
    });
    return res
      .status(400)
      .send(renderCallbackPage({ status: 'error', message: 'Missing code or state.', traceId }));
  }

  if (!config.features.outlookOauthEnabled) {
    logOutlookCallback('outlook_not_configured', traceId, {
      has_client_id: Boolean(config.outlook.clientId),
      has_client_secret: Boolean(config.outlook.clientSecret),
      has_redirect_uri: Boolean(config.outlook.redirectUri)
    });
    return res
      .status(500)
      .send(
        renderCallbackPage({
          status: 'error',
          message: 'Outlook integration not configured.',
          traceId
        })
      );
  }

  let payload: OutlookConnectState;
  try {
    payload = jwt.verify(state, config.jwt.secret) as OutlookConnectState;
  } catch (err) {
    logOutlookCallback('invalid_state_token', traceId, {
      error: err instanceof Error ? err.message : String(err)
    });
    return res
      .status(400)
      .send(renderCallbackPage({ status: 'error', message: 'Invalid state token.', traceId }));
  }

  if (typeof payload?.connect_trace_id === 'string' && payload.connect_trace_id.trim()) {
    traceId = payload.connect_trace_id;
  }
  callbackOrigin = resolveFrontendOrigin(payload?.frontend_origin);
  const dbTarget = await ensureDbFingerprintLogged(traceId);

  logOutlookCallback('callback_start', traceId, {
    profile_id: payload?.profile_id || null,
    user_id: payload?.user_id || null,
    has_code: Boolean(code),
    origin: callbackOrigin,
    db_fingerprint: dbTarget
      ? {
          database: dbTarget.database,
          server_address: dbTarget.serverAddress,
          server_port: dbTarget.serverPort
        }
      : null
  });

  if (payload?.purpose !== 'outlook_connect' || !payload?.profile_id || !payload?.user_id) {
    logOutlookCallback('invalid_state_payload', traceId, {
      purpose: payload?.purpose || null,
      profile_id: payload?.profile_id || null,
      user_id: payload?.user_id || null
    });
    return res
      .status(400)
      .send(
        renderCallbackPage({
          status: 'error',
          message: 'Invalid state payload.',
          frontendOrigin: callbackOrigin,
          traceId
        })
      );
  }

  try {
    const tokenResponse = await fetch(
      `https://login.microsoftonline.com/${config.outlook.tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: buildTokenRequest(code)
      }
    );

    const tokenData = await fetchJson(tokenResponse);
    if (!tokenResponse.ok) {
      const message = tokenData.error_description || tokenData.error || 'Token exchange failed.';
      logOutlookCallback('token_exchange_failed', traceId, {
        profile_id: payload.profile_id,
        user_id: payload.user_id,
        status: tokenResponse.status,
        oauth_error: tokenData.error || null,
        oauth_error_description: tokenData.error_description || null
      });
      return res
        .status(400)
        .send(
          renderCallbackPage({
            status: 'error',
            message,
            frontendOrigin: callbackOrigin,
            traceId
          })
        );
    }

    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || null;
    const scope = tokenData.scope || config.outlook.scopes.join(' ');
    const expiresIn = Number(tokenData.expires_in || 0);
    const tokenExpiresAt = Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000)
      : null;

    logOutlookCallback('token_exchange_succeeded', traceId, {
      profile_id: payload.profile_id,
      user_id: payload.user_id,
      status: tokenResponse.status,
      has_access_token: Boolean(accessToken),
      has_refresh_token: Boolean(refreshToken)
    });

    if (!accessToken) {
      logOutlookCallback('token_missing_access_token', traceId, {
        profile_id: payload.profile_id,
        user_id: payload.user_id
      });
      return res
        .status(400)
        .send(
          renderCallbackPage({
            status: 'error',
            message: 'Missing access token.',
            frontendOrigin: callbackOrigin,
            traceId
          })
        );
    }

    const meResponse = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    const meData = await fetchJson(meResponse);
    if (!meResponse.ok) {
      const message = meData.error?.message || 'Unable to fetch Outlook profile.';
      logOutlookCallback('graph_me_failed', traceId, {
        profile_id: payload.profile_id,
        user_id: payload.user_id,
        status: meResponse.status,
        graph_error: meData.error?.message || null
      });
      return res
        .status(400)
        .send(
          renderCallbackPage({
            status: 'error',
            message,
            frontendOrigin: callbackOrigin,
            traceId
          })
        );
    }

    const emailAddress = meData.mail || meData.userPrincipalName || '';
    logOutlookCallback('graph_me_succeeded', traceId, {
      profile_id: payload.profile_id,
      user_id: payload.user_id,
      status: meResponse.status,
      has_email_address: Boolean(emailAddress)
    });

    const client = await getClient();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id, email_account_id
         FROM profiles
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
         LIMIT 1`,
        [payload.profile_id, payload.user_id]
      );

      if (rows.length === 0) {
        await client.query('ROLLBACK');
        logOutlookCallback('owner_scope_guard_profile_not_found', traceId, {
          profile_id: payload.profile_id,
          user_id: payload.user_id
        });
        return res
          .status(404)
          .send(
            renderCallbackPage({
              status: 'error',
              message: 'Profile not found.',
              frontendOrigin: callbackOrigin,
              traceId
            })
          );
      }

      let emailAccountId = rows[0].email_account_id;
      logOutlookCallback('db_profile_lookup', traceId, {
        profile_id: payload.profile_id,
        user_id: payload.user_id,
        existing_email_account_id: emailAccountId || null
      });

      if (emailAccountId) {
        const updateResult = await client.query(
          `UPDATE email_accounts
           SET provider = 'outlook',
               email_address = $1,
               access_token = $2,
               refresh_token = $3,
               token_expires_at = $4,
               scope = $5,
               status = 'active'
           WHERE id = $6`,
          [emailAddress, accessToken, refreshToken, tokenExpiresAt, scope, emailAccountId]
        );
        logOutlookCallback('db_email_account_updated', traceId, {
          profile_id: payload.profile_id,
          email_account_id: emailAccountId,
          row_count: updateResult.rowCount
        });
      } else {
        const insertResult = await client.query(
          `INSERT INTO email_accounts
           (provider, email_address, access_token, refresh_token, token_expires_at, scope, status)
           VALUES ('outlook', $1, $2, $3, $4, $5, 'active')
           RETURNING id`,
          [emailAddress, accessToken, refreshToken, tokenExpiresAt, scope]
        );
        emailAccountId = insertResult.rows[0]?.id;
        logOutlookCallback('db_email_account_inserted', traceId, {
          profile_id: payload.profile_id,
          email_account_id: emailAccountId || null,
          row_count: insertResult.rowCount
        });
        if (emailAccountId) {
          const linkResult = await client.query(
            `UPDATE profiles
             SET email_account_id = $1
             WHERE id = $2`,
            [emailAccountId, payload.profile_id]
          );
          logOutlookCallback('db_profile_link_updated', traceId, {
            profile_id: payload.profile_id,
            email_account_id: emailAccountId,
            row_count: linkResult.rowCount
          });
        }
      }

      await client.query('COMMIT');
      logOutlookCallback('callback_commit_succeeded', traceId, {
        profile_id: payload.profile_id,
        user_id: payload.user_id,
        email_account_id: emailAccountId || null,
        db_fingerprint: dbTarget
          ? {
              database: dbTarget.database,
              server_address: dbTarget.serverAddress,
              server_port: dbTarget.serverPort
            }
          : null
      });

      return res.send(
        renderCallbackPage({
          status: 'success',
          profileId: payload.profile_id,
          emailAccountId: emailAccountId || null,
          frontendOrigin: callbackOrigin,
          traceId
        })
      );
    } catch (err) {
      await client.query('ROLLBACK');
      logOutlookCallback('db_transaction_failed', traceId, {
        profile_id: payload.profile_id,
        user_id: payload.user_id,
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    logOutlookCallback('callback_failed', traceId, {
      profile_id: payload?.profile_id || null,
      user_id: payload?.user_id || null,
      error: err instanceof Error ? err.message : String(err)
    });
    next(err);
  }
});

export default router;
