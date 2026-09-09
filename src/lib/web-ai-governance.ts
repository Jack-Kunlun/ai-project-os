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
import {
  withWebAiProjectAccessTransaction,
  type ProjectAccessAdmission,
} from "@/lib/access-linearization";
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
import { isProjectAiRuntimeOperation } from "@/lib/project-ai-runtime-capabilities";
import {
  consumeWebAiConfirmation,
  normalizeWebAiConfirmationId,
  validateWebAiConfirmation,
  type WebAiConfirmationExecuteInput,
  WebAiConfirmationError,
} from "@/lib/web-ai-confirmation";

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

type RuntimeDatabase = PrismaClient | Prisma.TransactionClient;

/**
 * PostgreSQL jsonb does not preserve object key insertion order. Canonicalize
 * only strict JSON values before comparing persisted grant scopes, while
 * keeping array order and primitive types exact. Anything outside JSON is
 * rejected instead of allowing JSON.stringify to coerce or omit it.
 */
function canonicalJson(value: unknown): string | null {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return JSON.stringify(value);
  }
  if (typeof value !== "object") return null;

  try {
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return null;
      const keys = Object.keys(value);
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) return null;
      const items = keys.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined
          ? null
          : canonicalJson(descriptor.value);
      });
      if (items.some((item) => item === null)) return null;
      return `[${items.join(",")}]`;
    }
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) return null;
    const keys = Object.keys(value).sort();
    if (keys.length !== ownKeys.length) return null;
    const entries = keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      const child = descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined
        ? null
        : canonicalJson(descriptor.value);
      return child === null ? null : `${JSON.stringify(key)}:${child}`;
    });
    if (entries.some((entry) => entry === null)) return null;
    return `{${entries.join(",")}}`;
  } catch {
    return null;
  }
}

/** @internal Focused contract coverage for the strict grant-scope comparator. */
export function canonicalJsonScopeEqual(left: unknown, right: unknown): boolean {
  const leftCanonical = canonicalJson(left);
  const rightCanonical = canonicalJson(right);
  return leftCanonical !== null && rightCanonical !== null && leftCanonical === rightCanonical;
}

function isFiniteDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isPersonalRuntimeRoute(route: RuntimeRoute): route is RuntimeRoute & {
  source: "personal_delegation";
  personalEvidence: NonNullable<RuntimeRoute["personalEvidence"]>;
} {
  return route.source === "personal_delegation" && route.personalEvidence !== null;
}

/**
 * The 1200 migration owns the complete personal-memory evidence predicate.
 * Keep the application check as a parameterized call to that predicate rather
 * than copying its joins into TypeScript, so reads and dispatch share the same
 * fail-closed definition after an upstream revoke, expiry, or drift.
 */
export async function isPersonalMemoryGenerationLive(
  generationId: string,
  db: RuntimeDatabase,
  requireComplete = true,
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/u.test(generationId)) return false;
  try {
    const rows = await db.$queryRaw<Array<{ live: boolean }>>`
      SELECT "personal_memory_frozen_evidence_valid"(${generationId}::uuid, ${requireComplete}) AS live
    `;
    return rows[0]?.live === true;
  } catch {
    // A missing/unavailable authority function must never make an index look
    // live. Callers turn false into their stable not-ready/denied result.
    return false;
  }
}

export type PersonalMemoryDispatchEvidence = Readonly<{
  generationId: string;
  mode: "build" | "consume";
}>;

async function isPersonalMemoryDispatchAdmissible(
  evidence: PersonalMemoryDispatchEvidence,
  input: Readonly<{ projectId: string; jobId: string; grantId: string }>,
  db: RuntimeDatabase,
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/u.test(evidence.generationId)) return false;
  try {
    const rows = await db.$queryRaw<Array<{ valid: boolean }>>`
      SELECT "personal_memory_dispatch_evidence_valid"(
        ${evidence.generationId}::uuid,
        ${input.projectId}::uuid,
        ${input.jobId}::uuid,
        ${input.grantId}::uuid,
        ${evidence.mode}
      ) AS valid
    `;
    return rows[0]?.valid === true;
  } catch {
    return false;
  }
}

