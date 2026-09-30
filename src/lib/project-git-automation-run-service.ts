import {
  Prisma,
  type PrismaClient,
  type ProjectGitRepositoryAutomationRunStatus,
} from "@prisma/client";
import { z } from "zod";
import {
  assertGitAutomationWorkerSession,
  isGitAutomationWorkerDatabase,
} from "@/lib/db";
import { GIT_REPOSITORY_SCAN_POLICY } from "@/lib/git/scan-policy";
import { isSerializationConflict } from "@/lib/project-snapshot-errors";

const DUE_CANDIDATE_BATCH_SIZE = 50;
const EXPIRED_LEASE_BATCH_SIZE = 50;
const uuidSchema = z.string().uuid();
const workerIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const runStatusSchema = z.enum(["pending", "dispatched", "succeeded", "unchanged", "failed", "unknown"]);
const automationResultStatusSchema = z.enum(["succeeded", "unchanged", "failed", "unknown"]);
const automationFileSchema = z.object({
  path: z.string().min(1).max(1024),
  blobOid: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
  body: z.string(),
}).strict();
const claimSchema = z.object({
  id: uuidSchema,
  grantId: uuidSchema,
  workerId: workerIdSchema,
  leaseToken: uuidSchema,
  scheduledFor: z.string().datetime({ offset: true }),
  leaseExpiresAt: z.string().datetime({ offset: true }),
  grantVersion: z.number().int().positive(),
  grantFingerprint: z.string().length(64),
  baseDelegationId: uuidSchema,
  baseDelegationVersion: z.number().int().positive(),
  baseDelegationFingerprint: z.string().length(64),
  scope: z.object({
    repositoryPath: z.string(),
    trackedRef: z.string(),
    includeRoots: z.array(z.unknown()),
    softExcludePatterns: z.array(z.unknown()),
  }),
});

export type ProjectGitAutomationRunServiceErrorCode =
  | "PROJECT_GIT_AUTOMATION_RUN_INVALID_INPUT"
  | "PROJECT_GIT_AUTOMATION_RUN_CONFLICT"
  | "PROJECT_GIT_AUTOMATION_RESULT_INVALID_INPUT"
  | "PROJECT_GIT_AUTOMATION_WORKER_DATABASE_REQUIRED"
  | "PROJECT_GIT_AUTOMATION_WORKER_SESSION_INVALID";

export class ProjectGitAutomationRunServiceError extends Error {
  constructor(readonly code: ProjectGitAutomationRunServiceErrorCode) {
    super(code);
    this.name = "ProjectGitAutomationRunServiceError";
  }
}

type LedgerDb = PrismaClient;
type LedgerTx = Prisma.TransactionClient;

export type ProjectGitAutomationRunClaim = Readonly<{
  id: string;
  grantId: string;
  workerId: string;
  leaseToken: string;
  scheduledFor: string;
  leaseExpiresAt: string;
  grantVersion: number;
  grantFingerprint: string;
  baseDelegationId: string;
  baseDelegationVersion: number;
  baseDelegationFingerprint: string;
  scope: Readonly<{
    repositoryPath: string;
    trackedRef: string;
    includeRoots: readonly Prisma.JsonValue[];
    softExcludePatterns: readonly Prisma.JsonValue[];
  }>;
}>;

export type ProjectGitAutomationLeaseMutationResult = Readonly<{
  accepted: boolean;
  status: ProjectGitRepositoryAutomationRunStatus;
  claim?: ProjectGitAutomationRunClaim;
  leaseExpiresAt?: string;
}>;

function fail(code: ProjectGitAutomationRunServiceErrorCode): never {
  throw new ProjectGitAutomationRunServiceError(code);
}

function parseUuid(value: unknown): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) return fail("PROJECT_GIT_AUTOMATION_RUN_INVALID_INPUT");
  return parsed.data.toLowerCase();
}

