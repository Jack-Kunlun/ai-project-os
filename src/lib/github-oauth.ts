import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Prisma, type GitHubOauthIntent, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { createSession, DEFAULT_WORKSPACE_ID, type CreatedSession } from "@/lib/auth";
import { createCredential, readCredentialSecret } from "@/lib/credential-vault";
import { getDb } from "@/lib/db";
import { canonicalInternalReturnPath } from "@/lib/redirects";

export const GITHUB_OAUTH_STATE_COOKIE_NAME = "ai_project_os_github_oauth_state" as const;

const AUTHORIZATION_ENDPOINT = "https://github.com/login/oauth/authorize";
const TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const USER_ENDPOINT = "https://api.github.com/user";
const EMAILS_ENDPOINT = "https://api.github.com/user/emails";
const GITHUB_API_VERSION = "2026-03-10";
const ATTEMPT_LIFETIME_MS = 10 * 60 * 1_000;
const MAX_ACTIVE_ATTEMPTS = 200;
const ATTEMPT_LOCK_ID = 2_026_090_201;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 64 * 1_024;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STATE_PATTERN = /^[A-Za-z0-9_-]{40,128}$/u;
const CODE_PATTERN = /^[^\s\u0000-\u001f\u007f-\u009f]{4,4096}$/u;

export type GitHubOAuthErrorCode =
  | "GITHUB_OAUTH_NOT_CONFIGURED"
  | "GITHUB_OAUTH_CONFIG_INVALID"
  | "GITHUB_OAUTH_INVALID_INPUT"
  | "GITHUB_OAUTH_FLOW_INVALID"
  | "GITHUB_OAUTH_FLOW_EXPIRED"
  | "GITHUB_OAUTH_PROVIDER_REJECTED"
  | "GITHUB_OAUTH_TOKEN_EXCHANGE_FAILED"
  | "GITHUB_OAUTH_PROFILE_FAILED"
  | "GITHUB_OAUTH_EMAIL_REQUIRED"
  | "GITHUB_OAUTH_TOKEN_REVOCATION_FAILED"
  | "GITHUB_OAUTH_ACCOUNT_LINK_REQUIRED"
  | "GITHUB_OAUTH_IDENTITY_CONFLICT"
  | "GITHUB_OAUTH_ACCOUNT_DISABLED";

export class GitHubOAuthError extends Error {
  constructor(readonly code: GitHubOAuthErrorCode) {
    super(code);
    this.name = "GitHubOAuthError";
  }
}

type GitHubOAuthConfig = Readonly<{ clientId: string; clientSecret: string }>;
type GitHubProfile = Readonly<{ githubUserId: bigint; login: string; email: string; displayName: string | null }>;

const tokenSchema = z.object({
  access_token: z.string().min(8).max(512),
  token_type: z.string().max(32),
  scope: z.string().max(512),
}).passthrough();

const userSchema = z.object({
  id: z.number().int().positive().safe(),
  login: z.string().regex(/^[A-Za-z0-9-]{1,64}$/u),
  name: z.string().max(255).nullable(),
  type: z.literal("User"),
}).passthrough();

const emailSchema = z.array(z.object({
  email: z.string().email().max(320),
  primary: z.boolean(),
  verified: z.boolean(),
}).passthrough()).max(100);

