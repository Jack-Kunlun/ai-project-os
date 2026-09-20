import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Prisma, type GitHubOauthIntent, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { appendEmailVerificationAudit, createSessionInTransaction, setVerifiedAccountEmail, type CreatedSession } from "@/lib/auth";
import { createCredential, readCredentialSecret } from "@/lib/credential-vault";
import { assertEntitlementWriterSession, getDb, getEntitlementDb, isEntitlementDatabase } from "@/lib/db";
import { canonicalInternalReturnPath } from "@/lib/redirects";
import { lockActorAccess, lockWorkspaceAccess } from "@/lib/access-linearization";
import {
  findCurrentWorkspaceMembership,
  grantWorkspaceMembership,
} from "@/lib/membership-governance";
import { activateAccountEntitlements } from "@/lib/account-entitlement-activation-service";
import { withSerializableRetry } from "@/lib/prisma-transaction";

export const GITHUB_OAUTH_STATE_COOKIE_NAME = "ai_project_os_github_oauth_state" as const;

const AUTHORIZATION_ENDPOINT = "https://github.com/login/oauth/authorize";
const TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const USER_ENDPOINT = "https://api.github.com/user";
const EMAILS_ENDPOINT = "https://api.github.com/user/emails";
const GITHUB_API_VERSION = "2026-03-10";
const ATTEMPT_LIFETIME_MS = 10 * 60 * 1_000;
const MAX_ACTIVE_ATTEMPTS = 200;
const ATTEMPT_LOCK_ID = 2_026_090_201;
const PLATFORM_BOOTSTRAP_LOCK_ID = 781452903;
const MAX_GITHUB_OAUTH_UNIQUE_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_JSON_BYTES = 64 * 1_024;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STATE_PATTERN = /^[A-Za-z0-9_-]{40,128}$/u;
const CODE_PATTERN = /^[^\s\u0000-\u001f\u007f-\u009f]{4,4096}$/u;

export type GitHubOAuthErrorCode =
  | "GITHUB_OAUTH_NOT_CONFIGURED"
  | "GITHUB_OAUTH_CONFIG_INVALID"
  | "GITHUB_OAUTH_BOOTSTRAP_PENDING"
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
  | "GITHUB_OAUTH_MEMBERSHIP_REVIEW_REQUIRED"
  | "GITHUB_OAUTH_ACCOUNT_DISABLED";

export class GitHubOAuthError extends Error {
  constructor(readonly code: GitHubOAuthErrorCode) {
    super(code);
    this.name = "GitHubOAuthError";
  }
}

export type GitHubOAuthAvailability = "notConfigured" | "configurationInvalid" | "bootstrapPending" | "available";

export type GitHubOAuthAvailabilityProjection = Readonly<{
  status: GitHubOAuthAvailability;
  callbackPath: "/api/auth/github/callback";
}>;

type GitHubOAuthConfig = Readonly<{ clientId: string; clientSecret: string; publicOrigin: string }>;
type GitHubProfile = Readonly<{ githubUserId: bigint; login: string; email: string; displayName: string | null }>;
type GitHubOAuthBootstrapClient = Readonly<{
  platformBootstrap: Readonly<{
    findUnique: (args: Readonly<{ where: Readonly<{ id: string }>; select: Readonly<{ initialAdminUserId: true }> }>) => Promise<Readonly<{ initialAdminUserId: string | null }> | null>;
  }>;
}>;

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

function readPublicOrigin(): string {
  const configuredPublicOrigin = process.env.AI_PROJECT_OS_PUBLIC_ORIGIN ?? "";
  let publicUrl: URL;
  try { publicUrl = new URL(configuredPublicOrigin); } catch { return fail("GITHUB_OAUTH_CONFIG_INVALID"); }
  if (
    publicUrl.pathname !== "/" || publicUrl.username.length > 0 || publicUrl.password.length > 0 ||
    publicUrl.search.length > 0 || publicUrl.hash.length > 0 ||
    (publicUrl.protocol !== "https:" && !(publicUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname)))
  ) return fail("GITHUB_OAUTH_CONFIG_INVALID");
  return publicUrl.origin;
}

