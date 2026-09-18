import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  AuthError,
  changeAccountPassword,
  createPasswordRecord,
  readSessionTokenReadOnly,
  requireApiSessionReadOnly,
  updateAccountProfile,
  updateAccountUsername,
  verifyPasswordRecord,
} from "@/lib/auth";

const userId = "52b01307-72b4-45e3-a57b-230bf5d036c8";
const profileRouteSource = readFileSync(new URL("../src/app/api/profile/route.ts", import.meta.url), "utf8");

function authError(code: string) {
  return (error: unknown) => error instanceof AuthError && error.code === code;
}

test("profile GET uses one read-only repeatable-read snapshot and read-only session authentication", () => {
  const getSource = profileRouteSource.slice(
    profileRouteSource.indexOf("export async function GET"),
    profileRouteSource.indexOf("export async function PATCH"),
  );
  assert.match(getSource, /db\.\$transaction/u);
  assert.match(getSource, /SET TRANSACTION ISOLATION LEVEL REPEATABLE READ/u);
  assert.match(getSource, /SET TRANSACTION READ ONLY/u);
  assert.match(getSource, /clock_timestamp\(\) AT TIME ZONE 'UTC'/u);
  assert.match(getSource, /requireApiSessionReadOnly\(request, tx, current\)/u);
  assert.match(getSource, /getPlatformTokenSummaryInTransaction\(sessionUser\.id, tx, current\)/u);
  assert.doesNotMatch(getSource, /requireApiSession\(request\)/u);
  assert.doesNotMatch(getSource, /getPlatformTokenSummary\(/u);
});

test("read-only session authentication preserves validity checks without touching lastSeenAt", async () => {
  const current = new Date("2026-09-12T00:00:00.000Z");
  let updateCount = 0;
  const db = {
    appSession: {
      findUnique: async () => ({
        id: "00000000-0000-4000-8000-000000000041",
        revokedAt: null,
        expiresAt: new Date("2026-09-13T00:00:00.000Z"),
        lastSeenAt: new Date("2026-09-01T00:00:00.000Z"),
        accountAccessVersion: 1,
        user: {
          id: userId,
          username: "owner",
          role: "user" as const,
          disabledAt: null,
          accountAccessVersion: 1,
        },
      }),
      updateMany: async () => {
        updateCount += 1;
        throw new Error("read-only session authentication attempted a write");
      },
    },
    appUser: {
      findUnique: async () => ({ id: userId, disabledAt: null, accountAccessVersion: 1 }),
    },
  } as unknown as PrismaClient;
  const token = "a".repeat(40);
  const direct = await readSessionTokenReadOnly(token, db, current);
  const required = await requireApiSessionReadOnly(
    new Request("http://127.0.0.1:3000/api/profile", {
      method: "GET",
      headers: { cookie: `ai_project_os_session=${token}` },
    }),
    db,
    current,
  );
  assert.equal(direct?.id, userId);
  assert.equal(required.id, userId);
  assert.equal(updateCount, 0);
});

test("password rotation verifies the current password, replaces the digest, and revokes all sessions", async () => {
  let password = await createPasswordRecord("CurrentPassword123");
  let revokedSessions = 0;
  const tx = {
    appUser: {
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: typeof password }) => {
        const matches = where.id === userId && where.passwordHash === password.passwordHash && where.passwordSalt === password.passwordSalt;
        if (!matches) return { count: 0 };
        password = data;
        return { count: 1 };
      },
    },
    appSession: {
      updateMany: async () => { revokedSessions += 3; return { count: 3 }; },
    },
  };
  const db = {
    appUser: {
      findUnique: async () => ({ id: userId, ...password }),
    },
    $transaction: async (operation: (client: typeof tx) => Promise<void>) => operation(tx),
  } as unknown as PrismaClient;

  await changeAccountPassword(userId, "CurrentPassword123", "NextPassword456", db);

  assert.equal(await verifyPasswordRecord("CurrentPassword123", password), false);
  assert.equal(await verifyPasswordRecord("NextPassword456", password), true);
  assert.equal(revokedSessions, 3);
});

test("password rotation rejects a wrong or unchanged password before mutating account state", async () => {
  const password = await createPasswordRecord("CurrentPassword123");
  let mutationCount = 0;
  const db = {
    appUser: { findUnique: async () => ({ id: userId, ...password }) },
    $transaction: async () => { mutationCount += 1; },
  } as unknown as PrismaClient;

  await assert.rejects(
    changeAccountPassword(userId, "WrongPassword123", "NextPassword456", db),
    authError("AUTH_CURRENT_PASSWORD_INVALID"),
  );
  await assert.rejects(
    changeAccountPassword(userId, "CurrentPassword123", "CurrentPassword123", db),
    authError("AUTH_PASSWORD_UNCHANGED"),
  );
  assert.equal(mutationCount, 0);
});

test("username update applies the canonical login-name boundary", async () => {
  let storedUsername = "owner";
  const db = {
    appUser: {
      update: async ({ data }: { data: { username: string } }) => {
        storedUsername = data.username;
        return { id: userId, username: storedUsername, role: "admin" as const, accountAccessVersion: 1 };
      },
    },
  } as unknown as PrismaClient;

  const updated = await updateAccountUsername(userId, "project.owner", db);
  assert.equal(updated.username, "project.owner");
  await assert.rejects(updateAccountUsername(userId, " project.owner", db), authError("AUTH_INVALID_INPUT"));
  assert.equal(storedUsername, "project.owner");
});

test("profile mutation endpoint rejects cross-origin requests before account access", async () => {
  const { PATCH } = await import("@/app/api/profile/route");
  const body = JSON.stringify({ action: "updateUsername", username: "owner" });
  const crossOrigin = await PATCH(new Request("http://127.0.0.1:3000/api/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json", host: "127.0.0.1:3000", origin: "https://example.invalid" },
    body,
  }));
  assert.equal(crossOrigin.status, 403);
});

test("profile keeps verification for same email and clears it for an actual email change", async () => {
  const verifiedAt = new Date("2026-09-01T00:00:00.000Z");
  const record: { id: string; displayName: string | null; email: string | null; emailVerifiedAt: Date | null } = {
    id: userId,
    displayName: "Owner",
    email: "owner@example.com",
    emailVerifiedAt: verifiedAt,
  };
  const audits: Array<Record<string, unknown>> = [];
  const tx = {
    $executeRaw: async () => 1,
    appUser: {
      findUnique: async () => ({ ...record }),
      update: async ({ data }: { data: Partial<typeof record> }) => {
        Object.assign(record, data);
        return { ...record };
      },
    },
    appUserEmailVerificationAudit: {
      create: async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); return data; },
    },
  };
  const db = {
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;

  const unchanged = await updateAccountProfile(userId, { displayName: "Owner 2", email: "owner@example.com" }, db);
  assert.equal(unchanged.emailVerifiedAt?.toISOString(), verifiedAt.toISOString());
  assert.equal(audits.length, 0);

  const changed = await updateAccountProfile(userId, { displayName: "Owner 2", email: "new-owner@example.com" }, db);
  assert.equal(changed.email, "new-owner@example.com");
  assert.equal(changed.emailVerifiedAt, null);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.event, "unverified");
  assert.equal("email" in (audits[0] ?? {}), false);
});
