export const ROLE_KEYS = {
  CLIENT: 'client',
  ADMIN: 'admin',
  MANAGER: 'manager',
  WORKER: 'worker'
} as const;

export type RoleKey = (typeof ROLE_KEYS)[keyof typeof ROLE_KEYS];

export const ADMIN_MANAGER_ROLE_KEYS: RoleKey[] = [ROLE_KEYS.ADMIN, ROLE_KEYS.MANAGER];
