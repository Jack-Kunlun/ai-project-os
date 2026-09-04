import { createHash } from "node:crypto";
import {
  type AiOperation,
  type AiProviderConnection,
  type PrismaClient,
  type ProjectAiRoute,
  type PlatformDefaultAiRoute,
} from "@prisma/client";
import { getProviderDefinition } from "@/lib/ai-providers";
import { getDb } from "@/lib/db";

type RouteDb = PrismaClient | import("@prisma/client").Prisma.TransactionClient;

export const EFFECTIVE_AI_ROUTE_SOURCES = ["project_override", "platform_default"] as const;
export type EffectiveAiRouteSource = typeof EFFECTIVE_AI_ROUTE_SOURCES[number];

export type EffectiveAiRouteErrorCode =
  | "PROJECT_NOT_FOUND"
  | "PROJECT_ROUTE_INVALID"
  | "PLATFORM_ROUTE_UNAVAILABLE"
  | "AI_PROVIDER_CONFIGURATION_DRIFT";

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
}>): string {
  return createHash("sha256").update(JSON.stringify({
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
  }), "utf8").digest("hex");
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
): EffectiveAiRoute {
  const maxOutputTokens = route.maxOutputTokens > 0 ? route.maxOutputTokens : route.operation === "embedding" ? 128 : 2_048;
  const routeUpdatedAt = route.updatedAt;
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
    providerConnection: Object.freeze(provider),
    source,
    routeId,
    routeVersion,
    routeUpdatedAt,
    providerConfigurationVersion: provider.configurationVersion,
    quotaMultiplierBps,
    routeFenceFingerprint,
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
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${operation}, 40904004))`;
}

type DefaultRouteWithProvider = PlatformDefaultAiRoute & { providerConnection: AiProviderConnection };

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
  if (options.lock === true) await lockPlatformOperation(db, operation);
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true, workspaceId: true } });
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

  const defaultRoute = await db.platformDefaultAiRoute.findFirst({
    where: { operation, status: "active" },
    orderBy: [{ version: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    include: { providerConnection: true },
  }) as DefaultRouteWithProvider | null;
  if (defaultRoute === null) return fail("PLATFORM_ROUTE_UNAVAILABLE");
  const provider = defaultRoute.providerConnection;
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
  return toEffectiveRoute(projectId, defaultRouteProjection, provider, "platform_default", defaultRoute.id, defaultRoute.version, defaultRoute.quotaMultiplierBps);
}

export function effectiveAiRouteSnapshot(route: Pick<EffectiveAiRoute, "source" | "routeId" | "routeVersion" | "routeUpdatedAt" | "providerConfigurationVersion" | "quotaMultiplierBps" | "routeFenceFingerprint">): Readonly<{
  routeSource: EffectiveAiRouteSource;
  routeId: string | null;
  routeVersion: number | null;
  routeUpdatedAt: Date;
  providerConfigurationVersion: number;
  quotaMultiplierBps: number;
  routeFenceFingerprint: string;
}> {
  return Object.freeze({
    routeSource: route.source,
    routeId: route.routeId,
    routeVersion: route.routeVersion,
    routeUpdatedAt: route.routeUpdatedAt,
    providerConfigurationVersion: route.providerConfigurationVersion,
    quotaMultiplierBps: route.quotaMultiplierBps,
    routeFenceFingerprint: route.routeFenceFingerprint,
  });
}

export function routeSnapshotsEqual(
  left: Pick<EffectiveAiRoute, "source" | "routeId" | "routeVersion" | "routeUpdatedAt" | "providerConfigurationVersion" | "quotaMultiplierBps" | "routeFenceFingerprint">,
  right: Pick<EffectiveAiRoute, "source" | "routeId" | "routeVersion" | "routeUpdatedAt" | "providerConfigurationVersion" | "quotaMultiplierBps" | "routeFenceFingerprint">,
): boolean {
  return left.source === right.source
    && left.routeId === right.routeId
    && left.routeVersion === right.routeVersion
    && left.routeUpdatedAt.getTime() === right.routeUpdatedAt.getTime()
    && left.providerConfigurationVersion === right.providerConfigurationVersion
    && left.quotaMultiplierBps === right.quotaMultiplierBps
    && left.routeFenceFingerprint === right.routeFenceFingerprint;
}
