import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { Prisma, type AppUser, type PrismaClient } from "@prisma/client";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { assertEntitlementWriterSession, getDb, getEntitlementDb, isEntitlementDatabase } from "@/lib/db";
import { authorizeApiRequest } from "@/lib/access-control";
import { lockActorAccess, lockWorkspaceAccess } from "@/lib/access-linearization";
import { appendWorkspaceMembershipAudit } from "@/lib/membership-governance";
import { toSystemRole, type SystemRole } from "@/lib/system-role";
import { createBootstrapSignupOfferPolicy } from "@/lib/platform-grant-offer-policy-service";
import { activateAccountEntitlements } from "@/lib/account-entitlement-activation-service";
import { getFirstAdminOnboardingState } from "@/lib/first-admin-onboarding-service";
import { DEFAULT_WORKSPACE_ID } from "@/lib/workspace-constants";

export const SESSION_COOKIE_NAME = "ai_project_os_session" as const;
export const SESSION_LIFETIME_DAYS = 14 as const;
export { DEFAULT_WORKSPACE_ID } from "@/lib/workspace-constants";

const PASSWORD_VERSION = 1;
const SCRYPT_KEY_BYTES = 32;
const SCRYPT_OPTIONS = Object.freeze({
  cost: 16_384,
  blockSize: 8,
  parallelization: 1,
  maxmem: 64 * 1024 * 1024,
});
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;

export type AuthErrorCode =
  | "AUTH_INVALID_INPUT"
  | "AUTH_ALREADY_INITIALIZED"
  | "AUTH_INVALID_CREDENTIALS"
  | "AUTH_CURRENT_PASSWORD_INVALID"
  | "AUTH_PASSWORD_UNCHANGED"
  | "AUTH_LOCAL_PASSWORD_EXISTS"
  | "AUTH_REQUIRED"
  | "AUTH_FORBIDDEN"
  | "AUTH_ACCOUNT_DISABLED"
  | "AUTH_CSRF_REJECTED";

export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode) {
    super(code);
    this.name = "AuthError";
  }
}

export type SafeSessionUser = Readonly<{
  id: string;
  username: string;
  role: SystemRole;
  accountAccessVersion: number;
}>;

type SessionDb = PrismaClient | Prisma.TransactionClient;

export type CreatedSession = Readonly<{
  token: string;
  expiresAt: Date;
  user: SafeSessionUser;
}>;

function fail(code: AuthErrorCode): never {
  throw new AuthError(code);
}

function canonicalUsername(value: unknown): string {
  if (typeof value !== "string") return fail("AUTH_INVALID_INPUT");
  const username = value.trim();
  if (username !== value || !USERNAME_PATTERN.test(username)) {
    return fail("AUTH_INVALID_INPUT");
  }
  return username;
}

function canonicalPassword(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 12 ||
    value.length > 128 ||
    CONTROL_PATTERN.test(value) ||
    !/[A-Za-z]/.test(value) ||
    !/[0-9]/.test(value)
  ) {
    return fail("AUTH_INVALID_INPUT");
  }
  return value;
}

function canonicalOptionalProfileText(value: unknown, maximum: number): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > maximum || CONTROL_PATTERN.test(value)) return fail("AUTH_INVALID_INPUT");
  return value;
}

