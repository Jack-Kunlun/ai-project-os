import { createHash, randomUUID } from "node:crypto";
import { Prisma, type AppUser, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { lockActorsAccess, lockWorkspaceAccess } from "@/lib/access-linearization";
import { getDb } from "@/lib/db";

export type AccountAccessAction = "disable" | "restore";
export type AccountAccessState = "enabled" | "disabled";

export type AccountAccessServiceErrorCode =
  | "ACCOUNT_ACCESS_INVALID_INPUT"
  | "ACCOUNT_ACCESS_USER_NOT_FOUND"
  | "ACCOUNT_ACCESS_ADMIN_REQUIRED"
  | "ACCOUNT_ACCESS_ADMIN_STALE"
  | "ACCOUNT_ACCESS_SELF_FORBIDDEN"
  | "ACCOUNT_ACCESS_ACTION_CONFLICT"
  | "ACCOUNT_ACCESS_CONFLICT"
  | "ACCOUNT_ACCESS_PREVIEW_STALE"
  | "ACCOUNT_ACCESS_PREVIEW_EXPIRED"
  | "ACCOUNT_ACCESS_LAST_ADMIN_REQUIRED"
  | "ACCOUNT_ACCESS_LAST_OWNER_REQUIRED"
  | "ACCOUNT_ACCESS_REASON_REQUIRED"
  | "ACCOUNT_ACCESS_UNSAFE_AUDIT_TEXT"
  | "ACCOUNT_ACCESS_IDEMPOTENCY_CONFLICT"
  | "ACCOUNT_ACCESS_CONFIRMATION_REQUIRED"
  | "ACCOUNT_ACCESS_METHOD_NOT_ALLOWED";

export class AccountAccessServiceError extends Error {
  constructor(readonly code: AccountAccessServiceErrorCode) {
    super(code);
    this.name = "AccountAccessServiceError";
  }
}

type AccountAccessDb = PrismaClient | Prisma.TransactionClient;

const UUID_SCHEMA = z.string().uuid();
const FINGERPRINT_SCHEMA = z.string().regex(/^[0-9a-f]{64}$/u);
const REQUEST_KEY_SCHEMA = z.string().trim().min(8).max(180);
const PREVIEW_TTL_MS = 5 * 60 * 1_000;
const PREVIEW_CLOCK_SKEW_MS = 5 * 1_000;
const MUTATION_TRANSACTION_TIMEOUT_MS = 30 * 1_000;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const UNSAFE_AUDIT_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f]|[A-Za-z0-9_-]{40,128}/u;
const EMAIL_SHAPED_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/u;

function fail(code: AccountAccessServiceErrorCode): never {
  throw new AccountAccessServiceError(code);
}

function isPrismaCode(error: unknown, code: string): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code === code;
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}

function isTransactionConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return isPrismaCode(error, "P2034")
    || isPrismaCode(error, "P2028")
    || /P2034|P2028|40001|serialization failure|could not serialize|write conflict|transaction (?:already )?closed|expired transaction/iu.test(message);
}

function hashFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function userId(value: unknown): string {
  const parsed = UUID_SCHEMA.safeParse(value);
  if (!parsed.success) return fail("ACCOUNT_ACCESS_INVALID_INPUT");
  return parsed.data.toLowerCase();
}

function action(value: unknown): AccountAccessAction {
  if (value !== "disable" && value !== "restore") return fail("ACCOUNT_ACCESS_INVALID_INPUT");
  return value;
}

function positiveVersion(value: unknown, required = true): number | undefined {
  if (value === undefined || value === null) {
    if (required) return fail("ACCOUNT_ACCESS_INVALID_INPUT");
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 1) return fail("ACCOUNT_ACCESS_INVALID_INPUT");
  return value as number;
}

function fingerprint(value: unknown): string {
  const parsed = FINGERPRINT_SCHEMA.safeParse(value);
  if (!parsed.success) return fail("ACCOUNT_ACCESS_INVALID_INPUT");
  return parsed.data;
}