function fail(code: GitHubOAuthErrorCode): never {
  throw new GitHubOAuthError(code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function base64urlSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function readConfig(): GitHubOAuthConfig {
  const clientId = process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID ?? "";
  const clientSecret = process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET ?? "";
  if (clientId.length === 0 && clientSecret.length === 0) return fail("GITHUB_OAUTH_NOT_CONFIGURED");
  if (
    clientId.length < 8 || clientId.length > 512 || !/^[A-Za-z0-9._-]+$/u.test(clientId) ||
    clientSecret.length < 8 || clientSecret.length > 512 || /\s/u.test(clientSecret) || CONTROL_PATTERN.test(clientSecret)
  ) return fail("GITHUB_OAUTH_CONFIG_INVALID");
  return Object.freeze({ clientId, clientSecret });
}

export function isGitHubOAuthConfigured(): boolean {
  try {
    readConfig();
    return true;
  } catch {
    return false;
  }
}

function canonicalRedirectUri(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { return fail("GITHUB_OAUTH_INVALID_INPUT"); }
  if (
    url.pathname !== "/api/auth/github/callback" || url.username.length > 0 || url.password.length > 0 ||
    url.search.length > 0 || url.hash.length > 0 ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  ) return fail("GITHUB_OAUTH_INVALID_INPUT");
  return url.toString();
}

function canonicalIntent(value: unknown): GitHubOauthIntent {
  if (value !== "login" && value !== "link") return fail("GITHUB_OAUTH_INVALID_INPUT");
  return value;
}

function canonicalLinkUserId(value: unknown, intent: GitHubOauthIntent): string | null {
  if (intent === "login") {
    if (value !== null && value !== undefined) return fail("GITHUB_OAUTH_INVALID_INPUT");
    return null;
  }
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return fail("GITHUB_OAUTH_INVALID_INPUT");
  return value;
}

export async function beginGitHubOAuth(
  input: Readonly<{
    redirectUri: string;
    returnTo?: unknown;
    intent: unknown;
    linkUserId?: unknown;
    remember?: unknown;
  }>,
  db: PrismaClient = getDb(),
) {
  const config = readConfig();
  const redirectUri = canonicalRedirectUri(input.redirectUri);
  const returnTo = canonicalInternalReturnPath(input.returnTo);
  const intent = canonicalIntent(input.intent);
  const linkUserId = canonicalLinkUserId(input.linkUserId, intent);
  const remember = input.remember === undefined ? true : input.remember;
  if (typeof remember !== "boolean") return fail("GITHUB_OAUTH_INVALID_INPUT");

  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + ATTEMPT_LIFETIME_MS);

  await db.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${ATTEMPT_LOCK_ID})`);
    const now = new Date();
    if (linkUserId !== null) {
      const user = await tx.appUser.findUnique({ where: { id: linkUserId }, select: { disabledAt: true } });
      if (user === null || user.disabledAt !== null) return fail("GITHUB_OAUTH_ACCOUNT_DISABLED");
    }

    const expired = await tx.gitHubOauthAttempt.findMany({
      where: { expiresAt: { lte: now } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 500,
      select: { id: true, credentialId: true },
    });
    if (expired.length > 0) {
      await tx.gitHubOauthAttempt.deleteMany({ where: { id: { in: expired.map((attempt) => attempt.id) }, expiresAt: { lte: now } } });
      await tx.externalCredential.deleteMany({ where: { id: { in: expired.map((attempt) => attempt.credentialId) }, githubOauthAttempts: { none: {} } } });
    }

    let activeCount = await tx.gitHubOauthAttempt.count({ where: { expiresAt: { gt: now }, consumedAt: null } });
    while (activeCount >= MAX_ACTIVE_ATTEMPTS) {
      const evicted = await tx.gitHubOauthAttempt.findMany({
        where: { expiresAt: { gt: now }, consumedAt: null },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: Math.min(activeCount - MAX_ACTIVE_ATTEMPTS + 1, 500),
        select: { id: true, credentialId: true },
      });
      if (evicted.length === 0) return fail("GITHUB_OAUTH_FLOW_INVALID");
      await tx.gitHubOauthAttempt.deleteMany({ where: { id: { in: evicted.map((attempt) => attempt.id) } } });
      await tx.externalCredential.deleteMany({ where: { id: { in: evicted.map((attempt) => attempt.credentialId) }, githubOauthAttempts: { none: {} } } });
      activeCount -= evicted.length;
    }

    const flowCredential = await createCredential("githubOauthFlow", verifier, tx);
    await tx.gitHubOauthAttempt.create({
      data: { credentialId: flowCredential.id, stateHash: sha256(state), intent, linkUserId, redirectUri, returnTo, remember, expiresAt },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  const authorization = new URL(AUTHORIZATION_ENDPOINT);
  authorization.searchParams.set("client_id", config.clientId);
  authorization.searchParams.set("redirect_uri", redirectUri);
  authorization.searchParams.set("scope", "read:user user:email");
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("code_challenge", base64urlSha256(verifier));
  authorization.searchParams.set("code_challenge_method", "S256");
  return Object.freeze({ authorizationUrl: authorization.toString(), state, expiresAt });
}

async function boundedJsonResponse(response: Response, failureCode: GitHubOAuthErrorCode): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) return fail(failureCode);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_JSON_BYTES) return fail(failureCode);
  if (!response.ok) return fail(failureCode);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return fail(failureCode);
  }
}

function githubApiHeaders(accessToken?: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": GITHUB_API_VERSION,
    "user-agent": "AI-Project-OS",
    ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
  };
}

async function exchangeCode(input: Readonly<{ config: GitHubOAuthConfig; code: string; redirectUri: string; verifier: string }>): Promise<string> {
  const form = new URLSearchParams({
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  });
  try {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "AI-Project-OS" },
      body: form.toString(),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const token = tokenSchema.parse(await boundedJsonResponse(response, "GITHUB_OAUTH_TOKEN_EXCHANGE_FAILED"));
    const scopes = new Set(token.scope.split(",").map((scope) => scope.trim()).filter(Boolean));
    if (token.token_type.toLowerCase() !== "bearer" || !scopes.has("read:user") || !scopes.has("user:email")) {
      return fail("GITHUB_OAUTH_TOKEN_EXCHANGE_FAILED");
    }
    return token.access_token;
  } catch (error) {
    if (error instanceof GitHubOAuthError) throw error;
    return fail("GITHUB_OAUTH_TOKEN_EXCHANGE_FAILED");
  }
}

async function fetchGitHubProfile(accessToken: string): Promise<GitHubProfile> {
  try {
    const init = { headers: githubApiHeaders(accessToken), redirect: "error" as const, cache: "no-store" as const, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
    const [userResponse, emailsResponse] = await Promise.all([fetch(USER_ENDPOINT, init), fetch(EMAILS_ENDPOINT, init)]);
    const [user, emails] = await Promise.all([
      boundedJsonResponse(userResponse, "GITHUB_OAUTH_PROFILE_FAILED").then((value) => userSchema.parse(value)),
      boundedJsonResponse(emailsResponse, "GITHUB_OAUTH_PROFILE_FAILED").then((value) => emailSchema.parse(value)),
    ]);
    const primary = emails.find((email) => email.primary && email.verified);
    if (!primary) return fail("GITHUB_OAUTH_EMAIL_REQUIRED");
    const name = user.name?.trim() ?? "";
    if (CONTROL_PATTERN.test(name)) return fail("GITHUB_OAUTH_PROFILE_FAILED");
    return Object.freeze({
      githubUserId: BigInt(user.id),
      login: user.login,
      email: primary.email.toLowerCase(),
      displayName: name.length > 0 ? name.slice(0, 160) : null,
    });
  } catch (error) {
    if (error instanceof GitHubOAuthError) throw error;
    return fail("GITHUB_OAUTH_PROFILE_FAILED");
  }
}

async function revokeAccessToken(config: GitHubOAuthConfig, accessToken: string): Promise<void> {
  try {
    const response = await fetch(`https://api.github.com/applications/${encodeURIComponent(config.clientId)}/token`, {
      method: "DELETE",
      headers: {
        ...githubApiHeaders(),
        authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ access_token: accessToken }),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status !== 204) return fail("GITHUB_OAUTH_TOKEN_REVOCATION_FAILED");
  } catch (error) {
    if (error instanceof GitHubOAuthError) throw error;
    return fail("GITHUB_OAUTH_TOKEN_REVOCATION_FAILED");
  }
}

