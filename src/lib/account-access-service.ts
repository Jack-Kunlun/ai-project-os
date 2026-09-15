import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Prisma, type AppUser, type PrismaClient, type ProjectMembershipRole, type WorkspaceMembershipRole } from "@prisma/client";
import { z } from "zod";
import {
  highestProjectPermission,
  projectRolePermission,
  workspaceRolePermission,
  type ProjectPermission,
} from "@/lib/access-control";
import { lockActorsAccess, lockWorkspaceAccess } from "@/lib/access-linearization";
import { loadOrCreateMasterKey } from "@/lib/credential-vault";
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

const ACCESS_MATRIX_PAGE_SIZE_DEFAULT = 20;
const ACCESS_MATRIX_PAGE_SIZE_MAX = 100;
const ACCESS_MATRIX_CURSOR_VERSION = 1 as const;
const ACCESS_MATRIX_CURSOR_CONTEXT = "ai-project-os:account-access-matrix-cursor:v1";
const ACCESS_MATRIX_READ_TRANSACTION_TIMEOUT_MS = 30_000;

type AccessMatrixCursor = Readonly<{
  subjectId: string;
  kind: "workspace" | "project";
  pageSize: number;
  createdAt: Date;
  id: string;
}>;

type AccessMatrixCursorPayload = Readonly<{
  version: typeof ACCESS_MATRIX_CURSOR_VERSION;
  subjectId: string;
  kind: "workspace" | "project";
  pageSize: number;
  createdAt: string;
  id: string;
}>;

export type AccessMatrixReason =
  | "account_disabled"
  | "account_enabled"
  | "system_admin_role"
  | "system_user_role"
  | "membership_active"
  | "membership_not_started"
  | "membership_expired"
  | "membership_revoked"
  | "membership_none"
  | "workspace_membership_confirmed"
  | "workspace_membership_pending"
  | "workspace_membership_revoked"
  | "workspace_membership_missing"
  | "workspace_role_not_elevated"
  | "project_inheritance_enabled"
  | "project_inheritance_disabled"
  | "direct_project_assignment_confirmed"
  | "direct_project_assignment_pending"
  | "direct_project_assignment_revoked"
  | "direct_project_assignment_missing"
  | "no_effective_project_permission";

export type AccessMatrixAuditEvidence = Readonly<{
  kind: "membership_access_audit" | "membership_record";
  action: "confirmed" | "revoked" | "migration_quarantined" | "bootstrap_confirmed";
}>;

export type AccessMatrixRevocation = Readonly<{
  recordedAt: string;
  evidence: AccessMatrixAuditEvidence;
}>;

export type AccessMatrixMembership = Readonly<{
  role: WorkspaceMembershipRole | ProjectMembershipRole;
  accessState: "pending" | "confirmed";
  recordedAt: string;
}>;

export type AccessMatrixWorkspaceProvenance = Readonly<{
  kind: "workspace_membership" | "none";
}>;

export type AccessMatrixProjectProvenance = Readonly<{
  kind:
    | "direct_project_assignment"
    | "workspace_inherited_owner_or_admin"
    | "direct_and_workspace_inherited"
    | "workspace_membership"
    | "none";
}>;

export type EffectiveAccessMatrix = Readonly<{
  asOf: string;
  subject: Readonly<{
    id: string;
    username: string;
    displayName: string | null;
  }>;
  system: Readonly<{
    role: "admin" | "user";
    accountState: AccountAccessState;
    effective: boolean;
    reasons: readonly AccessMatrixReason[];
    source: Readonly<{ kind: "app_user" }>;
  }>;
  commercial: Readonly<{
    tier: "member" | "free";
    lifecycle: "none" | "not_started" | "active" | "expired" | "revoked";
    entitlementEffective: boolean;
    startsAt: string | null;
    expiresAt: string | null;
    reasons: readonly AccessMatrixReason[];
    source:
      | Readonly<{ kind: "none" }>
      | Readonly<{ kind: "membership_subscription"; recordedAt: string }>;
  }>;
  workspaces: Readonly<{
    items: readonly Readonly<{
      id: string;
      name: string;
      slug: string;
      current: AccessMatrixMembership | null;
      latestRevocation: AccessMatrixRevocation | null;
      effective: boolean;
      reasons: readonly AccessMatrixReason[];
      provenance: AccessMatrixWorkspaceProvenance;
    }>[];
    nextCursor: string | null;
    hasMore: boolean;
  }>;
  projects: Readonly<{
    items: readonly Readonly<{
      id: string;
      name: string;
      slug: string;
      workspaceId: string;
      workspaceName: string;
      inheritanceMode: "workspaceInherited" | "projectOnly";
      archivedAt: string | null;
      direct: AccessMatrixMembership | null;
      latestDirectRevocation: AccessMatrixRevocation | null;
      inheritedFromWorkspace: Readonly<{
        role: WorkspaceMembershipRole | null;
        accessState: "pending" | "confirmed" | "revoked" | null;
        recordedAt: string | null;
        effective: boolean;
        provenance: Readonly<{
          kind: "workspace_inherited_owner_or_admin" | "workspace_membership" | "none";
        }>;
      }> | null;
      grantedPermission: ProjectPermission | null;
      effectivePermission: ProjectPermission | null;
      reasons: readonly AccessMatrixReason[];
      provenance: AccessMatrixProjectProvenance;
    }>[];
    nextCursor: string | null;
    hasMore: boolean;
  }>;
}>;

