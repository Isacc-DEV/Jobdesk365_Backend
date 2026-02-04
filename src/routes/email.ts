import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getClient, query } from '../db.js';
import { authRequired, fetchCurrentUser } from '../middleware/auth.js';

const router = express.Router();

function parseLimit(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 50;
  return Math.min(Math.floor(num), 200);
}

const getFrontendOrigin = (): string => {
  try {
    return new URL(config.frontendUrl).origin;
  } catch (err) {
    return '*';
  }
};

type CallbackPageInput = {
  status: 'success' | 'error';
  profileId?: string | null;
  message?: string | null;
};

const renderCallbackPage = ({ status, profileId, message }: CallbackPageInput): string => {
  const frontendOrigin = getFrontendOrigin();
  const payload = {
    type: status === 'success' ? 'email_connected' : 'email_connect_error',
    profileId: profileId || null,
    message: message || null
  };
  const safePayload = JSON.stringify(payload);
  const safeOrigin = JSON.stringify(frontendOrigin);
  const safeMessage = message || (status === 'success' ? 'Email connected.' : 'Email connection failed.');

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
          window.opener.postMessage(payload, origin);
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

router.get('/accounts', authRequired, fetchCurrentUser, async (req, res, next) => {
  try {
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
       WHERE (p.user_id = $1 OR p.assigned_bidder_user_id = $1) AND p.deleted_at IS NULL
       GROUP BY p.id, ea.id
       ORDER BY p.created_at DESC`,
      [req.currentUser.id]
    );
    return res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/messages', authRequired, fetchCurrentUser, async (req, res, next) => {
  const accountId = typeof req.query?.account_id === 'string' ? req.query.account_id : null;
  if (!accountId) {
    return res.status(400).json({ error: 'missing_account_id' });
  }
  const limit = parseLimit(req.query?.limit);

  try {
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
       WHERE (p.user_id = $1 OR p.assigned_bidder_user_id = $1)
         AND p.deleted_at IS NULL
         AND e.email_account_id = $2
       ORDER BY e.received_at DESC NULLS LAST, e.created_at DESC
       LIMIT $3`,
      [req.currentUser.id, accountId, limit]
    );
    return res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/messages/:emailId', authRequired, fetchCurrentUser, async (req, res, next) => {
  const emailId = typeof req.params?.emailId === 'string' ? req.params.emailId : null;
  if (!emailId) {
    return res.status(400).json({ error: 'missing_email_id' });
  }

  try {
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
         AND (p.user_id = $2 OR p.assigned_bidder_user_id = $2)
         AND p.deleted_at IS NULL
       LIMIT 1`,
      [emailId, req.currentUser.id]
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

router.patch('/messages/:emailId/read', authRequired, fetchCurrentUser, async (req, res, next) => {
  const emailId = typeof req.params?.emailId === 'string' ? req.params.emailId : null;
  if (!emailId) {
    return res.status(400).json({ error: 'missing_email_id' });
  }

  try {
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
         AND (p.user_id = $2 OR p.assigned_bidder_user_id = $2)
         AND p.deleted_at IS NULL
       LIMIT 1`,
      [emailId, req.currentUser.id]
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
       WHERE (p.user_id = $1 OR p.assigned_bidder_user_id = $1) AND p.deleted_at IS NULL AND ea.id = $2
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

  if (error) {
    const message = errorDescription || error;
    return res.status(400).send(renderCallbackPage({ status: 'error', message }));
  }

  if (!code || !state) {
    return res
      .status(400)
      .send(renderCallbackPage({ status: 'error', message: 'Missing code or state.' }));
  }

  if (!config.outlook.clientId || !config.outlook.clientSecret || !config.outlook.redirectUri) {
    return res
      .status(500)
      .send(renderCallbackPage({ status: 'error', message: 'Outlook integration not configured.' }));
  }

  let payload;
  try {
    payload = jwt.verify(state, config.jwt.secret);
  } catch (err) {
    return res
      .status(400)
      .send(renderCallbackPage({ status: 'error', message: 'Invalid state token.' }));
  }

  if (payload?.purpose !== 'outlook_connect' || !payload?.profile_id || !payload?.user_id) {
    return res
      .status(400)
      .send(renderCallbackPage({ status: 'error', message: 'Invalid state payload.' }));
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
      return res.status(400).send(renderCallbackPage({ status: 'error', message }));
    }

    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || null;
    const scope = tokenData.scope || config.outlook.scopes.join(' ');
    const expiresIn = Number(tokenData.expires_in || 0);
    const tokenExpiresAt = Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000)
      : null;

    if (!accessToken) {
      return res
        .status(400)
        .send(renderCallbackPage({ status: 'error', message: 'Missing access token.' }));
    }

    const meResponse = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    const meData = await fetchJson(meResponse);
    if (!meResponse.ok) {
      const message = meData.error?.message || 'Unable to fetch Outlook profile.';
      return res.status(400).send(renderCallbackPage({ status: 'error', message }));
    }

    const emailAddress = meData.mail || meData.userPrincipalName || '';

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
        return res
          .status(404)
          .send(renderCallbackPage({ status: 'error', message: 'Profile not found.' }));
      }

      let emailAccountId = rows[0].email_account_id;

      if (emailAccountId) {
        await client.query(
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
      } else {
        const insertResult = await client.query(
          `INSERT INTO email_accounts
           (provider, email_address, access_token, refresh_token, token_expires_at, scope, status)
           VALUES ('outlook', $1, $2, $3, $4, $5, 'active')
           RETURNING id`,
          [emailAddress, accessToken, refreshToken, tokenExpiresAt, scope]
        );
        emailAccountId = insertResult.rows[0]?.id;
        if (emailAccountId) {
          await client.query(
            `UPDATE profiles
             SET email_account_id = $1
             WHERE id = $2`,
            [emailAccountId, payload.profile_id]
          );
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return res.send(
      renderCallbackPage({ status: 'success', profileId: payload.profile_id })
    );
  } catch (err) {
    next(err);
  }
});

export default router;
