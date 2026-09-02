import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { Prisma, type AppUser, type AppUserRole, type PrismaClient } from "@prisma/client";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { authorizeApiRequest } from "@/lib/access-control";

export const SESSION_COOKIE_NAME = "ai_project_os_session" as const;
export const SESSION_LIFETIME_DAYS = 14 as const;
export const DEFAULT_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001" as const;

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
  role: AppUserRole;
}>;

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

function safeUser(user: Pick<AppUser, "id" | "username" | "role">): SafeSessionUser {
  return Object.freeze({ id: user.id, username: user.username, role: user.role });
}

export async function createSession(
  db: PrismaClient | Prisma.TransactionClient,
  user: Pick<AppUser, "id" | "username" | "role">,
  now = new Date(),
): Promise<CreatedSession> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_DAYS * 24 * 60 * 60 * 1_000);
  await db.appSession.create({
    data: {
      userId: user.id,
      tokenHash: tokenHash(token),
      expiresAt,
      lastSeenAt: now,
    },
  });
  return Object.freeze({ token, expiresAt, user: safeUser(user) });
}

export async function isApplicationInitialized(db: PrismaClient = getDb()): Promise<boolean> {
  return (await db.appUser.count({ where: { role: "admin" } })) > 0;
}

export async function initializeAdmin(
  input: Readonly<{ username: unknown; password: unknown }>,
  db: PrismaClient = getDb(),
): Promise<CreatedSession> {
  const username = canonicalUsername(input.username);
  const password = await createPasswordRecord(input.password);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(781452903)`;
    if ((await tx.appUser.count({ where: { role: "admin" } })) > 0) {
      return fail("AUTH_ALREADY_INITIALIZED");
    }
    const user = await tx.appUser.create({
      data: { username, role: "admin", ...password },
    });
    await tx.workspace.update({ where: { id: DEFAULT_WORKSPACE_ID }, data: { createdById: user.id } });
    await tx.workspaceMembership.create({ data: { workspaceId: DEFAULT_WORKSPACE_ID, userId: user.id, role: "owner" } });
    return createSession(tx, user);
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
    where: { userId: user.id, OR: [{ expiresAt: { lte: new Date() } }, { revokedAt: { not: null } }] },
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
    select: { id: true, username: true, role: true },
  });
  return safeUser(user);
}

export async function updateAccountProfile(
  userId: string,
  input: Readonly<{ displayName: unknown; email: unknown }>,
  db: PrismaClient = getDb(),
): Promise<Readonly<{ id: string; displayName: string | null; email: string | null }>> {
  return db.appUser.update({
    where: { id: userId },
    data: { displayName: canonicalOptionalProfileText(input.displayName, 160), email: canonicalEmail(input.email) },
    select: { id: true, displayName: true, email: true },
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

export async function readSessionToken(
  token: string | null,
  db: PrismaClient = getDb(),
): Promise<SafeSessionUser | null> {
  if (token === null) return null;
  const now = new Date();
  const session = await db.appSession.findUnique({
    where: { tokenHash: tokenHash(token) },
    include: { user: true },
  });
  if (session === null || session.revokedAt !== null || session.expiresAt <= now || session.user.disabledAt !== null) return null;
  if (now.getTime() - session.lastSeenAt.getTime() > 5 * 60 * 1_000) {
    await db.appSession.updateMany({
      where: { id: session.id, revokedAt: null, expiresAt: { gt: now } },
      data: { lastSeenAt: now },
    });
  }
  return safeUser(session.user);
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

export async function requirePageSession(db: PrismaClient = getDb()): Promise<SafeSessionUser> {
  const store = await cookies();
  const user = await readSessionToken(store.get(SESSION_COOKIE_NAME)?.value ?? null, db);
  if (user !== null) return user;
  redirect((await isApplicationInitialized(db)) ? "/login" : "/setup");
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
