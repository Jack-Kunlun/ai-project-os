import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type AiOperation,
  type AiProviderConnection,
  type BackgroundJobKind,
  type PrismaClient,
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
import { reloadProviderConfiguration } from "@/lib/ai-providers/service";
import { getDb } from "@/lib/db";
import { withWebAiProjectAccessTransaction } from "@/lib/access-linearization";
import { jsonValue } from "@/lib/web-github";
import { WEB_AI_TRANSFER_CONSENT_VERSION } from "@/lib/web-ai-contract";
import {
  effectiveAiRouteSnapshot,
  resolveEffectiveAiRoute,
  routeSnapshotsEqual,
  type EffectiveAiRoute,
} from "@/lib/effective-ai-route";
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

export type RuntimeRoute = EffectiveAiRoute;

type DispatchRoute = RuntimeRoute;

function hasCompleteRouteSnapshot(route: RuntimeRoute): boolean {
  return (route.source === "project_override" || route.source === "platform_default")
    && route.routeUpdatedAt instanceof Date
    && Number.isFinite(route.routeUpdatedAt.getTime())
    && Number.isSafeInteger(route.providerConfigurationVersion)
    && route.providerConfigurationVersion > 0
    && Number.isSafeInteger(route.quotaMultiplierBps)
    && route.quotaMultiplierBps >= 1
    && route.quotaMultiplierBps <= 100_000
    && typeof route.credentialSecretFingerprint === "string"
    && /^[0-9a-f]{64}$/u.test(route.credentialSecretFingerprint)
    && typeof route.routeFenceFingerprint === "string"
    && /^[0-9a-f]{64}$/u.test(route.routeFenceFingerprint)
    && (route.source === "platform_default"
      ? typeof route.routeId === "string" && route.routeId.length > 0 && Number.isSafeInteger(route.routeVersion) && (route.routeVersion ?? 0) > 0
      : route.routeId === null && route.routeVersion === null);
}

function assertRuntimeRoute(route: RuntimeRoute): void {
  if (
    !hasCompleteRouteSnapshot(route)
    || route.providerConnection.scope !== "platform"
    || route.providerConnection.ownershipState !== "confirmed"
    || route.providerConnection.workspaceId !== null
    || route.providerConnection.ownerUserId !== null
  ) {
    throw new AiEntitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN");
  }
}

function routeTupleMatches(left: RuntimeRoute, right: RuntimeRoute): boolean {
  return left.projectId === right.projectId
    && left.operation === right.operation
    && left.providerConnectionId === right.providerConnectionId
    && left.modelId === right.modelId
    && left.embeddingDimensions === right.embeddingDimensions
    && left.maxOutputTokens === right.maxOutputTokens
    && left.credentialSecretFingerprint === right.credentialSecretFingerprint
    && hasCompleteRouteSnapshot(left)
    && hasCompleteRouteSnapshot(right)
    && routeSnapshotsEqual(left, right);
}

function routeSnapshotData(route: RuntimeRoute) {
  const snapshot = effectiveAiRouteSnapshot(route as EffectiveAiRoute);
  return {
    routeSource: snapshot.routeSource,
    routeId: snapshot.routeId,
    routeVersion: snapshot.routeVersion,
    routeUpdatedAt: snapshot.routeUpdatedAt,
    providerConfigurationVersion: snapshot.providerConfigurationVersion,
    quotaMultiplierBps: snapshot.quotaMultiplierBps,
    routeFenceFingerprint: snapshot.routeFenceFingerprint,
    credentialSecretFingerprint: snapshot.credentialSecretFingerprint,
    payerKind: "platformCaller" as const,
    payerProviderConnectionId: route.providerConnectionId,
    embeddingDimensions: route.embeddingDimensions,
    maxOutputTokens: route.maxOutputTokens,
  };
}