function requestKey(value: unknown): string {
  const parsed = REQUEST_KEY_SCHEMA.safeParse(value);
  if (!parsed.success) return fail("ACCOUNT_ACCESS_INVALID_INPUT");
  return safeAuditText(parsed.data, true)!;
}

function safeAuditText(value: unknown, required = false): string | null {
  if (value === null || value === undefined || value === "") {
    if (required) return fail("ACCOUNT_ACCESS_INVALID_INPUT");
    return null;
  }
  if (typeof value !== "string") return fail("ACCOUNT_ACCESS_INVALID_INPUT");
  const normalized = value.trim();
  if (normalized.length === 0) {
    if (required) return fail("ACCOUNT_ACCESS_INVALID_INPUT");
    return null;
  }
  if (
    normalized.length > 500
    || CONTROL_PATTERN.test(normalized)
    || UNSAFE_AUDIT_TEXT_PATTERN.test(normalized)
    || EMAIL_SHAPED_PATTERN.test(normalized)
    || /^[0-9a-f]{64}$/iu.test(normalized)
  ) return fail("ACCOUNT_ACCESS_UNSAFE_AUDIT_TEXT");
  return normalized;
}

function requiredReason(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return fail("ACCOUNT_ACCESS_REASON_REQUIRED");
  const reason = safeAuditText(value, true);
  if (reason === null) return fail("ACCOUNT_ACCESS_REASON_REQUIRED");
  return reason;
}

function dateValue(value: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return fail("ACCOUNT_ACCESS_INVALID_INPUT");
}

function assertPreviewEvidence(input: Readonly<{ issuedAt: Date; expiresAt: Date; now: Date }>): void {
  const issuedAtMs = input.issuedAt.getTime();
  const expiresAtMs = input.expiresAt.getTime();
  const nowMs = input.now.getTime();
  if (
    issuedAtMs > nowMs + PREVIEW_CLOCK_SKEW_MS
    || expiresAtMs <= nowMs
    || expiresAtMs <= issuedAtMs
    || expiresAtMs - issuedAtMs > PREVIEW_TTL_MS
  ) return fail("ACCOUNT_ACCESS_PREVIEW_EXPIRED");
}

async function databaseNow(db: AccountAccessDb): Promise<Date> {
  const queryRaw = (db as unknown as { $queryRaw?: (query: Prisma.Sql) => Promise<unknown> }).$queryRaw;
  if (typeof queryRaw !== "function") return new Date();
  const rows = await queryRaw.call(db, Prisma.sql`SELECT clock_timestamp() AS "now"`) as Array<{ now?: Date }>;
  const now = rows[0]?.now;
  return now instanceof Date && !Number.isNaN(now.getTime()) ? now : fail("ACCOUNT_ACCESS_CONFLICT");
}

type AccountAccessAdmin = Readonly<{
  role: AppUser["role"];
  disabledAt: Date | null;
  accountAccessVersion: number;
}>;

async function loadAdmin(db: AccountAccessDb, adminId: string): Promise<AccountAccessAdmin | null> {
  return db.appUser.findUnique({
    where: { id: adminId },
    select: { role: true, disabledAt: true, accountAccessVersion: true },
  }) as Promise<AccountAccessAdmin | null>;
}

function assertAdminSnapshot(admin: AccountAccessAdmin | null, expectedVersion?: number): void {
  if (admin === null || admin.role !== "admin" || admin.disabledAt !== null) return fail("ACCOUNT_ACCESS_ADMIN_REQUIRED");
  if (expectedVersion !== undefined && admin.accountAccessVersion !== expectedVersion) return fail("ACCOUNT_ACCESS_ADMIN_STALE");
}

async function assertAdmin(adminId: string, db: AccountAccessDb): Promise<void> {
  assertAdminSnapshot(await loadAdmin(db, adminId));
}

type AccountTarget = Readonly<{
  id: string;
  username: string;
  displayName: string | null;
  role: AppUser["role"];
  disabledAt: Date | null;
  disabledReason: string | null;
  disabledById: string | null;
  accountAccessVersion: number;
}>;

