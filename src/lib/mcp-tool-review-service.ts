import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AccountAccessGuardError, assertAccountAccessForActor } from "@/lib/account-access-guard";
import { lockActorAccess } from "@/lib/access-linearization";
import { type AccessUser } from "@/lib/access-control";
import { getDb } from "@/lib/db";
import { McpCapabilityError, failMcp } from "@/lib/mcp/errors";

const UUID = z.string().uuid();
const FINGERPRINT = z.string().regex(/^[0-9a-f]{64}$/u);
const MAX_SERIALIZABLE_RETRIES = 3;
const NO_CREDENTIAL_FINGERPRINT = "d2ab012fb807b99b7d059aabe98a45dd6edf6941a5f22699f8d04b5906dc2c2b";

const reviewInputSchema = z.object({
  connectionId: UUID,
  toolDefinitionId: UUID,
  expectedConnectionConfigurationRevision: z.number().int().positive(),
  expectedConnectionUpdatedAt: z.string().datetime({ offset: true }),
  expectedDefinitionFingerprint: FINGERPRINT,
  expectedNetworkFingerprint: FINGERPRINT,
  expectedCredentialFingerprint: FINGERPRINT,
  conclusion: z.enum(["read_only_verified", "read_only_rejected", "needs_research"]),
  riskLevel: z.enum(["low", "medium", "high"]),
  riskReasonCode: z.enum([
    "read_only_eligible",
    "write_capability",
    "destructive_capability",
    "untrusted_remote_text",
    "schema_invalid",
    "network_unverified",
    "credential_scope_unknown",
    "insufficient_evidence",
  ]),
  evidenceNote: z.string().min(1).max(240),
  requestKey: z.string().min(1).max(180),
}).strict();

