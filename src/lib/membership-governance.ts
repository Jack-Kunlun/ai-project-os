import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import {
  MembershipAccessState,
  MembershipAccessAuditMembershipKind,
  type MembershipAccessAuditAction,
  ProjectMembershipInheritanceMode,
  type Prisma,
} from "@prisma/client";

export const CONFIRMED_MEMBERSHIP_ACCESS_STATE = MembershipAccessState.confirmed;
export const DEFAULT_MEMBERSHIP_ACCESS_STATE = MembershipAccessState.pending;
export const DEFAULT_PROJECT_MEMBERSHIP_INHERITANCE_MODE = ProjectMembershipInheritanceMode.projectOnly;

export const MEMBERSHIP_GOVERNANCE_CANDIDATE_CLASSIFICATIONS = Object.freeze([
  "likely_migration_generated",
  "ambiguous",
  "not_evaluable",
] as const);

export type MembershipGovernanceCandidateClassification =
  (typeof MEMBERSHIP_GOVERNANCE_CANDIDATE_CLASSIFICATIONS)[number];

export type MembershipGovernanceErrorCode =
  | "MEMBERSHIP_GOVERNANCE_INVALID_TRANSITION"
  | "MEMBERSHIP_GOVERNANCE_INVALID_FINGERPRINT_INPUT"
  | "MEMBERSHIP_GOVERNANCE_INVALID_MANIFEST_ENTRY"
  | "MEMBERSHIP_GOVERNANCE_CURRENT_CONFLICT"
  | "MEMBERSHIP_GOVERNANCE_WRITE_CONFLICT"
  | "MEMBERSHIP_GOVERNANCE_PENDING_CONFIRMATION_REQUIRED";

export class MembershipGovernanceError extends Error {
  readonly code: MembershipGovernanceErrorCode;