const targetSelect = {
  id: true,
  username: true,
  displayName: true,
  role: true,
  disabledAt: true,
  disabledReason: true,
  disabledById: true,
  accountAccessVersion: true,
} as const;

async function loadTarget(db: AccountAccessDb, targetId: string): Promise<AccountTarget | null> {
  return db.appUser.findUnique({ where: { id: targetId }, select: targetSelect }) as Promise<AccountTarget | null>;
}

async function activeSessionCount(db: AccountAccessDb, targetId: string): Promise<number> {
  return db.appSession.count({ where: { userId: targetId, revokedAt: null } });
}

async function enabledAdminCount(db: AccountAccessDb): Promise<number> {
  return db.appUser.count({ where: { role: "admin", disabledAt: null } });
}

/**
 * Account disable is serialized with role governance for every workspace in
 * which the target is currently an Owner.  The workspace locks are acquired
 * only after the actor locks, matching the global actor -> workspace order.
 */
async function ownerWorkspaceIds(db: AccountAccessDb, targetId: string): Promise<string[]> {
  const rows = await db.workspaceMembership.findMany({
    where: { userId: targetId, role: "owner", accessState: "confirmed" },
    orderBy: [{ workspaceId: "asc" }, { id: "asc" }],
    select: { workspaceId: true },
  });
  return [...new Set(rows.map((row) => row.workspaceId))].sort();
}

async function lastOwnerWorkspaceCount(db: AccountAccessDb, workspaceIds: readonly string[]): Promise<number> {
  let blockers = 0;
  for (const workspaceId of workspaceIds) {
    const count = await db.workspaceMembership.count({
      where: {
        workspaceId,
        role: "owner",
        accessState: "confirmed",
        user: { disabledAt: null },
      },
    });
    if (count <= 1) blockers += 1;
  }
  return blockers;
}

function targetState(target: AccountTarget): AccountAccessState {
  return target.disabledAt === null ? "enabled" : "disabled";
}

function assertActionAllowed(nextAction: AccountAccessAction, state: AccountAccessState): void {
  if (nextAction === "disable" && state !== "enabled") return fail("ACCOUNT_ACCESS_ACTION_CONFLICT");
  if (nextAction === "restore" && state !== "disabled") return fail("ACCOUNT_ACCESS_ACTION_CONFLICT");
}

function impactFingerprint(input: Readonly<{
  target: AccountTarget;
  action: AccountAccessAction;
  sessionCount: number;
}>): string {
  return hashFingerprint({
    userId: input.target.id,
    action: input.action,
    state: targetState(input.target),
    accountAccessVersion: input.target.accountAccessVersion,
    disabledAt: input.target.disabledAt?.toISOString() ?? null,
    sessionCount: input.sessionCount,
  });
}

function requestFingerprint(input: Readonly<{
  userId: string;
  action: AccountAccessAction;
  expectedVersion: number;
  impactFingerprint: string;
  reason: string;
  previewIssuedAt: Date;
  previewExpiresAt: Date;
}>): string {
  return hashFingerprint({
    userId: input.userId,
    action: input.action,
    expectedVersion: input.expectedVersion,
    impactFingerprint: input.impactFingerprint,
    reason: input.reason,
    previewIssuedAt: input.previewIssuedAt.toISOString(),
    previewExpiresAt: input.previewExpiresAt.toISOString(),
  });
}

export function accountAccessRequestFingerprint(input: Readonly<{
  userId: string;
  action: AccountAccessAction;
  expectedVersion: number;
  expectedImpactFingerprint: string;
  reason: string;
  previewIssuedAt: string | Date;
  previewExpiresAt: string | Date;
}>): string {
  return requestFingerprint({
    userId: userId(input.userId),
    action: action(input.action),
    expectedVersion: positiveVersion(input.expectedVersion)!,
    impactFingerprint: fingerprint(input.expectedImpactFingerprint),
    reason: requiredReason(input.reason),
    previewIssuedAt: dateValue(input.previewIssuedAt),
    previewExpiresAt: dateValue(input.previewExpiresAt),
  });
}

