import { createHash, randomUUID } from "node:crypto";
import { Prisma, type MembershipSubscription, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { lockActorsAccess } from "@/lib/access-linearization";
import { getDb } from "@/lib/db";
import { fulfillMembershipApplicationInTransaction } from "@/lib/membership-application-service";
import { toSystemRole } from "@/lib/system-role";

export type MembershipLifecycleAction = "grant" | "extend" | "revoke";
export type MembershipState = "none" | "active" | "expired" | "revoked";

export type MembershipServiceErrorCode =
  | "MEMBERSHIP_INVALID_INPUT"
  | "MEMBERSHIP_USER_NOT_FOUND"
  | "MEMBERSHIP_NOT_FOUND"
  | "MEMBERSHIP_CONFLICT"
  | "MEMBERSHIP_ADMIN_REQUIRED"
  | "MEMBERSHIP_ACTION_CONFLICT"
  | "MEMBERSHIP_PREVIEW_STALE"
  | "MEMBERSHIP_PREVIEW_EXPIRED"
  | "MEMBERSHIP_DEPENDENCY_RESOLUTION_REQUIRED"
  | "MEMBERSHIP_REASON_REQUIRED"
  | "MEMBERSHIP_UNSAFE_AUDIT_TEXT"
  | "MEMBERSHIP_IDEMPOTENCY_CONFLICT"
  | "MEMBERSHIP_CONFIRMATION_REQUIRED"
  | "MEMBERSHIP_METHOD_NOT_ALLOWED";

export class MembershipServiceError extends Error {
  constructor(readonly code: MembershipServiceErrorCode) {
    super(code);
    this.name = "MembershipServiceError";
  }
}

type MembershipDb = PrismaClient | Prisma.TransactionClient;

const userIdSchema = z.string().uuid();
const daysSchema = z.number().int().min(1).max(3650);
const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const requestKeySchema = z.string().trim().min(8).max(180);
const MEMBERSHIP_PREVIEW_TTL_MS = 5 * 60 * 1_000;
const MEMBERSHIP_PREVIEW_CLOCK_SKEW_MS = 5 * 1_000;
/**
 * Membership mutations may wait for the bounded provider probe while holding
 * the same actor advisory lock. Keep a finite margin for that wait rather
 * than relying on Prisma's 5s interactive-transaction default.
 */
const MEMBERSHIP_MUTATION_TRANSACTION_TIMEOUT_MS = 65_000;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const UNSAFE_AUDIT_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f]|[A-Za-z0-9_-]{40,128}/u;
const EMAIL_SHAPED_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/u;

function fail(code: MembershipServiceErrorCode): never {
  throw new MembershipServiceError(code);
}

function isPrismaCode(error: unknown, code: string): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return error.code === code;
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function isMembershipTransactionConflict(error: unknown): boolean {
  const databaseMessage = error instanceof Error ? error.message : "";
  return isPrismaCode(error, "P2034")
    || isPrismaCode(error, "P2028")
    || /P2034|P2028|40001|serialization failure|could not serialize|write conflict|transaction (?:already )?closed|expired transaction/iu.test(databaseMessage);
}

function hashFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function safeAuditText(value: string | null | undefined, required = false): string | null {
  if (value === null || value === undefined || value === "") {
    if (required) return fail("MEMBERSHIP_INVALID_INPUT");
    return null;
  }
  if (typeof value !== "string") return fail("MEMBERSHIP_INVALID_INPUT");
  const normalized = value.trim();
  if (normalized.length === 0 && required) return fail("MEMBERSHIP_INVALID_INPUT");
  if (normalized.length > 500 || CONTROL_PATTERN.test(normalized) || UNSAFE_AUDIT_TEXT_PATTERN.test(normalized) || EMAIL_SHAPED_PATTERN.test(normalized) || /^[0-9a-f]{64}$/iu.test(normalized)) {
    return fail("MEMBERSHIP_UNSAFE_AUDIT_TEXT");
  }
  return normalized;
}

function requiredReason(value: string | null | undefined): string {
  if (typeof value !== "string" || value.trim().length === 0) return fail("MEMBERSHIP_REASON_REQUIRED");
  return safeAuditText(value)!;
}

function requestKey(value: unknown): string {
  const parsed = requestKeySchema.safeParse(value);
  if (!parsed.success) return fail("MEMBERSHIP_INVALID_INPUT");
  return safeAuditText(parsed.data, true)!;
}

function fingerprint(value: unknown): string {
  const parsed = fingerprintSchema.safeParse(value);
  if (!parsed.success) return fail("MEMBERSHIP_INVALID_INPUT");
  return parsed.data;
}

function userId(value: unknown): string {
  const parsed = userIdSchema.safeParse(value);
  if (!parsed.success) return fail("MEMBERSHIP_INVALID_INPUT");
  return parsed.data.toLowerCase();
}

function days(value: unknown): number {
  if (!Number.isSafeInteger(value) || !daysSchema.safeParse(value).success) return fail("MEMBERSHIP_INVALID_INPUT");
  return value as number;
}

function expectedVersion(value: unknown, required = true): number | undefined {
  if (value === undefined || value === null) {
    if (required) return fail("MEMBERSHIP_INVALID_INPUT");
    return undefined;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) return fail("MEMBERSHIP_INVALID_INPUT");
  return value as number;
}

async function assertAdmin(adminUserId: string, db: PrismaClient): Promise<void> {
  const admin = await db.appUser.findUnique({ where: { id: adminUserId }, select: { role: true, disabledAt: true } });
  if (admin === null || admin.disabledAt !== null || admin.role !== "admin") return fail("MEMBERSHIP_ADMIN_REQUIRED");
}

