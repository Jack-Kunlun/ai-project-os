import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { assertGitAutomationWorkerSession, isGitAutomationWorkerDatabase } from "@/lib/db";
import type { ScannedGitHubMaterialSource } from "@/lib/github/material-scanner";
import { isSerializationConflict } from "@/lib/project-snapshot-errors";

const MATERIAL_KINDS = ["issue", "pull_request", "release"] as const;
const uuidSchema = z.string().uuid();
const workerIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const runStatusSchema = z.enum(["pending", "dispatched", "succeeded", "unchanged", "failed", "unknown"]);
const claimSchema = z.object({
  id: uuidSchema,
  grantId: uuidSchema,
  materialKind: z.enum(MATERIAL_KINDS),
  workerId: workerIdSchema,
  leaseToken: uuidSchema,
  scheduledFor: z.string().datetime({ offset: true }),
  leaseExpiresAt: z.string().datetime({ offset: true }),
  grantVersion: z.number().int().positive(),
  grantFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  baseDelegationId: uuidSchema,
  baseDelegationVersion: z.number().int().positive(),
  baseDelegationFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  repositoryPath: z.string().min(3).max(768),
  trackedRef: z.string().min(1).max(255),
  expectedPublicationVersionId: uuidSchema.nullable(),
  expectedPublicationGeneration: z.number().int().nonnegative(),
}).strict();
const sourceSchema = z.object({
  materialKind: z.enum(["issue", "pullRequest", "release"]),
  remoteIdentity: z.string().min(1).max(512),
  remoteRevisionFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  remoteNumber: z.number().int().positive(),
  normalizedPath: z.null(),
  externalRef: z.string().min(1).max(1024),
  capturedAt: z.string().datetime({ offset: true }),
  contentText: z.string().min(1),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
  contentBytes: z.number().int().positive(),
}).strict();

export type ProjectGitAutomationMaterialKind = typeof MATERIAL_KINDS[number];
export type ProjectGitAutomationMaterialRunClaim = Readonly<z.infer<typeof claimSchema>>;
export type ProjectGitAutomationMaterialLeaseResult = Readonly<{
  accepted: boolean;
  status: z.infer<typeof runStatusSchema>;
  leaseExpiresAt?: string;
}>;
export type ProjectGitAutomationMaterialPublicationResult = Readonly<{
  accepted: boolean;
  status: "succeeded" | "unchanged" | "failed" | "unknown";
  reason?: string;
  publicationVersionId?: string;
  publicationGeneration?: number;
  manifestFingerprint?: string;
  sourceCount?: number;
  decodedTextBytes?: number;
}>;

export type ProjectGitAutomationMaterialRunServiceErrorCode =
  | "PROJECT_GIT_MATERIAL_RUN_INVALID_INPUT"
  | "PROJECT_GIT_MATERIAL_RUN_CONFLICT"
  | "PROJECT_GIT_MATERIAL_RESULT_INVALID_INPUT"
  | "PROJECT_GIT_AUTOMATION_WORKER_DATABASE_REQUIRED"
  | "PROJECT_GIT_AUTOMATION_WORKER_SESSION_INVALID";

export class ProjectGitAutomationMaterialRunServiceError extends Error {
  constructor(readonly code: ProjectGitAutomationMaterialRunServiceErrorCode) {
    super(code);
    this.name = "ProjectGitAutomationMaterialRunServiceError";
  }
}

function fail(code: ProjectGitAutomationMaterialRunServiceErrorCode): never {
  throw new ProjectGitAutomationMaterialRunServiceError(code);
}

function parseUuid(value: unknown): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) return fail("PROJECT_GIT_MATERIAL_RUN_INVALID_INPUT");
  return parsed.data.toLowerCase();
}

function parseWorkerId(value: unknown): string {
  const parsed = workerIdSchema.safeParse(value);
  if (!parsed.success) return fail("PROJECT_GIT_MATERIAL_RUN_INVALID_INPUT");
  return parsed.data;
}

async function assertWorkerDatabase(db: PrismaClient): Promise<void> {
  if (!isGitAutomationWorkerDatabase(db)) return fail("PROJECT_GIT_AUTOMATION_WORKER_DATABASE_REQUIRED");
  try {
    await assertGitAutomationWorkerSession(db);
  } catch {
    return fail("PROJECT_GIT_AUTOMATION_WORKER_SESSION_INVALID");
  }
}

function parseClaim(value: unknown): ProjectGitAutomationMaterialRunClaim {
  const parsed = claimSchema.safeParse(value);
  if (!parsed.success) return fail("PROJECT_GIT_MATERIAL_RUN_CONFLICT");
  return Object.freeze(parsed.data);
}

