import { createHash, randomUUID } from "node:crypto";
import { Prisma, type MembershipApplicationAudit, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { lockActorsAccess } from "@/lib/access-linearization";
import { getDb } from "@/lib/db";

export type MembershipApplicationStatus = "pending" | "fulfilled" | "rejected" | "withdrawn";
export type MembershipApplicationAction = "submit" | "withdraw" | "reject";

export type MembershipApplicationErrorCode =
  | "MEMBERSHIP_APPLICATION_INVALID_INPUT"
  | "MEMBERSHIP_APPLICATION_NOT_FOUND"
  | "MEMBERSHIP_APPLICATION_ADMIN_REQUIRED"
  | "MEMBERSHIP_APPLICATION_ACCOUNT_DISABLED"
  | "MEMBERSHIP_APPLICATION_ACTIVE_MEMBERSHIP"
  | "MEMBERSHIP_APPLICATION_PENDING"
  | "MEMBERSHIP_APPLICATION_CONFLICT"
  | "MEMBERSHIP_APPLICATION_PREVIEW_STALE"
  | "MEMBERSHIP_APPLICATION_PREVIEW_EXPIRED"
  | "MEMBERSHIP_APPLICATION_CONFIRMATION_REQUIRED"
  | "MEMBERSHIP_APPLICATION_REASON_REQUIRED"
  | "MEMBERSHIP_APPLICATION_UNSAFE_TEXT"
  | "MEMBERSHIP_APPLICATION_IDEMPOTENCY_CONFLICT"
  | "MEMBERSHIP_APPLICATION_METHOD_NOT_ALLOWED";

export class MembershipApplicationServiceError extends Error {
  constructor(readonly code: MembershipApplicationErrorCode) {
    super(code);
    this.name = "MembershipApplicationServiceError";
  }
}

type ApplicationDb = PrismaClient | Prisma.TransactionClient;
const UUID = z.string().uuid();
const KEY = z.string().trim().min(8).max(180);
const FINGERPRINT = z.string().regex(/^[0-9a-f]{64}$/u);
const TTL_MS = 5 * 60 * 1_000;
const CLOCK_SKEW_MS = 5 * 1_000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const UNSAFE = /[A-Za-z0-9_-]{40,128}/u;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/u;

function fail(code: MembershipApplicationErrorCode): never {
  throw new MembershipApplicationServiceError(code);
}

function isApplicationTransactionConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || error.code === "P2028")) return true;
  const message = error instanceof Error ? error.message : "";
  return /P2034|P2028|40001|serialization failure|could not serialize|write conflict|transaction (?:already )?closed|expired transaction/iu.test(message);
}

function asUuid(value: unknown): string {
  const parsed = UUID.safeParse(value);
  if (!parsed.success) return fail("MEMBERSHIP_APPLICATION_INVALID_INPUT");
  return parsed.data.toLowerCase();
}

function asKey(value: unknown): string {
  const parsed = KEY.safeParse(value);
  if (!parsed.success || CONTROL.test(parsed.data) || UNSAFE.test(parsed.data) || EMAIL.test(parsed.data)) return fail("MEMBERSHIP_APPLICATION_INVALID_INPUT");
  return parsed.data;
}

function asFingerprint(value: unknown): string {
  const parsed = FINGERPRINT.safeParse(value);
  if (!parsed.success) return fail("MEMBERSHIP_APPLICATION_INVALID_INPUT");
  return parsed.data;
}

