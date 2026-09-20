import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExternalCredential, PrismaClient } from "@prisma/client";
import {
  beginGitHubOAuth,
  completeGitHubOAuth,
  getGitHubOAuthAvailability,
  GitHubOAuthError,
  githubOAuthPublicUrl,
  githubOAuthStateCookie,
  isGitHubOAuthConfigured,
} from "@/lib/github-oauth";

const USER_ID = "11111111-1111-4111-8111-111111111111";

type Attempt = {
  id: string;
  credentialId: string;
  stateHash: string;
  intent: "login" | "link";
  linkUserId: string | null;
  redirectUri: string;
  returnTo: string;
  remember: boolean;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
};

type IdentityRecord = {
  userId: string;
  githubUserId: bigint;
  login: string;
  email: string;
  displayName: string | null;
  lastLoginAt: Date;
};

type PlatformTokenGrantRecord = {
  id: string;
  userId: string;
  kind: "signup" | "manual";
  amount: number;
  remainingTokens: number;
  offerVersion: string;
  offerAmount?: number | null;
  offerValidForDays?: number | null;
  eligibilityKey?: string | null;
  eligibilitySource?: string | null;
  issuedById: string | null;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type PlatformTokenLedgerEntryRecord = {
  id: string;
  userId: string;
  grantId: string | null;
  reservationId: string | null;
  entryKind: "grant" | "reserve" | "settle" | "release" | "hold" | "adjustment";
  amount: number;
  usageTokens?: number | null;
  reasonCode: string;
  callKey: string | null;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

function fakeDb(initialBootstrap: Readonly<{ initialAdminUserId: string | null }> = {
  initialAdminUserId: "99999999-9999-4999-8999-999999999999",
}) {
  const bootstrap = { ...initialBootstrap };
  const credentials = new Map<string, ExternalCredential>();
  const attempts = new Map<string, Attempt>();
  const identities = new Map<string, { id: string; userId: string; githubUserId: bigint; login: string; email: string; displayName: string | null; lastLoginAt: Date }>();
  const users = new Map<string, { id: string; username: string; role: "admin" | "user"; displayName?: string | null; email?: string | null; emailVerifiedAt?: Date | null; disabledAt: Date | null; accountAccessVersion: number }>();
  const workspaces = new Map<string, { id: string; name: string; slug: string; createdById: string }>();
  const emailVerificationAudits: Array<Record<string, unknown>> = [];
  const memberships: Array<{
    id: string;
    workspaceId: string;
    userId: string;
    role: "owner" | "member";
    accessState: "confirmed";
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  const platformTokenGrants = new Map<string, PlatformTokenGrantRecord>();
  const platformTokenLedgerEntries = new Map<string, PlatformTokenLedgerEntryRecord>();
  const accountEntitlementActivations = new Map<string, Record<string, unknown>>();
  const accountEntitlementActivationAudits: Array<Record<string, unknown>> = [];
  let sequence = 0;
  const user = { id: USER_ID, username: "member", role: "user" as const, emailVerifiedAt: null, disabledAt: null, accountAccessVersion: 1 };
  users.set(user.id, user);

  const tx = {
    $executeRaw: async () => 1,
    platformBootstrap: {
      findUnique: async () => bootstrap,
    },
    appUser: {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) => where.id
        ? users.get(where.id) ?? null
        : [...users.values()].find((item) => item.email === where.email) ?? null,
      count: async ({ where }: { where: { username: string } }) => [...users.values()].filter((item) => item.username === where.username).length,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const current = users.get(where.id);
        if (!current) throw new Error("missing user");
        Object.assign(current, data);
        return current;
      },
      create: async ({ data }: { data: { username: string; displayName: string | null; email: string | null; emailVerifiedAt?: Date | null; role: "user" } }) => {
        const created = { id: `55555555-5555-4555-8555-${String(++sequence).padStart(12, "0")}`, ...data, disabledAt: null, accountAccessVersion: 1 };
        users.set(created.id, created);
        return created;
      },
    },
    workspace: {
      findUnique: async ({ where }: { where: { slug: string } }) => [...workspaces.values()].find((workspace) => workspace.slug === where.slug) ?? null,
      create: async ({ data }: { data: { id: string; name: string; slug: string; createdById: string } }) => {
        const created = { ...data };
        workspaces.set(created.id, created);
        return created;
      },
    },
    workspaceMembership: {
      create: async ({ data }: { data: { workspaceId: string; userId: string; role: "owner" | "member"; accessState: "confirmed" } }) => {
        const now = new Date();
        const created = { id: `66666666-6666-4666-8666-${String(++sequence).padStart(12, "0")}`, ...data, createdAt: now, updatedAt: now };
        memberships.push(created);
        return created;
      },
      findMany: async ({ where }: { where: { workspaceId?: string; userId?: string; accessState?: "confirmed" | { not: "revoked" } } }) =>
        memberships.filter((membership) => (where.workspaceId === undefined || membership.workspaceId === where.workspaceId)
          && (where.userId === undefined || membership.userId === where.userId)
          && (where.accessState === "confirmed" ? membership.accessState === "confirmed" : true)),
      count: async ({ where }: { where: { userId: string; accessState: "confirmed" } }) => memberships.filter((membership) => membership.userId === where.userId && membership.accessState === where.accessState).length,
    },
    membershipAccessAudit: {
      create: async () => ({}),
    },
    appUserEmailVerificationAudit: {
      create: async ({ data }: { data: Record<string, unknown> }) => { emailVerificationAudits.push(data); return data; },
    },
    platformTokenGrant: {
      findUnique: async ({ where }: { where: { userId_kind?: { userId: string; kind: PlatformTokenGrantRecord["kind"] } } }) => where.userId_kind === undefined ? null : [...platformTokenGrants.values()].find((grant) => grant.userId === where.userId_kind!.userId && grant.kind === where.userId_kind!.kind) ?? null,
      findFirst: async ({ where }: { where: { userId: string; kind: PlatformTokenGrantRecord["kind"] } }) => [...platformTokenGrants.values()].find((grant) => grant.userId === where.userId && grant.kind === where.kind) ?? null,
      create: async ({ data }: { data: PlatformTokenGrantRecord }) => {
        const created = { ...data, revokedAt: data.revokedAt ?? null, createdAt: data.createdAt ?? new Date(), updatedAt: data.updatedAt ?? new Date() };
        platformTokenGrants.set(created.id, created);
        return created;
      },
      createMany: async ({ data, skipDuplicates }: { data: Omit<PlatformTokenGrantRecord, "revokedAt" | "createdAt" | "updatedAt">; skipDuplicates?: boolean }) => {
        const duplicate = [...platformTokenGrants.values()].some((grant) => grant.userId === data.userId && grant.kind === data.kind);
        if (duplicate) {
          if (skipDuplicates) return { count: 0 };
          throw new Error("FAKE_PLATFORM_TOKEN_GRANT_UNIQUE");
        }
        const now = new Date();
        platformTokenGrants.set(data.id, { ...data, revokedAt: null, createdAt: now, updatedAt: now });
        return { count: 1 };
      },
      findUniqueOrThrow: async ({ where }: { where: { userId_kind: { userId: string; kind: PlatformTokenGrantRecord["kind"] } } }) => {
        const grant = [...platformTokenGrants.values()].find((candidate) => candidate.userId === where.userId_kind.userId && candidate.kind === where.userId_kind.kind);
        if (grant === undefined) throw new Error("FAKE_PLATFORM_TOKEN_GRANT_NOT_FOUND");
        return grant;
      },
    },
    platformGrantOfferPolicy: {
      findFirst: async () => ({ id: "77777777-7777-4777-8777-777777777777", offerVersion: "signup-500k-v1", amount: 500_000, validForDays: 30, eligibilityKey: "verified_identity_v1" }),
      findUnique: async () => null,
    },
    platformTokenLedgerEntry: {
      createMany: async ({ data, skipDuplicates }: { data: Omit<PlatformTokenLedgerEntryRecord, "createdAt"> | Array<Omit<PlatformTokenLedgerEntryRecord, "createdAt">>; skipDuplicates?: boolean }) => {
        const rows = Array.isArray(data) ? data : [data];
        let count = 0;
        for (const row of rows) {
          const duplicate = [...platformTokenLedgerEntries.values()].some((entry) => entry.idempotencyKey === row.idempotencyKey);
          if (duplicate) {
            if (skipDuplicates) continue;
            throw new Error("FAKE_PLATFORM_TOKEN_LEDGER_UNIQUE");
          }
          platformTokenLedgerEntries.set(row.id, { ...row, createdAt: new Date() });
          count += 1;
        }
        return { count };
      },
      create: async ({ data }: { data: PlatformTokenLedgerEntryRecord }) => {
        if ([...platformTokenLedgerEntries.values()].some((entry) => entry.idempotencyKey === data.idempotencyKey)) throw new Error("FAKE_PLATFORM_TOKEN_LEDGER_UNIQUE");
        platformTokenLedgerEntries.set(data.id, data);
        return data;
      },
    },
    accountEntitlementActivation: {
      findUnique: async ({ where }: { where: { userId_lifecycleKey: { userId: string; lifecycleKey: string } } }) => accountEntitlementActivations.get(`${where.userId_lifecycleKey.userId}:${where.userId_lifecycleKey.lifecycleKey}`) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const created: Record<string, unknown> = { ...data, createdAt: data.createdAt ?? new Date(), mutationTransactionId: data.mutationTransactionId ?? "88888888-8888-4888-8888-888888888888" };
        accountEntitlementActivations.set(`${String(created.userId)}:${String(created.lifecycleKey)}`, created);
        return created;
      },
    },
    accountEntitlementActivationAudit: {
      create: async ({ data }: { data: Record<string, unknown> }) => { accountEntitlementActivationAudits.push(data); return data; },
    },
    appSession: {
      create: async ({ data }: { data: Record<string, unknown> }) => ({ id: `session-${++sequence}`, ...data }),
    },
    externalCredential: {
      create: async ({ data }: { data: Omit<ExternalCredential, "id" | "createdAt" | "updatedAt" | "rotatedAt"> }) => {
        const now = new Date();
        const credential = { id: `22222222-2222-4222-8222-${String(++sequence).padStart(12, "0")}`, ...data, createdAt: now, updatedAt: now, rotatedAt: null } as ExternalCredential;
        credentials.set(credential.id, credential);
        return { id: credential.id, kind: credential.kind, maskedSuffix: credential.maskedSuffix, createdAt: now, updatedAt: now };
      },
      findUnique: async ({ where }: { where: { id: string } }) => credentials.get(where.id) ?? null,
      delete: async ({ where }: { where: { id: string } }) => { credentials.delete(where.id); },
      deleteMany: async () => ({ count: 0 }),
    },
    gitHubOauthAttempt: {
      findMany: async () => [],
      count: async () => attempts.size,
      create: async ({ data }: { data: Omit<Attempt, "id" | "createdAt" | "consumedAt"> }) => {
        const attempt: Attempt = { id: `33333333-3333-4333-8333-${String(++sequence).padStart(12, "0")}`, ...data, consumedAt: null, createdAt: new Date() };
        attempts.set(attempt.id, attempt);
        return attempt;
      },
      findUnique: async ({ where }: { where: { stateHash: string } }) => [...attempts.values()].find((attempt) => attempt.stateHash === where.stateHash) ?? null,
      updateMany: async ({ where, data }: { where: { id: string; consumedAt: null }; data: { consumedAt: Date } }) => {
        const attempt = attempts.get(where.id);
        if (!attempt || attempt.consumedAt !== null) return { count: 0 };
        attempt.consumedAt = data.consumedAt;
        return { count: 1 };
      },
      delete: async ({ where }: { where: { id: string } }) => { attempts.delete(where.id); },
      deleteMany: async () => ({ count: 0 }),
    },
    gitHubIdentity: {
      findUnique: async ({ where, include }: { where: { githubUserId?: bigint; userId?: string }; include?: { user: boolean } }) => {
        const identity = where.githubUserId !== undefined
          ? [...identities.values()].find((item) => item.githubUserId === where.githubUserId)
          : [...identities.values()].find((item) => item.userId === where.userId);
        return identity ? { ...identity, ...(include ? { user: users.get(identity.userId)! } : {}) } : null;
      },
      upsert: async ({ where, create, update }: { where: { userId: string }; create: IdentityRecord; update: Partial<IdentityRecord> }) => {
        const current = [...identities.values()].find((item) => item.userId === where.userId);
        if (current) {
          Object.assign(current, update);
          return current;
        }
        const identity = { id: `44444444-4444-4444-8444-${String(++sequence).padStart(12, "0")}`, ...create };
        identities.set(identity.id, identity);
        return identity;
      },
      create: async ({ data, include }: { data: IdentityRecord; include?: { user: boolean } }) => {
        const identity = { id: `44444444-4444-4444-8444-${String(++sequence).padStart(12, "0")}`, ...data };
        identities.set(identity.id, identity);
        return { ...identity, ...(include ? { user: users.get(identity.userId)! } : {}) };
      },
      update: async ({ where, data, include }: { where: { id: string }; data: Partial<IdentityRecord>; include?: { user: boolean } }) => {
        const identity = identities.get(where.id);
        if (!identity) throw new Error("missing identity");
        Object.assign(identity, data);
        return { ...identity, ...(include ? { user: users.get(identity.userId)! } : {}) };
      },
    },
  };

  const db = {
    ...tx,
    $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx),
  } as unknown as PrismaClient;
  return { db, credentials, attempts, identities, users, workspaces, memberships, platformTokenGrants, platformTokenLedgerEntries, accountEntitlementActivations, accountEntitlementActivationAudits, emailVerificationAudits, bootstrap };
}

