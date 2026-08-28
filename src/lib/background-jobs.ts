import { createHash, randomUUID } from "node:crypto";
import type { AppUser, BackgroundJobKind, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { getDb } from "@/lib/db";
import {
  createGitHubCodeScanService,
  createGitHubMaterialSyncService,
} from "@/lib/github";
import { jsonValue, loadProjectGitHubClient } from "@/lib/web-github";
import {
  claimProjectJob,
  failProjectJob,
  finishProjectJob,
  getProjectJob,
  isUncertainProviderDispatch,
  markProjectJobUnknown,
  markProviderAcknowledged,
  markProviderDispatched,
  startProjectJobHeartbeat,
  toPublicProjectJob,
  type ProjectJobHeartbeat,
  type JobAttemptClaim,
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
    return getProjectJob(projectId, jobId, db);
  }
  const error = { code: outcome.failureCode ?? "GITHUB_JOB_FAILED" };
  await failJob(jobId, claim, error, db, result);
  return getProjectJob(projectId, jobId, db);
}

export async function runGitHubCodeScanJob(input: Readonly<{
  projectId: string;
  requestedBy: Pick<AppUser, "id">;
  clientKey: unknown;
}>, db: PrismaClient = getDb()) {
  const job = await createQueuedJob({
    projectId: input.projectId,
    requestedById: input.requestedBy.id,
    kind: "githubScan",
    clientKey: input.clientKey,
  }, db);
  if (job.status !== "queued") return toPublicProjectJob(job);
  const claim = await claimJob(job.id, "githubScan", db);
  if (!claim) return toPublicProjectJob(await db.backgroundJob.findUniqueOrThrow({ where: { id: job.id } }));
  let heartbeat: ProjectJobHeartbeat | null = null;
  try {
    await markProviderDispatched({ jobId: job.id, ...claim }, db);
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
      await failJob(job.id, claim, error, db);
    }
    throw error;
  }
}

export async function runGitHubMaterialSyncJob(input: Readonly<{
  projectId: string;
  linkId: unknown;
  requestedBy: Pick<AppUser, "id">;
  clientKey: unknown;
}>, db: PrismaClient = getDb()) {
  const linkId = linkIdSchema.parse(input.linkId);
  const job = await createQueuedJob({
    projectId: input.projectId,
    requestedById: input.requestedBy.id,
    kind: "githubMaterialSync",
    clientKey: input.clientKey,
    payload: { linkId },
  }, db);
  if (job.status !== "queued") return toPublicProjectJob(job);
  const claim = await claimJob(job.id, "githubMaterialSync", db);
  if (!claim) return toPublicProjectJob(await db.backgroundJob.findUniqueOrThrow({ where: { id: job.id } }));
  let heartbeat: ProjectJobHeartbeat | null = null;
  try {
    await markProviderDispatched({ jobId: job.id, ...claim }, db);
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
      await failJob(job.id, claim, error, db);
    }
    throw error;
  }
}

export async function listProjectJobs(projectId: string, db: PrismaClient = getDb()) {
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