function parseWorkerId(value: unknown): string {
  const parsed = workerIdSchema.safeParse(value);
  if (!parsed.success) return fail("PROJECT_GIT_AUTOMATION_RUN_INVALID_INPUT");
  return parsed.data;
}

async function assertWorkerDatabase(db: LedgerDb): Promise<void> {
  if (!isGitAutomationWorkerDatabase(db)) return fail("PROJECT_GIT_AUTOMATION_WORKER_DATABASE_REQUIRED");
  try {
    await assertGitAutomationWorkerSession(db);
  } catch {
    return fail("PROJECT_GIT_AUTOMATION_WORKER_SESSION_INVALID");
  }
}

function parseClaim(value: unknown): ProjectGitAutomationRunClaim {
  const parsed = claimSchema.safeParse(value);
  if (!parsed.success) return fail("PROJECT_GIT_AUTOMATION_RUN_CONFLICT");
  return Object.freeze({
    ...parsed.data,
    scope: Object.freeze({
      ...parsed.data.scope,
      includeRoots: parsed.data.scope.includeRoots as Prisma.JsonValue[],
      softExcludePatterns: parsed.data.scope.softExcludePatterns as Prisma.JsonValue[],
    }),
  });
}

function parseMutation(value: unknown): ProjectGitAutomationLeaseMutationResult | null {
  if (value === null) return null;
  const parsed = z.object({
    accepted: z.boolean(),
    status: runStatusSchema,
    claim: z.unknown().optional(),
    leaseExpiresAt: z.string().datetime({ offset: true }).optional(),
  }).safeParse(value);
  if (!parsed.success) return fail("PROJECT_GIT_AUTOMATION_RUN_CONFLICT");
  return Object.freeze({
    accepted: parsed.data.accepted,
    status: parsed.data.status,
    ...(parsed.data.claim === undefined ? {} : { claim: parseClaim(parsed.data.claim) }),
    ...(parsed.data.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: parsed.data.leaseExpiresAt }),
  });
}

async function serializable<T>(db: LedgerDb, operation: (tx: LedgerTx) => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await db.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!isSerializationConflict(error)) throw error;
      if (attempt === 3) return fail("PROJECT_GIT_AUTOMATION_RUN_CONFLICT");
    }
  }
  return fail("PROJECT_GIT_AUTOMATION_RUN_CONFLICT");
}

async function dueCandidates(db: LedgerDb): Promise<readonly string[]> {
  const rows = await db.$queryRaw<Array<{ grantId: string }>>(Prisma.sql`
    SELECT grant_row."id"::text AS "grantId"
      FROM public."ProjectGitRepositoryAutomationGrant" grant_row
      LEFT JOIN public."ProjectGitRepositoryAutomationScheduleCursor" cursor_row
        ON cursor_row."grantId" = grant_row."id"
     WHERE grant_row."status" = 'active'
       AND (
         (cursor_row."grantId" IS NULL AND (
           grant_row."expiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
           OR grant_row."activatedAt" + grant_row."runIntervalMinutes" * interval '1 minute'
                <= (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
         ))
         OR (cursor_row."status" = 'active' AND (
           grant_row."expiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
           OR cursor_row."nextRunAt" <= (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
         ))
       )
     ORDER BY COALESCE(cursor_row."nextRunAt", grant_row."activatedAt" + grant_row."runIntervalMinutes" * interval '1 minute'), grant_row."id"
     LIMIT ${DUE_CANDIDATE_BATCH_SIZE}
  `);
  return rows.map((row) => row.grantId);
}

async function expiredLeaseCandidates(db: LedgerDb): Promise<readonly string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"::text AS "id"
      FROM public."ProjectGitRepositoryAutomationRun"
     WHERE "status" IN ('pending', 'dispatched')
       AND "leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
     ORDER BY "leaseExpiresAt", "id"
     LIMIT ${EXPIRED_LEASE_BATCH_SIZE}
  `);
  return rows.map((row) => row.id);
}

async function reconcileExpiredLeases(db: LedgerDb): Promise<void> {
  const runIds = await expiredLeaseCandidates(db);
  for (const runId of runIds) {
    await serializable(db, async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT public."project_git_automation_reconcile_expired"(${runId}::uuid) AS "reconciled"
      `);
    });
  }
}

