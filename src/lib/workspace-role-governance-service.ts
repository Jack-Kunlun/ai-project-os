import { createHash, randomUUID } from "node:crypto";
import {
  MembershipAccessState,
  Prisma,
  type PrismaClient,
  type WorkspaceMembership,
  type WorkspaceMembershipRole,
} from "@prisma/client";
import { z } from "zod";
import {
  lockActorsAccess,
  lockProjectAccess,
  lockWorkspaceAccess,
} from "@/lib/access-linearization";
import { getDb } from "@/lib/db";
import {
  findConfirmedWorkspaceMembership,
  findCurrentWorkspaceMembership,
  grantWorkspaceMembership,
  membershipFingerprint,
} from "@/lib/membership-governance";

/**
 * Workspace role changes are deliberately a separate governance surface from
 * the old member PATCH endpoint. Their preview/audit relations are explicitly
 * runtime-only control-plane tables; authorization epochs, membership audits,
 * and the deferred owner invariant remain the safety boundary.
 */

export type WorkspaceRoleGovernanceErrorCode =
  | "WORKSPACE_ROLE_GOVERNANCE_INVALID_INPUT"
  | "WORKSPACE_ROLE_GOVERNANCE_REASON_REQUIRED"
  | "WORKSPACE_ROLE_GOVERNANCE_UNSAFE_TEXT"
  | "WORKSPACE_ROLE_GOVERNANCE_ACTOR_REQUIRED"
  | "WORKSPACE_ROLE_GOVERNANCE_ACTOR_STALE"
  | "WORKSPACE_ROLE_GOVERNANCE_WORKSPACE_NOT_FOUND"
  | "WORKSPACE_ROLE_GOVERNANCE_SUBJECT_NOT_FOUND"
  | "WORKSPACE_ROLE_GOVERNANCE_SUBJECT_MEMBERSHIP_REQUIRED"
  | "WORKSPACE_ROLE_GOVERNANCE_SUBJECT_DISABLED"
  | "WORKSPACE_ROLE_GOVERNANCE_ROLE_FORBIDDEN"
  | "WORKSPACE_ROLE_GOVERNANCE_OWNER_REQUIRED"
  | "WORKSPACE_ROLE_GOVERNANCE_LAST_OWNER_REQUIRED"
  | "WORKSPACE_ROLE_GOVERNANCE_ACTION_CONFLICT"
  | "WORKSPACE_ROLE_GOVERNANCE_PREVIEW_NOT_FOUND"
  | "WORKSPACE_ROLE_GOVERNANCE_PREVIEW_STALE"
  | "WORKSPACE_ROLE_GOVERNANCE_PREVIEW_EXPIRED"
  | "WORKSPACE_ROLE_GOVERNANCE_PREVIEW_CONSUMED"
  | "WORKSPACE_ROLE_GOVERNANCE_CONFIRMATION_REQUIRED"
  | "WORKSPACE_ROLE_GOVERNANCE_CONFIRMATION_MISMATCH"
  | "WORKSPACE_ROLE_GOVERNANCE_IDEMPOTENCY_CONFLICT"
  | "WORKSPACE_ROLE_GOVERNANCE_REQUEST_KEY_CONFLICT"
  | "WORKSPACE_ROLE_GOVERNANCE_PROJECT_GRANTS_FROZEN"
  | "WORKSPACE_ROLE_GOVERNANCE_TRANSACTION_CONFLICT"
  | "WORKSPACE_ROLE_GOVERNANCE_WRITER_REQUIRED";

export class WorkspaceRoleGovernanceError extends Error {
  constructor(readonly code: WorkspaceRoleGovernanceErrorCode) {
    super(code);
    this.name = "WorkspaceRoleGovernanceError";
  }
}

type WorkspaceGovernanceDb = PrismaClient | Prisma.TransactionClient;

const UUID_SCHEMA = z.string().uuid();
const ROLE_SCHEMA = z.enum(["owner", "admin", "member", "viewer"]);
const FINGERPRINT_SCHEMA = z.string().regex(/^[0-9a-f]{64}$/u);
const REQUEST_KEY_SCHEMA = z.string().trim().min(8).max(180);
const PREVIEW_TTL_MS = 5 * 60 * 1_000;
const PREVIEW_CLOCK_SKEW_MS = 5 * 1_000;
const MUTATION_TRANSACTION_TIMEOUT_MS = 30 * 1_000;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const UNSAFE_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f]|[A-Za-z0-9_-]{40,128}/u;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/u;

type WorkspaceMembershipRow = Pick<WorkspaceMembership, "id" | "workspaceId" | "userId" | "role" | "accessState" | "createdAt" | "updatedAt">;

const targetSelect = {
  id: true,
  username: true,
  disabledAt: true,
  accountAccessVersion: true,
} as const;

type TargetRow = Prisma.AppUserGetPayload<{ select: typeof targetSelect }>;

const projectGrantSelect = {
  id: true,
  projectId: true,
  role: true,
  accessState: true,
  createdAt: true,
  updatedAt: true,
} as const;

type ProjectGrantRow = Prisma.ProjectMembershipGetPayload<{
  select: typeof projectGrantSelect;
}>;

type PreviewRow = Prisma.WorkspaceRoleMutationPreviewGetPayload<{
  include: { subject: { select: typeof targetSelect } };
}>;

function fail(code: WorkspaceRoleGovernanceErrorCode): never {
  throw new WorkspaceRoleGovernanceError(code);
}

function parseUuid(value: unknown): string {
  const parsed = UUID_SCHEMA.safeParse(value);
  if (!parsed.success) return fail("WORKSPACE_ROLE_GOVERNANCE_INVALID_INPUT");
  return parsed.data.toLowerCase();
}