async function reloadDispatchRoute(
  tx: Prisma.TransactionClient,
  input: Readonly<{ projectId: string; route: RuntimeRoute }>,
): Promise<DispatchRoute> {
  assertRuntimeRoute(input.route);
  const route = await resolveEffectiveAiRoute(input.projectId, input.route.operation, tx, { lock: true });
  if (!routeTupleMatches(input.route, route)) {
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
  const credential = await tx.externalCredential.findUnique({
    where: { id: provider.credentialId },
    select: { kind: true, secretFingerprint: true },
  });
  if (
    credential === null
    || credential.kind !== "aiProvider"
    || !/^[0-9a-f]{64}$/u.test(credential.secretFingerprint)
    || credential.secretFingerprint !== route.credentialSecretFingerprint
  ) {
    throw new AiEntitlementError("AI_PROVIDER_CONNECTION_UNAVAILABLE");
  }
  return Object.freeze({
    ...route,
    credentialSecretFingerprint: credential.secretFingerprint,
    providerConnection: Object.freeze({ ...provider, credentialSecretFingerprint: credential.secretFingerprint }),
  });
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

type RuntimeGrantTuple = Readonly<{
  id: string;
  projectId: string;
  operation: AiOperation;
  providerConnectionId: string;
  modelId: string;
  consentVersion: string;
  billingMode: "platform" | "byok" | "legacy";
  billingUserId: string;
  boundJobId: string | null;
  routeSource: string | null;
  routeId: string | null;
  routeVersion: number | null;
  routeUpdatedAt: Date | null;
  providerConfigurationVersion: number | null;
  quotaMultiplierBps: number | null;
  routeFenceFingerprint: string | null;
  credentialSecretFingerprint: string | null;
  payerKind: string | null;
  payerProviderConnectionId: string | null;
  embeddingDimensions: number | null;
  maxOutputTokens: number | null;
  expiresAt: Date;
  revokedAt: Date | null;
  scopeKind?: WebAiScopeKind;
  scopeIds?: unknown;
  manifestFingerprint?: string;
}>;

function grantMatchesRuntimeTuple(
  grant: RuntimeGrantTuple,
  input: Readonly<{ projectId: string; jobId: string; route: RuntimeRoute; billingUserId: string; billingMode: string; scopeKind?: WebAiScopeKind; scopeIds?: unknown; manifestFingerprint?: string }>,
): boolean {
  return grant.projectId === input.projectId
    && grant.operation === input.route.operation
    && grant.providerConnectionId === input.route.providerConnectionId
    && grant.modelId === input.route.modelId
    && grant.consentVersion === WEB_AI_TRANSFER_CONSENT_VERSION
    && grant.billingUserId === input.billingUserId
    && grant.billingMode === input.billingMode
    && grant.boundJobId === input.jobId
    && grant.revokedAt === null
    && grant.expiresAt > new Date()
    && grant.routeSource === input.route.source
    && grant.routeId === input.route.routeId
    && grant.routeVersion === input.route.routeVersion
    && grant.routeUpdatedAt !== null
    && grant.routeUpdatedAt.getTime() === input.route.routeUpdatedAt.getTime()
    && grant.providerConfigurationVersion === input.route.providerConfigurationVersion
    && grant.quotaMultiplierBps === input.route.quotaMultiplierBps
    && grant.routeFenceFingerprint === input.route.routeFenceFingerprint
    && grant.credentialSecretFingerprint === input.route.credentialSecretFingerprint
    && grant.payerKind === "platformCaller"
    && grant.payerProviderConnectionId === input.route.providerConnectionId
    && grant.embeddingDimensions === input.route.embeddingDimensions
    && grant.maxOutputTokens === input.route.maxOutputTokens
    && (input.scopeKind === undefined || grant.scopeKind === input.scopeKind)
    && (input.scopeIds === undefined || JSON.stringify(grant.scopeIds) === JSON.stringify(input.scopeIds))
    && (input.manifestFingerprint === undefined || grant.manifestFingerprint === input.manifestFingerprint);
}

function runtimeGrantSelect() {
  return {
    id: true,
    projectId: true,
    operation: true,
    providerConnectionId: true,
    modelId: true,
    consentVersion: true,
    billingMode: true,
    billingUserId: true,
    boundJobId: true,
    routeSource: true,
    routeId: true,
    routeVersion: true,
    routeUpdatedAt: true,
    providerConfigurationVersion: true,
    quotaMultiplierBps: true,
    routeFenceFingerprint: true,
    credentialSecretFingerprint: true,
    payerKind: true,
    payerProviderConnectionId: true,
    embeddingDimensions: true,
    maxOutputTokens: true,
    expiresAt: true,
    revokedAt: true,
    scopeKind: true,
    scopeIds: true,
    manifestFingerprint: true,
  } as const;
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
}>, db: PrismaClient = getDb()): Promise<Readonly<{ jobId: string; grantId: string; created: boolean }>> {
  assertRuntimeRoute(input.route);
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
      select: {
        id: true,
        projectId: true,
        kind: true,
        requestedById: true,
        webAiGrant: { select: runtimeGrantSelect() },
      },
    });
    if (existing !== null) {
      if (
        existing.projectId !== input.projectId
        || existing.kind !== input.kind
        || existing.requestedById !== transactionActor.id
        || existing.webAiGrant === null
        || !grantMatchesRuntimeTuple(existing.webAiGrant, {
          projectId: input.projectId,
          jobId: existing.id,
          route: input.route,
          billingUserId: transactionActor.id,
          billingMode: "platform",
          scopeKind: input.scopeKind,
          scopeIds: input.scopeIds,
          manifestFingerprint: input.manifestFingerprint,
        })
      ) throw new AiEntitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN");
      return Object.freeze({ jobId: existing.id, grantId: existing.webAiGrant.id, created: false });
    }
    const billing = await assertAiOutboundEntitlement({
      projectId: input.projectId,
      requestedById: transactionActor.id,
      route,
      db: tx,
      enforceConcurrency: true,
    });
    const jobId = randomUUID();
    const job = await tx.backgroundJob.create({
      data: {
        id: jobId,
        projectId: input.projectId,
        kind: input.kind,
        requestedById: transactionActor.id,
        webAiGrantId: null,
        idempotencyKey: key,
        payload: jsonValue(input.payload),
      },
    });
    const grant = await tx.webAiGrant.create({
      data: {
        id: randomUUID(),
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
        boundJobId: job.id,
        ...routeSnapshotData(route),
        expiresAt: new Date(Date.now() + GRANT_LIFETIME_MS),
      },
    });
    await tx.backgroundJob.update({ where: { id: job.id }, data: { webAiGrantId: grant.id } });
    if (input.afterCreate !== undefined) await input.afterCreate(tx, job.id);
    return Object.freeze({ jobId: job.id, grantId: grant.id, created: true });
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
  assertRuntimeRoute(input.route);
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
      select: { id: true, projectId: true, requestedById: true, kind: true },
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
    const supplementalScopeIds = { jobId: input.jobId, scope: input.scopeIds };
    const existing = await tx.webAiGrant.findUnique({
      where: { boundJobId_operation: { boundJobId: input.jobId, operation: route.operation } },
      select: runtimeGrantSelect(),
    });
    if (existing !== null) {
      if (!grantMatchesRuntimeTuple(existing, {
        projectId: input.projectId,
        jobId: input.jobId,
        route,
        billingUserId: billing.billingUserId,
        billingMode: billing.billingMode,
        scopeKind: input.scopeKind,
        scopeIds: supplementalScopeIds,
        manifestFingerprint: input.manifestFingerprint,
      })) throw new AiEntitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN");
      return Object.freeze({ grantId: existing.id, created: false });
    }
    const grant = await tx.webAiGrant.create({
      data: {
        id: randomUUID(),
        projectId: input.projectId,
        operation: route.operation,
        scopeKind: input.scopeKind,
        scopeIds: jsonValue(supplementalScopeIds),
        manifestFingerprint: input.manifestFingerprint,
        providerConnectionId: route.providerConnectionId,
        modelId: route.modelId,
        consentVersion: WEB_AI_TRANSFER_CONSENT_VERSION,
        issuedById: currentActor.id,
        billingMode: billing.billingMode,
        billingUserId: billing.billingUserId,
        callKey: stableAiCallKey(input.jobId, route.operation, "supplemental"),
        boundJobId: input.jobId,
        ...routeSnapshotData(route),
        expiresAt: new Date(Date.now() + GRANT_LIFETIME_MS),
      },
    });
    return Object.freeze({ grantId: grant.id, created: true });
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