const reviewHistorySchema = z.object({
  toolDefinitionId: UUID.optional(),
  connectionId: UUID.optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

type ReviewInput = z.infer<typeof reviewInputSchema>;
type ReviewHistoryInput = z.infer<typeof reviewHistorySchema>;
type ReviewDb = PrismaClient | Prisma.TransactionClient;
type ReviewTx = Prisma.TransactionClient;

type ReviewConclusion = ReviewInput["conclusion"];
type ReviewRiskLevel = ReviewInput["riskLevel"];
type ReviewRiskReasonCode = ReviewInput["riskReasonCode"];

const prismaConclusion = {
  read_only_verified: "readOnlyVerified",
  read_only_rejected: "readOnlyRejected",
  needs_research: "needsResearch",
} as const;

const prismaRiskReasonCode = {
  read_only_eligible: "readOnlyEligible",
  write_capability: "writeCapability",
  destructive_capability: "destructiveCapability",
  untrusted_remote_text: "untrustedRemoteText",
  schema_invalid: "schemaInvalid",
  network_unverified: "networkUnverified",
  credential_scope_unknown: "credentialScopeUnknown",
  insufficient_evidence: "insufficientEvidence",
} as const;

const evidenceNoteUnsafePattern = /(?:https?:\/\/|ftp:\/\/|www\.|authorization|cookie|header|bearer\s+|basic\s+|token|secret|password|credential|private[\s_-]*key|ciphertext|nonce|authtag|endpoint|-----begin|[a-f0-9]{64}|[A-Za-z0-9+/=_-]{32,})/iu;
const requestKeyUnsafePattern = /(?:https?:\/\/|ftp:\/\/|www\.|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|[A-Za-z0-9+/=_-]{40,})/u;
const controlCharacterPattern = /[\u0000-\u001f\u007f-\u009f]/u;

const reviewSelect = {
  id: true,
  connectionId: true,
  toolDefinitionId: true,
  toolName: true,
  definitionFingerprint: true,
  networkFingerprint: true,
  credentialFingerprint: true,
  connectionConfigurationRevision: true,
  connectionUpdatedAt: true,
  connectionOwnerAccountAccessVersion: true,
  reviewerId: true,
  reviewerAccountAccessVersion: true,
  conclusion: true,
  riskLevel: true,
  riskReasonCode: true,
  noteFingerprint: true,
  requestKey: true,
  requestFingerprint: true,
  attestationId: true,
  evidenceNote: false,
  reviewedAt: true,
  transactionId: true,
  createdAt: true,
} satisfies Prisma.McpToolReviewSelect;

type ReviewRow = Prisma.McpToolReviewGetPayload<{ select: typeof reviewSelect }>;

/**
 * Grant/candidate eligibility is deliberately stricter than the historical
 * V2 attestation shape.  A row is usable only when the immutable positive
 * review and its immutable audit carry the same exact tuple.  Keep this
 * helper read-only so callers cannot accidentally mint or mutate review
 * evidence while checking admission.
 */
export async function hasApprovedMcpToolReview(
  db: ReviewDb,
  attestation: Readonly<{
    id: string;
    connectionId: string;
    toolDefinitionId: string;
    toolName: string;
    definitionFingerprint: string;
    networkFingerprint: string;
    credentialFingerprint: string;
    connectionConfigurationRevision: number | null;
    connectionOwnerAccountAccessVersion: number | null;
    status?: string | null;
    version?: number | null;
    conclusion?: string | null;
    riskLevel?: string | null;
    evidenceNote?: string | null;
  }>,
): Promise<boolean> {
  if (attestation.connectionConfigurationRevision === null || attestation.connectionOwnerAccountAccessVersion === null) return false;
  if (attestation.status !== undefined && (
    attestation.status !== "active"
    || attestation.version !== 1
    || attestation.conclusion !== "read_only_verified"
    || !["low", "medium", "high"].includes(attestation.riskLevel ?? "")
    || attestation.evidenceNote !== "manual_read_only_review"
  )) return false;
  const review = await db.mcpToolReview.findFirst({
    where: {
      attestationId: attestation.id,
      connectionId: attestation.connectionId,
      toolDefinitionId: attestation.toolDefinitionId,
      toolName: attestation.toolName,
      definitionFingerprint: attestation.definitionFingerprint,
      networkFingerprint: attestation.networkFingerprint,
      credentialFingerprint: attestation.credentialFingerprint,
      connectionConfigurationRevision: attestation.connectionConfigurationRevision,
      connectionOwnerAccountAccessVersion: attestation.connectionOwnerAccountAccessVersion,
      conclusion: "readOnlyVerified",
      audits: {
        some: {
          attestationId: attestation.id,
          connectionId: attestation.connectionId,
          toolDefinitionId: attestation.toolDefinitionId,
          toolName: attestation.toolName,
          definitionFingerprint: attestation.definitionFingerprint,
          networkFingerprint: attestation.networkFingerprint,
          credentialFingerprint: attestation.credentialFingerprint,
          connectionConfigurationRevision: attestation.connectionConfigurationRevision,
          connectionOwnerAccountAccessVersion: attestation.connectionOwnerAccountAccessVersion,
          conclusion: "readOnlyVerified",
          evidenceNotePresent: true,
        },
      },
    },
    select: { id: true },
  });
  return review !== null;
}

const reviewCandidateSelect = {
  id: true,
  connectionId: true,
  name: true,
  definitionFingerprint: true,
  current: true,
  remoteReadOnlyHint: true,
  connection: {
    select: {
      id: true,
      name: true,
      authKind: true,
      credentialId: true,
      credentialFingerprint: true,
      configurationRevision: true,
      updatedAt: true,
      resolvedAddressFingerprint: true,
      status: true,
      disabledAt: true,
      ownerUserId: true,
      ownerAccountAccessVersion: true,
      ownershipState: true,
      credential: { select: { kind: true, secretFingerprint: true } },
      ownerUser: { select: { id: true, disabledAt: true, accountAccessVersion: true } },
    },
  },
} satisfies Prisma.McpToolDefinitionSelect;

type ReviewCandidate = Prisma.McpToolDefinitionGetPayload<{ select: typeof reviewCandidateSelect }>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actorIdFromInput(value: unknown): string {
  const candidate = isObject(value) ? value.id : value;
  const parsed = UUID.safeParse(candidate);
  return parsed.success ? parsed.data : failMcp("MCP_ADMIN_REQUIRED");
}

function actorEpochFromInput(value: unknown): number {
  const epoch = isObject(value) ? value.accountAccessVersion : undefined;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1) return failMcp("MCP_ADMIN_REQUIRED");
  return epoch;
}

function isPrismaCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function isSerializationConflict(error: unknown): boolean {
  if (isPrismaCode(error, "P2034")) return true;
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown; meta?: unknown };
  try {
    return /\b(?:40001|40P01)\b/u.test(JSON.stringify([candidate.code, candidate.message, candidate.meta]));
  } catch {
    return false;
  }
}

