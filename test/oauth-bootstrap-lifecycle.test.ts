import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { beginOidcLogin, OidcError } from "@/lib/oidc";

const PROVIDER_ID = "11111111-1111-4111-8111-111111111111";

function fakeOidcDb(bootstrap: Readonly<{ initialAdminUserId: string | null }>) {
  let providerLookups = 0;
  const tx = {
    $executeRaw: async () => 1,
    platformBootstrap: { findUnique: async () => bootstrap },
    oidcProvider: { findUnique: async () => { providerLookups += 1; return null; } },
  };
  const db = {
    ...tx,
    $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx),
  } as unknown as PrismaClient;
  return { db, get providerLookups() { return providerLookups; } };
}

test("OIDC start fails closed before provider lookup while platform admin bootstrap is pending", async () => {
  const store = fakeOidcDb({ initialAdminUserId: null });
  await assert.rejects(
    beginOidcLogin({ providerId: PROVIDER_ID, redirectUri: "http://127.0.0.1:3000/api/auth/oidc/callback" }, store.db),
    (error: unknown) => error instanceof OidcError && error.code === "OIDC_PROVIDER_NOT_VERIFIED",
  );
  assert.equal(store.providerLookups, 0);
});

test("OIDC start no longer requires a global/default-workspace Owner", async () => {
  const store = fakeOidcDb({ initialAdminUserId: "22222222-2222-4222-8222-222222222222" });
  await assert.rejects(
    beginOidcLogin({ providerId: PROVIDER_ID, redirectUri: "http://127.0.0.1:3000/api/auth/oidc/callback" }, store.db),
    (error: unknown) => error instanceof OidcError && error.code === "OIDC_PROVIDER_NOT_FOUND",
  );
  assert.equal(store.providerLookups, 1);
});

test("OIDC callback keeps the bootstrap fence inside its write transaction", async () => {
  const source = await readFile("src/lib/oidc.ts", "utf8");
  assert.match(
    source,
    /export async function completeOidcLogin[\s\S]*?return db\.\$transaction\(async \(tx\) => \{\s*await assertPlatformBootstrapReady\(tx\);[\s\S]*?tx\.appUser\.create/u,
  );
  assert.match(source, /SELECT pg_advisory_xact_lock\(\$\{PLATFORM_BOOTSTRAP_LOCK_ID\}\)/u);
  assert.match(source, /personalWorkspaceName\(user\.username\)/u);
  assert.match(source, /where: \{ slug: `user-\$\{user\.id\}` \}/u);
  assert.doesNotMatch(source, /initialOwnerUserId|adminOnboardingCompletedAt/u);
  assert.doesNotMatch(source, /DEFAULT_WORKSPACE_ID/u);
});