function parseRole(value: unknown): WorkspaceMembershipRole {
  const parsed = ROLE_SCHEMA.safeParse(value);
  if (!parsed.success) return fail("WORKSPACE_ROLE_GOVERNANCE_INVALID_INPUT");
  return parsed.data;
}

function parseVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    return fail("WORKSPACE_ROLE_GOVERNANCE_INVALID_INPUT");
  }
  return value as number;
}

function parseFingerprint(value: unknown): string {
  const parsed = FINGERPRINT_SCHEMA.safeParse(value);
  if (!parsed.success) return fail("WORKSPACE_ROLE_GOVERNANCE_INVALID_INPUT");
  return parsed.data;
}

function parseRequestKey(value: unknown): string {
  const parsed = REQUEST_KEY_SCHEMA.safeParse(value);
  if (!parsed.success) return fail("WORKSPACE_ROLE_GOVERNANCE_INVALID_INPUT");
  return safeText(parsed.data, true) ?? fail("WORKSPACE_ROLE_GOVERNANCE_INVALID_INPUT");
}

function safeText(value: unknown, required = false): string | null {
  if (value === null || value === undefined || value === "") {
    if (required) return fail("WORKSPACE_ROLE_GOVERNANCE_REASON_REQUIRED");
    return null;
  }
  if (typeof value !== "string") return fail("WORKSPACE_ROLE_GOVERNANCE_INVALID_INPUT");
  const normalized = value.trim();
  if (normalized.length === 0) {
    if (required) return fail("WORKSPACE_ROLE_GOVERNANCE_REASON_REQUIRED");
    return null;
  }
  if (
    normalized.length > 500
    || CONTROL_PATTERN.test(normalized)
    || UNSAFE_TEXT_PATTERN.test(normalized)
    || EMAIL_PATTERN.test(normalized)
    || /^[0-9a-f]{64}$/iu.test(normalized)
  ) return fail("WORKSPACE_ROLE_GOVERNANCE_UNSAFE_TEXT");
  return normalized;
}

function requiredReason(value: unknown): string {
  const reason = safeText(value, true);
  if (reason === null) return fail("WORKSPACE_ROLE_GOVERNANCE_REASON_REQUIRED");
  return reason;
}

function parseDate(value: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return fail("WORKSPACE_ROLE_GOVERNANCE_INVALID_INPUT");
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
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
    || /P2034|P2028|40001|serialization failure|could not serialize|write conflict|expired transaction/iu.test(message);
}

async function databaseNow(db: WorkspaceGovernanceDb): Promise<Date> {
  const queryRaw = (db as unknown as { $queryRaw?: (query: Prisma.Sql) => Promise<unknown> }).$queryRaw;
  // This control plane must never fall back to the process clock.  A real
  // Prisma client always exposes `$queryRaw`; treating anything else as a
  // transaction conflict keeps preview/execute fail-closed in tests and
  // against accidental adapter substitutions.
  if (typeof queryRaw !== "function") return fail("WORKSPACE_ROLE_GOVERNANCE_TRANSACTION_CONFLICT");
  const rows = await queryRaw.call(db, Prisma.sql`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS "now"`) as Array<{ now?: Date }>;
  const now = rows[0]?.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return fail("WORKSPACE_ROLE_GOVERNANCE_TRANSACTION_CONFLICT");
  return now;
}

async function setConfig(tx: Prisma.TransactionClient, name: string, value: string): Promise<void> {
  const executeRaw = (tx as unknown as { $executeRaw?: (query: Prisma.Sql) => Promise<unknown> }).$executeRaw;
  if (typeof executeRaw !== "function") return;
  await executeRaw.call(tx, Prisma.sql`SELECT set_config(${name}, ${value}, true)`);
}

async function setPreviewContext(tx: Prisma.TransactionClient, input: Readonly<{
  previewId: string;
  workspaceId: string;
  actorId: string;
  subjectId: string;
  membershipId: string;
  currentRole: WorkspaceMembershipRole;
  targetRole: WorkspaceMembershipRole;
  actorVersion: number;
  subjectVersion: number;
  ownerCount: number;
  projectGrantCount: number;
  projectGrantFingerprint: string;
  membershipFingerprint: string;
  requestKey: string;
  requestFingerprint: string;
  impactFingerprint: string;
}>): Promise<void> {
  const values: ReadonlyArray<readonly [string, string]> = [
    ["app.workspace_role_preview_context", "1"],
    ["app.workspace_role_preview_id", input.previewId],
    ["app.workspace_role_workspace_id", input.workspaceId],
    ["app.workspace_role_actor_id", input.actorId],
    ["app.workspace_role_subject_id", input.subjectId],
    ["app.workspace_role_membership_id", input.membershipId],
    ["app.workspace_role_current_role", input.currentRole],
    ["app.workspace_role_target_role", input.targetRole],
    ["app.workspace_role_actor_version", String(input.actorVersion)],
    ["app.workspace_role_subject_version", String(input.subjectVersion)],
    ["app.workspace_role_owner_count", String(input.ownerCount)],
    ["app.workspace_role_project_grant_count", String(input.projectGrantCount)],
    ["app.workspace_role_project_grant_fingerprint", input.projectGrantFingerprint],
    ["app.workspace_role_membership_fingerprint", input.membershipFingerprint],
    ["app.workspace_role_request_key", input.requestKey],
    ["app.workspace_role_request_fingerprint", input.requestFingerprint],
    ["app.workspace_role_impact_fingerprint", input.impactFingerprint],
  ];
  for (const [name, value] of values) await setConfig(tx, name, value);
}