async function withSerializableRetry<T>(db: PrismaClient, operation: (tx: ReviewTx) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_SERIALIZABLE_RETRIES; attempt += 1) {
    try {
      return await db.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!isSerializationConflict(error) || attempt === MAX_SERIALIZABLE_RETRIES - 1) throw error;
    }
  }
  throw new Error("MCP_TOOL_REVIEW_SERIALIZABLE_RETRY_EXHAUSTED");
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Normalize and reject reviewer notes that could carry remote or secret data. */
export function normalizeMcpToolReviewEvidenceNote(value: unknown): string {
  if (typeof value !== "string") return failMcp("MCP_TOOL_REVIEW_INVALID_INPUT");
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length === 0
    || Array.from(normalized).length > 240
    || Buffer.byteLength(normalized, "utf8") > 768
    || controlCharacterPattern.test(normalized)
    || evidenceNoteUnsafePattern.test(normalized)
  ) return failMcp("MCP_TOOL_REVIEW_NOTE_UNSAFE");
  return normalized;
}

function normalizeRequestKey(value: unknown): string {
  if (typeof value !== "string") return failMcp("MCP_TOOL_REVIEW_INVALID_INPUT");
  const normalized = value.normalize("NFKC").trim();
  if (
    normalized.length === 0
    || Array.from(normalized).length > 180
    || controlCharacterPattern.test(normalized)
    || requestKeyUnsafePattern.test(normalized)
  ) return failMcp("MCP_TOOL_REVIEW_INVALID_INPUT");
  return normalized;
}

function parseReviewInput(value: unknown): ReviewInput & { evidenceNote: string; requestKey: string; expectedUpdatedAt: Date } {
  const parsed = reviewInputSchema.safeParse(value);
  if (!parsed.success) return failMcp("MCP_TOOL_REVIEW_INVALID_INPUT");
  const evidenceNote = normalizeMcpToolReviewEvidenceNote(parsed.data.evidenceNote);
  const requestKey = normalizeRequestKey(parsed.data.requestKey);
  const expectedUpdatedAt = new Date(parsed.data.expectedConnectionUpdatedAt);
  if (!Number.isFinite(expectedUpdatedAt.getTime())) return failMcp("MCP_TOOL_REVIEW_INVALID_INPUT");
  return { ...parsed.data, evidenceNote, requestKey, expectedUpdatedAt };
}

function reviewRequestFingerprint(
  actorId: string,
  reviewerAccountAccessVersion: number,
  input: ReviewInput & { evidenceNote: string; requestKey: string; expectedUpdatedAt: Date },
  noteFingerprint: string,
): string {
  return hashText(JSON.stringify({
    actorId,
    reviewerAccountAccessVersion,
    connectionId: input.connectionId,
    toolDefinitionId: input.toolDefinitionId,
    expectedConnectionConfigurationRevision: input.expectedConnectionConfigurationRevision,
    expectedConnectionUpdatedAt: input.expectedUpdatedAt.toISOString(),
    expectedDefinitionFingerprint: input.expectedDefinitionFingerprint,
    expectedNetworkFingerprint: input.expectedNetworkFingerprint,
    expectedCredentialFingerprint: input.expectedCredentialFingerprint,
    conclusion: input.conclusion,
    riskLevel: input.riskLevel,
    riskReasonCode: input.riskReasonCode,
    noteFingerprint,
    requestKey: input.requestKey,
  }));
}

async function requireAdminActor(db: ReviewDb, actorId: string, expectedEpoch: number): Promise<number> {
  const actor = await db.appUser.findUnique({
    where: { id: actorId },
    select: { role: true, disabledAt: true, accountAccessVersion: true },
  });
  if (actor === null || actor.role !== "admin" || actor.disabledAt !== null || actor.accountAccessVersion !== expectedEpoch) {
    return failMcp("MCP_ADMIN_REQUIRED");
  }
  try {
    await assertAccountAccessForActor(db, { id: actorId, accountAccessVersion: expectedEpoch });
  } catch (error) {
    if (error instanceof AccountAccessGuardError) return failMcp("MCP_ADMIN_REQUIRED");
    throw error;
  }
  return actor.accountAccessVersion;
}

async function lockConnection(tx: ReviewTx, connectionId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${connectionId}::text, 32010000))`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "McpConnection" WHERE "id" = ${connectionId}::uuid FOR UPDATE`);
}

