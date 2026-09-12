import { createHash, randomUUID } from "node:crypto";
import { Prisma, type GitConnectionStatus, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AccountAccessGuardError, assertAccountAccessForActor } from "@/lib/account-access-guard";
import { lockActorAccess } from "@/lib/access-linearization";
import { rotateCredential } from "@/lib/credential-vault";
import { getDb } from "@/lib/db";
import { isSerializationConflict } from "@/lib/project-snapshot-errors";
import { encodeGitCredential } from "./credentials";
import { GitServiceError, type GitServiceErrorCode } from "./service";

const UUID = z.string().uuid();
const FINGERPRINT = z.string().regex(/^[0-9a-f]{64}$/u);
const REQUEST_KEY = z.string().trim().min(8).max(180).regex(/^[A-Za-z0-9._:-]+$/u);
const REASON = z.string().trim().min(1).max(500).refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const ACTION = z.enum(["rotateCredential", "retrust", "retest", "disable", "enable", "delete"]);
const PREVIEW_TTL_MS = 5 * 60 * 1000;

export type GitConnectionGovernanceActor = Readonly<{ id: string; accountAccessVersion?: number }>;
export type GitConnectionMutationAction = z.infer<typeof ACTION>;

function databaseAction(action: GitConnectionMutationAction): string {
  return action === "rotateCredential" ? "rotate_credential" : action;
}

export type GitConnectionMutationPreviewView = Readonly<{
  id: string;
  connectionId: string;
  action: GitConnectionMutationAction;
  connection: Readonly<{ name: string; status: GitConnectionStatus; configurationVersion: number; updatedAt: string }>;
  scope: "personal";
  owner: Readonly<{ userId: string; feePayer: "connection_owner" }>;
  reason: string;
  requestKey: string;
  requestFingerprint: string;
  impactFingerprint: string;
  impact: Readonly<Record<string, unknown>>;
  blockers: readonly string[];
  canExecute: boolean;
  issuedAt: string;
  expiresAt: string;
  consumedAt: string | null;
  executionStatus: string;
}>;

export type GitConnectionMutationResult = Readonly<{
  connectionId: string;
  action: GitConnectionMutationAction;
  status: string;
  auditId: string;
  result: Readonly<Record<string, unknown>>;
}>;

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

type Impact = Readonly<{
  legacyLinks: ReadonlyArray<Readonly<{ projectId: string; projectName: string | null; status: string }>>;
  liveDelegations: ReadonlyArray<Readonly<{ projectId: string; projectName: string | null; status: string; expiresAt: string }>>;
  manualRuns: ReadonlyArray<Readonly<{ projectId: string; projectName: string | null; status: string; expiresAt: string | null }>>;
  historicalReferences: number;
}>;

const previewSchema = z.object({
  action: ACTION,
  requestKey: REQUEST_KEY,
  reason: REASON,
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  confirmationName: z.string().trim().min(1).max(80).optional(),
  secret: z.string().min(8).max(32_768).optional(),
}).strict();

const executeSchema = z.object({
  previewId: UUID,
  requestKey: REQUEST_KEY,
  requestFingerprint: FINGERPRINT,
  impactFingerprint: FINGERPRINT,
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  confirmationName: z.string().trim().min(1).max(80).optional(),
  secret: z.string().min(8).max(32_768).optional(),
}).strict();

function fail(code: GitServiceErrorCode): never {
  throw new GitServiceError(code);
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function date(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return fail("GIT_CONNECTION_INVALID_INPUT");
  return parsed;
}

function uuid(value: unknown): string {
  const parsed = UUID.safeParse(value);
  return parsed.success ? parsed.data : fail("GIT_CONNECTION_INVALID_INPUT");
}

async function clock(tx: Tx): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS "now"`;
  const value = rows[0]?.now;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("GIT_GOVERNANCE_DATABASE_CLOCK_UNAVAILABLE");
  return value;
}

async function setConfig(tx: Tx, key: string, value: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT set_config(${key}, ${value}, true)`);
}

