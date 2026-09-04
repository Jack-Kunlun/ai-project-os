import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type AiOperation,
  type AiProviderConnection,
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
  lockMembershipUser,
} from "@/lib/ai-entitlements";
import { reloadProviderConfiguration } from "@/lib/ai-providers/service";
import { getDb } from "@/lib/db";
import { withWebAiProjectAccessTransaction } from "@/lib/access-linearization";
import { jsonValue } from "@/lib/web-github";
import { WEB_AI_TRANSFER_CONSENT_VERSION } from "@/lib/web-ai-contract";
import { assertWebAiProjectAccess, WebAiAccessError, type WebAiActor } from "@/lib/web-ai-access";
import {
  claimProjectJob,
  failProjectJob,
  finishProjectJob,
  toPublicProjectJob,
  isUncertainProviderDispatch,
  markProjectJobUnknown,
  markProviderAcknowledged,
  markProviderNotDispatched,
  withProjectJobAccessTransaction,
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

type DispatchRoute = RuntimeRoute & { providerConnection: AiProviderConnection };

function routeTupleMatches(left: RuntimeRoute, right: RuntimeRoute): boolean {
  return left.projectId === right.projectId
    && left.operation === right.operation
    && left.providerConnectionId === right.providerConnectionId
    && left.modelId === right.modelId
    && left.embeddingDimensions === right.embeddingDimensions
    && left.maxOutputTokens === right.maxOutputTokens;
}

async function reloadDispatchRoute(
  tx: Prisma.TransactionClient,
  input: Readonly<{ projectId: string; route: RuntimeRoute }>,
): Promise<DispatchRoute> {
  const route = await tx.projectAiRoute.findUnique({
    where: { projectId_operation: { projectId: input.projectId, operation: input.route.operation } },
    include: { providerConnection: true },
  });
  if (route === null || !routeTupleMatches(input.route, route)) {
    throw new AiEntitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN");
  }
  return route;
}

/**
 * Reload the persisted route and then join the provider configuration fence.
 * Grant creation may use a freshly verified provider row, but it must still
 * preserve the caller's route tuple; dispatch performs the stricter ownership
 * and configuration-version check immediately before network I/O.
 */
async function reloadRuntimeRoute(
  tx: Prisma.TransactionClient,
  input: Readonly<{ projectId: string; route: RuntimeRoute }>,
): Promise<RuntimeRoute> {
  const route = await reloadDispatchRoute(tx, input);
  const provider = await reloadProviderConfiguration(tx, route.providerConnectionId);
  if (
    provider === null
    || provider.id !== input.route.providerConnectionId
    || provider.scope !== input.route.providerConnection.scope
    || provider.workspaceId !== input.route.providerConnection.workspaceId
    || provider.ownerUserId !== input.route.providerConnection.ownerUserId
    || provider.ownershipState !== input.route.providerConnection.ownershipState
    || provider.configurationVersion !== input.route.providerConnection.configurationVersion
  ) {
    throw new AiEntitlementError("AI_PROVIDER_CONNECTION_UNAVAILABLE");
  }
  return Object.freeze({ ...route, providerConnection: provider });
}

async function reloadDispatchProvider(
  tx: Prisma.TransactionClient,
  route: DispatchRoute,
  expected: RuntimeRoute,
): Promise<AiProviderConnection> {
  const provider = await reloadProviderConfiguration(tx, route.providerConnectionId);
  if (
    provider === null
    || provider.id !== expected.providerConnectionId
    || provider.scope !== expected.providerConnection.scope
    || provider.workspaceId !== expected.providerConnection.workspaceId
    || provider.ownerUserId !== expected.providerConnection.ownerUserId
    || provider.ownershipState !== expected.providerConnection.ownershipState
  ) {
    throw new AiEntitlementError("AI_PROVIDER_CONNECTION_UNAVAILABLE");
  }
  if (
    provider.status !== "verified"
    || provider.disabledAt !== null
    || provider.ownershipState !== "confirmed"
    || provider.configurationVersion !== expected.providerConnection.configurationVersion
  ) {
    throw new AiEntitlementError("AI_PROVIDER_CONNECTION_UNAVAILABLE");
  }
  return provider;
}

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
  requestedBy: WebAiActor;
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
  return withWebAiProjectAccessTransaction(db, {
    actor: input.requestedBy,
    projectId: input.projectId,
    required: "edit",
  }, async (tx, admission) => {
    const transactionActor = admission.actor;
    const route = await reloadRuntimeRoute(tx, { projectId: input.projectId, route: input.route });
    const key = idempotencyKey(input.kind, input.projectId, transactionActor.id, input.clientKey);
    const existing = await tx.backgroundJob.findUnique({
      where: { requestedById_idempotencyKey: { requestedById: transactionActor.id, idempotencyKey: key } },
      select: { id: true },
    });
    if (existing !== null) return Object.freeze({ jobId: existing.id, created: false });
    const billing = await assertAiOutboundEntitlement({
      projectId: input.projectId,
      requestedById: transactionActor.id,
      route,
      db: tx,
      enforceConcurrency: true,
    });
    const jobId = randomUUID();
    const grant = await tx.webAiGrant.create({
      data: {
        projectId: input.projectId,
        operation: route.operation,
        scopeKind: input.scopeKind,
        scopeIds: jsonValue(input.scopeIds),
        manifestFingerprint: input.manifestFingerprint,
        providerConnectionId: route.providerConnectionId,
        modelId: route.modelId,
        consentVersion: WEB_AI_TRANSFER_CONSENT_VERSION,
        issuedById: transactionActor.id,
        billingMode: billing.billingMode,
        billingUserId: billing.billingUserId,
        callKey: stableAiCallKey(jobId, route.operation, "grant"),
        expiresAt: new Date(Date.now() + GRANT_LIFETIME_MS),
      },
    });
    const job = await tx.backgroundJob.create({
      data: {
        id: jobId,
        projectId: input.projectId,
        kind: input.kind,
        requestedById: transactionActor.id,
        webAiGrantId: grant.id,
        idempotencyKey: key,
        payload: jsonValue(input.payload),
      },
    });
    if (input.afterCreate !== undefined) await input.afterCreate(tx, job.id);
    return Object.freeze({ jobId: job.id, created: true });
  });
}