async function lockTuple(tx: ReviewTx, connectionId: string, toolDefinitionId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${connectionId}:${toolDefinitionId}`}::text, 32010003))`);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "McpToolDefinition" WHERE "id" = ${toolDefinitionId}::uuid AND "connectionId" = ${connectionId}::uuid FOR UPDATE`);
}

async function loadCandidate(tx: ReviewTx, toolDefinitionId: string): Promise<ReviewCandidate> {
  const candidate = await tx.mcpToolDefinition.findUnique({ where: { id: toolDefinitionId }, select: reviewCandidateSelect });
  if (candidate === null) return failMcp("MCP_TOOL_NOT_FOUND");
  return candidate;
}

function currentCredentialFingerprint(candidate: ReviewCandidate): string {
  const connection = candidate.connection;
  if (connection.authKind === "none") {
    if (connection.credentialId !== null || connection.credentialFingerprint !== NO_CREDENTIAL_FINGERPRINT) return failMcp("MCP_TOOL_REVIEW_CANDIDATE_STALE");
    return NO_CREDENTIAL_FINGERPRINT;
  }
  if (
    connection.authKind !== "bearer"
    || connection.credentialId === null
    || connection.credential === null
    || connection.credential.kind !== "mcp"
    || connection.credential.secretFingerprint !== connection.credentialFingerprint
  ) return failMcp("MCP_TOOL_REVIEW_CANDIDATE_STALE");
  return connection.credentialFingerprint;
}

function assertCandidateSnapshot(
  candidate: ReviewCandidate,
  input: ReviewInput & { evidenceNote: string; requestKey: string; expectedUpdatedAt: Date },
): { credentialFingerprint: string; connectionOwnerAccountAccessVersion: number } {
  const connection = candidate.connection;
  if (
    candidate.connectionId !== input.connectionId
    || !candidate.current
    || connection.id !== input.connectionId
    || connection.status !== "verified"
    || connection.disabledAt !== null
    || connection.ownershipState !== "confirmed"
    || connection.ownerUserId === null
    || connection.ownerUser === null
    || connection.ownerUser.id !== connection.ownerUserId
    || connection.ownerUser.disabledAt !== null
    || connection.ownerAccountAccessVersion === null
    || connection.ownerAccountAccessVersion < 1
    || connection.ownerAccountAccessVersion !== connection.ownerUser.accountAccessVersion
    || connection.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()
    || connection.configurationRevision !== input.expectedConnectionConfigurationRevision
    || candidate.definitionFingerprint !== input.expectedDefinitionFingerprint
    || connection.resolvedAddressFingerprint === null
    || connection.resolvedAddressFingerprint !== input.expectedNetworkFingerprint
  ) return failMcp("MCP_TOOL_REVIEW_CANDIDATE_STALE");
  const credentialFingerprint = currentCredentialFingerprint(candidate);
  if (credentialFingerprint !== input.expectedCredentialFingerprint) return failMcp("MCP_TOOL_REVIEW_CANDIDATE_STALE");
  if (input.conclusion === "read_only_verified" && !candidate.remoteReadOnlyHint) return failMcp("MCP_TOOL_NOT_READ_ONLY");
  return { credentialFingerprint, connectionOwnerAccountAccessVersion: connection.ownerAccountAccessVersion };
}

async function findExistingReview(tx: ReviewTx, reviewerId: string, requestKey: string): Promise<ReviewRow | null> {
  return tx.mcpToolReview.findUnique({ where: { reviewerId_requestKey: { reviewerId, requestKey } }, select: reviewSelect });
}

function projectReview(row: ReviewRow) {
  return Object.freeze({
    id: row.id,
    connectionId: row.connectionId,
    toolDefinitionId: row.toolDefinitionId,
    toolName: row.toolName,
    definitionFingerprint: row.definitionFingerprint,
    networkFingerprint: row.networkFingerprint,
    credentialFingerprint: row.credentialFingerprint,
    connectionConfigurationRevision: row.connectionConfigurationRevision,
    connectionUpdatedAt: row.connectionUpdatedAt.toISOString(),
    connectionOwnerAccountAccessVersion: row.connectionOwnerAccountAccessVersion,
    reviewerId: row.reviewerId,
    reviewerAccountAccessVersion: row.reviewerAccountAccessVersion,
    conclusion: row.conclusion,
    riskLevel: row.riskLevel,
    riskReasonCode: row.riskReasonCode,
    evidenceNotePresent: true,
    noteFingerprint: row.noteFingerprint,
    attestationId: row.attestationId,
    reviewedAt: row.reviewedAt.toISOString(),
    transactionId: row.transactionId.toString(),
  });
}

function sameRequest(existing: ReviewRow, requestFingerprint: string): boolean {
  return existing.requestFingerprint === requestFingerprint;
}

async function dbClock(tx: ReviewTx): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS "now"`);
  const value = rows[0]?.now;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("MCP_TOOL_REVIEW_DB_CLOCK_UNAVAILABLE");
  return value;
}