function parseLeaseResult(value: unknown): ProjectGitAutomationMaterialLeaseResult | null {
  if (value === null) return null;
  const parsed = z.object({
    accepted: z.boolean(),
    status: runStatusSchema,
    leaseExpiresAt: z.string().datetime({ offset: true }).optional(),
  }).strict().safeParse(value);
  if (!parsed.success) return fail("PROJECT_GIT_MATERIAL_RUN_CONFLICT");
  return Object.freeze(parsed.data);
}

function parsePublicationResult(value: unknown): ProjectGitAutomationMaterialPublicationResult | null {
  if (value === null) return null;
  const parsed = z.object({
    accepted: z.boolean(),
    status: z.enum(["succeeded", "unchanged", "failed", "unknown"]),
    reason: z.string().max(64).optional(),
    publicationVersionId: uuidSchema.optional(),
    publicationGeneration: z.number().int().positive().optional(),
    manifestFingerprint: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
    sourceCount: z.number().int().nonnegative().optional(),
    decodedTextBytes: z.number().int().nonnegative().optional(),
  }).strict().safeParse(value);
  if (!parsed.success) return fail("PROJECT_GIT_MATERIAL_RUN_CONFLICT");
  return Object.freeze(parsed.data);
}

async function serializable<T>(db: PrismaClient, operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await db.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!isSerializationConflict(error)) throw error;
      if (attempt === 3) return fail("PROJECT_GIT_MATERIAL_RUN_CONFLICT");
    }
  }
  return fail("PROJECT_GIT_MATERIAL_RUN_CONFLICT");
}

async function materialCandidates(db: PrismaClient): Promise<readonly Readonly<{ grantId: string; materialKind: ProjectGitAutomationMaterialKind }>[]> {
  const rows = await db.$queryRaw<Array<{ grantId: string; materialKind: string }>>(Prisma.sql`
    SELECT cursor_row."grantId"::text AS "grantId", cursor_row."materialKind"::text AS "materialKind"
      FROM public."ProjectGitRepositoryMaterialCursor" cursor_row
      JOIN public."ProjectGitRepositoryAutomationGrant" grant_row ON grant_row."id" = cursor_row."grantId"
     WHERE grant_row."status" = 'active'
       AND cursor_row."status" = 'active'
       AND (cursor_row."nextRunAt" <= (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
         OR grant_row."expiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3))
     ORDER BY cursor_row."nextRunAt", cursor_row."grantId", cursor_row."materialKind"
     LIMIT 100
  `);
  return rows.map((row) => {
    if (!MATERIAL_KINDS.includes(row.materialKind as ProjectGitAutomationMaterialKind)) {
      return fail("PROJECT_GIT_MATERIAL_RUN_CONFLICT");
    }
    return Object.freeze({ grantId: row.grantId, materialKind: row.materialKind as ProjectGitAutomationMaterialKind });
  });
}

async function expiredRunCandidates(db: PrismaClient): Promise<readonly string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"::text AS "id"
      FROM public."ProjectGitRepositoryMaterialRun"
     WHERE "status" IN ('pending', 'dispatched')
       AND "leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
     ORDER BY "leaseExpiresAt", "id"
     LIMIT 50
  `);
  return rows.map((row) => row.id);
}

async function reconcileExpired(db: PrismaClient): Promise<void> {
  for (const runId of await expiredRunCandidates(db)) {
    await serializable(db, async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT public."project_git_material_reconcile_expired"(${parseUuid(runId)}::uuid) AS "reconciled"
      `);
    });
  }
}

async function claimForMaterial(
  db: PrismaClient,
  grantId: string,
  materialKind: ProjectGitAutomationMaterialKind,
  workerId: string,
): Promise<ProjectGitAutomationMaterialRunClaim | null> {
  return serializable(db, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ claim: unknown }>>(Prisma.sql`
      SELECT public."project_git_material_claim_due"(
        ${grantId}::uuid, ${materialKind}::public."ProjectGitRepositoryMaterialKind", ${workerId}::varchar
      ) AS "claim"
    `);
    const claim = rows[0]?.claim ?? null;
    return claim === null ? null : parseClaim(claim);
  });
}

/** Claim one consented material class. The code-run ledger and publication head are never touched. */
export async function claimNextProjectGitAutomationMaterialRun(
  workerIdInput: unknown,
  db: PrismaClient,
): Promise<ProjectGitAutomationMaterialRunClaim | null> {
  const workerId = parseWorkerId(workerIdInput);
  await assertWorkerDatabase(db);
  await reconcileExpired(db);
  for (const candidate of await materialCandidates(db)) {
    const claim = await claimForMaterial(db, candidate.grantId, candidate.materialKind, workerId);
    if (claim !== null) return claim;
  }
  return null;
}