function hasCompletePersonalEvidence(route: RuntimeRoute): boolean {
  const evidence = route.personalEvidence;
  if (evidence === null || !isProjectAiRuntimeOperation(route.operation)) return false;
  const identifiers = [
    evidence.personalDelegationId,
    evidence.effectiveRouteSelectionId,
    evidence.payerProviderConnectionId,
    evidence.connectionOwnerId,
    evidence.billingUserId,
    evidence.ownerProjectMembershipId,
    evidence.ownerSubscriptionId,
    evidence.projectConfirmedById,
    evidence.projectConfirmedProjectMembershipId,
    evidence.selectedById,
    evidence.selectedByProjectMembershipId,
  ];
  if (identifiers.some((value) => typeof value !== "string" || value.length === 0)) return false;
  if (
    evidence.payerKind !== "personal_connection_owner"
    || evidence.personalDelegationVersion < 1
    || evidence.effectiveRouteSelectionVersion < 1
    || evidence.ownerSubscriptionVersion < 1
    || !isFiniteDate(evidence.effectiveRouteSelectionUpdatedAt)
    || !isFiniteDate(evidence.ownerMembershipCreatedAt)
    || !isFiniteDate(evidence.ownerSubscriptionStartsAt)
    || !isFiniteDate(evidence.ownerSubscriptionExpiresAt)
    || !isFiniteDate(evidence.projectConfirmedMembershipCreatedAt)
    || !isFiniteDate(evidence.selectedByMembershipCreatedAt)
    || !/^[0-9a-f]{64}$/u.test(evidence.personalDelegationFingerprint)
    || !/^[0-9a-f]{64}$/u.test(evidence.credentialSecretFingerprint)
    || !Number.isSafeInteger(evidence.connectionOwnerAccountAccessVersion)
    || evidence.connectionOwnerAccountAccessVersion < 1
    || evidence.connectionOwnerId !== evidence.billingUserId
    || evidence.payerProviderConnectionId.length === 0
  ) return false;
  if (route.operation === "embedding") {
    return evidence.embeddingDimensions !== null
      && Number.isSafeInteger(evidence.embeddingDimensions)
      && evidence.embeddingDimensions >= 8
      && evidence.embeddingDimensions <= 8192
      && evidence.maxOutputTokens === null
      && route.maxOutputTokens === 128;
  }
  return evidence.embeddingDimensions === null
    && typeof evidence.maxOutputTokens === "number"
    && Number.isSafeInteger(evidence.maxOutputTokens)
    && evidence.maxOutputTokens >= 1
    && evidence.maxOutputTokens <= 65_536
    && route.maxOutputTokens === evidence.maxOutputTokens;
}

function hasCompleteRouteSnapshot(route: RuntimeRoute): boolean {
  const common = route.routeUpdatedAt instanceof Date
    && Number.isFinite(route.routeUpdatedAt.getTime())
    && Number.isSafeInteger(route.providerConfigurationVersion)
    && route.providerConfigurationVersion > 0
    && Number.isSafeInteger(route.quotaMultiplierBps)
    && route.quotaMultiplierBps >= 1
    && route.quotaMultiplierBps <= 100_000
    && typeof route.credentialSecretFingerprint === "string"
    && /^[0-9a-f]{64}$/u.test(route.credentialSecretFingerprint)
    && typeof route.routeFenceFingerprint === "string"
    && /^[0-9a-f]{64}$/u.test(route.routeFenceFingerprint);
  if (!common) return false;
  if (isPersonalRuntimeRoute(route)) {
    return typeof route.routeId === "string"
      && route.routeId.length > 0
      && Number.isSafeInteger(route.routeVersion)
      && (route.routeVersion ?? 0) > 0
      && route.quotaMultiplierBps === 10_000
      && hasCompletePersonalEvidence(route);
  }
  return (route.source === "project_override" || route.source === "platform_default")
    && (route.source === "platform_default"
      ? typeof route.routeId === "string" && route.routeId.length > 0 && Number.isSafeInteger(route.routeVersion) && (route.routeVersion ?? 0) > 0
      : route.routeId === null && route.routeVersion === null);
}

function assertRuntimeRoute(route: RuntimeRoute): void {
  if (!hasCompleteRouteSnapshot(route)) {
    throw new AiEntitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN");
  }
  if (isPersonalRuntimeRoute(route)) {
    if (
      route.providerConnection.scope !== "user"
      || route.providerConnection.ownershipState !== "confirmed"
      || route.providerConnection.workspaceId !== null
      || route.providerConnection.ownerUserId !== route.personalEvidence.connectionOwnerId
      || route.personalEvidence.payerProviderConnectionId !== route.providerConnectionId
    ) throw new AiEntitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN");
    return;
  }
  if (
    route.providerConnection.scope !== "platform"
    || route.providerConnection.ownershipState !== "confirmed"
    || route.providerConnection.workspaceId !== null
    || route.providerConnection.ownerUserId !== null
  ) throw new AiEntitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN");
}

function personalEvidenceMatches(
  left: NonNullable<RuntimeRoute["personalEvidence"]>,
  right: NonNullable<RuntimeRoute["personalEvidence"]>,
): boolean {
  return JSON.stringify({
    ...left,
    effectiveRouteSelectionUpdatedAt: left.effectiveRouteSelectionUpdatedAt.toISOString(),
    ownerMembershipCreatedAt: left.ownerMembershipCreatedAt.toISOString(),
    ownerSubscriptionStartsAt: left.ownerSubscriptionStartsAt.toISOString(),
    ownerSubscriptionExpiresAt: left.ownerSubscriptionExpiresAt.toISOString(),
    projectConfirmedMembershipCreatedAt: left.projectConfirmedMembershipCreatedAt.toISOString(),
    selectedByMembershipCreatedAt: left.selectedByMembershipCreatedAt.toISOString(),
  }) === JSON.stringify({
    ...right,
    effectiveRouteSelectionUpdatedAt: right.effectiveRouteSelectionUpdatedAt.toISOString(),
    ownerMembershipCreatedAt: right.ownerMembershipCreatedAt.toISOString(),
    ownerSubscriptionStartsAt: right.ownerSubscriptionStartsAt.toISOString(),
    ownerSubscriptionExpiresAt: right.ownerSubscriptionExpiresAt.toISOString(),
    projectConfirmedMembershipCreatedAt: right.projectConfirmedMembershipCreatedAt.toISOString(),
    selectedByMembershipCreatedAt: right.selectedByMembershipCreatedAt.toISOString(),
  });
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
    && routeSnapshotsEqual(left, right)
    && (left.personalEvidence === null
      ? right.personalEvidence === null
      : right.personalEvidence !== null && personalEvidenceMatches(left.personalEvidence, right.personalEvidence));
}

