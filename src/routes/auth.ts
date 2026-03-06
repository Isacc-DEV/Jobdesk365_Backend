import express from 'express';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { query } from '../db.js';
import { hashPassword, comparePassword } from '../utils/password.js';
import { INTERNAL_WORKER_BLOCK_MESSAGE, authRequired, fetchCurrentUser } from '../middleware/auth.js';
import { requireSupabaseAdminClient, requireSupabaseOtpClient } from '../services/supabaseAuth.js';

const router = express.Router();
const USERNAME_RE = /^[a-z0-9]+$/;
const PLAN_VALUES = new Set(['free', 'plus', 'pro', 'pro_plus']);

// Local file storage for avatars
const AVATARS_DIR = path.resolve(process.cwd(), 'uploads', 'avatars');

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) {
      cb(null, true);
      return;
    }
    cb(new Error('invalid_file_type'));
  }
}).single('avatar');

type UserTokenData = {
  id: string;
  email: string;
  plan: string;
};

type UserRow = UserTokenData & {
  username: string;
  display_name: string | null;
  bio: string | null;
  photo_link: string | null;
  balance?: number;
  verified: boolean;
  email_verified_at?: string | Date | null;
  email_verification_nonce?: string | null;
  email_verification_requested_at?: string | Date | null;
  last_login_at?: string | Date | null;
  last_login_place?: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  password_hash?: string;
  deleted_at?: string | Date | null;
  roles?: string[];
  is_internal_account?: boolean;
  blocked_at?: string | Date | null;
};

function getAvatarExtension(file: Express.Multer.File) {
  const originalExt = (file.originalname?.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
  const safeOriginalExt = originalExt.replace(/[^a-z0-9.]/g, '').slice(0, 10);
  if (safeOriginalExt) {
    return safeOriginalExt;
  }
  const mime = (file.mimetype || '').toLowerCase();
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/webp') return '.webp';
  return '.png';
}

async function ensureAvatarsDirectory() {
  try {
    await fs.access(AVATARS_DIR);
  } catch {
    await fs.mkdir(AVATARS_DIR, { recursive: true });
  }
}

function signUser(user: UserTokenData) {
  return jwt.sign({ id: user.id, email: user.email, plan: user.plan }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn as SignOptions['expiresIn']
  });
}

function normalizeEmail(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function getVerificationRedirectUrl(nonce: string): string {
  const url = new URL(config.auth.emailVerificationPath, config.frontendUrl);
  url.searchParams.set('vnonce', nonce);
  return url.toString();
}

async function sendVerificationEmail(email: string, nonce: string): Promise<void> {
  const supabaseOtpClient = requireSupabaseOtpClient();
  const { error } = await supabaseOtpClient.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      emailRedirectTo: getVerificationRedirectUrl(nonce)
    }
  });
  if (error) {
    throw new Error(error.message || 'verification_failed');
  }
}

function parseDateToEpochMs(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const epoch = new Date(value).getTime();
  return Number.isFinite(epoch) ? epoch : null;
}