const publicSubscription = {
  id: true,
  userId: true,
  status: true,
  startsAt: true,
  expiresAt: true,
  revokedAt: true,
  revocationReason: true,
  note: true,
  version: true,
  grantedById: true,
  revokedById: true,
  createdAt: true,
  updatedAt: true,
} as const;

type PublicSubscription = Prisma.MembershipSubscriptionGetPayload<{ select: typeof publicSubscription }>;

export async function listMemberships(input: Readonly<{
  adminUserId: string;
  search?: string;
  page?: number;
  pageSize?: number;
}>, db: PrismaClient = getDb()) {
  await assertAdmin(input.adminUserId, db);
  const page = Number.isSafeInteger(input.page) && (input.page ?? 1) >= 1 ? input.page ?? 1 : 1;
  const pageSize = Number.isSafeInteger(input.pageSize) && (input.pageSize ?? 20) >= 1 ? Math.min(input.pageSize ?? 20, 100) : 20;
  const search = input.search?.trim().slice(0, 160) ?? "";
  const where: Prisma.AppUserWhereInput = search.length === 0 ? {} : {
    OR: [
      { username: { contains: search, mode: "insensitive" } },
      { displayName: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
    ],
  };
  const users = await db.appUser.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    skip: (page - 1) * pageSize,
    take: pageSize + 1,
    select: {
      id: true,
      username: true,
      displayName: true,
      email: true,
      role: true,
      disabledAt: true,
      membershipSubscription: { select: publicSubscription },
    },
  });
  const hasNextPage = users.length > pageSize;
  const pageUsers = users.slice(0, pageSize);
  const applicationDelegate = (db as unknown as { membershipApplication?: { findMany?: (input: unknown) => Promise<Array<{ userId: string; id: string; status: string; statusVersion: number; requestReason: string | null; rejectionReason: string | null; submittedAt: Date; fulfilledAt: Date | null; rejectedAt: Date | null; withdrawnAt: Date | null }>> } }).membershipApplication;
  const applications = typeof applicationDelegate?.findMany === "function"
    ? await applicationDelegate.findMany({ where: { userId: { in: pageUsers.map((user) => user.id) } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { userId: true, id: true, status: true, statusVersion: true, requestReason: true, rejectionReason: true, submittedAt: true, fulfilledAt: true, rejectedAt: true, withdrawnAt: true } })
    : [];
  const applicationByUser = new Map<string, (typeof applications)[number]>();
  for (const application of applications) if (!applicationByUser.has(application.userId)) applicationByUser.set(application.userId, application);
  const items = pageUsers.map((user) => ({ ...user, membershipApplication: applicationByUser.get(user.id) ?? null, role: toSystemRole(user.role) }));
  return Object.freeze({ items, page, pageSize, hasNextPage });
}

