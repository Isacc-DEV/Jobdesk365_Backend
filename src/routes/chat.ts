import express from 'express';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { config } from '../config.js';
import { query } from '../db.js';
import { authRequired, fetchCurrentUser } from '../middleware/auth.js';
import { broadcastToEmployees, broadcastToThread, broadcastToUsers } from '../realtime/chatRealtime.js';
import { canAccessManagerScope, isAdmin, isWorker } from '../lib/accessControl.js';

const router = express.Router();

const CHAT_UPLOAD_DIR = path.resolve(process.cwd(), 'uploads', 'chat');
fs.mkdirSync(CHAT_UPLOAD_DIR, { recursive: true });

const attachmentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, CHAT_UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').slice(0, 10);
    const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, '') || '';
    const base = `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    cb(null, `${base}${safeExt}`);
  }
});

const attachmentUpload = multer({
  storage: attachmentStorage,
  limits: { fileSize: 15 * 1024 * 1024 }
}).single('file');

const isEmployee = (roles?: string[] | null) =>
  isAdmin(roles) || isWorker(roles);

const isAdminOrManager = (user?: { roles?: string[] | null; badges?: string[] | null } | null) =>
  isAdmin(user?.roles) || canAccessManagerScope(user);

const safeText = (value: unknown) => String(value || '').trim();

const resolveUserFromToken = async (header?: string) => {
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length);
  try {
    const payload = jwt.verify(token, config.jwt.secret) as { id?: string };
    if (!payload?.id) return null;
    const { rows } = await query(
      `SELECT u.id, u.email, u.username, u.display_name, u.photo_link,
              ARRAY(
                SELECT r.key
                FROM user_roles ur
                JOIN roles r ON r.id = ur.role_id
                WHERE ur.user_id = u.id
              ) AS roles
       FROM users u
       WHERE u.id = $1 AND u.deleted_at IS NULL
       LIMIT 1`,
      [payload.id]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
};

const formatDisplayName = (user: any) =>
  user?.display_name || user?.username || user?.email || 'User';

router.post('/live/start', async (req, res, next) => {
  try {
    const authUser = await resolveUserFromToken(req.headers.authorization);
    const name = safeText(req.body?.name);
    const email = safeText(req.body?.email);
    const existingGuestId = safeText(req.body?.guest_id);

    if (authUser && Array.isArray(authUser.roles) && authUser.roles.includes('client')) {
      const { rows: existingRows } = await query(
        `SELECT id, guest_id, user_type, display_name, status
         FROM chat_threads
         WHERE user_id = $1 AND status <> 'closed'
         ORDER BY updated_at DESC
         LIMIT 1`,
        [authUser.id]
      );
      if (existingRows.length) {
        return res.json({ thread: existingRows[0] });
      }

      const displayName = formatDisplayName(authUser);
      const { rows } = await query(
        `INSERT INTO chat_threads (user_id, user_type, display_name, status, last_activity_at)
         VALUES ($1, 'client', $2, 'open', now())
         RETURNING *`,
        [authUser.id, displayName]
      );
      broadcastToEmployees({ type: 'thread:new', thread: rows[0] });
      return res.status(201).json({ thread: rows[0] });
    }

    const guestId = existingGuestId || crypto.randomUUID();
    const displayName = name || 'Guest';

    const { rows: openRows } = await query(
      `SELECT id, guest_id, user_type, display_name, status
       FROM chat_threads
       WHERE guest_id = $1 AND status <> 'closed'
       ORDER BY updated_at DESC
       LIMIT 1`,
      [guestId]
    );
    if (openRows.length) {
      return res.json({ thread: openRows[0], guest_id: guestId });
    }

    const { rows } = await query(
      `INSERT INTO chat_threads (guest_id, user_type, display_name, status, last_activity_at)
       VALUES ($1, 'guest', $2, 'open', now())
       RETURNING *`,
      [guestId, displayName || email || 'Guest']
    );
    broadcastToEmployees({ type: 'thread:new', thread: rows[0] });
    return res.status(201).json({ thread: rows[0], guest_id: guestId });
  } catch (err) {
    next(err);
  }
});

router.get('/live/messages', async (req, res, next) => {
  try {
    const threadId = safeText(req.query?.thread_id);
    if (!threadId) return res.status(400).json({ error: 'missing_thread_id' });

    const authUser = await resolveUserFromToken(req.headers.authorization);
    const guestId = safeText(req.query?.guest_id || req.headers['x-guest-id']);

    const { rows: threadRows } = await query(
      `SELECT id, user_id, guest_id, user_type
       FROM chat_threads
       WHERE id = $1
       LIMIT 1`,
      [threadId]
    );
    if (!threadRows.length) return res.status(404).json({ error: 'thread_not_found' });
    const thread = threadRows[0];

    if (thread.user_type === 'guest') {
      if (!guestId || guestId !== thread.guest_id) {
        return res.status(403).json({ error: 'forbidden' });
      }
    }

    if (thread.user_type === 'client') {
      if (!authUser || authUser.id !== thread.user_id) {
        return res.status(403).json({ error: 'forbidden' });
      }
    }

    const { rows } = await query(
      `SELECT id, sender_type, sender_id, content, created_at, delivered_at, read_at
       FROM chat_messages
       WHERE thread_id = $1 AND sender_type <> 'internal'
       ORDER BY created_at ASC`,
      [threadId]
    );
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/live/messages', async (req, res, next) => {
  try {
    const threadId = safeText(req.body?.thread_id);
    const content = safeText(req.body?.content);
    if (!threadId || !content) return res.status(400).json({ error: 'missing_fields' });

    const authUser = await resolveUserFromToken(req.headers.authorization);
    const guestId = safeText(req.body?.guest_id || req.headers['x-guest-id']);

    const { rows: threadRows } = await query(
      `SELECT id, user_id, guest_id, user_type, status
       FROM chat_threads
       WHERE id = $1
       LIMIT 1`,
      [threadId]
    );
    if (!threadRows.length) return res.status(404).json({ error: 'thread_not_found' });
    const thread = threadRows[0];

    if (thread.user_type === 'guest') {
      if (!guestId || guestId !== thread.guest_id) {
        return res.status(403).json({ error: 'forbidden' });
      }
    }

    if (thread.user_type === 'client') {
      if (!authUser || authUser.id !== thread.user_id) {
        return res.status(403).json({ error: 'forbidden' });
      }
    }

    const senderId = authUser?.id || null;
    const { rows } = await query(
      `INSERT INTO chat_messages (thread_id, sender_type, sender_id, content, delivered_at)
       VALUES ($1, 'external', $2, $3, now())
       RETURNING *`,
      [threadId, senderId, content]
    );

    await query(
      `UPDATE chat_threads
       SET last_activity_at = now()
       WHERE id = $1`,
      [threadId]
    );

    broadcastToEmployees({ type: 'message:new', thread_id: threadId, message: rows[0] });
    broadcastToThread(threadId, { type: 'message:new', thread_id: threadId, message: rows[0] });

    res.status(201).json({ message: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post('/live/close', async (req, res, next) => {
  try {
    const threadId = safeText(req.body?.thread_id);
    if (!threadId) return res.status(400).json({ error: 'missing_thread_id' });

    const authUser = await resolveUserFromToken(req.headers.authorization);
    const guestId = safeText(req.body?.guest_id || req.headers['x-guest-id']);

    const { rows: threadRows } = await query(
      `SELECT id, user_id, guest_id, user_type, status
       FROM chat_threads
       WHERE id = $1
       LIMIT 1`,
      [threadId]
    );
    if (!threadRows.length) return res.status(404).json({ error: 'thread_not_found' });
    const thread = threadRows[0];

    if (thread.user_type === 'guest') {
      if (!guestId || guestId !== thread.guest_id) {
        return res.status(403).json({ error: 'forbidden' });
      }
    }

    if (thread.user_type === 'client') {
      if (!authUser || authUser.id !== thread.user_id) {
        return res.status(403).json({ error: 'forbidden' });
      }
    }

    if (thread.status === 'closed') {
      return res.json({ thread });
    }

    const { rows } = await query(
      `UPDATE chat_threads
       SET status = 'closed',
           closed_at = now(),
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [threadId]
    );
    if (rows[0]) {
      broadcastToEmployees({ type: 'thread:update', thread: rows[0] });
    }
    res.json({ thread: rows[0] || thread });
  } catch (err) {
    next(err);
  }
});

