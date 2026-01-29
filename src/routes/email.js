import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getClient } from '../db.js';

const router = express.Router();

const getFrontendOrigin = () => {
  try {
    return new URL(config.frontendUrl).origin;
  } catch (err) {
    return '*';
  }
};

const renderCallbackPage = ({ status, profileId, message }) => {
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

const buildTokenRequest = (code) => {
  const params = new URLSearchParams({
    client_id: config.outlook.clientId,
    client_secret: config.outlook.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.outlook.redirectUri
  });
  return params.toString();
};

const fetchJson = async (response) => {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    return { error: 'invalid_json', error_description: text };
  }
};

router.get('/outlook/callback', async (req, res, next) => {
  const { code, state, error, error_description } = req.query || {};

  if (error) {
    const message = error_description || error;
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