function canonicalEmail(value: unknown): string | null {
  const email = canonicalOptionalProfileText(value, 320)?.toLowerCase() ?? null;
  if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return fail("AUTH_INVALID_INPUT");
  return email;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function emailFingerprint(value: string | null): string | null {
  return value === null ? null : createHash("sha256").update(value, "utf8").digest("hex");
}

type EmailVerificationAuditInput = Readonly<{
  userId: string;
  event: "verified" | "unverified";
  emailBefore: string | null;
  emailAfter: string | null;
  verifiedAtBefore: Date | null;
  verifiedAtAfter: Date | null;
  source: "profile" | "github" | "oidc";
  reason: string;
}>;

/**
 * Keep email evidence useful without copying an address into an audit row.
 * Callers must already hold the actor lock and be inside the same transaction
 * as the AppUser mutation.
 */
export async function appendEmailVerificationAudit(
  db: Prisma.TransactionClient,
  input: EmailVerificationAuditInput,
): Promise<void> {
  await db.appUserEmailVerificationAudit.create({
    data: {
      userId: input.userId,
      event: input.event,
      emailFingerprintBefore: emailFingerprint(input.emailBefore),
      emailFingerprintAfter: emailFingerprint(input.emailAfter),
      verifiedAtBefore: input.verifiedAtBefore,
      verifiedAtAfter: input.verifiedAtAfter,
      source: input.source,
      reason: input.reason,
    },
  });
}

/**
 * Apply a trusted upstream email assertion.  The caller owns the common
 * actor lock; this helper deliberately never accepts an email from a browser
 * request or from an unverified upstream claim.
 */
export async function setVerifiedAccountEmail(
  db: Prisma.TransactionClient,
  userId: string,
  emailInput: string,
  source: "github" | "oidc",
  now = new Date(),
) {
  const email = canonicalEmail(emailInput);
  if (email === null) return fail("AUTH_INVALID_INPUT");
  const current = await db.appUser.findUnique({
    where: { id: userId },
    select: { id: true, email: true, emailVerifiedAt: true },
  });
  if (current === null) return fail("AUTH_REQUIRED");
  const storedEmail = current.email ?? null;
  const currentEmail = storedEmail?.trim().toLowerCase() ?? null;
  const currentVerifiedAt = current.emailVerifiedAt ?? null;
  if (currentEmail === email && currentVerifiedAt !== null) return current;
  const updated = await db.appUser.update({
    where: { id: userId },
    data: { email, emailVerifiedAt: now },
    select: { id: true, email: true, emailVerifiedAt: true },
  });
  await appendEmailVerificationAudit(db, {
    userId,
    event: "verified",
    emailBefore: storedEmail,
    emailAfter: email,
    verifiedAtBefore: currentVerifiedAt,
    verifiedAtAfter: now,
    source,
    reason: source === "github" ? "github_primary_email_verified" : "oidc_email_claim_verified",
  });
  return updated;
}

async function passwordDigest(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, SCRYPT_KEY_BYTES, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(Buffer.from(derivedKey));
    });
  });
}

export async function createPasswordRecord(passwordInput: unknown): Promise<Readonly<{
  passwordHash: string;
  passwordSalt: string;
  passwordVersion: 1;
}>> {
  const password = canonicalPassword(passwordInput);
  const salt = randomBytes(16);
  const digest = await passwordDigest(password, salt);
  return Object.freeze({
    passwordHash: digest.toString("base64url"),
    passwordSalt: salt.toString("base64url"),
    passwordVersion: PASSWORD_VERSION,
  });
}

export async function verifyPasswordRecord(
  passwordInput: unknown,
  record: Readonly<{ passwordHash: string | null; passwordSalt: string | null; passwordVersion: number }>,
): Promise<boolean> {
  if (record.passwordHash === null || record.passwordSalt === null) return false;
  let password: string;
  try {
    password = canonicalPassword(passwordInput);
  } catch {
    return false;
  }
  if (record.passwordVersion !== PASSWORD_VERSION) return false;
  let expected: Buffer;
  let salt: Buffer;
  try {
    expected = Buffer.from(record.passwordHash, "base64url");
    salt = Buffer.from(record.passwordSalt, "base64url");
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_KEY_BYTES || salt.length !== 16) return false;
  const actual = await passwordDigest(password, salt);
  return timingSafeEqual(actual, expected);
}

function safeUser(user: Pick<AppUser, "id" | "username" | "role"> & Partial<Pick<AppUser, "accountAccessVersion">>): SafeSessionUser {
  const accountAccessVersion = user.accountAccessVersion;
  if (
    typeof accountAccessVersion !== "number"
    || !Number.isSafeInteger(accountAccessVersion)
    || accountAccessVersion < 1
  ) {
    return fail("AUTH_REQUIRED");
  }
  return Object.freeze({ id: user.id, username: user.username, role: toSystemRole(user.role), accountAccessVersion });
}

