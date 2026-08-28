import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  Prisma,
  type BackgroundJobKind,
  type PrismaClient,
} from "@prisma/client";
import { z } from "zod";
import { getDb } from "@/lib/db";

const JOB_LOCK_NAMESPACE = 23082026;
// The current monolith executes a job in one request. Keep enough headroom for
// a bounded GitHub scan or several model calls; explicit reconciliation remains
// available once this lease expires.
export const DEFAULT_JOB_LEASE_MS = 30 * 60_000;
export const DEFAULT_JOB_HEARTBEAT_INTERVAL_MS = 15_000;
const stageSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/);

export type ProjectWorkflowErrorCode =
  | "PROJECT_WORKFLOW_INVALID_INPUT"
  | "PROJECT_WORKFLOW_JOB_NOT_FOUND"
  | "PROJECT_WORKFLOW_PROJECT_MISMATCH"
  | "PROJECT_WORKFLOW_INVALID_STATE"
  | "PROJECT_WORKFLOW_CLAIM_CONFLICT"
  | "PROJECT_WORKFLOW_ATTEMPT_NOT_FOUND"
  | "PROJECT_WORKFLOW_STALE_ATTEMPT"
  | "PROJECT_WORKFLOW_LEASE_EXPIRED"
  | "PROJECT_WORKFLOW_RECONCILIATION_NOT_DUE"
  | "PROJECT_WORKFLOW_CANCEL_NOT_ALLOWED"
  | "PROJECT_WORKFLOW_RETRY_NOT_SUPPORTED";

export class ProjectWorkflowError extends Error {
  constructor(readonly code: ProjectWorkflowErrorCode) {
    super(code);
    this.name = "ProjectWorkflowError";
  }
}

/** The raw token is deliberately only returned to the in-process executor. */
export type JobAttemptClaim = Readonly<{
  attemptId: string;
  claimToken: string;
}>;

export type PublicJobAttempt = Readonly<{
  id: string;
  attemptNumber: number;
  status: "running" | "succeeded" | "failed" | "unknown" | "cancelled";
  leasedAt: Date;
  leaseExpiresAt: Date;
  heartbeatAt: Date;
  dispatchState: "pending" | "dispatched" | "acknowledged";
  safeFailureCode: string | null;
  completedAt: Date | null;
}>;

export type PublicProjectJob = Readonly<{
  id: string;
  projectId: string | null;
  kind: BackgroundJobKind;
  status: "queued" | "waitingConsent" | "running" | "succeeded" | "failed" | "unknown" | "cancelled";
  stage: string;
  result: unknown;
  progressCurrent: number;
  progressTotal: number;
  failureCode: string | null;
  reconciliationRequired: boolean;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  attempts: readonly PublicJobAttempt[];
}>;

type WorkflowDb = PrismaClient | Prisma.TransactionClient;

function fail(code: ProjectWorkflowErrorCode): never {
  throw new ProjectWorkflowError(code);
}

function hashLeaseToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function matchesLeaseToken(expectedHash: string, token: string): boolean {
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(hashLeaseToken(token), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function safeFailureCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{3,64}$/.test(code)) return code;
  }
  if (error instanceof Error && /^[A-Z0-9_]{3,64}$/.test(error.message)) return error.message;
  return "PROJECT_WORKFLOW_FAILED";
}

function safeNullableFailureCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z0-9_]{3,64}$/.test(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeResultString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

function safeResultInteger(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function safeResultNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeResultHash(value: unknown, length: 40 | 64): string | null {
  return typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value) ? value : null;
}

function safeResultDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeResultEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : null;
}

function serializeSimpleResult(value: Record<string, unknown>, keys: Readonly<Record<string, "string" | "integer" | "hash" | "uuid">>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, type] of Object.entries(keys)) {
    const candidate = value[key];
    const normalized = type === "string"
      ? safeResultString(candidate, 50_000)
      : type === "integer"
        ? safeResultInteger(candidate)
        : type === "hash"
          ? safeResultHash(candidate, 64)
          : safeResultString(candidate, 128);
    if (normalized !== null) output[key] = normalized;
  }
  return output;
}

