import { query } from '../db.js';
import { NOTIFICATION_TYPES, type NotificationType } from '../constants/notificationTypes.js';
import { ADMIN_WORKER_ROLE_KEYS, type RoleKey } from '../constants/roles.js';

type CursorRow = { created_at: string | Date; id: string };

type NotificationRow = {
  id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  message: string;
  redirect_url: string;
  is_read: boolean;
  read_at: string | Date | null;
  metadata: Record<string, unknown>;
  created_at: string | Date;
};

type CreateNotificationsInput = {
  userIds: string[];
  type: NotificationType;
  title: string;
  message: string;
  redirectUrl: string;
  dedupeKey?: string | null;
  metadata?: Record<string, unknown>;
};

type NotificationListOptions = {
  limit: number;
  cursor?: string | null;
};

let notificationSchemaPromise: Promise<void> | null = null;

export const ensureNotificationSchema = async () => {
  if (notificationSchemaPromise) return notificationSchemaPromise;
  notificationSchemaPromise = (async () => {
    await query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    await query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type text NOT NULL,
        title text NOT NULL,
        message text NOT NULL,
        redirect_url text NOT NULL,
        is_read boolean NOT NULL DEFAULT false,
        read_at timestamptz,
        dedupe_key text,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_notifications_user_created_at
      ON notifications (user_id, created_at DESC, id DESC)
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
      ON notifications (user_id, is_read, created_at DESC)
    `);
    await query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe_key
      ON notifications (dedupe_key)
    `);
  })();

  try {
    await notificationSchemaPromise;
  } catch (err) {
    notificationSchemaPromise = null;
    throw err;
  }

  return notificationSchemaPromise;
};

const uniqueUserIds = (userIds: Array<string | null | undefined>): string[] =>
  Array.from(new Set(userIds.filter((value): value is string => Boolean(value))));

function encodeCursor(row?: CursorRow | null): string | null {
  if (!row) return null;
  return Buffer.from(JSON.stringify({ created_at: row.created_at, id: row.id })).toString('base64');
}