export type AccountAccessPreview = Readonly<{
  action: AccountAccessAction;
  user: Readonly<{
    id: string;
    username: string;
    displayName: string | null;
    role: "admin" | "user";
    state: AccountAccessState;
  }>;
  current: Readonly<{
    state: AccountAccessState;
    accountAccessVersion: number;
    disabledAt: Date | null;
    sessionCount: number;
  }>;
  target: Readonly<{
    state: AccountAccessState;
    accountAccessVersion: number;
    disabledAt: Date | null;
    sessionCount: number;
  }>;
  blockingCategories: readonly string[];
  canExecute: boolean;
  impactFingerprint: string;
  requestFingerprint: string;
  previewId: string;
  issuedAt: Date;
  expiresAt: Date;
  previewIssuedAt: Date;
  previewExpiresAt: Date;
}>;

export type AccountAccessPreviewInput = Readonly<{
  adminUserId: string;
  adminAccountAccessVersion: number;
  userId: string;
  action: AccountAccessAction;
  reason: string;
  expectedVersion?: number;
}>;

export type AccountAccessExecuteInput = Readonly<AccountAccessPreviewInput & {
  expectedVersion: number;
  expectedImpactFingerprint: string;
  requestKey: string;
  requestFingerprint: string;
  previewId: string;
  previewIssuedAt: string | Date;
  previewExpiresAt: string | Date;
  confirmation: true;
  confirmationUsername: string;
}>;

async function setPreviewContext(tx: Prisma.TransactionClient, input: Readonly<{
  previewId: string;
  actorId: string;
  userId: string;
  action: AccountAccessAction;
  expectedVersion: number;
  impactFingerprint: string;
  requestFingerprint: string;
}>): Promise<void> {
  const executeRaw = (tx as unknown as { $executeRaw?: (query: Prisma.Sql) => Promise<unknown> }).$executeRaw;
  if (typeof executeRaw !== "function") return;
  await executeRaw.call(tx, Prisma.sql`SELECT set_config('app.account_access_preview_context', '1', true)`);
  await executeRaw.call(tx, Prisma.sql`SELECT set_config('app.account_access_preview_id', ${input.previewId}, true)`);
  await executeRaw.call(tx, Prisma.sql`SELECT set_config('app.account_access_preview_actor_id', ${input.actorId}, true)`);
  await executeRaw.call(tx, Prisma.sql`SELECT set_config('app.account_access_preview_user_id', ${input.userId}, true)`);
  await executeRaw.call(tx, Prisma.sql`SELECT set_config('app.account_access_preview_action', ${input.action}, true)`);
  await executeRaw.call(tx, Prisma.sql`SELECT set_config('app.account_access_preview_version', ${input.expectedVersion.toString()}, true)`);
  await executeRaw.call(tx, Prisma.sql`SELECT set_config('app.account_access_preview_impact_fingerprint', ${input.impactFingerprint}, true)`);
  await executeRaw.call(tx, Prisma.sql`SELECT set_config('app.account_access_preview_request_fingerprint', ${input.requestFingerprint}, true)`);
}

async function setLifecycleContext(tx: Prisma.TransactionClient, input: Readonly<{
  actorId: string;
  userId: string;
  action: AccountAccessAction;
  event: "disabled" | "restored";
  versionAfter: number;
  requestKey: string;
  requestFingerprint: string;
  impactFingerprint: string;
  previewId: string;
}>): Promise<void> {
  const executeRaw = (tx as unknown as { $executeRaw?: (query: Prisma.Sql) => Promise<unknown> }).$executeRaw;
  if (typeof executeRaw !== "function") return;
  await executeRaw.call(tx, Prisma.sql`SELECT set_config('app.account_access_lifecycle_context', '1', true)`);
  await executeRaw.call(tx, Prisma.sql`SELECT set_config('app.account_access_lifecycle_actor_id', ${input.actorId}, true)`);
  await executeRaw.call(tx, Prisma.sql`SELECT set_config('app.account_access_lifecycle_user_id', ${input.userId}, true)`);
  await executeRaw.call(tx, Prisma.sql`SELECT set_config('app.account_access_lifecycle_action', ${input.action}, true)`);
  await executeRaw.call(tx, Prisma.sql`SELECT set_config('app.account_access_lifecycle_event', ${input.event}, true)`);
  await executeRaw.call(tx, Prisma.sql`SELECT set_config('app.account_access_lifecycle_preview_id', ${input.previewId}, true)`);
  await executeRaw.call(tx, Prisma.sql`SELECT set_config('app.account_access_lifecycle_version_after', ${input.versionAfter.toString()}, true)`);
  await executeRaw.call(tx, Prisma.sql`SELECT set_config('app.account_access_lifecycle_request_key', ${input.requestKey}, true)`);
  await executeRaw.call(tx, Prisma.sql`SELECT set_config('app.account_access_lifecycle_request_fingerprint', ${input.requestFingerprint}, true)`);
  await executeRaw.call(tx, Prisma.sql`SELECT set_config('app.account_access_lifecycle_impact_fingerprint', ${input.impactFingerprint}, true)`);
}