async function setReviewContext(
  tx: ReviewTx,
  values: Readonly<{
    reviewId: string;
    connectionId: string;
    toolDefinitionId: string;
    reviewerId: string;
    reviewerEpoch: number;
    conclusion: ReviewConclusion;
    riskLevel: ReviewRiskLevel;
    riskReasonCode: ReviewRiskReasonCode;
    requestKey: string;
    requestFingerprint: string;
    noteFingerprint: string;
    attestationId: string | null;
  }>,
): Promise<void> {
  const context: ReadonlyArray<readonly [string, string]> = [
    ["app.mcp_tool_review_context", "1"],
    ["app.mcp_tool_review_id", values.reviewId],
    ["app.mcp_tool_review_connection_id", values.connectionId],
    ["app.mcp_tool_review_tool_definition_id", values.toolDefinitionId],
    ["app.mcp_tool_review_reviewer_id", values.reviewerId],
    ["app.mcp_tool_review_reviewer_epoch", String(values.reviewerEpoch)],
    ["app.mcp_tool_review_conclusion", values.conclusion],
    ["app.mcp_tool_review_risk_level", values.riskLevel],
    ["app.mcp_tool_review_risk_reason_code", values.riskReasonCode],
    ["app.mcp_tool_review_request_key", values.requestKey],
    ["app.mcp_tool_review_request_fingerprint", values.requestFingerprint],
    ["app.mcp_tool_review_note_fingerprint", values.noteFingerprint],
    ["app.mcp_tool_review_attestation_id", values.attestationId ?? ""],
  ];
  for (const [name, value] of context) await tx.$executeRaw(Prisma.sql`SELECT set_config(${name}, ${value}, true)`);
}

type ActiveAttestation = Readonly<{
  id: string;
  controlPlaneVersion: number | null;
  status: "active" | "revoked" | null;
  version: number | null;
  connectionId: string;
  toolDefinitionId: string;
  toolName: string;
  definitionFingerprint: string;
  networkFingerprint: string;
  credentialFingerprint: string;
  connectionConfigurationRevision: number | null;
  connectionOwnerAccountAccessVersion: number | null;
  conclusion: string | null;
  riskLevel: string | null;
  evidenceNote: string | null;
  verifiedBy: Readonly<{ role: string; disabledAt: Date | null }>;
  note: string | null;
  evidence: unknown;
}>;

async function loadActiveAttestation(
  tx: ReviewTx,
  candidate: ReviewCandidate,
  snapshot: Readonly<{ credentialFingerprint: string; connectionOwnerAccountAccessVersion: number }>,
): Promise<ActiveAttestation | null> {
  return tx.mcpToolAttestation.findFirst({
    where: {
      controlPlaneVersion: 2,
      status: "active",
      connectionId: candidate.connection.id,
      toolDefinitionId: candidate.id,
      toolName: candidate.name,
      definitionFingerprint: candidate.definitionFingerprint,
      networkFingerprint: candidate.connection.resolvedAddressFingerprint!,
      credentialFingerprint: snapshot.credentialFingerprint,
      connectionConfigurationRevision: candidate.connection.configurationRevision,
    },
    select: {
      id: true,
      controlPlaneVersion: true,
      status: true,
      version: true,
      connectionId: true,
      toolDefinitionId: true,
      toolName: true,
      definitionFingerprint: true,
      networkFingerprint: true,
      credentialFingerprint: true,
      connectionConfigurationRevision: true,
      connectionOwnerAccountAccessVersion: true,
      conclusion: true,
      riskLevel: true,
      evidenceNote: true,
      verifiedBy: { select: { role: true, disabledAt: true } },
      note: true,
      evidence: true,
    },
  }) as unknown as Promise<ActiveAttestation | null>;
}

function isEmptyJsonObject(value: unknown): boolean {
  return isObject(value) && Object.keys(value).length === 0;
}