function decodeCursor(token: unknown): CursorRow | null {
  if (!token) return null;
  try {
    const json = Buffer.from(String(token), 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    if (parsed && parsed.created_at && parsed.id) return parsed;
  } catch (_err) {
    return null;
  }
  return null;
}

export async function getAllActiveUserIds(): Promise<string[]> {
  const { rows } = await query<{ id: string }>(
    `SELECT id
     FROM users
     WHERE deleted_at IS NULL`
  );
  return rows.map((row) => row.id);
}

export async function getUserIdsByRoleKeys(roleKeys: RoleKey[]): Promise<string[]> {
  if (!roleKeys.length) return [];
  const { rows } = await query<{ user_id: string }>(
    `SELECT DISTINCT ur.user_id
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     JOIN users u ON u.id = ur.user_id
     WHERE r.key = ANY($1::text[])
       AND u.deleted_at IS NULL`,
    [roleKeys]
  );
  return rows.map((row) => row.user_id);
}

export async function partitionUsersByRoleKeys(
  userIds: string[],
  roleKeys: RoleKey[]
): Promise<{ withRoles: string[]; withoutRoles: string[] }> {
  const uniqueIds = uniqueUserIds(userIds);
  if (!uniqueIds.length || !roleKeys.length) {
    return { withRoles: [], withoutRoles: uniqueIds };
  }

  const { rows } = await query<{ user_id: string }>(
    `SELECT DISTINCT ur.user_id
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = ANY($1::uuid[])
       AND r.key = ANY($2::text[])`,
    [uniqueIds, roleKeys]
  );

  const withRoleSet = new Set(rows.map((row) => row.user_id));
  const withRoles = uniqueIds.filter((id) => withRoleSet.has(id));
  const withoutRoles = uniqueIds.filter((id) => !withRoleSet.has(id));
  return { withRoles, withoutRoles };
}

export async function createNotifications(input: CreateNotificationsInput): Promise<number> {
  await ensureNotificationSchema();
  const userIds = uniqueUserIds(input.userIds);
  if (!userIds.length) return 0;

  const { rowCount } = await query(
    `WITH target_users AS (
       SELECT DISTINCT UNNEST($1::uuid[]) AS user_id
     )
     INSERT INTO notifications
       (user_id, type, title, message, redirect_url, dedupe_key, metadata)
     SELECT tu.user_id,
            $2,
            $3,
            $4,
            $5,
            CASE WHEN $6::text IS NULL THEN NULL ELSE $6 || ':' || tu.user_id::text END,
            COALESCE($7::jsonb, '{}'::jsonb)
     FROM target_users tu
     JOIN users u ON u.id = tu.user_id
     WHERE u.deleted_at IS NULL
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      userIds,
      input.type,
      input.title,
      input.message,
      input.redirectUrl,
      input.dedupeKey ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );

  return rowCount ?? 0;
}

export async function listNotificationsForUser(
  userId: string,
  options: NotificationListOptions
): Promise<{
  items: NotificationRow[];
  nextCursor: string | null;
  hasUnread: boolean;
  unreadCount: number;
}> {
  await ensureNotificationSchema();
  const decoded = decodeCursor(options.cursor);
  const filters = ['user_id = $1'];
  const params: Array<string | Date> = [userId];
  let idx = params.length;

  if (decoded) {
    idx += 1;
    const createdAtParam = idx;
    params.push(decoded.created_at);
    idx += 1;
    params.push(decoded.id);
    filters.push(`(created_at, id) < ($${createdAtParam}, $${idx})`);
  }

  const { rows } = await query<NotificationRow>(
    `SELECT id,
            user_id,
            type,
            title,
            message,
            redirect_url,
            is_read,
            read_at,
            metadata,
            created_at
     FROM notifications
     WHERE ${filters.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length + 1}`,
    [...params, options.limit + 1]
  );

  const items = rows.slice(0, options.limit);
  const nextCursor = rows.length > options.limit ? encodeCursor(rows[options.limit]) : null;

  const { rows: unreadRows } = await query<{ unread_count: number }>(
    `SELECT COUNT(1)::int AS unread_count
     FROM notifications
     WHERE user_id = $1
       AND is_read = false`,
    [userId]
  );

  const unreadCount = Number(unreadRows[0]?.unread_count ?? 0);
  return {
    items,
    nextCursor,
    hasUnread: unreadCount > 0,
    unreadCount
  };
}

export async function markAllNotificationsRead(userId: string): Promise<number> {
  await ensureNotificationSchema();
  const { rowCount } = await query(
    `UPDATE notifications
     SET is_read = true,
         read_at = now()
     WHERE user_id = $1
       AND is_read = false`,
    [userId]
  );
  return rowCount ?? 0;
}

const getAdminManagerUserIds = async () => getUserIdsByRoleKeys(ADMIN_WORKER_ROLE_KEYS);

export async function notifyResumeTemplateAdded(templateTitle: string) {
  const recipients = await getAllActiveUserIds();
  await createNotifications({
    userIds: recipients,
    type: NOTIFICATION_TYPES.RESUME_TEMPLATE_ADDED,
    title: 'Resume template added',
    message: `A new resume template was added: ${templateTitle}.`,
    redirectUrl: '/resume-templates'
  });
}

export async function notifyProfileCreated(userId: string, profileName: string) {
  await createNotifications({
    userIds: [userId],
    type: NOTIFICATION_TYPES.PROFILE_CREATED,
    title: 'Profile created',
    message: `Your profile "${profileName}" was created.`,
    redirectUrl: '/profiles'
  });
}

export async function notifyAssignBidderToProfile(input: {
  profileId: string;
  profileName: string;
  profileOwnerUserId: string;
  bidderUserId: string;
}) {
  const adminManagerIds = await getAdminManagerUserIds();
  await createNotifications({
    userIds: uniqueUserIds([
      ...adminManagerIds,
      input.profileOwnerUserId,
      input.bidderUserId
    ]),
    type: NOTIFICATION_TYPES.ASSIGN_BIDDER,
    title: 'Bidder assigned',
    message: `A bidder was assigned to profile "${input.profileName}".`,
    redirectUrl: '/profiles',
    metadata: { profile_id: input.profileId, bidder_user_id: input.bidderUserId }
  });
}

export async function notifyAssignBidderRequest(input: { requestId: string }) {
  const adminManagerIds = await getAdminManagerUserIds();
  await createNotifications({
    userIds: adminManagerIds,
    type: NOTIFICATION_TYPES.ASSIGN_BIDDER_REQUEST,
    title: 'Bidder request assigned',
    message: 'A bidder request was assigned.',
    redirectUrl: '/requests',
    metadata: { request_id: input.requestId }
  });
}

async function notifyBidderRequestWithRoleAwareRedirect(input: {
  requestId: string;
  type: NotificationType;
  title: string;
  message: string;
  recipients: string[];
}) {
  const { withRoles: adminManagerRecipients, withoutRoles: userRecipients } =
    await partitionUsersByRoleKeys(input.recipients, ADMIN_WORKER_ROLE_KEYS);

  await Promise.all([
    createNotifications({
      userIds: adminManagerRecipients,
      type: input.type,
      title: input.title,
      message: input.message,
      redirectUrl: '/requests',
      metadata: { request_id: input.requestId }
    }),
    createNotifications({
      userIds: userRecipients,
      type: input.type,
      title: input.title,
      message: input.message,
      redirectUrl: '/profiles',
      metadata: { request_id: input.requestId }
    })
  ]);
}

export async function notifyReassignBidderRequest(input: {
  requestId: string;
  requesterUserId: string;
  currentAssigneeUserId: string | null;
}) {
  const adminManagerIds = await getAdminManagerUserIds();
  const recipients = uniqueUserIds([
    ...adminManagerIds,
    input.requesterUserId,
    input.currentAssigneeUserId
  ]);
  await notifyBidderRequestWithRoleAwareRedirect({
    requestId: input.requestId,
    type: NOTIFICATION_TYPES.REASSIGN_BIDDER_REQUEST,
    title: 'Bidder request reassigned',
    message: 'A bidder request was reassigned.',
    recipients
  });
}

export async function notifyUnassignBidderRequest(input: {
  requestId: string;
  requesterUserId: string;
  previousAssigneeUserId: string | null;
}) {
  const adminManagerIds = await getAdminManagerUserIds();
  const recipients = uniqueUserIds([
    ...adminManagerIds,
    input.requesterUserId,
    input.previousAssigneeUserId
  ]);
  await notifyBidderRequestWithRoleAwareRedirect({
    requestId: input.requestId,
    type: NOTIFICATION_TYPES.UNASSIGN_BIDDER_REQUEST,
    title: 'Bidder request unassigned',
    message: 'A bidder request was unassigned.',
    recipients
  });
}

export async function notifyAssignCallerRequest(input: {
  requestId: string;
  profileOwnerUserId: string;
  assignedCallerUserId: string | null;
}) {
  const adminManagerIds = await getAdminManagerUserIds();
  const recipients = uniqueUserIds([
    ...adminManagerIds,
    input.profileOwnerUserId,
    input.assignedCallerUserId
  ]);

  const { withRoles: adminManagerRecipients, withoutRoles: callerOrUserRecipients } =
    await partitionUsersByRoleKeys(recipients, ADMIN_WORKER_ROLE_KEYS);

  await Promise.all([
    createNotifications({
      userIds: adminManagerRecipients,
      type: NOTIFICATION_TYPES.ASSIGN_CALLER_REQUEST,
      title: 'Caller request assigned',
      message: 'A caller request was assigned.',
      redirectUrl: '/requests',
      metadata: { request_id: input.requestId }
    }),
    createNotifications({
      userIds: callerOrUserRecipients,
      type: NOTIFICATION_TYPES.ASSIGN_CALLER_REQUEST,
      title: 'Caller request assigned',
      message: 'A caller request was assigned.',
      redirectUrl: '/calendar',
      metadata: { request_id: input.requestId }
    })
  ]);
}

export async function notifyCallerRequestDecision(input: {
  requestId: string;
  profileOwnerUserId: string;
  assignedCallerUserId: string | null;
  accepted: boolean;
}) {
  const adminManagerIds = await getAdminManagerUserIds();
  await createNotifications({
    userIds: uniqueUserIds([
      ...adminManagerIds,
      input.profileOwnerUserId,
      input.assignedCallerUserId
    ]),
    type: input.accepted
      ? NOTIFICATION_TYPES.ASSIGN_CALLER_ACCEPTED
      : NOTIFICATION_TYPES.ASSIGN_CALLER_REJECTED,
    title: input.accepted ? 'Caller request accepted' : 'Caller request rejected',
    message: input.accepted
      ? 'A caller request was accepted.'
      : 'A caller request was rejected.',
    redirectUrl: '/calendar',
    metadata: { request_id: input.requestId }
  });
}

export async function notifyTalentAdded(input: {
  talentUserId: string;
  talentRole: 'bidder' | 'caller';
}) {
  const adminManagerIds = await getAdminManagerUserIds();
  await createNotifications({
    userIds: uniqueUserIds([...adminManagerIds, input.talentUserId]),
    type: NOTIFICATION_TYPES.TALENT_ADDED,
    title: 'Talent added',
    message: `A ${input.talentRole} talent was added.`,
    redirectUrl: '/hire-talent',
    metadata: { talent_user_id: input.talentUserId, talent_role: input.talentRole }
  });
}

export async function createInterviewReminderNotifications(offsetMinutes: 30 | 5): Promise<number> {
  await ensureNotificationSchema();

  const type =
    offsetMinutes === 30
      ? NOTIFICATION_TYPES.INTERVIEW_REMINDER_30M
      : NOTIFICATION_TYPES.INTERVIEW_REMINDER_5M;
  const title =
    offsetMinutes === 30
      ? 'Interview in 30 minutes'
      : 'Interview in 5 minutes';

  const { rowCount } = await query(
    `INSERT INTO notifications
       (user_id, type, title, message, redirect_url, dedupe_key, metadata)
     SELECT ce.assigned_user_id,
            $1,
            $2,
            COALESCE(NULLIF(ce.title, ''), 'Interview') || ' starts in ' || $3::text || ' minutes.',
            '/calendar',
            'calendar_reminder:' || ce.id::text || ':' || $3::text || ':' || ce.start_at::text,
            jsonb_build_object('calendar_event_id', ce.id, 'start_at', ce.start_at, 'offset_minutes', $3)
     FROM calendar_events ce
     JOIN talents t
       ON COALESCE(t.user_id, t.id) = ce.assigned_user_id
      AND t.talent_role = 'caller'
     JOIN users u ON u.id = ce.assigned_user_id
     WHERE ce.assigned_user_id IS NOT NULL
       AND ce.start_at IS NOT NULL
       AND u.deleted_at IS NULL
       AND ce.start_at > now() + make_interval(mins => $3::int)
       AND ce.start_at <= now() + make_interval(mins => $3::int) + interval '2 minute'
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [type, title, offsetMinutes]
  );

  return rowCount ?? 0;
}