async function setExecuteContext(tx: Prisma.TransactionClient, input: Readonly<{
  previewId: string;
  workspaceId: string;
  actorId: string;
  subjectId: string;
  actorVersion: number;
  subjectVersion: number;
  projectGrantCount: number;
  projectGrantFingerprint: string;
  requestKey: string;
  requestFingerprint: string;
  impactFingerprint: string;
}>): Promise<void> {
  const values: ReadonlyArray<readonly [string, string]> = [
    ["app.workspace_role_execute_context", "1"],
    ["app.workspace_role_execute_preview_id", input.previewId],
    ["app.workspace_role_workspace_id", input.workspaceId],
    ["app.workspace_role_actor_id", input.actorId],
    ["app.workspace_role_subject_id", input.subjectId],
    ["app.workspace_role_actor_version", String(input.actorVersion)],
    ["app.workspace_role_subject_version", String(input.subjectVersion)],
    ["app.workspace_role_project_grant_count", String(input.projectGrantCount)],
    ["app.workspace_role_project_grant_fingerprint", input.projectGrantFingerprint],
    ["app.workspace_role_request_key", input.requestKey],
    ["app.workspace_role_request_fingerprint", input.requestFingerprint],
    ["app.workspace_role_impact_fingerprint", input.impactFingerprint],
  ];
  for (const [name, value] of values) await setConfig(tx, name, value);
}

function projectSnapshot(rows: readonly ProjectGrantRow[]) {
  return rows.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    role: row.role,
    accessState: row.accessState,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

async function loadProjectGrants(tx: Prisma.TransactionClient, workspaceId: string, subjectId: string): Promise<readonly ProjectGrantRow[]> {
  return tx.projectMembership.findMany({
    where: {
      userId: subjectId,
      accessState: { not: MembershipAccessState.revoked },
      project: { workspaceId },
    },
    orderBy: [{ projectId: "asc" }, { id: "asc" }],
    select: projectGrantSelect,
  });
}

async function lockSubjectProjects(tx: Prisma.TransactionClient, workspaceId: string, subjectId: string): Promise<void> {
  const rows = await tx.projectMembership.findMany({
    where: { userId: subjectId, accessState: { not: MembershipAccessState.revoked }, project: { workspaceId } },
    orderBy: [{ projectId: "asc" }, { id: "asc" }],
    select: { projectId: true },
  });
  for (const projectId of [...new Set(rows.map((row) => row.projectId))].sort()) {
    await lockProjectAccess(tx, projectId);
  }
}

async function ownerCount(tx: Prisma.TransactionClient, workspaceId: string): Promise<number> {
  return tx.workspaceMembership.count({
    where: {
      workspaceId,
      role: "owner",
      accessState: MembershipAccessState.confirmed,
      user: { disabledAt: null },
    },
  });
}

function ownerCountAfter(before: number, currentRole: WorkspaceMembershipRole, targetRole: WorkspaceMembershipRole): number {
  const wasOwner = currentRole === "owner";
  const willBeOwner = targetRole === "owner";
  return before - (wasOwner ? 1 : 0) + (willBeOwner ? 1 : 0);
}

function permissionReduction(currentRole: WorkspaceMembershipRole, targetRole: WorkspaceMembershipRole): boolean {
  const rank: Record<WorkspaceMembershipRole, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };
  return rank[targetRole] < rank[currentRole];
}

