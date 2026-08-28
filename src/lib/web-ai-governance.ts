import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type AiOperation,
  type AiProviderConnection,
  type AppUser,
  type BackgroundJobKind,
  type PrismaClient,
  type ProjectAiRoute,
  type WebAiScopeKind,
} from "@prisma/client";
import { z } from "zod";
import { ProviderTransportError } from "@/lib/ai-providers";
import { getDb } from "@/lib/db";
import { jsonValue } from "@/lib/web-github";
import { WEB_AI_TRANSFER_CONSENT_VERSION } from "@/lib/web-ai-contract";
import {
  claimProjectJob,
  failProjectJob,
  finishProjectJob,
  toPublicProjectJob,
  isUncertainProviderDispatch,
  markProjectJobUnknown,
  markProviderAcknowledged,
  markProviderDispatched,
  type JobAttemptClaim,
  updateProjectJobProgress,
} from "@/lib/project-workflow";

export { WEB_AI_TRANSFER_CONSENT_VERSION } from "@/lib/web-ai-contract";
const GRANT_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const clientKeySchema = z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/);

export type WebAiGovernanceErrorCode =
  | "WEB_AI_CONSENT_REQUIRED"
  | "WEB_AI_JOB_INVALID_STATE"
  | "WEB_AI_JOB_NOT_FOUND";

export class WebAiGovernanceError extends Error {
  constructor(readonly code: WebAiGovernanceErrorCode) {
    super(code);
    this.name = "WebAiGovernanceError";
  }
}

export type RuntimeRoute = ProjectAiRoute & { providerConnection: AiProviderConnection };

function fail(code: WebAiGovernanceErrorCode): never {
  throw new WebAiGovernanceError(code);
}

export function manifestFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function assertWebAiConsent(value: unknown): void {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { acknowledged?: unknown }).acknowledged !== true ||
    (value as { version?: unknown }).version !== WEB_AI_TRANSFER_CONSENT_VERSION
  ) {
    return fail("WEB_AI_CONSENT_REQUIRED");
  }
}

function idempotencyKey(
  kind: BackgroundJobKind,
  projectId: string,
  userId: string,
  rawClientKey: unknown,
): string {
  const clientKey = clientKeySchema.parse(rawClientKey);
  return createHash("sha256")
    .update(`${kind}:${projectId}:${userId}:${clientKey}`, "utf8")
    .digest("hex");
}

