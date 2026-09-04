import { createHash, randomUUID } from "node:crypto";
import type { BackgroundJobKind, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { CredentialVaultError } from "@/lib/credential-vault";
import { getDb } from "@/lib/db";
import { assertWebAiProjectAccess, type WebAiActor } from "@/lib/web-ai-access";
import {
  createGitHubCodeScanService,
  createGitHubMaterialSyncService,
} from "@/lib/github";
import { jsonValue, loadProjectGitHubClient } from "@/lib/web-github";
import {
  claimProjectJob,
  failProjectJob,
  finishProjectJob,
  getProjectJobInternal,
  isUncertainProviderDispatch,
  markProjectJobUnknown,
  markProviderAcknowledged,
  markProviderNotDispatched,
  startProjectJobHeartbeat,
  toPublicProjectJob,
  type ProjectJobHeartbeat,
  type JobAttemptClaim,
  withProjectJobAccessTransaction,
} from "@/lib/project-workflow";

export type BackgroundJobErrorCode =
  | "BACKGROUND_JOB_INVALID_INPUT"
  | "BACKGROUND_JOB_NOT_FOUND"
  | "BACKGROUND_JOB_INVALID_STATE";

export class BackgroundJobError extends Error {
  constructor(readonly code: BackgroundJobErrorCode) {
    super(code);
    this.name = "BackgroundJobError";
  }
}

const clientKeySchema = z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const linkIdSchema = z.string().uuid();

function idempotencyHash(kind: BackgroundJobKind, projectId: string, clientKey: string): string {
  return createHash("sha256").update(`${kind}:${projectId}:${clientKey}`, "utf8").digest("hex");
}

async function createQueuedJob(input: Readonly<{
  projectId: string;
  kind: BackgroundJobKind;
  requestedById: string;
  clientKey: unknown;
  payload?: Record<string, unknown>;
}>, db: PrismaClient) {
  const clientKey = clientKeySchema.parse(input.clientKey);
  const hash = idempotencyHash(input.kind, input.projectId, clientKey);
  const existing = await db.backgroundJob.findUnique({
    where: { requestedById_idempotencyKey: { requestedById: input.requestedById, idempotencyKey: hash } },
  });
  if (existing !== null) return existing;
  return db.backgroundJob.create({
    data: {
      id: randomUUID(),
      projectId: input.projectId,
      kind: input.kind,
      requestedById: input.requestedById,
      idempotencyKey: hash,
      payload: jsonValue(input.payload ?? {}),
    },
  });
}

async function claimJob(jobId: string, kind: BackgroundJobKind, db: PrismaClient): Promise<JobAttemptClaim | false> {
  return claimProjectJob(jobId, db, kind);
}

async function finishJob(jobId: string, claim: JobAttemptClaim, result: unknown, db: PrismaClient) {
  return toPublicProjectJob(await finishProjectJob({ jobId, ...claim, result: jsonValue(result) }, db));
}

async function failJob(jobId: string, claim: JobAttemptClaim, error: unknown, db: PrismaClient, result?: unknown) {
  await failProjectJob({ jobId, ...claim, error, ...(result === undefined ? {} : { result: jsonValue(result) }) }, db);
}

function nestedStatus(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const status = (value as { status?: unknown }).status;
  return typeof status === "string" ? status : null;
}

function nestedFailureCode(value: unknown, fallback: string): string {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as { failureCode?: unknown; code?: unknown };
    const code = record.failureCode ?? record.code;
    if (typeof code === "string" && /^[A-Z0-9_]{3,64}$/.test(code)) return code;
  }
  return fallback;
}

export type GitHubJobOutcome = Readonly<{
  status: "succeeded" | "failed" | "unknown";
  failureCode: string | null;
  warning: string | null;
}>;