async function previewInTransaction(
  tx: Prisma.TransactionClient,
  input: AccountAccessPreviewInput,
  now: Date,
): Promise<AccountAccessPreview> {
  const adminId = userId(input.adminUserId);
  const targetId = userId(input.userId);
  const nextAction = action(input.action);
  if (adminId === targetId) return fail("ACCOUNT_ACCESS_SELF_FORBIDDEN");
  const target = await loadTarget(tx, targetId);
  if (target === null) return fail("ACCOUNT_ACCESS_USER_NOT_FOUND");
  const state = targetState(target);
  assertActionAllowed(nextAction, state);
  const currentVersion = positiveVersion(target.accountAccessVersion)!;
  const expected = positiveVersion(input.expectedVersion, false);
  if (expected !== undefined && expected !== currentVersion) return fail("ACCOUNT_ACCESS_PREVIEW_STALE");
  const reason = requiredReason(input.reason);
  const sessionCount = await activeSessionCount(tx, targetId);
  const impact = impactFingerprint({ target, action: nextAction, sessionCount });
  const issuedAt = new Date(now.getTime());
  const expiresAt = new Date(issuedAt.getTime() + PREVIEW_TTL_MS);
  const request = requestFingerprint({
    userId: targetId,
    action: nextAction,
    expectedVersion: currentVersion,
    impactFingerprint: impact,
    reason,
    previewIssuedAt: issuedAt,
    previewExpiresAt: expiresAt,
  });
  const categories: string[] = [];
  if (nextAction === "disable" && target.role === "admin" && await enabledAdminCount(tx) <= 1) {
    categories.push("last_enabled_system_admin");
  }
  if (nextAction === "disable") {
    const ownerWorkspaces = await ownerWorkspaceIds(tx, targetId);
    if (await lastOwnerWorkspaceCount(tx, ownerWorkspaces) > 0) {
      categories.push("last_enabled_workspace_owner");
    }
  }
  const previewId = randomUUID();
  await setPreviewContext(tx, {
    previewId,
    actorId: adminId,
    userId: targetId,
    action: nextAction,
    expectedVersion: currentVersion,
    impactFingerprint: impact,
    requestFingerprint: request,
  });
  await tx.accountAccessMutationPreview.create({
    data: {
      id: previewId,
      actorId: adminId,
      userId: targetId,
      action: nextAction,
      expectedVersion: currentVersion,
      impactFingerprint: impact,
      requestFingerprint: request,
      issuedAt,
      expiresAt,
    },
  });
  return Object.freeze({
    action: nextAction,
    user: Object.freeze({
      id: target.id,
      username: target.username,
      displayName: target.displayName,
      role: target.role === "admin" ? "admin" : "user",
      state,
    }),
    current: Object.freeze({ state, accountAccessVersion: currentVersion, disabledAt: target.disabledAt, sessionCount }),
    target: Object.freeze({
      state: nextAction === "disable" ? "disabled" : "enabled",
      accountAccessVersion: currentVersion + 1,
      disabledAt: nextAction === "disable" ? issuedAt : null,
      sessionCount,
    }),
    blockingCategories: Object.freeze(categories),
    canExecute: categories.length === 0,
    impactFingerprint: impact,
    requestFingerprint: request,
    previewId,
    issuedAt,
    expiresAt,
    previewIssuedAt: issuedAt,
    previewExpiresAt: expiresAt,
  });
}