router.get('/threads', authRequired, fetchCurrentUser, async (req, res, next) => {
  if (!isEmployee(req.currentUser?.roles)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const scope = String(req.query?.scope || '').toLowerCase();
  const filters: string[] = [];
  const params: Array<unknown> = [];
  let idx = 0;

  if (scope === 'assigned') {
    idx += 1;
    filters.push(`t.assigned_manager_id = $${idx}`);
    params.push(req.currentUser.id);
  }

  if (req.query?.status) {
    idx += 1;
    filters.push(`t.status = $${idx}`);
    params.push(String(req.query.status));
  }

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  try {
    const { rows } = await query(
      `SELECT t.*,
              (
                SELECT m.content
                FROM chat_messages m
                WHERE m.thread_id = t.id
                ORDER BY m.created_at DESC
                LIMIT 1
              ) AS last_message,
              (
                SELECT m.created_at
                FROM chat_messages m
                WHERE m.thread_id = t.id
                ORDER BY m.created_at DESC
                LIMIT 1
              ) AS last_message_at,
              (
                SELECT COUNT(*)
                FROM chat_messages m
                LEFT JOIN chat_message_reads r
                  ON r.message_id = m.id AND r.user_id = $${idx + 1}
                WHERE m.thread_id = t.id
                  AND m.sender_type = 'external'
                  AND r.message_id IS NULL
              ) AS unread_count
       FROM chat_threads t
       ${whereClause}
       ORDER BY t.last_activity_at DESC NULLS LAST, t.updated_at DESC`,
      [...params, req.currentUser.id]
    );
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/channels', authRequired, fetchCurrentUser, async (req, res, next) => {
  if (!isEmployee(req.currentUser?.roles)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const { rows } = await query(
      `SELECT id, key, name, position, is_support
       FROM chat_channels
       ORDER BY position ASC, name ASC`
    );
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/channels/:channelId/messages', authRequired, fetchCurrentUser, async (req, res, next) => {
  if (!isEmployee(req.currentUser?.roles)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const channelId = req.params.channelId;
  try {
    const { rows: messages } = await query(
      `SELECT id, channel_id, sender_id, content, created_at
       FROM chat_channel_messages
       WHERE channel_id = $1
       ORDER BY created_at ASC`,
      [channelId]
    );

    const messageIds = messages.map((m) => m.id);
    if (!messageIds.length) {
      return res.json({ items: [] });
    }

    const { rows: reactions } = await query(
      `SELECT id, message_id, user_id, emoji, created_at
       FROM chat_channel_reactions
       WHERE message_id = ANY($1::uuid[])`,
      [messageIds]
    );

    const { rows: attachments } = await query(
      `SELECT id, message_id, file_url, file_type, preview_url, size_bytes, name, created_at
       FROM chat_channel_attachments
       WHERE message_id = ANY($1::uuid[])`,
      [messageIds]
    );

    const reactionsByMessage = new Map<string, any[]>();
    reactions.forEach((reaction) => {
      const list = reactionsByMessage.get(reaction.message_id) || [];
      list.push(reaction);
      reactionsByMessage.set(reaction.message_id, list);
    });

    const attachmentsByMessage = new Map<string, any[]>();
    attachments.forEach((attachment) => {
      const list = attachmentsByMessage.get(attachment.message_id) || [];
      list.push(attachment);
      attachmentsByMessage.set(attachment.message_id, list);
    });

    const enriched = messages.map((message) => ({
      ...message,
      reactions: reactionsByMessage.get(message.id) || [],
      attachments: attachmentsByMessage.get(message.id) || []
    }));

    res.json({ items: enriched });
  } catch (err) {
    next(err);
  }
});

router.post('/channels/:channelId/messages', authRequired, fetchCurrentUser, async (req, res, next) => {
  if (!isEmployee(req.currentUser?.roles)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const channelId = req.params.channelId;
  const content = safeText(req.body?.content);
  if (!content) return res.status(400).json({ error: 'missing_content' });
  try {
    const { rows } = await query(
      `INSERT INTO chat_channel_messages (channel_id, sender_id, content)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [channelId, req.currentUser.id, content]
    );
    const message = { ...rows[0], reactions: [] };
    broadcastToEmployees({ type: 'channel:message:new', channel_id: channelId, message });
    res.status(201).json({ message });
  } catch (err) {
    next(err);
  }
});

router.post('/channel-messages/:messageId/reactions', authRequired, fetchCurrentUser, async (req, res, next) => {
  if (!isEmployee(req.currentUser?.roles)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const messageId = req.params.messageId;
  const emoji = safeText(req.body?.emoji);
  if (!emoji) return res.status(400).json({ error: 'missing_emoji' });
  try {
    const { rows } = await query(
      `INSERT INTO chat_channel_reactions (message_id, user_id, emoji)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [messageId, req.currentUser.id, emoji]
    );
    res.status(201).json({ reaction: rows[0] || null });
  } catch (err) {
    next(err);
  }
});

router.delete('/channel-messages/:messageId/reactions', authRequired, fetchCurrentUser, async (req, res, next) => {
  if (!isEmployee(req.currentUser?.roles)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const messageId = req.params.messageId;
  const emoji = safeText(req.body?.emoji);
  if (!emoji) return res.status(400).json({ error: 'missing_emoji' });
  try {
    await query(
      `DELETE FROM chat_channel_reactions
       WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
      [messageId, req.currentUser.id, emoji]
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/channel-messages/:messageId/attachments', authRequired, fetchCurrentUser, (req, res, next) => {
  if (!isEmployee(req.currentUser?.roles)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  attachmentUpload(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: 'upload_failed', message: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'missing_file' });
    }
    try {
      const { rows: messageRows } = await query(
        `SELECT id FROM chat_channel_messages WHERE id = $1 LIMIT 1`,
        [req.params.messageId]
      );
      if (!messageRows.length) {
        return res.status(404).json({ error: 'message_not_found' });
      }
      const host = req.get('host');
      const protocol = req.protocol;
      const fileUrl = `${protocol}://${host}/uploads/chat/${req.file.filename}`;
      const { rows } = await query(
        `INSERT INTO chat_channel_attachments (message_id, file_url, file_type, size_bytes, name)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [req.params.messageId, fileUrl, req.file.mimetype, req.file.size, req.file.originalname]
      );
      res.status(201).json({ attachment: rows[0] });
    } catch (uploadErr) {
      next(uploadErr);
    }
  });
});

router.post('/dm/threads', authRequired, fetchCurrentUser, async (req, res, next) => {
  if (!isEmployee(req.currentUser?.roles)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const otherUserId = safeText(req.body?.user_id);
  if (!otherUserId) return res.status(400).json({ error: 'missing_user_id' });
  if (otherUserId === req.currentUser.id) {
    return res.status(400).json({ error: 'invalid_user_id' });
  }
  try {
    const { rows: existing } = await query(
      `SELECT id, user_a_id, user_b_id
       FROM chat_dm_threads
       WHERE (user_a_id = $1 AND user_b_id = $2)
          OR (user_a_id = $2 AND user_b_id = $1)
       LIMIT 1`,
      [req.currentUser.id, otherUserId]
    );
    if (existing.length) {
      return res.json({ thread: existing[0] });
    }

    const { rows } = await query(
      `INSERT INTO chat_dm_threads (user_a_id, user_b_id)
       VALUES ($1, $2)
       RETURNING *`,
      [req.currentUser.id, otherUserId]
    );
    res.status(201).json({ thread: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.get('/dm/threads/:threadId/messages', authRequired, fetchCurrentUser, async (req, res, next) => {
  if (!isEmployee(req.currentUser?.roles)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const threadId = req.params.threadId;
  try {
    const { rows: threadRows } = await query(
      `SELECT id, user_a_id, user_b_id
       FROM chat_dm_threads
       WHERE id = $1
       LIMIT 1`,
      [threadId]
    );
    if (!threadRows.length) return res.status(404).json({ error: 'thread_not_found' });
    const thread = threadRows[0];
    if (thread.user_a_id !== req.currentUser.id && thread.user_b_id !== req.currentUser.id) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const { rows: messages } = await query(
      `SELECT id, thread_id, sender_id, content, created_at
       FROM chat_dm_messages
       WHERE thread_id = $1
       ORDER BY created_at ASC`,
      [threadId]
    );

    const messageIds = messages.map((m) => m.id);
    if (!messageIds.length) {
      return res.json({ items: [] });
    }

    const { rows: reactions } = await query(
      `SELECT id, message_id, user_id, emoji, created_at
       FROM chat_dm_reactions
       WHERE message_id = ANY($1::uuid[])`,
      [messageIds]
    );

    const { rows: attachments } = await query(
      `SELECT id, message_id, file_url, file_type, preview_url, size_bytes, name, created_at
       FROM chat_dm_attachments
       WHERE message_id = ANY($1::uuid[])`,
      [messageIds]
    );

    const reactionsByMessage = new Map<string, any[]>();
    reactions.forEach((reaction) => {
      const list = reactionsByMessage.get(reaction.message_id) || [];
      list.push(reaction);
      reactionsByMessage.set(reaction.message_id, list);
    });

    const attachmentsByMessage = new Map<string, any[]>();
    attachments.forEach((attachment) => {
      const list = attachmentsByMessage.get(attachment.message_id) || [];
      list.push(attachment);
      attachmentsByMessage.set(attachment.message_id, list);
    });

    const enriched = messages.map((message) => ({
      ...message,
      reactions: reactionsByMessage.get(message.id) || [],
      attachments: attachmentsByMessage.get(message.id) || []
    }));

    res.json({ items: enriched });
  } catch (err) {
    next(err);
  }
});

router.post('/dm/threads/:threadId/messages', authRequired, fetchCurrentUser, async (req, res, next) => {
  if (!isEmployee(req.currentUser?.roles)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const threadId = req.params.threadId;
  const content = safeText(req.body?.content);
  if (!content) return res.status(400).json({ error: 'missing_content' });
  try {
    const { rows: threadRows } = await query(
      `SELECT id, user_a_id, user_b_id
       FROM chat_dm_threads
       WHERE id = $1
       LIMIT 1`,
      [threadId]
    );
    if (!threadRows.length) return res.status(404).json({ error: 'thread_not_found' });
    const thread = threadRows[0];
    if (thread.user_a_id !== req.currentUser.id && thread.user_b_id !== req.currentUser.id) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const { rows } = await query(
      `INSERT INTO chat_dm_messages (thread_id, sender_id, content)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [threadId, req.currentUser.id, content]
    );

    await query(
      `UPDATE chat_dm_threads
       SET updated_at = now()
       WHERE id = $1`,
      [threadId]
    );

    const message = { ...rows[0], reactions: [] };
    broadcastToUsers([thread.user_a_id, thread.user_b_id], {
      type: 'dm:message:new',
      thread_id: threadId,
      message
    });
    res.status(201).json({ message });
  } catch (err) {
    next(err);
  }
});

router.post('/dm-messages/:messageId/reactions', authRequired, fetchCurrentUser, async (req, res, next) => {
  if (!isEmployee(req.currentUser?.roles)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const messageId = req.params.messageId;
  const emoji = safeText(req.body?.emoji);
  if (!emoji) return res.status(400).json({ error: 'missing_emoji' });
  try {
    const { rows: threadRows } = await query(
      `SELECT t.user_a_id, t.user_b_id
       FROM chat_dm_messages m
       JOIN chat_dm_threads t ON t.id = m.thread_id
       WHERE m.id = $1
       LIMIT 1`,
      [messageId]
    );
    if (!threadRows.length) return res.status(404).json({ error: 'message_not_found' });
    const thread = threadRows[0];
    if (thread.user_a_id !== req.currentUser.id && thread.user_b_id !== req.currentUser.id) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const { rows } = await query(
      `INSERT INTO chat_dm_reactions (message_id, user_id, emoji)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [messageId, req.currentUser.id, emoji]
    );
    res.status(201).json({ reaction: rows[0] || null });
  } catch (err) {
    next(err);
  }
});

router.delete('/dm-messages/:messageId/reactions', authRequired, fetchCurrentUser, async (req, res, next) => {
  if (!isEmployee(req.currentUser?.roles)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const messageId = req.params.messageId;
  const emoji = safeText(req.body?.emoji);
  if (!emoji) return res.status(400).json({ error: 'missing_emoji' });
  try {
    const { rows: threadRows } = await query(
      `SELECT t.user_a_id, t.user_b_id
       FROM chat_dm_messages m
       JOIN chat_dm_threads t ON t.id = m.thread_id
       WHERE m.id = $1
       LIMIT 1`,
      [messageId]
    );
    if (!threadRows.length) return res.status(404).json({ error: 'message_not_found' });
    const thread = threadRows[0];
    if (thread.user_a_id !== req.currentUser.id && thread.user_b_id !== req.currentUser.id) {
      return res.status(403).json({ error: 'forbidden' });
    }
    await query(
      `DELETE FROM chat_dm_reactions
       WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
      [messageId, req.currentUser.id, emoji]
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/dm-messages/:messageId/attachments', authRequired, fetchCurrentUser, (req, res, next) => {
  if (!isEmployee(req.currentUser?.roles)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  attachmentUpload(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: 'upload_failed', message: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'missing_file' });
    }
    try {
      const { rows: threadRows } = await query(
        `SELECT t.user_a_id, t.user_b_id
         FROM chat_dm_messages m
         JOIN chat_dm_threads t ON t.id = m.thread_id
         WHERE m.id = $1
         LIMIT 1`,
        [req.params.messageId]
      );
      if (!threadRows.length) return res.status(404).json({ error: 'message_not_found' });
      const thread = threadRows[0];
      if (thread.user_a_id !== req.currentUser.id && thread.user_b_id !== req.currentUser.id) {
        return res.status(403).json({ error: 'forbidden' });
      }
      const host = req.get('host');
      const protocol = req.protocol;
      const fileUrl = `${protocol}://${host}/uploads/chat/${req.file.filename}`;
      const { rows } = await query(
        `INSERT INTO chat_dm_attachments (message_id, file_url, file_type, size_bytes, name)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [req.params.messageId, fileUrl, req.file.mimetype, req.file.size, req.file.originalname]
      );
      res.status(201).json({ attachment: rows[0] });
    } catch (uploadErr) {
      next(uploadErr);
    }
  });
});

router.get('/threads/:threadId/messages', authRequired, fetchCurrentUser, async (req, res, next) => {
  if (!isEmployee(req.currentUser?.roles)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const threadId = req.params.threadId;
  try {
    const { rows: messages } = await query(
      `SELECT id, thread_id, sender_type, sender_id, content, created_at, delivered_at, read_at
       FROM chat_messages
       WHERE thread_id = $1
       ORDER BY created_at ASC`,
      [threadId]
    );

    const messageIds = messages.map((m) => m.id);
    if (!messageIds.length) {
      return res.json({ items: [] });
    }

    const { rows: reactions } = await query(
      `SELECT id, message_id, user_id, guest_id, emoji, created_at
       FROM chat_reactions
       WHERE message_id = ANY($1::uuid[])`,
      [messageIds]
    );

    const { rows: attachments } = await query(
      `SELECT id, message_id, file_url, file_type, preview_url, size_bytes, name, created_at
       FROM chat_attachments
       WHERE message_id = ANY($1::uuid[])`,
      [messageIds]
    );

    const { rows: reads } = await query(
      `SELECT message_id, user_id, read_at
       FROM chat_message_reads
       WHERE message_id = ANY($1::uuid[])`,
      [messageIds]
    );

    const reactionsByMessage = new Map<string, any[]>();
    reactions.forEach((reaction) => {
      const list = reactionsByMessage.get(reaction.message_id) || [];
      list.push(reaction);
      reactionsByMessage.set(reaction.message_id, list);
    });

    const attachmentsByMessage = new Map<string, any[]>();
    attachments.forEach((attachment) => {
      const list = attachmentsByMessage.get(attachment.message_id) || [];
      list.push(attachment);
      attachmentsByMessage.set(attachment.message_id, list);
    });

    const readsByMessage = new Map<string, any[]>();
    reads.forEach((read) => {
      const list = readsByMessage.get(read.message_id) || [];
      list.push(read);
      readsByMessage.set(read.message_id, list);
    });

    const enriched = messages.map((message) => ({
      ...message,
      reactions: reactionsByMessage.get(message.id) || [],
      attachments: attachmentsByMessage.get(message.id) || [],
      reads: readsByMessage.get(message.id) || []
    }));

    res.json({ items: enriched });
  } catch (err) {
    next(err);
  }
});

router.post('/threads/:threadId/read', authRequired, fetchCurrentUser, async (req, res, next) => {
  if (!isEmployee(req.currentUser?.roles)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const threadId = req.params.threadId;
  try {
    await query(
      `INSERT INTO chat_message_reads (message_id, user_id)
       SELECT m.id, $2
       FROM chat_messages m
       WHERE m.thread_id = $1 AND m.sender_type = 'external'
       ON CONFLICT DO NOTHING`,
      [threadId, req.currentUser.id]
    );

    await query(
      `UPDATE chat_messages
       SET read_at = now()
       WHERE thread_id = $1 AND sender_type = 'external' AND read_at IS NULL`,
      [threadId]
    );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/threads/:threadId/messages', authRequired, fetchCurrentUser, async (req, res, next) => {
  if (!isEmployee(req.currentUser?.roles)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const threadId = req.params.threadId;
  const content = safeText(req.body?.content);
  const mode = safeText(req.body?.mode) || 'external';
  if (!content) return res.status(400).json({ error: 'missing_content' });

  const senderType = mode === 'internal' ? 'internal' : 'system';

  try {
    const { rows } = await query(
      `INSERT INTO chat_messages (thread_id, sender_type, sender_id, content, delivered_at)
       VALUES ($1, $2, $3, $4, now())
       RETURNING *`,
      [threadId, senderType, req.currentUser.id, content]
    );

    await query(
      `UPDATE chat_threads
       SET last_activity_at = now(),
           status = CASE WHEN status = 'open' THEN 'assigned' ELSE status END
       WHERE id = $1`,
      [threadId]
    );

    broadcastToThread(threadId, { type: 'message:new', thread_id: threadId, message: rows[0] });
    broadcastToEmployees({ type: 'message:new', thread_id: threadId, message: rows[0] });

    res.status(201).json({ message: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.post('/threads/:threadId/assign', authRequired, fetchCurrentUser, async (req, res, next) => {
  if (!isAdminOrManager(req.currentUser)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const threadId = req.params.threadId;
  const managerId = safeText(req.body?.manager_id) || req.currentUser.id;
  try {
    const { rows } = await query(
      `UPDATE chat_threads
       SET assigned_manager_id = $2,
           status = 'assigned'
       WHERE id = $1
       RETURNING *`,
      [threadId, managerId]
    );
    if (!rows.length) return res.status(404).json({ error: 'thread_not_found' });
    broadcastToEmployees({ type: 'thread:update', thread: rows[0] });
    res.json({ thread: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.patch('/threads/:threadId', authRequired, fetchCurrentUser, async (req, res, next) => {
  if (!isAdminOrManager(req.currentUser)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const threadId = req.params.threadId;
  const updates: string[] = [];
  const params: Array<unknown> = [threadId];
  let idx = 1;

  const addField = (column: string, value: unknown) => {
    if (value === undefined) return;
    idx += 1;
    updates.push(`${column} = $${idx}`);
    params.push(value);
  };

  addField('status', req.body?.status);
  addField('assigned_manager_id', req.body?.assigned_manager_id);
  addField('watchers', req.body?.watchers);
  addField('closed_at', req.body?.closed_at);

  if (!updates.length) return res.status(400).json({ error: 'no_updates' });

  try {
    const { rows } = await query(
      `UPDATE chat_threads
       SET ${updates.join(', ')}
       WHERE id = $1
       RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'thread_not_found' });
    broadcastToEmployees({ type: 'thread:update', thread: rows[0] });
    res.json({ thread: rows[0] });
  } catch (err) {
    next(err);
  }
});

router.get('/users', authRequired, fetchCurrentUser, async (req, res, next) => {
  if (!isEmployee(req.currentUser?.roles)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const { rows } = await query(
      `SELECT u.id, u.email, u.username, u.display_name, u.photo_link,
              ARRAY(
                SELECT r.key
                FROM user_roles ur
                JOIN roles r ON r.id = ur.role_id
                WHERE ur.user_id = u.id
              ) AS roles
       FROM users u
       WHERE u.deleted_at IS NULL
       ORDER BY u.created_at DESC`,
      []
    );
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/messages/:messageId/reactions', authRequired, fetchCurrentUser, async (req, res, next) => {
  if (!isEmployee(req.currentUser?.roles)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const messageId = req.params.messageId;
  const emoji = safeText(req.body?.emoji);
  if (!emoji) return res.status(400).json({ error: 'missing_emoji' });
  try {
    const { rows } = await query(
      `INSERT INTO chat_reactions (message_id, user_id, emoji)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [messageId, req.currentUser.id, emoji]
    );
    res.status(201).json({ reaction: rows[0] || null });
  } catch (err) {
    next(err);
  }
});

router.delete('/messages/:messageId/reactions', authRequired, fetchCurrentUser, async (req, res, next) => {
  if (!isEmployee(req.currentUser?.roles)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const messageId = req.params.messageId;
  const emoji = safeText(req.body?.emoji);
  if (!emoji) return res.status(400).json({ error: 'missing_emoji' });
  try {
    await query(
      `DELETE FROM chat_reactions
       WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
      [messageId, req.currentUser.id, emoji]
    );
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/messages/:messageId/attachments', authRequired, fetchCurrentUser, (req, res, next) => {
  if (!isEmployee(req.currentUser?.roles)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  attachmentUpload(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: 'upload_failed', message: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'missing_file' });
    }
    const host = req.get('host');
    const protocol = req.protocol;
    const fileUrl = `${protocol}://${host}/uploads/chat/${req.file.filename}`;
    const { rows } = await query(
      `INSERT INTO chat_attachments (message_id, file_url, file_type, size_bytes, name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.params.messageId, fileUrl, req.file.mimetype, req.file.size, req.file.originalname]
    );
    res.status(201).json({ attachment: rows[0] });
  });
});

export default router;

