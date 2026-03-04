const normalize = (items: string[] | null | undefined): string[] =>
  Array.isArray(items) ? items.map((item) => String(item || "").toLowerCase()) : [];

export const hasRole = (roles: string[] | null | undefined, role: string): boolean =>
  normalize(roles).includes(String(role || "").toLowerCase());

export const hasBadge = (badges: string[] | null | undefined, badge: string): boolean =>
  normalize(badges).includes(String(badge || "").toLowerCase());

export const isAdmin = (roles: string[] | null | undefined): boolean =>
  hasRole(roles, "admin");

export const isWorker = (roles: string[] | null | undefined): boolean =>
  hasRole(roles, "worker");

export const canAccessManagerScope = (user: {
  roles?: string[] | null | undefined;
  badges?: string[] | null | undefined;
} | null | undefined): boolean => {
  if (!user) return false;
  return isAdmin(user.roles) || (isWorker(user.roles) && hasBadge(user.badges, "manager"));
};