async function fetchVerifiedGitHubProfile(input: Readonly<{ config: GitHubOAuthConfig; code: string; redirectUri: string; verifier: string }>): Promise<GitHubProfile> {
  const accessToken = await exchangeCode(input);
  let profile: GitHubProfile | null = null;
  let profileError: unknown = null;
  try {
    profile = await fetchGitHubProfile(accessToken);
  } catch (error) {
    profileError = error;
  }
  await revokeAccessToken(input.config, accessToken);
  if (profileError !== null) throw profileError;
  if (profile === null) return fail("GITHUB_OAUTH_PROFILE_FAILED");
  return profile;
}

async function availableGitHubUsername(login: string, db: Prisma.TransactionClient): Promise<string> {
  const normalized = login.toLowerCase().slice(0, 48);
  const base = normalized.length >= 3 ? normalized : `github-${normalized}`;
  for (let index = 0; index < 100; index += 1) {
    const candidate = index === 0 ? base : `${base.slice(0, 58)}-${index}`;
    if ((await db.appUser.count({ where: { username: candidate } })) === 0) return candidate;
  }
  return `github-${randomBytes(12).toString("hex")}`;
}

export async function completeGitHubOAuth(
  input: Readonly<{ code: unknown; state: unknown; cookieState: unknown; sessionUserId?: unknown }>,
  db: PrismaClient = getDb(),
): Promise<Readonly<{ session: CreatedSession | null; returnTo: string; intent: GitHubOauthIntent; remember: boolean }>> {
  const config = readConfig();
  if (
    typeof input.code !== "string" || !CODE_PATTERN.test(input.code) ||
    typeof input.state !== "string" || !STATE_PATTERN.test(input.state) ||
    typeof input.cookieState !== "string" || !secureEqual(input.state, input.cookieState)
  ) return fail("GITHUB_OAUTH_FLOW_INVALID");

  const attempt = await db.gitHubOauthAttempt.findUnique({ where: { stateHash: sha256(input.state) } });
  if (attempt === null || attempt.consumedAt !== null) return fail("GITHUB_OAUTH_FLOW_INVALID");
  if (attempt.expiresAt <= new Date()) return fail("GITHUB_OAUTH_FLOW_EXPIRED");
  if (attempt.intent === "link" && (typeof input.sessionUserId !== "string" || input.sessionUserId !== attempt.linkUserId)) {
    return fail("GITHUB_OAUTH_FLOW_INVALID");
  }
  const claimed = await db.gitHubOauthAttempt.updateMany({
    where: { id: attempt.id, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  });
  if (claimed.count !== 1) return fail("GITHUB_OAUTH_FLOW_INVALID");

  const verifier = await readCredentialSecret(attempt.credentialId, "githubOauthFlow", db);
  if (!/^[A-Za-z0-9_-]{43,128}$/u.test(verifier)) return fail("GITHUB_OAUTH_FLOW_INVALID");
  const profile = await fetchVerifiedGitHubProfile({ config, code: input.code, redirectUri: attempt.redirectUri, verifier });

  return db.$transaction(async (tx) => {
    const now = new Date();
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${profile.githubUserId.toString()}::text, ${ATTEMPT_LOCK_ID}))`);
    if (attempt.intent === "link") {
      const user = await tx.appUser.findUnique({ where: { id: attempt.linkUserId! } });
      if (user === null || user.disabledAt !== null) return fail("GITHUB_OAUTH_ACCOUNT_DISABLED");
      const [byGitHub, byUser] = await Promise.all([
        tx.gitHubIdentity.findUnique({ where: { githubUserId: profile.githubUserId } }),
        tx.gitHubIdentity.findUnique({ where: { userId: user.id } }),
      ]);
      if ((byGitHub !== null && byGitHub.userId !== user.id) || (byUser !== null && byUser.githubUserId !== profile.githubUserId)) {
        return fail("GITHUB_OAUTH_IDENTITY_CONFLICT");
      }
      await tx.gitHubIdentity.upsert({
        where: { userId: user.id },
        create: { userId: user.id, ...profile, lastLoginAt: now },
        update: { login: profile.login, email: profile.email, displayName: profile.displayName, lastLoginAt: now },
      });
      await tx.gitHubOauthAttempt.delete({ where: { id: attempt.id } });
      await tx.externalCredential.delete({ where: { id: attempt.credentialId } });
      return Object.freeze({ session: null, returnTo: "/profile?github=linked", intent: attempt.intent, remember: attempt.remember });
    }

    let identity = await tx.gitHubIdentity.findUnique({ where: { githubUserId: profile.githubUserId }, include: { user: true } });
    if (identity === null) {
      const emailOwner = await tx.appUser.findUnique({ where: { email: profile.email }, select: { id: true } });
      if (emailOwner !== null) return fail("GITHUB_OAUTH_ACCOUNT_LINK_REQUIRED");
      const user = await tx.appUser.create({
        data: {
          username: await availableGitHubUsername(profile.login, tx),
          displayName: profile.displayName,
          email: profile.email,
          role: "member",
          passwordHash: null,
          passwordSalt: null,
        },
      });
      await tx.workspaceMembership.create({
        data: { workspaceId: DEFAULT_WORKSPACE_ID, userId: user.id, role: "member" },
      });
      identity = await tx.gitHubIdentity.create({
        data: { userId: user.id, ...profile, lastLoginAt: now },
        include: { user: true },
      });
    } else {
      if (identity.user.disabledAt !== null) return fail("GITHUB_OAUTH_ACCOUNT_DISABLED");
      identity = await tx.gitHubIdentity.update({
        where: { id: identity.id },
        data: { login: profile.login, email: profile.email, displayName: profile.displayName, lastLoginAt: now },
        include: { user: true },
      });
    }
    await tx.gitHubOauthAttempt.delete({ where: { id: attempt.id } });
    await tx.externalCredential.delete({ where: { id: attempt.credentialId } });
    const session = await createSession(tx, identity.user);
    return Object.freeze({ session, returnTo: canonicalInternalReturnPath(attempt.returnTo), intent: attempt.intent, remember: attempt.remember });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function githubOAuthFailurePath(state: unknown, db: PrismaClient = getDb()): Promise<string> {
  if (typeof state !== "string" || !STATE_PATTERN.test(state)) return "/login";
  const attempt = await db.gitHubOauthAttempt.findUnique({ where: { stateHash: sha256(state) }, select: { intent: true } });
  return attempt?.intent === "link" ? "/profile" : "/login";
}

export function githubOAuthProviderRejected(): never {
  return fail("GITHUB_OAUTH_PROVIDER_REJECTED");
}

export function githubOAuthStateCookie(state: string, expiresAt: Date): string {
  const secure = process.env.AI_PROJECT_OS_SECURE_COOKIES === "true" ? "; Secure" : "";
  return `${GITHUB_OAUTH_STATE_COOKIE_NAME}=${state}; Path=/api/auth/github/callback; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secure}`;
}

export function expiredGitHubOAuthStateCookie(): string {
  const secure = process.env.AI_PROJECT_OS_SECURE_COOKIES === "true" ? "; Secure" : "";
  return `${GITHUB_OAUTH_STATE_COOKIE_NAME}=; Path=/api/auth/github/callback; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