  constructor(code: MembershipGovernanceErrorCode, message: string = code) {
    super(message);
    this.name = "MembershipGovernanceError";
    this.code = code;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const MEMBERSHIP_ROLE_VALUES = new Set(["owner", "admin", "member", "editor", "viewer"]);
const FINGERPRINT_SEPARATOR = "\u001f";

export interface MembershipFingerprintInput {
  readonly membershipId: string;
  readonly resourceId: string;
  readonly userId: string;
  readonly role: string;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
}

export interface MembershipManifestEntry {
  readonly membershipKind: MembershipAccessAuditMembershipKind | "workspace" | "project";
  readonly membershipId: string;
  readonly membershipFingerprint: string;
}

export type MembershipAuditDb = Pick<Prisma.TransactionClient, "membershipAccessAudit">;

/**
 * The access-state migration intentionally removes the old compound unique
 * constraints from Prisma's DMMF. Keep all current-row reads behind these
 * helpers so callers cannot accidentally use a revoked history row or assume
 * that a compound `findUnique` still exists.
 */
export type MembershipGovernanceDb = Pick<
  Prisma.TransactionClient,
  "workspaceMembership" | "projectMembership" | "membershipAccessAudit"
>;

const workspaceMembershipAuditSelect = {
  id: true,
  workspaceId: true,
  userId: true,
  role: true,
  accessState: true,
  createdAt: true,
  updatedAt: true,
} as const;

const projectMembershipAuditSelect = {
  id: true,
  projectId: true,
  userId: true,
  role: true,
  accessState: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type CurrentWorkspaceMembership = Prisma.WorkspaceMembershipGetPayload<{
  select: typeof workspaceMembershipAuditSelect;
}>;

export type CurrentProjectMembership = Prisma.ProjectMembershipGetPayload<{
  select: typeof projectMembershipAuditSelect;
}>;

export type WorkspaceMembershipAuditRow = Readonly<{
  id: string;
  workspaceId: string;
  userId: string;
  role: string;
  accessState: MembershipAccessState;
  createdAt: Date;
  updatedAt: Date;
}>;

export type ProjectMembershipAuditRow = Readonly<{
  id: string;
  projectId: string;
  workspaceId: string;
  userId: string;
  role: string;
  accessState: MembershipAccessState;
  createdAt: Date;
  updatedAt: Date;
}>;

export type MembershipAuditInput = Readonly<{
  action: MembershipAccessAuditAction;
  previousState: MembershipAccessState | null;
  actorId?: string | null;
  reason: string;
  manifestFingerprint?: string | null;
}>;

function normalizeUuid(value: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new MembershipGovernanceError("MEMBERSHIP_GOVERNANCE_INVALID_FINGERPRINT_INPUT");
  }
  return value.toLowerCase();
}

function canonicalTimestamp(value: Date | string): string {
  let parsed: Date;
  if (value instanceof Date) {
    parsed = value;
  } else {
    const trimmed = value.trim();
    const postgresTimestamp = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/u;
    parsed = new Date(postgresTimestamp.test(trimmed)
      ? `${trimmed.replace(" ", "T")}Z`
      : trimmed);
  }
  if (Number.isNaN(parsed.getTime())) {
    throw new MembershipGovernanceError("MEMBERSHIP_GOVERNANCE_INVALID_FINGERPRINT_INPUT");
  }
  // PostgreSQL's migration uses timestamp(3) without a timezone.  Removing
  // the trailing Z keeps the JS and SQL canonical payloads identical while
  // still normalizing Date/string inputs to UTC.
  return parsed.toISOString().slice(0, -1);
}

function normalizeRole(value: string): string {
  const role = typeof value === "string" ? value.trim() : "";
  if (!MEMBERSHIP_ROLE_VALUES.has(role)) {
    throw new MembershipGovernanceError("MEMBERSHIP_GOVERNANCE_INVALID_FINGERPRINT_INPUT");
  }
  return role;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Build a deterministic, redacted membership fingerprint.
 *
 * Only UUIDs, the membership role, and the two membership timestamps are
 * included.  Do not extend this input with display names, emails, secrets, or
 * resource content.
 */
export function membershipFingerprint(input: MembershipFingerprintInput): string {
  const payload = [
    normalizeUuid(input.membershipId),
    normalizeUuid(input.resourceId),
    normalizeUuid(input.userId),
    normalizeRole(input.role),
    canonicalTimestamp(input.createdAt),
    canonicalTimestamp(input.updatedAt),
  ].join(FINGERPRINT_SEPARATOR);
  return sha256Hex(payload);
}

export function membershipManifestFingerprint(entries: readonly MembershipManifestEntry[]): string {
  const canonicalEntries = entries.map((entry) => {
    const membershipKind = String(entry.membershipKind);
    if (membershipKind !== "project" && membershipKind !== "workspace") {
      throw new MembershipGovernanceError("MEMBERSHIP_GOVERNANCE_INVALID_MANIFEST_ENTRY");
    }
    const membershipId = normalizeUuid(entry.membershipId);
    const fingerprint = String(entry.membershipFingerprint).toLowerCase();
    if (!FINGERPRINT_PATTERN.test(fingerprint)) {
      throw new MembershipGovernanceError("MEMBERSHIP_GOVERNANCE_INVALID_MANIFEST_ENTRY");
    }
    return { membershipKind, membershipId, fingerprint };
  }).sort((left, right) => {
    const kindOrder = left.membershipKind < right.membershipKind
      ? -1
      : left.membershipKind > right.membershipKind ? 1 : 0;
    if (kindOrder !== 0) return kindOrder;
    return left.membershipId < right.membershipId
      ? -1
      : left.membershipId > right.membershipId ? 1 : 0;
  });

  return sha256Hex(canonicalEntries
    .map((entry) => `${entry.membershipKind}:${entry.membershipId}:${entry.fingerprint}`)
    .join(":"));
}

export const CONFIRMED_WORKSPACE_MEMBERSHIP_WHERE = Object.freeze({
  accessState: CONFIRMED_MEMBERSHIP_ACCESS_STATE,
}) satisfies Prisma.WorkspaceMembershipWhereInput;

export const CONFIRMED_PROJECT_MEMBERSHIP_WHERE = Object.freeze({
  accessState: CONFIRMED_MEMBERSHIP_ACCESS_STATE,
}) satisfies Prisma.ProjectMembershipWhereInput;

export function buildConfirmedWorkspaceMembershipWhere(input: Readonly<{
  workspaceId?: string;
  userId?: string;
}> = {}): Prisma.WorkspaceMembershipWhereInput {
  return {
    ...CONFIRMED_WORKSPACE_MEMBERSHIP_WHERE,
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    ...(input.userId === undefined ? {} : { userId: input.userId }),
  };
}

export function buildConfirmedProjectMembershipWhere(input: Readonly<{
  projectId?: string;
  userId?: string;
}> = {}): Prisma.ProjectMembershipWhereInput {
  return {
    ...CONFIRMED_PROJECT_MEMBERSHIP_WHERE,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.userId === undefined ? {} : { userId: input.userId }),
  };
}

/**
 * Validate a membership access state transition.  Repeating the same state is
 * idempotent; revoked memberships cannot be directly revived as confirmed.
 */
export function assertMembershipAccessTransition(
  previousState: MembershipAccessState,
  nextState: MembershipAccessState,
): void {
  const allowed = previousState === nextState
    || (previousState === MembershipAccessState.pending
      && (nextState === MembershipAccessState.confirmed || nextState === MembershipAccessState.revoked))
    || (previousState === MembershipAccessState.confirmed && nextState === MembershipAccessState.revoked);
  if (!allowed) {
    throw new MembershipGovernanceError(
      "MEMBERSHIP_GOVERNANCE_INVALID_TRANSITION",
      `membership access transition ${previousState}->${nextState} is not allowed`,
    );
  }
}

export function transitionMembershipAccessState(
  previousState: MembershipAccessState,
  nextState: MembershipAccessState,
): MembershipAccessState {
  assertMembershipAccessTransition(previousState, nextState);
  return nextState;
}

function auditNewState(action: MembershipAccessAuditAction): MembershipAccessState {
  if (action === "migrationQuarantined") return MembershipAccessState.pending;
  if (action === "confirmed" || action === "bootstrapConfirmed") return MembershipAccessState.confirmed;
  return MembershipAccessState.revoked;
}

function auditReason(value: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > 500) {
    throw new MembershipGovernanceError("MEMBERSHIP_GOVERNANCE_INVALID_MANIFEST_ENTRY");
  }
  return value;
}

function auditManifestFingerprint(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const fingerprint = value.toLowerCase();
  if (!FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new MembershipGovernanceError("MEMBERSHIP_GOVERNANCE_INVALID_MANIFEST_ENTRY");
  }
  return fingerprint;
}

/**
 * Append an immutable audit row from the complete post-write membership row.
 * The helper deliberately accepts only UUIDs, role/state and timestamps for
 * the fingerprint; callers must never add identity, project text or secrets.
 */
export async function appendMembershipAccessAudit(
  db: MembershipAuditDb,
  membershipKind: MembershipAccessAuditMembershipKind,
  membership: WorkspaceMembershipAuditRow | ProjectMembershipAuditRow,
  input: MembershipAuditInput,
) {
  const newState = auditNewState(input.action);
  if (membership.accessState !== newState) {
    throw new MembershipGovernanceError("MEMBERSHIP_GOVERNANCE_INVALID_TRANSITION");
  }
  if (input.previousState !== null && input.previousState === newState) {
    throw new MembershipGovernanceError("MEMBERSHIP_GOVERNANCE_INVALID_TRANSITION");
  }
  if (input.previousState !== null) assertMembershipAccessTransition(input.previousState, newState);
  const isProject = membershipKind === MembershipAccessAuditMembershipKind.project;
  const resourceId = isProject ? (membership as ProjectMembershipAuditRow).projectId : membership.workspaceId;
  const projectId = isProject ? (membership as ProjectMembershipAuditRow).projectId : null;
  const membershipFingerprint = membershipFingerprintValue(membership, resourceId);
  return db.membershipAccessAudit.create({
    data: {
      membershipKind,
      membershipId: normalizeUuid(membership.id),
      workspaceId: normalizeUuid(membership.workspaceId),
      projectId: projectId === null ? null : normalizeUuid(projectId),
      userId: normalizeUuid(membership.userId),
      action: input.action,
      previousState: input.previousState,
      newState,
      roleSnapshot: normalizeRole(membership.role),
      actorId: input.actorId === undefined || input.actorId === null ? null : normalizeUuid(input.actorId),
      reason: auditReason(input.reason),
      membershipFingerprint,
      manifestFingerprint: auditManifestFingerprint(input.manifestFingerprint),
    },
  });
}

function membershipFingerprintValue(
  membership: WorkspaceMembershipAuditRow | ProjectMembershipAuditRow,
  resourceId: string,
): string {
  return membershipFingerprint({
    membershipId: membership.id,
    resourceId,
    userId: membership.userId,
    role: membership.role,
    createdAt: membership.createdAt,
    updatedAt: membership.updatedAt,
  });
}

export async function appendWorkspaceMembershipAudit(
  db: MembershipAuditDb,
  membership: WorkspaceMembershipAuditRow,
  input: MembershipAuditInput,
) {
  return appendMembershipAccessAudit(db, MembershipAccessAuditMembershipKind.workspace, membership, input);
}

export async function appendProjectMembershipAudit(
  db: MembershipAuditDb,
  membership: ProjectMembershipAuditRow,
  input: MembershipAuditInput,
) {
  return appendMembershipAccessAudit(db, MembershipAccessAuditMembershipKind.project, membership, input);
}

function assertAtMostOneCurrent<T>(rows: readonly T[], kind: MembershipAccessAuditMembershipKind, scope: string): T | null {
  if (rows.length > 1) {
    throw new MembershipGovernanceError(
      "MEMBERSHIP_GOVERNANCE_CURRENT_CONFLICT",
      `${kind} membership has multiple current rows for ${scope}`,
    );
  }
  return rows[0] ?? null;
}

/** Read the sole non-revoked workspace membership for a user. */
export async function findCurrentWorkspaceMembership(
  db: MembershipGovernanceDb,
  workspaceId: string,
  userId: string,
): Promise<CurrentWorkspaceMembership | null> {
  const rows = await db.workspaceMembership.findMany({
    where: {
      workspaceId,
      userId,
      accessState: { not: MembershipAccessState.revoked },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 2,
    select: workspaceMembershipAuditSelect,
  });
  return assertAtMostOneCurrent(rows, MembershipAccessAuditMembershipKind.workspace, `${workspaceId}:${userId}`);
}

/** Read the sole confirmed workspace membership for a user. */
export async function findConfirmedWorkspaceMembership(
  db: MembershipGovernanceDb,
  workspaceId: string,
  userId: string,
): Promise<CurrentWorkspaceMembership | null> {
  const rows = await db.workspaceMembership.findMany({
    where: {
      workspaceId,
      userId,
      accessState: MembershipAccessState.confirmed,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 2,
    select: workspaceMembershipAuditSelect,
  });
  return assertAtMostOneCurrent(rows, MembershipAccessAuditMembershipKind.workspace, `${workspaceId}:${userId}`);
}

/** Read the sole non-revoked project membership for a user. */
export async function findCurrentProjectMembership(
  db: MembershipGovernanceDb,
  projectId: string,
  userId: string,
): Promise<CurrentProjectMembership | null> {
  const rows = await db.projectMembership.findMany({
    where: {
      projectId,
      userId,
      accessState: { not: MembershipAccessState.revoked },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 2,
    select: projectMembershipAuditSelect,
  });
  return assertAtMostOneCurrent(rows, MembershipAccessAuditMembershipKind.project, `${projectId}:${userId}`);
}

/** Read the sole confirmed project membership for a user. */
export async function findConfirmedProjectMembership(
  db: MembershipGovernanceDb,
  projectId: string,
  userId: string,
): Promise<CurrentProjectMembership | null> {
  const rows = await db.projectMembership.findMany({
    where: {
      projectId,
      userId,
      accessState: MembershipAccessState.confirmed,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 2,
    select: projectMembershipAuditSelect,
  });
  return assertAtMostOneCurrent(rows, MembershipAccessAuditMembershipKind.project, `${projectId}:${userId}`);
}

export async function hasRevokedWorkspaceMembership(
  db: MembershipGovernanceDb,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  return (await db.workspaceMembership.count({
    where: { workspaceId, userId, accessState: MembershipAccessState.revoked },
  })) > 0;
}

export async function hasRevokedProjectMembership(
  db: MembershipGovernanceDb,
  projectId: string,
  userId: string,
): Promise<boolean> {
  return (await db.projectMembership.count({
    where: { projectId, userId, accessState: MembershipAccessState.revoked },
  })) > 0;
}

function governanceWriteConflict(message: string): MembershipGovernanceError {
  return new MembershipGovernanceError("MEMBERSHIP_GOVERNANCE_WRITE_CONFLICT", message);
}

function isUniqueConstraintConflict(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "P2002";
}

async function revokeWorkspaceMembershipInTransaction(
  db: MembershipGovernanceDb,
  current: CurrentWorkspaceMembership,
  actorId: string | null,
  reason: string,
): Promise<CurrentWorkspaceMembership> {
  if (current.accessState === MembershipAccessState.pending) {
    throw new MembershipGovernanceError(
      "MEMBERSHIP_GOVERNANCE_PENDING_CONFIRMATION_REQUIRED",
      "pending membership requires explicit governance confirmation",
    );
  }
  if (current.accessState === MembershipAccessState.revoked) return current;
  const result = await db.workspaceMembership.updateMany({
    where: { id: current.id, accessState: current.accessState },
    data: { accessState: MembershipAccessState.revoked },
  });
  if (result.count !== 1) throw governanceWriteConflict(`workspace membership ${current.id} changed concurrently`);
  const revoked = await db.workspaceMembership.findUnique({ where: { id: current.id }, select: workspaceMembershipAuditSelect });
  if (revoked === null) throw governanceWriteConflict(`workspace membership ${current.id} disappeared`);
  await appendWorkspaceMembershipAudit(db, revoked, {
    action: "revoked",
    previousState: current.accessState,
    actorId,
    reason,
  });
  return revoked;
}

async function revokeProjectMembershipInTransaction(
  db: MembershipGovernanceDb,
  current: CurrentProjectMembership,
  workspaceId: string,
  actorId: string | null,
  reason: string,
): Promise<CurrentProjectMembership> {
  if (current.accessState === MembershipAccessState.pending) {
    throw new MembershipGovernanceError(
      "MEMBERSHIP_GOVERNANCE_PENDING_CONFIRMATION_REQUIRED",
      "pending membership requires explicit governance confirmation",
    );
  }
  if (current.accessState === MembershipAccessState.revoked) return current;
  const result = await db.projectMembership.updateMany({
    where: { id: current.id, accessState: current.accessState },
    data: { accessState: MembershipAccessState.revoked },
  });
  if (result.count !== 1) throw governanceWriteConflict(`project membership ${current.id} changed concurrently`);
  const revoked = await db.projectMembership.findUnique({ where: { id: current.id }, select: projectMembershipAuditSelect });
  if (revoked === null) throw governanceWriteConflict(`project membership ${current.id} disappeared`);
  await appendProjectMembershipAudit(db, { ...revoked, workspaceId }, {
    action: "revoked",
    previousState: current.accessState,
    actorId,
    reason,
  });
  return revoked;
}

export type WorkspaceMembershipGrantInput = Readonly<{
  workspaceId: string;
  userId: string;
  role: "owner" | "admin" | "member" | "viewer";
  actorId?: string | null;
  reason: string;
}>;

export type ProjectMembershipGrantInput = Readonly<{
  projectId: string;
  workspaceId: string;
  userId: string;
  role: "owner" | "editor" | "viewer";
  actorId?: string | null;
  reason: string;
}>;

/**
 * Grant or regrant a workspace membership. Existing confirmed rows with the
 * same role are idempotent. Pending rows require the dedicated, double-signed
 * governance manifest; a regrant after revocation gets a new membership id
 * and an audit for both the revocation and the new confirmed epoch.
 *
 * The caller must already hold actor -> workspace -> membership locks.
 */
export async function grantWorkspaceMembership(
  db: MembershipGovernanceDb,
  input: WorkspaceMembershipGrantInput,
): Promise<CurrentWorkspaceMembership> {
  const actorId = input.actorId ?? null;
  const current = await findCurrentWorkspaceMembership(db, input.workspaceId, input.userId);
  if (current !== null && current.accessState === MembershipAccessState.confirmed && current.role === input.role) {
    return current;
  }
  if (current !== null && current.accessState === MembershipAccessState.pending) {
    throw new MembershipGovernanceError(
      "MEMBERSHIP_GOVERNANCE_PENDING_CONFIRMATION_REQUIRED",
      "pending membership requires explicit governance confirmation",
    );
  }
  if (current !== null) await revokeWorkspaceMembershipInTransaction(db, current, actorId, `${input.reason}:role_or_regrant_replacement`);
  let created: CurrentWorkspaceMembership;
  try {
    created = await db.workspaceMembership.create({
      data: {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        userId: input.userId,
        role: input.role,
        accessState: MembershipAccessState.confirmed,
      },
      select: workspaceMembershipAuditSelect,
    });
  } catch (error) {
    if (isUniqueConstraintConflict(error)) {
      throw governanceWriteConflict(`workspace membership ${input.workspaceId}:${input.userId} changed concurrently`);
    }
    throw error;
  }
  await appendWorkspaceMembershipAudit(db, created, {
    action: "confirmed",
    previousState: null,
    actorId,
    reason: input.reason,
  });
  return created;
}

/** Revoke the current workspace membership while retaining its history row. */
export async function revokeWorkspaceMembership(
  db: MembershipGovernanceDb,
  workspaceId: string,
  userId: string,
  input: Readonly<{ actorId?: string | null; reason: string }>,
): Promise<CurrentWorkspaceMembership | null> {
  const current = await findCurrentWorkspaceMembership(db, workspaceId, userId);
  if (current === null) return null;
  return revokeWorkspaceMembershipInTransaction(db, current, input.actorId ?? null, input.reason);
}

/**
 * Grant or regrant a project membership with the same history semantics as
 * workspace memberships. Pending rows require the dedicated, double-signed
 * governance manifest. The workspace id is supplied by the caller so the
 * audit snapshot remains independent from later project deletion.
 */
export async function grantProjectMembership(
  db: MembershipGovernanceDb,
  input: ProjectMembershipGrantInput,
): Promise<CurrentProjectMembership> {
  const actorId = input.actorId ?? null;
  const current = await findCurrentProjectMembership(db, input.projectId, input.userId);
  if (current !== null && current.accessState === MembershipAccessState.confirmed && current.role === input.role) {
    return current;
  }
  if (current !== null && current.accessState === MembershipAccessState.pending) {
    throw new MembershipGovernanceError(
      "MEMBERSHIP_GOVERNANCE_PENDING_CONFIRMATION_REQUIRED",
      "pending membership requires explicit governance confirmation",
    );
  }
  if (current !== null) await revokeProjectMembershipInTransaction(db, current, input.workspaceId, actorId, `${input.reason}:role_or_regrant_replacement`);
  let created: CurrentProjectMembership;
  try {
    created = await db.projectMembership.create({
      data: {
        id: randomUUID(),
        projectId: input.projectId,
        userId: input.userId,
        role: input.role,
        accessState: MembershipAccessState.confirmed,
      },
      select: projectMembershipAuditSelect,
    });
  } catch (error) {
    if (isUniqueConstraintConflict(error)) {
      throw governanceWriteConflict(`project membership ${input.projectId}:${input.userId} changed concurrently`);
    }
    throw error;
  }
  await appendProjectMembershipAudit(db, { ...created, workspaceId: input.workspaceId }, {
    action: "confirmed",
    previousState: null,
    actorId,
    reason: input.reason,
  });
  return created;
}

/** Revoke the current project membership while retaining its history row. */
export async function revokeProjectMembership(
  db: MembershipGovernanceDb,
  projectId: string,
  userId: string,
  workspaceId: string,
  input: Readonly<{ actorId?: string | null; reason: string }>,
): Promise<CurrentProjectMembership | null> {
  const current = await findCurrentProjectMembership(db, projectId, userId);
  if (current === null) return null;
  return revokeProjectMembershipInTransaction(db, current, workspaceId, input.actorId ?? null, input.reason);
}