type MembershipSnapshot = Readonly<{
  id: string;
  userId: string;
  status: MembershipSubscription["status"];
  startsAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revocationReason: string | null;
  note: string | null;
  version: number;
  grantedById: string | null;
  revokedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

type MembershipDependencyProject = Readonly<{
  projectId: string;
  projectName: string;
  nonTerminalPersonalDelegations: number;
  effectivePersonalRouteSelections: number;
  publishedPersonalIndexes: number;
}>;

type MembershipDependencyStats = Readonly<{
  nonTerminalPersonalDelegations: number;
  effectivePersonalRouteSelections: number;
  publishedPersonalIndexes: number;
  affectedProjects: readonly MembershipDependencyProject[];
  personalModelAutomationsAffected: 0;
  platformAutomationImpact: "unaffected";
  gitMcpImpact: "unaffected";
}>;

type MembershipTarget = Readonly<{
  id: string;
  username: string;
  disabledAt: Date | null;
  accountAccessVersion: number;
  membershipSubscription: MembershipSnapshot | null;
}>;

type MembershipPreviewInput = Readonly<{
  adminUserId: string;
  userId: string;
  action: MembershipLifecycleAction;
  days?: number;
  note?: string | null;
  reason?: string | null;
  expectedVersion?: number;
  applicationId?: string | null;
}>;

type MembershipExecuteInput = Readonly<MembershipPreviewInput & {
  expectedVersion: number;
  expectedImpactFingerprint: string;
  requestKey: string;
  requestFingerprint: string;
  previewId: string;
  previewIssuedAt: string | Date;
  previewExpiresAt: string | Date;
  confirmation: true;
  confirmationUsername?: string;
}>;

export type MembershipPreview = Readonly<{
  action: MembershipLifecycleAction;
  user: Readonly<{ id: string; username: string; disabledAt: Date | null }>;
  current: Readonly<{ state: MembershipState; version: number; startsAt: Date | null; expiresAt: Date | null; status: MembershipSubscription["status"] | null }>;
  target: Readonly<{ state: MembershipState; version: number; startsAt: Date; expiresAt: Date; status: MembershipSubscription["status"]; revokedAt: Date | null; revocationReason: string | null; note: string | null }>;
  dependencyStats: MembershipDependencyStats;
  blockingCategories: readonly string[];
  canExecute: boolean;
  impactFingerprint: string;
  requestFingerprint: string;
  previewId: string;
  issuedAt: Date;
  expiresAt: Date;
  previewIssuedAt: Date;
  previewExpiresAt: Date;
  applicationId: string | null;
}>;

function membershipState(subscription: MembershipSnapshot | null, now: Date): MembershipState {
  if (subscription === null) return "none";
  if (subscription.status === "revoked") return "revoked";
  return subscription.expiresAt > now && subscription.startsAt <= now ? "active" : "expired";
}

function assertLifecycleAction(action: MembershipLifecycleAction): MembershipLifecycleAction {
  if (action !== "grant" && action !== "extend" && action !== "revoke") return fail("MEMBERSHIP_INVALID_INPUT");
  return action;
}

function assertActionAllowed(action: MembershipLifecycleAction, state: MembershipState): void {
  if (action === "grant" && state !== "none" && state !== "expired" && state !== "revoked") return fail("MEMBERSHIP_ACTION_CONFLICT");
  if (action === "extend" && state !== "active") return fail("MEMBERSHIP_ACTION_CONFLICT");
  if (action === "revoke" && state !== "active") return fail("MEMBERSHIP_ACTION_CONFLICT");
}

function dateValue(value: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return fail("MEMBERSHIP_INVALID_INPUT");
}

function assertPreviewEvidence(input: Readonly<{ issuedAt: Date; expiresAt: Date; now: Date }>): void {
  const issuedAtMs = input.issuedAt.getTime();
  const expiresAtMs = input.expiresAt.getTime();
  const nowMs = input.now.getTime();
  if (
    issuedAtMs > nowMs + MEMBERSHIP_PREVIEW_CLOCK_SKEW_MS
    || expiresAtMs <= nowMs
    || expiresAtMs <= issuedAtMs
    || expiresAtMs - issuedAtMs > MEMBERSHIP_PREVIEW_TTL_MS
  ) return fail("MEMBERSHIP_PREVIEW_EXPIRED");
}

function buildRequestFingerprint(input: Readonly<{
  userId: string;
  action: MembershipLifecycleAction;
  days: number | null;
  note: string | null;
  reason: string | null;
  expectedVersion: number;
  applicationId?: string | null;
  impactFingerprint: string;
  previewIssuedAt: string | Date;
  previewExpiresAt: string | Date;
}>): string {
  return hashFingerprint({
    userId: input.userId,
    action: input.action,
    days: input.days,
    note: input.note,
    reason: input.reason,
    expectedVersion: input.expectedVersion,
    applicationId: input.applicationId ?? null,
    impactFingerprint: input.impactFingerprint,
    previewIssuedAt: dateValue(input.previewIssuedAt).toISOString(),
    previewExpiresAt: dateValue(input.previewExpiresAt).toISOString(),
  });
}

export function membershipRequestFingerprint(input: Readonly<{
  userId: string;
  action: MembershipLifecycleAction;
  days?: number | null;
  note?: string | null;
  reason?: string | null;
  expectedVersion: number;
  applicationId?: string | null;
  impactFingerprint: string;
  previewIssuedAt: string | Date;
  previewExpiresAt: string | Date;
}>): string {
  return buildRequestFingerprint({
    userId: userId(input.userId),
    action: assertLifecycleAction(input.action),
    days: input.days === undefined || input.days === null ? null : days(input.days),
    note: safeAuditText(input.note) ?? null,
    reason: safeAuditText(input.reason) ?? null,
    expectedVersion: expectedVersion(input.expectedVersion)!,
    applicationId: input.applicationId ?? null,
    impactFingerprint: fingerprint(input.impactFingerprint),
    previewIssuedAt: dateValue(input.previewIssuedAt),
    previewExpiresAt: dateValue(input.previewExpiresAt),
  });
}

async function databaseNow(db: MembershipDb): Promise<Date> {
  const queryRaw = (db as unknown as { $queryRaw?: (query: Prisma.Sql) => Promise<unknown> }).$queryRaw;
  if (typeof queryRaw !== "function") return new Date();
  const rows = await queryRaw.call(db, Prisma.sql`SELECT clock_timestamp() AS "now"`) as Array<{ now?: Date }>;
  const now = rows[0]?.now;
  return now instanceof Date && !Number.isNaN(now.getTime()) ? now : fail("MEMBERSHIP_CONFLICT");
}

async function loadTarget(db: MembershipDb, targetId: string): Promise<MembershipTarget | null> {
  return db.appUser.findUnique({
    where: { id: targetId },
    select: {
      id: true,
      username: true,
      disabledAt: true,
      accountAccessVersion: true,
      membershipSubscription: { select: publicSubscription },
    },
  }) as Promise<MembershipTarget | null>;
}

function dependencyProjectFromJson(value: unknown): MembershipDependencyProject | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.projectId !== "string" || typeof row.projectName !== "string") return null;
  return Object.freeze({
    projectId: row.projectId,
    projectName: row.projectName,
    nonTerminalPersonalDelegations: Number(row.nonTerminalPersonalDelegations ?? 0),
    effectivePersonalRouteSelections: Number(row.effectivePersonalRouteSelections ?? 0),
    publishedPersonalIndexes: Number(row.publishedPersonalIndexes ?? 0),
  });
}

function dependencyStats(input: Readonly<{ nonTerminalPersonalDelegations: number; effectivePersonalRouteSelections: number; publishedPersonalIndexes: number; affectedProjects: readonly MembershipDependencyProject[] }>): MembershipDependencyStats {
  return Object.freeze({
    nonTerminalPersonalDelegations: input.nonTerminalPersonalDelegations,
    effectivePersonalRouteSelections: input.effectivePersonalRouteSelections,
    publishedPersonalIndexes: input.publishedPersonalIndexes,
    affectedProjects: Object.freeze([...input.affectedProjects]),
    // Personal model automations are not an exposed capability in this
    // release. Keep the zero explicit so the preview cannot imply that
    // platform automation is being revoked or reconfigured.
    personalModelAutomationsAffected: 0,
    platformAutomationImpact: "unaffected",
    gitMcpImpact: "unaffected",
  });
}

