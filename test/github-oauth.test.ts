import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExternalCredential, PrismaClient } from "@prisma/client";
import {
  beginGitHubOAuth,
  completeGitHubOAuth,
  GitHubOAuthError,
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

function fakeDb() {
  const credentials = new Map<string, ExternalCredential>();
  const attempts = new Map<string, Attempt>();
  const identities = new Map<string, { id: string; userId: string; githubUserId: bigint; login: string; email: string; displayName: string | null; lastLoginAt: Date }>();
  const users = new Map<string, { id: string; username: string; role: "admin" | "member"; displayName?: string | null; email?: string | null; disabledAt: Date | null }>();
  const memberships: Array<{ workspaceId: string; userId: string; role: "member" }> = [];
  let sequence = 0;
  const user = { id: USER_ID, username: "admin", role: "admin" as const, disabledAt: null };
  users.set(user.id, user);

  const tx = {
    $executeRaw: async () => 1,
    appUser: {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) => where.id
        ? users.get(where.id) ?? null
        : [...users.values()].find((item) => item.email === where.email) ?? null,
      count: async ({ where }: { where: { username: string } }) => [...users.values()].filter((item) => item.username === where.username).length,
      create: async ({ data }: { data: { username: string; displayName: string | null; email: string; role: "member" } }) => {
        const created = { id: `55555555-5555-4555-8555-${String(++sequence).padStart(12, "0")}`, ...data, disabledAt: null };
        users.set(created.id, created);
        return created;
      },
    },
    workspaceMembership: {
      create: async ({ data }: { data: { workspaceId: string; userId: string; role: "member" } }) => { memberships.push(data); return data; },
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
  return { db, credentials, attempts, identities, users, memberships };
}

test("GitHub OAuth uses PKCE, explicit linking, verified email, and transient token revocation", async () => {
  const temp = await mkdtemp(join(tmpdir(), "ai-project-os-github-oauth-"));
  const originalFetch = globalThis.fetch;
  const originalClientId = process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID;
  const originalClientSecret = process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET;
  const originalMasterKey = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
  process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID = "Iv1.1234567890";
  process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET = "github-oauth-secret-for-tests";
  process.env.AI_PROJECT_OS_MASTER_KEY_FILE = join(temp, "master.key");

  try {
    assert.equal(isGitHubOAuthConfigured(), true);
    const store = fakeDb();
    const begun = await beginGitHubOAuth({
      redirectUri: "http://127.0.0.1:3000/api/auth/github/callback",
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
      redirectUri: "http://127.0.0.1:3000/api/auth/github/callback",
      returnTo: "/dashboard",
      intent: "login",
      remember: true,
    }, registrationStore.db);
    const registered = await completeGitHubOAuth({ code: "github-register-code", state: registration.state, cookieState: registration.state }, registrationStore.db);
    assert.equal(registered.session?.user.role, "member");
    assert.equal(registered.session?.user.username, "octocat");
    assert.equal(registrationStore.users.size, 2);
    assert.deepEqual(registrationStore.memberships.map((membership) => membership.role), ["member"]);
    assert.equal(registrationStore.identities.size, 1);

    const registeredUserId = registered.session?.user.id;
    const returning = await beginGitHubOAuth({
      redirectUri: "http://127.0.0.1:3000/api/auth/github/callback",
      returnTo: "/dashboard?query=hello%20world",
      intent: "login",
      remember: true,
    }, registrationStore.db);
    const signedIn = await completeGitHubOAuth({ code: "github-return-code", state: returning.state, cookieState: returning.state }, registrationStore.db);
    assert.equal(signedIn.session?.user.id, registeredUserId);
    assert.equal(signedIn.returnTo, "/dashboard?query=hello%20world");
    assert.equal(registrationStore.users.size, 2);
    assert.equal(registrationStore.identities.size, 1);

    const existingEmailStore = fakeDb();
    existingEmailStore.users.set("66666666-6666-4666-8666-666666666666", {
      id: "66666666-6666-4666-8666-666666666666",
      username: "existing-member",
      role: "member",
      email: "octocat@github.test",
      disabledAt: null,
    });
    const existingEmailFlow = await beginGitHubOAuth({
      redirectUri: "http://127.0.0.1:3000/api/auth/github/callback",
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

    githubUserId = 8;
    githubLogin = "x";
    githubEmail = "x@github.test";
    const shortLoginStore = fakeDb();
    const shortLoginFlow = await beginGitHubOAuth({
      redirectUri: "http://127.0.0.1:3000/api/auth/github/callback",
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
  try {
    delete process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID;
    delete process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET;
    assert.equal(isGitHubOAuthConfigured(), false);
    process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID = "Iv1.1234567890";
    assert.equal(isGitHubOAuthConfigured(), false);
  } finally {
    if (originalClientId === undefined) delete process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID; else process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined) delete process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET; else process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET = originalClientSecret;
  }
});

test("GitHub OAuth rejects a callback without the matching state cookie", async () => {
  const originalClientId = process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID;
  const originalClientSecret = process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET;
  process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID = "Iv1.1234567890";
  process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET = "github-oauth-secret-for-tests";
  try {
    await assert.rejects(
      completeGitHubOAuth({ code: "github-code", state: "a".repeat(43), cookieState: "b".repeat(43) }, fakeDb().db),
      (error: unknown) => error instanceof GitHubOAuthError && error.code === "GITHUB_OAUTH_FLOW_INVALID",
    );
  } finally {
    if (originalClientId === undefined) delete process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID; else process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined) delete process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET; else process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET = originalClientSecret;
  }
});