async function mutateLease(
  runIdInput: unknown,
  workerIdInput: unknown,
  leaseTokenInput: unknown,
  operation: "heartbeat" | "dispatch",
  db: PrismaClient,
): Promise<ProjectGitAutomationMaterialLeaseResult | null> {
  const runId = parseUuid(runIdInput);
  const workerId = parseWorkerId(workerIdInput);
  const leaseToken = parseUuid(leaseTokenInput);
  await assertWorkerDatabase(db);
  return serializable(db, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ result: unknown }>>(Prisma.sql`
      SELECT public."project_git_material_mutate_lease"(
        ${runId}::uuid, ${workerId}::varchar, ${leaseToken}::uuid, ${operation}::varchar
      ) AS "result"
    `);
    return parseLeaseResult(rows[0]?.result ?? null);
  });
}

export async function markProjectGitAutomationMaterialRunDispatched(
  runId: unknown, workerId: unknown, leaseToken: unknown, db: PrismaClient,
): Promise<ProjectGitAutomationMaterialLeaseResult | null> {
  return mutateLease(runId, workerId, leaseToken, "dispatch", db);
}

export async function heartbeatProjectGitAutomationMaterialRun(
  runId: unknown, workerId: unknown, leaseToken: unknown, db: PrismaClient,
): Promise<ProjectGitAutomationMaterialLeaseResult | null> {
  return mutateLease(runId, workerId, leaseToken, "heartbeat", db);
}

export async function finalizeProjectGitAutomationMaterialRun(
  input: Readonly<{
    runId: unknown;
    workerId: unknown;
    leaseToken: unknown;
    repositoryId: unknown;
    repositoryNodeId: unknown;
    observedHeadCommitSha: unknown;
    sources: unknown;
  }>,
  db: PrismaClient,
): Promise<ProjectGitAutomationMaterialPublicationResult | null> {
  const runId = parseUuid(input.runId);
  const workerId = parseWorkerId(input.workerId);
  const leaseToken = parseUuid(input.leaseToken);
  const repositoryId = z.number().int().positive().safe().safeParse(input.repositoryId);
  const repositoryNodeId = z.string().min(1).max(512).safeParse(input.repositoryNodeId);
  const observedHeadCommitSha = z.string().regex(/^[0-9a-f]{40}$/u).safeParse(input.observedHeadCommitSha);
  const sources = z.array(sourceSchema).max(20_000).safeParse(input.sources);
  if (!repositoryId.success || !repositoryNodeId.success || !observedHeadCommitSha.success || !sources.success) {
    return fail("PROJECT_GIT_MATERIAL_RESULT_INVALID_INPUT");
  }
  const totalSourceBytes = sources.data.reduce((sum, source) => sum + Buffer.byteLength(source.contentText, "utf8"), 0);
  if (totalSourceBytes > 32 * 1024 * 1024 || sources.data.some((source) => {
    if (Buffer.byteLength(source.contentText, "utf8") !== source.contentBytes) return true;
    return createHashSha256(source.contentText) !== source.contentHash;
  })) return fail("PROJECT_GIT_MATERIAL_RESULT_INVALID_INPUT");

  await assertWorkerDatabase(db);
  return serializable(db, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ result: unknown }>>(Prisma.sql`
      SELECT public."project_git_material_finalize_result"(
        ${runId}::uuid, ${workerId}::varchar, ${leaseToken}::uuid, ${repositoryId.data}::bigint,
        ${repositoryNodeId.data}::varchar, ${observedHeadCommitSha.data}::varchar,
        ${JSON.stringify(sources.data)}::jsonb
      ) AS "result"
    `);
    return parsePublicationResult(rows[0]?.result ?? null);
  });
}

function createHashSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function materialKindForScanner(kind: ProjectGitAutomationMaterialKind): "issue" | "pullRequest" | "release" {
  return kind === "pull_request" ? "pullRequest" : kind;
}

export function materialKindForDatabase(kind: "issue" | "pullRequest" | "release"): ProjectGitAutomationMaterialKind {
  return kind === "pullRequest" ? "pull_request" : kind;
}

export function validateMaterialSourcesForClaim(
  claim: ProjectGitAutomationMaterialRunClaim,
  sources: readonly ScannedGitHubMaterialSource[],
): void {
  const expectedKind = materialKindForScanner(claim.materialKind);
  if (sources.some((source) => source.materialKind !== expectedKind)) {
    fail("PROJECT_GIT_MATERIAL_RESULT_INVALID_INPUT");
  }
}