async function loadDependencies(db: MembershipDb, targetId: string): Promise<MembershipDependencyStats> {
  const queryRaw = (db as unknown as { $queryRaw?: (query: Prisma.Sql) => Promise<unknown> }).$queryRaw;
  if (typeof queryRaw === "function") {
    const rows = await queryRaw.call(db, Prisma.sql`
      WITH project_impacts AS (
        SELECT delegation."projectId",
               COUNT(*)::int AS "nonTerminalPersonalDelegations",
               0::int AS "effectivePersonalRouteSelections",
               0::int AS "publishedPersonalIndexes"
          FROM "ProjectAiProviderDelegation" delegation
         WHERE delegation."connectionOwnerId" = ${targetId}::uuid
           AND delegation."status" IN ('draft', 'owner_confirmed', 'active')
         GROUP BY delegation."projectId"
        UNION ALL
        SELECT selection."projectId",
               0::int,
               COUNT(*)::int,
               0::int
          FROM "ProjectAiEffectiveRouteSelection" selection
          LEFT JOIN "ProjectAiProviderDelegation" delegation ON delegation."id" = selection."delegationId"
         WHERE selection."source" = 'personal_delegation'
           AND (selection."selectedById" = ${targetId}::uuid OR delegation."connectionOwnerId" = ${targetId}::uuid)
         GROUP BY selection."projectId"
        UNION ALL
        SELECT pointer."projectId",
               0::int,
               0::int,
               COUNT(*)::int
          FROM "MemoryIndexPointer" pointer
          JOIN "MemoryIndexGeneration" generation
            ON generation."projectId" = pointer."projectId" AND generation."id" = pointer."indexGenerationId"
          JOIN "AiProviderConnection" provider ON provider."id" = generation."providerConnectionId"
         WHERE provider."scope" = 'user'
           AND provider."ownerUserId" = ${targetId}::uuid
         GROUP BY pointer."projectId"
      ), aggregated AS (
        SELECT "projectId",
               SUM("nonTerminalPersonalDelegations")::int AS "nonTerminalPersonalDelegations",
               SUM("effectivePersonalRouteSelections")::int AS "effectivePersonalRouteSelections",
               SUM("publishedPersonalIndexes")::int AS "publishedPersonalIndexes"
          FROM project_impacts
         GROUP BY "projectId"
      )
      SELECT COALESCE(SUM(aggregated."nonTerminalPersonalDelegations"), 0)::int AS "nonTerminalPersonalDelegations",
             COALESCE(SUM(aggregated."effectivePersonalRouteSelections"), 0)::int AS "effectivePersonalRouteSelections",
             COALESCE(SUM(aggregated."publishedPersonalIndexes"), 0)::int AS "publishedPersonalIndexes",
             COALESCE(
               jsonb_agg(
                 jsonb_build_object(
                   'projectId', project."id",
                   'projectName', project."name",
                   'nonTerminalPersonalDelegations', aggregated."nonTerminalPersonalDelegations",
                   'effectivePersonalRouteSelections', aggregated."effectivePersonalRouteSelections",
                   'publishedPersonalIndexes', aggregated."publishedPersonalIndexes"
                 ) ORDER BY project."name", project."id"
               ) FILTER (WHERE project."id" IS NOT NULL),
               '[]'::jsonb
             ) AS "affectedProjects"
        FROM aggregated
        JOIN "Project" project ON project."id" = aggregated."projectId"
    `) as Array<{ nonTerminalPersonalDelegations?: number; effectivePersonalRouteSelections?: number; publishedPersonalIndexes?: number; affectedProjects?: unknown }>;
    const row = rows[0] ?? {};
    const projects = Array.isArray(row.affectedProjects)
      ? row.affectedProjects.map(dependencyProjectFromJson).filter((project): project is MembershipDependencyProject => project !== null)
      : [];
    return dependencyStats({
      nonTerminalPersonalDelegations: Number(row.nonTerminalPersonalDelegations ?? 0),
      effectivePersonalRouteSelections: Number(row.effectivePersonalRouteSelections ?? 0),
      publishedPersonalIndexes: Number(row.publishedPersonalIndexes ?? 0),
      affectedProjects: projects,
    });
  }

  const [delegations, selections, pointers] = await Promise.all([
    db.projectAiProviderDelegation.findMany({
      where: { connectionOwnerId: targetId, status: { in: ["draft", "ownerConfirmed", "active"] } },
      select: { projectId: true, project: { select: { name: true } } },
    }),
    db.projectAiEffectiveRouteSelection.findMany({
      where: { source: "personalDelegation", OR: [{ selectedById: targetId }, { delegation: { connectionOwnerId: targetId } }] },
      select: { projectId: true, project: { select: { name: true } } },
    }),
    db.memoryIndexPointer.findMany({
      where: { generation: { providerConnection: { scope: "user", ownerUserId: targetId } } },
      select: { projectId: true, project: { select: { name: true } } },
    }),
  ]);
  const projectMap = new Map<string, { projectName: string; nonTerminalPersonalDelegations: number; effectivePersonalRouteSelections: number; publishedPersonalIndexes: number }>();
  function projectEntry(projectId: string, projectName: string) {
    const existing = projectMap.get(projectId);
    if (existing) return existing;
    const created = { projectName, nonTerminalPersonalDelegations: 0, effectivePersonalRouteSelections: 0, publishedPersonalIndexes: 0 };
    projectMap.set(projectId, created);
    return created;
  }
  for (const delegation of delegations) projectEntry(delegation.projectId, delegation.project.name).nonTerminalPersonalDelegations += 1;
  for (const selection of selections) projectEntry(selection.projectId, selection.project.name).effectivePersonalRouteSelections += 1;
  for (const pointer of pointers) projectEntry(pointer.projectId, pointer.project.name).publishedPersonalIndexes += 1;
  const affectedProjects = [...projectMap.entries()].map(([projectId, value]) => ({ projectId, ...value })).sort((left, right) => left.projectName.localeCompare(right.projectName) || left.projectId.localeCompare(right.projectId));
  return dependencyStats({
    nonTerminalPersonalDelegations: delegations.length,
    effectivePersonalRouteSelections: selections.length,
    publishedPersonalIndexes: pointers.length,
    affectedProjects,
  });
}