function safeReason(value: unknown, required = false): string | null {
  if (value === null || value === undefined || value === "") {
    if (required) return fail("MEMBERSHIP_APPLICATION_REASON_REQUIRED");
    return null;
  }
  if (typeof value !== "string") return fail("MEMBERSHIP_APPLICATION_INVALID_INPUT");
  const result = value.trim();
  if (result.length === 0) {
    if (required) return fail("MEMBERSHIP_APPLICATION_REASON_REQUIRED");
    return null;
  }
  if (result.length > 500 || CONTROL.test(result) || UNSAFE.test(result) || EMAIL.test(result) || /^[0-9a-f]{64}$/iu.test(result)) return fail("MEMBERSHIP_APPLICATION_UNSAFE_TEXT");
  return result;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

async function now(db: ApplicationDb): Promise<Date> {
  const queryRaw = (db as unknown as { $queryRaw?: (query: Prisma.Sql) => Promise<unknown> }).$queryRaw;
  if (typeof queryRaw !== "function") return new Date();
  const rows = await queryRaw.call(db, Prisma.sql`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`) as Array<{ now?: Date }>;
  const value = rows[0]?.now;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return fail("MEMBERSHIP_APPLICATION_CONFLICT");
  return value;
}

function stateOf(subscription: { status: "active" | "revoked"; startsAt: Date; expiresAt: Date } | null, current: Date): "none" | "active" | "expired" | "revoked" {
  if (subscription === null) return "none";
  if (subscription.status === "revoked") return "revoked";
  return subscription.startsAt <= current && subscription.expiresAt > current ? "active" : "expired";
}

function assertPreviewWindow(issuedAt: Date, expiresAt: Date, current: Date): void {
  if (issuedAt.getTime() > current.getTime() + CLOCK_SKEW_MS || expiresAt.getTime() <= current.getTime() || expiresAt.getTime() <= issuedAt.getTime() || expiresAt.getTime() - issuedAt.getTime() > TTL_MS) return fail("MEMBERSHIP_APPLICATION_PREVIEW_EXPIRED");
}

const applicationSelect = {
  id: true,
  userId: true,
  status: true,
  statusVersion: true,
  requestKey: true,
  requestReason: true,
  rejectionReason: true,
  accountAccessVersion: true,
  membershipVersion: true,
  membershipState: true,
  submittedAt: true,
  fulfilledAt: true,
  rejectedAt: true,
  withdrawnAt: true,
  fulfilledSubscriptionId: true,
  fulfilledSubscriptionVersion: true,
  fulfilledSubscriptionAuditId: true,
  fulfilledMembershipPreviewId: true,
  submitPreviewId: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type PublicMembershipApplication = Prisma.MembershipApplicationGetPayload<{ select: typeof applicationSelect }>;

const previewSelect = {
  id: true,
  actorId: true,
  userId: true,
  applicationId: true,
  action: true,
  expectedApplicationVersion: true,
  expectedAccountAccessVersion: true,
  expectedMembershipVersion: true,
  expectedMembershipState: true,
  requestKey: true,
  requestFingerprint: true,
  impactFingerprint: true,
  reason: true,
  issuedAt: true,
  expiresAt: true,
  consumedAt: true,
} as const;

export type MembershipApplicationPreview = Readonly<{
  application: PublicMembershipApplication | null;
  preview: Prisma.MembershipApplicationPreviewGetPayload<{ select: typeof previewSelect }>;
}>;

type UserSnapshot = Readonly<{
  id: string;
  username: string;
  disabledAt: Date | null;
  accountAccessVersion: number;
  membership: { id: string; status: "active" | "revoked"; startsAt: Date; expiresAt: Date; version: number } | null;
}>;

async function loadUser(db: ApplicationDb, userId: string): Promise<UserSnapshot | null> {
  const row = await db.appUser.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      disabledAt: true,
      accountAccessVersion: true,
      membershipSubscription: { select: { id: true, status: true, startsAt: true, expiresAt: true, version: true } },
    },
  });
  if (row === null) return null;
  // Prisma exposes this relation as `membershipSubscription`; the service
  // snapshot deliberately uses the shorter domain name consumed by the
  // state/fingerprint helpers.  Keep the mapping explicit so a relation
  // rename or an omitted select cannot silently turn an active subscription
  // into an undefined value at runtime.
  return {
    id: row.id,
    username: row.username,
    disabledAt: row.disabledAt,
    accountAccessVersion: row.accountAccessVersion,
    membership: row.membershipSubscription,
  };
}

async function assertAdmin(db: ApplicationDb, actorId: string): Promise<UserSnapshot> {
  const actor = await loadUser(db, actorId);
  if (actor === null || actor.disabledAt !== null) return fail("MEMBERSHIP_APPLICATION_ADMIN_REQUIRED");
  const role = await db.appUser.findUnique({ where: { id: actorId }, select: { role: true } });
  if (role?.role !== "admin") return fail("MEMBERSHIP_APPLICATION_ADMIN_REQUIRED");
  return actor;
}

function impactFingerprint(input: Readonly<{ applicationId: string | null; user: UserSnapshot; application: PublicMembershipApplication | null; state: string }>): string {
  return hash({
    applicationId: input.applicationId,
    userId: input.user.id,
    accountAccessVersion: input.user.accountAccessVersion,
    membership: input.user.membership === null ? null : {
      id: input.user.membership.id,
      status: input.user.membership.status,
      startsAt: input.user.membership.startsAt.toISOString(),
      expiresAt: input.user.membership.expiresAt.toISOString(),
      version: input.user.membership.version,
    },
    application: input.application === null ? null : {
      id: input.application.id,
      status: input.application.status,
      statusVersion: input.application.statusVersion,
      requestKey: input.application.requestKey,
    },
    state: input.state,
  });
}

function requestFingerprint(input: Readonly<{ action: MembershipApplicationAction; userId: string; applicationId: string | null; requestKey: string; reason: string | null; expectedApplicationVersion: number; expectedAccountAccessVersion: number; expectedMembershipVersion: number; expectedMembershipState: string; impactFingerprint: string; issuedAt: Date; expiresAt: Date }>): string {
  return hash({ ...input, issuedAt: input.issuedAt.toISOString(), expiresAt: input.expiresAt.toISOString() });
}