export async function previewAccountAccess(
  input: AccountAccessPreviewInput,
  db: PrismaClient = getDb(),
): Promise<AccountAccessPreview> {
  const adminId = userId(input.adminUserId);
  const expectedAdminVersion = positiveVersion(input.adminAccountAccessVersion)!;
  const targetId = userId(input.userId);
  await assertAdmin(adminId, db);
  try {
    return await db.$transaction(async (tx) => {
      await lockActorsAccess(tx, [adminId, targetId]);
      const targetOwnerWorkspaces = await ownerWorkspaceIds(tx, targetId);
      for (const workspaceId of targetOwnerWorkspaces) await lockWorkspaceAccess(tx, workspaceId);
      assertAdminSnapshot(await loadAdmin(tx, adminId), expectedAdminVersion);
      return previewInTransaction(tx, { ...input, adminUserId: adminId, userId: targetId }, await databaseNow(tx));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: MUTATION_TRANSACTION_TIMEOUT_MS });
  } catch (error) {
    if (isTransactionConflict(error)) return fail("ACCOUNT_ACCESS_CONFLICT");
    throw error;
  }
}

type AccountAccessMutationResult = Readonly<{
  id: string;
  username: string;
  displayName: string | null;
  role: "admin" | "user";
  state: AccountAccessState;
  disabledAt: Date | null;
  accountAccessVersion: number;
  revokedSessionCount: number;
  event: "disabled" | "restored";
  replayed?: boolean;
}>;

function publicMutationResult(input: Readonly<{
  target: AccountTarget;
  disabledAt: Date | null;
  accountAccessVersion: number;
  event: "disabled" | "restored";
  revokedSessionCount: number;
  replayed?: boolean;
}>): AccountAccessMutationResult {
  return Object.freeze({
    id: input.target.id,
    username: input.target.username,
    displayName: input.target.displayName,
    role: input.target.role === "admin" ? "admin" : "user",
    state: input.disabledAt === null ? "enabled" : "disabled",
    disabledAt: input.disabledAt,
    accountAccessVersion: input.accountAccessVersion,
    revokedSessionCount: input.revokedSessionCount,
    event: input.event,
    ...(input.replayed === true ? { replayed: true } : {}),
  });
}