function personalRouteSnapshotData(route: RuntimeRoute & {
  source: "personal_delegation";
  personalEvidence: NonNullable<RuntimeRoute["personalEvidence"]>;
}) {
  const snapshot = effectiveAiRouteSnapshot(route as EffectiveAiRoute);
  const evidence = route.personalEvidence;
  return {
    routeSource: snapshot.routeSource,
    routeId: snapshot.routeId,
    routeVersion: snapshot.routeVersion,
    routeUpdatedAt: snapshot.routeUpdatedAt,
    providerConfigurationVersion: snapshot.providerConfigurationVersion,
    quotaMultiplierBps: snapshot.quotaMultiplierBps,
    routeFenceFingerprint: snapshot.routeFenceFingerprint,
    credentialSecretFingerprint: evidence.credentialSecretFingerprint,
    personalDelegationId: evidence.personalDelegationId,
    personalDelegationVersion: evidence.personalDelegationVersion,
    personalDelegationFingerprint: evidence.personalDelegationFingerprint,
    effectiveRouteSelectionId: evidence.effectiveRouteSelectionId,
    effectiveRouteSelectionVersion: evidence.effectiveRouteSelectionVersion,
    effectiveRouteSelectionUpdatedAt: evidence.effectiveRouteSelectionUpdatedAt,
    payerKind: "personalConnectionOwner" as const,
    payerProviderConnectionId: evidence.payerProviderConnectionId,
    ownerProjectMembershipId: evidence.ownerProjectMembershipId,
    ownerMembershipCreatedAt: evidence.ownerMembershipCreatedAt,
    ownerSubscriptionId: evidence.ownerSubscriptionId,
    ownerSubscriptionVersion: evidence.ownerSubscriptionVersion,
    ownerSubscriptionStartsAt: evidence.ownerSubscriptionStartsAt,
    ownerSubscriptionExpiresAt: evidence.ownerSubscriptionExpiresAt,
    projectConfirmedById: evidence.projectConfirmedById,
    projectConfirmedProjectMembershipId: evidence.projectConfirmedProjectMembershipId,
    projectConfirmedMembershipCreatedAt: evidence.projectConfirmedMembershipCreatedAt,
    selectedById: evidence.selectedById,
    selectedByProjectMembershipId: evidence.selectedByProjectMembershipId,
    selectedByMembershipCreatedAt: evidence.selectedByMembershipCreatedAt,
    connectionOwnerAccountAccessVersion: evidence.connectionOwnerAccountAccessVersion,
    embeddingDimensions: evidence.embeddingDimensions,
    maxOutputTokens: evidence.maxOutputTokens,
  };
}