/**
 * Create a session using the transaction that the caller already owns.
 *
 * Keep this separate from createSession's PrismaClient entry point. Prisma's
 * interactive TransactionClient exposes a $transaction-shaped proxy too, so
 * detecting transactions by the presence of that property recurses forever.
 * Callers that are already inside a transaction must use this function.
 */
export async function createSessionInTransaction(
  db: PrismaClient | Prisma.TransactionClient,
  user: Pick<AppUser, "id" | "username" | "role"> & Partial<Pick<AppUser, "accountAccessVersion">>,
  now = new Date(),
): Promise<CreatedSession> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_DAYS * 24 * 60 * 60 * 1_000);
  let sessionUser: Pick<AppUser, "id" | "username" | "role"> & Partial<Pick<AppUser, "accountAccessVersion">> = user;
  const appUserDelegate = (db as unknown as {
    appUser?: {
      findUnique?: (args: unknown) => Promise<Readonly<{
        id: string;
        username: string;
        role: AppUser["role"];
        disabledAt: Date | null;
        accountAccessVersion: number;
      }> | null>;
    };
  }).appUser;
  if (typeof appUserDelegate?.findUnique === "function") {
    const current = await appUserDelegate.findUnique({
      where: { id: user.id },
      select: { id: true, username: true, role: true, disabledAt: true, accountAccessVersion: true },
    });
    if (current === null) return fail("AUTH_REQUIRED");
    if (current.disabledAt !== null) return fail("AUTH_ACCOUNT_DISABLED");
    sessionUser = current;
  }
  const accountAccessVersion = sessionUser.accountAccessVersion;
  if (
    typeof accountAccessVersion !== "number"
    || !Number.isSafeInteger(accountAccessVersion)
    || accountAccessVersion < 1
  ) {
    return fail("AUTH_REQUIRED");
  }
  // The migration installs a DB guard on AppSession. The context is scoped to
  // this transaction and is intentionally not exposed to request callers.
  const executeRaw = (db as unknown as { $executeRaw?: (query: Prisma.Sql) => Promise<unknown> }).$executeRaw;
  if (typeof executeRaw === "function") {
    await executeRaw.call(db, Prisma.sql`SELECT set_config('app.account_session_context', '1', true)`);
    await executeRaw.call(db, Prisma.sql`SELECT set_config('app.account_session_user_id', ${sessionUser.id}, true)`);
    await executeRaw.call(db, Prisma.sql`SELECT set_config('app.account_session_version', ${accountAccessVersion.toString()}, true)`);
  }
  await db.appSession.create({
    data: {
      userId: sessionUser.id,
      accountAccessVersion,
      tokenHash: tokenHash(token),
      expiresAt,
      lastSeenAt: now,
    },
  });
  return Object.freeze({ token, expiresAt, user: safeUser(sessionUser) });
}

/**
 * Top-level session creation entry point. The transaction is opened exactly
 * once here; transaction callbacks use createSessionInTransaction directly.
 * The no-$transaction fallback is retained for the small in-memory auth
 * doubles used by boundary tests.
 */
export async function createSession(
  db: PrismaClient | Prisma.TransactionClient,
  user: Pick<AppUser, "id" | "username" | "role"> & Partial<Pick<AppUser, "accountAccessVersion">>,
  now = new Date(),
): Promise<CreatedSession> {
  const transaction = (db as unknown as {
    $transaction?: <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
  }).$transaction;
  if (typeof transaction === "function") {
    return await transaction.call(db, (tx) => createSessionInTransaction(tx, user, now)) as CreatedSession;
  }
  return createSessionInTransaction(db, user, now);
}

export async function isApplicationInitialized(db: PrismaClient = getDb()): Promise<boolean> {
  return (await db.appUser.count({ where: { role: "admin" } })) > 0;
}