function blockingCategories(dependencies: MembershipDependencyStats): readonly string[] {
  const categories: string[] = [];
  if (dependencies.nonTerminalPersonalDelegations > 0) categories.push("non_terminal_personal_ai_delegation");
  if (dependencies.effectivePersonalRouteSelections > 0) categories.push("effective_personal_route_selection");
  if (dependencies.publishedPersonalIndexes > 0) categories.push("published_personal_index");
  return Object.freeze(categories);
}

function impactFingerprint(input: Readonly<{ userId: string; action: MembershipLifecycleAction; subscription: MembershipSnapshot | null; state: MembershipState; dependencies: MembershipDependencyStats; applicationId?: string | null }>): string {
  return hashFingerprint({
    userId: input.userId,
    action: input.action,
    applicationId: input.applicationId ?? null,
    state: input.state,
    subscription: input.subscription === null ? null : {
      id: input.subscription.id,
      version: input.subscription.version,
      status: input.subscription.status,
      startsAt: input.subscription.startsAt.toISOString(),
      expiresAt: input.subscription.expiresAt.toISOString(),
      revokedAt: input.subscription.revokedAt?.toISOString() ?? null,
      revocationReason: input.subscription.revocationReason,
      note: input.subscription.note,
    },
    dependencies: {
      nonTerminalPersonalDelegations: input.dependencies.nonTerminalPersonalDelegations,
      effectivePersonalRouteSelections: input.dependencies.effectivePersonalRouteSelections,
      publishedPersonalIndexes: input.dependencies.publishedPersonalIndexes,
      affectedProjects: input.dependencies.affectedProjects,
    },
  });
}

function proposedSnapshot(input: Readonly<{ action: MembershipLifecycleAction; subscription: MembershipSnapshot | null; now: Date; days: number; note: string | null; reason: string | null }>): Readonly<{ state: MembershipState; version: number; startsAt: Date; expiresAt: Date; status: MembershipSubscription["status"]; revokedAt: Date | null; revocationReason: string | null; note: string | null }> {
  const existing = input.subscription;
  if (input.action === "revoke") {
    if (existing === null) return fail("MEMBERSHIP_NOT_FOUND");
    return Object.freeze({ state: "revoked", version: existing.version + 1, startsAt: existing.startsAt, expiresAt: existing.expiresAt, status: "revoked", revokedAt: input.now, revocationReason: input.reason, note: existing.note });
  }
  if (input.action === "extend") {
    if (existing === null) return fail("MEMBERSHIP_NOT_FOUND");
    return Object.freeze({ state: "active", version: existing.version + 1, startsAt: existing.startsAt, expiresAt: new Date(existing.expiresAt.getTime() + input.days * 86_400_000), status: "active", revokedAt: null, revocationReason: null, note: input.note });
  }
  const startsAt = input.now;
  return Object.freeze({ state: "active", version: existing === null ? 1 : existing.version + 1, startsAt, expiresAt: new Date(startsAt.getTime() + input.days * 86_400_000), status: "active", revokedAt: null, revocationReason: null, note: input.note });
}

async function previewMembershipInTransaction(db: MembershipDb, input: MembershipPreviewInput, now: Date): Promise<MembershipPreview> {
  const targetId = userId(input.userId);
  const action = assertLifecycleAction(input.action);
  const applicationId = input.applicationId === undefined || input.applicationId === null ? null : userId(input.applicationId);
  if (applicationId !== null && action !== "grant") return fail("MEMBERSHIP_INVALID_INPUT");
  const target = await loadTarget(db, targetId);
  if (target === null) return fail("MEMBERSHIP_USER_NOT_FOUND");
  const state = membershipState(target.membershipSubscription, now);
  assertActionAllowed(action, state);
  if (action === "grant") {
    const pendingApplication = await db.membershipApplication.findFirst({ where: { userId: targetId, status: "pending" }, select: { id: true } });
    if ((pendingApplication?.id ?? null) !== applicationId) return fail("MEMBERSHIP_PREVIEW_STALE");
  }
  const normalizedDays = action === "revoke" ? null : days(input.days);
  const note = safeAuditText(input.note);
  const reason = action === "revoke" ? requiredReason(input.reason) : safeAuditText(input.reason);
  const currentVersion = target.membershipSubscription?.version ?? 0;
  if (input.expectedVersion !== undefined && expectedVersion(input.expectedVersion)! !== currentVersion) return fail("MEMBERSHIP_PREVIEW_STALE");
  if (applicationId !== null) {
    const application = await db.membershipApplication.findUnique({ where: { id: applicationId }, select: { userId: true, status: true, statusVersion: true, accountAccessVersion: true, membershipVersion: true, membershipState: true } });
    if (target.disabledAt !== null || application === null || application.userId !== targetId || application.status !== "pending" || application.accountAccessVersion !== target.accountAccessVersion || application.membershipVersion !== currentVersion || application.membershipState !== state) return fail("MEMBERSHIP_PREVIEW_STALE");
  }
  const dependencies = await loadDependencies(db, targetId);
  const proposed = proposedSnapshot({ action, subscription: target.membershipSubscription, now, days: normalizedDays ?? 0, note, reason });
  const current = Object.freeze({
    state,
    version: currentVersion,
    startsAt: target.membershipSubscription?.startsAt ?? null,
    expiresAt: target.membershipSubscription?.expiresAt ?? null,
    status: target.membershipSubscription?.status ?? null,
  });
  const impact = impactFingerprint({ userId: targetId, action, subscription: target.membershipSubscription, state, dependencies, applicationId });
  const issuedAt = new Date(now.getTime());
  const expiry = new Date(issuedAt.getTime() + MEMBERSHIP_PREVIEW_TTL_MS);
  const request = buildRequestFingerprint({ userId: targetId, action, days: normalizedDays, note, reason, expectedVersion: currentVersion, applicationId, impactFingerprint: impact, previewIssuedAt: issuedAt, previewExpiresAt: expiry });
  const previewId = randomUUID();
  const previewContextDb = db as Prisma.TransactionClient;
  await setPreviewContext(previewContextDb, { previewId, actorId: input.adminUserId, userId: targetId });
  await previewContextDb.membershipMutationPreview.create({
    data: {
      id: previewId,
      actorId: input.adminUserId,
      userId: targetId,
      action,
      expectedVersion: currentVersion,
      impactFingerprint: impact,
      requestFingerprint: request,
      issuedAt,
      expiresAt: expiry,
      applicationId,
    },
  });
  const categories = blockingCategories(dependencies);
  return Object.freeze({
    action,
    user: Object.freeze({ id: target.id, username: target.username, disabledAt: target.disabledAt }),
    current,
    target: proposed,
    dependencyStats: dependencies,
    blockingCategories: categories,
    canExecute: categories.length === 0,
    impactFingerprint: impact,
    requestFingerprint: request,
    previewId,
    issuedAt,
    expiresAt: expiry,
    previewIssuedAt: issuedAt,
    previewExpiresAt: expiry,
    applicationId,
  });
}

