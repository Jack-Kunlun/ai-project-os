import { createHash, randomUUID } from "node:crypto";
import type { AppUser, BackgroundJobKind, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { getDb } from "@/lib/db";
import {
  createGitHubCodeScanService,
  createGitHubMaterialSyncService,
} from "@/lib/github";
import { jsonValue, loadProjectGitHubClient } from "@/lib/web-github";

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

function fail(code: BackgroundJobErrorCode): never {
  throw new BackgroundJobError(code);
}

function idempotencyHash(kind: BackgroundJobKind, projectId: string, clientKey: string): string {
  return createHash("sha256").update(`${kind}:${projectId}:${clientKey}`, "utf8").digest("hex");
}

function safeFailureCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{3,64}$/.test(code)) return code;
  }
  return "BACKGROUND_JOB_FAILED";
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

async function claimJob(jobId: string, kind: BackgroundJobKind, db: PrismaClient) {
  const claimed = await db.backgroundJob.updateMany({
    where: { id: jobId, kind, status: "queued" },
    data: { status: "running", stage: "executing", startedAt: new Date() },
  });
  if (claimed.count === 1) return;
  const job = await db.backgroundJob.findUnique({ where: { id: jobId } });
  if (job === null) return fail("BACKGROUND_JOB_NOT_FOUND");
  if (job.status === "succeeded" || job.status === "failed") return;
  return fail("BACKGROUND_JOB_INVALID_STATE");
}

async function finishJob(jobId: string, result: unknown, db: PrismaClient) {
  return db.backgroundJob.update({
    where: { id: jobId },
    data: {
      status: "succeeded",
      stage: "complete",
      result: jsonValue(result),
      progressCurrent: 1,
      progressTotal: 1,
      completedAt: new Date(),
      failureCode: null,
    },
  });
}

async function failJob(jobId: string, error: unknown, db: PrismaClient) {
  await db.backgroundJob.updateMany({
    where: { id: jobId, status: "running" },
    data: {
      status: "failed",
      stage: "failed",
      failureCode: safeFailureCode(error),
      completedAt: new Date(),
    },
  });
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
  if (job.status !== "queued") return job;
  await claimJob(job.id, "githubScan", db);
  try {
    const client = await loadProjectGitHubClient(input.projectId, db);
    const result = await createGitHubCodeScanService({ db, client }).scanProject(input.projectId);
    return finishJob(job.id, result, db);
  } catch (error) {
    await failJob(job.id, error, db);
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
  if (job.status !== "queued") return job;
  await claimJob(job.id, "githubMaterialSync", db);
  try {
    const client = await loadProjectGitHubClient(input.projectId, db);
    const result = await createGitHubMaterialSyncService({ db, client }).syncRepository({
      projectId: input.projectId,
      linkId,
    });
    return finishJob(job.id, result, db);
  } catch (error) {
    await failJob(job.id, error, db);
    throw error;
  }
}

export async function listProjectJobs(projectId: string, db: PrismaClient = getDb()) {
  return db.backgroundJob.findMany({
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
    },
  });
}