async function executeInTransaction(
  tx: Prisma.TransactionClient,
  input: AccountAccessExecuteInput,
  now: Date,
): Promise<AccountAccessMutationResult> {
  const adminId = userId(input.adminUserId);
  const targetId = userId(input.userId);
  const nextAction = action(input.action);
  const key = requestKey(input.requestKey);
  const expectedImpact = fingerprint(input.expectedImpactFingerprint);
  const suppliedFingerprint = fingerprint(input.requestFingerprint);
  const version = positiveVersion(input.expectedVersion)!;
  const previewId = userId(input.previewId);
  const previewIssuedAt = dateValue(input.previewIssuedAt);
  const previewExpiresAt = dateValue(input.previewExpiresAt);
  if (adminId === targetId) return fail("ACCOUNT_ACCESS_SELF_FORBIDDEN");
  if (input.confirmation !== true) return fail("ACCOUNT_ACCESS_CONFIRMATION_REQUIRED");
  const target = await loadTarget(tx, targetId);
  if (target === null) return fail("ACCOUNT_ACCESS_USER_NOT_FOUND");
  if (input.confirmationUsername !== target.username) return fail("ACCOUNT_ACCESS_CONFIRMATION_REQUIRED");
  const reason = requiredReason(input.reason);
  const calculatedFingerprint = requestFingerprint({
    userId: targetId,
    action: nextAction,
    expectedVersion: version,
    impactFingerprint: expectedImpact,
    reason,
    previewIssuedAt,
    previewExpiresAt,
  });
  if (calculatedFingerprint !== suppliedFingerprint) return fail("ACCOUNT_ACCESS_IDEMPOTENCY_CONFLICT");
  const existingAudit = await tx.accountAccessAudit.findFirst({
    where: { actorId: adminId, requestKey: key },
    orderBy: { createdAt: "asc" },
  });
  if (existingAudit !== null) {
    if (
      existingAudit.requestFingerprint !== suppliedFingerprint
      || existingAudit.previewId !== previewId
      || existingAudit.userId !== targetId
    ) return fail("ACCOUNT_ACCESS_IDEMPOTENCY_CONFLICT");
    return publicMutationResult({
      target,
      disabledAt: existingAudit.disabledAtAfter,
      accountAccessVersion: existingAudit.versionAfter,
      event: existingAudit.event,
      revokedSessionCount: 0,
      replayed: true,
    });
  }
  assertPreviewEvidence({ issuedAt: previewIssuedAt, expiresAt: previewExpiresAt, now });
  const preview = await tx.accountAccessMutationPreview.findUnique({ where: { id: previewId } });
  if (
    preview === null
    || preview.actorId !== adminId
    || preview.userId !== targetId
    || preview.action !== nextAction
    || preview.expectedVersion !== version
    || preview.impactFingerprint !== expectedImpact
    || preview.requestFingerprint !== suppliedFingerprint
    || preview.issuedAt.getTime() !== previewIssuedAt.getTime()
    || preview.expiresAt.getTime() !== previewExpiresAt.getTime()
  ) return fail("ACCOUNT_ACCESS_PREVIEW_STALE");
  if (preview.consumedAt !== null) return fail("ACCOUNT_ACCESS_PREVIEW_STALE");
  assertPreviewEvidence({ issuedAt: preview.issuedAt, expiresAt: preview.expiresAt, now });
  const state = targetState(target);
  assertActionAllowed(nextAction, state);
  const currentSessionCount = await activeSessionCount(tx, targetId);
  const currentImpact = impactFingerprint({ target, action: nextAction, sessionCount: currentSessionCount });
  if (target.accountAccessVersion !== version || currentImpact !== expectedImpact) return fail("ACCOUNT_ACCESS_PREVIEW_STALE");
  if (nextAction === "disable" && target.role === "admin" && await enabledAdminCount(tx) <= 1) return fail("ACCOUNT_ACCESS_LAST_ADMIN_REQUIRED");
  if (nextAction === "disable") {
    const ownerWorkspaces = await ownerWorkspaceIds(tx, targetId);
    if (await lastOwnerWorkspaceCount(tx, ownerWorkspaces) > 0) return fail("ACCOUNT_ACCESS_LAST_OWNER_REQUIRED");
  }
  const event = nextAction === "disable" ? "disabled" : "restored";
  const nextVersion = target.accountAccessVersion + 1;
  await setLifecycleContext(tx, {
    actorId: adminId,
    userId: targetId,
    action: nextAction,
    event,
    versionAfter: nextVersion,
    requestKey: key,
    requestFingerprint: suppliedFingerprint,
    impactFingerprint: currentImpact,
    previewId,
  });
  const updated = await tx.appUser.update({
    where: { id: targetId },
    data: nextAction === "disable"
      ? { accountAccessVersion: { increment: 1 }, disabledAt: now, disabledReason: reason, disabledById: adminId }
      : { accountAccessVersion: { increment: 1 }, disabledAt: null, disabledReason: null, disabledById: null },
    select: targetSelect,
  });
  const revoked = await tx.appSession.updateMany({
    where: { userId: targetId, revokedAt: null },
    data: { revokedAt: now },
  });
  const consumed = await tx.accountAccessMutationPreview.updateMany({
    where: { id: previewId, consumedAt: null },
    data: { consumedAt: now },
  });
  if (consumed.count !== 1) return fail("ACCOUNT_ACCESS_CONFLICT");
  await tx.accountAccessAudit.create({
    data: {
      userId: targetId,
      actorId: adminId,
      event,
      versionBefore: target.accountAccessVersion,
      versionAfter: updated.accountAccessVersion,
      disabledAtBefore: target.disabledAt,
      disabledAtAfter: updated.disabledAt,
      disabledReasonBefore: target.disabledReason,
      disabledReasonAfter: updated.disabledReason,
      disabledByIdBefore: target.disabledById,
      disabledByIdAfter: updated.disabledById,
      previewId,
      reason,
      requestKey: key,
      requestFingerprint: suppliedFingerprint,
      impactFingerprint: currentImpact,
      transitionAt: now,
      createdAt: now,
      contractVersion: 1,
    },
  });
  return publicMutationResult({
    target: updated,
    disabledAt: updated.disabledAt,
    accountAccessVersion: updated.accountAccessVersion,
    event,
    revokedSessionCount: revoked.count,
  });
}