async function setPreviewContext(tx: Prisma.TransactionClient, input: Readonly<{ previewId: string; actorId: string; userId: string }>): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_application_preview_context', '1', true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_application_preview_id', ${input.previewId}, true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_application_preview_actor_id', ${input.actorId}, true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_application_preview_user_id', ${input.userId}, true)`);
}

async function setApplicationContext(tx: Prisma.TransactionClient, input: Readonly<{ applicationId: string; actorId: string; userId: string; previewId?: string; expectedVersion?: number; execute?: boolean; transition?: boolean }>): Promise<void> {
  if (input.execute) await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_application_execute_context', '1', true)`);
  if (input.transition) await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_application_transition_context', '1', true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_application_id', ${input.applicationId}, true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_application_actor_id', ${input.actorId}, true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_application_user_id', ${input.userId}, true)`);
  if (input.previewId !== undefined) await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_application_preview_id', ${input.previewId}, true)`);
  if (input.expectedVersion !== undefined) await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_application_expected_version', ${String(input.expectedVersion)}, true)`);
}

async function consumePreview(tx: Prisma.TransactionClient, previewId: string, current: Date): Promise<void> {
  const consumed = await tx.membershipApplicationPreview.updateMany({ where: { id: previewId, consumedAt: null }, data: { consumedAt: current } });
  if (consumed.count !== 1) return fail("MEMBERSHIP_APPLICATION_PREVIEW_STALE");
}

async function listOrCurrent(db: ApplicationDb, userId: string, currentOnly: boolean): Promise<PublicMembershipApplication | null | readonly PublicMembershipApplication[]> {
  const where: Prisma.MembershipApplicationWhereInput = { userId: asUuid(userId), ...(currentOnly ? { status: "pending" } : {}) };
  const rows = await db.membershipApplication.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: applicationSelect });
  const safeRows = rows.map((row) => Object.freeze(row));
  return currentOnly ? (safeRows[0] ?? null) : Object.freeze(safeRows);
}

export async function getCurrentMembershipApplication(userId: string, db: ApplicationDb = getDb()): Promise<PublicMembershipApplication | null> {
  // The profile must keep the latest terminal outcome visible so a user can
  // distinguish a withdrawn, rejected, or fulfilled request from never having
  // submitted one.  Pending uniqueness is enforced separately by the partial
  // database index and submit preview path.
  const rows = await listOrCurrent(db, userId, false) as readonly PublicMembershipApplication[];
  return rows[0] ?? null;
}