export async function initializeAdmin(
  input: Readonly<{ username: unknown; password: unknown }>,
  db: PrismaClient = getEntitlementDb(),
): Promise<CreatedSession> {
  const username = canonicalUsername(input.username);
  const password = await createPasswordRecord(input.password);
  return db.$transaction(async (tx) => {
    if (isEntitlementDatabase(db)) await assertEntitlementWriterSession(tx);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(781452903)`;
    await lockWorkspaceAccess(tx, DEFAULT_WORKSPACE_ID);
    if ((await tx.appUser.count({ where: { role: "admin" } })) > 0) {
      return fail("AUTH_ALREADY_INITIALIZED");
    }
    const [workspaceMembershipCount, projectMembershipCount] = await Promise.all([
      // Bootstrap is only safe while the database has no membership facts at
      // all.  Checking just the default workspace would let a partially
      // migrated/pending membership in another workspace be bypassed by a
      // second self-bootstrap.
      tx.workspaceMembership.count(),
      tx.projectMembership.count(),
    ]);
    if (workspaceMembershipCount > 0 || projectMembershipCount > 0) return fail("AUTH_ALREADY_INITIALIZED");
    const user = await tx.appUser.create({
      data: { username, role: "admin", ...password },
    });
    await tx.workspace.update({ where: { id: DEFAULT_WORKSPACE_ID }, data: { createdById: user.id } });
    const membership = await tx.workspaceMembership.create({ data: { workspaceId: DEFAULT_WORKSPACE_ID, userId: user.id, role: "owner", accessState: "confirmed" } });
    await appendWorkspaceMembershipAudit(tx, membership, {
      action: "bootstrapConfirmed",
      previousState: null,
      actorId: user.id,
      reason: "fresh_application_bootstrap",
    });
    await createBootstrapSignupOfferPolicy(tx, user.id);
    await activateAccountEntitlements({
      userId: user.id,
      source: "bootstrap",
      actorId: user.id,
      accountAccessVersion: user.accountAccessVersion,
      evidenceKind: "setup",
    }, tx);
    return createSessionInTransaction(tx, user);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function loginAdmin(
  input: Readonly<{ username: unknown; password: unknown }>,
  db: PrismaClient = getDb(),
): Promise<CreatedSession> {
  let username: string;
  try {
    username = canonicalUsername(input.username);
  } catch {
    return fail("AUTH_INVALID_CREDENTIALS");
  }
  const user = await db.appUser.findUnique({ where: { username } });
  if (
    user === null ||
    user.disabledAt !== null ||
    !(await verifyPasswordRecord(input.password, user))
  ) {
    return fail("AUTH_INVALID_CREDENTIALS");
  }
  await db.appSession.updateMany({
    where: { userId: user.id, expiresAt: { lte: new Date() }, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return createSession(db, user);
}

export async function updateAccountUsername(
  userId: string,
  usernameInput: unknown,
  db: PrismaClient = getDb(),
): Promise<SafeSessionUser> {
  const username = canonicalUsername(usernameInput);
  const user = await db.appUser.update({
    where: { id: userId },
    data: { username },
    select: { id: true, username: true, role: true, accountAccessVersion: true },
  });
  return safeUser(user);
}

export async function updateAccountProfile(
  userId: string,
  input: Readonly<{ displayName: unknown; email: unknown }>,
  db: PrismaClient = getDb(),
): Promise<Readonly<{ id: string; displayName: string | null; email: string | null; emailVerifiedAt: Date | null }>> {
  const displayName = canonicalOptionalProfileText(input.displayName, 160);
  const email = canonicalEmail(input.email);
  return db.$transaction(async (tx) => {
    await lockActorAccess(tx, userId);
    const current = await tx.appUser.findUnique({
      where: { id: userId },
      select: { id: true, displayName: true, email: true, emailVerifiedAt: true },
    });
    if (current === null) return fail("AUTH_REQUIRED");
    const storedEmail = current.email ?? null;
    const currentEmail = storedEmail?.trim().toLowerCase() ?? null;
    const currentVerifiedAt = current.emailVerifiedAt ?? null;
    const emailChanged = currentEmail !== email;
    const nextVerifiedAt = emailChanged ? null : currentVerifiedAt;
    const updated = await tx.appUser.update({
      where: { id: userId },
      data: { displayName, email, emailVerifiedAt: nextVerifiedAt },
      select: { id: true, displayName: true, email: true, emailVerifiedAt: true },
    });
    if (emailChanged) {
      await appendEmailVerificationAudit(tx, {
        userId,
        event: "unverified",
        emailBefore: storedEmail,
        emailAfter: email,
        verifiedAtBefore: currentVerifiedAt,
        verifiedAtAfter: null,
        source: "profile",
        reason: "profile_email_changed",
      });
    }
    return updated;
  });
}

export async function setLocalAccountPassword(userId: string, newPasswordInput: unknown, db: PrismaClient = getDb()): Promise<void> {
  const nextPassword = await createPasswordRecord(newPasswordInput);
  await db.$transaction(async (tx) => {
    const updated = await tx.appUser.updateMany({ where: { id: userId, passwordHash: null, passwordSalt: null }, data: nextPassword });
    if (updated.count !== 1) return fail("AUTH_LOCAL_PASSWORD_EXISTS");
    await tx.appSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  });
}

export async function changeAccountPassword(
  userId: string,
  currentPasswordInput: unknown,
  newPasswordInput: unknown,
  db: PrismaClient = getDb(),
): Promise<void> {
  const user = await db.appUser.findUnique({
    where: { id: userId },
    select: {
      id: true,
      passwordHash: true,
      passwordSalt: true,
      passwordVersion: true,
    },
  });
  if (user === null) return fail("AUTH_REQUIRED");
  if (user.passwordHash === null || user.passwordSalt === null) return fail("AUTH_CURRENT_PASSWORD_INVALID");
  if (!(await verifyPasswordRecord(currentPasswordInput, user))) {
    return fail("AUTH_CURRENT_PASSWORD_INVALID");
  }
  if (await verifyPasswordRecord(newPasswordInput, user)) {
    return fail("AUTH_PASSWORD_UNCHANGED");
  }

  const nextPassword = await createPasswordRecord(newPasswordInput);
  const revokedAt = new Date();
  await db.$transaction(async (tx) => {
    const update = await tx.appUser.updateMany({
      where: {
        id: userId,
        passwordHash: user.passwordHash,
        passwordSalt: user.passwordSalt,
        passwordVersion: user.passwordVersion,
      },
      data: nextPassword,
    });
    if (update.count !== 1) return fail("AUTH_CURRENT_PASSWORD_INVALID");
    await tx.appSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt },
    });
  });
}

function cookieToken(cookieHeader: string | null): string | null {
  if (cookieHeader === null) return null;
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName === SESSION_COOKIE_NAME) {
      const value = rest.join("=");
      return /^[A-Za-z0-9_-]{40,128}$/.test(value) ? value : null;
    }
  }
  return null;
}

async function readSessionTokenInternal(
  token: string | null,
  db: SessionDb,
  now: Date,
  touchLastSeen: boolean,
): Promise<SafeSessionUser | null> {
  if (token === null) return null;
  const session = await db.appSession.findUnique({
    where: { tokenHash: tokenHash(token) },
    include: { user: true },
  });
  if (
    session === null
    || session.revokedAt !== null
    || session.expiresAt <= now
    || session.user.disabledAt !== null
    || session.accountAccessVersion !== session.user.accountAccessVersion
  ) return null;
  if (touchLastSeen && now.getTime() - session.lastSeenAt.getTime() > 5 * 60 * 1_000) {
    await db.appSession.updateMany({
      where: {
        id: session.id,
        revokedAt: null,
        expiresAt: { gt: now },
        accountAccessVersion: session.accountAccessVersion,
        user: {
          is: {
            disabledAt: null,
            accountAccessVersion: session.user.accountAccessVersion,
          },
        },
      },
      data: { lastSeenAt: now },
    });
  }
  return safeUser(session.user);
}

export async function readSessionToken(
  token: string | null,
  db: PrismaClient = getDb(),
): Promise<SafeSessionUser | null> {
  return readSessionTokenInternal(token, db, new Date(), true);
}

/**
 * Authenticate a request without touching session recency.  Read-only pages
 * use this inside their snapshot transaction so authentication observes the
 * same database state as the rest of the projection and cannot write through
 * an otherwise read-only connection.
 */
export async function readSessionTokenReadOnly(
  token: string | null,
  db: SessionDb = getDb(),
  now = new Date(),
): Promise<SafeSessionUser | null> {
  return readSessionTokenInternal(token, db, now, false);
}

export async function requireApiSession(
  request: Request,
  db: PrismaClient = getDb(),
): Promise<SafeSessionUser> {
  const user = await readSessionToken(cookieToken(request.headers.get("cookie")), db);
  if (user === null) return fail("AUTH_REQUIRED");
  await authorizeApiRequest(user, request, db);
  return user;
}

export async function requireApiSessionReadOnly(
  request: Request,
  db: SessionDb = getDb(),
  now = new Date(),
): Promise<SafeSessionUser> {
  const user = await readSessionTokenReadOnly(cookieToken(request.headers.get("cookie")), db, now);
  if (user === null) return fail("AUTH_REQUIRED");
  await authorizeApiRequest(user, request, db);
  return user;
}

export async function requirePageSession(db: PrismaClient = getDb()): Promise<SafeSessionUser> {
  const store = await cookies();
  const user = await readSessionToken(store.get(SESSION_COOKIE_NAME)?.value ?? null, db);
  if (user !== null) {
    if (await getFirstAdminOnboardingState(user.id, db) === "pending") redirect("/onboarding");
    return user;
  }
  redirect((await isApplicationInitialized(db)) ? "/login" : "/setup");
}

/**
 * The onboarding page intentionally lives outside the admin layout. Keep a
 * dedicated guard here so the normal page gate can redirect pending sessions
 * without making /onboarding redirect back to itself.
 */
export async function requireFirstAdminOnboardingPage(
  db: PrismaClient = getDb(),
): Promise<SafeSessionUser> {
  const store = await cookies();
  const user = await readSessionToken(store.get(SESSION_COOKIE_NAME)?.value ?? null, db);
  if (user === null) redirect((await isApplicationInitialized(db)) ? "/login" : "/setup");
  if (await getFirstAdminOnboardingState(user.id, db) !== "pending") redirect("/dashboard");
  return user;
}

export async function getPageSession(db: PrismaClient = getDb()): Promise<SafeSessionUser | null> {
  const store = await cookies();
  return readSessionToken(store.get(SESSION_COOKIE_NAME)?.value ?? null, db);
}

export async function revokeRequestSession(
  request: Request,
  db: PrismaClient = getDb(),
): Promise<void> {
  const token = cookieToken(request.headers.get("cookie"));
  if (token === null) return;
  await db.appSession.updateMany({
    where: { tokenHash: tokenHash(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (origin === null || host === null) return fail("AUTH_CSRF_REJECTED");
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return fail("AUTH_CSRF_REJECTED");
  }
  if (originUrl.host.toLowerCase() !== host.toLowerCase()) {
    return fail("AUTH_CSRF_REJECTED");
  }
}

export function sessionCookie(token: string, expiresAt: Date, persistent = true): string {
  const secure = process.env.AI_PROJECT_OS_SECURE_COOKIES === "true" ? "; Secure" : "";
  const expires = persistent ? `; Expires=${expiresAt.toUTCString()}` : "";
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax${expires}${secure}`;
}

export function expiredSessionCookie(): string {
  const secure = process.env.AI_PROJECT_OS_SECURE_COOKIES === "true" ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