export async function executeAccountAccess(
  input: AccountAccessExecuteInput,
  db: PrismaClient = getDb(),
): Promise<AccountAccessMutationResult> {
  const adminId = userId(input.adminUserId);
  const expectedAdminVersion = positiveVersion(input.adminAccountAccessVersion)!;
  const targetId = userId(input.userId);
  await assertAdmin(adminId, db);
  try {
    return await db.$transaction(async (tx) => {
      await lockActorsAccess(tx, [adminId, targetId]);
      const targetOwnerWorkspaces = await ownerWorkspaceIds(tx, targetId);
      for (const workspaceId of targetOwnerWorkspaces) await lockWorkspaceAccess(tx, workspaceId);
      assertAdminSnapshot(await loadAdmin(tx, adminId), expectedAdminVersion);
      return executeInTransaction(tx, { ...input, adminUserId: adminId, userId: targetId }, await databaseNow(tx));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: MUTATION_TRANSACTION_TIMEOUT_MS });
  } catch (error) {
    if (isTransactionConflict(error) || isPrismaCode(error, "P2002") || /P2002|unique constraint|duplicate key/iu.test(error instanceof Error ? error.message : "")) return fail("ACCOUNT_ACCESS_CONFLICT");
    if (isPrismaCode(error, "P2003") || /23514|check_violation|account access|app_user_account_access|AppUser_account_access|AccountAccess/iu.test(error instanceof Error ? error.message : "")) return fail("ACCOUNT_ACCESS_CONFLICT");
    throw error;
  }
}

export async function listAccountAccess(input: Readonly<{
  adminUserId: string;
  adminAccountAccessVersion: number;
  search?: string;
  page?: number;
  pageSize?: number;
}>, db: PrismaClient = getDb()) {
  const adminId = userId(input.adminUserId);
  const expectedAdminVersion = positiveVersion(input.adminAccountAccessVersion)!;
  await assertAdmin(adminId, db);
  const page = Number.isSafeInteger(input.page) && (input.page ?? 1) >= 1 ? input.page ?? 1 : 1;
  const pageSize = Number.isSafeInteger(input.pageSize) && (input.pageSize ?? 20) >= 1 ? Math.min(input.pageSize ?? 20, 100) : 20;
  const search = input.search?.trim().slice(0, 160) ?? "";
  const where: Prisma.AppUserWhereInput = search.length === 0 ? {} : {
    OR: [
      { username: { contains: search, mode: "insensitive" } },
      { displayName: { contains: search, mode: "insensitive" } },
    ],
  };
  return db.$transaction(async (tx) => {
    await lockActorsAccess(tx, [adminId]);
    assertAdminSnapshot(await loadAdmin(tx, adminId), expectedAdminVersion);
    const users = await tx.appUser.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize + 1,
      select: {
        id: true,
        username: true,
        displayName: true,
        role: true,
        disabledAt: true,
        accountAccessVersion: true,
        _count: { select: { sessions: true } },
      },
    });
    const hasNextPage = users.length > pageSize;
    const items = users.slice(0, pageSize).map((user) => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role === "admin" ? "admin" as const : "user" as const,
      state: user.disabledAt === null ? "enabled" as const : "disabled" as const,
      disabledAt: user.disabledAt,
      accountAccessVersion: user.accountAccessVersion,
      sessionCount: user._count.sessions,
    }));
    return Object.freeze({ items, page, pageSize, hasNextPage });
  });
}
