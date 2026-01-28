import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db.js';

export function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_token' });
  }

  const token = header.slice('Bearer '.length);
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    req.user = payload;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

export async function fetchCurrentUser(req, res, next) {
  if (!req.user?.id) return res.status(401).json({ error: 'invalid_token' });
  try {
    const { rows } = await query(
      `SELECT id, email, username, display_name, bio, photo_link, plan, verified, created_at, updated_at
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'user_not_found' });
    req.currentUser = rows[0];
    return next();
  } catch (err) {
    next(err);
  }
}
