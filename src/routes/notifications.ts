import express from 'express';
import { authRequired, fetchCurrentUser } from '../middleware/auth.js';
import { createNotifications, ensureNotificationSchema, listNotificationsForUser, markAllNotificationsRead } from '../services/notifications.js';
import { NOTIFICATION_TYPES, type NotificationType } from '../constants/notificationTypes.js';
import { ADMIN_MANAGER_ROLE_KEYS } from '../constants/roles.js';

const router = express.Router();

const hasAnyRole = (roles: string[] | null | undefined, requiredRoles: string[]) =>
  Array.isArray(roles) && requiredRoles.some((role) => roles.includes(role));

const isNotificationType = (value: string): value is NotificationType =>
  Object.values(NOTIFICATION_TYPES).includes(value as NotificationType);

function parseLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(Math.floor(parsed), 100);
}

router.use(authRequired, fetchCurrentUser);
router.use(async (_req, _res, next) => {
  try {
    await ensureNotificationSchema();
    next();
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  const limit = parseLimit(req.query?.limit);
  const cursor = typeof req.query?.cursor === 'string' ? req.query.cursor : null;
  try {
    const data = await listNotificationsForUser(req.currentUser.id, { limit, cursor });
    return res.json({
      items: data.items,
      next_cursor: data.nextCursor,
      has_unread: data.hasUnread,
      unread_count: data.unreadCount
    });
  } catch (err) {
    next(err);
  }
});

router.post('/mark-all-read', async (req, res, next) => {
  try {
    const updatedCount = await markAllNotificationsRead(req.currentUser.id);
    return res.json({ updated_count: updatedCount });
  } catch (err) {
    next(err);
  }
});

router.post('/create', async (req, res, next) => {
  if (!hasAnyRole(req.currentUser?.roles, ADMIN_MANAGER_ROLE_KEYS)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const payload = req.body || {};
  const rawType = payload.type ? String(payload.type) : '';
  const type = rawType as NotificationType;
  const title = payload.title ? String(payload.title).trim() : '';
  const message = payload.message ? String(payload.message).trim() : '';
  const redirectUrl = payload.redirect_url ? String(payload.redirect_url).trim() : '';
  const userIds = Array.isArray(payload.user_ids)
    ? payload.user_ids.map((value: unknown) => String(value)).filter(Boolean)
    : payload.user_id
      ? [String(payload.user_id)]
      : [];

  if (!type || !isNotificationType(type) || !title || !message || !redirectUrl || userIds.length === 0) {
    return res.status(400).json({ error: 'missing_required_fields' });
  }

  try {
    const createdCount = await createNotifications({
      userIds,
      type,
      title,
      message,
      redirectUrl
    });
    return res.status(201).json({ created_count: createdCount });
  } catch (err) {
    next(err);
  }
});

export default router;
