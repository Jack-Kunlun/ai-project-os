import { createHash } from "node:crypto";
import {
  type AiOperation,
  type AiProviderConnection,
  type PrismaClient,
  type ProjectAiRoute,
  type PlatformDefaultAiRoute,
} from "@prisma/client";
import { canonicalProviderBaseUrl, getProviderDefinition } from "@/lib/ai-providers";
import { getDb } from "@/lib/db";

type RouteDb = PrismaClient | import("@prisma/client").Prisma.TransactionClient;

export const EFFECTIVE_AI_ROUTE_SOURCES = ["project_override", "platform_default", "personal_delegation"] as const;
export type EffectiveAiRouteSource = typeof EFFECTIVE_AI_ROUTE_SOURCES[number];

export type EffectiveAiRouteErrorCode =
  | "PROJECT_NOT_FOUND"
  | "PROJECT_ROUTE_INVALID"
  | "PLATFORM_ROUTE_UNAVAILABLE"
  | "AI_PROVIDER_CONFIGURATION_DRIFT"
  | "PERSONAL_ROUTE_UNAVAILABLE"
  | "AI_ROUTE_LOCK_BUSY";

export class EffectiveAiRouteError extends Error {
  constructor(readonly code: EffectiveAiRouteErrorCode) {
    super(code);
    this.name = "EffectiveAiRouteError";
  }
}

/**
 * Runtime route metadata is deliberately separate from the control-plane
 * route rows.  A caller can pass the tuple to a Grant, and dispatch can later
 * require the same tuple without consulting a different route source.
 */
export type EffectiveAiRoute = Readonly<{
  projectId: string;
  operation: AiOperation;
  providerConnectionId: string;
  modelId: string;
  embeddingDimensions: number | null;
  maxOutputTokens: number;
  createdAt: Date;
  updatedAt: Date;
  providerConnection: AiProviderConnection;
  source: EffectiveAiRouteSource;
  routeId: string | null;
  routeVersion: number | null;
  routeUpdatedAt: Date;
  providerConfigurationVersion: number;
  quotaMultiplierBps: number;
  routeFenceFingerprint: string;
  /** Non-secret credential fence captured while the provider lock is held. */
  credentialSecretFingerprint?: string;
  personalEvidence: PersonalEffectiveAiRouteEvidence | null;
}>;

export type PersonalEffectiveAiRouteEvidence = Readonly<{
  personalDelegationId: string;
  personalDelegationVersion: number;
  personalDelegationFingerprint: string;
  effectiveRouteSelectionId: string;
  effectiveRouteSelectionVersion: number;
  effectiveRouteSelectionUpdatedAt: Date;
  payerKind: "personal_connection_owner";
  payerProviderConnectionId: string;
  connectionOwnerId: string;
  billingUserId: string;
  ownerProjectMembershipId: string;
  ownerMembershipCreatedAt: Date;
  ownerSubscriptionId: string;
  ownerSubscriptionVersion: number;
  ownerSubscriptionStartsAt: Date;
  ownerSubscriptionExpiresAt: Date;
  projectConfirmedById: string;
  projectConfirmedProjectMembershipId: string;
  projectConfirmedMembershipCreatedAt: Date;
  selectedById: string;
  selectedByProjectMembershipId: string;
  selectedByMembershipCreatedAt: Date;
  connectionOwnerAccountAccessVersion: number;
  credentialSecretFingerprint: string;
  embeddingDimensions: number | null;
  maxOutputTokens: number | null;
}>;

const ROUTE_OPERATION_VALUES = [
  "embedding",
  "visionExtract",
  "autoExtract",
  "sourceSummary",
  "projectAnalysis",
  "generateWithContext",
] as const satisfies readonly AiOperation[];

const PROJECT_ROUTE_OPERATION_VALUES = new Set<AiOperation>(ROUTE_OPERATION_VALUES);

function fail(code: EffectiveAiRouteErrorCode): never {
  throw new EffectiveAiRouteError(code);
}

function operationIsSupported(operation: AiOperation): boolean {
  return PROJECT_ROUTE_OPERATION_VALUES.has(operation);
}