async function lockConnection(tx: Tx, connectionId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${connectionId}::text, 32010000))`);
  await tx.$queryRaw`SELECT "id" FROM "GitConnection" WHERE "id" = ${connectionId}::uuid FOR UPDATE`;
}

async function requireActor(tx: Db, actor: GitConnectionGovernanceActor): Promise<number> {
  try {
    const current = await assertAccountAccessForActor(tx, actor);
    return current.accountAccessVersion;
  } catch (error) {
    if (error instanceof AccountAccessGuardError) {
      if (error.code === "ACCOUNT_DISABLED") return fail("GIT_CONNECTION_DISABLED");
      return fail("GIT_CONNECTION_NOT_VERIFIED");
    }
    throw error;
  }
}

async function visibleProjectNames(
  db: Db,
  actorId: string,
  projectIds: readonly string[],
): Promise<Map<string, string>> {
  if (projectIds.length === 0) return new Map();
  const projects = await db.project.findMany({
    where: {
      id: { in: [...new Set(projectIds)] },
      OR: [
        { memberships: { some: { userId: actorId, accessState: "confirmed" } } },
        { workspace: { memberships: { some: { userId: actorId, accessState: "confirmed", role: { in: ["owner", "admin"] } } } } },
      ],
    },
    select: { id: true, name: true },
  });
  return new Map(projects.map((project) => [project.id, project.name]));
}

async function loadImpact(db: Db, connectionId: string, actorId: string): Promise<Impact> {
  const delegationRefs = await db.projectGitRepositoryDelegation.findMany({ where: { gitConnectionId: connectionId }, select: { id: true } });
  const delegationRows = await db.projectGitRepositoryDelegation.findMany({
    where: { gitConnectionId: connectionId, status: { in: ["draft", "ownerConfirmed", "active"] } },
    select: { id: true, projectId: true, status: true, expiresAt: true },
    orderBy: [{ projectId: "asc" }, { id: "asc" }],
  });
  const [legacyRows, runRows] = await Promise.all([
    db.projectGitRepositoryLink.findMany({
      where: { repository: { gitConnectionId: connectionId } },
      select: { projectId: true, status: true },
      orderBy: [{ projectId: "asc" }, { id: "asc" }],
    }),
    db.projectGitRepositoryManualRun.findMany({
      where: { delegationId: { in: delegationRows.map((row) => row.id) }, status: { in: ["queued", "running", "unknown"] } },
      select: { projectId: true, status: true, createdAt: true },
      orderBy: [{ projectId: "asc" }, { id: "asc" }],
    }),
  ]);
  const historicalReferences = delegationRefs.length === 0
    ? 0
    : await db.projectGitRepositoryManualRunAudit.count({ where: { delegationId: { in: delegationRefs.map((row) => row.id) } } });
  const projectIds = [
    ...legacyRows.map((row) => row.projectId),
    ...delegationRows.map((row) => row.projectId),
    ...runRows.map((row) => row.projectId),
  ];
  const names = await visibleProjectNames(db, actorId, projectIds);
  const legacyLinks = legacyRows.map((row) => Object.freeze({ projectId: row.projectId, projectName: names.get(row.projectId) ?? null, status: row.status }));
  const liveDelegations = delegationRows.map((row) => Object.freeze({ projectId: row.projectId, projectName: names.get(row.projectId) ?? null, status: row.status, expiresAt: row.expiresAt.toISOString() }));
  const manualRuns = runRows.map((row) => Object.freeze({ projectId: row.projectId, projectName: names.get(row.projectId) ?? null, status: row.status, expiresAt: null }));
  return Object.freeze({ legacyLinks, liveDelegations, manualRuns, historicalReferences });
}

function impactCount(impact: Impact): number {
  return impact.legacyLinks.length + impact.liveDelegations.length + impact.manualRuns.length + impact.historicalReferences;
}

function blockersFor(
  action: GitConnectionMutationAction,
  status: GitConnectionStatus,
  confirmationName: string | undefined,
  name: string,
  candidateSecretPresent: boolean,
  credentialAvailable: boolean,
  impact: Impact,
): string[] {
  const blockers: string[] = [];
  if ((action === "rotateCredential" || action === "retrust" || action === "retest") && status === "disabled") blockers.push("connection_disabled");
  if (action === "rotateCredential" && !candidateSecretPresent) blockers.push("secret_required_at_preview");
  if (action === "rotateCredential" && !credentialAvailable) blockers.push("credential_unavailable");
  if (action === "delete" && status !== "disabled") blockers.push("connection_must_be_disabled");
  if ((action === "disable" || action === "delete") && impact.manualRuns.some((run) => run.status === "queued" || run.status === "running")) blockers.push("active_manual_run");
  // ProjectGitRepositoryLink is retained history and has a NO ACTION FK to
  // GitRepository, regardless of whether the link is currently disabled.
  // Keep preview admission aligned with the database dependency boundary so
  // a disabled legacy link cannot turn an apparently executable delete into a
  // late foreign-key failure.
  if (action === "delete" && impact.legacyLinks.length > 0) blockers.push("legacy_project_link");
  if (action === "delete" && impact.liveDelegations.length > 0) blockers.push("live_delegation");
  if (action === "delete" && impact.historicalReferences > 0) blockers.push("historical_reference");
  if (action === "delete" && confirmationName !== undefined && confirmationName !== name) blockers.push("confirmation_name_mismatch");
  if (action === "retrust" || action === "retest") blockers.push("external_io_planned_not_dispatched");
  return blockers;
}

function previewView(row: {
  id: string; connectionId: string; action: string; reason: string; requestKey: string; requestFingerprint: string; impactFingerprint: string;
  impactSnapshot: Prisma.JsonValue; blockers: Prisma.JsonValue; canExecute: boolean; issuedAt: Date; expiresAt: Date; consumedAt: Date | null;
  executionStatus: string; connectionStatus: GitConnectionStatus; connectionConfigurationVersion: number; connectionUpdatedAt: Date; ownerUserId: string;
}): GitConnectionMutationPreviewView {
  const blockers = Array.isArray(row.blockers) ? row.blockers.filter((value): value is string => typeof value === "string") : [];
  const impact = row.impactSnapshot !== null && typeof row.impactSnapshot === "object" && !Array.isArray(row.impactSnapshot) ? row.impactSnapshot as Record<string, unknown> : {};
  return Object.freeze({
    id: row.id,
    connectionId: row.connectionId,
    action: row.action as GitConnectionMutationAction,
    connection: { name: "连接", status: row.connectionStatus, configurationVersion: row.connectionConfigurationVersion, updatedAt: row.connectionUpdatedAt.toISOString() },
    scope: "personal",
    owner: { userId: row.ownerUserId, feePayer: "connection_owner" as const },
    reason: row.reason,
    requestKey: row.requestKey,
    requestFingerprint: row.requestFingerprint,
    impactFingerprint: row.impactFingerprint,
    impact,
    blockers,
    canExecute: row.canExecute && blockers.length === 0,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    consumedAt: row.consumedAt?.toISOString() ?? null,
    executionStatus: row.executionStatus,
  });
}

async function loadOwnedConnection(tx: Db, connectionId: string, actor: GitConnectionGovernanceActor) {
  const current = await tx.gitConnection.findFirst({
    where: { id: connectionId, ownerUserId: actor.id, ownershipState: "confirmed" },
    select: { id: true, name: true, ownerUserId: true, status: true, configurationVersion: true, updatedAt: true, authKind: true, credentialId: true, ownerAccountAccessVersion: true },
  });
  if (current === null || current.ownerUserId === null) return fail("GIT_CONNECTION_NOT_FOUND");
  if (current.ownerAccountAccessVersion === null) return fail("GIT_CONNECTION_NOT_VERIFIED");
  return current;
}

async function setGovernanceContext(tx: Tx, input: Readonly<{ preview: string; connectionId: string; actorId: string; ownerId: string; action?: string; requestKey?: string; requestFingerprint?: string; impactFingerprint?: string; execute?: boolean }>): Promise<void> {
  // The connection security trigger consumes the base context in addition to
  // the preview/execute phase markers.  Keep all context fields transaction
  // local so a governance mutation cannot leak into a later pooled session.
  await setConfig(tx, "app.git_connection_governance_context", "1");
  await setConfig(tx, "app.git_connection_governance_connection_id", input.connectionId);
  await setConfig(tx, "app.git_connection_governance_actor_id", input.actorId);
  await setConfig(tx, "app.git_connection_governance_owner_id", input.ownerId);
  if (input.action !== undefined) await setConfig(tx, "app.git_connection_governance_action", input.action);
  if (input.requestKey !== undefined) await setConfig(tx, "app.git_connection_governance_request_key", input.requestKey);
  if (input.requestFingerprint !== undefined) await setConfig(tx, "app.git_connection_governance_request_fingerprint", input.requestFingerprint);
  if (input.impactFingerprint !== undefined) await setConfig(tx, "app.git_connection_governance_impact_fingerprint", input.impactFingerprint);
  await setConfig(tx, input.execute === true ? "app.git_connection_governance_execute_context" : "app.git_connection_governance_preview_context", "1");
  await setConfig(tx, input.execute === true ? "app.git_connection_governance_execute_preview_id" : "app.git_connection_governance_preview_id", input.preview);
}

async function withRetry<T>(db: PrismaClient, operation: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!isSerializationConflict(error) || attempt === 2) throw error;
    }
  }
  throw new Error("GIT_CONNECTION_GOVERNANCE_RETRY_EXHAUSTED");
}

export async function previewGitConnectionMutation(
  connectionIdInput: unknown,
  input: unknown,
  actor: GitConnectionGovernanceActor,
  db: PrismaClient = getDb(),
): Promise<GitConnectionMutationPreviewView> {
  const connectionId = uuid(connectionIdInput);
  const parsed = previewSchema.safeParse(input);
  if (!parsed.success) return fail("GIT_CONNECTION_INVALID_INPUT");
  if (parsed.data.action === "rotateCredential" && parsed.data.secret === undefined) return fail("GIT_CONNECTION_INVALID_INPUT");
  if (parsed.data.action === "delete" && parsed.data.confirmationName === undefined) return fail("GIT_CONNECTION_INVALID_INPUT");
  const expectedUpdatedAt = date(parsed.data.expectedUpdatedAt);
  const requestFingerprint = hash({ connectionId, action: parsed.data.action, requestKey: parsed.data.requestKey, reason: parsed.data.reason, expectedUpdatedAt: expectedUpdatedAt.toISOString(), confirmationName: parsed.data.confirmationName ?? null, candidateSecret: parsed.data.secret === undefined ? null : hash(parsed.data.secret) });
  return withRetry(db, async (tx) => {
    await lockActorAccess(tx, actor.id);
    const actorVersion = await requireActor(tx, actor);
    await lockConnection(tx, connectionId);
    const connection = await loadOwnedConnection(tx, connectionId, actor);
    if (connection.ownerAccountAccessVersion !== actorVersion) return fail("GIT_CONNECTION_NOT_VERIFIED");
    if (connection.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return fail("GIT_CONNECTION_CONFLICT");
    const existing = await tx.gitConnectionMutationPreview.findUnique({ where: { actorId_requestKey: { actorId: actor.id, requestKey: parsed.data.requestKey } } });
    if (existing !== null) {
      if (existing.requestFingerprint !== requestFingerprint) return fail("GIT_CONNECTION_PREVIEW_MISMATCH");
      return previewView({ ...existing, connectionStatus: connection.status, connectionConfigurationVersion: connection.configurationVersion, connectionUpdatedAt: connection.updatedAt, ownerUserId: actor.id });
    }
    const impact = await loadImpact(tx, connectionId, actor.id);
    const impactSnapshot = {
      legacyLinks: impact.legacyLinks,
      liveDelegations: impact.liveDelegations,
      manualRuns: impact.manualRuns,
      historicalReferences: impact.historicalReferences,
    } satisfies Prisma.InputJsonValue;
    const impactFingerprint = hash(impactSnapshot);
    const blockers = blockersFor(parsed.data.action, connection.status, parsed.data.confirmationName, connection.name, parsed.data.secret !== undefined, connection.authKind !== "none" && connection.credentialId !== null, impact);
    const issuedAt = await clock(tx);
    const expiresAt = new Date(issuedAt.getTime() + PREVIEW_TTL_MS);
    const previewId = randomUUID();
    await setGovernanceContext(tx, { preview: previewId, connectionId, actorId: actor.id, ownerId: actor.id, action: databaseAction(parsed.data.action), requestKey: parsed.data.requestKey, requestFingerprint, impactFingerprint });
    const row = await tx.gitConnectionMutationPreview.create({
      data: {
        id: previewId, connectionId, actorId: actor.id, ownerUserId: actor.id, action: parsed.data.action,
        actorAccountAccessVersion: actorVersion, connectionConfigurationVersion: connection.configurationVersion,
        connectionUpdatedAt: connection.updatedAt, connectionStatus: connection.status,
        candidateSecretFingerprint: parsed.data.secret === undefined ? null : hash(parsed.data.secret),
        confirmationName: parsed.data.confirmationName ?? null, reason: parsed.data.reason, requestKey: parsed.data.requestKey,
        requestFingerprint, impactFingerprint, impactSnapshot, impactCount: impactCount(impact), blockers: blockers as Prisma.InputJsonValue,
        canExecute: blockers.length === 0, issuedAt, expiresAt,
      },
    });
    return previewView({ ...row, connectionStatus: connection.status, connectionConfigurationVersion: connection.configurationVersion, connectionUpdatedAt: connection.updatedAt, ownerUserId: actor.id });
  });
}

function mutationResult(row: { id: string; connectionId: string; action: string; executionStatus: string; safeErrorCode: string | null; resultId: string | null }): GitConnectionMutationResult {
  return Object.freeze({ connectionId: row.connectionId, action: row.action as GitConnectionMutationAction, status: row.executionStatus, auditId: row.id, result: { safeErrorCode: row.safeErrorCode, resultId: row.resultId } });
}

export async function executeGitConnectionMutation(
  connectionIdInput: unknown,
  input: unknown,
  actor: GitConnectionGovernanceActor,
  db: PrismaClient = getDb(),
): Promise<GitConnectionMutationResult> {
  const connectionId = uuid(connectionIdInput);
  const parsed = executeSchema.safeParse(input);
  if (!parsed.success) return fail("GIT_CONNECTION_INVALID_INPUT");
  const expectedUpdatedAt = date(parsed.data.expectedUpdatedAt);
  const existingAudit = await db.gitConnectionMutationAudit.findFirst({ where: { actorId: actor.id, requestKey: parsed.data.requestKey }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (existingAudit !== null) {
    if (existingAudit.requestFingerprint !== parsed.data.requestFingerprint || existingAudit.connectionId !== connectionId) return fail("GIT_CONNECTION_PREVIEW_MISMATCH");
    return mutationResult(existingAudit);
  }
  return withRetry(db, async (tx) => {
    await lockActorAccess(tx, actor.id);
    const actorVersion = await requireActor(tx, actor);
    await lockConnection(tx, connectionId);
    const preview = await tx.gitConnectionMutationPreview.findFirst({ where: { id: parsed.data.previewId, actorId: actor.id, connectionId } });
    if (preview === null) return fail("GIT_CONNECTION_PREVIEW_NOT_FOUND");
    if (preview.requestKey !== parsed.data.requestKey || preview.requestFingerprint !== parsed.data.requestFingerprint || preview.impactFingerprint !== parsed.data.impactFingerprint) return fail("GIT_CONNECTION_PREVIEW_MISMATCH");
    if (preview.consumedAt !== null) {
      const replay = await tx.gitConnectionMutationAudit.findFirst({ where: { previewId: preview.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
      if (replay !== null) return mutationResult(replay);
      return fail("GIT_CONNECTION_PREVIEW_CONSUMED");
    }
    const connection = await loadOwnedConnection(tx, connectionId, actor);
    if (preview.action === "delete" && parsed.data.confirmationName !== preview.confirmationName) return fail("GIT_CONNECTION_PREVIEW_MISMATCH");
    if (connection.ownerAccountAccessVersion !== actorVersion || connection.updatedAt.getTime() !== expectedUpdatedAt.getTime() || connection.updatedAt.getTime() !== preview.connectionUpdatedAt.getTime() || connection.configurationVersion !== preview.connectionConfigurationVersion || connection.status !== preview.connectionStatus) return fail("GIT_CONNECTION_CONFLICT");
    const now = await clock(tx);
    if (now.getTime() >= preview.expiresAt.getTime()) return fail("GIT_CONNECTION_PREVIEW_EXPIRED");
    const impact = await loadImpact(tx, connectionId, actor.id);
    const currentImpactSnapshot = { legacyLinks: impact.legacyLinks, liveDelegations: impact.liveDelegations, manualRuns: impact.manualRuns, historicalReferences: impact.historicalReferences } satisfies Prisma.InputJsonValue;
    const currentImpactFingerprint = hash(currentImpactSnapshot);
    if (currentImpactFingerprint !== preview.impactFingerprint) return fail("GIT_CONNECTION_IMPACT_CHANGED");
    const blockers = blockersFor(preview.action, connection.status, parsed.data.confirmationName ?? preview.confirmationName ?? undefined, connection.name, parsed.data.secret !== undefined || preview.candidateSecretFingerprint !== null, connection.authKind !== "none" && connection.credentialId !== null, impact);
    if (!preview.canExecute || blockers.length > 0) return fail("GIT_CONNECTION_IN_USE");
    const action = preview.action;
    const external = action === "retrust" || action === "retest";
    await setGovernanceContext(tx, { preview: preview.id, connectionId, actorId: actor.id, ownerId: actor.id, action: databaseAction(action), requestKey: preview.requestKey, requestFingerprint: preview.requestFingerprint, impactFingerprint: preview.impactFingerprint, execute: true });
    let statusAfter: GitConnectionStatus | null = connection.status;
    let executionStatus: "completed" | "held" = external ? "held" : "completed";
    const safeErrorCode: string | null = external ? "GIT_EXTERNAL_IO_PLANNED_NOT_DISPATCHED" : null;
    if (external) {
      executionStatus = "held";
    } else if (action === "rotateCredential") {
      if (parsed.data.secret === undefined || preview.candidateSecretFingerprint === null || hash(parsed.data.secret) !== preview.candidateSecretFingerprint) return fail("GIT_CONNECTION_PREVIEW_MISMATCH");
      if (connection.credentialId === null || connection.authKind === "none") return fail("GIT_CONNECTION_INVALID_INPUT");
      await setConfig(tx, "app.personal_git_credential_rotation_context", "1");
      await setConfig(tx, "app.personal_git_credential_rotation_owner_id", actor.id);
      await setConfig(tx, "app.personal_git_credential_rotation_connection_id", connection.id);
      await rotateCredential(connection.credentialId, "git", encodeGitCredential(connection.authKind, parsed.data.secret), tx);
      statusAfter = "configured";
      await tx.gitConnection.update({ where: { id: connection.id }, data: { configurationVersion: { increment: 1 }, status: "configured", resolvedAddressFingerprint: null, lastTestedAt: null, lastErrorCode: null, ownerAccountAccessVersion: actorVersion }, });
    } else if (action === "disable") {
      statusAfter = "disabled";
      await tx.gitConnection.update({ where: { id: connection.id }, data: { status: "disabled", disabledAt: now, configurationVersion: { increment: 1 } } });
    } else if (action === "enable") {
      statusAfter = "configured";
      await tx.gitConnection.update({ where: { id: connection.id }, data: { status: "configured", disabledAt: null, configurationVersion: { increment: 1 } } });
    } else if (action === "delete") {
      await tx.gitRepository.deleteMany({ where: { gitConnectionId: connection.id } });
      await tx.gitConnection.delete({ where: { id: connection.id } });
      if (connection.credentialId !== null) await tx.externalCredential.delete({ where: { id: connection.credentialId } });
      statusAfter = null;
    } else if (action === "retrust") {
      await tx.gitConnection.update({ where: { id: connection.id }, data: { status: "configured", resolvedAddressFingerprint: null, lastTestedAt: null, lastErrorCode: null, configurationVersion: { increment: 1 } } });
    }
    await tx.gitConnectionMutationPreview.update({ where: { id: preview.id }, data: { consumedAt: now, executionStatus } });
    const connectionAfter = statusAfter === null
      ? null
      : await tx.gitConnection.findUniqueOrThrow({ where: { id: connection.id }, select: { configurationVersion: true, status: true } });
    const audit = await tx.gitConnectionMutationAudit.create({
      data: {
        id: randomUUID(), connectionId, actorId: actor.id, ownerUserId: actor.id, previewId: preview.id, action,
        statusBefore: connection.status, statusAfter: connectionAfter?.status ?? statusAfter, connectionConfigurationVersion: connectionAfter?.configurationVersion ?? connection.configurationVersion,
        impactCount: impactCount(impact), requestKey: preview.requestKey, requestFingerprint: preview.requestFingerprint,
        impactFingerprint: preview.impactFingerprint, executionStatus, safeErrorCode, resultId: null, transitionAt: now,
      },
    });
    return mutationResult(audit);
  });
}

export const gitConnectionMutationActions = Object.freeze(["rotateCredential", "retrust", "retest", "disable", "enable", "delete"] as const);

// Kept for tests and UI adapters: the only supported write path is the pair
// above; callers must never receive secret fingerprints or endpoint fields.
export function isGitConnectionMutationAction(value: unknown): value is GitConnectionMutationAction {
  return typeof value === "string" && (gitConnectionMutationActions as readonly string[]).includes(value);
}