function membershipSnapshotFingerprint(row: WorkspaceMembershipRow): string {
  return membershipFingerprint({
    membershipId: row.id,
    resourceId: row.workspaceId,
    userId: row.userId,
    role: row.role,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function impactFingerprint(input: Readonly<{
  workspaceId: string;
  subjectId: string;
  membership: WorkspaceMembershipRow;
  targetRole: WorkspaceMembershipRole;
  actorVersion: number;
  subjectVersion: number;
  ownerCount: number;
  projectGrantCount: number;
  projectGrantFingerprint: string;
  membershipFingerprint: string;
}>): string {
  return sha256({
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    membershipId: input.membership.id,
    currentRole: input.membership.role,
    targetRole: input.targetRole,
    actorAccountAccessVersion: input.actorVersion,
    subjectAccountAccessVersion: input.subjectVersion,
    ownerCount: input.ownerCount,
    ownerCountAfter: ownerCountAfter(input.ownerCount, input.membership.role, input.targetRole),
    projectGrantCount: input.projectGrantCount,
    projectGrantFingerprint: input.projectGrantFingerprint,
    membershipFingerprint: input.membershipFingerprint,
  });
}

function requestFingerprint(input: Readonly<{
  workspaceId: string;
  subjectId: string;
  targetRole: WorkspaceMembershipRole;
  reason: string;
  requestKey: string;
  impactFingerprint: string;
  issuedAt: Date;
  expiresAt: Date;
}>): string {
  return sha256({
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    targetRole: input.targetRole,
    reason: input.reason,
    requestKey: input.requestKey,
    impactFingerprint: input.impactFingerprint,
    issuedAt: input.issuedAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
  });
}

function assertPreviewEvidence(issuedAt: Date, expiresAt: Date, now: Date): void {
  if (
    issuedAt.getTime() > now.getTime() + PREVIEW_CLOCK_SKEW_MS
    || expiresAt.getTime() <= now.getTime()
    || expiresAt.getTime() <= issuedAt.getTime()
    || expiresAt.getTime() - issuedAt.getTime() > PREVIEW_TTL_MS
  ) return fail("WORKSPACE_ROLE_GOVERNANCE_PREVIEW_EXPIRED");
}

type GovernanceContext = Readonly<{
  actor: TargetRow;
  subject: TargetRow;
  membership: WorkspaceMembershipRow;
  actorMembershipRole: WorkspaceMembershipRole;
  projectGrants: readonly ProjectGrantRow[];
  projectGrantSnapshot: readonly ReturnType<typeof projectSnapshot>[number][];
  projectGrantFingerprint: string;
  membershipFingerprint: string;
  ownerCount: number;
}>;

async function loadGovernanceContext(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  actorId: string,
  subjectId: string,
  targetRole: WorkspaceMembershipRole,
  actorAccountAccessVersion: number,
): Promise<GovernanceContext> {
  const [actor, subject, workspace] = await Promise.all([
    tx.appUser.findUnique({ where: { id: actorId }, select: targetSelect }),
    tx.appUser.findUnique({ where: { id: subjectId }, select: targetSelect }),
    tx.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } }),
  ]);
  if (workspace === null) return fail("WORKSPACE_ROLE_GOVERNANCE_WORKSPACE_NOT_FOUND");
  if (actor === null || actor.disabledAt !== null) return fail("WORKSPACE_ROLE_GOVERNANCE_ACTOR_REQUIRED");
  if (actor.accountAccessVersion !== actorAccountAccessVersion) return fail("WORKSPACE_ROLE_GOVERNANCE_ACTOR_STALE");
  if (subject === null) return fail("WORKSPACE_ROLE_GOVERNANCE_SUBJECT_NOT_FOUND");
  const actorMembership = await findConfirmedWorkspaceMembership(tx, workspaceId, actorId);
  if (actorMembership === null || (actorMembership.role !== "owner" && actorMembership.role !== "admin")) {
    return fail("WORKSPACE_ROLE_GOVERNANCE_ACTOR_REQUIRED");
  }
  const membership = await findCurrentWorkspaceMembership(tx, workspaceId, subjectId);
  if (membership === null || membership.accessState !== MembershipAccessState.confirmed) {
    return fail("WORKSPACE_ROLE_GOVERNANCE_SUBJECT_MEMBERSHIP_REQUIRED");
  }
  if (membership.role === targetRole) return fail("WORKSPACE_ROLE_GOVERNANCE_ACTION_CONFLICT");
  if (actorMembership.role !== "owner" && (membership.role === "owner" || targetRole === "owner")) {
    return fail("WORKSPACE_ROLE_GOVERNANCE_OWNER_REQUIRED");
  }
  if (subject.disabledAt !== null && (targetRole === "owner" || targetRole === "admin")) {
    return fail("WORKSPACE_ROLE_GOVERNANCE_SUBJECT_DISABLED");
  }
  const projectGrants = await loadProjectGrants(tx, workspaceId, subjectId);
  const snapshot = projectSnapshot(projectGrants);
  return {
    actor,
    subject,
    membership,
    actorMembershipRole: actorMembership.role,
    projectGrants,
    projectGrantSnapshot: snapshot,
    projectGrantFingerprint: sha256(snapshot),
    membershipFingerprint: membershipSnapshotFingerprint(membership),
    ownerCount: await ownerCount(tx, workspaceId),
  };
}

export type WorkspaceRoleMutationPreviewInput = Readonly<{
  workspaceId: string;
  subjectId: string;
  actorId: string;
  actorAccountAccessVersion: number;
  targetRole: WorkspaceMembershipRole;
  reason: string;
  requestKey: string;
}>;

export type WorkspaceRoleMutationPreview = Readonly<{
  previewId: string;
  action: "role_change";
  workspaceId: string;
  actorId: string;
  subject: Readonly<{ id: string; username: string; disabledAt: Date | null }>;
  current: Readonly<{ membershipId: string; role: WorkspaceMembershipRole; accountAccessVersion: number }>;
  target: Readonly<{ role: WorkspaceMembershipRole; ownerCount: number; projectGrantCount: number; permissionReduction: boolean }>;
  ownerCount: number;
  ownerCountAfter: number;
  projectGrantCount: number;
  projectGrantFingerprint: string;
  membershipFingerprint: string;
  reason: string;
  requestKey: string;
  requestFingerprint: string;
  impactFingerprint: string;
  issuedAt: Date;
  expiresAt: Date;
  previewIssuedAt: Date;
  previewExpiresAt: Date;
}>;

function publicPreview(input: Readonly<{
  previewId: string;
  workspaceId: string;
  actorId: string;
  subject: TargetRow;
  membership: WorkspaceMembershipRow;
  targetRole: WorkspaceMembershipRole;
  ownerCount: number;
  projectGrantCount: number;
  projectGrantFingerprint: string;
  membershipFingerprint: string;
  reason: string;
  requestKey: string;
  requestFingerprint: string;
  impactFingerprint: string;
  issuedAt: Date;
  expiresAt: Date;
}>): WorkspaceRoleMutationPreview {
  const nextOwnerCount = ownerCountAfter(input.ownerCount, input.membership.role, input.targetRole);
  return Object.freeze({
    previewId: input.previewId,
    action: "role_change",
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    subject: Object.freeze({ id: input.subject.id, username: input.subject.username, disabledAt: input.subject.disabledAt }),
    current: Object.freeze({ membershipId: input.membership.id, role: input.membership.role, accountAccessVersion: input.subject.accountAccessVersion }),
    target: Object.freeze({ role: input.targetRole, ownerCount: nextOwnerCount, projectGrantCount: input.projectGrantCount, permissionReduction: permissionReduction(input.membership.role, input.targetRole) }),
    ownerCount: input.ownerCount,
    ownerCountAfter: nextOwnerCount,
    projectGrantCount: input.projectGrantCount,
    projectGrantFingerprint: input.projectGrantFingerprint,
    membershipFingerprint: input.membershipFingerprint,
    reason: input.reason,
    requestKey: input.requestKey,
    requestFingerprint: input.requestFingerprint,
    impactFingerprint: input.impactFingerprint,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    previewIssuedAt: input.issuedAt,
    previewExpiresAt: input.expiresAt,
  });
}

