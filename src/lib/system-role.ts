import type { AppUserRole } from "@prisma/client";

/** The stable system-role vocabulary exposed outside the persistence layer. */
export type SystemRole = "admin" | "user";

/**
 * Canonicalize the persisted role while the legacy `member` value remains in
 * the database. This mapper is intentionally exhaustive so a future enum
 * value cannot silently become a public role.
 */
export function toSystemRole(role: AppUserRole): SystemRole {
  switch (role) {
    case "admin":
      return "admin";
    case "member":
    case "user":
      return "user";
    default: {
      const exhaustiveRole: never = role;
      throw new Error(`UNSUPPORTED_APP_USER_ROLE:${String(exhaustiveRole)}`);
    }
  }
}