/** The only provider input exposed after final admission. */
export type ProviderDispatchContext = Readonly<{
  connection: Readonly<AiProviderConnection & {
    /** Non-secret credential fence; transport rechecks it before fetch. */
    credentialSecretFingerprint: string;
  }>;
  operation: AiOperation;
  modelId: string;
  maxOutputTokens: number;
  providerCallAuditId: string;
  webAiGrantId: string;
  reservationId: string | null;
  routeFenceFingerprint: string;
}>;

export async function auditedProviderCall<T>(input: Readonly<{
  jobId: string;
  attempt: JobAttemptClaim;
  actor: WebAiActor;
  route: RuntimeRoute;
  grantId: string;
  operation?: AiOperation;
  callKey: string;
  requestPayload?: unknown;
  maxOutputTokens?: number;
  call: (dispatch: ProviderDispatchContext) => Promise<Readonly<T & {
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
  providerCallAuditId: string;
  webAiGrantId: string;
  routeFenceFingerprint: string;
  }> {
  assertRuntimeRoute(input.route);
  if (!/^[0-9a-f-]{36}$/u.test(input.grantId)) {
    throw new AiEntitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN");
  }
  if (input.operation !== undefined && input.operation !== input.route.operation) {
    throw new AiEntitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN");
  }
  const operation = input.route.operation;
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
  const requestedMaxOutputTokens = input.maxOutputTokens ?? input.route.maxOutputTokens;
  if (!Number.isSafeInteger(requestedMaxOutputTokens) || requestedMaxOutputTokens < 1 || requestedMaxOutputTokens > input.route.maxOutputTokens) {
    throw new AiEntitlementError("AI_MODEL_CAPABILITY_MISMATCH");
  }
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
          rawEstimatedTokens: estimatePlatformTokens(input.requestPayload ?? { operation, modelId: input.route.modelId }, requestedMaxOutputTokens),
          webAiGrantId: input.grantId,
          webAiGrantProjectId: input.route.projectId,
          routeSnapshot: input.route,
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
      const credential = await tx.externalCredential.findUnique({
        where: { id: provider.credentialId },
        select: { kind: true, secretFingerprint: true },
      });
      if (
        credential === null
        || credential.kind !== "aiProvider"
        || !/^[0-9a-f]{64}$/u.test(credential.secretFingerprint)
        || credential.secretFingerprint !== persistedRoute.credentialSecretFingerprint
      ) {
        throw new AiEntitlementError("AI_PROVIDER_CONNECTION_UNAVAILABLE");
      }
      const dispatchProvider = Object.freeze({
        ...provider,
        credentialSecretFingerprint: credential.secretFingerprint,
      });
      const dispatchRoute: DispatchRoute = { ...persistedRoute, providerConnection: dispatchProvider };
      const finalBilling = await assertAiOutboundEntitlement({
        projectId: input.route.projectId,
        requestedById: accessAdmission.access.actor.id,
        route: dispatchRoute,
        operation,
        db: tx,
        enforceConcurrency: false,
      });
      // The grant id is explicit at the call boundary. A job's primary grant
      // relation is not a valid substitute because RAG/brief/agent calls also
      // use operation-specific supplemental grants.
      const grant = await tx.webAiGrant.findUnique({
        where: { id: input.grantId },
        select: runtimeGrantSelect(),
      });
      if (
        grant === null
        || !grantMatchesRuntimeTuple(grant, {
          projectId: input.route.projectId,
          jobId: input.jobId,
          route: dispatchRoute,
          billingUserId: accessAdmission.access.actor.id,
          billingMode: finalBilling.billingMode,
        })
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
          jobId: input.jobId,
          operation,
          modelId: dispatchRoute.modelId,
          webAiGrantId: grant.id,
          routeFenceFingerprint: dispatchRoute.routeFenceFingerprint,
          quotaMultiplierBps: dispatchRoute.quotaMultiplierBps,
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
            webAiGrantId: grant.id,
            webAiGrantReferenceId: grant.id,
            webAiGrantProjectId: input.route.projectId,
            providerConnectionId: provider.id,
            operation,
            modelId: persistedRoute.modelId,
            billingMode: finalBilling.billingMode,
            billingUserId: finalBilling.billingUserId,
            callKey: input.callKey,
            reservationId: reservation?.reservationId ?? null,
            routeSource: dispatchRoute.source,
            routeId: dispatchRoute.routeId,
            routeVersion: dispatchRoute.routeVersion,
            routeUpdatedAt: dispatchRoute.routeUpdatedAt,
            providerConfigurationVersion: dispatchRoute.providerConfigurationVersion,
            quotaMultiplierBps: dispatchRoute.quotaMultiplierBps,
            routeFenceFingerprint: dispatchRoute.routeFenceFingerprint,
            credentialSecretFingerprint: credential.secretFingerprint,
            payerKind: "platformCaller",
            payerProviderConnectionId: dispatchRoute.providerConnectionId,
            embeddingDimensions: dispatchRoute.embeddingDimensions,
            maxOutputTokens: dispatchRoute.maxOutputTokens,
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
      const dispatch: ProviderDispatchContext = Object.freeze({
        connection: dispatchProvider,
        operation,
        modelId: dispatchRoute.modelId,
        maxOutputTokens: requestedMaxOutputTokens,
        providerCallAuditId: audit.id,
        webAiGrantId: grant.id,
        reservationId: reservation?.reservationId ?? null,
        routeFenceFingerprint: dispatchRoute.routeFenceFingerprint,
      });
      return Object.freeze({ auditId: audit.id, grantId: grant.id, billing: finalBilling, dispatch, dispatchMarked: accessAdmission.dispatchMarked });
    });
    auditId = admitted.auditId;
    dispatchMarked = admitted.dispatchMarked;
    networkStarted = true;
    const result = await input.call(admitted.dispatch);
    await markProviderAcknowledged({ jobId: input.jobId, ...input.attempt }, db);
    if (reservation !== null && reservation.created) {
      const settled = await settlePlatformTokenReservation({
        userId: admitted.billing.billingUserId,
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
    return Object.freeze({
      ...result,
      providerCallAuditId: admitted.auditId,
      webAiGrantId: admitted.grantId,
      routeFenceFingerprint: admitted.dispatch.routeFenceFingerprint,
    });
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
