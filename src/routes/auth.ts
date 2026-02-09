import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db.js';
import { hashPassword, comparePassword } from '../utils/password.js';
import { authRequired, fetchCurrentUser } from '../middleware/auth.js';

const router = express.Router();
const USERNAME_RE = /^[a-z0-9]+$/;
const PLAN_VALUES = new Set(['free', 'plus', 'pro', 'pro_plus']);
const AVATAR_DIR = path.resolve(process.cwd(), 'uploads', 'avatars');

fs.mkdirSync(AVATAR_DIR, { recursive: true });

const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AVATAR_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').slice(0, 10);
    const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, '') || '';
    const base = `${req.user?.id ?? 'user'}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    cb(null, `${base}${safeExt}`);
  }
});

const avatarUpload = multer({
  storage: avatarStorage,
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
  last_login_at?: string | Date | null;
  last_login_place?: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  password_hash?: string;
  deleted_at?: string | Date | null;
};

function signUser(user: UserTokenData) {
  return jwt.sign({ id: user.id, email: user.email, plan: user.plan }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn as SignOptions['expiresIn']
  });
}

router.post('/register', async (req, res, next) => {
  const { email, username, password, display_name, bio, photo_link, plan } = req.body || {};
  if (!email || !username || !password) {
    return res.status(400).json({ error: 'missing_required_fields' });
  }
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'invalid_username_format', message: 'Use lowercase letters and numbers only.' });
  }
  if (plan && !PLAN_VALUES.has(plan)) {
    return res.status(400).json({ error: 'invalid_plan' });
  }
  try {
    const existingUsername = await query(
      `SELECT 1 FROM users WHERE lower(username) = lower($1::text) AND deleted_at IS NULL LIMIT 1`,
      [username]
    );
    if (existingUsername.rowCount) {
      return res.status(409).json({ error: 'username_taken' });
    }

    const password_hash = await hashPassword(password);
    const { rows } = await query<UserRow>(
      `INSERT INTO users (email, username, password_hash, display_name, bio, photo_link, plan)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::plan_type, 'free'::plan_type))
       RETURNING id, email, username, display_name, bio, photo_link, plan, balance, verified, created_at, updated_at`,
      [email, username, password_hash, display_name ?? null, bio ?? null, photo_link ?? null, plan]
    );
    const user = rows[0];
    const token = signUser(user);
    return res.status(201).json({ token, user });
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

router.post('/login', async (req, res, next) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'missing_credentials' });
  try {
    const { rows } = await query<UserRow>(
      `SELECT id, email, username, password_hash, display_name, bio, photo_link, plan, balance, verified, deleted_at
       FROM users
       WHERE lower(email) = lower($1::text)
       ORDER BY deleted_at NULLS FIRST
       LIMIT 1`,
      [email]
    );
    const user = rows[0];
    if (!user || user.deleted_at) return res.status(401).json({ error: 'invalid_credentials' });
    const ok = await comparePassword(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
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
  avatarUpload(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: 'upload_failed', message: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'missing_file' });
    }
    const host = req.get('host');
    const protocol = req.protocol;
    const photoLink = `${protocol}://${host}/uploads/avatars/${req.file.filename}`;
    return res.json({ photo_link: photoLink });
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
    return res.json({ ...user, roles: roleRows.map((row) => row.key) });
  } catch (err) {
    next(err);
  }
});

// Stateless JWT: logout is client-side; endpoint provided for symmetry/analytics.
router.post('/logout', (req, res) => {
  res.json({ success: true, message: 'Logged out. Please discard the token client-side.' });
});

export default router;
