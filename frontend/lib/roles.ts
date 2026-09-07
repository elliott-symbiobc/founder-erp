/**
 * Shared role constants — import from here instead of using string literals.
 * Add new roles here; update any role-based conditionals to use these constants.
 */
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  VIEWER: "viewer",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/** All valid role values, in descending privilege order. */
export const ALL_ROLES: Role[] = [ROLES.ADMIN, ROLES.USER, ROLES.VIEWER];

/** The least-privileged role — used as the safe default. */
export const DEFAULT_ROLE: Role = ROLES.VIEWER;