function routeFence(input: Readonly<{
  projectId: string;
  operation: AiOperation;
  source: EffectiveAiRouteSource;
  routeId: string | null;
  routeVersion: number | null;
  routeUpdatedAt: Date;
  providerConnectionId: string;
  providerConfigurationVersion: number;
  quotaMultiplierBps: number;
  modelId: string;
  embeddingDimensions: number | null;
  maxOutputTokens: number;
  credentialSecretFingerprint?: string | null;
  personalEvidence?: PersonalEffectiveAiRouteEvidence | null;
}>): string {
  const payload: Record<string, unknown> = {
    projectId: input.projectId,
    operation: input.operation,
    source: input.source,
    routeId: input.routeId,
    routeVersion: input.routeVersion,
    routeUpdatedAt: input.routeUpdatedAt.toISOString(),
    providerConnectionId: input.providerConnectionId,
    providerConfigurationVersion: input.providerConfigurationVersion,
    quotaMultiplierBps: input.quotaMultiplierBps,
    modelId: input.modelId,
    embeddingDimensions: input.embeddingDimensions,
    maxOutputTokens: input.maxOutputTokens,
  };
  if (input.personalEvidence !== undefined && input.personalEvidence !== null) {
    payload.personalEvidence = {
      ...input.personalEvidence,
      ownerMembershipCreatedAt: input.personalEvidence.ownerMembershipCreatedAt.toISOString(),
      ownerSubscriptionStartsAt: input.personalEvidence.ownerSubscriptionStartsAt.toISOString(),
      ownerSubscriptionExpiresAt: input.personalEvidence.ownerSubscriptionExpiresAt.toISOString(),
      projectConfirmedMembershipCreatedAt: input.personalEvidence.projectConfirmedMembershipCreatedAt.toISOString(),
      selectedByMembershipCreatedAt: input.personalEvidence.selectedByMembershipCreatedAt.toISOString(),
      effectiveRouteSelectionUpdatedAt: input.personalEvidence.effectiveRouteSelectionUpdatedAt.toISOString(),
    };
  }
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function assertProviderScope(
  provider: AiProviderConnection,
  workspaceId: string,
  source: EffectiveAiRouteSource,
): void {
  if (
    provider.scope !== "platform"
    || provider.ownershipState !== "confirmed"
    || provider.disabledAt !== null
    || provider.status !== "verified"
  ) return fail(source === "platform_default" ? "PLATFORM_ROUTE_UNAVAILABLE" : "PROJECT_ROUTE_INVALID");
  if (provider.workspaceId !== null || provider.ownerUserId !== null) {
    return fail(source === "platform_default" ? "PLATFORM_ROUTE_UNAVAILABLE" : "PROJECT_ROUTE_INVALID");
  }
  void workspaceId;
}

type PersonalProviderRow = {
  id: string;
  name: string;
  kind: AiProviderConnection["kind"];
  scope: AiProviderConnection["scope"];
  ownerUserId: string | null;
  workspaceId: string | null;
  ownershipState: AiProviderConnection["ownershipState"];
  protocol: AiProviderConnection["protocol"];
  baseUrl: string;
  defaultGenerationModelId: string | null;
  defaultEmbeddingModelId: string | null;
  defaultVisionModelId: string | null;
  embeddingDimensions: number | null;
  configurationVersion: number;
  status: AiProviderConnection["status"];
  disabledAt: Date | null;
  credential: { kind: string; secretFingerprint: string };
  ownerAccountAccessVersion: number | null;
};

function assertPersonalProvider(
  provider: PersonalProviderRow,
  operation: AiOperation,
  modelId: string,
  embeddingDimensions: number | null,
  maxOutputTokens: number | null,
  credentialFingerprint: string,
  expectedProviderId: string,
  expectedOwnerId: string,
): void {
  if (
    provider.id !== expectedProviderId
    || provider.scope !== "user"
    || provider.ownerUserId === null
    || provider.ownerUserId !== expectedOwnerId
    || provider.workspaceId !== null
    || provider.ownershipState !== "confirmed"
    || provider.status !== "verified"
    || provider.disabledAt !== null
    || provider.protocol !== "chatCompletions"
    || provider.baseUrl !== canonicalProviderBaseUrl(provider.kind)
    || provider.configurationVersion < 1
    || provider.credential.kind !== "aiProvider"
    || provider.credential.secretFingerprint !== credentialFingerprint
  ) return fail("PERSONAL_ROUTE_UNAVAILABLE");
  const definition = getProviderDefinition(provider.kind);
  if (operation === "embedding") {
    if (
      !definition.supportsEmbeddings
      || provider.kind === "deepseek"
      || provider.defaultEmbeddingModelId === null
      || provider.defaultEmbeddingModelId !== modelId
      || provider.embeddingDimensions === null
      || provider.embeddingDimensions !== embeddingDimensions
      || maxOutputTokens !== null
    ) return fail("PERSONAL_ROUTE_UNAVAILABLE");
    return;
  }
  if (operation === "visionExtract") {
    if (!definition.supportsVision || provider.defaultVisionModelId === null || provider.defaultVisionModelId !== modelId || embeddingDimensions !== null) {
      return fail("PERSONAL_ROUTE_UNAVAILABLE");
    }
  } else if (provider.defaultGenerationModelId === null || provider.defaultGenerationModelId !== modelId || embeddingDimensions !== null) {
    return fail("PERSONAL_ROUTE_UNAVAILABLE");
  }
  if (!Number.isSafeInteger(maxOutputTokens) || (maxOutputTokens ?? 0) < 1 || (maxOutputTokens ?? 0) > 65_536) {
    return fail("PERSONAL_ROUTE_UNAVAILABLE");
  }
}

function assertCapability(
  operation: AiOperation,
  modelId: string,
  embeddingDimensions: number | null,
  maxOutputTokens: number,
  provider: AiProviderConnection,
  source: EffectiveAiRouteSource,
): void {
  const unavailable = source === "platform_default" ? "PLATFORM_ROUTE_UNAVAILABLE" : "PROJECT_ROUTE_INVALID";
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 65_536) return fail(unavailable);
  const definition = getProviderDefinition(provider.kind);
  if (operation === "embedding") {
    if (
      !definition.supportsEmbeddings
      || provider.defaultEmbeddingModelId === null
      || provider.embeddingDimensions === null
      || modelId !== provider.defaultEmbeddingModelId
      || embeddingDimensions !== provider.embeddingDimensions
    ) return fail(unavailable);
    return;
  }
  if (operation === "visionExtract") {
    if (
      !definition.supportsVision
      || provider.defaultVisionModelId === null
      || modelId !== provider.defaultVisionModelId
      || embeddingDimensions !== null
    ) return fail(unavailable);
    return;
  }
  if (embeddingDimensions !== null || provider.defaultGenerationModelId === null || modelId !== provider.defaultGenerationModelId) {
    return fail(unavailable);
  }
}