function serializeSearchResult(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const id = safeResultString(value.id, 128);
  const scope = safeResultEnum(value.scope, ["projectSource", "repositoryCode", "repositoryMaterial"] as const);
  const contentText = safeResultString(value.contentText, 50_000);
  const contentHash = safeResultHash(value.contentHash, 64);
  const semanticScore = safeResultNumber(value.semanticScore);
  const lexicalScore = safeResultNumber(value.lexicalScore);
  const score = safeResultNumber(value.score);
  if (id === null || scope === null || contentText === null || contentHash === null || semanticScore === null || lexicalScore === null || score === null) return null;
  return {
    id,
    scope,
    projectSourceId: safeResultString(value.projectSourceId, 128),
    projectRepositoryLinkId: safeResultString(value.projectRepositoryLinkId, 128),
    frozenCommitSha: safeResultHash(value.frozenCommitSha, 40),
    path: safeResultString(value.path, 2_048),
    externalRef: safeResultString(value.externalRef, 4_096),
    rangeStart: safeResultInteger(value.rangeStart),
    rangeEnd: safeResultInteger(value.rangeEnd),
    contentText,
    contentHash,
    semanticScore,
    lexicalScore,
    score,
  };
}

function serializeCodeScanResult(value: Record<string, unknown>): Record<string, unknown> {
  const runs = Array.isArray(value.runs)
    ? value.runs.map((run) => {
        if (!isRecord(run)) return null;
        return {
          id: safeResultString(run.id, 128),
          projectRepositoryLinkId: safeResultString(run.projectRepositoryLinkId, 128),
          requiredForProjectSnapshot: run.requiredForProjectSnapshot === true,
          status: safeResultEnum(run.status, ["queued", "running", "succeeded", "failed", "rateLimited", "unknown", "cancelled"] as const),
          stage: safeResultEnum(run.stage, ["queued", "discovering", "fetching", "scanning", "publishing", "terminal"] as const),
          frozenCommitSha: safeResultHash(run.frozenCommitSha, 40),
          rootTreeSha: safeResultHash(run.rootTreeSha, 40),
          requestCount: safeResultInteger(run.requestCount),
          visitedTreeEntryCount: safeResultInteger(run.visitedTreeEntryCount),
          discoveredFileCount: safeResultInteger(run.discoveredFileCount),
          decodedTextBytes: safeResultInteger(run.decodedTextBytes),
          failureCode: safeResultString(run.failureCode, 128),
          retryAt: safeResultDate(run.retryAt),
        };
      }).filter((run) => run !== null).slice(0, 2_000)
    : [];
  const status = safeResultEnum(value.status, ["queued", "running", "succeeded", "partial", "partialOptional", "failed", "unknown", "cancelled"] as const);
  const output: Record<string, unknown> = {
    id: safeResultString(value.id, 128),
    projectId: safeResultString(value.projectId, 128),
    status,
    requiredManifestFingerprint: safeResultHash(value.requiredManifestFingerprint, 64),
    expectedRequiredLinkCount: safeResultInteger(value.expectedRequiredLinkCount),
    expectedOptionalLinkCount: safeResultInteger(value.expectedOptionalLinkCount),
    completedRequiredLinkCount: safeResultInteger(value.completedRequiredLinkCount),
    completedOptionalLinkCount: safeResultInteger(value.completedOptionalLinkCount),
    failureCode: safeResultString(value.failureCode, 128),
    startedAt: safeResultDate(value.startedAt),
    completedAt: safeResultDate(value.completedAt),
    projectCodeSnapshotId: safeResultString(value.projectCodeSnapshotId, 128),
    runs,
  };
  if (status === "partialOptional") output.warning = "OPTIONAL_REPOSITORY_INCOMPLETE";
  return output;
}