function platformRouteSnapshotData(route: RuntimeRoute) {
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

function routeSnapshotData(route: RuntimeRoute) {
  return isPersonalRuntimeRoute(route)
    ? personalRouteSnapshotData(route)
    : platformRouteSnapshotData(route);
}

type RuntimeBilling = Readonly<{
  billingMode: "platform" | "byok";
  billingUserId: string;
  reservationRequired: boolean;
}>;

async function assertRuntimeBilling(input: Readonly<{
  projectId: string;
  requestedById: string;
  route: RuntimeRoute;
  operation?: AiOperation;
  db: PrismaClient | Prisma.TransactionClient;
  enforceConcurrency?: boolean;
}>): Promise<RuntimeBilling> {
  if (isPersonalRuntimeRoute(input.route)) {
    if (input.operation !== undefined && input.operation !== input.route.operation) {
      throw new AiEntitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN");
    }
    return Object.freeze({
      billingMode: "byok",
      billingUserId: input.route.personalEvidence.billingUserId,
      reservationRequired: false,
    });
  }
  return assertAiOutboundEntitlement(input);
}

async function personalGrantExpiresAt(
  tx: Prisma.TransactionClient,
  route: RuntimeRoute,
  grantExpiresAtCap?: unknown,
): Promise<Date> {
  const now = new Date();
  let normalExpiresAt = new Date(now.getTime() + GRANT_LIFETIME_MS);
  if (isPersonalRuntimeRoute(route)) {
    const delegation = await tx.projectAiProviderDelegation.findUnique({
      where: { id: route.personalEvidence.personalDelegationId },
      select: { expiresAt: true },
    });
    if (delegation === null || delegation.expiresAt <= now) {
      throw new AiEntitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN");
    }
    normalExpiresAt = new Date(Math.min(normalExpiresAt.getTime(), delegation.expiresAt.getTime()));
  }
  return applyGrantExpiresAtCap(normalExpiresAt, grantExpiresAtCap);
}

/**
 * Apply an internal, pre-authorized expiry cap without ever extending the
 * normal grant lifetime.  The cap is deliberately runtime-validated because
 * this service is also callable from test and worker code outside TypeScript's
 * static type boundary.
 */
export function applyGrantExpiresAtCap(normalExpiresAt: Date, cap: unknown): Date {
  if (cap === undefined) return normalExpiresAt;
  if (!isFiniteDate(normalExpiresAt) || !isFiniteDate(cap)) {
    throw new AiEntitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN");
  }
  const now = Date.now();
  if (cap.getTime() <= now || cap.getTime() > normalExpiresAt.getTime()) {
    throw new AiEntitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN");
  }
  return new Date(cap.getTime());
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
  confirmationChallengeId: string | null;
  payerKind: string | null;
  payerProviderConnectionId: string | null;
  personalDelegationId: string | null;
  personalDelegationVersion: number | null;
  personalDelegationFingerprint: string | null;
  effectiveRouteSelectionId: string | null;
  effectiveRouteSelectionVersion: number | null;
  effectiveRouteSelectionUpdatedAt: Date | null;
  ownerProjectMembershipId: string | null;
  ownerMembershipCreatedAt: Date | null;
  ownerSubscriptionId: string | null;
  ownerSubscriptionVersion: number | null;
  ownerSubscriptionStartsAt: Date | null;
  ownerSubscriptionExpiresAt: Date | null;
  projectConfirmedById: string | null;
  projectConfirmedProjectMembershipId: string | null;
  projectConfirmedMembershipCreatedAt: Date | null;
  selectedById: string | null;
  selectedByProjectMembershipId: string | null;
  selectedByMembershipCreatedAt: Date | null;
  connectionOwnerAccountAccessVersion: number | null;
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
  input: Readonly<{ projectId: string; jobId: string; route: RuntimeRoute; billingUserId: string; billingMode: string; scopeKind?: WebAiScopeKind; scopeIds?: unknown; manifestFingerprint?: string; confirmationChallengeId?: string }>,
): boolean {
  const common = grant.projectId === input.projectId
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
    && (input.confirmationChallengeId === undefined || grant.confirmationChallengeId === input.confirmationChallengeId)
    && (input.scopeKind === undefined || grant.scopeKind === input.scopeKind)
    && (input.scopeIds === undefined || canonicalJsonScopeEqual(grant.scopeIds, input.scopeIds))
    && (input.manifestFingerprint === undefined || grant.manifestFingerprint === input.manifestFingerprint);
  if (!common) return false;
  if (!isPersonalRuntimeRoute(input.route)) {
    return grant.payerKind === "platformCaller"
      && grant.payerProviderConnectionId === input.route.providerConnectionId
      && [
        grant.personalDelegationId,
        grant.personalDelegationVersion,
        grant.personalDelegationFingerprint,
        grant.effectiveRouteSelectionId,
        grant.effectiveRouteSelectionVersion,
        grant.effectiveRouteSelectionUpdatedAt,
        grant.ownerProjectMembershipId,
        grant.ownerMembershipCreatedAt,
        grant.ownerSubscriptionId,
        grant.ownerSubscriptionVersion,
        grant.ownerSubscriptionStartsAt,
        grant.ownerSubscriptionExpiresAt,
        grant.projectConfirmedById,
        grant.projectConfirmedProjectMembershipId,
        grant.projectConfirmedMembershipCreatedAt,
        grant.selectedById,
        grant.selectedByProjectMembershipId,
        grant.selectedByMembershipCreatedAt,
        grant.connectionOwnerAccountAccessVersion,
      ].every((value) => value === null)
      && grant.embeddingDimensions === input.route.embeddingDimensions
      && grant.maxOutputTokens === input.route.maxOutputTokens;
  }
  const evidence = input.route.personalEvidence;
  const sameDate = (left: Date | null, right: Date): boolean => left !== null && left.getTime() === right.getTime();
  return grant.payerKind === "personalConnectionOwner"
    && grant.payerProviderConnectionId === evidence.payerProviderConnectionId
    && grant.personalDelegationId === evidence.personalDelegationId
    && grant.personalDelegationVersion === evidence.personalDelegationVersion
    && grant.personalDelegationFingerprint === evidence.personalDelegationFingerprint
    && grant.effectiveRouteSelectionId === evidence.effectiveRouteSelectionId
    && grant.effectiveRouteSelectionVersion === evidence.effectiveRouteSelectionVersion
    && sameDate(grant.effectiveRouteSelectionUpdatedAt, evidence.effectiveRouteSelectionUpdatedAt)
    && grant.ownerProjectMembershipId === evidence.ownerProjectMembershipId
    && sameDate(grant.ownerMembershipCreatedAt, evidence.ownerMembershipCreatedAt)
    && grant.ownerSubscriptionId === evidence.ownerSubscriptionId
    && grant.ownerSubscriptionVersion === evidence.ownerSubscriptionVersion
    && sameDate(grant.ownerSubscriptionStartsAt, evidence.ownerSubscriptionStartsAt)
    && sameDate(grant.ownerSubscriptionExpiresAt, evidence.ownerSubscriptionExpiresAt)
    && grant.projectConfirmedById === evidence.projectConfirmedById
    && grant.projectConfirmedProjectMembershipId === evidence.projectConfirmedProjectMembershipId
    && sameDate(grant.projectConfirmedMembershipCreatedAt, evidence.projectConfirmedMembershipCreatedAt)
    && grant.selectedById === evidence.selectedById
    && grant.selectedByProjectMembershipId === evidence.selectedByProjectMembershipId
    && sameDate(grant.selectedByMembershipCreatedAt, evidence.selectedByMembershipCreatedAt)
    && grant.connectionOwnerAccountAccessVersion === evidence.connectionOwnerAccountAccessVersion
    && grant.embeddingDimensions === evidence.embeddingDimensions
    && grant.maxOutputTokens === evidence.maxOutputTokens;
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
    confirmationChallengeId: true,
    payerKind: true,
    payerProviderConnectionId: true,
    personalDelegationId: true,
    personalDelegationVersion: true,
    personalDelegationFingerprint: true,
    effectiveRouteSelectionId: true,
    effectiveRouteSelectionVersion: true,
    effectiveRouteSelectionUpdatedAt: true,
    ownerProjectMembershipId: true,
    ownerMembershipCreatedAt: true,
    ownerSubscriptionId: true,
    ownerSubscriptionVersion: true,
    ownerSubscriptionStartsAt: true,
    ownerSubscriptionExpiresAt: true,
    projectConfirmedById: true,
    projectConfirmedProjectMembershipId: true,
    projectConfirmedMembershipCreatedAt: true,
    selectedById: true,
    selectedByProjectMembershipId: true,
    selectedByMembershipCreatedAt: true,
    connectionOwnerAccountAccessVersion: true,
    embeddingDimensions: true,
    maxOutputTokens: true,
    expiresAt: true,
    revokedAt: true,
    scopeKind: true,
    scopeIds: true,
    manifestFingerprint: true,
  } as const;
}