test("GitHub OAuth uses PKCE, explicit linking, verified email, and transient token revocation", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ai-project-os-github-oauth-"));
  const originalFetch = globalThis.fetch;
  const originalClientId = process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID;
  const originalClientSecret = process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET;
  const originalPublicOrigin = process.env.AI_PROJECT_OS_PUBLIC_ORIGIN;
  const originalMasterKey = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
  process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID = "Iv1.1234567890";
  process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET = "github-oauth-secret-for-tests";
  process.env.AI_PROJECT_OS_PUBLIC_ORIGIN = "http://127.0.0.1:3000";
  process.env.AI_PROJECT_OS_MASTER_KEY_FILE = join(temp, "master.key");

  try {
    assert.equal(isGitHubOAuthConfigured(), true);
    assert.equal(githubOAuthPublicUrl("/profile").toString(), "http://127.0.0.1:3000/profile");
    const store = fakeDb();
    const begun = await beginGitHubOAuth({
      returnTo: "/profile",
      intent: "link",
      linkUserId: USER_ID,
      remember: false,
    }, store.db);
    const authorization = new URL(begun.authorizationUrl);
    assert.equal(authorization.origin, "https://github.com");
    assert.equal(authorization.pathname, "/login/oauth/authorize");
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorization.searchParams.get("scope"), "read:user user:email");
    assert.equal(authorization.searchParams.get("redirect_uri"), "http://127.0.0.1:3000/api/auth/github/callback");
    assert.equal(authorization.searchParams.get("state"), begun.state);
    assert.equal(authorization.searchParams.has("client_secret"), false);
    assert.match(githubOAuthStateCookie(begun.state, begun.expiresAt), /HttpOnly; SameSite=Lax/u);

    const requests: Array<{ url: string; method: string }> = [];
    let githubUserId = 7;
    let githubLogin = "octocat";
    let githubEmail = "Octocat@GitHub.Test";
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET" });
      if (url.endsWith("/login/oauth/access_token")) {
        assert.match(String(init?.body), /code_verifier=/u);
        return Response.json({ access_token: "github-temporary-access-token", token_type: "bearer", scope: "read:user,user:email" });
      }
      if (url.endsWith("/user/emails")) return Response.json([{ email: githubEmail, primary: true, verified: true }]);
      if (url.endsWith("/user")) return Response.json({ id: githubUserId, login: githubLogin, name: "The Octocat", type: "User" });
      if (url.includes("/applications/") && init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`unexpected request: ${url}`);
    };

    const completed = await completeGitHubOAuth({ code: "github-code", state: begun.state, cookieState: begun.state, sessionUserId: USER_ID }, store.db);
    assert.equal(completed.intent, "link");
    assert.equal(completed.session, null);
    assert.equal(completed.returnTo, "/profile?github=linked");
    assert.equal(store.identities.size, 1);
    assert.equal([...store.identities.values()][0]?.email, "octocat@github.test");
    assert.equal(store.credentials.size, 0);
    assert.equal(store.attempts.size, 0);
    assert.equal(requests.some((request) => request.method === "DELETE" && request.url.includes("/applications/")), true);

    const registrationStore = fakeDb();
    const registration = await beginGitHubOAuth({
      returnTo: "/dashboard",
      intent: "login",
      remember: true,
    }, registrationStore.db);
    const registered = await completeGitHubOAuth({ code: "github-register-code", state: registration.state, cookieState: registration.state }, registrationStore.db);
    assert.equal(registered.session?.user.role, "user");
    assert.equal(registered.session?.user.username, "octocat");
    assert.equal(registrationStore.users.size, 2);
    assert.equal([...registrationStore.users.values()].find((item) => item.username === "octocat")?.role, "user");
    assert.deepEqual(registrationStore.memberships.map((membership) => membership.role), ["owner"]);
    assert.equal(registrationStore.workspaces.size, 1);
    const personalWorkspace = [...registrationStore.workspaces.values()][0];
    assert.equal(personalWorkspace?.createdById, registered.session?.user.id);
    assert.equal(personalWorkspace?.slug, `user-${registered.session?.user.id}`);
    assert.equal(registrationStore.identities.size, 1);
    assert.equal(registrationStore.platformTokenGrants.size, 1);
    const signupGrant = [...registrationStore.platformTokenGrants.values()][0];
    assert.equal(signupGrant?.amount, 500_000);
    assert.equal(signupGrant?.remainingTokens, 500_000);
    assert.equal(signupGrant?.kind, "signup");
    assert.equal(registrationStore.platformTokenLedgerEntries.size, 1);
    const signupLedger = [...registrationStore.platformTokenLedgerEntries.values()][0];
    assert.equal(signupLedger?.amount, 500_000);
    assert.equal(signupLedger?.idempotencyKey, `grant:signup:${registered.session?.user.id}:signup-500k-v1`);

    const registeredUserId = registered.session?.user.id;
    const returning = await beginGitHubOAuth({
      returnTo: "/dashboard?query=hello%20world",
      intent: "login",
      remember: true,
    }, registrationStore.db);
    const signedIn = await completeGitHubOAuth({ code: "github-return-code", state: returning.state, cookieState: returning.state }, registrationStore.db);
    assert.equal(signedIn.session?.user.id, registeredUserId);
    assert.equal(signedIn.returnTo, "/dashboard?query=hello%20world");
    assert.equal(registrationStore.users.size, 2);
    assert.equal(registrationStore.identities.size, 1);
    assert.equal(registrationStore.platformTokenGrants.size, 1);
    assert.equal(registrationStore.platformTokenLedgerEntries.size, 1);

    githubUserId = 9;
    githubLogin = "legacy-member";
    githubEmail = "legacy-member@github.test";
    const legacyStore = fakeDb();
    legacyStore.identities.set("legacy-github-identity", {
      id: "legacy-github-identity",
      userId: USER_ID,
      githubUserId: BigInt(githubUserId),
      login: githubLogin,
      email: githubEmail,
      displayName: "Legacy Member",
      lastLoginAt: new Date(),
    });
    const legacyFlow = await beginGitHubOAuth({
      returnTo: "/dashboard",
      intent: "login",
      remember: true,
    }, legacyStore.db);
    const legacySignedIn = await completeGitHubOAuth({ code: "github-legacy-member-code", state: legacyFlow.state, cookieState: legacyFlow.state }, legacyStore.db);
    assert.equal(legacySignedIn.session?.user.id, USER_ID);
    assert.equal(legacyStore.workspaces.size, 1);
    assert.equal(legacyStore.memberships.length, 1);
    assert.equal(legacyStore.memberships[0]?.role, "owner");
    assert.equal(legacyStore.memberships[0]?.userId, USER_ID);

    githubUserId = 7;
    githubLogin = "octocat";
    githubEmail = "Octocat@GitHub.Test";
    const existingEmailStore = fakeDb();
    existingEmailStore.users.set("66666666-6666-4666-8666-666666666666", {
      id: "66666666-6666-4666-8666-666666666666",
      username: "existing-member",
      role: "user",
      email: "octocat@github.test",
      disabledAt: null,
      accountAccessVersion: 1,
    });
    const existingEmailFlow = await beginGitHubOAuth({
      returnTo: "/dashboard",
      intent: "login",
      remember: true,
    }, existingEmailStore.db);
    await assert.rejects(
      completeGitHubOAuth({ code: "github-existing-email-code", state: existingEmailFlow.state, cookieState: existingEmailFlow.state }, existingEmailStore.db),
      (error: unknown) => error instanceof GitHubOAuthError && error.code === "GITHUB_OAUTH_ACCOUNT_LINK_REQUIRED",
    );
    assert.equal(existingEmailStore.users.size, 2);
    assert.equal(existingEmailStore.identities.size, 0);
    assert.equal(existingEmailStore.platformTokenGrants.size, 0);
    assert.equal(existingEmailStore.platformTokenLedgerEntries.size, 0);

    githubUserId = 8;
    githubLogin = "x";
    githubEmail = "x@github.test";
    const shortLoginStore = fakeDb();
    const shortLoginFlow = await beginGitHubOAuth({
      returnTo: "/dashboard",
      intent: "login",
      remember: true,
    }, shortLoginStore.db);
    const shortLoginRegistration = await completeGitHubOAuth({ code: "github-short-login-code", state: shortLoginFlow.state, cookieState: shortLoginFlow.state }, shortLoginStore.db);
    assert.equal(shortLoginRegistration.session?.user.username, "github-x");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalClientId === undefined) delete process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID; else process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined) delete process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET; else process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET = originalClientSecret;
    if (originalPublicOrigin === undefined) delete process.env.AI_PROJECT_OS_PUBLIC_ORIGIN; else process.env.AI_PROJECT_OS_PUBLIC_ORIGIN = originalPublicOrigin;
    if (originalMasterKey === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE; else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = originalMasterKey;
    await rm(temp, { recursive: true, force: true });
  }
});