router.post('/register', async (req, res, next) => {
  const { email, username, password, display_name, bio, photo_link, plan, is_internal_user } = req.body || {};
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !username || !password) {
    return res.status(400).json({ error: 'missing_required_fields' });
  }
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'invalid_username_format', message: 'Use lowercase letters and numbers only.' });
  }
  if (plan && !PLAN_VALUES.has(plan)) {
    return res.status(400).json({ error: 'invalid_plan' });
  }
  try {
    const targetIsInternal = Boolean(is_internal_user);
    const existingIdentities = await query<{
      email_match: boolean;
      username_match: boolean;
      is_internal_account: boolean;
    }>(
      `SELECT lower(u.email) = lower($1::text) AS email_match,
              lower(u.username) = lower($2::text) AS username_match,
              EXISTS (
                SELECT 1
                FROM user_roles ur
                JOIN roles r ON r.id = ur.role_id
                WHERE ur.user_id = u.id
                  AND r.key IN ('admin', 'worker')
              ) AS is_internal_account
      FROM users u
       WHERE u.deleted_at IS NULL
         AND (lower(u.email) = lower($1::text) OR lower(u.username) = lower($2::text))`,
      [normalizedEmail, username]
    );

    const conflictingRows = existingIdentities.rows.filter(
      (row) => Boolean(row.is_internal_account) === targetIsInternal
    );
    if (conflictingRows.some((row) => row.username_match)) {
      return res.status(409).json({ error: 'username_taken' });
    }
    if (conflictingRows.some((row) => row.email_match)) {
      return res.status(409).json({ error: 'email_taken' });
    }

    const password_hash = await hashPassword(password);
    const verified = !targetIsInternal;
    const verificationNonce = randomUUID();
    const { rows } = await query<UserRow>(
      `INSERT INTO users (
          email,
          username,
          password_hash,
          display_name,
          bio,
          photo_link,
          plan,
          verified,
          email_verified_at,
          email_verification_nonce,
          email_verification_requested_at
       )
       VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          COALESCE($7::plan_type, 'free'::plan_type),
          $8,
          NULL,
          $9,
          now()
       )
       RETURNING id, email, username, display_name, bio, photo_link, plan, balance, verified, created_at, updated_at`,
      [
        normalizedEmail,
        username,
        password_hash,
        display_name ?? null,
        bio ?? null,
        photo_link ?? null,
        plan,
        verified,
        verificationNonce
      ]
    );
    const user = rows[0];

    const roleRows = await query<{ id: string; key: string }>(
      `SELECT id, key
       FROM roles
       WHERE key IN ('user', 'worker')`
    );
    const roleByKey = roleRows.rows.reduce<Record<string, string>>((acc, row) => {
      acc[row.key] = row.id;
      return acc;
    }, {});

    if (roleByKey.user) {
      await query(
        `INSERT INTO user_roles (user_id, role_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [user.id, roleByKey.user]
      );
    }

    if (is_internal_user && roleByKey.worker) {
      await query(
        `INSERT INTO user_roles (user_id, role_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [user.id, roleByKey.worker]
      );
    }

    if (!config.features.emailVerificationEnabled) {
      const token = signUser(user);
      return res.status(201).json({ token, user });
    }

    try {
      await sendVerificationEmail(normalizedEmail, verificationNonce);
    } catch {
      await query(`DELETE FROM users WHERE id = $1`, [user.id]);
      return res.status(503).json({
        error: 'verification_unavailable',
        message: 'Email verification is temporarily unavailable. Please try again later.'
      });
    }

    return res.status(201).json({
      status: 'verification_required',
      email: normalizedEmail,
      expires_in_seconds: config.auth.emailVerificationTtlSeconds
    });
  } catch (err) {
    if (err.code === '23505') {
      // unique_violation
      const isEmail = err.detail?.includes('email');
      const isUsername = err.detail?.includes('username');
      return res.status(409).json({ error: isEmail ? 'email_taken' : isUsername ? 'username_taken' : 'duplicate' });
    }
    next(err);
  }
});