/**
 * Rejoin the access/job/provider fences after the durable dispatch marker has
 * committed and immediately before a provider transport reads a credential or
 * attaches a request to the network.  The admission transaction deliberately
 * performs no secret or network I/O; this second transaction is the final
 * fresh decision for the in-process connection object.
 */
async function revalidateProviderDispatchBeforeTransport(input: Readonly<{
  actor: WebAiActor;
  projectId: string;
  jobId: string;
  attempt: JobAttemptClaim;
  route: DispatchRoute;
  grantId: string;
  auditId: string;
  callKey: string;
  billing: RuntimeBilling;
}>, db: PrismaClient): Promise<void> {
  try {
    const additionalActorIds = typeof input.route.providerConnection.ownerUserId !== "string"
      ? []
      : [input.route.providerConnection.ownerUserId];
    await withProjectJobAccessTransaction(db, {
      actor: input.actor,
      projectId: input.projectId,
      jobId: input.jobId,
      required: "edit",
      expectedRequestedById: input.actor.id,
      additionalActorIds,
      attempt: { jobId: input.jobId, ...input.attempt },
    }, async (tx, accessAdmission) => {
      if (accessAdmission.attempt === null) {
        throw new ProviderTransportError("AI_PROVIDER_UNAVAILABLE", 409, false);
      }
      const marker = await tx.backgroundJobAttempt.findUnique({
        where: { id: input.attempt.attemptId },
        select: { jobId: true, dispatchState: true },
      });
      if (marker === null || marker.jobId !== input.jobId || marker.dispatchState !== "dispatched") {
        throw new ProviderTransportError("AI_PROVIDER_UNAVAILABLE", 409, false);
      }

      // Reload the effective route and provider under their lifecycle locks;
      // the object captured at admission is only a routing hint. This also
      // rechecks personal owner membership/subscription/access epochs.
      const persistedRoute = await reloadDispatchRoute(tx, {
        projectId: input.projectId,
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
        || credential.secretFingerprint !== input.route.credentialSecretFingerprint
      ) {
        throw new ProviderTransportError("AI_PROVIDER_UNAVAILABLE", 409, false);
      }
      const dispatchRoute: DispatchRoute = {
        ...persistedRoute,
        providerConnection: Object.freeze({ ...provider, credentialSecretFingerprint: credential.secretFingerprint }),
      };
      const grant = await tx.webAiGrant.findUnique({
        where: { id: input.grantId },
        select: runtimeGrantSelect(),
      });
      if (
        grant === null
        || !grantMatchesRuntimeTuple(grant, {
          projectId: input.projectId,
          jobId: input.jobId,
          route: dispatchRoute,
          billingUserId: input.billing.billingUserId,
          billingMode: input.billing.billingMode,
        })
      ) {
        throw new ProviderTransportError("AI_PROVIDER_UNAVAILABLE", 409, false);
      }
      const audit = await tx.providerCallAudit.findUnique({
        where: { id: input.auditId },
        select: {
          jobId: true,
          webAiGrantId: true,
          providerConnectionId: true,
          operation: true,
          billingMode: true,
          billingUserId: true,
          callKey: true,
          routeFenceFingerprint: true,
          credentialSecretFingerprint: true,
          connectionOwnerAccountAccessVersion: true,
          status: true,
        },
      });
      if (
        audit === null
        || audit.status !== "running"
        || audit.jobId !== input.jobId
        || audit.webAiGrantId !== input.grantId
        || audit.providerConnectionId !== provider.id
        || audit.operation !== dispatchRoute.operation
        || audit.billingMode !== input.billing.billingMode
        || audit.billingUserId !== input.billing.billingUserId
        || audit.callKey !== input.callKey
        || audit.routeFenceFingerprint !== dispatchRoute.routeFenceFingerprint
        || audit.credentialSecretFingerprint !== credential.secretFingerprint
        || audit.connectionOwnerAccountAccessVersion !== (dispatchRoute.personalEvidence?.connectionOwnerAccountAccessVersion ?? null)
      ) {
        throw new ProviderTransportError("AI_PROVIDER_UNAVAILABLE", 409, false);
      }
    });
  } catch (error) {
    // This callback is invoked before credential or request I/O. Preserve the
    // explicit pre-dispatch classification for all stale/revoked/drifted
    // control-plane outcomes so the caller can safely release its reservation.
    if (error instanceof ProviderTransportError && error.requestDispatched === false) throw error;
    throw new ProviderTransportError("AI_PROVIDER_UNAVAILABLE", 409, false);
  }
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
  /** Internal-only cap; public HTTP routes never derive or forward this field. */
  grantExpiresAtCap?: Date;
  confirmation?: WebAiConfirmationExecuteInput;
  /** Rebuild the confirmation material while the admission locks are held. */
  refreshConfirmation?: (
    tx: Prisma.TransactionClient,
    admission: ProjectAccessAdmission,
    route: RuntimeRoute,
  ) => Promise<WebAiConfirmationExecuteInput>;
  supplemental?: Readonly<{
    route: RuntimeRoute;
    scopeKind: WebAiScopeKind;
    scopeIds: unknown;
    manifestFingerprint: string;
  }>;
  /**
   * Run DB-only admission checks after the route is reloaded while the
   * project access locks are held, before idempotency lookup or job/grant
   * creation. This seam is intentionally inside the transaction so legacy
   * route writes and runtime job creation observe one linearized decision.
   */
  beforeCreate?: (tx: Prisma.TransactionClient, admission: ProjectAccessAdmission) => Promise<void>;
  /**
   * A kind-specific resource can be created while the grant/job transaction
   * is still open. Memory index candidates use this seam to hold the project
   * admission lock and create their generation atomically with the job.
   */
  afterCreate?: (tx: Prisma.TransactionClient, jobId: string, grantId: string) => Promise<void>;
}>, db: PrismaClient = getDb()): Promise<Readonly<{ jobId: string; grantId: string; created: boolean }>> {
  assertRuntimeRoute(input.route);
  return withWebAiProjectAccessTransaction(db, {
    actor: input.requestedBy,
    projectId: input.projectId,
    required: "edit",
    additionalActorIds: typeof input.route.providerConnection.ownerUserId === "string"
      ? [input.route.providerConnection.ownerUserId]
      : [],
  }, async (tx, admission) => {
    const transactionActor = admission.actor;
    const route = await reloadRuntimeRoute(tx, { projectId: input.projectId, route: input.route });
    if (input.beforeCreate !== undefined) await input.beforeCreate(tx, admission);
    const confirmationInput = input.refreshConfirmation === undefined
      ? input.confirmation
      : await input.refreshConfirmation(tx, admission, route);
    if (confirmationInput === undefined) throw new WebAiConfirmationError("WEB_AI_CONFIRMATION_REQUIRED");
    const confirmation = await validateWebAiConfirmation(tx, admission, confirmationInput);
    if (confirmation.row.consumedJobId !== null) {
      const recovered = await tx.backgroundJob.findUnique({
        where: { id: confirmation.row.consumedJobId },
        select: { id: true, projectId: true, requestedById: true, webAiGrantId: true },
      });
      if (
        recovered === null
        || recovered.projectId !== input.projectId
        || recovered.requestedById !== transactionActor.id
        || recovered.webAiGrantId === null
      ) return fail("WEB_AI_JOB_NOT_FOUND");
      const recoveredGrant = await tx.webAiGrant.findUnique({
        where: { id: recovered.webAiGrantId },
        select: runtimeGrantSelect(),
      });
      if (
        recoveredGrant === null
        || recoveredGrant.confirmationChallengeId !== confirmation.row.id
        || !grantMatchesRuntimeTuple(recoveredGrant, {
          projectId: input.projectId,
          jobId: recovered.id,
          route,
          billingUserId: isPersonalRuntimeRoute(route) ? route.personalEvidence.billingUserId : transactionActor.id,
          billingMode: isPersonalRuntimeRoute(route) ? "byok" : "platform",
          scopeKind: input.scopeKind,
          scopeIds: input.scopeIds,
          manifestFingerprint: input.manifestFingerprint,
          confirmationChallengeId: confirmation.row.id,
        })
      ) return fail("WEB_AI_JOB_NOT_FOUND");
      if (input.supplemental !== undefined) {
        const supplementalRoute = await reloadRuntimeRoute(tx, {
          projectId: input.projectId,
          route: input.supplemental.route,
        });
        assertRuntimeRoute(supplementalRoute);
        const supplementalBilling = await assertRuntimeBilling({
          projectId: input.projectId,
          requestedById: transactionActor.id,
          route: supplementalRoute,
          db: tx,
          enforceConcurrency: false,
        });
        const supplementalGrant = await tx.webAiGrant.findUnique({
          where: { boundJobId_operation: { boundJobId: recovered.id, operation: supplementalRoute.operation } },
          select: runtimeGrantSelect(),
        });
        if (
          supplementalGrant === null
          || !grantMatchesRuntimeTuple(supplementalGrant, {
            projectId: input.projectId,
            jobId: recovered.id,
            route: supplementalRoute,
            billingUserId: supplementalBilling.billingUserId,
            billingMode: supplementalBilling.billingMode,
            scopeKind: input.supplemental.scopeKind,
            scopeIds: { jobId: recovered.id, scope: input.supplemental.scopeIds },
            manifestFingerprint: input.supplemental.manifestFingerprint,
            confirmationChallengeId: confirmation.row.id,
          })
        ) return fail("WEB_AI_JOB_NOT_FOUND");
      }
      return Object.freeze({ jobId: recovered.id, grantId: recoveredGrant.id, created: false });
    }
    const key = idempotencyKey(input.kind, input.projectId, transactionActor.id, input.clientKey);
    const personal = isPersonalRuntimeRoute(route);
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
          route,
          billingUserId: personal ? route.personalEvidence.billingUserId : transactionActor.id,
          billingMode: personal ? "byok" : "platform",
          scopeKind: input.scopeKind,
          scopeIds: input.scopeIds,
          manifestFingerprint: input.manifestFingerprint,
          confirmationChallengeId: confirmation.row.id,
        })
      ) throw new AiEntitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN");
      await consumeWebAiConfirmation(tx, confirmation, existing.id, transactionActor.id);
      return Object.freeze({ jobId: existing.id, grantId: existing.webAiGrant.id, created: false });
    }
    const billing = await assertRuntimeBilling({
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
        confirmationChallengeId: confirmation.row.id,
        ...routeSnapshotData(route),
        expiresAt: await personalGrantExpiresAt(tx, route, input.grantExpiresAtCap),
      },
    });
    await tx.backgroundJob.update({ where: { id: job.id }, data: { webAiGrantId: grant.id } });
    if (input.supplemental !== undefined) {
      const supplementalRoute = await reloadRuntimeRoute(tx, {
        projectId: input.projectId,
        route: input.supplemental.route,
      });
      assertRuntimeRoute(supplementalRoute);
      const supplementalBilling = await assertRuntimeBilling({
        projectId: input.projectId,
        requestedById: transactionActor.id,
        route: supplementalRoute,
        db: tx,
        enforceConcurrency: false,
      });
      const supplementalScopeIds = { jobId: job.id, scope: input.supplemental.scopeIds };
      await tx.webAiGrant.create({
        data: {
          id: randomUUID(),
          projectId: input.projectId,
          operation: supplementalRoute.operation,
          scopeKind: input.supplemental.scopeKind,
          scopeIds: jsonValue(supplementalScopeIds),
          manifestFingerprint: input.supplemental.manifestFingerprint,
          providerConnectionId: supplementalRoute.providerConnectionId,
          modelId: supplementalRoute.modelId,
          consentVersion: WEB_AI_TRANSFER_CONSENT_VERSION,
          issuedById: transactionActor.id,
          billingMode: supplementalBilling.billingMode,
          billingUserId: supplementalBilling.billingUserId,
          callKey: stableAiCallKey(job.id, supplementalRoute.operation, "supplemental"),
          boundJobId: job.id,
          confirmationChallengeId: confirmation.row.id,
          ...routeSnapshotData(supplementalRoute),
          expiresAt: await personalGrantExpiresAt(tx, supplementalRoute, input.grantExpiresAtCap),
        },
      });
    }
    if (input.afterCreate !== undefined) await input.afterCreate(tx, job.id, grant.id);
    await consumeWebAiConfirmation(tx, confirmation, job.id, transactionActor.id);
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
  confirmationChallengeId?: string;
}>, db: PrismaClient = getDb()) {
  assertRuntimeRoute(input.route);
  if (input.confirmationChallengeId === undefined) throw new WebAiConfirmationError("WEB_AI_CONFIRMATION_REQUIRED");
  const confirmationChallengeId = normalizeWebAiConfirmationId(input.confirmationChallengeId);
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
      select: { id: true, projectId: true, requestedById: true, kind: true, webAiGrantId: true },
    });
    if (job === null || job.projectId !== input.projectId || job.requestedById !== currentActor.id) {
      return fail("WEB_AI_JOB_NOT_FOUND");
    }
    const challenge = await tx.webAiConfirmationChallenge.findUnique({
      where: { id: confirmationChallengeId },
      select: { actorId: true, actorAccountAccessVersion: true, consumedAt: true, consumedJobId: true },
    });
    const primaryGrant = job.webAiGrantId === null
      ? null
      : await tx.webAiGrant.findUnique({ where: { id: job.webAiGrantId }, select: { confirmationChallengeId: true } });
    if (
      challenge === null
      || challenge.actorId !== currentActor.id
      || challenge.actorAccountAccessVersion !== currentActor.accountAccessVersion
      || challenge.consumedAt === null
      || challenge.consumedJobId !== input.jobId
      || primaryGrant?.confirmationChallengeId !== confirmationChallengeId
    ) throw new WebAiConfirmationError("WEB_AI_CONFIRMATION_STALE");
    const route = await reloadRuntimeRoute(tx, { projectId: input.projectId, route: input.route });
    const billing = await assertRuntimeBilling({
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
        confirmationChallengeId,
      })) throw new AiEntitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN");
      return Object.freeze({ grantId: existing.id, created: false });
    }
    // Supplemental grants for the seven Web AI actions are created together
    // with the primary job/grant and challenge consumption. Once the
    // challenge is consumed, creating a missing supplemental grant in this
    // later transaction would turn it into a bypass. Recover only an already
    // bound grant; fail closed if the atomic creation evidence is absent.
    if (challenge.consumedAt !== null) {
      throw new WebAiConfirmationError("WEB_AI_CONFIRMATION_STALE");
    }
    throw new WebAiConfirmationError("WEB_AI_CONFIRMATION_REQUIRED");
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
  billingMode: "platform" | "byok";
  billingUserId: string;
  payerKind: "platformCaller" | "personalConnectionOwner";
  payerProviderConnectionId: string;
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
  /** Optional exact memory-generation evidence for build or index consumption. */
  personalMemoryGeneration?: PersonalMemoryDispatchEvidence;
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
  const billing = await assertRuntimeBilling({
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
      const finalBilling = await assertRuntimeBilling({
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
          billingUserId: finalBilling.billingUserId,
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
      if (
        dispatchRoute.source === "personal_delegation"
        && dispatchRoute.operation === "embedding"
        && input.personalMemoryGeneration === undefined
      ) {
        throw new AiEntitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN");
      }
      if (
        input.personalMemoryGeneration !== undefined
        && !(await isPersonalMemoryDispatchAdmissible(input.personalMemoryGeneration, {
          projectId: input.route.projectId,
          jobId: input.jobId,
          grantId: grant.id,
        }, tx))
      ) {
        throw new AiEntitlementError("AI_ROUTE_CONFIGURATION_FORBIDDEN");
      }
      const personalEvidence = isPersonalRuntimeRoute(dispatchRoute) ? dispatchRoute.personalEvidence : null;
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
            payerKind: personalEvidence === null ? "platformCaller" : "personalConnectionOwner",
            payerProviderConnectionId: personalEvidence?.payerProviderConnectionId ?? dispatchRoute.providerConnectionId,
            personalDelegationId: personalEvidence?.personalDelegationId ?? null,
            personalDelegationVersion: personalEvidence?.personalDelegationVersion ?? null,
            personalDelegationFingerprint: personalEvidence?.personalDelegationFingerprint ?? null,
            effectiveRouteSelectionId: personalEvidence?.effectiveRouteSelectionId ?? null,
            effectiveRouteSelectionVersion: personalEvidence?.effectiveRouteSelectionVersion ?? null,
            effectiveRouteSelectionUpdatedAt: personalEvidence?.effectiveRouteSelectionUpdatedAt ?? null,
            ownerProjectMembershipId: personalEvidence?.ownerProjectMembershipId ?? null,
            ownerMembershipCreatedAt: personalEvidence?.ownerMembershipCreatedAt ?? null,
            ownerSubscriptionId: personalEvidence?.ownerSubscriptionId ?? null,
            ownerSubscriptionVersion: personalEvidence?.ownerSubscriptionVersion ?? null,
            ownerSubscriptionStartsAt: personalEvidence?.ownerSubscriptionStartsAt ?? null,
            ownerSubscriptionExpiresAt: personalEvidence?.ownerSubscriptionExpiresAt ?? null,
            projectConfirmedById: personalEvidence?.projectConfirmedById ?? null,
            projectConfirmedProjectMembershipId: personalEvidence?.projectConfirmedProjectMembershipId ?? null,
            projectConfirmedMembershipCreatedAt: personalEvidence?.projectConfirmedMembershipCreatedAt ?? null,
            selectedById: personalEvidence?.selectedById ?? null,
            selectedByProjectMembershipId: personalEvidence?.selectedByProjectMembershipId ?? null,
            selectedByMembershipCreatedAt: personalEvidence?.selectedByMembershipCreatedAt ?? null,
            connectionOwnerAccountAccessVersion: personalEvidence?.connectionOwnerAccountAccessVersion ?? null,
            embeddingDimensions: personalEvidence?.embeddingDimensions ?? dispatchRoute.embeddingDimensions,
            maxOutputTokens: personalEvidence?.maxOutputTokens ?? (personalEvidence === null ? dispatchRoute.maxOutputTokens : null),
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
        billingMode: finalBilling.billingMode,
        billingUserId: finalBilling.billingUserId,
        payerKind: personalEvidence === null ? "platformCaller" : "personalConnectionOwner",
        payerProviderConnectionId: personalEvidence?.payerProviderConnectionId ?? dispatchRoute.providerConnectionId,
      });
      return Object.freeze({ auditId: audit.id, grantId: grant.id, billing: finalBilling, dispatch, dispatchMarked: accessAdmission.dispatchMarked });
    });
    auditId = admitted.auditId;
    dispatchMarked = admitted.dispatchMarked;
    const revalidate = () => revalidateProviderDispatchBeforeTransport({
      actor: input.actor,
      projectId: input.route.projectId,
      jobId: input.jobId,
      attempt: input.attempt,
      route: ({
        ...input.route,
        providerConnection: admitted.dispatch.connection,
        credentialSecretFingerprint: admitted.dispatch.connection.credentialSecretFingerprint,
      } as DispatchRoute),
      grantId: admitted.grantId,
      auditId: admitted.auditId,
      callKey: input.callKey,
      billing: admitted.billing,
    }, db);
    const dispatch: ProviderDispatchContext = Object.freeze({
      ...admitted.dispatch,
      connection: Object.freeze({
        ...admitted.dispatch.connection,
        onBeforeCredentialRead: revalidate,
        onBeforeRequest: revalidate,
      }),
    });
    networkStarted = true;
    const result = await input.call(dispatch);
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
      routeFenceFingerprint: dispatch.routeFenceFingerprint,
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