async function claimForGrant(db: LedgerDb, grantId: string, workerId: string): Promise<ProjectGitAutomationRunClaim | null> {
  return serializable(db, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ claim: unknown }>>(Prisma.sql`
      SELECT public."project_git_automation_claim_due"(${grantId}::uuid, ${workerId}::varchar) AS "claim"
    `);
    const claim = rows[0]?.claim ?? null;
    return claim === null ? null : parseClaim(claim);
  });
}

/**
 * Claim one due interval through the database transition API. The ledger stays
 * inert: this function performs no network, credential, repository, or publish work.
 */
export async function claimNextProjectGitAutomationRun(
  workerIdInput: unknown,
  db: LedgerDb,
): Promise<ProjectGitAutomationRunClaim | null> {
  const workerId = parseWorkerId(workerIdInput);
  await assertWorkerDatabase(db);
  await reconcileExpiredLeases(db);
  for (const grantId of await dueCandidates(db)) {
    const claim = await claimForGrant(db, grantId, workerId);
    if (claim !== null) return claim;
  }
  return null;
}

async function mutateLease(
  runIdInput: unknown,
  workerIdInput: unknown,
  leaseTokenInput: unknown,
  operation: "heartbeat" | "dispatch",
  db: LedgerDb,
): Promise<ProjectGitAutomationLeaseMutationResult | null> {
  const runId = parseUuid(runIdInput);
  const workerId = parseWorkerId(workerIdInput);
  const leaseToken = parseUuid(leaseTokenInput);
  await assertWorkerDatabase(db);
  return serializable(db, async (tx) => {
    const rows = await tx.$queryRaw<Array<{ result: unknown }>>(Prisma.sql`
      SELECT public."project_git_automation_mutate_lease"(
        ${runId}::uuid, ${workerId}::varchar, ${leaseToken}::uuid, ${operation}::varchar
      ) AS "result"
    `);
    return parseMutation(rows[0]?.result ?? null);
  });
}

/** One-way pending -> dispatched lease fence; performs no I/O. */
export async function markProjectGitAutomationRunDispatched(
  runId: unknown,
  workerId: unknown,
  leaseToken: unknown,
  db: LedgerDb,
): Promise<ProjectGitAutomationLeaseMutationResult | null> {
  return mutateLease(runId, workerId, leaseToken, "dispatch", db);
}

/** Extend a live lease with a compare-and-set after DB eligibility rechecks. */
export async function heartbeatProjectGitAutomationRun(
  runId: unknown,
  workerId: unknown,
  leaseToken: unknown,
  db: LedgerDb,
): Promise<ProjectGitAutomationLeaseMutationResult | null> {
  return mutateLease(runId, workerId, leaseToken, "heartbeat", db);
}

export type ProjectGitAutomationPublicationResult = Readonly<{
  accepted: boolean;
  status: z.infer<typeof automationResultStatusSchema>;
  reason?: string;
  publicationVersionId?: string;
  publicationGeneration?: number;
  manifestFingerprint?: string;
  fileCount?: number;
  decodedTextBytes?: number;
}>;