function previewFromRow(row: PreviewRow): WorkspaceRoleMutationPreview {
  const subject = row.subject;
  return publicPreview({
    previewId: row.id,
    workspaceId: row.workspaceId,
    actorId: row.actorId,
    subject: subject as TargetRow,
    membership: {
      id: row.membershipId,
      workspaceId: row.workspaceId,
      userId: row.subjectId,
      role: row.currentRole,
      accessState: MembershipAccessState.confirmed,
      createdAt: row.issuedAt,
      updatedAt: row.issuedAt,
    },
    targetRole: row.targetRole,
    ownerCount: row.ownerCount,
    projectGrantCount: row.projectGrantCount,
    projectGrantFingerprint: row.projectGrantFingerprint.trim(),
    membershipFingerprint: row.membershipFingerprint.trim(),
    reason: row.reason,
    requestKey: row.requestKey,
    requestFingerprint: row.requestFingerprint.trim(),
    impactFingerprint: row.impactFingerprint.trim(),
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
  });
}

async function findPreviewByKey(tx: Prisma.TransactionClient, actorId: string, requestKey: string) {
  return tx.workspaceRoleMutationPreview.findUnique({
    where: { actorId_requestKey: { actorId, requestKey } },
    include: { subject: { select: targetSelect } },
  });
}

async function previewInTransaction(
  tx: Prisma.TransactionClient,
  input: WorkspaceRoleMutationPreviewInput,
): Promise<WorkspaceRoleMutationPreview> {
  const workspaceId = parseUuid(input.workspaceId);
  const actorId = parseUuid(input.actorId);
  const subjectId = parseUuid(input.subjectId);
  const actorVersion = parseVersion(input.actorAccountAccessVersion);
  const targetRole = parseRole(input.targetRole);
  const reason = requiredReason(input.reason);
  const requestKey = parseRequestKey(input.requestKey);
  await lockActorsAccess(tx, [actorId, subjectId]);
  await lockWorkspaceAccess(tx, workspaceId);
  await lockSubjectProjects(tx, workspaceId, subjectId);
  const now = await databaseNow(tx);
  const context = await loadGovernanceContext(tx, workspaceId, actorId, subjectId, targetRole, actorVersion);
  if (ownerCountAfter(context.ownerCount, context.membership.role, targetRole) < 1) {
    return fail("WORKSPACE_ROLE_GOVERNANCE_LAST_OWNER_REQUIRED");
  }
  const impact = impactFingerprint({
    workspaceId,
    subjectId,
    membership: context.membership,
    targetRole,
    actorVersion,
    subjectVersion: context.subject.accountAccessVersion,
    ownerCount: context.ownerCount,
    projectGrantCount: context.projectGrants.length,
    projectGrantFingerprint: context.projectGrantFingerprint,
    membershipFingerprint: context.membershipFingerprint,
  });
  const existing = await findPreviewByKey(tx, actorId, requestKey);
  if (existing !== null) {
    // Retries must be derived from the persisted DB-clock window.  Reusing a
    // fresh `now` here would change the request fingerprint by a few
    // milliseconds and turn a lost response into a false idempotency conflict.
    const persistedImpact = impactFingerprint({
      workspaceId,
      subjectId,
      membership: context.membership,
      targetRole,
      actorVersion,
      subjectVersion: context.subject.accountAccessVersion,
      ownerCount: context.ownerCount,
      projectGrantCount: context.projectGrants.length,
      projectGrantFingerprint: context.projectGrantFingerprint,
      membershipFingerprint: context.membershipFingerprint,
    });
    const persistedRequest = requestFingerprint({
      workspaceId,
      subjectId,
      targetRole,
      reason,
      requestKey,
      impactFingerprint: persistedImpact,
      issuedAt: existing.issuedAt,
      expiresAt: existing.expiresAt,
    });
    const stableIntentMismatch = existing.workspaceId !== workspaceId
      || existing.actorId !== actorId
      || existing.subjectId !== subjectId
      || existing.membershipId !== context.membership.id
      || existing.action !== "roleChange"
      || existing.currentRole !== context.membership.role
      || existing.targetRole !== targetRole
      || existing.actorAccountAccessVersion !== actorVersion
      || existing.subjectAccountAccessVersion !== context.subject.accountAccessVersion
      || existing.ownerCount !== context.ownerCount
      || existing.projectGrantCount !== context.projectGrants.length
      || JSON.stringify(existing.projectGrantSnapshot) !== JSON.stringify(context.projectGrantSnapshot)
      || existing.projectGrantFingerprint.trim() !== context.projectGrantFingerprint
      || existing.membershipFingerprint.trim() !== context.membershipFingerprint
      || existing.reason !== reason
      || existing.requestKey !== requestKey
      || existing.impactFingerprint.trim() !== persistedImpact
      || existing.requestFingerprint.trim() !== persistedRequest;
    if (stableIntentMismatch) return fail("WORKSPACE_ROLE_GOVERNANCE_IDEMPOTENCY_CONFLICT");
    if (existing.consumedAt !== null) return fail("WORKSPACE_ROLE_GOVERNANCE_PREVIEW_CONSUMED");
    if (existing.expiresAt <= now) return fail("WORKSPACE_ROLE_GOVERNANCE_PREVIEW_EXPIRED");
    return previewFromRow(existing);
  }
  const issuedAt = new Date(now.getTime());
  const expiresAt = new Date(issuedAt.getTime() + PREVIEW_TTL_MS);
  const request = requestFingerprint({ workspaceId, subjectId, targetRole, reason, requestKey, impactFingerprint: impact, issuedAt, expiresAt });
  const previewId = randomUUID();
  await setPreviewContext(tx, {
    previewId,
    workspaceId,
    actorId,
    subjectId,
    membershipId: context.membership.id,
    currentRole: context.membership.role,
    targetRole,
    actorVersion,
    subjectVersion: context.subject.accountAccessVersion,
    ownerCount: context.ownerCount,
    projectGrantCount: context.projectGrants.length,
    projectGrantFingerprint: context.projectGrantFingerprint,
    membershipFingerprint: context.membershipFingerprint,
    requestKey,
    requestFingerprint: request,
    impactFingerprint: impact,
  });
  await tx.workspaceRoleMutationPreview.create({
    data: {
      id: previewId,
      workspaceId,
      actorId,
      subjectId,
      membershipId: context.membership.id,
      action: "roleChange",
      currentRole: context.membership.role,
      targetRole,
      actorAccountAccessVersion: actorVersion,
      subjectAccountAccessVersion: context.subject.accountAccessVersion,
      ownerCount: context.ownerCount,
      projectGrantCount: context.projectGrants.length,
      projectGrantSnapshot: context.projectGrantSnapshot,
      projectGrantFingerprint: context.projectGrantFingerprint,
      membershipFingerprint: context.membershipFingerprint,
      reason,
      requestKey,
      requestFingerprint: request,
      impactFingerprint: impact,
      issuedAt,
      expiresAt,
      createdAt: issuedAt,
    },
    include: { subject: { select: targetSelect } },
  });
  return publicPreview({
    previewId,
    workspaceId,
    actorId,
    subject: context.subject,
    membership: context.membership,
    targetRole,
    ownerCount: context.ownerCount,
    projectGrantCount: context.projectGrants.length,
    projectGrantFingerprint: context.projectGrantFingerprint,
    membershipFingerprint: context.membershipFingerprint,
    reason,
    requestKey,
    requestFingerprint: request,
    impactFingerprint: impact,
    issuedAt,
    expiresAt,
  });
}

