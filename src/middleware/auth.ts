import jwt from 'jsonwebtoken';
import type { JwtPayload } from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { query } from '../db.js';

type TokenPayload = JwtPayload & { id?: string; email?: string; plan?: string };
type CurrentUser = {
  id: string;
  email: string;
  username: string;
  display_name: string | null;
  bio: string | null;
  photo_link: string | null;
  plan: string;
  balance: number;
  verified: boolean;
  blocked_at?: string | Date | null;
  last_login_at: string | Date | null;
  last_login_place: string | null;
  roles: string[];
  badges: string[];
  created_at: string | Date;
  updated_at: string | Date;
};

export const INTERNAL_WORKER_BLOCK_MESSAGE =
  'plz contact to support team and get verified as internal worker';

export function authRequired(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_token' });
  }

  const token = header.slice('Bearer '.length);
  try {
    const payload = jwt.verify(token, config.jwt.secret) as TokenPayload;
    req.user = payload;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

export async function fetchCurrentUser(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.id) return res.status(401).json({ error: 'invalid_token' });
  try {
    const { rows } = await query<CurrentUser>(
      `SELECT id,
              email,
              username,
              display_name,
              bio,
              photo_link,
              plan,
              balance,
              verified,
              blocked_at,
              last_login_at,
              last_login_place,
              ARRAY(
                SELECT r.key
                FROM user_roles ur
                JOIN roles r ON r.id = ur.role_id
                WHERE ur.user_id = users.id
              ) AS roles,
              created_at,
              updated_at
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'user_not_found' });
    const current = rows[0];
    let badges: string[] = [];
    try {
      const badgeRows = await query<{ key: string }>(
        `SELECT DISTINCT COALESCE(ub.badge_key, ub.talent_role) AS key
         FROM user_badges ub
         WHERE COALESCE(ub.user_id, ub.id) = $1
           AND COALESCE(ub.badge_key, ub.talent_role) IS NOT NULL`,
        [req.user.id]
      );
      badges = badgeRows.rows.map((row) => String(row.key || '')).filter(Boolean);
    } catch (err) {
      // user_badges may not exist before schema migration; keep auth compatible.
      badges = [];
    }
    req.currentUser = { ...current, badges };
    if (current.blocked_at) {
      return res.status(403).json({
        error: 'account_blocked',
        message: 'Your account is blocked. Please contact support team.'
      });
    }
    const roles = Array.isArray(current.roles) ? current.roles.map((role) => String(role || '')) : [];
    if (!current.verified && roles.includes('worker')) {
      return res.status(403).json({
        error: 'worker_not_verified',
        message: INTERNAL_WORKER_BLOCK_MESSAGE
      });
    }
    return next();
  } catch (err) {
    next(err);
  }
}