test("GitHub OAuth migration bounds return paths without rejecting valid percent encoding", async () => {
  const migration = await readFile(join(process.cwd(), "prisma/migrations/20260902000000_add_github_oauth_login/migration.sql"), "utf8");
  assert.match(migration, /char_length\("returnTo"\) BETWEEN 1 AND 1024/u);
  assert.match(migration, /left\("returnTo", 2\) <> '\/\/'/u);
  assert.doesNotMatch(migration, /\{0,1023\}/u);
});

test("GitHub OAuth stays unavailable for missing or partial deployment configuration", () => {
  const originalClientId = process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID;
  const originalClientSecret = process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET;
  const originalPublicOrigin = process.env.AI_PROJECT_OS_PUBLIC_ORIGIN;
  try {
    delete process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID;
    delete process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET;
    process.env.AI_PROJECT_OS_PUBLIC_ORIGIN = "http://127.0.0.1:3000";
    assert.equal(isGitHubOAuthConfigured(), false);
    assert.equal(githubOAuthPublicUrl("/login").toString(), "http://127.0.0.1:3000/login");
    process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID = "Iv1.1234567890";
    assert.equal(isGitHubOAuthConfigured(), false);
    process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET = "github-oauth-secret-for-tests";
    process.env.AI_PROJECT_OS_PUBLIC_ORIGIN = "http://0.0.0.0:3000";
    assert.equal(isGitHubOAuthConfigured(), false);
    process.env.AI_PROJECT_OS_PUBLIC_ORIGIN = "https://ai-project-os.com";
    assert.equal(isGitHubOAuthConfigured(), true);
  } finally {
    if (originalClientId === undefined) delete process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID; else process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined) delete process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET; else process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET = originalClientSecret;
    if (originalPublicOrigin === undefined) delete process.env.AI_PROJECT_OS_PUBLIC_ORIGIN; else process.env.AI_PROJECT_OS_PUBLIC_ORIGIN = originalPublicOrigin;
  }
});