const accessMatrixCursorSchema = z.object({
  version: z.literal(ACCESS_MATRIX_CURSOR_VERSION),
  subjectId: z.string().uuid(),
  kind: z.enum(["workspace", "project"]),
  pageSize: z.number().int().min(1).max(ACCESS_MATRIX_PAGE_SIZE_MAX),
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
}).strict();

function accessMatrixPageSize(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return ACCESS_MATRIX_PAGE_SIZE_DEFAULT;
  return Math.min(value as number, ACCESS_MATRIX_PAGE_SIZE_MAX);
}

function canonicalAccessMatrixCursorPayload(input: AccessMatrixCursorPayload): string {
  return JSON.stringify(input);
}

function accessMatrixCursorSignature(key: Buffer, encodedPayload: string): string {
  return createHmac("sha256", key)
    .update(ACCESS_MATRIX_CURSOR_CONTEXT, "utf8")
    .update("\0", "utf8")
    .update(encodedPayload, "utf8")
    .digest("base64url");
}

function encodeAccessMatrixCursor(key: Buffer, input: AccessMatrixCursor): string {
  const payload: AccessMatrixCursorPayload = {
    version: ACCESS_MATRIX_CURSOR_VERSION,
    subjectId: input.subjectId.toLowerCase(),
    kind: input.kind,
    pageSize: input.pageSize,
    createdAt: input.createdAt.toISOString(),
    id: input.id.toLowerCase(),
  };
  const encodedPayload = Buffer.from(canonicalAccessMatrixCursorPayload(payload), "utf8").toString("base64url");
  return encodedPayload + "." + accessMatrixCursorSignature(key, encodedPayload);
}

function decodeAccessMatrixCursor(
  key: Buffer,
  value: unknown,
  expected: Readonly<Pick<AccessMatrixCursor, "subjectId" | "kind" | "pageSize">>,
): AccessMatrixCursor | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 512) return fail("ACCOUNT_ACCESS_INVALID_INPUT");
  const [encodedPayload, signature, ...rest] = value.split(".");
  if (
    encodedPayload === undefined
    || signature === undefined
    || rest.length > 0
    || !/^[A-Za-z0-9_-]+$/u.test(encodedPayload)
    || !/^[A-Za-z0-9_-]+$/u.test(signature)
  ) return fail("ACCOUNT_ACCESS_INVALID_INPUT");
  const expectedSignature = accessMatrixCursorSignature(key, encodedPayload);
  let supplied: Buffer;
  let expectedBuffer: Buffer;
  try {
    supplied = Buffer.from(signature, "base64url");
    expectedBuffer = Buffer.from(expectedSignature, "base64url");
  } catch {
    return fail("ACCOUNT_ACCESS_INVALID_INPUT");
  }
  if (
    supplied.toString("base64url") !== signature
    || supplied.length !== expectedBuffer.length
    || !timingSafeEqual(supplied, expectedBuffer)
  ) return fail("ACCOUNT_ACCESS_INVALID_INPUT");
  const decoded = Buffer.from(encodedPayload, "base64url").toString("utf8");
  if (Buffer.from(decoded, "utf8").toString("base64url") !== encodedPayload) return fail("ACCOUNT_ACCESS_INVALID_INPUT");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(decoded) as unknown;
  } catch {
    return fail("ACCOUNT_ACCESS_INVALID_INPUT");
  }
  const parsed = accessMatrixCursorSchema.safeParse(parsedJson);
  if (!parsed.success) return fail("ACCOUNT_ACCESS_INVALID_INPUT");
  const createdAt = new Date(parsed.data.createdAt);
  if (Number.isNaN(createdAt.getTime())) return fail("ACCOUNT_ACCESS_INVALID_INPUT");
  const canonicalPayload: AccessMatrixCursorPayload = {
    version: ACCESS_MATRIX_CURSOR_VERSION,
    subjectId: parsed.data.subjectId.toLowerCase(),
    kind: parsed.data.kind,
    pageSize: parsed.data.pageSize,
    createdAt: createdAt.toISOString(),
    id: parsed.data.id.toLowerCase(),
  };
  if (canonicalAccessMatrixCursorPayload(canonicalPayload) !== decoded) return fail("ACCOUNT_ACCESS_INVALID_INPUT");
  if (
    canonicalPayload.subjectId !== expected.subjectId.toLowerCase()
    || canonicalPayload.kind !== expected.kind
    || canonicalPayload.pageSize !== expected.pageSize
  ) return fail("ACCOUNT_ACCESS_INVALID_INPUT");
  return Object.freeze({
    subjectId: canonicalPayload.subjectId,
    kind: canonicalPayload.kind,
    pageSize: canonicalPayload.pageSize,
    createdAt,
    id: canonicalPayload.id,
  });
}