function readConfig(): GitHubOAuthConfig {
  const clientId = process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_ID ?? "";
  const clientSecret = process.env.AI_PROJECT_OS_GITHUB_OAUTH_CLIENT_SECRET ?? "";
  if (clientId.length === 0 && clientSecret.length === 0) return fail("GITHUB_OAUTH_NOT_CONFIGURED");
  if (
    clientId.length < 8 || clientId.length > 512 || !/^[A-Za-z0-9._-]+$/u.test(clientId) ||
    clientSecret.length < 8 || clientSecret.length > 512 || /\s/u.test(clientSecret) || CONTROL_PATTERN.test(clientSecret)
  ) return fail("GITHUB_OAUTH_CONFIG_INVALID");
  return Object.freeze({ clientId, clientSecret, publicOrigin: readPublicOrigin() });
}

export function isGitHubOAuthConfigured(): boolean {
  try {
    readConfig();
    return true;
  } catch {
    return false;
  }
}

/**
 * Public pages may expose only this four-state projection. It never returns
 * environment values or a bootstrap row identifier. A failed bootstrap read
 * is intentionally fail-closed as pending so the login UI cannot invite a
 * doomed OAuth flow.
 */
export async function getGitHubOAuthAvailability(
  db?: PrismaClient,
): Promise<GitHubOAuthAvailabilityProjection> {
  let configuration: GitHubOAuthAvailability;
  try {
    readConfig();
    configuration = "available";
  } catch (error) {
    configuration = error instanceof GitHubOAuthError && error.code === "GITHUB_OAUTH_NOT_CONFIGURED" ? "notConfigured" : "configurationInvalid";
  }
  if (configuration !== "available") return Object.freeze({ status: configuration, callbackPath: "/api/auth/github/callback" });
  try {
    const database = (db ?? getDb()) as unknown as GitHubOAuthBootstrapClient;
    const bootstrap = await database.platformBootstrap.findUnique({ where: { id: "platform" }, select: { initialAdminUserId: true } });
    if (bootstrap === null || bootstrap.initialAdminUserId === null) {
      return Object.freeze({ status: "bootstrapPending", callbackPath: "/api/auth/github/callback" });
    }
  } catch {
    return Object.freeze({ status: "bootstrapPending", callbackPath: "/api/auth/github/callback" });
  }
  return Object.freeze({ status: "available", callbackPath: "/api/auth/github/callback" });
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

/**
 * GitHub login is a user-domain capability. Keep the platform-admin bootstrap
 * fence in the same transaction as the eventual account/membership/entitlement
 * writes so a callback cannot race application initialization.
 */
async function assertPlatformBootstrapReady(db: Prisma.TransactionClient): Promise<void> {
  await db.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${PLATFORM_BOOTSTRAP_LOCK_ID})`);
  const bootstrap = await db.platformBootstrap.findUnique({
    where: { id: "platform" },
    select: { initialAdminUserId: true },
  });
  if (bootstrap === null || bootstrap.initialAdminUserId === null) {
    return fail("GITHUB_OAUTH_BOOTSTRAP_PENDING");
  }
}

export async function beginGitHubOAuth(
  input: Readonly<{
    returnTo?: unknown;
    intent: unknown;
    linkUserId?: unknown;
    remember?: unknown;
  }>,
  db: PrismaClient = getDb(),
) {
  const config = readConfig();
  const redirectUri = new URL("/api/auth/github/callback", `${config.publicOrigin}/`).toString();
  const returnTo = canonicalInternalReturnPath(input.returnTo);
  const intent = canonicalIntent(input.intent);
  const linkUserId = canonicalLinkUserId(input.linkUserId, intent);
  const remember = input.remember === undefined ? true : input.remember;
  if (typeof remember !== "boolean") return fail("GITHUB_OAUTH_INVALID_INPUT");

  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + ATTEMPT_LIFETIME_MS);

  await db.$transaction(async (tx) => {
    await assertPlatformBootstrapReady(tx);
    if (linkUserId !== null) await lockActorAccess(tx, linkUserId);
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${ATTEMPT_LOCK_ID})`);
    const now = new Date();
    if (linkUserId !== null) {
      const user = await tx.appUser.findUnique({ where: { id: linkUserId }, select: { disabledAt: true, role: true } });
      if (user === null || user.disabledAt !== null) return fail("GITHUB_OAUTH_ACCOUNT_DISABLED");
      if (user.role !== "user") return fail("GITHUB_OAUTH_ACCOUNT_LINK_REQUIRED");
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

export function githubOAuthPublicUrl(path: unknown): URL {
  return new URL(canonicalInternalReturnPath(path, "/"), `${readPublicOrigin()}/`);
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

function personalWorkspaceName(username: string): string {
  return `${username} 的工作区`;
}

function isGitHubSignupUniqueConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  const target = error.meta && typeof error.meta === "object" && "target" in error.meta
    ? (error.meta as { target?: unknown }).target
    : undefined;
  const targetName = Array.isArray(target) && target.length === 1
    ? target[0]
    : typeof target === "string"
      ? target
      : undefined;
  const metaRecord = error.meta && typeof error.meta === "object" ? error.meta as Record<string, unknown> : null;
  const driverAdapterError = metaRecord?.driverAdapterError;
  const cause = driverAdapterError && typeof driverAdapterError === "object"
    ? (driverAdapterError as Record<string, unknown>).cause
    : null;
  const constraint = cause && typeof cause === "object"
    ? (cause as Record<string, unknown>).constraint
    : null;
  const constraintName = constraint && typeof constraint === "object"
    ? (constraint as Record<string, unknown>).index
    : undefined;
  return [targetName, constraintName].some((name) => typeof name === "string" && [
    "email",
    "username",
    "githubUserId",
    "userId",
    "AppUser_email_key",
    "AppUser_username_key",
    "GitHubIdentity_githubUserId_key",
    "GitHubIdentity_userId_key",
    "Workspace_slug_key",
  ].includes(name));
}

/**
 * Existing GitHub identities may predate personal workspaces.  A returning
 * login repairs that legacy state only after the user already has at least one
 * confirmed membership (checked by the caller), and never changes that
 * existing membership.  The actor lock is held by the caller before this
 * helper is entered; the workspace lock is therefore always acquired second.
 */
async function ensurePersonalWorkspaceForExistingIdentity(
  db: Prisma.TransactionClient,
  user: Readonly<{ id: string; username: string }>,
): Promise<void> {
  const slug = `user-${user.id}`;
  const existing = await db.workspace.findUnique({
    where: { slug },
    select: { id: true, createdById: true },
  });

  if (existing === null) {
    const workspaceId = randomUUID();
    await lockWorkspaceAccess(db, workspaceId);
    const workspace = await db.workspace.create({
      data: {
        id: workspaceId,
        name: personalWorkspaceName(user.username),
        slug,
        createdById: user.id,
      },
      select: { id: true },
    });
    await grantWorkspaceMembership(db, {
      workspaceId: workspace.id,
      userId: user.id,
      role: "owner",
      actorId: user.id,
      reason: "github_oauth_personal_workspace_migrated",
    });
    return;
  }

  await lockWorkspaceAccess(db, existing.id);
  const canonical = await db.workspace.findUnique({
    where: { slug },
    select: { id: true, createdById: true },
  });
  if (canonical === null || canonical.createdById !== user.id) {
    return fail("GITHUB_OAUTH_MEMBERSHIP_REVIEW_REQUIRED");
  }

  const membership = await findCurrentWorkspaceMembership(db, canonical.id, user.id);
  if (membership === null || membership.accessState !== "confirmed" || membership.role !== "owner") {
    return fail("GITHUB_OAUTH_MEMBERSHIP_REVIEW_REQUIRED");
  }
}

async function runGitHubOAuthTransaction(
  db: PrismaClient,
  attempt: Readonly<{
    id: string;
    credentialId: string;
    intent: GitHubOauthIntent;
    linkUserId: string | null;
    returnTo: string;
    remember: boolean;
  }>,
  profile: GitHubProfile,
): Promise<Readonly<{ session: CreatedSession | null; returnTo: string; intent: GitHubOauthIntent; remember: boolean }>> {
  return withSerializableRetry(db, async (tx) => {
    await assertPlatformBootstrapReady(tx);
    if (isEntitlementDatabase(db)) await assertEntitlementWriterSession(tx);
    const now = new Date();

    // The profile lock is acquired before resolving the identity on every
    // serializable attempt. This makes two independent states for the same
    // GitHub profile converge on one identity/user/workspace, while all
    // account and workspace locks still follow actor -> workspace order.
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${profile.githubUserId.toString()}::text, ${ATTEMPT_LOCK_ID}))`);
    let identity = await tx.gitHubIdentity.findUnique({ where: { githubUserId: profile.githubUserId }, include: { user: true } });
    if (attempt.intent === "link") {
      await lockActorAccess(tx, attempt.linkUserId!);
    } else if (identity !== null) {
      await lockActorAccess(tx, identity.userId);
    }
    identity = await tx.gitHubIdentity.findUnique({ where: { githubUserId: profile.githubUserId }, include: { user: true } });

    if (attempt.intent === "link") {
      const user = await tx.appUser.findUnique({ where: { id: attempt.linkUserId! } });
      if (user === null || user.disabledAt !== null) return fail("GITHUB_OAUTH_ACCOUNT_DISABLED");
      if (user.role !== "user") return fail("GITHUB_OAUTH_ACCOUNT_LINK_REQUIRED");
      const [byGitHub, byUser] = await Promise.all([
        tx.gitHubIdentity.findUnique({ where: { githubUserId: profile.githubUserId } }),
        tx.gitHubIdentity.findUnique({ where: { userId: user.id } }),
      ]);
      if ((byGitHub !== null && byGitHub.userId !== user.id) || (byUser !== null && byUser.githubUserId !== profile.githubUserId)) {
        return fail("GITHUB_OAUTH_IDENTITY_CONFLICT");
      }
      const emailOwner = await tx.appUser.findUnique({ where: { email: profile.email }, select: { id: true } });
      if (emailOwner !== null && emailOwner.id !== user.id) return fail("GITHUB_OAUTH_ACCOUNT_LINK_REQUIRED");
      await setVerifiedAccountEmail(tx, user.id, profile.email, "github", now);
      await tx.gitHubIdentity.upsert({
        where: { userId: user.id },
        create: { userId: user.id, ...profile, lastLoginAt: now },
        update: { login: profile.login, email: profile.email, displayName: profile.displayName, lastLoginAt: now },
      });
      await tx.gitHubOauthAttempt.delete({ where: { id: attempt.id } });
      await tx.externalCredential.delete({ where: { id: attempt.credentialId } });
      return Object.freeze({ session: null, returnTo: "/profile?github=linked", intent: attempt.intent, remember: attempt.remember });
    }

    if (identity === null) {
      const emailOwner = await tx.appUser.findUnique({ where: { email: profile.email }, select: { id: true } });
      if (emailOwner !== null) return fail("GITHUB_OAUTH_ACCOUNT_LINK_REQUIRED");
      const user = await tx.appUser.create({
        data: {
          username: await availableGitHubUsername(profile.login, tx),
          displayName: profile.displayName,
          email: profile.email,
          emailVerifiedAt: now,
          role: "user",
          passwordHash: null,
          passwordSalt: null,
        },
      });
      await appendEmailVerificationAudit(tx, {
        userId: user.id,
        event: "verified",
        emailBefore: null,
        emailAfter: profile.email,
        verifiedAtBefore: null,
        verifiedAtAfter: now,
        source: "github",
        reason: "github_primary_email_verified",
      });

      // A GitHub signup owns a fresh personal workspace. It must never join a
      // historical/default workspace row that may still exist in old data.
      await lockActorAccess(tx, user.id);
      const workspaceId = randomUUID();
      await lockWorkspaceAccess(tx, workspaceId);
      const workspace = await tx.workspace.create({
        data: {
          id: workspaceId,
          name: personalWorkspaceName(user.username),
          slug: `user-${user.id}`,
          createdById: user.id,
        },
        select: { id: true },
      });
      await grantWorkspaceMembership(tx, {
        workspaceId: workspace.id,
        userId: user.id,
        role: "owner",
        actorId: user.id,
        reason: "github_oauth_personal_workspace_created",
      });
      await activateAccountEntitlements({
        userId: user.id,
        source: "githubRegistration",
        actorId: user.id,
        accountAccessVersion: user.accountAccessVersion,
        actorAccountAccessVersion: user.accountAccessVersion,
        evidenceKind: "github",
        evidenceRef: profile.githubUserId.toString(),
        now,
      }, tx);
      identity = await tx.gitHubIdentity.create({
        data: { userId: user.id, ...profile, lastLoginAt: now },
        include: { user: true },
      });
    } else {
      if (identity.user.role !== "user") return fail("GITHUB_OAUTH_ACCOUNT_LINK_REQUIRED");
      if (identity.user.disabledAt !== null) return fail("GITHUB_OAUTH_ACCOUNT_DISABLED");
      const emailOwner = await tx.appUser.findUnique({ where: { email: profile.email }, select: { id: true } });
      if (emailOwner !== null && emailOwner.id !== identity.user.id) return fail("GITHUB_OAUTH_ACCOUNT_LINK_REQUIRED");
      await setVerifiedAccountEmail(tx, identity.user.id, profile.email, "github", now);
      await ensurePersonalWorkspaceForExistingIdentity(tx, identity.user);
      identity = await tx.gitHubIdentity.update({
        where: { id: identity.id },
        data: { login: profile.login, email: profile.email, displayName: profile.displayName, lastLoginAt: now },
        include: { user: true },
      });
    }
    await tx.gitHubOauthAttempt.delete({ where: { id: attempt.id } });
    await tx.externalCredential.delete({ where: { id: attempt.credentialId } });
    const session = await createSessionInTransaction(tx, identity.user);
    return Object.freeze({ session, returnTo: canonicalInternalReturnPath(attempt.returnTo), intent: attempt.intent, remember: attempt.remember });
  });
}

async function completeGitHubOAuthTransaction(
  db: PrismaClient,
  attempt: Readonly<{
    id: string;
    credentialId: string;
    intent: GitHubOauthIntent;
    linkUserId: string | null;
    returnTo: string;
    remember: boolean;
  }>,
  profile: GitHubProfile,
): Promise<Readonly<{ session: CreatedSession | null; returnTo: string; intent: GitHubOauthIntent; remember: boolean }>> {
  for (let uniqueRetry = 0; ; uniqueRetry += 1) {
    try {
      return await runGitHubOAuthTransaction(db, attempt, profile);
    } catch (error) {
      // A Serializable snapshot can be established before the profile lock:
      // a second callback may therefore miss the first callback's identity and
      // hit a signup unique index (email/username/GitHubIdentity). Retry that
      // one narrow race after the failed transaction is fully rolled back and
      // a fresh connection-level read confirms the winner. Do not retry other
      // unique conflicts, and never repeat provider calls here.
      if (
        attempt.intent !== "login"
        || uniqueRetry >= MAX_GITHUB_OAUTH_UNIQUE_RETRIES
        || !isGitHubSignupUniqueConflict(error)
      ) throw error;
      const existingIdentity = await db.gitHubIdentity.findUnique({
        where: { githubUserId: profile.githubUserId },
        select: { id: true },
      });
      if (existingIdentity === null) throw error;
    }
  }
}

export async function completeGitHubOAuth(
  input: Readonly<{ code: unknown; state: unknown; cookieState: unknown; sessionUserId?: unknown }>,
  db: PrismaClient = getEntitlementDb(),
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
  return completeGitHubOAuthTransaction(db, attempt, profile);
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