export async function previewMembership(input: MembershipPreviewInput, db: PrismaClient = getDb()): Promise<MembershipPreview> {
  const adminId = userId(input.adminUserId);
  await assertAdmin(adminId, db);
  try {
    return await db.$transaction(async (tx) => {
      await lockActorsAccess(tx, [adminId, userId(input.userId)]);
      const currentAdmin = await tx.appUser.findUnique({ where: { id: adminId }, select: { id: true, role: true, disabledAt: true } });
      if (currentAdmin === null || currentAdmin.disabledAt !== null || currentAdmin.role !== "admin") return fail("MEMBERSHIP_ADMIN_REQUIRED");
      return previewMembershipInTransaction(tx, { ...input, adminUserId: adminId }, await databaseNow(tx));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: MEMBERSHIP_MUTATION_TRANSACTION_TIMEOUT_MS });
  } catch (error) {
    if (isMembershipTransactionConflict(error)) return fail("MEMBERSHIP_CONFLICT");
    throw error;
  }
}

function snapshotFromRow(row: MembershipSubscription): MembershipSnapshot {
  return row;
}

function snapshotToPublic(snapshot: Readonly<{
  subscriptionId: string;
  userId: string;
  statusAfter: MembershipSubscription["status"] | null;
  startsAtAfter: Date | null;
  expiresAtAfter: Date | null;
  revokedAtAfter: Date | null;
  revocationReasonAfter: string | null;
  noteAfter: string | null;
  versionAfter: number | null;
  grantedByIdAfter: string | null;
  revokedByIdAfter: string | null;
  transitionAt: Date;
}>): PublicSubscription {
  return Object.freeze({
    id: snapshot.subscriptionId,
    userId: snapshot.userId,
    status: snapshot.statusAfter ?? "active",
    startsAt: snapshot.startsAtAfter ?? snapshot.transitionAt,
    expiresAt: snapshot.expiresAtAfter ?? snapshot.transitionAt,
    revokedAt: snapshot.revokedAtAfter,
    revocationReason: snapshot.revocationReasonAfter,
    note: snapshot.noteAfter,
    version: snapshot.versionAfter ?? 1,
    grantedById: snapshot.grantedByIdAfter,
    revokedById: snapshot.revokedByIdAfter,
    createdAt: snapshot.transitionAt,
    updatedAt: snapshot.transitionAt,
  });
}

async function setPreviewContext(tx: Prisma.TransactionClient, input: Readonly<{ previewId: string; actorId: string; userId: string }>): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_preview_context', '1', true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_preview_id', ${input.previewId}, true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_preview_actor_id', ${input.actorId}, true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_preview_user_id', ${input.userId}, true)`);
}

async function setLifecycleContext(tx: Prisma.TransactionClient, input: Readonly<{ adminUserId: string; userId: string; action: MembershipLifecycleAction; requestKey: string; requestFingerprint: string; impactFingerprint: string; previewId: string; applicationId?: string | null }>): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_context', '1', true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_actor_id', ${input.adminUserId}, true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_user_id', ${input.userId}, true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_action', ${input.action}, true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_request_key', ${input.requestKey}, true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_request_fingerprint', ${input.requestFingerprint}, true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_impact_fingerprint', ${input.impactFingerprint}, true)`);
  await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_preview_id', ${input.previewId}, true)`);
  if (input.applicationId !== undefined && input.applicationId !== null) {
    await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_application_id', ${input.applicationId}, true)`);
    await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_application_actor_id', ${input.adminUserId}, true)`);
    await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_application_user_id', ${input.userId}, true)`);
  }
}

