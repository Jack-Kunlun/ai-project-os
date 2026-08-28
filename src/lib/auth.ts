import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { Prisma, type AppUser, type PrismaClient } from "@prisma/client";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";

export const SESSION_COOKIE_NAME = "ai_project_os_session" as const;
export const SESSION_LIFETIME_DAYS = 14 as const;

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
  | "AUTH_REQUIRED"
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
  role: "admin";
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
  record: Readonly<{ passwordHash: string; passwordSalt: string; passwordVersion: number }>,
): Promise<boolean> {
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

async function createSession(
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
  if (session === null || session.revokedAt !== null || session.expiresAt <= now) return null;
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
  return user ?? fail("AUTH_REQUIRED");
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

export function sessionCookie(token: string, expiresAt: Date): string {
  const secure = process.env.AI_PROJECT_OS_SECURE_COOKIES === "true" ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secure}`;
}

export function expiredSessionCookie(): string {
  const secure = process.env.AI_PROJECT_OS_SECURE_COOKIES === "true" ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