export async function previewWorkspaceRoleMutation(
  input: WorkspaceRoleMutationPreviewInput,
  db: PrismaClient = getDb(),
): Promise<WorkspaceRoleMutationPreview> {
  try {
    return await db.$transaction(async (tx) => previewInTransaction(tx, input), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: MUTATION_TRANSACTION_TIMEOUT_MS,
    });
  } catch (error) {
    if (isTransactionConflict(error)) return fail("WORKSPACE_ROLE_GOVERNANCE_TRANSACTION_CONFLICT");
    if (isPrismaCode(error, "P2002")) return fail("WORKSPACE_ROLE_GOVERNANCE_REQUEST_KEY_CONFLICT");
    throw error;
  }
}

export type WorkspaceRoleMutationExecuteInput = Readonly<WorkspaceRoleMutationPreviewInput & {
  previewId: string;
  currentRole: WorkspaceMembershipRole;
  expectedTargetRole?: WorkspaceMembershipRole;
  expectedOwnerCount?: number;
  expectedProjectGrantCount?: number;
  expectedProjectGrantFingerprint?: string;
  expectedMembershipFingerprint?: string;
  expectedImpactFingerprint: string;
  requestFingerprint: string;
  previewIssuedAt: string | Date;
  previewExpiresAt: string | Date;
  confirmation: true;
  confirmationUsername: string;
}>;

export type WorkspaceRoleMutationResult = Readonly<{
  workspaceId: string;
  actorId: string;
  subject: Readonly<{ id: string; username: string }>;
  oldMembershipId: string;
  newMembershipId: string;
  oldRole: WorkspaceMembershipRole;
  newRole: WorkspaceMembershipRole;
  ownerCountBefore: number;
  ownerCountAfter: number;
  projectGrantCount: number;
  permissionReduction: boolean;
  transitionAt: Date;
  replayed?: boolean;
}>;