async function executeMembershipInTransaction(tx: Prisma.TransactionClient, input: MembershipExecuteInput, now: Date): Promise<PublicSubscription> {
  const adminId = userId(input.adminUserId);
  const targetId = userId(input.userId);
  const previewId = userId(input.previewId);
  const action = assertLifecycleAction(input.action);
  const applicationId = input.applicationId === undefined || input.applicationId === null ? null : userId(input.applicationId);
  if (applicationId !== null && action !== "grant") return fail("MEMBERSHIP_INVALID_INPUT");
  const key = requestKey(input.requestKey);
  const suppliedRequestFingerprint = fingerprint(input.requestFingerprint);
  const expectedImpact = fingerprint(input.expectedImpactFingerprint);
  const version = expectedVersion(input.expectedVersion)!;
  const previewIssuedAt = dateValue(input.previewIssuedAt);
  const previewExpiresAt = dateValue(input.previewExpiresAt);
  const target = await loadTarget(tx, targetId);
  if (target === null) return fail("MEMBERSHIP_USER_NOT_FOUND");
  const preview = await tx.membershipMutationPreview.findUnique({ where: { id: previewId } });
  if (preview === null || preview.actorId !== adminId || preview.userId !== targetId || preview.action !== action) return fail("MEMBERSHIP_PREVIEW_STALE");
  if ((preview.applicationId ?? null) !== applicationId) return fail("MEMBERSHIP_PREVIEW_STALE");
  if (action === "grant") {
    const pendingApplication = await tx.membershipApplication.findFirst({ where: { userId: targetId, status: "pending" }, select: { id: true } });
    if ((pendingApplication?.id ?? null) !== applicationId) return fail("MEMBERSHIP_PREVIEW_STALE");
  }
  if (input.confirmation !== true) return fail("MEMBERSHIP_CONFIRMATION_REQUIRED");
  if (action === "revoke" && input.confirmationUsername !== target.username) return fail("MEMBERSHIP_CONFIRMATION_REQUIRED");
  const normalizedDays = action === "revoke" ? null : days(input.days);
  const note = safeAuditText(input.note);
  const reason = action === "revoke" ? requiredReason(input.reason) : safeAuditText(input.reason);
  // Validate the caller-supplied fingerprint against the actual mutation
  // payload before looking up an idempotency record.  Otherwise a caller
  // could reuse a previously valid fingerprint while changing the action or
  // note and receive the old result as a replay.
  const suppliedPayloadFingerprint = buildRequestFingerprint({
    userId: targetId,
    action,
    days: normalizedDays,
    note,
    reason,
    expectedVersion: version,
    applicationId,
    impactFingerprint: expectedImpact,
    previewIssuedAt,
    previewExpiresAt,
  });
  if (suppliedPayloadFingerprint !== suppliedRequestFingerprint) return fail("MEMBERSHIP_IDEMPOTENCY_CONFLICT");
  const existingAudit = await tx.membershipSubscriptionAudit.findFirst({ where: { actorId: adminId, requestKey: key, contractVersion: 2 }, orderBy: { createdAt: "asc" } });
  if (existingAudit !== null) {
    if (existingAudit.requestFingerprint !== suppliedRequestFingerprint || existingAudit.previewId !== previewId) return fail("MEMBERSHIP_IDEMPOTENCY_CONFLICT");
    return snapshotToPublic(existingAudit);
  }
  // Reject caller-supplied evidence that already falls outside the server
  // window before comparing it with the persisted preview.  A caller must
  // not be able to turn an overlong or expired preview into a generic hash
  // mismatch by recomputing the public SHA fingerprint.  An exact replay
  // returned above remains safe after the preview's short TTL has elapsed.
  assertPreviewEvidence({ issuedAt: previewIssuedAt, expiresAt: previewExpiresAt, now });
  if (
    preview.expectedVersion !== version
    || preview.impactFingerprint !== expectedImpact
    || preview.requestFingerprint !== suppliedRequestFingerprint
    || preview.issuedAt.getTime() !== previewIssuedAt.getTime()
    || preview.expiresAt.getTime() !== previewExpiresAt.getTime()
  ) return fail("MEMBERSHIP_PREVIEW_STALE");
  if (preview.consumedAt !== null) return fail("MEMBERSHIP_PREVIEW_STALE");
  assertPreviewEvidence({ issuedAt: preview.issuedAt, expiresAt: preview.expiresAt, now });
  const existing = target.membershipSubscription;
  const state = membershipState(existing, now);
  assertActionAllowed(action, state);
  const dependencies = await loadDependencies(tx, targetId);
  if (applicationId !== null) {
    const application = await tx.membershipApplication.findUnique({ where: { id: applicationId }, select: { userId: true, status: true, accountAccessVersion: true, membershipVersion: true, membershipState: true } });
    if (target.disabledAt !== null || application === null || application.userId !== targetId || application.status !== "pending" || application.accountAccessVersion !== target.accountAccessVersion || application.membershipVersion !== version || application.membershipState !== state) return fail("MEMBERSHIP_PREVIEW_STALE");
  }
  const currentImpact = impactFingerprint({ userId: targetId, action, subscription: existing, state, dependencies, applicationId });
  if (version !== (existing?.version ?? 0) || expectedImpact !== currentImpact) return fail("MEMBERSHIP_PREVIEW_STALE");
  const calculatedRequestFingerprint = buildRequestFingerprint({ userId: targetId, action, days: normalizedDays, note, reason, expectedVersion: version, applicationId, impactFingerprint: currentImpact, previewIssuedAt, previewExpiresAt });
  if (calculatedRequestFingerprint !== suppliedRequestFingerprint) return fail("MEMBERSHIP_IDEMPOTENCY_CONFLICT");
  if (dependencies.nonTerminalPersonalDelegations > 0 || dependencies.effectivePersonalRouteSelections > 0 || dependencies.publishedPersonalIndexes > 0) return fail("MEMBERSHIP_DEPENDENCY_RESOLUTION_REQUIRED");

  await setLifecycleContext(tx, { adminUserId: adminId, userId: targetId, action, requestKey: key, requestFingerprint: suppliedRequestFingerprint, impactFingerprint: currentImpact, previewId, applicationId });
  const before = existing === null ? null : snapshotFromRow(existing);
  let subscription: PublicSubscription;
  if (action === "revoke") {
    if (existing === null) return fail("MEMBERSHIP_NOT_FOUND");
    subscription = await tx.membershipSubscription.update({
      where: { userId: targetId },
      data: { status: "revoked", revokedAt: now, revokedById: adminId, revocationReason: reason, version: { increment: 1 } },
      select: publicSubscription,
    });
  } else if (action === "extend") {
    if (existing === null) return fail("MEMBERSHIP_NOT_FOUND");
    subscription = await tx.membershipSubscription.update({
      where: { userId: targetId },
      data: { status: "active", expiresAt: new Date(existing.expiresAt.getTime() + normalizedDays! * 86_400_000), note, version: { increment: 1 } },
      select: publicSubscription,
    });
  } else {
    subscription = existing === null
      ? await tx.membershipSubscription.create({ data: { userId: targetId, status: "active", startsAt: now, expiresAt: new Date(now.getTime() + normalizedDays! * 86_400_000), grantedById: adminId, note }, select: publicSubscription })
      : await tx.membershipSubscription.update({
          where: { userId: targetId },
          data: { status: "active", startsAt: now, expiresAt: new Date(now.getTime() + normalizedDays! * 86_400_000), grantedById: adminId, revokedById: null, revokedAt: null, revocationReason: null, note, version: { increment: 1 } },
          select: publicSubscription,
        });
  }
  const subscriptionAudit = await tx.membershipSubscriptionAudit.create({
    data: {
      id: randomUUID(),
      subscriptionId: subscription.id,
      userId: targetId,
      actorId: adminId,
      eventKind: action,
      startsAt: subscription.startsAt,
      expiresAt: subscription.expiresAt,
      note: subscription.note,
      versionBefore: before?.version ?? null,
      versionAfter: subscription.version,
      statusBefore: before?.status ?? null,
      statusAfter: subscription.status,
      startsAtBefore: before?.startsAt ?? null,
      startsAtAfter: subscription.startsAt,
      expiresAtBefore: before?.expiresAt ?? null,
      expiresAtAfter: subscription.expiresAt,
      revokedAtBefore: before?.revokedAt ?? null,
      revokedAtAfter: subscription.revokedAt,
      revocationReasonBefore: before?.revocationReason ?? null,
      revocationReasonAfter: subscription.revocationReason,
      noteBefore: before?.note ?? null,
      noteAfter: subscription.note,
      grantedByIdBefore: before?.grantedById ?? null,
      grantedByIdAfter: subscription.grantedById,
      revokedByIdBefore: before?.revokedById ?? null,
      revokedByIdAfter: subscription.revokedById,
      reason: reason ?? `membership_${action}`,
      requestKey: key,
      requestFingerprint: suppliedRequestFingerprint,
      impactFingerprint: currentImpact,
      previewId,
      applicationId,
      transitionAt: now,
      createdAt: now,
      contractVersion: 2,
    },
  });
  // The application-bound membership preview must be consumed while the
  // application is still pending. Its database guard intentionally requires
  // that state; the deferred closure checks below still see the complete
  // subscription, audit, and fulfilled-application writes at COMMIT.
  const consumed = await tx.membershipMutationPreview.updateMany({ where: { id: previewId, consumedAt: null }, data: { consumedAt: now } });
  if (consumed.count !== 1) return fail("MEMBERSHIP_CONFLICT");
  if (applicationId !== null) {
    await fulfillMembershipApplicationInTransaction(tx, {
      applicationId,
      actorId: adminId,
      userId: targetId,
      membershipPreviewId: previewId,
      subscriptionId: subscription.id,
      subscriptionVersion: subscription.version,
      subscriptionAuditId: subscriptionAudit.id,
      requestKey: key,
      requestFingerprint: suppliedRequestFingerprint,
      impactFingerprint: currentImpact,
      now,
    });
  }
  return Object.freeze(subscription);
}