export function classifyGitHubJobResult(
  result: unknown,
  kind: "githubScan" | "githubMaterialSync",
): GitHubJobOutcome {
  const status = nestedStatus(result);
  if (status === "succeeded") return Object.freeze({ status: "succeeded", failureCode: null, warning: null });
  if (kind === "githubScan" && status === "partialOptional") {
    return Object.freeze({ status: "succeeded", failureCode: null, warning: "OPTIONAL_REPOSITORY_INCOMPLETE" });
  }
  if (status === "unknown") {
    return Object.freeze({
      status: "unknown",
      failureCode: nestedFailureCode(result, "RECONCILIATION_REQUIRED"),
      warning: null,
    });
  }
  if (status !== "failed" && status !== "partial" && status !== "rateLimited" && status !== "cancelled") {
    return Object.freeze({
      status: "unknown",
      failureCode: nestedFailureCode(result, "GITHUB_JOB_RESULT_UNKNOWN"),
      warning: null,
    });
  }
  const fallback = status === "rateLimited"
    ? "GITHUB_RATE_LIMITED"
    : kind === "githubScan"
      ? status === "partial" ? "GITHUB_CODE_SCAN_PARTIAL" : "GITHUB_CODE_SCAN_FAILED"
      : status === "partial" ? "GITHUB_MATERIAL_SYNC_PARTIAL" : "GITHUB_MATERIAL_SYNC_FAILED";
  return Object.freeze({
    status: "failed",
    failureCode: nestedFailureCode(result, fallback),
    warning: null,
  });
}

export function classifyGitHubJobError(error: unknown): GitHubJobOutcome {
  const code = nestedFailureCode(error, "");
  return isUncertainProviderDispatch(error) || code.endsWith("_RECONCILIATION_REQUIRED")
    ? Object.freeze({ status: "unknown", failureCode: nestedFailureCode(error, "RECONCILIATION_REQUIRED"), warning: null })
    : Object.freeze({ status: "failed", failureCode: nestedFailureCode(error, "GITHUB_JOB_FAILED"), warning: null });
}

async function stopRequestHeartbeat(
  heartbeat: ProjectJobHeartbeat,
  jobId: string,
  claim: JobAttemptClaim,
  db: PrismaClient,
): Promise<void> {
  await heartbeat.stop();
  if (heartbeat.failure !== null) {
    await markProjectJobUnknown({
      jobId,
      ...claim,
      error: { code: "PROJECT_WORKFLOW_HEARTBEAT_FAILED" },
    }, db).catch(() => undefined);
    throw heartbeat.failure;
  }
}

async function settleGitHubResult(
  projectId: string,
  jobId: string,
  claim: JobAttemptClaim,
  result: unknown,
  db: PrismaClient,
  outcome: GitHubJobOutcome,
) {
  if (outcome.status === "succeeded") {
    return finishJob(jobId, claim, result, db);
  }
  if (outcome.status === "unknown") {
    await markProjectJobUnknown({
      jobId,
      ...claim,
      error: { code: outcome.failureCode ?? "RECONCILIATION_REQUIRED" },
      result,
    }, db);
    return getProjectJobInternal(projectId, jobId, db);
  }
  const error = { code: outcome.failureCode ?? "GITHUB_JOB_FAILED" };
  await failJob(jobId, claim, error, db, result);
  return getProjectJobInternal(projectId, jobId, db);
}

function isDefinitelyPreDispatchGitHubFailure(error: unknown): boolean {
  if (error instanceof CredentialVaultError) return true;
  if (typeof error !== "object" || error === null) return false;
  if ("requestDispatched" in error && (error as { requestDispatched?: unknown }).requestDispatched === false) return true;
  const code = nestedFailureCode(error, "");
  return code.startsWith("GITHUB_WEB_");
}

/**
 * Mark one direct GitHub request inside the canonical actor -> workspace ->
 * project -> job admission transaction.  The transaction is deliberately
 * database-only; callers must load the encrypted credential and construct the
 * client only after this promise resolves.
 */
