import type { AppUserRole } from "@prisma/client";

/** The stable system-role vocabulary exposed outside the persistence layer. */
export type SystemRole = "admin" | "user";

/** Canonicalize the persisted system role into the public role vocabulary. */
export function toSystemRole(role: AppUserRole): SystemRole {
  switch (role) {
    case "admin":
      return "admin";
    case "user":
      return "user";
    default: {
      const exhaustiveRole: never = role;
      throw new Error(`UNSUPPORTED_APP_USER_ROLE:${String(exhaustiveRole)}`);
    }
  }
}