function isEffectiveActiveAttestation(
  row: ActiveAttestation,
  candidate: ReviewCandidate,
  snapshot: Readonly<{ credentialFingerprint: string; connectionOwnerAccountAccessVersion: number }>,
): boolean {
  return row.controlPlaneVersion === 2
    && row.status === "active"
    && row.version === 1
    && row.conclusion === "read_only_verified"
    && row.riskLevel !== null
    && ["low", "medium", "high"].includes(row.riskLevel)
    && row.evidenceNote === "manual_read_only_review"
    && row.note === null
    && isEmptyJsonObject(row.evidence)
    && row.verifiedBy.role === "admin"
    && row.verifiedBy.disabledAt === null
    && row.connectionId === candidate.connection.id
    && row.toolDefinitionId === candidate.id
    && row.toolName === candidate.name
    && row.definitionFingerprint === candidate.definitionFingerprint
    && row.networkFingerprint === candidate.connection.resolvedAddressFingerprint
    && row.credentialFingerprint === snapshot.credentialFingerprint
    && row.connectionConfigurationRevision === candidate.connection.configurationRevision
    && row.connectionOwnerAccountAccessVersion === snapshot.connectionOwnerAccountAccessVersion;
}

/** Revoke an existing same-tuple V2 row before creating the reviewed row. */
async function revokeActiveAttestationForReview(tx: ReviewTx, row: ActiveAttestation, actorId: string): Promise<void> {
  if (row.version !== 1 || row.controlPlaneVersion !== 2 || row.status !== "active") {
    return failMcp("MCP_TOOL_REVIEW_ATTESTATION_CONFLICT");
  }
  const nextVersion = row.version + 1;
  const changed = await tx.mcpToolAttestation.updateMany({
    where: { id: row.id, controlPlaneVersion: 2, status: "active", version: row.version },
    data: { status: "revoked", version: nextVersion, revokedById: actorId },
  });
  if (changed.count !== 1) return failMcp("MCP_TOOL_REVIEW_ATTESTATION_CONFLICT");
  await tx.mcpToolAttestationAudit.create({
    data: {
      id: randomUUID(),
      attestationId: row.id,
      connectionId: row.connectionId,
      toolDefinitionId: row.toolDefinitionId,
      event: "revoked",
      actorId,
      controlPlaneVersion: 2,
      attestationVersion: nextVersion,
      statusBefore: "active",
      statusAfter: "revoked",
      connectionConfigurationRevision: row.connectionConfigurationRevision,
      connectionOwnerAccountAccessVersion: row.connectionOwnerAccountAccessVersion,
      definitionFingerprint: row.definitionFingerprint,
      networkFingerprint: row.networkFingerprint,
      credentialFingerprint: row.credentialFingerprint,
      details: {},
    },
  });
}