test("GitHub OAuth rejects a callback without the matching state cookie", async () => {
  const originalClientId = process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID;
  const originalClientSecret = process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET;
  const originalPublicOrigin = process.env.AI_PROJECT_OS_PUBLIC_ORIGIN;
  process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID = "Iv1.1234567890";
  process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET = "github-oauth-secret-for-tests";
  process.env.AI_PROJECT_OS_PUBLIC_ORIGIN = "http://127.0.0.1:3000";
  try {
    await assert.rejects(
      completeGitHubOAuth({ code: "github-code", state: "a".repeat(43), cookieState: "b".repeat(43) }, fakeDb().db),
      (error: unknown) => error instanceof GitHubOAuthError && error.code === "GITHUB_OAUTH_FLOW_INVALID",
    );
  } finally {
    if (originalClientId === undefined) delete process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID; else process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined) delete process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET; else process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET = originalClientSecret;
    if (originalPublicOrigin === undefined) delete process.env.AI_PROJECT_OS_PUBLIC_ORIGIN; else process.env.AI_PROJECT_OS_PUBLIC_ORIGIN = originalPublicOrigin;
  }
});

test("GitHub OAuth fails closed while platform-admin bootstrap is pending, including a callback race", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ai-project-os-github-bootstrap-"));
  const originalFetch = globalThis.fetch;
  const originalClientId = process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID;
  const originalClientSecret = process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET;
  const originalPublicOrigin = process.env.AI_PROJECT_OS_PUBLIC_ORIGIN;
  const originalMasterKey = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
  process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID = "Iv1.1234567890";
  process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET = "github-oauth-secret-for-tests";
  process.env.AI_PROJECT_OS_PUBLIC_ORIGIN = "http://127.0.0.1:3000";
  process.env.AI_PROJECT_OS_MASTER_KEY_FILE = join(temp, "master.key");

  try {
    const store = fakeDb({ initialAdminUserId: null });
    await assert.rejects(
      beginGitHubOAuth({ intent: "login", returnTo: "/login" }, store.db),
      (error: unknown) => error instanceof GitHubOAuthError && error.code === "GITHUB_OAUTH_BOOTSTRAP_PENDING",
    );
    assert.equal(store.attempts.size, 0);
    assert.equal(store.users.size, 1);

    store.bootstrap.initialAdminUserId = "99999999-9999-4999-8999-999999999999";
    const flow = await beginGitHubOAuth({ intent: "login", returnTo: "/dashboard" }, store.db);
    store.bootstrap.initialAdminUserId = null;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/login/oauth/access_token")) return Response.json({ access_token: "github-temporary-access-token", token_type: "bearer", scope: "read:user,user:email" });
      if (url.endsWith("/user/emails")) return Response.json([{ email: "pending@github.test", primary: true, verified: true }]);
      if (url.endsWith("/user")) return Response.json({ id: 42, login: "pending-user", name: "Pending User", type: "User" });
      if (url.includes("/applications/") && init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`unexpected request: ${url}`);
    };

    await assert.rejects(
      completeGitHubOAuth({ code: "github-pending-code", state: flow.state, cookieState: flow.state }, store.db),
      (error: unknown) => error instanceof GitHubOAuthError && error.code === "GITHUB_OAUTH_BOOTSTRAP_PENDING",
    );
    assert.equal(store.users.size, 1);
    assert.equal(store.memberships.length, 0);
    assert.equal(store.platformTokenGrants.size, 0);
    assert.equal(store.identities.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalClientId === undefined) delete process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID; else process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined) delete process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET; else process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET = originalClientSecret;
    if (originalPublicOrigin === undefined) delete process.env.AI_PROJECT_OS_PUBLIC_ORIGIN; else process.env.AI_PROJECT_OS_PUBLIC_ORIGIN = originalPublicOrigin;
    if (originalMasterKey === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE; else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = originalMasterKey;
    await rm(temp, { recursive: true, force: true });
  }
});