function serializeMaterialSyncResult(value: Record<string, unknown>): Record<string, unknown> {
  return {
    id: safeResultString(value.id, 128),
    projectId: safeResultString(value.projectId, 128),
    projectRepositoryLinkId: safeResultString(value.projectRepositoryLinkId, 128),
    linkConfigVersion: safeResultInteger(value.linkConfigVersion),
    expectedEffectivePolicyVersion: safeResultInteger(value.expectedEffectivePolicyVersion),
    expectedActiveMaterialGenerationId: safeResultString(value.expectedActiveMaterialGenerationId, 128),
    status: safeResultEnum(value.status, ["queued", "running", "succeeded", "partial", "failed", "rateLimited", "unknown", "cancelled"] as const),
    stage: safeResultEnum(value.stage, ["queued", "freezing", "fetching", "scanning", "publishing", "terminal"] as const),
    observedHeadCommitSha: safeResultHash(value.observedHeadCommitSha, 40),
    requestCount: safeResultInteger(value.requestCount),
    fetchedObjectCount: safeResultInteger(value.fetchedObjectCount),
    publishedSourceCount: safeResultInteger(value.publishedSourceCount),
    quarantineCount: safeResultInteger(value.quarantineCount),
    failureCode: safeResultString(value.failureCode, 128),
    retryAt: safeResultDate(value.retryAt),
    startedAt: safeResultDate(value.startedAt),
    completedAt: safeResultDate(value.completedAt),
    repositoryMaterialGenerationId: safeResultString(value.repositoryMaterialGenerationId, 128),
    activeMaterialGenerationId: safeResultString(value.activeMaterialGenerationId, 128),
  };
}

export function serializeProjectJobResult(kind: BackgroundJobKind, value: unknown): unknown {
  if (value === null || value === undefined || !isRecord(value)) return null;
  if (kind === "githubScan") return Object.freeze(serializeCodeScanResult(value));
  if (kind === "githubMaterialSync") return Object.freeze(serializeMaterialSyncResult(value));
  if (kind === "semanticSearch") {
    const results = Array.isArray(value.results)
      ? value.results.map(serializeSearchResult).filter((result): result is Record<string, unknown> => result !== null).slice(0, 10)
      : [];
    return Object.freeze({
      question: safeResultString(value.question, 2_000),
      indexGenerationId: safeResultString(value.indexGenerationId, 128),
      results,
    });
  }
  if (kind === "memoryIndex") {
    return Object.freeze(serializeSimpleResult(value, {
      indexGenerationId: "uuid",
      recordCount: "integer",
      dimensions: "integer",
      manifest: "hash",
    }));
  }
  if (kind === "autoExtract") {
    return Object.freeze(serializeSimpleResult(value, {
      sourceCount: "integer",
      candidateCount: "integer",
      duplicateCount: "integer",
      manifest: "hash",
    }));
  }
  if (kind === "ragAnswer") return Object.freeze(serializeSimpleResult(value, { answerId: "uuid" }));
  if (kind === "projectBrief") return Object.freeze(serializeSimpleResult(value, { reportId: "uuid" }));
  if (kind === "projectAgent") return Object.freeze(serializeSimpleResult(value, { agentRunId: "uuid" }));
  return null;
}

export function isLeaseExpired(leaseExpiresAt: Date | string, now = new Date()): boolean {
  return new Date(leaseExpiresAt).getTime() <= now.getTime();
}

export function isUncertainProviderDispatch(error: unknown): boolean {
  const code = safeFailureCode(error);
  return code === "AI_PROVIDER_TIMEOUT" || code === "AI_PROVIDER_UNAVAILABLE" ||
    code === "GITHUB_REQUEST_TIMEOUT" || code === "GITHUB_REQUEST_FAILED";
}

export function classifyProviderDispatchFailure(error: unknown): "unknown" | "failed" {
  return isUncertainProviderDispatch(error) ? "unknown" : "failed";
}