async function admitDirectGitHubDispatch(
  input: Readonly<{ projectId: string; jobId: string; requestedBy: WebAiActor; claim: JobAttemptClaim; kind: "githubScan" | "githubMaterialSync"; linkId?: string }>,
  db: PrismaClient,
) {
  return withProjectJobAccessTransaction(db, {
    actor: input.requestedBy,
    projectId: input.projectId,
    jobId: input.jobId,
    expectedRequestedById: input.requestedBy.id,
    attempt: { jobId: input.jobId, ...input.claim },
    markDispatched: true,
  }, async (tx, admission) => {
    if (admission.job.kind !== input.kind || admission.job.requestedById !== input.requestedBy.id) {
      throw new BackgroundJobError("BACKGROUND_JOB_INVALID_STATE");
    }
    if (input.kind === "githubMaterialSync") {
      const route = await tx.projectRepositoryLink.findUnique({
        where: { projectId_id: { projectId: input.projectId, id: input.linkId! } },
        select: {
          status: true,
          githubConnection: {
            select: {
              status: true,
              credentialId: true,
              credential: { select: { id: true, kind: true, secretFingerprint: true } },
            },
          },
        },
      });
      const connection = route?.githubConnection ?? null;
      const credential = connection?.credential ?? null;
      if (
        route === null ||
        route.status !== "active" ||
        connection === null ||
        connection.status !== "verified" ||
        connection.credentialId === null ||
        credential === null ||
        credential.id !== connection.credentialId ||
        credential.kind !== "github" ||
        !/^[0-9a-f]{64}$/u.test(credential.secretFingerprint)
      ) {
        throw new BackgroundJobError("BACKGROUND_JOB_INVALID_STATE");
      }
    }
    return admission;
  });
}

export async function runGitHubCodeScanJob(input: Readonly<{
  projectId: string;
  requestedBy: WebAiActor;
  clientKey: unknown;
}>, db: PrismaClient = getDb()) {
  const currentActor = await assertWebAiProjectAccess(input.requestedBy, input.projectId, "edit", db);
  const job = await createQueuedJob({
    projectId: input.projectId,
    requestedById: currentActor.id,
    kind: "githubScan",
    clientKey: input.clientKey,
  }, db);
  if (job.status !== "queued") return toPublicProjectJob(job);
  const claim = await claimJob(job.id, "githubScan", db);
  if (!claim) return toPublicProjectJob(await db.backgroundJob.findUniqueOrThrow({ where: { id: job.id } }));
  let heartbeat: ProjectJobHeartbeat | null = null;
  try {
    // Re-check the actor after the claim, inside the terminalizing try/catch.
    // This closes the revoke/disable race before the shared dispatch admission
    // can read any GitHub credential or start provider work.
    await assertWebAiProjectAccess(input.requestedBy, input.projectId, "edit", db);
    // The access admission and dispatch marker commit together.  No heartbeat,
    // credential read, client construction, or provider call is allowed before
    // that commit boundary.
    await admitDirectGitHubDispatch({
      projectId: input.projectId,
      jobId: job.id,
      requestedBy: input.requestedBy,
      claim,
      kind: "githubScan",
    }, db);
    heartbeat = startProjectJobHeartbeat({ jobId: job.id, ...claim }, db);
    const client = await loadProjectGitHubClient(input.projectId, db);
    const result = await createGitHubCodeScanService({ db, client }).scanProject(input.projectId);
    const outcome = classifyGitHubJobResult(result, "githubScan");
    await stopRequestHeartbeat(heartbeat, job.id, claim, db);
    if (outcome.status !== "unknown") {
      await markProviderAcknowledged({ jobId: job.id, ...claim }, db);
    }
    return settleGitHubResult(input.projectId, job.id, claim, result, db, outcome);
  } catch (error) {
    if (heartbeat !== null) await heartbeat.stop();
    if (classifyGitHubJobError(error).status === "unknown") {
      await markProjectJobUnknown({ jobId: job.id, ...claim, error }, db);
    } else {
      // Credential/client setup and explicit pre-dispatch transport failures
      // cannot have reached GitHub. Undo the optimistic admission marker
      // before closing the known-failed attempt.
      if (isDefinitelyPreDispatchGitHubFailure(error)) {
        await markProviderNotDispatched({ jobId: job.id, ...claim }, db).catch(() => undefined);
      }
      await failJob(job.id, claim, error, db);
    }
    throw error;
  }
}