router.post('/email-verification/confirm', async (req, res, next) => {
  if (!config.features.emailVerificationEnabled) {
    return res.status(404).json({ error: 'not_found' });
  }
  const header = req.headers.authorization;
  const nonce = String(req.body?.nonce || '').trim();
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_token' });
  }
  if (!nonce) {
    return res.status(400).json({ error: 'missing_nonce' });
  }
  const accessToken = header.slice('Bearer '.length).trim();
  if (!accessToken) {
    return res.status(401).json({ error: 'invalid_token' });
  }

  try {
    const supabaseAdminClient = requireSupabaseAdminClient();
    const {
      data: { user: supabaseUser },
      error: getUserError
    } = await supabaseAdminClient.auth.getUser(accessToken);

    if (getUserError || !supabaseUser?.email) {
      return res.status(401).json({ error: 'invalid_token' });
    }

    const normalizedEmail = normalizeEmail(supabaseUser.email);
    const { rows } = await query<UserRow>(
      `SELECT id, email_verification_nonce, email_verification_requested_at, email_verified_at
       FROM users
       WHERE lower(email) = lower($1::text)
         AND email_verification_nonce = $2
         AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      [normalizedEmail, nonce]
    );
    const user = rows[0];
    if (!user) {
      const existing = await query<UserRow>(
        `SELECT email_verified_at
         FROM users
         WHERE lower(email) = lower($1::text)
           AND deleted_at IS NULL
         ORDER BY created_at ASC`,
        [normalizedEmail]
      );
      if (existing.rows.some((row) => Boolean(row.email_verified_at))) {
        return res.json({ status: 'verified' });
      }
      return res.status(400).json({ error: 'invalid_verification_nonce' });
    }

    const requestedAtMs = parseDateToEpochMs(user.email_verification_requested_at || null);
    if (!requestedAtMs) {
      return res.status(400).json({ error: 'verification_failed' });
    }

    const maxAgeMs = config.auth.emailVerificationTtlSeconds * 1000;
    if (Date.now() - requestedAtMs > maxAgeMs) {
      return res.status(400).json({ error: 'verification_link_expired' });
    }

    await query(
      `UPDATE users
       SET email_verified_at = now(),
           email_verification_nonce = NULL,
           email_verification_requested_at = NULL
       WHERE id = $1`,
      [user.id]
    );

    return res.json({ status: 'verified' });
  } catch (err) {
    next(err);
  }
});

router.post('/email-verification/resend', async (req, res, next) => {
  if (!config.features.emailVerificationEnabled) {
    return res.status(404).json({ error: 'not_found' });
  }
  const normalizedEmail = normalizeEmail(req.body?.email);
  if (!normalizedEmail) {
    return res.status(400).json({ error: 'missing_email' });
  }

  try {
    const { rows } = await query<UserRow>(
      `SELECT id, email_verified_at, email_verification_requested_at
       FROM users
       WHERE lower(email) = lower($1::text)
         AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      [normalizedEmail]
    );
    const user = rows[0];
    if (!user || user.email_verified_at) {
      return res.json({ status: 'verification_resent_if_eligible' });
    }

    const requestedAtMs = parseDateToEpochMs(user.email_verification_requested_at || null);
    const cooldownMs = config.auth.emailVerificationResendCooldownSeconds * 1000;
    if (requestedAtMs && Date.now() - requestedAtMs < cooldownMs) {
      return res.json({ status: 'verification_resent_if_eligible' });
    }

    const verificationNonce = randomUUID();
    await query(
      `UPDATE users
       SET email_verification_nonce = $1,
           email_verification_requested_at = now()
       WHERE id = $2`,
      [verificationNonce, user.id]
    );
    await sendVerificationEmail(normalizedEmail, verificationNonce);

    return res.json({ status: 'verification_resent_if_eligible' });
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  const { email, password } = req.body || {};
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !password) return res.status(400).json({ error: 'missing_credentials' });
  try {
    const { rows } = await query<UserRow>(
      `SELECT id,
              email,
              username,
              password_hash,
              display_name,
              bio,
              photo_link,
              plan,
              balance,
              verified,
              email_verified_at,
              blocked_at,
              deleted_at,
              ARRAY(
                SELECT r.key
                FROM user_roles ur
                JOIN roles r ON r.id = ur.role_id
                WHERE ur.user_id = users.id
              ) AS roles
       FROM users
       WHERE lower(email) = lower($1::text)
         AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      [normalizedEmail]
    );
    let user: UserRow | null = null;
    for (const candidate of rows) {
      const ok = await comparePassword(password, candidate.password_hash || '');
      if (!ok) continue;
      user = candidate;
      break;
    }
    if (!user) return res.status(401).json({ error: 'invalid_credentials' });
    if (config.features.emailVerificationEnabled && !user.email_verified_at) {
      return res.status(403).json({
        error: 'email_not_verified',
        message: 'Please verify your email before signing in.'
      });
    }
    if (user.blocked_at) {
      return res.status(403).json({
        error: 'account_blocked',
        message: 'Your account is blocked. Please contact support team.'
      });
    }
    const roles = Array.isArray(user.roles) ? user.roles.map((role) => String(role || '').toLowerCase()) : [];
    if (!user.verified && roles.includes('worker')) {
      return res.status(403).json({
        error: 'worker_not_verified',
        message: INTERNAL_WORKER_BLOCK_MESSAGE
      });
    }
    delete user.password_hash;
    const forwardedFor = Array.isArray(req.headers['x-forwarded-for'])
      ? req.headers['x-forwarded-for'][0]
      : req.headers['x-forwarded-for'];
    const loginPlace = (forwardedFor || req.ip || '').toString() || null;
    await query(
      `UPDATE users
       SET last_login_at = now(),
           last_login_place = $1
       WHERE id = $2`,
      [loginPlace, user.id]
    );
    const token = signUser(user);
    return res.json({ token, user });
  } catch (err) {
    next(err);
  }
});

router.get('/me', authRequired, fetchCurrentUser, (req, res) => {
  res.json({ user: req.currentUser });
});

router.post('/me/avatar', authRequired, (req, res, next) => {
  avatarUpload(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: 'upload_failed', message: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'missing_file' });
    }
    try {
      await ensureAvatarsDirectory();

      const ext = getAvatarExtension(req.file);
      const fileName = `${req.user?.id || 'user'}-${Date.now()}-${randomUUID()}${ext}`;
      const filePath = path.join(AVATARS_DIR, fileName);

      // Write file to local storage
      await fs.writeFile(filePath, req.file.buffer);

      // Generate public URL (server serves /uploads as static)
      const photoLink = `/uploads/avatars/${fileName}`;

      await query(
        `UPDATE users
         SET photo_link = $1
         WHERE id = $2`,
        [photoLink, req.user?.id]
      );

      return res.json({ photo_link: photoLink });
    } catch (uploadErr) {
      return next(uploadErr);
    }
  });
});

router.post('/password', authRequired, fetchCurrentUser, async (req, res, next) => {
  const { old_password, new_password } = req.body || {};
  if (!old_password || !new_password) {
    return res.status(400).json({ error: 'missing_required_fields' });
  }
  if (String(new_password).length < 8) {
    return res.status(400).json({ error: 'weak_password', message: 'Password must be at least 8 characters.' });
  }
  try {
    const { rows } = await query<UserRow>(
      `SELECT password_hash FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [req.currentUser.id]
    );
    const current = rows[0];
    if (!current?.password_hash) {
      return res.status(404).json({ error: 'user_not_found' });
    }
    const ok = await comparePassword(old_password, current.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
    const password_hash = await hashPassword(new_password);
    await query(
      `UPDATE users
       SET password_hash = $1
       WHERE id = $2`,
      [password_hash, req.currentUser.id]
    );
    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.put('/me', authRequired, fetchCurrentUser, async (req, res, next) => {
  const body = req.body || {};
  const hasDisplayName = Object.prototype.hasOwnProperty.call(body, 'display_name');
  const hasName = Object.prototype.hasOwnProperty.call(body, 'name');
  const hasBio = Object.prototype.hasOwnProperty.call(body, 'bio');
  const hasPhotoLink = Object.prototype.hasOwnProperty.call(body, 'photo_link');

  if (!hasDisplayName && !hasName && !hasBio && !hasPhotoLink) {
    return res.json(req.currentUser);
  }

  const displayName = hasDisplayName
    ? body.display_name
    : hasName
      ? body.name
      : req.currentUser.display_name;

  const bio = hasBio ? body.bio : req.currentUser.bio;
  const photoLink = hasPhotoLink ? body.photo_link : req.currentUser.photo_link;

  try {
    const { rows } = await query<UserRow>(
      `UPDATE users
       SET display_name = $1,
           bio = $2,
           photo_link = $3
       WHERE id = $4
       RETURNING id, email, username, display_name, bio, photo_link, plan, balance, verified, created_at, updated_at`,
      [displayName ?? null, bio ?? null, photoLink ?? null, req.currentUser.id]
    );
    const user = rows[0];
    const { rows: roleRows } = await query<{ key: string }>(
      `SELECT r.key
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1`,
      [req.currentUser.id]
    );
    let badges: string[] = [];
    try {
      const { rows: badgeRows } = await query<{ key: string }>(
        `SELECT DISTINCT COALESCE(ub.badge_key, ub.talent_role) AS key
         FROM user_badges ub
         WHERE COALESCE(ub.user_id, ub.id) = $1
           AND COALESCE(ub.badge_key, ub.talent_role) IS NOT NULL`,
        [req.currentUser.id]
      );
      badges = badgeRows.map((row) => row.key);
    } catch (err) {
      badges = [];
    }
    return res.json({ ...user, roles: roleRows.map((row) => row.key), badges });
  } catch (err) {
    next(err);
  }
});

// Stateless JWT: logout is client-side; endpoint provided for symmetry/analytics.
router.post('/logout', (req, res) => {
  res.json({ success: true, message: 'Logged out. Please discard the token client-side.' });
});

export default router;