async function withJobLock<T>(db: WorkflowDb, jobId: string, operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if (!("$transaction" in db)) {
    return operation(db);
  }
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${jobId}, ${JOB_LOCK_NAMESPACE}))`;
    return operation(tx);
  // The advisory lock serializes all state transitions for one job. Read
  // Committed lets the waiter observe the lock holder's committed status
  // instead of retaining a stale Serializable snapshot after the wait.
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

async function findJobForAttempt(tx: Prisma.TransactionClient, jobId: string) {
  return tx.backgroundJob.findUnique({
    where: { id: jobId },
    select: { id: true, kind: true, status: true, stage: true },
  });
}

async function verifyAttempt(
  tx: Prisma.TransactionClient,
  input: Readonly<{ jobId: string; attemptId: string; claimToken: string }>,
  options: Readonly<{ allowExpired?: boolean }> = {},
) {
  const attempt = await tx.backgroundJobAttempt.findUnique({
    where: { id: input.attemptId },
    select: {
      id: true,
      jobId: true,
      attemptNumber: true,
      status: true,
      leaseTokenHash: true,
      leaseExpiresAt: true,
      heartbeatAt: true,
    },
  });
  if (attempt === null || attempt.jobId !== input.jobId) return fail("PROJECT_WORKFLOW_ATTEMPT_NOT_FOUND");
  if (!matchesLeaseToken(attempt.leaseTokenHash, input.claimToken)) return fail("PROJECT_WORKFLOW_STALE_ATTEMPT");
  const job = await findJobForAttempt(tx, input.jobId);
  if (job === null) return fail("PROJECT_WORKFLOW_JOB_NOT_FOUND");
  const latest = await tx.backgroundJobAttempt.findFirst({
    where: { jobId: input.jobId },
    orderBy: { attemptNumber: "desc" },
    select: { id: true },
  });
  if (latest?.id !== attempt.id) return fail("PROJECT_WORKFLOW_STALE_ATTEMPT");
  if (attempt.status !== "running" || job.status !== "running") return fail("PROJECT_WORKFLOW_STALE_ATTEMPT");
  if (!options.allowExpired && isLeaseExpired(attempt.leaseExpiresAt)) return fail("PROJECT_WORKFLOW_LEASE_EXPIRED");
  return Object.freeze({ attempt, job });
}

export async function claimProjectJob(
  jobId: string,
  db: WorkflowDb = getDb(),
  expectedKind?: BackgroundJobKind,
): Promise<JobAttemptClaim | false> {
  if (!z.string().uuid().safeParse(jobId).success) return fail("PROJECT_WORKFLOW_INVALID_INPUT");
  return withJobLock(db, jobId, async (tx) => {
    const job = await tx.backgroundJob.findUnique({
      where: { id: jobId },
      select: { id: true, kind: true, status: true, startedAt: true },
    });
    if (job === null) return fail("PROJECT_WORKFLOW_JOB_NOT_FOUND");
    if (expectedKind !== undefined && job.kind !== expectedKind) return fail("PROJECT_WORKFLOW_INVALID_STATE");
    if (job.status !== "queued") return false;

    const latest = await tx.backgroundJobAttempt.findFirst({
      where: { jobId },
      orderBy: { attemptNumber: "desc" },
      select: { attemptNumber: true },
    });
    const now = new Date();
    const claimToken = randomBytes(32).toString("base64url");
    const attempt = await tx.backgroundJobAttempt.create({
      data: {
        jobId,
        attemptNumber: (latest?.attemptNumber ?? 0) + 1,
        leaseTokenHash: hashLeaseToken(claimToken),
        leasedAt: now,
        leaseExpiresAt: new Date(now.getTime() + DEFAULT_JOB_LEASE_MS),
        heartbeatAt: now,
      },
      select: { id: true },
    });
    await tx.backgroundJob.update({
      where: { id: jobId },
      data: {
        status: "running",
        stage: "preparing",
        startedAt: job.startedAt ?? now,
        reconciliationRequired: false,
      },
    });
    return Object.freeze({ attemptId: attempt.id, claimToken });
  });
}

export async function heartbeatProjectJob(
  input: Readonly<{ jobId: string; attemptId: string; claimToken: string }>,
  db: WorkflowDb = getDb(),
): Promise<boolean> {
  return withJobLock(db, input.jobId, async (tx) => {
    await verifyAttempt(tx, input);
    const now = new Date();
    const updated = await tx.backgroundJobAttempt.updateMany({
      where: { id: input.attemptId, jobId: input.jobId, status: "running" },
      data: { heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + DEFAULT_JOB_LEASE_MS) },
    });
    if (updated.count !== 1) return fail("PROJECT_WORKFLOW_STALE_ATTEMPT");
    return true;
  });
}

export type ProjectJobHeartbeat = Readonly<{
  stop: () => Promise<void>;
  readonly failure: unknown | null;
}>;

export function startProjectJobHeartbeat(
  input: Readonly<{ jobId: string; attemptId: string; claimToken: string }>,
  db: WorkflowDb = getDb(),
  options: Readonly<{
    intervalMs?: number;
    heartbeat?: (input: Readonly<{ jobId: string; attemptId: string; claimToken: string }>, db: WorkflowDb) => Promise<boolean>;
  }> = {},
): ProjectJobHeartbeat {
  const intervalMs = options.intervalMs ?? DEFAULT_JOB_HEARTBEAT_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs >= DEFAULT_JOB_LEASE_MS) {
    return fail("PROJECT_WORKFLOW_INVALID_INPUT");
  }
  const sendHeartbeat = options.heartbeat ?? heartbeatProjectJob;
  let active = true;
  let inFlight: Promise<void> | null = null;
  let failure: unknown | null = null;
  const tick = () => {
    if (!active || inFlight !== null) return;
    inFlight = Promise.resolve()
      .then(() => sendHeartbeat(input, db))
      .then(() => undefined)
      .catch((error: unknown) => {
        failure = error;
        active = false;
        clearInterval(timer);
      })
      .finally(() => {
        inFlight = null;
      });
  };
  const timer: ReturnType<typeof setInterval> = setInterval(tick, intervalMs);
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
  return Object.freeze({
    stop: async () => {
      if (!active) {
        if (inFlight !== null) await inFlight;
        return;
      }
      active = false;
      clearInterval(timer);
      if (inFlight !== null) await inFlight;
    },
    get failure() {
      return failure;
    },
  });
}

export async function updateProjectJobProgress(
  input: Readonly<{ jobId: string; attemptId: string; claimToken: string; stage: string; current: number; total: number }>,
  db: WorkflowDb = getDb(),
): Promise<boolean> {
  const stage = stageSchema.parse(input.stage);
  if (!Number.isSafeInteger(input.current) || input.current < 0 || !Number.isSafeInteger(input.total) || input.total < 0 || input.current > input.total) {
    return fail("PROJECT_WORKFLOW_INVALID_INPUT");
  }
  return withJobLock(db, input.jobId, async (tx) => {
    await verifyAttempt(tx, input);
    const now = new Date();
    const updated = await tx.backgroundJobAttempt.updateMany({
      where: { id: input.attemptId, jobId: input.jobId, status: "running" },
      data: { heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + DEFAULT_JOB_LEASE_MS) },
    });
    if (updated.count !== 1) return fail("PROJECT_WORKFLOW_STALE_ATTEMPT");
    await tx.backgroundJob.update({
      where: { id: input.jobId },
      data: { stage, progressCurrent: input.current, progressTotal: input.total },
    });
    return true;
  });
}

export async function markProviderDispatched(
  input: Readonly<{ jobId: string; attemptId: string; claimToken: string }>,
  db: WorkflowDb = getDb(),
): Promise<boolean> {
  return withJobLock(db, input.jobId, async (tx) => {
    await verifyAttempt(tx, input);
    const now = new Date();
    const updated = await tx.backgroundJobAttempt.updateMany({
      where: {
        id: input.attemptId,
        jobId: input.jobId,
        status: "running",
        dispatchState: { in: ["pending", "acknowledged"] },
      },
      data: { dispatchState: "dispatched", heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + DEFAULT_JOB_LEASE_MS) },
    });
    if (updated.count !== 1) return fail("PROJECT_WORKFLOW_STALE_ATTEMPT");
    return true;
  });
}

export async function markProviderAcknowledged(
  input: Readonly<{ jobId: string; attemptId: string; claimToken: string }>,
  db: WorkflowDb = getDb(),
): Promise<boolean> {
  return withJobLock(db, input.jobId, async (tx) => {
    await verifyAttempt(tx, input);
    const now = new Date();
    const updated = await tx.backgroundJobAttempt.updateMany({
      where: { id: input.attemptId, jobId: input.jobId, status: "running", dispatchState: "dispatched" },
      data: { dispatchState: "acknowledged", heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + DEFAULT_JOB_LEASE_MS) },
    });
    if (updated.count !== 1) return fail("PROJECT_WORKFLOW_STALE_ATTEMPT");
    return true;
  });
}

export async function finishProjectJob(
  input: Readonly<{ jobId: string; attemptId: string; claimToken: string; result: unknown }>,
  db: WorkflowDb = getDb(),
) {
  return withJobLock(db, input.jobId, async (tx) => {
    const { job } = await verifyAttempt(tx, input);
    const completedAt = new Date();
    const updated = await tx.backgroundJobAttempt.updateMany({
      where: { id: input.attemptId, jobId: input.jobId, status: "running" },
      data: { status: "succeeded", completedAt, heartbeatAt: completedAt },
    });
    if (updated.count !== 1) return fail("PROJECT_WORKFLOW_STALE_ATTEMPT");
    return tx.backgroundJob.update({
      where: { id: input.jobId },
      data: {
        status: "succeeded",
        stage: "complete",
        result: serializeProjectJobResult(job.kind, input.result) as Prisma.InputJsonValue,
        progressCurrent: 1,
        progressTotal: 1,
        failureCode: null,
        completedAt,
        reconciliationRequired: false,
      },
    });
  });
}

export async function failProjectJob(
  input: Readonly<{ jobId: string; attemptId: string; claimToken: string; error: unknown; result?: unknown }>,
  db: WorkflowDb = getDb(),
): Promise<boolean> {
  return withJobLock(db, input.jobId, async (tx) => {
    const job = await findJobForAttempt(tx, input.jobId);
    if (job === null) return fail("PROJECT_WORKFLOW_JOB_NOT_FOUND");
    if (job.status === "unknown" || job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") return false;
    await verifyAttempt(tx, input);
    const completedAt = new Date();
    const code = safeFailureCode(input.error);
    const updated = await tx.backgroundJobAttempt.updateMany({
      where: { id: input.attemptId, jobId: input.jobId, status: "running" },
      data: { status: "failed", safeFailureCode: code, completedAt, heartbeatAt: completedAt },
    });
    if (updated.count !== 1) return fail("PROJECT_WORKFLOW_STALE_ATTEMPT");
    const data: Prisma.BackgroundJobUpdateInput = {
      status: "failed",
      stage: "failed",
      failureCode: code,
      completedAt,
    };
    if (input.result !== undefined) data.result = serializeProjectJobResult(job.kind, input.result) as Prisma.InputJsonValue;
    await tx.backgroundJob.update({
      where: { id: input.jobId },
      data,
    });
    return true;
  });
}

export async function markProjectJobUnknown(
  input: Readonly<{ jobId: string; attemptId: string; claimToken: string; error: unknown; result?: unknown }>,
  db: WorkflowDb = getDb(),
): Promise<boolean> {
  return withJobLock(db, input.jobId, async (tx) => {
    const job = await findJobForAttempt(tx, input.jobId);
    if (job === null) return fail("PROJECT_WORKFLOW_JOB_NOT_FOUND");
    if (job.status === "unknown") return false;
    if (job.status !== "running") return fail("PROJECT_WORKFLOW_STALE_ATTEMPT");
    await verifyAttempt(tx, input, { allowExpired: true });
    const completedAt = new Date();
    const code = safeFailureCode(input.error);
    await tx.backgroundJobAttempt.update({
      where: { id: input.attemptId },
      data: { status: "unknown", safeFailureCode: code, completedAt, heartbeatAt: completedAt },
    });
    const data: Prisma.BackgroundJobUpdateInput = {
      status: "unknown",
      stage: "unknown",
      failureCode: code,
      completedAt,
      reconciliationRequired: true,
    };
    if (input.result !== undefined) data.result = serializeProjectJobResult(job.kind, input.result) as Prisma.InputJsonValue;
    await tx.backgroundJob.update({
      where: { id: input.jobId },
      data,
    });
    return true;
  });
}

function publicAttempt(attempt: {
  id: string;
  attemptNumber: number;
  status: "running" | "succeeded" | "failed" | "unknown" | "cancelled";
  leasedAt: Date;
  leaseExpiresAt: Date;
  heartbeatAt: Date;
  dispatchState: "pending" | "dispatched" | "acknowledged";
  safeFailureCode: string | null;
  completedAt: Date | null;
}): PublicJobAttempt {
  return Object.freeze({
    id: attempt.id,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    leasedAt: attempt.leasedAt,
    leaseExpiresAt: attempt.leaseExpiresAt,
    heartbeatAt: attempt.heartbeatAt,
    dispatchState: attempt.dispatchState,
    safeFailureCode: attempt.safeFailureCode,
    completedAt: attempt.completedAt,
  });
}

type PublicProjectJobSource = Readonly<{
  id: string;
  projectId?: string | null;
  kind: BackgroundJobKind;
  status: PublicProjectJob["status"];
  stage?: string | null;
  result?: unknown;
  progressCurrent?: number;
  progressTotal?: number;
  failureCode?: string | null;
  reconciliationRequired?: boolean;
  createdAt: Date;
  startedAt?: Date | null;
  completedAt?: Date | null;
  attempts?: readonly Parameters<typeof publicAttempt>[0][];
}>;

/**
 * The only public representation of a BackgroundJob. Keep this mapper
 * whitelist-based: payloads, idempotency keys, grants, and lease material are
 * execution internals and must never cross an API boundary.
 */
export function toPublicProjectJob(job: PublicProjectJobSource): PublicProjectJob {
  return Object.freeze({
    id: job.id,
    projectId: job.projectId ?? null,
    kind: job.kind,
    status: job.status,
    stage: typeof job.stage === "string" && job.stage.length <= 64 ? job.stage : "unknown",
    result: serializeProjectJobResult(job.kind, job.result),
    progressCurrent: Number.isSafeInteger(job.progressCurrent) && (job.progressCurrent ?? 0) >= 0 ? job.progressCurrent ?? 0 : 0,
    progressTotal: Number.isSafeInteger(job.progressTotal) && (job.progressTotal ?? 0) >= 0 ? job.progressTotal ?? 0 : 0,
    failureCode: safeNullableFailureCode(job.failureCode),
    reconciliationRequired: job.reconciliationRequired === true,
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    attempts: Object.freeze((job.attempts ?? []).map(publicAttempt)),
  });
}

const jobDetailSelect = {
  id: true,
  projectId: true,
  kind: true,
  status: true,
  stage: true,
  result: true,
  progressCurrent: true,
  progressTotal: true,
  failureCode: true,
  reconciliationRequired: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  attempts: {
    orderBy: { attemptNumber: "desc" as const },
    take: 5,
    select: {
      id: true,
      attemptNumber: true,
      status: true,
      leasedAt: true,
      leaseExpiresAt: true,
      heartbeatAt: true,
      dispatchState: true,
      safeFailureCode: true,
      completedAt: true,
    },
  },
} as const;

export async function getProjectJob(
  projectId: string,
  jobId: string,
  db: WorkflowDb = getDb(),
) {
  const job = await db.backgroundJob.findFirst({ where: { id: jobId, projectId }, select: jobDetailSelect });
  if (job === null) return fail("PROJECT_WORKFLOW_JOB_NOT_FOUND");
  return toPublicProjectJob(job);
}

export async function reconcileProjectJob(
  projectId: string,
  jobId: string,
  db: WorkflowDb = getDb(),
) {
  return withJobLock(db, jobId, async (tx) => {
    const job = await tx.backgroundJob.findUnique({
      where: { id: jobId },
      select: { id: true, projectId: true, status: true },
    });
    if (job === null) return fail("PROJECT_WORKFLOW_JOB_NOT_FOUND");
    if (job.projectId !== projectId) return fail("PROJECT_WORKFLOW_PROJECT_MISMATCH");
    if (job.status === "unknown") {
      await tx.providerCallAudit.updateMany({
        where: { jobId, status: "running" },
        data: { status: "unknown", safeErrorCode: "RECONCILIATION_REQUIRED", completedAt: new Date() },
      });
      return getProjectJob(projectId, jobId, tx);
    }
    if (job.status !== "running") return fail("PROJECT_WORKFLOW_INVALID_STATE");
    const attempt = await tx.backgroundJobAttempt.findFirst({
      where: { jobId },
      orderBy: { attemptNumber: "desc" },
      select: { id: true, status: true, leaseExpiresAt: true },
    });
    if (attempt === null) return fail("PROJECT_WORKFLOW_ATTEMPT_NOT_FOUND");
    if (attempt.status !== "running") return fail("PROJECT_WORKFLOW_STALE_ATTEMPT");
    if (!isLeaseExpired(attempt.leaseExpiresAt)) return fail("PROJECT_WORKFLOW_RECONCILIATION_NOT_DUE");
    const completedAt = new Date();
    await tx.backgroundJobAttempt.update({
      where: { id: attempt.id },
      data: { status: "unknown", safeFailureCode: "RECONCILIATION_REQUIRED", completedAt, heartbeatAt: completedAt },
    });
    await tx.providerCallAudit.updateMany({
      where: { jobId, status: "running" },
      data: { status: "unknown", safeErrorCode: "RECONCILIATION_REQUIRED", completedAt },
    });
    await tx.backgroundJob.update({
      where: { id: jobId },
      data: { status: "unknown", stage: "reconciliation_required", failureCode: "RECONCILIATION_REQUIRED", completedAt, reconciliationRequired: true },
    });
    return getProjectJob(projectId, jobId, tx);
  });
}

export async function cancelProjectJob(
  projectId: string,
  jobId: string,
  db: WorkflowDb = getDb(),
) {
  return withJobLock(db, jobId, async (tx) => {
    const job = await tx.backgroundJob.findUnique({
      where: { id: jobId },
      select: { id: true, projectId: true, status: true },
    });
    if (job === null) return fail("PROJECT_WORKFLOW_JOB_NOT_FOUND");
    if (job.projectId !== projectId) return fail("PROJECT_WORKFLOW_PROJECT_MISMATCH");
    if (job.status !== "queued" && job.status !== "waitingConsent") return fail("PROJECT_WORKFLOW_CANCEL_NOT_ALLOWED");
    const completedAt = new Date();
    await tx.backgroundJob.update({
      where: { id: jobId },
      data: { status: "cancelled", stage: "cancelled", completedAt },
    });
    return getProjectJob(projectId, jobId, tx);
  });
}

export function rejectProjectJobRetry(): never {
  return fail("PROJECT_WORKFLOW_RETRY_NOT_SUPPORTED");
}

export { safeFailureCode as workflowSafeFailureCode };