async function executeInTransaction(
  tx: Prisma.TransactionClient,
  input: WorkspaceRoleMutationExecuteInput,
): Promise<WorkspaceRoleMutationResult> {
  const workspaceId = parseUuid(input.workspaceId);
  const actorId = parseUuid(input.actorId);
  const subjectId = parseUuid(input.subjectId);
  const previewId = parseUuid(input.previewId);
  const actorVersion = parseVersion(input.actorAccountAccessVersion);
  const targetRole = parseRole(input.targetRole);
  const currentRole = parseRole(input.currentRole);
  const expectedImpact = parseFingerprint(input.expectedImpactFingerprint);
  const suppliedRequest = parseFingerprint(input.requestFingerprint);
  const requestKey = parseRequestKey(input.requestKey);
  const reason = requiredReason(input.reason);
  const issuedAt = parseDate(input.previewIssuedAt);
  const expiresAt = parseDate(input.previewExpiresAt);
  if (input.confirmation !== true) return fail("WORKSPACE_ROLE_GOVERNANCE_CONFIRMATION_REQUIRED");
  if (input.confirmationUsername === undefined || typeof input.confirmationUsername !== "string") return fail("WORKSPACE_ROLE_GOVERNANCE_CONFIRMATION_REQUIRED");
  await lockActorsAccess(tx, [actorId, subjectId]);
  await lockWorkspaceAccess(tx, workspaceId);
  await lockSubjectProjects(tx, workspaceId, subjectId);
  // Read the authoritative clock only after every actor/workspace/project
  // lock.  The same instant drives expiry, preview consumption, transition,
  // and audit timestamps throughout this SERIALIZABLE mutation.
  const now = await databaseNow(tx);
  const existingAudit = await tx.workspaceRoleMutationAudit.findFirst({
    where: { actorId, requestKey },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (existingAudit !== null) {
    const [actor, subject] = await Promise.all([
      tx.appUser.findUnique({ where: { id: actorId }, select: targetSelect }),
      tx.appUser.findUnique({ where: { id: subjectId }, select: targetSelect }),
    ]);
    if (actor === null || actor.disabledAt !== null) return fail("WORKSPACE_ROLE_GOVERNANCE_ACTOR_REQUIRED");
    if (actor.accountAccessVersion !== actorVersion) return fail("WORKSPACE_ROLE_GOVERNANCE_ACTOR_STALE");
    if (subject === null) return fail("WORKSPACE_ROLE_GOVERNANCE_SUBJECT_NOT_FOUND");
    if (subject.username !== input.confirmationUsername) return fail("WORKSPACE_ROLE_GOVERNANCE_CONFIRMATION_MISMATCH");
    if (existingAudit.requestFingerprint.trim() !== suppliedRequest
      || existingAudit.impactFingerprint.trim() !== expectedImpact
      || existingAudit.previewId !== previewId
      || existingAudit.subjectId !== subjectId
      || existingAudit.workspaceId !== workspaceId
      || existingAudit.oldRole !== currentRole
      || existingAudit.newRole !== targetRole
      || existingAudit.reason !== reason
      || existingAudit.actorAccountAccessVersion !== actorVersion
      || (input.expectedTargetRole !== undefined && parseRole(input.expectedTargetRole) !== existingAudit.newRole)
      || (input.expectedOwnerCount !== undefined && input.expectedOwnerCount !== existingAudit.ownerCountBefore)
      || (input.expectedProjectGrantCount !== undefined && input.expectedProjectGrantCount !== existingAudit.projectGrantCount)
      || (input.expectedProjectGrantFingerprint !== undefined && parseFingerprint(input.expectedProjectGrantFingerprint) !== existingAudit.projectGrantFingerprint.trim())
    ) return fail("WORKSPACE_ROLE_GOVERNANCE_IDEMPOTENCY_CONFLICT");
    return {
      workspaceId,
      actorId,
      subject: Object.freeze({ id: subjectId, username: subject.username }),
      oldMembershipId: existingAudit.oldMembershipId,
      newMembershipId: existingAudit.newMembershipId,
      oldRole: existingAudit.oldRole,
      newRole: existingAudit.newRole,
      ownerCountBefore: existingAudit.ownerCountBefore,
      ownerCountAfter: existingAudit.ownerCountAfter,
      projectGrantCount: existingAudit.projectGrantCount,
      permissionReduction: permissionReduction(existingAudit.oldRole, existingAudit.newRole),
      transitionAt: existingAudit.transitionAt,
      replayed: true,
    };
  }
  const context = await loadGovernanceContext(tx, workspaceId, actorId, subjectId, targetRole, actorVersion);
  if (context.subject.username !== input.confirmationUsername) return fail("WORKSPACE_ROLE_GOVERNANCE_CONFIRMATION_MISMATCH");
  if (context.membership.role !== currentRole) return fail("WORKSPACE_ROLE_GOVERNANCE_PREVIEW_STALE");
  if (input.expectedTargetRole !== undefined && parseRole(input.expectedTargetRole) !== targetRole) return fail("WORKSPACE_ROLE_GOVERNANCE_PREVIEW_STALE");
  if (input.expectedOwnerCount !== undefined && input.expectedOwnerCount !== context.ownerCount) return fail("WORKSPACE_ROLE_GOVERNANCE_PREVIEW_STALE");
  if (input.expectedProjectGrantCount !== undefined && input.expectedProjectGrantCount !== context.projectGrants.length) return fail("WORKSPACE_ROLE_GOVERNANCE_PREVIEW_STALE");
  if (input.expectedProjectGrantFingerprint !== undefined && parseFingerprint(input.expectedProjectGrantFingerprint) !== context.projectGrantFingerprint) return fail("WORKSPACE_ROLE_GOVERNANCE_PREVIEW_STALE");
  if (input.expectedMembershipFingerprint !== undefined && parseFingerprint(input.expectedMembershipFingerprint) !== context.membershipFingerprint) return fail("WORKSPACE_ROLE_GOVERNANCE_PREVIEW_STALE");
  const calculatedImpact = impactFingerprint({
    workspaceId,
    subjectId,
    membership: context.membership,
    targetRole,
    actorVersion,
    subjectVersion: context.subject.accountAccessVersion,
    ownerCount: context.ownerCount,
    projectGrantCount: context.projectGrants.length,
    projectGrantFingerprint: context.projectGrantFingerprint,
    membershipFingerprint: context.membershipFingerprint,
  });
  if (calculatedImpact !== expectedImpact) return fail("WORKSPACE_ROLE_GOVERNANCE_PREVIEW_STALE");
  assertPreviewEvidence(issuedAt, expiresAt, now);
  const preview = await tx.workspaceRoleMutationPreview.findUnique({ where: { id: previewId } });
  if (
    preview === null
    || preview.workspaceId !== workspaceId
    || preview.actorId !== actorId
    || preview.subjectId !== subjectId
    || preview.action !== "roleChange"
    || preview.currentRole !== currentRole
    || preview.targetRole !== targetRole
    || preview.actorAccountAccessVersion !== actorVersion
    || preview.subjectAccountAccessVersion !== context.subject.accountAccessVersion
    || preview.ownerCount !== context.ownerCount
    || preview.projectGrantCount !== context.projectGrants.length
    || preview.projectGrantFingerprint !== context.projectGrantFingerprint
    || preview.membershipFingerprint !== context.membershipFingerprint
    || preview.requestKey !== requestKey
    || preview.requestFingerprint !== suppliedRequest
    || preview.impactFingerprint !== expectedImpact
    || preview.issuedAt.getTime() !== issuedAt.getTime()
    || preview.expiresAt.getTime() !== expiresAt.getTime()
    || preview.consumedAt !== null
  ) return fail("WORKSPACE_ROLE_GOVERNANCE_PREVIEW_STALE");
  assertPreviewEvidence(preview.issuedAt, preview.expiresAt, now);
  const expectedRequest = requestFingerprint({ workspaceId, subjectId, targetRole, reason, requestKey, impactFingerprint: calculatedImpact, issuedAt, expiresAt });
  if (expectedRequest !== suppliedRequest) return fail("WORKSPACE_ROLE_GOVERNANCE_IDEMPOTENCY_CONFLICT");
  const ownerBefore = context.ownerCount;
  const ownerAfter = ownerCountAfter(ownerBefore, currentRole, targetRole);
  if (ownerAfter < 1) return fail("WORKSPACE_ROLE_GOVERNANCE_LAST_OWNER_REQUIRED");
  await setExecuteContext(tx, {
    previewId,
    workspaceId,
    actorId,
    subjectId,
    actorVersion,
    subjectVersion: context.subject.accountAccessVersion,
    projectGrantCount: context.projectGrants.length,
    projectGrantFingerprint: context.projectGrantFingerprint,
    requestKey,
    requestFingerprint: suppliedRequest,
    impactFingerprint: calculatedImpact,
  });
  const consumed = await tx.workspaceRoleMutationPreview.updateMany({ where: { id: previewId, consumedAt: null }, data: { consumedAt: now } });
  if (consumed.count !== 1) return fail("WORKSPACE_ROLE_GOVERNANCE_PREVIEW_CONSUMED");
  const replaced = await grantWorkspaceMembership(tx, {
    workspaceId,
    userId: subjectId,
    role: targetRole,
    actorId,
    reason: "workspace_role_mutation_replaced",
  });
  const finalOwnerCount = await ownerCount(tx, workspaceId);
  if (finalOwnerCount !== ownerAfter || finalOwnerCount < 1) return fail("WORKSPACE_ROLE_GOVERNANCE_LAST_OWNER_REQUIRED");
  await tx.workspaceRoleMutationAudit.create({
    data: {
      id: randomUUID(),
      workspaceId,
      actorId,
      subjectId,
      previewId,
      event: "roleChanged",
      oldMembershipId: context.membership.id,
      newMembershipId: replaced.id,
      oldRole: context.membership.role,
      newRole: replaced.role,
      actorAccountAccessVersion: actorVersion,
      subjectAccountAccessVersionBefore: context.subject.accountAccessVersion,
      subjectAccountAccessVersionAfter: context.subject.accountAccessVersion,
      ownerCountBefore: ownerBefore,
      ownerCountAfter: finalOwnerCount,
      projectGrantCount: context.projectGrants.length,
      projectGrantFingerprint: context.projectGrantFingerprint,
      reason,
      requestKey,
      requestFingerprint: suppliedRequest,
      impactFingerprint: calculatedImpact,
      transitionAt: now,
      createdAt: now,
      contractVersion: 1,
    },
  });
  return {
    workspaceId,
    actorId,
    subject: Object.freeze({ id: subjectId, username: context.subject.username }),
    oldMembershipId: context.membership.id,
    newMembershipId: replaced.id,
    oldRole: context.membership.role,
    newRole: replaced.role,
    ownerCountBefore: ownerBefore,
    ownerCountAfter: finalOwnerCount,
    projectGrantCount: context.projectGrants.length,
    permissionReduction: permissionReduction(context.membership.role, replaced.role),
    transitionAt: now,
  };
}

export async function executeWorkspaceRoleMutation(
  input: WorkspaceRoleMutationExecuteInput,
  db: PrismaClient = getDb(),
): Promise<WorkspaceRoleMutationResult> {
  try {
    return await db.$transaction(async (tx) => executeInTransaction(tx, input), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: MUTATION_TRANSACTION_TIMEOUT_MS,
    });
  } catch (error) {
    if (isTransactionConflict(error)) return fail("WORKSPACE_ROLE_GOVERNANCE_TRANSACTION_CONFLICT");
    if (isPrismaCode(error, "P2002")) return fail("WORKSPACE_ROLE_GOVERNANCE_REQUEST_KEY_CONFLICT");
    if (isPrismaCode(error, "P2003") || /workspace role mutation|check_violation|23514|owner invariant/iu.test(error instanceof Error ? error.message : "")) {
      return fail("WORKSPACE_ROLE_GOVERNANCE_TRANSACTION_CONFLICT");
    }
    throw error;
  }
}

/**
 * The legacy PATCH endpoint must remain present for old clients, but it is no
 * longer a role-management write path.  This explicit error is also used by
 * callers that try to include projectGrants: project permissions need their
 * own future PCE and must not be smuggled through a role mutation preview.
 */
export function rejectDirectWorkspaceRoleMutation(): never {
  return fail("WORKSPACE_ROLE_GOVERNANCE_PROJECT_GRANTS_FROZEN");
}
