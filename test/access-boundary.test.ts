import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { AccessControlError, authorizeApiRequest, classifyApiPath } from "../src/lib/access-control";

const admin = { id: "11111111-1111-4111-8111-111111111111", role: "admin" as const, accountAccessVersion: 1 };
const user = { id: "22222222-2222-4222-8222-222222222222", role: "user" as const, accountAccessVersion: 1 };

function dbFor(actor: typeof admin | typeof user): PrismaClient {
  return {
    appUser: {
      findUnique: async () => ({ id: actor.id, disabledAt: null, accountAccessVersion: 1 }),
    },
  } as unknown as PrismaClient;
}

function request(path: string, method = "GET"): Request {
  return new Request(`http://127.0.0.1${path}`, { method });
}

async function assertForbidden(actor: typeof admin | typeof user, path: string): Promise<void> {
  await assert.rejects(
    () => authorizeApiRequest(actor, request(path), dbFor(actor)),
    (error: unknown) => error instanceof AccessControlError && error.code === "ACCESS_FORBIDDEN",
  );
}

test("API namespace classifier keeps platform, user, shared, public, and unknown paths distinct", () => {
  assert.equal(classifyApiPath("/api/admin/users"), "platform");
  assert.equal(classifyApiPath("/api/system/audit"), "platform");
  assert.equal(classifyApiPath("/api/settings/providers"), "platform");
  assert.equal(classifyApiPath("/api/settings/git-connections"), "deprecated");
  assert.equal(classifyApiPath("/api/projects/11111111-1111-4111-8111-111111111111"), "ordinary-user");
  assert.equal(classifyApiPath("/api/profile/membership-applications/preview"), "ordinary-user");
  assert.equal(classifyApiPath("/api/auth/session"), "shared");
  assert.equal(classifyApiPath("/api/profile/"), "ordinary-user");
  assert.equal(classifyApiPath("/api/health"), "public");
  assert.equal(classifyApiPath("/api/future"), "unknown");
});

test("ordinary users cannot enter platform namespaces while retaining unknown and business API compatibility", async () => {
  await assertForbidden(user, "/api/admin/credits/grants");
  await assertForbidden(user, "/api/system/audit");
  await assertForbidden(user, "/api/settings/providers");
  await authorizeApiRequest(user, request("/api/dashboard"), dbFor(user));
  await authorizeApiRequest(user, request("/api/profile"), dbFor(user));
  await authorizeApiRequest(user, request("/api/future"), dbFor(user));
});

test("admins use the independent platform account API and cannot enter user APIs or unknown namespaces", async () => {
  await authorizeApiRequest(admin, request("/api/admin/credits/grants"), dbFor(admin));
  await authorizeApiRequest(admin, request("/api/system/audit"), dbFor(admin));
  await authorizeApiRequest(admin, request("/api/settings/providers"), dbFor(admin));
  await authorizeApiRequest(admin, request("/api/auth/session"), dbFor(admin));
  await authorizeApiRequest(admin, request("/api/admin/account"), dbFor(admin));
  await assertForbidden(admin, "/api/profile");
  await assertForbidden(admin, "/api/settings/git-connections");
  await assertForbidden(admin, "/api/dashboard");
  await assertForbidden(admin, "/api/projects/11111111-1111-4111-8111-111111111111");
  await assertForbidden(admin, "/api/me/ai-providers");
  await assertForbidden(admin, "/api/notifications");
  await assertForbidden(admin, "/api/profile/membership-applications/preview");
  await assertForbidden(admin, "/api/future");
});

test("page guards use separate base, user, and admin entry points", async () => {
  const auth = await readFile("src/lib/auth.ts", "utf8");
  const systemAdmin = await readFile("src/lib/system-admin.ts", "utf8");
  assert.match(auth, /export async function requireAuthenticatedPageSession/u);
  assert.match(auth, /export async function requireUserPageSession/u);
  assert.match(auth, /if \(user\.role === "admin"\) redirect\("\/admin"\)/u);
  assert.match(systemAdmin, /requireAuthenticatedPageSession\(\)/u);
  assert.doesNotMatch(systemAdmin, /requirePageSession\(\)/u);
});