function toEffectiveRoute(
  projectId: string,
  route: ProjectAiRoute,
  provider: AiProviderConnection,
  source: EffectiveAiRouteSource,
  routeId: string | null,
  routeVersion: number | null,
  quotaMultiplierBps: number,
  credentialSecretFingerprint: string,
): EffectiveAiRoute {
  const maxOutputTokens = route.maxOutputTokens > 0 ? route.maxOutputTokens : route.operation === "embedding" ? 128 : 2_048;
  const routeUpdatedAt = route.updatedAt;
  const { credential: _credential, ...providerWithoutCredential } = provider as AiProviderConnection & {
    credential?: { kind: string; secretFingerprint: string };
  };
  void _credential;
  const routeFenceFingerprint = routeFence({
    projectId,
    operation: route.operation,
    source,
    routeId,
    routeVersion,
    routeUpdatedAt,
    providerConnectionId: route.providerConnectionId,
    providerConfigurationVersion: provider.configurationVersion,
    quotaMultiplierBps,
    modelId: route.modelId,
    embeddingDimensions: route.embeddingDimensions,
    maxOutputTokens,
    credentialSecretFingerprint,
  });
  return Object.freeze({
    projectId,
    operation: route.operation,
    providerConnectionId: route.providerConnectionId,
    modelId: route.modelId,
    embeddingDimensions: route.embeddingDimensions,
    maxOutputTokens,
    createdAt: route.createdAt,
    updatedAt: route.updatedAt,
    providerConnection: Object.freeze(providerWithoutCredential),
    source,
    routeId,
    routeVersion,
    routeUpdatedAt,
    providerConfigurationVersion: provider.configurationVersion,
    quotaMultiplierBps,
    routeFenceFingerprint,
    credentialSecretFingerprint,
    personalEvidence: null,
  });
}

