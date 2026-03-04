import type { Server as HttpServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db.js';

type ConnectionInfo = {
  socket: WebSocket;
  userId?: string;
  guestId?: string;
  roles?: string[];
  type: 'employee' | 'client' | 'guest';
  displayName?: string;
  status: 'online' | 'idle' | 'offline' | 'responding';
  lastSeen: number;
  threads: Set<string>;
};

const connections = new Set<ConnectionInfo>();
const presenceById = new Map<string, ConnectionInfo>();

const isEmployeeRole = (roles?: string[]) =>
  Array.isArray(roles) && roles.some((role) => role === 'admin' || role === 'worker');

const toPresenceSnapshot = () => {
  const items: Array<{
    id: string;
    type: string;
    status: string;
    display_name?: string;
    roles?: string[];
    last_seen_at: number;
  }> = [];
  presenceById.forEach((info) => {
    items.push({
      id: info.userId || info.guestId || '',
      type: info.type,
      status: info.status,
      display_name: info.displayName,
      roles: info.roles,
      last_seen_at: info.lastSeen
    });
  });
  return items;
};

const broadcast = (payload: unknown, filter?: (info: ConnectionInfo) => boolean) => {
  const message = JSON.stringify(payload);
  connections.forEach((info) => {
    if (filter && !filter(info)) return;
    if (info.socket.readyState === WebSocket.OPEN) {
      info.socket.send(message);
    }
  });
};

export const broadcastToEmployees = (payload: unknown) => {
  broadcast(payload, (info) => info.type === 'employee');
};

export const broadcastToUsers = (userIds: string[], payload: unknown) => {
  const idSet = new Set(userIds.filter(Boolean));
  if (!idSet.size) return;
  broadcast(payload, (info) => Boolean(info.userId) && idSet.has(info.userId as string));
};

export const broadcastToThread = (threadId: string, payload: unknown) => {
  broadcast(payload, (info) => info.threads.has(threadId));
};

export const getPresenceSnapshot = () => toPresenceSnapshot();

const updatePresence = (info: ConnectionInfo, nextStatus?: ConnectionInfo['status']) => {
  const key = info.userId || info.guestId;
  if (!key) return;
  if (nextStatus) info.status = nextStatus;
  info.lastSeen = Date.now();
  presenceById.set(key, info);
  broadcastToEmployees({ type: 'presence:update', items: toPresenceSnapshot() });
};

const resolveUserFromToken = async (token: string) => {
  const payload = jwt.verify(token, config.jwt.secret) as { id?: string };
  if (!payload?.id) return null;
  const { rows } = await query(
    `SELECT u.id, u.email, u.username, u.display_name,
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
};

const decodeInitialInfo = async (url: URL) => {
  const token = url.searchParams.get('token');
  const guestId = url.searchParams.get('guest_id');
  if (token) {
    try {
      const user = await resolveUserFromToken(token);
      if (!user) return null;
      const type = isEmployeeRole(user.roles) ? 'employee' : 'client';
      return {
        userId: user.id,
        roles: user.roles,
        displayName: user.display_name || user.username || user.email || 'User',
        type
      } as const;
    } catch {
      return null;
    }
  }
  if (guestId) {
    return { guestId, type: 'guest', displayName: 'Guest' } as const;
  }
  return null;
};

const setIdleStatuses = () => {
  const now = Date.now();
  let changed = false;
  presenceById.forEach((info, key) => {
    if (info.status === 'offline') return;
    const delta = now - info.lastSeen;
    if (delta > 60000) {
      info.status = 'offline';
      changed = true;
    } else if (delta > 20000 && info.status === 'online') {
      info.status = 'idle';
      changed = true;
    }
    presenceById.set(key, info);
  });
  if (changed) {
    broadcastToEmployees({ type: 'presence:update', items: toPresenceSnapshot() });
  }
};

export const initChatRealtime = (server: HttpServer) => {
  const wss = new WebSocketServer({ server, path: '/chat/ws' });

  wss.on('connection', async (socket, req) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const infoSeed = await decodeInitialInfo(url);
    if (!infoSeed) {
      socket.close(1008, 'Unauthorized');
      return;
    }

    const info: ConnectionInfo = {
      socket,
      userId: infoSeed.userId,
      guestId: infoSeed.guestId,
      roles: infoSeed.roles,
      type: infoSeed.type,
      displayName: infoSeed.displayName,
      status: 'online',
      lastSeen: Date.now(),
      threads: new Set()
    };

    connections.add(info);
    updatePresence(info, 'online');

    if (info.type === 'employee') {
      socket.send(JSON.stringify({ type: 'presence:snapshot', items: toPresenceSnapshot() }));
    }

    socket.on('message', (data) => {
      try {
        const payload = JSON.parse(String(data || '{}')) as any;
        if (payload.type === 'heartbeat') {
          updatePresence(info, info.status === 'offline' ? 'online' : info.status);
          return;
        }
        if (payload.type === 'subscribe' && payload.thread_id) {
          info.threads.add(String(payload.thread_id));
          return;
        }
        if (payload.type === 'unsubscribe' && payload.thread_id) {
          info.threads.delete(String(payload.thread_id));
          return;
        }
        if (payload.type === 'typing' && payload.thread_id) {
          broadcastToThread(String(payload.thread_id), {
            type: 'typing',
            thread_id: String(payload.thread_id),
            status: payload.status || 'typing',
            sender: info.userId || info.guestId || null,
            sender_type: info.type
          });
          return;
        }
      } catch {
        // ignore invalid messages
      }
    });

    socket.on('close', () => {
      connections.delete(info);
      const key = info.userId || info.guestId;
      if (key) {
        info.status = 'offline';
        presenceById.set(key, info);
        broadcastToEmployees({ type: 'presence:update', items: toPresenceSnapshot() });
      }
    });
  });

  setInterval(setIdleStatuses, 10000);

  return wss;
};