function afterAccessMatrixCursor(cursor: AccessMatrixCursor | null): Readonly<{
  OR: [
    { createdAt: { gt: Date } },
    { createdAt: Date; id: { gt: string } },
  ];
}> | Record<string, never> {
  if (cursor === null) return {};
  return {
    OR: [
      { createdAt: { gt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { gt: cursor.id } },
    ],
  };
}

function accessMatrixRecordedAt(value: Date): string {
  return value.toISOString();
}

export type AccessMatrixMembershipRow = Readonly<{
  id: string;
  role: WorkspaceMembershipRole | ProjectMembershipRole;
  accessState: "pending" | "confirmed" | "revoked";
  createdAt: Date;
  updatedAt: Date;
}>;

type AccessMatrixWorkspaceMembershipRow = AccessMatrixMembershipRow & Readonly<{ workspaceId: string }>;
type AccessMatrixProjectMembershipRow = AccessMatrixMembershipRow & Readonly<{ projectId: string }>;

type AccessMatrixAuditRow = Readonly<{
  membershipId: string;
  action: "confirmed" | "revoked" | "migrationQuarantined" | "bootstrapConfirmed";
  createdAt: Date;
}>;

function membershipForDto(row: AccessMatrixMembershipRow): AccessMatrixMembership | null {
  if (row.accessState === "revoked") return null;
  return Object.freeze({
    role: row.role,
    accessState: row.accessState,
    recordedAt: accessMatrixRecordedAt(row.updatedAt),
  });
}

function auditAction(value: AccessMatrixAuditRow["action"]): AccessMatrixAuditEvidence["action"] {
  if (value === "migrationQuarantined") return "migration_quarantined";
  if (value === "bootstrapConfirmed") return "bootstrap_confirmed";
  return value;
}

function revocationForDto(
  row: AccessMatrixMembershipRow | null,
  audit: AccessMatrixAuditRow | undefined,
): AccessMatrixRevocation | null {
  if (row === null || row.accessState !== "revoked") return null;
  return Object.freeze({
    recordedAt: accessMatrixRecordedAt(audit?.createdAt ?? row.updatedAt),
    evidence: Object.freeze({
      kind: audit === undefined ? "membership_record" as const : "membership_access_audit" as const,
      action: auditAction(audit?.action ?? "revoked"),
    }),
  });
}

function mapAudits(rows: readonly AccessMatrixAuditRow[]): Map<string, AccessMatrixAuditRow> {
  const result = new Map<string, AccessMatrixAuditRow>();
  for (const row of rows) {
    // The query is ordered newest first.  Keep one bounded, safe audit label
    // per membership rather than exposing a history or relying on ordering
    // supplied by a caller.
    if (!result.has(row.membershipId)) result.set(row.membershipId, row);
  }
  return result;
}

/**
 * Split a bounded batch into its sole current relationship and its latest
 * revoked relationship.  This pure projection is also the query-budget
 * contract: callers must batch rows before invoking it, never query per scope.
 */
export function groupAccessMatrixMembershipRows<T extends AccessMatrixMembershipRow>(
  rows: readonly T[],
  scopeOf: (row: T) => string,
): Readonly<{
  current: ReadonlyMap<string, T>;
  latestRevoked: ReadonlyMap<string, T>;
}> {
  const current = new Map<string, T>();
  const latestRevoked = new Map<string, T>();
  for (const row of rows) {
    const scope = scopeOf(row);
    if (row.accessState === "revoked") {
      const previous = latestRevoked.get(scope);
      if (
        previous === undefined
        || row.updatedAt.getTime() > previous.updatedAt.getTime()
        || (row.updatedAt.getTime() === previous.updatedAt.getTime() && row.id > previous.id)
      ) latestRevoked.set(scope, row);
      continue;
    }
    if (current.has(scope)) return fail("ACCOUNT_ACCESS_CONFLICT");
    current.set(scope, row);
  }
  return Object.freeze({ current, latestRevoked });
}

function currentWorkspaceReasons(
  current: AccessMatrixMembership | null,
  latestRevocation: AccessMatrixRevocation | null,
  enabled: boolean,
): AccessMatrixReason[] {
  const reasons: AccessMatrixReason[] = current === null
    ? [latestRevocation === null ? "workspace_membership_missing" : "workspace_membership_revoked"]
    : current.accessState === "pending"
      ? ["workspace_membership_pending"]
      : ["workspace_membership_confirmed"];
  if (!enabled) reasons.push("account_disabled");
  return reasons;
}

function subscriptionLifecycle(
  subscription: Readonly<{ status: "active" | "revoked"; startsAt: Date; expiresAt: Date }> | null,
  now: Date,
): "none" | "not_started" | "active" | "expired" | "revoked" {
  if (subscription === null) return "none";
  if (subscription.status === "revoked") return "revoked";
  if (subscription.startsAt > now) return "not_started";
  if (subscription.expiresAt <= now) return "expired";
  return "active";
}

function commercialReasons(
  lifecycle: "none" | "not_started" | "active" | "expired" | "revoked",
  enabled: boolean,
): AccessMatrixReason[] {
  const reasons: AccessMatrixReason[] = [
    lifecycle === "none" ? "membership_none"
      : lifecycle === "not_started" ? "membership_not_started"
        : lifecycle === "active" ? "membership_active"
          : lifecycle === "expired" ? "membership_expired" : "membership_revoked",
  ];
  if (!enabled) reasons.push("account_disabled");
  return reasons;
}

function projectReasons(input: Readonly<{
  direct: AccessMatrixMembership | null;
  latestDirectRevocation: AccessMatrixRevocation | null;
  inherited: Readonly<{
    role: WorkspaceMembershipRole | null;
    accessState: "pending" | "confirmed" | "revoked" | null;
    effective: boolean;
  }> | null;
  inheritedPermission: ProjectPermission | null;
  inheritanceMode: "workspaceInherited" | "projectOnly";
  grantedPermission: ProjectPermission | null;
  effectivePermission: ProjectPermission | null;
  enabled: boolean;
}>): AccessMatrixReason[] {
  const reasons: AccessMatrixReason[] = [];
  if (input.direct === null) {
    reasons.push(input.latestDirectRevocation === null ? "direct_project_assignment_missing" : "direct_project_assignment_revoked");
  } else if (input.direct.accessState === "pending") {
    reasons.push("direct_project_assignment_pending");
  } else {
    reasons.push("direct_project_assignment_confirmed");
  }
  if (input.inheritanceMode === "workspaceInherited") {
    reasons.push("project_inheritance_enabled");
    // `effective` on the DTO includes the account-disabled overlay.  Reasons
    // must still describe a confirmed elevated relationship underneath that
    // overlay, otherwise a disabled owner would be mislabeled as non-elevated.
    if (input.inheritedPermission !== null) {
      // The inherited role is intentionally represented only by the safe
      // provenance and the resulting permission, never by another actor.
      reasons.push("workspace_membership_confirmed");
    } else if (input.inherited?.accessState === "pending") {
      reasons.push("workspace_membership_pending");
    } else if (input.inherited?.accessState === "revoked") {
      reasons.push("workspace_membership_revoked");
    } else if (input.inherited !== null && input.inherited.role !== null) {
      reasons.push("workspace_role_not_elevated");
    } else {
      reasons.push("workspace_membership_missing");
    }
  } else {
    reasons.push("project_inheritance_disabled");
  }
  if (input.grantedPermission === null) reasons.push("no_effective_project_permission");
  if (!input.enabled) reasons.push("account_disabled");
  return reasons;
}

function projectProvenance(input: Readonly<{
  direct: AccessMatrixMembership | null;
  inherited: Readonly<{
    role: WorkspaceMembershipRole | null;
    accessState: "pending" | "confirmed" | "revoked" | null;
    provenance: Readonly<{
      kind: "workspace_inherited_owner_or_admin" | "workspace_membership" | "none";
    }>;
  }> | null;
  inheritanceMode: "workspaceInherited" | "projectOnly";
}>): AccessMatrixProjectProvenance {
  // Provenance describes only confirmed grants that contributed to the
  // relationship-calculated permission.  Pending/revoked/directly unrelated
  // records remain available through the DTO and reasons, but are not an
  // authorization source.  Account disabled is intentionally ignored here:
  // grantedPermission is the underlying relationship result and must retain
  // its source while effectivePermission is separately nulled.
  const hasConfirmedDirect = input.direct?.accessState === "confirmed";
  const hasConfirmedElevatedInherited = input.inheritanceMode === "workspaceInherited"
    && input.inherited?.accessState === "confirmed"
    && input.inherited.provenance.kind === "workspace_inherited_owner_or_admin";
  if (hasConfirmedDirect && hasConfirmedElevatedInherited) return Object.freeze({ kind: "direct_and_workspace_inherited" });
  if (hasConfirmedDirect) return Object.freeze({ kind: "direct_project_assignment" });
  if (hasConfirmedElevatedInherited) return Object.freeze({ kind: "workspace_inherited_owner_or_admin" });
  return Object.freeze({ kind: "none" });
}

function projectPermissionFromRole(role: ProjectMembershipRole | null): ProjectPermission | null {
  return role === null ? null : projectRolePermission(role);
}

async function membershipAuditRows(
  db: Prisma.TransactionClient,
  kind: "workspace" | "project",
  membershipIds: readonly string[],
): Promise<AccessMatrixAuditRow[]> {
  if (membershipIds.length === 0) return [];
  return db.membershipAccessAudit.findMany({
    where: { membershipKind: kind, membershipId: { in: [...new Set(membershipIds)] }, action: "revoked" },
    orderBy: [{ createdAt: "desc" }, { membershipId: "asc" }],
    select: { membershipId: true, action: true, createdAt: true },
  }) as Promise<AccessMatrixAuditRow[]>;
}

async function workspaceMembershipRows(
  db: Prisma.TransactionClient,
  workspaceIds: readonly string[],
  subjectId: string,
): Promise<AccessMatrixWorkspaceMembershipRow[]> {
  if (workspaceIds.length === 0) return [];
  const scopeIds = [...new Set(workspaceIds)];
  const scopes = Prisma.join(scopeIds.map((id) => Prisma.sql`${id}::uuid`));
  return db.$queryRaw<AccessMatrixWorkspaceMembershipRow[]>(Prisma.sql`
    WITH "current_candidates" AS (
      SELECT "id", "workspaceId", "role", "accessState", "createdAt", "updatedAt",
        row_number() OVER (
          PARTITION BY "workspaceId"
          ORDER BY "updatedAt" DESC, "id" DESC
        ) AS "candidateRank"
      FROM "WorkspaceMembership"
      WHERE "workspaceId" IN (${scopes})
        AND "userId" = ${subjectId}::uuid
        AND "accessState" <> 'revoked'
    ),
    "latest_revoked" AS (
      SELECT "id", "workspaceId", "role", "accessState", "createdAt", "updatedAt",
        row_number() OVER (
          PARTITION BY "workspaceId"
          ORDER BY "updatedAt" DESC, "id" DESC
        ) AS "candidateRank"
      FROM "WorkspaceMembership"
      WHERE "workspaceId" IN (${scopes})
        AND "userId" = ${subjectId}::uuid
        AND "accessState" = 'revoked'
    )
    SELECT "id", "workspaceId", "role", "accessState", "createdAt", "updatedAt"
    FROM "current_candidates"
    WHERE "candidateRank" <= 2
    UNION ALL
    SELECT "id", "workspaceId", "role", "accessState", "createdAt", "updatedAt"
    FROM "latest_revoked"
    WHERE "candidateRank" = 1
  `);
}

async function projectMembershipRows(
  db: Prisma.TransactionClient,
  projectIds: readonly string[],
  subjectId: string,
): Promise<AccessMatrixProjectMembershipRow[]> {
  if (projectIds.length === 0) return [];
  const scopeIds = [...new Set(projectIds)];
  const scopes = Prisma.join(scopeIds.map((id) => Prisma.sql`${id}::uuid`));
  return db.$queryRaw<AccessMatrixProjectMembershipRow[]>(Prisma.sql`
    WITH "current_candidates" AS (
      SELECT "id", "projectId", "role", "accessState", "createdAt", "updatedAt",
        row_number() OVER (
          PARTITION BY "projectId"
          ORDER BY "updatedAt" DESC, "id" DESC
        ) AS "candidateRank"
      FROM "ProjectMembership"
      WHERE "projectId" IN (${scopes})
        AND "userId" = ${subjectId}::uuid
        AND "accessState" <> 'revoked'
    ),
    "latest_revoked" AS (
      SELECT "id", "projectId", "role", "accessState", "createdAt", "updatedAt",
        row_number() OVER (
          PARTITION BY "projectId"
          ORDER BY "updatedAt" DESC, "id" DESC
        ) AS "candidateRank"
      FROM "ProjectMembership"
      WHERE "projectId" IN (${scopes})
        AND "userId" = ${subjectId}::uuid
        AND "accessState" = 'revoked'
    )
    SELECT "id", "projectId", "role", "accessState", "createdAt", "updatedAt"
    FROM "current_candidates"
    WHERE "candidateRank" <= 2
    UNION ALL
    SELECT "id", "projectId", "role", "accessState", "createdAt", "updatedAt"
    FROM "latest_revoked"
    WHERE "candidateRank" = 1
  `);
}

async function getEffectiveAccessMatrixInTransaction(
  tx: Prisma.TransactionClient,
  input: Readonly<{
    subjectId: string;
    workspaceCursor: AccessMatrixCursor | null;
    projectCursor: AccessMatrixCursor | null;
    pageSize: number;
    cursorKey: Buffer;
  }>,
  now: Date,
): Promise<EffectiveAccessMatrix> {
  const subject = await tx.appUser.findUnique({
    where: { id: input.subjectId },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      disabledAt: true,
      membershipSubscription: { select: { status: true, startsAt: true, expiresAt: true, createdAt: true, updatedAt: true } },
    },
  });
  if (subject === null) return fail("ACCOUNT_ACCESS_USER_NOT_FOUND");
  const enabled = subject.disabledAt === null;
  const role = subject.role === "admin" ? "admin" as const : "user" as const;
  const systemReasons: AccessMatrixReason[] = [role === "admin" ? "system_admin_role" : "system_user_role", enabled ? "account_enabled" : "account_disabled"];

  const lifecycle = subscriptionLifecycle(subject.membershipSubscription, now);
  const commercial = Object.freeze({
    tier: lifecycle === "active" ? "member" as const : "free" as const,
    lifecycle,
    entitlementEffective: lifecycle === "active" && enabled,
    startsAt: subject.membershipSubscription?.startsAt.toISOString() ?? null,
    expiresAt: subject.membershipSubscription?.expiresAt.toISOString() ?? null,
    reasons: Object.freeze(commercialReasons(lifecycle, enabled)),
    source: subject.membershipSubscription === null
      ? Object.freeze({ kind: "none" as const })
      : Object.freeze({ kind: "membership_subscription" as const, recordedAt: accessMatrixRecordedAt(subject.membershipSubscription.updatedAt) }),
  });

  const workspacePage = await tx.workspace.findMany({
    where: {
      memberships: { some: { userId: subject.id } },
      ...afterAccessMatrixCursor(input.workspaceCursor),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: input.pageSize + 1,
    select: { id: true, name: true, slug: true, createdAt: true },
  });
  const hasMoreWorkspaces = workspacePage.length > input.pageSize;
  const workspaceRows = workspacePage.slice(0, input.pageSize);

  const projectPage = await tx.project.findMany({
    where: {
      AND: [
        {
          OR: [
            { memberships: { some: { userId: subject.id } } },
            { workspace: { memberships: { some: { userId: subject.id } } } },
          ],
        },
        afterAccessMatrixCursor(input.projectCursor),
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: input.pageSize + 1,
    select: {
      id: true,
      name: true,
      slug: true,
      workspaceId: true,
      membershipInheritanceMode: true,
      archivedAt: true,
      createdAt: true,
    },
  });
  const hasMoreProjects = projectPage.length > input.pageSize;
  const projectRows = projectPage.slice(0, input.pageSize);
  const projectWorkspaceIds = [...new Set(projectRows.map((project) => project.workspaceId))];
  const allWorkspaceIds = [...new Set([...workspaceRows.map((workspace) => workspace.id), ...projectWorkspaceIds])];
  const [allWorkspaceMembershipRows, allProjectMembershipRows, projectWorkspaceRows] = await Promise.all([
    workspaceMembershipRows(tx, allWorkspaceIds, subject.id),
    projectMembershipRows(tx, projectRows.map((project) => project.id), subject.id),
    projectWorkspaceIds.length === 0
      ? Promise.resolve([] as Array<{ id: string; name: string }>)
      : tx.workspace.findMany({ where: { id: { in: projectWorkspaceIds } }, select: { id: true, name: true } }),
  ]);
  const workspaceMembershipGroups = groupAccessMatrixMembershipRows(allWorkspaceMembershipRows, (row) => row.workspaceId);
  const projectMembershipGroups = groupAccessMatrixMembershipRows(allProjectMembershipRows, (row) => row.projectId);
  const [workspaceRevokedAudits, projectRevokedAudits] = await Promise.all([
    membershipAuditRows(tx, "workspace", [...workspaceMembershipGroups.latestRevoked.values()].map((row) => row.id)),
    membershipAuditRows(tx, "project", [...projectMembershipGroups.latestRevoked.values()].map((row) => row.id)),
  ]).then(([workspaceRowsWithAudit, projectRowsWithAudit]) => [mapAudits(workspaceRowsWithAudit), mapAudits(projectRowsWithAudit)] as const);
  const workspaceItems = workspaceRows.map((workspace) => {
    const currentRow = workspaceMembershipGroups.current.get(workspace.id) ?? null;
    const latestRevokedRow = workspaceMembershipGroups.latestRevoked.get(workspace.id) ?? null;
    const current = currentRow === null ? null : membershipForDto(currentRow);
    const latestRevocation = revocationForDto(latestRevokedRow, latestRevokedRow === null ? undefined : workspaceRevokedAudits.get(latestRevokedRow.id));
    return Object.freeze({
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      current,
      latestRevocation,
      effective: enabled && current?.accessState === "confirmed",
      reasons: Object.freeze(currentWorkspaceReasons(current, latestRevocation, enabled)),
      provenance: Object.freeze({ kind: current?.accessState === "confirmed" ? "workspace_membership" as const : "none" as const }),
    });
  });
  const projectWorkspaceNames = new Map(projectWorkspaceRows.map((workspace) => [workspace.id, workspace.name]));

  const projectItems = projectRows.map((project) => {
    const directRow = projectMembershipGroups.current.get(project.id) ?? null;
    const latestDirectRow = projectMembershipGroups.latestRevoked.get(project.id) ?? null;
    const direct = directRow === null ? null : membershipForDto(directRow);
    const latestDirectRevocation = revocationForDto(latestDirectRow, latestDirectRow === null ? undefined : projectRevokedAudits.get(latestDirectRow.id));
    const currentWorkspaceRow = workspaceMembershipGroups.current.get(project.workspaceId) ?? null;
    const latestWorkspaceRow = workspaceMembershipGroups.latestRevoked.get(project.workspaceId) ?? null;
    const inheritedRow = currentWorkspaceRow ?? latestWorkspaceRow;
    const inheritedRole = inheritedRow?.role as WorkspaceMembershipRole | undefined;
    const inheritedState = inheritedRow?.accessState ?? null;
    const inheritedPermission = project.membershipInheritanceMode === "workspaceInherited"
      && inheritedState === "confirmed"
      && inheritedRole !== undefined
      ? workspaceRolePermission(inheritedRole)
      : null;
    const directPermission = direct?.accessState === "confirmed" ? projectPermissionFromRole(direct.role as ProjectMembershipRole) : null;
    const grantedPermission = highestProjectPermission(directPermission, inheritedPermission);
    const effectivePermission = enabled ? grantedPermission : null;
    const inheritedEffective = enabled && inheritedPermission !== null;
    const inheritedFromWorkspace = inheritedRow === null
      ? null
      : Object.freeze({
        role: inheritedRole ?? null,
        accessState: inheritedState,
        recordedAt: accessMatrixRecordedAt(inheritedRow.updatedAt),
        effective: inheritedEffective,
        provenance: Object.freeze({ kind: inheritedPermission !== null ? "workspace_inherited_owner_or_admin" as const : "none" as const }),
      });
    return Object.freeze({
      id: project.id,
      name: project.name,
      slug: project.slug,
      workspaceId: project.workspaceId,
      workspaceName: projectWorkspaceNames.get(project.workspaceId) ?? "未命名工作区",
      inheritanceMode: project.membershipInheritanceMode,
      archivedAt: project.archivedAt?.toISOString() ?? null,
      direct,
      latestDirectRevocation,
      inheritedFromWorkspace,
      grantedPermission,
      effectivePermission,
      reasons: Object.freeze(projectReasons({
        direct,
        latestDirectRevocation,
        inherited: inheritedFromWorkspace,
        inheritedPermission,
        inheritanceMode: project.membershipInheritanceMode,
        grantedPermission,
        effectivePermission,
        enabled,
      })),
      provenance: projectProvenance({
        direct,
        inherited: inheritedFromWorkspace,
        inheritanceMode: project.membershipInheritanceMode,
      }),
    });
  });
  const nextWorkspaceCursor = hasMoreWorkspaces && workspaceRows.length > 0
    ? encodeAccessMatrixCursor(input.cursorKey, {
      subjectId: subject.id,
      kind: "workspace",
      pageSize: input.pageSize,
      createdAt: workspaceRows[workspaceRows.length - 1]!.createdAt,
      id: workspaceRows[workspaceRows.length - 1]!.id,
    })
    : null;
  const nextProjectCursor = hasMoreProjects && projectRows.length > 0
    ? encodeAccessMatrixCursor(input.cursorKey, {
      subjectId: subject.id,
      kind: "project",
      pageSize: input.pageSize,
      createdAt: projectRows[projectRows.length - 1]!.createdAt,
      id: projectRows[projectRows.length - 1]!.id,
    })
    : null;

  return Object.freeze({
    asOf: now.toISOString(),
    subject: Object.freeze({ id: subject.id, username: subject.username, displayName: subject.displayName }),
    system: Object.freeze({
      role,
      accountState: enabled ? "enabled" as const : "disabled" as const,
      effective: enabled,
      reasons: Object.freeze(systemReasons),
      source: Object.freeze({ kind: "app_user" as const }),
    }),
    commercial,
    workspaces: Object.freeze({
      items: Object.freeze(workspaceItems),
      nextCursor: nextWorkspaceCursor,
      hasMore: hasMoreWorkspaces,
    }),
    projects: Object.freeze({
      items: Object.freeze(projectItems),
      nextCursor: nextProjectCursor,
      hasMore: hasMoreProjects,
    }),
  });
}

export async function getEffectiveAccessMatrix(input: Readonly<{
  adminUserId: string;
  adminAccountAccessVersion: number;
  userId: string;
  workspaceCursor?: string | null;
  projectCursor?: string | null;
  pageSize?: number;
}>, db: PrismaClient = getDb()): Promise<EffectiveAccessMatrix> {
  const adminId = userId(input.adminUserId);
  const expectedAdminVersion = positiveVersion(input.adminAccountAccessVersion)!;
  const subjectId = userId(input.userId);
  const pageSize = accessMatrixPageSize(input.pageSize);
  await assertAdmin(adminId, db);
  const cursorKey = await loadOrCreateMasterKey();
  const workspaceCursor = decodeAccessMatrixCursor(cursorKey, input.workspaceCursor, { subjectId, kind: "workspace", pageSize });
  const projectCursor = decodeAccessMatrixCursor(cursorKey, input.projectCursor, { subjectId, kind: "project", pageSize });
  try {
    return await db.$transaction(async (tx) => {
      await lockActorsAccess(tx, [adminId]);
      assertAdminSnapshot(await loadAdmin(tx, adminId), expectedAdminVersion);
      const now = await databaseNow(tx);
      return getEffectiveAccessMatrixInTransaction(tx, { subjectId, workspaceCursor, projectCursor, pageSize, cursorKey }, now);
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: ACCESS_MATRIX_READ_TRANSACTION_TIMEOUT_MS,
    });
  } catch (error) {
    if (isTransactionConflict(error)) return fail("ACCOUNT_ACCESS_CONFLICT");
    throw error;
  }
}