export async function listMembershipApplications(input: Readonly<{ adminUserId: string; status?: MembershipApplicationStatus; search?: string; page?: number; pageSize?: number }>, db: PrismaClient = getDb()): Promise<Readonly<{ items: readonly PublicMembershipApplication[]; page: number; pageSize: number; hasNextPage: boolean }>> {
  await assertAdmin(db, asUuid(input.adminUserId));
  const page = Number.isSafeInteger(input.page) && (input.page ?? 1) >= 1 ? input.page ?? 1 : 1;
  const pageSize = Number.isSafeInteger(input.pageSize) && (input.pageSize ?? 20) >= 1 ? Math.min(input.pageSize ?? 20, 100) : 20;
  const search = typeof input.search === "string" ? input.search.trim().slice(0, 160) : "";
  const rows = await db.membershipApplication.findMany({
    where: {
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(search.length === 0 ? {} : { user: { OR: [{ username: { contains: search, mode: "insensitive" } }, { displayName: { contains: search, mode: "insensitive" } }] } }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * pageSize,
    take: pageSize + 1,
    select: applicationSelect,
  });
  return Object.freeze({ items: Object.freeze(rows.slice(0, pageSize).map((row) => Object.freeze(row))), page, pageSize, hasNextPage: rows.length > pageSize });
}

export async function previewMembershipApplication(input: Readonly<{ actorId: string; userId?: string; requestKey: string; reason?: string | null }>, db: PrismaClient = getDb()): Promise<MembershipApplicationPreview> {
  const actorId = asUuid(input.actorId);
  const targetId = input.userId === undefined ? actorId : asUuid(input.userId);
  if (actorId !== targetId) return fail("MEMBERSHIP_APPLICATION_INVALID_INPUT");
  const key = asKey(input.requestKey);
  const reason = safeReason(input.reason, true);
  try {
    return await db.$transaction(async (tx) => {
      await lockActorsAccess(tx, [actorId]);
      const user = await loadUser(tx, targetId);
      if (user === null) return fail("MEMBERSHIP_APPLICATION_NOT_FOUND");
      if (user.disabledAt !== null) return fail("MEMBERSHIP_APPLICATION_ACCOUNT_DISABLED");
      const current = await now(tx);
      const state = stateOf(user.membership, current);
      if (state === "active") return fail("MEMBERSHIP_APPLICATION_ACTIVE_MEMBERSHIP");
      const existingPreview = await tx.membershipApplicationPreview.findUnique({ where: { actorId_requestKey: { actorId, requestKey: key } }, select: previewSelect });
      const existing = await tx.membershipApplication.findFirst({ where: { userId: targetId, status: "pending" }, select: applicationSelect });
      if (existing !== null) {
        if (existingPreview !== null
          && existingPreview.userId === targetId
          && existingPreview.applicationId === null
          && existingPreview.action === "submit"
          && existingPreview.reason === reason
          && existingPreview.consumedAt === null
          && existingPreview.expectedApplicationVersion === 0
          && existingPreview.expectedAccountAccessVersion === user.accountAccessVersion
          && existingPreview.expectedMembershipVersion === (user.membership?.version ?? 0)
          && existingPreview.expectedMembershipState === state
          && existingPreview.impactFingerprint === impactFingerprint({ applicationId: null, user, application: null, state })
          && existingPreview.requestFingerprint === requestFingerprint({ action: "submit", userId: targetId, applicationId: null, requestKey: key, reason, expectedApplicationVersion: 0, expectedAccountAccessVersion: user.accountAccessVersion, expectedMembershipVersion: user.membership?.version ?? 0, expectedMembershipState: state, impactFingerprint: existingPreview.impactFingerprint, issuedAt: existingPreview.issuedAt, expiresAt: existingPreview.expiresAt })) {
          assertPreviewWindow(existingPreview.issuedAt, existingPreview.expiresAt, current);
          return Object.freeze({ application: Object.freeze(existing), preview: existingPreview });
        }
        return fail("MEMBERSHIP_APPLICATION_PENDING");
      }
      if (existingPreview !== null) {
        if (existingPreview.userId !== targetId || existingPreview.applicationId !== null || existingPreview.action !== "submit" || existingPreview.reason !== reason) {
          return fail("MEMBERSHIP_APPLICATION_IDEMPOTENCY_CONFLICT");
        }
        if (existingPreview.consumedAt !== null) return fail("MEMBERSHIP_APPLICATION_PREVIEW_STALE");
        if (
          existingPreview.expectedApplicationVersion !== 0
          || existingPreview.expectedAccountAccessVersion !== user.accountAccessVersion
          || existingPreview.expectedMembershipVersion !== (user.membership?.version ?? 0)
          || existingPreview.expectedMembershipState !== state
        ) return fail("MEMBERSHIP_APPLICATION_PREVIEW_STALE");
        const impact = impactFingerprint({ applicationId: null, user, application: null, state });
        const replayRequest = requestFingerprint({ action: "submit", userId: targetId, applicationId: null, requestKey: key, reason, expectedApplicationVersion: 0, expectedAccountAccessVersion: user.accountAccessVersion, expectedMembershipVersion: user.membership?.version ?? 0, expectedMembershipState: state, impactFingerprint: impact, issuedAt: existingPreview.issuedAt, expiresAt: existingPreview.expiresAt });
        if (existingPreview.impactFingerprint !== impact || existingPreview.requestFingerprint !== replayRequest) return fail("MEMBERSHIP_APPLICATION_PREVIEW_STALE");
        assertPreviewWindow(existingPreview.issuedAt, existingPreview.expiresAt, current);
        return Object.freeze({ application: null, preview: existingPreview });
      }
      const issuedAt = new Date(current.getTime());
      const expiresAt = new Date(issuedAt.getTime() + TTL_MS);
      const impact = impactFingerprint({ applicationId: null, user, application: null, state });
      const request = requestFingerprint({ action: "submit", userId: targetId, applicationId: null, requestKey: key, reason, expectedApplicationVersion: 0, expectedAccountAccessVersion: user.accountAccessVersion, expectedMembershipVersion: user.membership?.version ?? 0, expectedMembershipState: state, impactFingerprint: impact, issuedAt, expiresAt });
      const previewId = randomUUID();
      await setPreviewContext(tx, { previewId, actorId, userId: targetId });
      const preview = await tx.membershipApplicationPreview.create({ data: { id: previewId, actorId, userId: targetId, action: "submit", expectedApplicationVersion: 0, expectedAccountAccessVersion: user.accountAccessVersion, expectedMembershipVersion: user.membership?.version ?? 0, expectedMembershipState: state, requestKey: key, requestFingerprint: request, impactFingerprint: impact, reason, issuedAt, expiresAt }, select: previewSelect });
      return Object.freeze({ application: null, preview });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 65_000 });
  } catch (error) {
    if (error instanceof MembershipApplicationServiceError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return fail("MEMBERSHIP_APPLICATION_IDEMPOTENCY_CONFLICT");
    if (isApplicationTransactionConflict(error)) return fail("MEMBERSHIP_APPLICATION_CONFLICT");
    throw error;
  }
}

export async function executeMembershipApplication(input: Readonly<{ actorId: string; requestKey: string; requestFingerprint: string; impactFingerprint: string; previewId: string; previewIssuedAt: string | Date; previewExpiresAt: string | Date; confirmation: true; confirmationUsername?: string }>, db: PrismaClient = getDb()): Promise<PublicMembershipApplication> {
  const actorId = asUuid(input.actorId);
  const key = asKey(input.requestKey);
  const suppliedRequest = asFingerprint(input.requestFingerprint);
  const suppliedImpact = asFingerprint(input.impactFingerprint);
  const previewId = asUuid(input.previewId);
  if (input.confirmation !== true) return fail("MEMBERSHIP_APPLICATION_CONFIRMATION_REQUIRED");
  const issuedAt = input.previewIssuedAt instanceof Date ? input.previewIssuedAt : new Date(input.previewIssuedAt);
  const expiresAt = input.previewExpiresAt instanceof Date ? input.previewExpiresAt : new Date(input.previewExpiresAt);
  if (Number.isNaN(issuedAt.getTime()) || Number.isNaN(expiresAt.getTime())) return fail("MEMBERSHIP_APPLICATION_INVALID_INPUT");
  try {
    return await db.$transaction(async (tx) => {
      await lockActorsAccess(tx, [actorId]);
      const user = await loadUser(tx, actorId);
      if (user === null) return fail("MEMBERSHIP_APPLICATION_NOT_FOUND");
      if (user.disabledAt !== null) return fail("MEMBERSHIP_APPLICATION_ACCOUNT_DISABLED");
      if (input.confirmationUsername !== undefined && input.confirmationUsername !== user.username) return fail("MEMBERSHIP_APPLICATION_CONFIRMATION_REQUIRED");
      const current = await now(tx);
      const existingAudit = await tx.membershipApplicationAudit.findUnique({ where: { actorId_requestKey: { actorId, requestKey: key } } });
      if (existingAudit !== null) {
        if (existingAudit.event !== "submitted" || existingAudit.applicationPreviewId !== previewId || existingAudit.requestFingerprint !== suppliedRequest || existingAudit.impactFingerprint !== suppliedImpact) return fail("MEMBERSHIP_APPLICATION_IDEMPOTENCY_CONFLICT");
        const existing = await tx.membershipApplication.findUnique({ where: { id: existingAudit.applicationId }, select: applicationSelect });
        if (existing === null) return fail("MEMBERSHIP_APPLICATION_CONFLICT");
        return Object.freeze(existing);
      }
      assertPreviewWindow(issuedAt, expiresAt, current);
      const preview = await tx.membershipApplicationPreview.findUnique({ where: { id: previewId }, select: previewSelect });
      if (preview === null || preview.actorId !== actorId || preview.userId !== actorId || preview.action !== "submit" || preview.consumedAt !== null) return fail("MEMBERSHIP_APPLICATION_PREVIEW_STALE");
      if (preview.issuedAt.getTime() !== issuedAt.getTime() || preview.expiresAt.getTime() !== expiresAt.getTime() || preview.requestKey !== key || preview.requestFingerprint !== suppliedRequest || preview.impactFingerprint !== suppliedImpact) return fail("MEMBERSHIP_APPLICATION_PREVIEW_STALE");
      const state = stateOf(user.membership, current);
      if (state === "active") return fail("MEMBERSHIP_APPLICATION_ACTIVE_MEMBERSHIP");
      if (preview.expectedAccountAccessVersion !== user.accountAccessVersion || preview.expectedMembershipVersion !== (user.membership?.version ?? 0) || preview.expectedMembershipState !== state) return fail("MEMBERSHIP_APPLICATION_PREVIEW_STALE");
      const previewReason = safeReason(preview.reason, true)!;
      const calculated = requestFingerprint({ action: "submit", userId: actorId, applicationId: null, requestKey: key, reason: previewReason, expectedApplicationVersion: 0, expectedAccountAccessVersion: user.accountAccessVersion, expectedMembershipVersion: user.membership?.version ?? 0, expectedMembershipState: state, impactFingerprint: suppliedImpact, issuedAt, expiresAt });
      if (calculated !== suppliedRequest) return fail("MEMBERSHIP_APPLICATION_IDEMPOTENCY_CONFLICT");
      const applicationId = randomUUID();
      await setApplicationContext(tx, { applicationId, actorId, userId: actorId, previewId, expectedVersion: 0, execute: true });
      const application = await tx.membershipApplication.create({ data: { id: applicationId, userId: actorId, status: "pending", statusVersion: 1, requestKey: key, requestFingerprint: suppliedRequest, impactFingerprint: suppliedImpact, requestReason: previewReason, accountAccessVersion: user.accountAccessVersion, membershipVersion: user.membership?.version ?? 0, membershipState: state, submittedAt: current, submitPreviewId: previewId, createdAt: current, updatedAt: current }, select: applicationSelect });
      await tx.membershipApplicationAudit.create({ data: { id: randomUUID(), applicationId, userId: actorId, actorId, event: "submitted", statusBefore: null, statusAfter: "pending", statusVersionBefore: null, statusVersionAfter: 1, applicationPreviewId: previewId, membershipPreviewId: null, subscriptionId: null, subscriptionVersion: null, subscriptionAuditId: null, reason: previewReason, requestKey: key, requestFingerprint: suppliedRequest, impactFingerprint: suppliedImpact, transitionAt: current, createdAt: current } });
      await consumePreview(tx, previewId, current);
      return Object.freeze(application);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 65_000 });
  } catch (error) {
    if (error instanceof MembershipApplicationServiceError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return fail("MEMBERSHIP_APPLICATION_PENDING");
    if (isApplicationTransactionConflict(error)) return fail("MEMBERSHIP_APPLICATION_CONFLICT");
    throw error;
  }
}

async function previewTerminalAction(input: Readonly<{ actorId: string; applicationId: string; action: "withdraw" | "reject"; requestKey: string; reason?: string | null }>, db: PrismaClient): Promise<MembershipApplicationPreview> {
  const actorId = asUuid(input.actorId);
  const applicationId = asUuid(input.applicationId);
  const key = asKey(input.requestKey);
  const reason = safeReason(input.reason, input.action === "reject");
  try {
    return await db.$transaction(async (tx) => {
      const application = await tx.membershipApplication.findUnique({ where: { id: applicationId }, select: applicationSelect });
      if (application === null) return fail("MEMBERSHIP_APPLICATION_NOT_FOUND");
      await lockActorsAccess(tx, [actorId, application.userId]);
      const actor = input.action === "reject" ? await assertAdmin(tx, actorId) : await loadUser(tx, actorId);
      if (actor === null || actor.disabledAt !== null) return fail("MEMBERSHIP_APPLICATION_ACCOUNT_DISABLED");
      if (input.action === "withdraw" && actorId !== application.userId) return fail("MEMBERSHIP_APPLICATION_INVALID_INPUT");
      if (application.status !== "pending") return fail("MEMBERSHIP_APPLICATION_CONFLICT");
      const current = await now(tx);
      const user = await loadUser(tx, application.userId);
      if (user === null) return fail("MEMBERSHIP_APPLICATION_NOT_FOUND");
      const state = stateOf(user.membership, current);
      const impact = impactFingerprint({ applicationId, user, application, state });
      const issuedAt = new Date(current.getTime());
      const expiresAt = new Date(issuedAt.getTime() + TTL_MS);
      const existingPreview = await tx.membershipApplicationPreview.findUnique({ where: { actorId_requestKey: { actorId, requestKey: key } }, select: previewSelect });
      if (existingPreview !== null) {
        const replayRequest = requestFingerprint({ action: input.action, userId: application.userId, applicationId, requestKey: key, reason, expectedApplicationVersion: application.statusVersion, expectedAccountAccessVersion: user.accountAccessVersion, expectedMembershipVersion: user.membership?.version ?? 0, expectedMembershipState: state, impactFingerprint: impact, issuedAt: existingPreview.issuedAt, expiresAt: existingPreview.expiresAt });
        if (existingPreview.applicationId === applicationId && existingPreview.action === input.action && existingPreview.reason === reason && existingPreview.expectedApplicationVersion === application.statusVersion && existingPreview.expectedAccountAccessVersion === user.accountAccessVersion && existingPreview.expectedMembershipVersion === (user.membership?.version ?? 0) && existingPreview.expectedMembershipState === state && existingPreview.impactFingerprint === impact && existingPreview.requestFingerprint === replayRequest) {
          return Object.freeze({ application: Object.freeze(application), preview: existingPreview });
        }
        return fail("MEMBERSHIP_APPLICATION_IDEMPOTENCY_CONFLICT");
      }
      const request = requestFingerprint({ action: input.action, userId: application.userId, applicationId, requestKey: key, reason, expectedApplicationVersion: application.statusVersion, expectedAccountAccessVersion: user.accountAccessVersion, expectedMembershipVersion: user.membership?.version ?? 0, expectedMembershipState: state, impactFingerprint: impact, issuedAt, expiresAt });
      const previewId = randomUUID();
      await setPreviewContext(tx, { previewId, actorId, userId: application.userId });
      const preview = await tx.membershipApplicationPreview.create({ data: { id: previewId, actorId, userId: application.userId, applicationId, action: input.action, expectedApplicationVersion: application.statusVersion, expectedAccountAccessVersion: user.accountAccessVersion, expectedMembershipVersion: user.membership?.version ?? 0, expectedMembershipState: state, requestKey: key, requestFingerprint: request, impactFingerprint: impact, reason, issuedAt, expiresAt }, select: previewSelect });
      return Object.freeze({ application: Object.freeze(application), preview });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 65_000 });
  } catch (error) {
    if (error instanceof MembershipApplicationServiceError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return fail("MEMBERSHIP_APPLICATION_IDEMPOTENCY_CONFLICT");
    if (isApplicationTransactionConflict(error)) return fail("MEMBERSHIP_APPLICATION_CONFLICT");
    throw error;
  }
}

export async function previewWithdrawMembershipApplication(input: Readonly<{ actorId: string; applicationId: string; requestKey: string; reason?: string | null }>, db: PrismaClient = getDb()): Promise<MembershipApplicationPreview> {
  return previewTerminalAction({ ...input, action: "withdraw" }, db);
}

export async function previewRejectMembershipApplication(input: Readonly<{ actorId: string; applicationId: string; requestKey: string; reason: string }>, db: PrismaClient = getDb()): Promise<MembershipApplicationPreview> {
  return previewTerminalAction({ ...input, action: "reject" }, db);
}

async function executeTerminalAction(input: Readonly<{ actorId: string; action: "withdraw" | "reject"; previewId: string; applicationId: string; requestKey: string; requestFingerprint: string; impactFingerprint: string; previewIssuedAt: string | Date; previewExpiresAt: string | Date; confirmation: true }>, db: PrismaClient): Promise<PublicMembershipApplication> {
  const actorId = asUuid(input.actorId);
  const applicationId = asUuid(input.applicationId);
  const previewId = asUuid(input.previewId);
  const key = asKey(input.requestKey);
  const suppliedRequest = asFingerprint(input.requestFingerprint);
  const suppliedImpact = asFingerprint(input.impactFingerprint);
  if (input.confirmation !== true) return fail("MEMBERSHIP_APPLICATION_CONFIRMATION_REQUIRED");
  const issuedAt = input.previewIssuedAt instanceof Date ? input.previewIssuedAt : new Date(input.previewIssuedAt);
  const expiresAt = input.previewExpiresAt instanceof Date ? input.previewExpiresAt : new Date(input.previewExpiresAt);
  if (Number.isNaN(issuedAt.getTime()) || Number.isNaN(expiresAt.getTime())) return fail("MEMBERSHIP_APPLICATION_INVALID_INPUT");
  try {
    return await db.$transaction(async (tx) => {
    const preview = await tx.membershipApplicationPreview.findUnique({ where: { id: previewId }, select: previewSelect });
    if (preview === null || preview.actorId !== actorId || preview.applicationId !== applicationId || preview.action !== input.action || preview.requestKey !== key || preview.requestFingerprint !== suppliedRequest || preview.impactFingerprint !== suppliedImpact) return fail("MEMBERSHIP_APPLICATION_PREVIEW_STALE");
    const application = await tx.membershipApplication.findUnique({ where: { id: applicationId }, select: applicationSelect });
    if (application === null) return fail("MEMBERSHIP_APPLICATION_NOT_FOUND");
    await lockActorsAccess(tx, [actorId, application.userId]);
    const actor = input.action === "reject" ? await assertAdmin(tx, actorId) : await loadUser(tx, actorId);
    if (actor === null || actor.disabledAt !== null) return fail("MEMBERSHIP_APPLICATION_ACCOUNT_DISABLED");
    if (input.action === "withdraw" && actorId !== application.userId) return fail("MEMBERSHIP_APPLICATION_INVALID_INPUT");
    const expectedEvent = input.action === "withdraw" ? "withdrawn" : "rejected";
    const existingAudit = await tx.membershipApplicationAudit.findUnique({ where: { actorId_requestKey: { actorId, requestKey: key } } });
    if (existingAudit !== null) {
      if (existingAudit.applicationId !== applicationId || existingAudit.applicationPreviewId !== previewId || existingAudit.event !== expectedEvent || existingAudit.requestFingerprint !== suppliedRequest || existingAudit.impactFingerprint !== suppliedImpact) return fail("MEMBERSHIP_APPLICATION_IDEMPOTENCY_CONFLICT");
      return Object.freeze(application);
    }
    if (preview.consumedAt !== null) return fail("MEMBERSHIP_APPLICATION_PREVIEW_STALE");
    const current = await now(tx);
    assertPreviewWindow(issuedAt, expiresAt, current);
    if (preview.issuedAt.getTime() !== issuedAt.getTime() || preview.expiresAt.getTime() !== expiresAt.getTime()) return fail("MEMBERSHIP_APPLICATION_PREVIEW_STALE");
    const user = await loadUser(tx, application.userId);
    if (user === null) return fail("MEMBERSHIP_APPLICATION_NOT_FOUND");
    const state = stateOf(user.membership, current);
    if (application.status !== "pending" || application.statusVersion !== preview.expectedApplicationVersion || user.accountAccessVersion !== preview.expectedAccountAccessVersion || (user.membership?.version ?? 0) !== preview.expectedMembershipVersion || state !== preview.expectedMembershipState) return fail("MEMBERSHIP_APPLICATION_PREVIEW_STALE");
    const calculated = requestFingerprint({ action: preview.action, userId: application.userId, applicationId, requestKey: key, reason: preview.reason, expectedApplicationVersion: application.statusVersion, expectedAccountAccessVersion: user.accountAccessVersion, expectedMembershipVersion: user.membership?.version ?? 0, expectedMembershipState: state, impactFingerprint: suppliedImpact, issuedAt, expiresAt });
    if (calculated !== suppliedRequest) return fail("MEMBERSHIP_APPLICATION_IDEMPOTENCY_CONFLICT");
    const status = preview.action === "withdraw" ? ("withdrawn" as const) : ("rejected" as const);
    const event = preview.action === "withdraw" ? ("withdrawn" as const) : ("rejected" as const);
    const terminalData = preview.action === "withdraw" ? { status, withdrawnAt: current, rejectionReason: null } : { status, rejectedAt: current, rejectionReason: preview.reason };
    await setApplicationContext(tx, { applicationId, actorId, userId: application.userId, previewId, expectedVersion: application.statusVersion, execute: true, transition: true });
    const updated = await tx.membershipApplication.update({ where: { id: applicationId }, data: { ...terminalData, statusVersion: { increment: 1 }, updatedAt: current }, select: applicationSelect });
    await tx.membershipApplicationAudit.create({ data: { id: randomUUID(), applicationId, userId: application.userId, actorId, event, statusBefore: "pending", statusAfter: status as MembershipApplicationStatus, statusVersionBefore: application.statusVersion, statusVersionAfter: updated.statusVersion, applicationPreviewId: previewId, membershipPreviewId: null, subscriptionId: null, subscriptionVersion: null, subscriptionAuditId: null, reason: preview.reason, requestKey: key, requestFingerprint: suppliedRequest, impactFingerprint: suppliedImpact, transitionAt: current, createdAt: current } });
    await consumePreview(tx, previewId, current);
    return Object.freeze(updated);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 65_000 });
  } catch (error) {
    if (error instanceof MembershipApplicationServiceError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034" || error.code === "P2028")) return fail(error.code === "P2002" ? "MEMBERSHIP_APPLICATION_IDEMPOTENCY_CONFLICT" : "MEMBERSHIP_APPLICATION_CONFLICT");
    throw error;
  }
}

export async function executeWithdrawMembershipApplication(input: Readonly<{ actorId: string; applicationId: string; requestKey: string; requestFingerprint: string; impactFingerprint: string; previewId: string; previewIssuedAt: string | Date; previewExpiresAt: string | Date; confirmation: true }>, db: PrismaClient = getDb()): Promise<PublicMembershipApplication> {
  return executeTerminalAction({ ...input, action: "withdraw", applicationId: input.applicationId }, db);
}

export async function executeRejectMembershipApplication(input: Readonly<{ actorId: string; applicationId: string; requestKey: string; requestFingerprint: string; impactFingerprint: string; previewId: string; previewIssuedAt: string | Date; previewExpiresAt: string | Date; confirmation: true }>, db: PrismaClient = getDb()): Promise<PublicMembershipApplication> {
  return executeTerminalAction({ ...input, action: "reject", applicationId: input.applicationId }, db);
}

/**
 * Called only from the existing membership grant execute transaction.  It is
 * intentionally not exported as an HTTP-facing operation: fulfillment must
 * share the subscription audit transaction and exact membership preview.
 */
export async function fulfillMembershipApplicationInTransaction(tx: Prisma.TransactionClient, input: Readonly<{ applicationId: string; actorId: string; userId: string; membershipPreviewId: string; subscriptionId: string; subscriptionVersion: number; subscriptionAuditId: string; requestKey: string; requestFingerprint: string; impactFingerprint: string; now: Date }>): Promise<PublicMembershipApplication> {
  const applicationId = asUuid(input.applicationId);
  const actorId = asUuid(input.actorId);
  const userId = asUuid(input.userId);
  const application = await tx.membershipApplication.findUnique({ where: { id: applicationId }, select: applicationSelect });
  if (application === null || application.userId !== userId || application.status !== "pending") return fail("MEMBERSHIP_APPLICATION_PREVIEW_STALE");
  await setApplicationContext(tx, { applicationId, actorId, userId, expectedVersion: application.statusVersion, transition: true });
  const updated = await tx.membershipApplication.update({ where: { id: applicationId }, data: { status: "fulfilled", statusVersion: { increment: 1 }, fulfilledAt: input.now, fulfilledSubscriptionId: input.subscriptionId, fulfilledSubscriptionVersion: input.subscriptionVersion, fulfilledSubscriptionAuditId: input.subscriptionAuditId, fulfilledMembershipPreviewId: input.membershipPreviewId, updatedAt: input.now }, select: applicationSelect });
  await tx.membershipApplicationAudit.create({ data: { id: randomUUID(), applicationId, userId, actorId, event: "fulfilled", statusBefore: "pending", statusAfter: "fulfilled", statusVersionBefore: application.statusVersion, statusVersionAfter: updated.statusVersion, applicationPreviewId: null, membershipPreviewId: input.membershipPreviewId, subscriptionId: input.subscriptionId, subscriptionVersion: input.subscriptionVersion, subscriptionAuditId: input.subscriptionAuditId, reason: "membership_application_fulfilled", requestKey: input.requestKey, requestFingerprint: input.requestFingerprint, impactFingerprint: input.impactFingerprint, transitionAt: input.now, createdAt: input.now } });
  return Object.freeze(updated);
}

export function membershipApplicationAuditPublic(row: MembershipApplicationAudit): Readonly<{ id: string; applicationId: string; event: string; statusAfter: string; statusVersionAfter: number; reason: string | null; transitionAt: Date }> {
  return Object.freeze({ id: row.id, applicationId: row.applicationId, event: row.event, statusAfter: row.statusAfter, statusVersionAfter: row.statusVersionAfter, reason: row.reason, transitionAt: row.transitionAt });
}