export async function createSupplementalWebAiGrant(input: Readonly<{
  projectId: string;
  jobId: string;
  route: RuntimeRoute;
  requestedBy: WebAiActor;
  scopeKind: WebAiScopeKind;
  scopeIds: unknown;
  manifestFingerprint: string;
}>, db: PrismaClient = getDb()) {
  const additionalActorIds = typeof input.route.providerConnection.ownerUserId !== "string"
    ? []
    : [input.route.providerConnection.ownerUserId];
  return withWebAiProjectAccessTransaction(db, {
    actor: input.requestedBy,
    projectId: input.projectId,
    required: "edit",
    additionalActorIds,
  }, async (tx, admission) => {
    const currentActor = admission.actor;
    const job = await tx.backgroundJob.findUnique({
      where: { id: input.jobId },
      select: { id: true, projectId: true, requestedById: true },
    });
    if (job === null || job.projectId !== input.projectId || job.requestedById !== currentActor.id) {
      return fail("WEB_AI_JOB_NOT_FOUND");
    }
    const route = await reloadRuntimeRoute(tx, { projectId: input.projectId, route: input.route });
    const billing = await assertAiOutboundEntitlement({
      projectId: input.projectId,
      requestedById: currentActor.id,
      route,
      db: tx,
      enforceConcurrency: false,
    });
    return tx.webAiGrant.create({
      data: {
        projectId: input.projectId,
        operation: route.operation,
        scopeKind: input.scopeKind,
        scopeIds: jsonValue({ jobId: input.jobId, scope: input.scopeIds }),
        manifestFingerprint: input.manifestFingerprint,
        providerConnectionId: route.providerConnectionId,
        modelId: route.modelId,
        consentVersion: WEB_AI_TRANSFER_CONSENT_VERSION,
        issuedById: currentActor.id,
        billingMode: billing.billingMode,
        billingUserId: billing.billingUserId,
        callKey: stableAiCallKey(input.jobId, route.operation, "supplemental"),
        expiresAt: new Date(Date.now() + GRANT_LIFETIME_MS),
      },
    });
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
  actor: WebAiActor;
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
  const currentActor = await assertWebAiProjectAccess(input.actor, input.route.projectId, "edit", db);
  // Bind the caller's route to the job before touching provider or token
  // state. This is only an early rejection; the final access-first admission
  // below reloads the same tuple while holding the job lock.
  const requestedJob = await db.backgroundJob.findUnique({
    where: { id: input.jobId },
    select: { projectId: true, requestedById: true },
  });
  if (
    requestedJob === null
    || requestedJob.projectId !== input.route.projectId
    || requestedJob.requestedById !== currentActor.id
  ) {
    throw new WebAiAccessError("ACCESS_FORBIDDEN");
  }
  const billing = await assertAiOutboundEntitlement({
    projectId: input.route.projectId,
    requestedById: currentActor.id,
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
    if (reservation !== null && reservation.status !== "reserved") {
      throw new AiEntitlementError(reservation.status === "held" ? "AI_PLATFORM_TOKEN_USAGE_UNVERIFIED" : "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED");
    }
    const additionalActorIds = typeof input.route.providerConnection.ownerUserId !== "string"
      ? []
      : [input.route.providerConnection.ownerUserId];
    const admitted = await withProjectJobAccessTransaction(db, {
      actor: input.actor,
      projectId: input.route.projectId,
      jobId: input.jobId,
      required: "edit",
      expectedRequestedById: currentActor.id,
      additionalActorIds,
      attempt: {
        jobId: input.jobId,
        attemptId: input.attempt.attemptId,
        claimToken: input.attempt.claimToken,
      },
      markDispatched: true,
    }, async (tx, accessAdmission) => {
      // The persisted project route and provider configuration are reloaded
      // only after the shared access and job locks. The provider lock is the
      // same namespace used by control-plane lifecycle writes.
      const persistedRoute = await reloadDispatchRoute(tx, {
        projectId: input.route.projectId,
        route: input.route,
      });
      const provider = await reloadDispatchProvider(tx, persistedRoute, input.route);
      const dispatchRoute: DispatchRoute = { ...persistedRoute, providerConnection: provider };
      if (provider.scope === "workspace" && provider.ownerUserId !== null) {
        await lockMembershipUser(tx, provider.ownerUserId);
      }
      const finalBilling = await assertAiOutboundEntitlement({
        projectId: input.route.projectId,
        requestedById: accessAdmission.access.actor.id,
        route: dispatchRoute,
        operation,
        db: tx,
        enforceConcurrency: false,
      });
      // A BackgroundJob is the durable owner of the grant used to create it.
      // Rebind that grant under the same job lock so a stale worker cannot
      // dispatch with a route/provider tuple that was never granted to this
      // job (or with an expired/revoked grant).
      const grantBinding = await tx.backgroundJob.findUnique({
        where: { id: input.jobId },
        select: {
          projectId: true,
          requestedById: true,
          webAiGrant: {
            select: {
              projectId: true,
              operation: true,
              providerConnectionId: true,
              modelId: true,
              consentVersion: true,
              billingMode: true,
              billingUserId: true,
              expiresAt: true,
              revokedAt: true,
            },
          },
        },
      });
      const grant = grantBinding?.webAiGrant;
      if (
        grantBinding === null
        || grant === undefined
        || grant === null
        || grantBinding.projectId !== input.route.projectId
        || grantBinding.requestedById !== accessAdmission.access.actor.id
        || grant.projectId !== input.route.projectId
        || grant.operation !== input.route.operation
        || grant.providerConnectionId !== input.route.providerConnectionId
        || grant.modelId !== input.route.modelId
        || grant.consentVersion !== WEB_AI_TRANSFER_CONSENT_VERSION
        || grant.revokedAt !== null
        || grant.expiresAt <= new Date()
      ) {
        throw new AiEntitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN");
      }
      if (
        finalBilling.billingMode !== billing.billingMode
        || finalBilling.billingUserId !== billing.billingUserId
        || finalBilling.reservationRequired !== billing.reservationRequired
        || grant.billingMode !== finalBilling.billingMode
        || grant.billingUserId !== finalBilling.billingUserId
      ) {
        throw new AiEntitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN");
      }
      if (reservation !== null) {
        const fence = await acquirePlatformTokenDispatchFence({
          userId: finalBilling.billingUserId,
          callKey: input.callKey,
          now: new Date(),
        }, tx);
        if (fence === null || !fence.allowed || fence.status !== "reserved") {
          throw new AiEntitlementError(fence?.status === "held" ? "AI_PLATFORM_TOKEN_USAGE_UNVERIFIED" : "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED");
        }
      }
      let audit;
      try {
        audit = await tx.providerCallAudit.create({
          data: {
            jobId: input.jobId,
            providerConnectionId: provider.id,
            operation,
            modelId: persistedRoute.modelId,
            billingMode: finalBilling.billingMode,
            billingUserId: finalBilling.billingUserId,
            callKey: input.callKey,
            reservationId: reservation?.reservationId ?? null,
            status: "running",
          },
        });
      } catch (error) {
        // The unique key is the final duplicate-call fence. It runs inside
        // the same transaction as the attempt marker, so a conflict cannot
        // leave a dispatched attempt or audit behind.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new AiEntitlementError("AI_PROVIDER_CALL_RECONCILIATION_REQUIRED");
        }
        throw error;
      }
      return Object.freeze({ auditId: audit.id, billing: finalBilling, dispatchMarked: accessAdmission.dispatchMarked });
    });
    auditId = admitted.auditId;
    dispatchMarked = admitted.dispatchMarked;
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
        await db.providerCallAudit.update({ where: { id: auditId! }, data: { status: "unknown", safeErrorCode: settlementError, usageKnown: result.usageKnown === true, providerRequestId: result.providerRequestId, inputTokens: result.inputTokens, outputTokens: result.outputTokens ?? 0, completedAt: new Date() } });
        await markProjectJobUnknown({ jobId: input.jobId, ...input.attempt, error: new AiEntitlementError(settlementError) }, db);
        jobMarkedUnknown = true;
        throw new AiEntitlementError(settlementError);
      }
    }
    await db.providerCallAudit.update({
      where: { id: auditId! },
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
