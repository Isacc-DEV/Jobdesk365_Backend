import express from 'express';
import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db.js';
import { hashPassword, comparePassword } from '../utils/password.js';
import { authRequired, fetchCurrentUser } from '../middleware/auth.js';

const router = express.Router();
const USERNAME_RE = /^[a-z0-9]+$/;
const PLAN_VALUES = new Set(['free', 'plus', 'pro', 'pro_plus']);

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
  verified: boolean;
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
       RETURNING id, email, username, display_name, bio, photo_link, plan, verified, created_at, updated_at`,
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
      `SELECT id, email, username, password_hash, display_name, bio, photo_link, plan, verified, deleted_at
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
    const token = signUser(user);
    return res.json({ token, user });
  } catch (err) {
    next(err);
  }
});

router.get('/me', authRequired, fetchCurrentUser, (req, res) => {
  res.json({ user: req.currentUser });
});

// Stateless JWT: logout is client-side; endpoint provided for symmetry/analytics.
router.post('/logout', (req, res) => {
  res.json({ success: true, message: 'Logged out. Please discard the token client-side.' });
});

export default router;