function toDefaultProjectRoute(route: PlatformDefaultAiRoute): ProjectAiRoute {
  return {
    projectId: "",
    operation: route.operation,
    providerConnectionId: route.providerConnectionId,
    modelId: route.modelId,
    embeddingDimensions: route.embeddingDimensions,
    maxOutputTokens: route.maxOutputTokens ?? (route.operation === "embedding" ? 128 : 2_048),
    createdAt: route.createdAt,
    updatedAt: route.updatedAt,
  };
}

async function lockPlatformOperation(db: RouteDb, operation: AiOperation): Promise<void> {
  const rows = await db.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${operation}, 40904004)) AS locked`;
  if (rows[0]?.locked !== true) return fail("AI_ROUTE_LOCK_BUSY");
}

async function lockRouteDomain(db: RouteDb, operation: AiOperation): Promise<void> {
  const global = await db.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended('ai-project-provider-delegation-global', 0)) AS locked`;
  if (global[0]?.locked !== true) return fail("AI_ROUTE_LOCK_BUSY");
  await lockPlatformOperation(db, operation);
}

async function lockProviderRouteDomain(db: RouteDb, providerConnectionId: string): Promise<void> {
  const provider = await db.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${providerConnectionId}, 40904005)) AS locked`;
  if (provider[0]?.locked !== true) return fail("AI_ROUTE_LOCK_BUSY");
}

async function databaseNow(db: RouteDb): Promise<Date> {
  const rows = await db.$queryRaw<Array<{ now: Date | string }>>`SELECT clock_timestamp() AS now`;
  const value = rows[0]?.now;
  const date = value instanceof Date ? value : new Date(value ?? "");
  if (!Number.isFinite(date.getTime())) return fail("PERSONAL_ROUTE_UNAVAILABLE");
  return date;
}

async function resolvePersonalRoute(
  projectId: string,
  operation: AiOperation,
  project: { workspaceId: string; archivedAt: Date | null },
  selection: {
    id: string;
    projectId: string;
    operation: AiOperation;
    source: "platformDefault" | "personalDelegation";
    delegationId: string | null;
    selectedById: string;
    selectedByProjectMembershipId: string;
    selectedByMembershipCreatedAt: Date;
    connectionOwnerAccountAccessVersion: number | null;
    version: number;
    createdAt: Date;
    updatedAt: Date;
  },
  db: RouteDb,
): Promise<EffectiveAiRoute> {
  if (selection.source !== "personalDelegation" || selection.delegationId === null || selection.projectId !== projectId || selection.operation !== operation) {
    return fail("PERSONAL_ROUTE_UNAVAILABLE");
  }
  const now = await databaseNow(db);
  const delegation = await db.projectAiProviderDelegation.findFirst({
    where: { id: selection.delegationId, projectId, operation },
    select: {
      id: true,
      projectId: true,
      operation: true,
      version: true,
      status: true,
      providerConnectionId: true,
      connectionOwnerId: true,
      ownerProjectMembershipId: true,
      ownerMembershipCreatedAt: true,
      projectConfirmedProjectMembershipId: true,
      projectConfirmedMembershipCreatedAt: true,
      projectConfirmedById: true,
      connectionOwnerSubscriptionId: true,
      connectionOwnerSubscriptionVersion: true,
      connectionOwnerSubscriptionStartsAt: true,
      connectionOwnerSubscriptionExpiresAt: true,
      connectionOwnerAccountAccessVersion: true,
      modelId: true,
      embeddingDimensions: true,
      maxOutputTokens: true,
      providerConfigurationVersion: true,
      credentialFingerprint: true,
      delegationFingerprint: true,
      expiresAt: true,
      providerConnection: {
        select: {
          id: true,
          name: true,
          kind: true,
          scope: true,
          workspaceId: true,
          ownerUserId: true,
          ownershipState: true,
          protocol: true,
          baseUrl: true,
          defaultGenerationModelId: true,
          defaultEmbeddingModelId: true,
          defaultVisionModelId: true,
          embeddingDimensions: true,
          configurationVersion: true,
          ownerAccountAccessVersion: true,
          status: true,
          disabledAt: true,
          credential: { select: { kind: true, secretFingerprint: true } },
        },
      },
    },
  });
  if (delegation === null || delegation.status !== "active" || delegation.expiresAt <= now || project.workspaceId.length === 0 || project.archivedAt !== null) {
    return fail("PERSONAL_ROUTE_UNAVAILABLE");
  }
  const provider = delegation.providerConnection as PersonalProviderRow;
  assertPersonalProvider(
    provider,
    operation,
    delegation.modelId,
    delegation.embeddingDimensions,
    delegation.maxOutputTokens,
    delegation.credentialFingerprint,
    delegation.providerConnectionId,
    delegation.connectionOwnerId,
  );
  if (provider.configurationVersion !== delegation.providerConfigurationVersion) return fail("AI_PROVIDER_CONFIGURATION_DRIFT");

  const owner = await db.appUser.findUnique({
    where: { id: delegation.connectionOwnerId },
    select: { disabledAt: true, accountAccessVersion: true },
  });
  if (
    owner === null
    || owner.disabledAt !== null
    || provider.ownerAccountAccessVersion === null
    || delegation.connectionOwnerAccountAccessVersion === null
    || provider.ownerAccountAccessVersion !== owner.accountAccessVersion
    || delegation.connectionOwnerAccountAccessVersion !== owner.accountAccessVersion
    || delegation.connectionOwnerAccountAccessVersion !== provider.ownerAccountAccessVersion
    || selection.connectionOwnerAccountAccessVersion !== owner.accountAccessVersion
  ) return fail("PERSONAL_ROUTE_UNAVAILABLE");
  const ownerMembership = await db.projectMembership.findUnique({
    where: { id: delegation.ownerProjectMembershipId },
    select: { projectId: true, userId: true, role: true, accessState: true, createdAt: true },
  });
  if (
    ownerMembership === null
    || ownerMembership.projectId !== projectId
    || ownerMembership.userId !== delegation.connectionOwnerId
    || ownerMembership.accessState !== "confirmed"
    || (ownerMembership.role !== "owner" && ownerMembership.role !== "editor")
    || ownerMembership.createdAt.getTime() !== delegation.ownerMembershipCreatedAt.getTime()
  ) return fail("PERSONAL_ROUTE_UNAVAILABLE");
  const subscription = await db.membershipSubscription.findUnique({
    where: { id: delegation.connectionOwnerSubscriptionId },
    select: { userId: true, status: true, version: true, startsAt: true, expiresAt: true },
  });
  if (
    subscription === null
    || subscription.userId !== delegation.connectionOwnerId
    || subscription.status !== "active"
    || subscription.version !== delegation.connectionOwnerSubscriptionVersion
    || subscription.startsAt.getTime() !== delegation.connectionOwnerSubscriptionStartsAt.getTime()
    || subscription.expiresAt.getTime() !== delegation.connectionOwnerSubscriptionExpiresAt.getTime()
    || subscription.startsAt > now
    || subscription.expiresAt <= now
  ) return fail("PERSONAL_ROUTE_UNAVAILABLE");
  if (delegation.projectConfirmedProjectMembershipId === null || delegation.projectConfirmedMembershipCreatedAt === null || delegation.projectConfirmedById === null) {
    return fail("PERSONAL_ROUTE_UNAVAILABLE");
  }
  const projectOwnerMembership = await db.projectMembership.findUnique({
    where: { id: delegation.projectConfirmedProjectMembershipId },
    select: { projectId: true, userId: true, role: true, accessState: true, createdAt: true },
  });
  if (
    projectOwnerMembership === null
    || projectOwnerMembership.projectId !== projectId
    || projectOwnerMembership.userId !== delegation.projectConfirmedById
    || projectOwnerMembership.role !== "owner"
    || projectOwnerMembership.accessState !== "confirmed"
    || projectOwnerMembership.createdAt.getTime() !== delegation.projectConfirmedMembershipCreatedAt.getTime()
  ) return fail("PERSONAL_ROUTE_UNAVAILABLE");
  const projectOwner = await db.appUser.findUnique({ where: { id: delegation.projectConfirmedById }, select: { disabledAt: true } });
  if (projectOwner === null || projectOwner.disabledAt !== null) return fail("PERSONAL_ROUTE_UNAVAILABLE");
  const selectionOwnerMembership = await db.projectMembership.findUnique({
    where: { id: selection.selectedByProjectMembershipId },
    select: { projectId: true, userId: true, role: true, accessState: true, createdAt: true },
  });
  if (
    selectionOwnerMembership === null
    || selectionOwnerMembership.projectId !== projectId
    || selectionOwnerMembership.userId !== selection.selectedById
    || selectionOwnerMembership.role !== "owner"
    || selectionOwnerMembership.accessState !== "confirmed"
    || selectionOwnerMembership.createdAt.getTime() !== selection.selectedByMembershipCreatedAt.getTime()
  ) return fail("PERSONAL_ROUTE_UNAVAILABLE");
  const selectionOwner = await db.appUser.findUnique({ where: { id: selection.selectedById }, select: { disabledAt: true } });
  if (selectionOwner === null || selectionOwner.disabledAt !== null) return fail("PERSONAL_ROUTE_UNAVAILABLE");

  const personalEvidence: PersonalEffectiveAiRouteEvidence = Object.freeze({
    personalDelegationId: delegation.id,
    personalDelegationVersion: delegation.version,
    personalDelegationFingerprint: delegation.delegationFingerprint,
    effectiveRouteSelectionId: selection.id,
    effectiveRouteSelectionVersion: selection.version,
    effectiveRouteSelectionUpdatedAt: selection.updatedAt,
    payerKind: "personal_connection_owner",
    payerProviderConnectionId: delegation.providerConnectionId,
    connectionOwnerId: delegation.connectionOwnerId,
    billingUserId: delegation.connectionOwnerId,
    ownerProjectMembershipId: delegation.ownerProjectMembershipId,
    ownerMembershipCreatedAt: delegation.ownerMembershipCreatedAt,
    ownerSubscriptionId: delegation.connectionOwnerSubscriptionId,
    ownerSubscriptionVersion: delegation.connectionOwnerSubscriptionVersion,
    ownerSubscriptionStartsAt: delegation.connectionOwnerSubscriptionStartsAt,
    ownerSubscriptionExpiresAt: delegation.connectionOwnerSubscriptionExpiresAt,
    projectConfirmedById: delegation.projectConfirmedById,
    projectConfirmedProjectMembershipId: delegation.projectConfirmedProjectMembershipId,
    projectConfirmedMembershipCreatedAt: delegation.projectConfirmedMembershipCreatedAt,
    selectedById: selection.selectedById,
    selectedByProjectMembershipId: selection.selectedByProjectMembershipId,
    selectedByMembershipCreatedAt: selection.selectedByMembershipCreatedAt,
    connectionOwnerAccountAccessVersion: delegation.connectionOwnerAccountAccessVersion,
    credentialSecretFingerprint: delegation.credentialFingerprint,
    embeddingDimensions: delegation.embeddingDimensions,
    maxOutputTokens: delegation.maxOutputTokens,
  });
  const { credential: _credential, ...providerWithoutCredential } = provider;
  void _credential;
  const runtimeMaxOutputTokens = delegation.maxOutputTokens ?? 128;
  const routeFenceFingerprint = routeFence({
    projectId,
    operation,
    source: "personal_delegation",
    routeId: selection.id,
    routeVersion: selection.version,
    routeUpdatedAt: selection.updatedAt,
    providerConnectionId: delegation.providerConnectionId,
    providerConfigurationVersion: delegation.providerConfigurationVersion,
    quotaMultiplierBps: 10_000,
    modelId: delegation.modelId,
    embeddingDimensions: delegation.embeddingDimensions,
    maxOutputTokens: runtimeMaxOutputTokens,
    credentialSecretFingerprint: delegation.credentialFingerprint,
    personalEvidence,
  });
  return Object.freeze({
    projectId,
    operation,
    providerConnectionId: delegation.providerConnectionId,
    modelId: delegation.modelId,
    embeddingDimensions: delegation.embeddingDimensions,
    maxOutputTokens: runtimeMaxOutputTokens,
    createdAt: selection.createdAt,
    updatedAt: selection.updatedAt,
    providerConnection: Object.freeze(providerWithoutCredential as unknown as AiProviderConnection),
    source: "personal_delegation",
    routeId: selection.id,
    routeVersion: selection.version,
    routeUpdatedAt: selection.updatedAt,
    providerConfigurationVersion: delegation.providerConfigurationVersion,
    quotaMultiplierBps: 10_000,
    routeFenceFingerprint,
    credentialSecretFingerprint: delegation.credentialFingerprint,
    personalEvidence,
  });
}

type DefaultRouteWithProvider = PlatformDefaultAiRoute & {
  providerConnection: AiProviderConnection & {
    credential: { kind: string; secretFingerprint: string };
  };
};

/**
 * Resolve the only route a runtime operation may use.  When `lock` is true,
 * callers must provide a transaction client; this acquires the platform
 * operation lock before reading either route source and lets the subsequent
 * provider lock preserve access -> operation -> provider ordering.
 */
export async function resolveEffectiveAiRoute(
  projectId: string,
  operation: AiOperation,
  db: RouteDb = getDb(),
  options: Readonly<{ lock?: boolean }> = {},
): Promise<EffectiveAiRoute> {
  if (!operationIsSupported(operation)) return fail("PLATFORM_ROUTE_UNAVAILABLE");
  if (options.lock === true) await lockRouteDomain(db, operation);
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true, workspaceId: true, archivedAt: true } });
  if (project === null) return fail("PROJECT_NOT_FOUND");

  const projectRoute = await db.projectAiRoute.findUnique({
    where: { projectId_operation: { projectId, operation } },
  });
  if (projectRoute !== null) {
    // ProjectAiRoute predates the platform-default admission contract and has
    // no user-provider ownership/double-consent fence. Treat any surviving
    // row as a legacy reference: it must not override the administrator-owned
    // platform route or silently fall back to it.
    return fail("PROJECT_ROUTE_INVALID");
  }

  const selection = await db.projectAiEffectiveRouteSelection.findUnique({
    where: { projectId_operation: { projectId, operation } },
    select: {
      id: true,
      projectId: true,
      operation: true,
      source: true,
      delegationId: true,
      selectedById: true,
      selectedByProjectMembershipId: true,
      selectedByMembershipCreatedAt: true,
      connectionOwnerAccountAccessVersion: true,
      version: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (selection?.source === "personalDelegation") {
    if (options.lock === true) {
      const delegation = await db.projectAiProviderDelegation.findUnique({
        where: { id: selection.delegationId ?? "" },
        select: { providerConnectionId: true },
      });
      if (delegation === null) return fail("PERSONAL_ROUTE_UNAVAILABLE");
      await lockProviderRouteDomain(db, delegation.providerConnectionId);
    }
    return resolvePersonalRoute(projectId, operation, project, selection, db);
  }
  if (selection !== null && (selection.source !== "platformDefault" || selection.delegationId !== null)) {
    return fail("PLATFORM_ROUTE_UNAVAILABLE");
  }
  if (project.archivedAt !== null) return fail("PLATFORM_ROUTE_UNAVAILABLE");

  const defaultRoute = await db.platformDefaultAiRoute.findFirst({
    where: { operation, status: "active" },
    orderBy: [{ version: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    include: {
      providerConnection: {
        include: { credential: { select: { kind: true, secretFingerprint: true } } },
      },
    },
  }) as DefaultRouteWithProvider | null;
  if (defaultRoute === null) return fail("PLATFORM_ROUTE_UNAVAILABLE");
  const provider = defaultRoute.providerConnection;
  if (provider.credential.kind !== "aiProvider" || !/^[0-9a-f]{64}$/u.test(provider.credential.secretFingerprint)) {
    return fail("PLATFORM_ROUTE_UNAVAILABLE");
  }
  assertProviderScope(provider, project.workspaceId, "platform_default");
  if (
    defaultRoute.validatedAt === null
    || defaultRoute.validatedProviderConfigurationVersion === null
  ) return fail("PLATFORM_ROUTE_UNAVAILABLE");
  if (!Number.isSafeInteger(provider.configurationVersion) || provider.configurationVersion < 1 || defaultRoute.validatedProviderConfigurationVersion !== provider.configurationVersion) {
    return fail("AI_PROVIDER_CONFIGURATION_DRIFT");
  }
  const defaultRouteProjection = toDefaultProjectRoute(defaultRoute);
  assertCapability(operation, defaultRoute.modelId, defaultRoute.embeddingDimensions, defaultRouteProjection.maxOutputTokens, provider, "platform_default");
  if (!Number.isSafeInteger(defaultRoute.quotaMultiplierBps) || defaultRoute.quotaMultiplierBps < 1 || defaultRoute.quotaMultiplierBps > 100_000) {
    return fail("PLATFORM_ROUTE_UNAVAILABLE");
  }
  return toEffectiveRoute(projectId, defaultRouteProjection, provider, "platform_default", defaultRoute.id, defaultRoute.version, defaultRoute.quotaMultiplierBps, provider.credential.secretFingerprint);
}

export function effectiveAiRouteSnapshot(route: Pick<EffectiveAiRoute, "source" | "routeId" | "routeVersion" | "routeUpdatedAt" | "providerConfigurationVersion" | "quotaMultiplierBps" | "routeFenceFingerprint" | "credentialSecretFingerprint">): Readonly<{
  routeSource: EffectiveAiRouteSource;
  routeId: string | null;
  routeVersion: number | null;
  routeUpdatedAt: Date;
  providerConfigurationVersion: number;
  quotaMultiplierBps: number;
  routeFenceFingerprint: string;
  credentialSecretFingerprint: string | null;
}> {
  return Object.freeze({
    routeSource: route.source,
    routeId: route.routeId,
    routeVersion: route.routeVersion,
    routeUpdatedAt: route.routeUpdatedAt,
    providerConfigurationVersion: route.providerConfigurationVersion,
    quotaMultiplierBps: route.quotaMultiplierBps,
    routeFenceFingerprint: route.routeFenceFingerprint,
    credentialSecretFingerprint: route.credentialSecretFingerprint ?? null,
  });
}

export function routeSnapshotsEqual(
  left: Pick<EffectiveAiRoute, "source" | "routeId" | "routeVersion" | "routeUpdatedAt" | "providerConfigurationVersion" | "quotaMultiplierBps" | "routeFenceFingerprint" | "credentialSecretFingerprint">,
  right: Pick<EffectiveAiRoute, "source" | "routeId" | "routeVersion" | "routeUpdatedAt" | "providerConfigurationVersion" | "quotaMultiplierBps" | "routeFenceFingerprint" | "credentialSecretFingerprint">,
): boolean {
  return left.source === right.source
    && left.routeId === right.routeId
    && left.routeVersion === right.routeVersion
    && left.routeUpdatedAt.getTime() === right.routeUpdatedAt.getTime()
    && left.providerConfigurationVersion === right.providerConfigurationVersion
    && left.quotaMultiplierBps === right.quotaMultiplierBps
    && left.routeFenceFingerprint === right.routeFenceFingerprint
    && left.credentialSecretFingerprint === right.credentialSecretFingerprint;
}