export async function createGrantedWebAiJob(input: Readonly<{
  projectId: string;
  kind: BackgroundJobKind;
  route: RuntimeRoute;
  requestedBy: Pick<AppUser, "id">;
  clientKey: unknown;
  scopeKind: WebAiScopeKind;
  scopeIds: unknown;
  manifestFingerprint: string;
  payload: Record<string, unknown>;
}>, db: PrismaClient = getDb()): Promise<Readonly<{ jobId: string; created: boolean }>> {
  const key = idempotencyKey(input.kind, input.projectId, input.requestedBy.id, input.clientKey);
  const existing = await db.backgroundJob.findUnique({
    where: { requestedById_idempotencyKey: { requestedById: input.requestedBy.id, idempotencyKey: key } },
    select: { id: true },
  });
  if (existing !== null) return Object.freeze({ jobId: existing.id, created: false });

  return db.$transaction(async (tx) => {
    const grant = await tx.webAiGrant.create({
      data: {
        projectId: input.projectId,
        operation: input.route.operation,
        scopeKind: input.scopeKind,
        scopeIds: jsonValue(input.scopeIds),
        manifestFingerprint: input.manifestFingerprint,
        providerConnectionId: input.route.providerConnectionId,
        modelId: input.route.modelId,
        consentVersion: WEB_AI_TRANSFER_CONSENT_VERSION,
        issuedById: input.requestedBy.id,
        expiresAt: new Date(Date.now() + GRANT_LIFETIME_MS),
      },
    });
    const job = await tx.backgroundJob.create({
      data: {
        id: randomUUID(),
        projectId: input.projectId,
        kind: input.kind,
        requestedById: input.requestedBy.id,
        webAiGrantId: grant.id,
        idempotencyKey: key,
        payload: jsonValue(input.payload),
      },
    });
    return Object.freeze({ jobId: job.id, created: true });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function createSupplementalWebAiGrant(input: Readonly<{
  projectId: string;
  jobId: string;
  route: RuntimeRoute;
  requestedBy: Pick<AppUser, "id">;
  scopeKind: WebAiScopeKind;
  scopeIds: unknown;
  manifestFingerprint: string;
}>, db: PrismaClient = getDb()) {
  return db.webAiGrant.create({
    data: {
      projectId: input.projectId,
      operation: input.route.operation,
      scopeKind: input.scopeKind,
      scopeIds: jsonValue({ jobId: input.jobId, scope: input.scopeIds }),
      manifestFingerprint: input.manifestFingerprint,
      providerConnectionId: input.route.providerConnectionId,
      modelId: input.route.modelId,
      consentVersion: WEB_AI_TRANSFER_CONSENT_VERSION,
      issuedById: input.requestedBy.id,
      expiresAt: new Date(Date.now() + GRANT_LIFETIME_MS),
    },
  });
}

export async function claimWebAiJob(jobId: string, db: PrismaClient = getDb()): Promise<JobAttemptClaim | false> {
  return claimProjectJob(jobId, db);
}

function safeFailureCode(error: unknown): string {
  if (error instanceof ProviderTransportError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{3,64}$/.test(code)) return code;
  }
  if (error instanceof Error && /^[A-Z0-9_]{3,64}$/.test(error.message)) return error.message;
  return "WEB_AI_JOB_FAILED";
}

export async function finishWebAiJob(
  jobId: string,
  claim: JobAttemptClaim,
  result: unknown,
  db: PrismaClient = getDb(),
) {
  return toPublicProjectJob(await finishProjectJob({ jobId, ...claim, result: jsonValue(result) }, db));
}

export async function failWebAiJob(
  jobId: string,
  claim: JobAttemptClaim,
  error: unknown,
  db: PrismaClient = getDb(),
) {
  await failProjectJob({ jobId, ...claim, error }, db);
}

export async function updateWebAiJobProgress(
  jobId: string,
  claim: JobAttemptClaim,
  stage: string,
  current: number,
  total: number,
  db: PrismaClient = getDb(),
) {
  await updateProjectJobProgress({ jobId, ...claim, stage, current, total }, db);
}

export async function auditedProviderCall<T>(input: Readonly<{
  jobId: string;
  attempt: JobAttemptClaim;
  route: RuntimeRoute;
  operation?: AiOperation;
  call: () => Promise<Readonly<T & {
    inputTokens: number;
    providerRequestId: string | null;
    outputTokens?: number;
  }>>;
}>, db: PrismaClient = getDb()): Promise<T & {
  inputTokens: number;
  providerRequestId: string | null;
  outputTokens?: number;
}> {
  await markProviderDispatched({ jobId: input.jobId, ...input.attempt }, db);
  const audit = await db.providerCallAudit.create({
    data: {
      jobId: input.jobId,
      providerConnectionId: input.route.providerConnectionId,
      operation: input.operation ?? input.route.operation,
      modelId: input.route.modelId,
      status: "running",
    },
  });
  try {
    const result = await input.call();
    await markProviderAcknowledged({ jobId: input.jobId, ...input.attempt }, db);
    await db.providerCallAudit.update({
      where: { id: audit.id },
      data: {
        status: "succeeded",
        providerRequestId: result.providerRequestId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens ?? 0,
        completedAt: new Date(),
      },
    });
    return result;
  } catch (error) {
    const uncertain = isUncertainProviderDispatch(error);
    await db.providerCallAudit.updateMany({
      where: { id: audit.id, status: "running" },
      data: {
        status: uncertain ? "unknown" : "failed",
        safeErrorCode: safeFailureCode(error),
        completedAt: new Date(),
      },
    });
    if (uncertain) {
      await markProjectJobUnknown({ jobId: input.jobId, ...input.attempt, error }, db);
    }
    throw error;
  }
}