function parseAutomationFiles(value: unknown): readonly z.infer<typeof automationFileSchema>[] {
  const parsed = z.array(automationFileSchema).max(GIT_REPOSITORY_SCAN_POLICY.maxScannedFiles).safeParse(value);
  if (!parsed.success) return fail("PROJECT_GIT_AUTOMATION_RESULT_INVALID_INPUT");
  const paths = new Set<string>();
  let totalBodyBytes = 0;
  for (const file of parsed.data) {
    const pathBytes = Buffer.byteLength(file.path, "utf8");
    const bodyBytes = Buffer.byteLength(file.body, "utf8");
    const pathSegments = file.path.split("/");
    if (pathBytes > 1024 || file.path !== file.path.normalize("NFC")
      || file.path.startsWith("/") || file.path.endsWith("/") || file.path.includes("//")
      || file.path.includes("\\") || /[\u0000-\u001f\u007f-\u009f]/u.test(file.path)
      || pathSegments.some((segment) => segment === "" || segment === "." || segment === "..")
      || bodyBytes > GIT_REPOSITORY_SCAN_POLICY.maxFileBytes
      || file.body.includes("\u0000") || file.body.includes("\r")
      || paths.has(file.path)) {
      return fail("PROJECT_GIT_AUTOMATION_RESULT_INVALID_INPUT");
    }
    totalBodyBytes += bodyBytes;
    if (totalBodyBytes > GIT_REPOSITORY_SCAN_POLICY.maxTotalBytes) {
      return fail("PROJECT_GIT_AUTOMATION_RESULT_INVALID_INPUT");
    }
    paths.add(file.path);
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(parsed.data), "utf8");
  if (serializedBytes > 80 * 1024 * 1024) return fail("PROJECT_GIT_AUTOMATION_RESULT_INVALID_INPUT");
  return Object.freeze(parsed.data.map((file) => Object.freeze(file)));
}

function parsePublicationResult(value: unknown): ProjectGitAutomationPublicationResult {
  const parsed = z.object({
    accepted: z.boolean(),
    status: automationResultStatusSchema,
    reason: z.string().optional(),
    publicationVersionId: uuidSchema.optional(),
    publicationGeneration: z.number().int().positive().optional(),
    manifestFingerprint: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
    fileCount: z.number().int().nonnegative().optional(),
    decodedTextBytes: z.number().int().nonnegative().optional(),
  }).strict().safeParse(value);
  if (!parsed.success) return fail("PROJECT_GIT_AUTOMATION_RUN_CONFLICT");
  return Object.freeze(parsed.data);
}

/**
 * Finalize an already dispatched synthetic/read result through the migrator-
 * owned atomic publisher. This boundary performs no Git or network I/O and
 * accepts file bytes, never caller-selected ProjectSource identifiers.
 */
export async function finalizeProjectGitAutomationRunResult(
  input: Readonly<{
    runId: unknown;
    workerId: unknown;
    leaseToken: unknown;
    commitSha: unknown;
    outcome: unknown;
    files: unknown;
  }>,
  db: LedgerDb,
): Promise<ProjectGitAutomationPublicationResult> {
  const runId = parseUuid(input.runId);
  const workerId = parseWorkerId(input.workerId);
  const leaseToken = parseUuid(input.leaseToken);
  const commitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u).safeParse(input.commitSha);
  const outcome = z.enum(["changed", "unchanged"]).safeParse(input.outcome);
  if (!commitSha.success || !outcome.success) return fail("PROJECT_GIT_AUTOMATION_RESULT_INVALID_INPUT");
  const files = parseAutomationFiles(input.files);
  if ((outcome.data === "unchanged" && files.length !== 0)
    || (outcome.data === "changed" && files.length === 0)) {
    return fail("PROJECT_GIT_AUTOMATION_RESULT_INVALID_INPUT");
  }
  await assertWorkerDatabase(db);
  const rows = await serializable(db, async (tx) => {
    return tx.$queryRaw<Array<{ result: unknown }>>(Prisma.sql`
      SELECT public."project_git_automation_finalize_result"(
        ${runId}::uuid, ${workerId}::varchar, ${leaseToken}::uuid,
        ${commitSha.data}::varchar, ${outcome.data}::varchar, ${JSON.stringify(files)}::jsonb
      ) AS "result"
    `);
  });
  return parsePublicationResult(rows[0]?.result ?? null);
}