async function createReviewTransaction(
  tx: ReviewTx,
  actorId: string,
  reviewerAccountAccessVersion: number,
  input: ReviewInput & { evidenceNote: string; requestKey: string; expectedUpdatedAt: Date },
  noteFingerprint: string,
  requestFingerprint: string,
): Promise<Readonly<{ review: ReturnType<typeof projectReview>; created: boolean }>> {
  await lockActorAccess(tx, actorId);
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "AppUser" WHERE "id" = ${actorId}::uuid FOR UPDATE`);
  await requireAdminActor(tx, actorId, reviewerAccountAccessVersion);

  let existing = await findExistingReview(tx, actorId, input.requestKey);
  if (existing !== null) {
    if (!sameRequest(existing, requestFingerprint)) return failMcp("MCP_TOOL_REVIEW_IDEMPOTENCY_CONFLICT");
    return Object.freeze({ review: projectReview(existing), created: false });
  }

  const initial = await tx.mcpToolDefinition.findUnique({ where: { id: input.toolDefinitionId }, select: { connectionId: true } });
  if (initial === null) return failMcp("MCP_TOOL_NOT_FOUND");
  await lockConnection(tx, initial.connectionId);
  await lockTuple(tx, initial.connectionId, input.toolDefinitionId);
  await requireAdminActor(tx, actorId, reviewerAccountAccessVersion);

  existing = await findExistingReview(tx, actorId, input.requestKey);
  if (existing !== null) {
    if (!sameRequest(existing, requestFingerprint)) return failMcp("MCP_TOOL_REVIEW_IDEMPOTENCY_CONFLICT");
    return Object.freeze({ review: projectReview(existing), created: false });
  }

  const candidate = await loadCandidate(tx, input.toolDefinitionId);
  const snapshot = assertCandidateSnapshot(candidate, input);
  const active = await loadActiveAttestation(tx, candidate, snapshot);
  const activeHasApprovedReview = active === null ? false : await hasApprovedMcpToolReview(tx, active);
  let attestationId: string | null = null;
  if (input.conclusion === "read_only_verified") {
    if (active !== null) {
      if (activeHasApprovedReview) return failMcp("MCP_TOOL_REVIEW_ATTESTATION_CONFLICT");
      // Never reuse an active row: the review must be the immutable evidence
      // for a fresh V2 attestation created in this same transaction.
      await revokeActiveAttestationForReview(tx, active, actorId);
    }
    const attestation = await tx.mcpToolAttestation.create({
      data: {
        id: randomUUID(),
        controlPlaneVersion: 2,
        status: "active",
        version: 1,
        connectionId: candidate.connection.id,
        toolDefinitionId: candidate.id,
        toolName: candidate.name,
        definitionFingerprint: candidate.definitionFingerprint,
        networkFingerprint: candidate.connection.resolvedAddressFingerprint!,
        credentialFingerprint: snapshot.credentialFingerprint,
        conclusion: "read_only_verified",
        riskLevel: input.riskLevel,
        evidenceNote: "manual_read_only_review",
        connectionConfigurationRevision: candidate.connection.configurationRevision,
        connectionOwnerAccountAccessVersion: snapshot.connectionOwnerAccountAccessVersion,
        verifiedById: actorId,
        note: null,
        evidence: {},
      },
      select: { id: true },
    });
    attestationId = attestation.id;
    await tx.mcpToolAttestationAudit.create({
      data: {
        id: randomUUID(),
        attestationId,
        connectionId: candidate.connection.id,
        toolDefinitionId: candidate.id,
        event: "attested",
        actorId,
        controlPlaneVersion: 2,
        attestationVersion: 1,
        statusBefore: null,
        statusAfter: "active",
        connectionConfigurationRevision: candidate.connection.configurationRevision,
        connectionOwnerAccountAccessVersion: snapshot.connectionOwnerAccountAccessVersion,
        definitionFingerprint: candidate.definitionFingerprint,
        networkFingerprint: candidate.connection.resolvedAddressFingerprint!,
        credentialFingerprint: snapshot.credentialFingerprint,
        details: {},
      },
    });
  } else if (active !== null && activeHasApprovedReview && isEffectiveActiveAttestation(active, candidate, snapshot)) {
    return failMcp("MCP_TOOL_REVIEW_ATTESTATION_CONFLICT");
  }

  const reviewId = randomUUID();
  const reviewedAt = await dbClock(tx);
  await setReviewContext(tx, {
    reviewId,
    connectionId: candidate.connection.id,
    toolDefinitionId: candidate.id,
    reviewerId: actorId,
    reviewerEpoch: reviewerAccountAccessVersion,
    conclusion: input.conclusion,
    riskLevel: input.riskLevel,
    riskReasonCode: input.riskReasonCode,
    requestKey: input.requestKey,
    requestFingerprint,
    noteFingerprint,
    attestationId,
  });
  const review = await tx.mcpToolReview.create({
    data: {
      id: reviewId,
      connectionId: candidate.connection.id,
      toolDefinitionId: candidate.id,
      toolName: candidate.name,
      definitionFingerprint: candidate.definitionFingerprint,
      networkFingerprint: candidate.connection.resolvedAddressFingerprint!,
      credentialFingerprint: snapshot.credentialFingerprint,
      connectionConfigurationRevision: candidate.connection.configurationRevision,
      connectionUpdatedAt: candidate.connection.updatedAt,
      connectionOwnerAccountAccessVersion: snapshot.connectionOwnerAccountAccessVersion,
      reviewerId: actorId,
      reviewerAccountAccessVersion,
      conclusion: prismaConclusion[input.conclusion],
      riskLevel: input.riskLevel,
      riskReasonCode: prismaRiskReasonCode[input.riskReasonCode],
      evidenceNote: input.evidenceNote,
      noteFingerprint,
      requestKey: input.requestKey,
      requestFingerprint,
      attestationId,
      reviewedAt,
      createdAt: reviewedAt,
    },
    select: reviewSelect,
  });
  await tx.mcpToolReviewAudit.create({
    data: {
      id: randomUUID(),
      reviewId: review.id,
      connectionId: review.connectionId,
      toolDefinitionId: review.toolDefinitionId,
      toolName: review.toolName,
      definitionFingerprint: review.definitionFingerprint,
      networkFingerprint: review.networkFingerprint,
      credentialFingerprint: review.credentialFingerprint,
      connectionConfigurationRevision: review.connectionConfigurationRevision,
      connectionUpdatedAt: review.connectionUpdatedAt,
      connectionOwnerAccountAccessVersion: review.connectionOwnerAccountAccessVersion,
      reviewerId: review.reviewerId,
      reviewerAccountAccessVersion: review.reviewerAccountAccessVersion,
      conclusion: review.conclusion,
      riskLevel: review.riskLevel,
      riskReasonCode: review.riskReasonCode,
      evidenceNotePresent: true,
      noteFingerprint: review.noteFingerprint,
      requestKey: review.requestKey,
      requestFingerprint: review.requestFingerprint,
      attestationId: review.attestationId,
      reviewedAt: review.reviewedAt,
      createdAt: reviewedAt,
    },
  });
  return Object.freeze({ review: projectReview(review), created: true });
}

/** Create one immutable administrator review and, for a positive review, a V2 attestation in the same transaction. */
export async function createMcpToolReview(
  actorInput: AccessUser,
  inputValue: unknown,
  db: PrismaClient = getDb(),
) {
  const actorId = actorIdFromInput(actorInput);
  const reviewerAccountAccessVersion = actorEpochFromInput(actorInput);
  const input = parseReviewInput(inputValue);
  const noteFingerprint = hashText(input.evidenceNote);
  const requestFingerprint = reviewRequestFingerprint(actorId, reviewerAccountAccessVersion, input, noteFingerprint);
  try {
    return await withSerializableRetry(db, (tx) => createReviewTransaction(tx, actorId, reviewerAccountAccessVersion, input, noteFingerprint, requestFingerprint));
  } catch (error) {
    if (isPrismaCode(error, "P2002")) {
      const existing = await db.mcpToolReview.findUnique({ where: { reviewerId_requestKey: { reviewerId: actorId, requestKey: input.requestKey } }, select: reviewSelect });
      if (existing !== null) {
        if (!sameRequest(existing, requestFingerprint)) return failMcp("MCP_TOOL_REVIEW_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ review: projectReview(existing), created: false });
      }
      return failMcp("MCP_TOOL_REVIEW_ATTESTATION_CONFLICT");
    }
    if (error instanceof McpCapabilityError) throw error;
    throw error;
  }
}

/** Read the immutable review ledger without returning the stored note body. */
export async function listMcpToolReviewHistory(
  actorInput: AccessUser,
  inputValue: unknown = {},
  db: PrismaClient = getDb(),
) {
  const actorId = actorIdFromInput(actorInput);
  const reviewerAccountAccessVersion = actorEpochFromInput(actorInput);
  const parsed = reviewHistorySchema.safeParse(inputValue);
  if (!parsed.success) return failMcp("MCP_TOOL_REVIEW_INVALID_INPUT");
  return withSerializableRetry(db, async (tx) => {
    await lockActorAccess(tx, actorId);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "AppUser" WHERE "id" = ${actorId}::uuid FOR UPDATE`);
    await requireAdminActor(tx, actorId, reviewerAccountAccessVersion);
    const where = {
      ...(parsed.data.toolDefinitionId === undefined ? {} : { toolDefinitionId: parsed.data.toolDefinitionId }),
      ...(parsed.data.connectionId === undefined ? {} : { connectionId: parsed.data.connectionId }),
    } satisfies Prisma.McpToolReviewWhereInput;
    const start = (parsed.data.page - 1) * parsed.data.pageSize;
    const [total, rows] = await Promise.all([
      tx.mcpToolReview.count({ where }),
      tx.mcpToolReview.findMany({ where, skip: start, take: parsed.data.pageSize, orderBy: [{ reviewedAt: "desc" }, { id: "desc" }], select: reviewSelect }),
    ]);
    return Object.freeze({
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      total,
      reviews: rows.map(projectReview),
    });
  });
}

export type McpToolReviewInput = ReviewInput;
export type McpToolReviewHistoryInput = ReviewHistoryInput;