export async function runGitHubMaterialSyncJob(input: Readonly<{
  projectId: string;
  linkId: unknown;
  requestedBy: WebAiActor;
  clientKey: unknown;
}>, db: PrismaClient = getDb()) {
  const linkId = linkIdSchema.parse(input.linkId);
  const currentActor = await assertWebAiProjectAccess(input.requestedBy, input.projectId, "edit", db);
  const job = await createQueuedJob({
    projectId: input.projectId,
    requestedById: currentActor.id,
    kind: "githubMaterialSync",
    clientKey: input.clientKey,
    payload: { linkId },
  }, db);
  if (job.status !== "queued") return toPublicProjectJob(job);
  const claim = await claimJob(job.id, "githubMaterialSync", db);
  if (!claim) return toPublicProjectJob(await db.backgroundJob.findUniqueOrThrow({ where: { id: job.id } }));
  let heartbeat: ProjectJobHeartbeat | null = null;
  try {
    // Re-check the actor after the claim, inside the terminalizing try/catch.
    // This closes the revoke/disable race before the shared dispatch admission
    // can read any GitHub credential or start provider work.
    await assertWebAiProjectAccess(input.requestedBy, input.projectId, "edit", db);
    // The access admission and dispatch marker commit together.  No heartbeat,
    // credential read, client construction, or provider call is allowed before
    // that commit boundary.
    await admitDirectGitHubDispatch({
      projectId: input.projectId,
      jobId: job.id,
      requestedBy: input.requestedBy,
      claim,
      kind: "githubMaterialSync",
      linkId,
    }, db);
    heartbeat = startProjectJobHeartbeat({ jobId: job.id, ...claim }, db);
    const client = await loadProjectGitHubClient(input.projectId, db);
    const result = await createGitHubMaterialSyncService({ db, client }).syncRepository({
      projectId: input.projectId,
      linkId,
    });
    const outcome = classifyGitHubJobResult(result, "githubMaterialSync");
    await stopRequestHeartbeat(heartbeat, job.id, claim, db);
    if (outcome.status !== "unknown") {
      await markProviderAcknowledged({ jobId: job.id, ...claim }, db);
    }
    return settleGitHubResult(input.projectId, job.id, claim, result, db, outcome);
  } catch (error) {
    if (heartbeat !== null) await heartbeat.stop();
    if (classifyGitHubJobError(error).status === "unknown") {
      await markProjectJobUnknown({ jobId: job.id, ...claim, error }, db);
    } else {
      if (isDefinitelyPreDispatchGitHubFailure(error)) {
        await markProviderNotDispatched({ jobId: job.id, ...claim }, db).catch(() => undefined);
      }
      await failJob(job.id, claim, error, db);
    }
    throw error;
  }
}

export { runGitHubProjectSyncJob } from "@/lib/github";

export async function listProjectJobs(
  projectId: string,
  actor: WebAiActor,
  db: PrismaClient = getDb(),
) {
  await assertWebAiProjectAccess(actor, projectId, "view", db);
  const jobs = await db.backgroundJob.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: {
      id: true,
      kind: true,
      status: true,
      stage: true,
      result: true,
      progressCurrent: true,
      progressTotal: true,
      failureCode: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
      reconciliationRequired: true,
      attempts: {
        orderBy: { attemptNumber: "desc" },
        take: 1,
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
    },
  });
  return jobs.map(toPublicProjectJob);
}
