export const ROLE_KEYS = {
  USER: 'user',
  ADMIN: 'admin',
  WORKER: 'worker'
} as const;

export type RoleKey = (typeof ROLE_KEYS)[keyof typeof ROLE_KEYS];

export const ADMIN_WORKER_ROLE_KEYS: RoleKey[] = [ROLE_KEYS.ADMIN, ROLE_KEYS.WORKER];