test("GitHub OAuth availability exposes only the configuration/bootstrap state", async () => {
  const originalClientId = process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID;
  const originalClientSecret = process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET;
  const originalPublicOrigin = process.env.AI_PROJECT_OS_PUBLIC_ORIGIN;
  try {
    delete process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID;
    delete process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET;
    process.env.AI_PROJECT_OS_PUBLIC_ORIGIN = "https://ai-project-os.com";
    assert.equal((await getGitHubOAuthAvailability()).status, "notConfigured");

    process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID = "Iv1.1234567890";
    assert.equal((await getGitHubOAuthAvailability()).status, "configurationInvalid");

    process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET = "github-oauth-secret-for-tests";
    const pending = fakeDb({ initialAdminUserId: null });
    const pendingAvailability = await getGitHubOAuthAvailability(pending.db);
    assert.deepEqual(pendingAvailability, { status: "bootstrapPending", callbackPath: "/api/auth/github/callback" });

    const available = fakeDb();
    const availableAvailability = await getGitHubOAuthAvailability(available.db);
    assert.deepEqual(availableAvailability, { status: "available", callbackPath: "/api/auth/github/callback" });
    assert.equal(JSON.stringify(availableAvailability).includes("secret"), false);
  } finally {
    if (originalClientId === undefined) delete process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID; else process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined) delete process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET; else process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET = originalClientSecret;
    if (originalPublicOrigin === undefined) delete process.env.AI_PROJECT_OS_PUBLIC_ORIGIN; else process.env.AI_PROJECT_OS_PUBLIC_ORIGIN = originalPublicOrigin;
  }
});
