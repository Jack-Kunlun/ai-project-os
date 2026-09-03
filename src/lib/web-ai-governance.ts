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
import {
  assertAiOutboundEntitlement,
  acquirePlatformTokenDispatchFence,
  AiEntitlementError,
  estimatePlatformTokens,
  holdPlatformTokenReservation,
  releasePlatformTokenReservation,
  reservePlatformTokens,
  settlePlatformTokenReservation,
} from "@/lib/ai-entitlements";
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
  markProviderNotDispatched,
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

/** Stable per-job call identity used by both the audit and token ledger. */
export function stableAiCallKey(jobId: string, operation: string, discriminator: string): string {
  return `ai:${createHash("sha256").update(`${jobId}:${operation}:${discriminator}`, "utf8").digest("hex")}`;
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
  /**
   * A kind-specific resource can be created while the grant/job transaction
   * is still open. Memory index candidates use this seam to hold the project
   * admission lock and create their generation atomically with the job.
   */
  afterCreate?: (tx: Prisma.TransactionClient, jobId: string) => Promise<void>;
}>, db: PrismaClient = getDb()): Promise<Readonly<{ jobId: string; created: boolean }>> {
  const key = idempotencyKey(input.kind, input.projectId, input.requestedBy.id, input.clientKey);
  const existing = await db.backgroundJob.findUnique({
    where: { requestedById_idempotencyKey: { requestedById: input.requestedBy.id, idempotencyKey: key } },
    select: { id: true },
  });
  if (existing !== null) return Object.freeze({ jobId: existing.id, created: false });

  return db.$transaction(async (tx) => {
    const billing = await assertAiOutboundEntitlement({
      projectId: input.projectId,
      requestedById: input.requestedBy.id,
      route: input.route,
      db: tx,
      enforceConcurrency: true,
    });
    const jobId = randomUUID();
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
        billingMode: billing.billingMode,
        billingUserId: billing.billingUserId,
        callKey: stableAiCallKey(jobId, input.route.operation, "grant"),
        expiresAt: new Date(Date.now() + GRANT_LIFETIME_MS),
      },
    });
    const job = await tx.backgroundJob.create({
      data: {
        id: jobId,
        projectId: input.projectId,
        kind: input.kind,
        requestedById: input.requestedBy.id,
        webAiGrantId: grant.id,
        idempotencyKey: key,
        payload: jsonValue(input.payload),
      },
    });
    if (input.afterCreate !== undefined) await input.afterCreate(tx, job.id);
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
  const billing = await assertAiOutboundEntitlement({
    projectId: input.projectId,
    requestedById: input.requestedBy.id,
    route: input.route,
    db,
    enforceConcurrency: false,
  });
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
      billingMode: billing.billingMode,
      billingUserId: billing.billingUserId,
      callKey: stableAiCallKey(input.jobId, input.route.operation, "supplemental"),
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
  callKey: string;
  requestPayload?: unknown;
  maxOutputTokens?: number;
  call: () => Promise<Readonly<T & {
    inputTokens: number;
    providerRequestId: string | null;
    outputTokens?: number;
    usageKnown?: boolean;
  }>>;
}>, db: PrismaClient = getDb()): Promise<T & {
  inputTokens: number;
  providerRequestId: string | null;
  outputTokens?: number;
  usageKnown?: boolean;
}> {
  const operation = input.operation ?? input.route.operation;
  const job = await db.backgroundJob.findUnique({ where: { id: input.jobId }, select: { requestedById: true } });
  if (job === null) throw new Error("WEB_AI_JOB_NOT_FOUND");
  const billing = await assertAiOutboundEntitlement({
    projectId: input.route.projectId,
    requestedById: job.requestedById,
    route: input.route,
    operation,
    db,
    enforceConcurrency: false,
  });
  const billingUserId = billing.billingUserId;
  let reservation: Awaited<ReturnType<typeof reservePlatformTokens>> | null = null;
  let auditId: string | null = null;
  let networkStarted = false;
  let dispatchMarked = false;
  let jobMarkedUnknown = false;
  try {
    reservation = billing.reservationRequired
      ? await reservePlatformTokens({
          userId: billingUserId,
          jobId: input.jobId,
          providerConnectionId: input.route.providerConnectionId,
          callKey: input.callKey,
          operation,
          modelId: input.route.modelId,
          estimatedTokens: estimatePlatformTokens(input.requestPayload ?? { operation, modelId: input.route.modelId }, input.maxOutputTokens ?? input.route.maxOutputTokens),
        }, db)
      : null;
    if (reservation !== null && (!reservation.created || reservation.status !== "reserved")) {
      throw new AiEntitlementError(reservation.status === "held" ? "AI_PLATFORM_TOKEN_USAGE_UNVERIFIED" : "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED");
    }
    await markProviderDispatched({ jobId: input.jobId, ...input.attempt }, db);
    dispatchMarked = true;
    if (reservation !== null && reservation.created) {
      const fence = await acquirePlatformTokenDispatchFence({
        userId: billingUserId,
        callKey: input.callKey,
      }, db);
      if (fence === null || !fence.allowed || fence.status !== "reserved") {
        throw new AiEntitlementError(fence?.status === "held" ? "AI_PLATFORM_TOKEN_USAGE_UNVERIFIED" : "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED");
      }
    }
    let audit;
    try {
      audit = await db.providerCallAudit.create({
        data: {
          jobId: input.jobId,
          providerConnectionId: input.route.providerConnectionId,
          operation,
          modelId: input.route.modelId,
          billingMode: billing.billingMode,
          billingUserId,
          callKey: input.callKey,
          reservationId: reservation?.reservationId ?? null,
          status: "running",
        },
      });
    } catch (error) {
      // The database unique key is the final guard for BYOK (which has no
      // token reservation). A duplicate call must stop before HTTP rather
      // than being treated as a fresh attempt.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AiEntitlementError("AI_PROVIDER_CALL_RECONCILIATION_REQUIRED");
      }
      throw error;
    }
    auditId = audit.id;
    networkStarted = true;
    const result = await input.call();
    await markProviderAcknowledged({ jobId: input.jobId, ...input.attempt }, db);
    if (reservation !== null && reservation.created) {
      const settled = await settlePlatformTokenReservation({
        userId: billingUserId,
        callKey: input.callKey,
        actualTokens: result.inputTokens + (result.outputTokens ?? 0),
        usageKnown: result.usageKnown === true,
      }, db);
      if (settled.status !== "settled") {
        const settlementError = settled.status === "held" && result.usageKnown !== true
          ? "AI_PLATFORM_TOKEN_USAGE_UNVERIFIED"
          : "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED";
        await db.providerCallAudit.update({ where: { id: audit.id }, data: { status: "unknown", safeErrorCode: settlementError, usageKnown: result.usageKnown === true, providerRequestId: result.providerRequestId, inputTokens: result.inputTokens, outputTokens: result.outputTokens ?? 0, completedAt: new Date() } });
        await markProjectJobUnknown({ jobId: input.jobId, ...input.attempt, error: new AiEntitlementError(settlementError) }, db);
        jobMarkedUnknown = true;
        throw new AiEntitlementError(settlementError);
      }
    }
    await db.providerCallAudit.update({
      where: { id: audit.id },
      data: {
        status: "succeeded",
        providerRequestId: result.providerRequestId,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens ?? 0,
        usageKnown: result.usageKnown === true,
        completedAt: new Date(),
      },
    });
    return result;
  } catch (error) {
    const uncertain = networkStarted && isUncertainProviderDispatch(error);
    // Transport errors that do not carry the optional marker are conservative:
    // the request may already have reached the provider. Only an explicit
    // `false` is safe to classify as pre-dispatch.
    const requestDispatched = networkStarted && !(
      typeof error === "object" && error !== null &&
      "requestDispatched" in error &&
      (error as { requestDispatched?: unknown }).requestDispatched === false
    );
    let cleanupFailed = false;
    const reconciliationError = () => new AiEntitlementError("AI_PROVIDER_CALL_RECONCILIATION_REQUIRED");
    if (auditId !== null) {
      try {
        await db.providerCallAudit.updateMany({
          where: { id: auditId, status: "running" },
          data: {
            // Once an audit exists, a non-explicit transport failure is
            // conservatively unknown even when the transport did not attach
            // its optional uncertainty marker.
            status: requestDispatched || uncertain ? "unknown" : "failed",
            safeErrorCode: safeFailureCode(error),
            completedAt: new Date(),
          },
        });
      } catch {
        cleanupFailed = true;
      }
    }
    if (dispatchMarked && !requestDispatched) {
      try {
        await markProviderNotDispatched({ jobId: input.jobId, ...input.attempt }, db);
      } catch {
        cleanupFailed = true;
      }
    }
    if (reservation !== null && reservation.created) {
      try {
        if (!requestDispatched) {
          await releasePlatformTokenReservation({ userId: billingUserId, callKey: input.callKey }, db);
        } else {
          await holdPlatformTokenReservation({ userId: billingUserId, callKey: input.callKey, errorCode: "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED" }, db);
        }
      } catch {
        // A failed release/hold is itself an unresolved accounting state. Do
        // not hide it behind the original provider error or allow a retry.
        cleanupFailed = true;
      }
    }
    const mustReconcile = cleanupFailed || requestDispatched || uncertain || (error instanceof AiEntitlementError && (error.code === "AI_PLATFORM_TOKEN_USAGE_UNVERIFIED" || error.code === "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED"));
    if (mustReconcile && !jobMarkedUnknown) {
      try {
        await markProjectJobUnknown({ jobId: input.jobId, ...input.attempt, error: cleanupFailed ? reconciliationError() : error }, db);
        jobMarkedUnknown = true;
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) throw reconciliationError();
    throw error;
  }
}