export async function executeMembership(input: MembershipExecuteInput, db: PrismaClient = getDb()): Promise<PublicSubscription> {
  const adminId = userId(input.adminUserId);
  const targetId = userId(input.userId);
  await assertAdmin(adminId, db);
  try {
    return await db.$transaction(async (tx) => {
      await lockActorsAccess(tx, [adminId, targetId]);
      const currentAdmin = await tx.appUser.findUnique({ where: { id: adminId }, select: { id: true, role: true, disabledAt: true } });
      if (currentAdmin === null || currentAdmin.disabledAt !== null || currentAdmin.role !== "admin") return fail("MEMBERSHIP_ADMIN_REQUIRED");
      return executeMembershipInTransaction(tx, { ...input, adminUserId: adminId, userId: targetId }, await databaseNow(tx));
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: MEMBERSHIP_MUTATION_TRANSACTION_TIMEOUT_MS });
  } catch (error) {
    const databaseMessage = error instanceof Error ? error.message : "";
    if (isMembershipTransactionConflict(error) || isPrismaCode(error, "P2002") || /P2002|unique constraint|duplicate key/u.test(databaseMessage)) return fail("MEMBERSHIP_CONFLICT");
    if (/PROJECT_AI_PROVIDER_DELEGATION_(?:UPSTREAM_INVALIDATION|SELECTION_INVALIDATION)_REQUIRED/u.test(databaseMessage)) {
      return fail("MEMBERSHIP_DEPENDENCY_RESOLUTION_REQUIRED");
    }
    if (isPrismaCode(error, "P2003") || /23514|check_violation|membership subscription|membership_subscription|constraint/u.test(databaseMessage)) return fail("MEMBERSHIP_CONFLICT");
    throw error;
  }
}
