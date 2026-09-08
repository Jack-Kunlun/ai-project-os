import {
  Prisma,
  type AiProviderConnectionStatus,
  type PlatformDefaultAiRouteStatus,
  type PrismaClient,
} from "@prisma/client";
import { z } from "zod";
import { getProviderDefinition, isSafeModelId } from "@/lib/ai-providers";
import { AccountAccessGuardError, assertAccountAccessForActor, requireAccountAccessVersion } from "@/lib/account-access-guard";
import { lockActorAccess } from "@/lib/access-linearization";
import { getDb } from "@/lib/db";
import { isSerializationConflict } from "@/lib/project-snapshot-errors";

/** The control plane keeps configuration and audit rows separate from runtime
 * route metadata. The current effective-route resolver consumes an active,
 * validated platform-default row without letting this module mutate dispatch
 * behavior. */
export const PLATFORM_DEFAULT_AI_OPERATIONS = [
  "embedding",
  "visionExtract",
  "autoExtract",
  "sourceSummary",
  "projectAnalysis",
  "generateWithContext",
] as const;

export type PlatformDefaultAiOperation = typeof PLATFORM_DEFAULT_AI_OPERATIONS[number];
export type PlatformDefaultAiRouteActor = Readonly<{ id: string; role: string; accountAccessVersion?: number }>;
type RouteDb = PrismaClient | Prisma.TransactionClient;

export type PlatformDefaultAiRouteErrorCode =
  | "PLATFORM_AI_ROUTE_INVALID_INPUT"
  | "PLATFORM_AI_ROUTE_ADMIN_REQUIRED"
  | "PLATFORM_AI_ROUTE_NOT_FOUND"
  | "PLATFORM_AI_ROUTE_CONFLICT"
  | "PLATFORM_AI_ROUTE_PROVIDER_NOT_FOUND"
  | "PLATFORM_AI_ROUTE_PROVIDER_INVALID"
  | "PLATFORM_AI_ROUTE_PROVIDER_NOT_VERIFIED"
  | "PLATFORM_AI_ROUTE_PROVIDER_DISABLED"
  | "PLATFORM_AI_ROUTE_CAPABILITY_MISMATCH"
  | "PLATFORM_AI_ROUTE_NOT_DRAFT"
  | "PLATFORM_AI_ROUTE_NOT_VALIDATED"
  | "PLATFORM_AI_ROUTE_CONFIGURATION_CHANGED"
  | "PLATFORM_AI_ROUTE_REASON_REQUIRED";

export class PlatformDefaultAiRouteError extends Error {
  constructor(readonly code: PlatformDefaultAiRouteErrorCode) {
    super(code);
    this.name = "PlatformDefaultAiRouteError";
  }
}

export const PlatformDefaultAiRouteServiceError = PlatformDefaultAiRouteError;

export type PlatformDefaultAiRouteReadinessCode =
  | "missing"
  | "provider-invalid"
  | "provider-not-verified"
  | "provider-disabled"
  | "configuration-changed"
  | "capability-mismatch"
  | "not-validated"
  | "ready";

const routeIdSchema = z.string().uuid();
const modelIdSchema = z.string().trim().min(1).max(128).refine(isSafeModelId);
const operationSchema = z.enum(PLATFORM_DEFAULT_AI_OPERATIONS);
const routeInputSchema = z.object({
  operation: operationSchema,
  providerConnectionId: z.string().uuid(),
  modelId: modelIdSchema,
  embeddingDimensions: z.number().int().min(8).max(8192).nullable().optional(),
  maxOutputTokens: z.number().int().min(1).max(65_536).nullable().optional(),
  quotaMultiplierBps: z.number().int().min(1).max(100_000).default(10_000),
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();
const routeUpdateSchema = z.object({
  providerConnectionId: z.string().uuid().optional(),
  modelId: modelIdSchema.optional(),
  embeddingDimensions: z.number().int().min(8).max(8192).nullable().optional(),
  maxOutputTokens: z.number().int().min(1).max(65_536).nullable().optional(),
  quotaMultiplierBps: z.number().int().min(1).max(100_000).optional(),
  expectedUpdatedAt: z.union([z.string().datetime({ offset: true }), z.date()]),
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();
const lifecycleSchema = z.object({
  action: z.enum(["validate", "activate", "retire"]),
  expectedUpdatedAt: z.union([z.string().datetime({ offset: true }), z.date()]),
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();

const providerForRouteSelect = {
  id: true,
  name: true,
  kind: true,
  scope: true,
  workspaceId: true,
  ownerUserId: true,
  ownershipState: true,
  status: true,
  disabledAt: true,
  configurationVersion: true,
  defaultGenerationModelId: true,
  defaultEmbeddingModelId: true,
  defaultVisionModelId: true,
  embeddingDimensions: true,
} as const;

const routeSelect = {
  id: true,
  operation: true,
  version: true,
  status: true,
  providerConnectionId: true,
  modelId: true,
  embeddingDimensions: true,
  maxOutputTokens: true,
  quotaMultiplierBps: true,
  validatedProviderConfigurationVersion: true,
  validatedAt: true,
  createdById: true,
  updatedById: true,
  createdAt: true,
  updatedAt: true,
  providerConnection: { select: providerForRouteSelect },
} as const;

const providerListSelect = {
  id: true,
  name: true,
  kind: true,
  scope: true,
  ownershipState: true,
  status: true,
  disabledAt: true,
  configurationVersion: true,
  defaultGenerationModelId: true,
  defaultEmbeddingModelId: true,
  defaultVisionModelId: true,
  embeddingDimensions: true,
  _count: {
    select: {
      projectRoutes: true,
      platformDefaultAiRoutes: { where: { status: "active" } },
    },
  },
} as const;

type RouteWithProvider = Prisma.PlatformDefaultAiRouteGetPayload<{ select: typeof routeSelect }>;
type ProviderForRoute = RouteWithProvider["providerConnection"];
type RoutePayload = Readonly<{
  embeddingDimensions: number | null;
  maxOutputTokens: number | null;
}>;

function fail(code: PlatformDefaultAiRouteErrorCode): never {
  throw new PlatformDefaultAiRouteError(code);
}

function parseRouteId(value: unknown): string {
  const parsed = routeIdSchema.safeParse(value);
  if (!parsed.success) return fail("PLATFORM_AI_ROUTE_INVALID_INPUT");
  return parsed.data;
}

function parseRouteInput(value: unknown) {
  const parsed = routeInputSchema.safeParse(value);
  if (!parsed.success) return fail("PLATFORM_AI_ROUTE_INVALID_INPUT");
  return parsed.data;
}

function parseRouteUpdate(value: unknown) {
  const parsed = routeUpdateSchema.safeParse(value);
  if (!parsed.success) return fail("PLATFORM_AI_ROUTE_INVALID_INPUT");
  return parsed.data;
}

function parseLifecycleInput(value: unknown) {
  const parsed = lifecycleSchema.safeParse(value);
  if (!parsed.success) return fail("PLATFORM_AI_ROUTE_INVALID_INPUT");
  return parsed.data;
}

function assertAdmin(actor: PlatformDefaultAiRouteActor): PlatformDefaultAiRouteActor {
  if (actor === null || actor === undefined || actor.role !== "admin" || typeof actor.id !== "string" || actor.id.length === 0) {
    return fail("PLATFORM_AI_ROUTE_ADMIN_REQUIRED");
  }
  try {
    requireAccountAccessVersion(actor);
  } catch (error) {
    if (error instanceof AccountAccessGuardError) return fail("PLATFORM_AI_ROUTE_ADMIN_REQUIRED");
    throw error;
  }
  return actor;
}

async function assertCurrentAdmin(
  actor: PlatformDefaultAiRouteActor,
  db: RouteDb,
): Promise<void> {
  try {
    await assertAccountAccessForActor(db, actor);
  } catch (error) {
    if (error instanceof AccountAccessGuardError) return fail("PLATFORM_AI_ROUTE_ADMIN_REQUIRED");
    throw error;
  }
  const current = await db.appUser.findUnique({
    where: { id: actor.id },
    select: { role: true },
  });
  if (current === null || current.role !== "admin") return fail("PLATFORM_AI_ROUTE_ADMIN_REQUIRED");
}

async function lockAndAssertCurrentAdmin(
  actor: PlatformDefaultAiRouteActor,
  db: Prisma.TransactionClient,
): Promise<void> {
  await lockActorAccess(db, actor.id);
  await assertCurrentAdmin(actor, db);
}

function isKnown(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

const SERIALIZABLE_RETRY_LIMIT = 3;

async function withSerializableRetry<T>(operation: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (attempt < SERIALIZABLE_RETRY_LIMIT) {
    try {
      return await operation();
    } catch (error) {
      attempt += 1;
      if (!isSerializationConflict(error) || attempt >= SERIALIZABLE_RETRY_LIMIT) throw error;
    }
  }
  throw new Error("PLATFORM_AI_ROUTE_SERIALIZABLE_RETRY_EXHAUSTED");
}

function normalizeDate(value: string | Date): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) return fail("PLATFORM_AI_ROUTE_INVALID_INPUT");
  return date;
}

function normalizePayload(
  operation: PlatformDefaultAiOperation,
  embeddingDimensions: number | null | undefined,
  maxOutputTokens: number | null | undefined,
): RoutePayload {
  if (operation === "embedding") {
    if (embeddingDimensions === null || embeddingDimensions === undefined || maxOutputTokens !== null && maxOutputTokens !== undefined) {
      return fail("PLATFORM_AI_ROUTE_INVALID_INPUT");
    }
    return { embeddingDimensions, maxOutputTokens: null };
  }
  if (embeddingDimensions !== null && embeddingDimensions !== undefined || maxOutputTokens === null) {
    return fail("PLATFORM_AI_ROUTE_INVALID_INPUT");
  }
  return { embeddingDimensions: null, maxOutputTokens: maxOutputTokens ?? 2_048 };
}

function assertProviderStructure(provider: ProviderForRoute | null): asserts provider is ProviderForRoute {
  if (
    provider === null
    || provider.scope !== "platform"
    || provider.workspaceId !== null
    || provider.ownerUserId !== null
    || provider.ownershipState !== "confirmed"
  ) return fail("PLATFORM_AI_ROUTE_PROVIDER_INVALID");
}

function assertCapability(
  operation: PlatformDefaultAiOperation,
  modelId: string,
  payload: RoutePayload,
  provider: ProviderForRoute,
): void {
  if (operation === "embedding") {
    if (
      !getProviderDefinition(provider.kind).supportsEmbeddings
      || provider.defaultEmbeddingModelId === null
      || provider.embeddingDimensions === null
      || modelId !== provider.defaultEmbeddingModelId
      || payload.embeddingDimensions !== provider.embeddingDimensions
      || payload.maxOutputTokens !== null
    ) return fail("PLATFORM_AI_ROUTE_CAPABILITY_MISMATCH");
    return;
  }
  if (operation === "visionExtract") {
    if (
      !getProviderDefinition(provider.kind).supportsVision
      || provider.defaultVisionModelId === null
      || modelId !== provider.defaultVisionModelId
      || payload.embeddingDimensions !== null
      || payload.maxOutputTokens === null
    ) return fail("PLATFORM_AI_ROUTE_CAPABILITY_MISMATCH");
    return;
  }
  if (payload.embeddingDimensions !== null || payload.maxOutputTokens === null || modelId !== provider.defaultGenerationModelId) {
    return fail("PLATFORM_AI_ROUTE_CAPABILITY_MISMATCH");
  }
}

function assertProviderUsable(
  operation: PlatformDefaultAiOperation,
  modelId: string,
  payload: RoutePayload,
  provider: ProviderForRoute | null,
): asserts provider is ProviderForRoute {
  assertProviderStructure(provider);
  if (provider.disabledAt !== null || provider.status === "disabled") return fail("PLATFORM_AI_ROUTE_PROVIDER_DISABLED");
  if (provider.status !== "verified") return fail("PLATFORM_AI_ROUTE_PROVIDER_NOT_VERIFIED");
  assertCapability(operation, modelId, payload, provider);
}

function assertDraftTarget(
  operation: PlatformDefaultAiOperation,
  modelId: string,
  payload: RoutePayload,
  provider: ProviderForRoute | null,
): asserts provider is ProviderForRoute {
  assertProviderStructure(provider);
  if (provider.disabledAt !== null || provider.status === "disabled") return fail("PLATFORM_AI_ROUTE_PROVIDER_DISABLED");
  assertCapability(operation, modelId, payload, provider);
}

function routeData(
  providerConnectionId: string,
  modelId: string,
  payload: RoutePayload,
  quotaMultiplierBps: number,
) {
  return {
    providerConnectionId,
    modelId,
    embeddingDimensions: payload.embeddingDimensions,
    maxOutputTokens: payload.maxOutputTokens,
    quotaMultiplierBps,
  };
}

function routeResponse(route: RouteWithProvider) {
  return Object.freeze({
    id: route.id,
    operation: route.operation,
    version: route.version,
    status: route.status,
    providerConnectionId: route.providerConnectionId,
    modelId: route.modelId,
    embeddingDimensions: route.embeddingDimensions,
    maxOutputTokens: route.maxOutputTokens,
    quotaMultiplierBps: route.quotaMultiplierBps,
    validatedProviderConfigurationVersion: route.validatedProviderConfigurationVersion,
    validatedAt: route.validatedAt,
    createdById: route.createdById,
    updatedById: route.updatedById,
    createdAt: route.createdAt,
    updatedAt: route.updatedAt,
  });
}

function safeSnapshot(route: RouteWithProvider, status = route.status): Prisma.InputJsonValue {
  return {
    operation: route.operation,
    version: route.version,
    status,
    modelId: route.modelId,
    embeddingDimensions: route.embeddingDimensions,
    maxOutputTokens: route.maxOutputTokens,
    quotaMultiplierBps: route.quotaMultiplierBps,
    validatedProviderConfigurationVersion: route.validatedProviderConfigurationVersion,
  } as Prisma.InputJsonValue;
}

async function writeAudit(
  db: RouteDb,
  route: RouteWithProvider,
  action: "draftCreated" | "draftUpdated" | "validated" | "activated" | "retired",
  actorId: string,
  reason?: string,
  status?: PlatformDefaultAiRouteStatus,
): Promise<void> {
  await db.platformDefaultAiRouteAudit.create({
    data: {
      action,
      routeId: route.id,
      operation: route.operation,
      routeVersion: route.version,
      providerConnectionId: route.providerConnectionId,
      providerConfigurationVersion: route.providerConnection.configurationVersion,
      actorId,
      reason: reason ?? null,
      safeSnapshot: safeSnapshot(route, status),
    },
  });
}

async function lockOperation(db: RouteDb, operation: PlatformDefaultAiOperation): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${operation}, 40904004))`;
}

// Keep provider configuration writes and route lifecycle transitions in the
// same transaction-scoped lock domain. A provider update that wins first will
// therefore invalidate the route before activation can commit, while a route
// activation that wins first is visible to the subsequent provider check.
async function lockProviderConfiguration(db: RouteDb, providerId: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${providerId}, 40904005))`;
}

async function lockProviderRow(db: RouteDb, providerId: string): Promise<void> {
  await db.$queryRaw`SELECT "id" FROM "AiProviderConnection" WHERE "id" = ${providerId} FOR UPDATE`;
}

async function findRoute(routeId: string, db: RouteDb): Promise<RouteWithProvider | null> {
  return db.platformDefaultAiRoute.findUnique({ where: { id: routeId }, select: routeSelect });
}

async function findRouteLockTarget(
  routeId: string,
  db: RouteDb,
): Promise<{ operation: PlatformDefaultAiOperation; providerConnectionId: string } | null> {
  return db.platformDefaultAiRoute.findUnique({
    where: { id: routeId },
    select: { operation: true, providerConnectionId: true },
  });
}

function routePayloadFromRecord(route: RouteWithProvider): RoutePayload {
  return normalizePayload(route.operation, route.embeddingDimensions, route.maxOutputTokens);
}

export async function createPlatformDefaultAiRoute(
  input: unknown,
  actor: PlatformDefaultAiRouteActor,
  db: PrismaClient = getDb(),
) {
  const actorHint = assertAdmin(actor);
  const parsed = parseRouteInput(input);
  const payload = normalizePayload(parsed.operation, parsed.embeddingDimensions, parsed.maxOutputTokens);
  try {
    return await withSerializableRetry(() => db.$transaction(async (tx) => {
      await lockAndAssertCurrentAdmin(actorHint, tx);
      await lockOperation(tx, parsed.operation);
      await lockProviderConfiguration(tx, parsed.providerConnectionId);
      const provider = await tx.aiProviderConnection.findUnique({
        where: { id: parsed.providerConnectionId },
        select: providerForRouteSelect,
      });
      if (provider === null) return fail("PLATFORM_AI_ROUTE_PROVIDER_NOT_FOUND");
      assertDraftTarget(parsed.operation, parsed.modelId, payload, provider);
      const latest = await tx.platformDefaultAiRoute.findFirst({
        where: { operation: parsed.operation },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const route = await tx.platformDefaultAiRoute.create({
        data: {
          operation: parsed.operation,
          version: (latest?.version ?? 0) + 1,
          status: "draft",
          ...routeData(parsed.providerConnectionId, parsed.modelId, payload, parsed.quotaMultiplierBps),
          createdById: actorHint.id,
          updatedById: actorHint.id,
        },
        select: routeSelect,
      });
      await writeAudit(tx, route, "draftCreated", actorHint.id, parsed.reason);
      return routeResponse(route);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  } catch (error) {
    if (isKnown(error, "P2002") || isSerializationConflict(error)) return fail("PLATFORM_AI_ROUTE_CONFLICT");
    throw error;
  }
}

export async function updatePlatformDefaultAiRoute(
  routeId: string,
  input: unknown,
  actor: PlatformDefaultAiRouteActor,
  db: PrismaClient = getDb(),
) {
  const actorHint = assertAdmin(actor);
  const id = parseRouteId(routeId);
  const parsed = parseRouteUpdate(input);
  const expectedUpdatedAt = normalizeDate(parsed.expectedUpdatedAt);
  try {
    return await withSerializableRetry(() => db.$transaction(async (tx) => {
      await lockAndAssertCurrentAdmin(actorHint, tx);
      const current = await findRoute(id, tx);
      if (current === null) return fail("PLATFORM_AI_ROUTE_NOT_FOUND");
      if (current.status !== "draft") return fail("PLATFORM_AI_ROUTE_NOT_DRAFT");
      await lockOperation(tx, current.operation);
      if (current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return fail("PLATFORM_AI_ROUTE_CONFLICT");
      const providerConnectionId = parsed.providerConnectionId ?? current.providerConnectionId;
      const modelId = parsed.modelId ?? current.modelId;
      await lockProviderConfiguration(tx, providerConnectionId);
      const payload = normalizePayload(
        current.operation,
        parsed.embeddingDimensions === undefined ? current.embeddingDimensions : parsed.embeddingDimensions,
        parsed.maxOutputTokens === undefined ? current.maxOutputTokens : parsed.maxOutputTokens,
      );
      const provider = await tx.aiProviderConnection.findUnique({ where: { id: providerConnectionId }, select: providerForRouteSelect });
      if (provider === null) return fail("PLATFORM_AI_ROUTE_PROVIDER_NOT_FOUND");
      assertDraftTarget(current.operation, modelId, payload, provider);
      const nextData = routeData(
        providerConnectionId,
        modelId,
        payload,
        parsed.quotaMultiplierBps ?? current.quotaMultiplierBps,
      );
      const changed = current.providerConnectionId !== nextData.providerConnectionId
        || current.modelId !== nextData.modelId
        || current.embeddingDimensions !== nextData.embeddingDimensions
        || current.maxOutputTokens !== nextData.maxOutputTokens
        || current.quotaMultiplierBps !== nextData.quotaMultiplierBps;
      if (!changed) return routeResponse(current);
      const updated = await tx.platformDefaultAiRoute.updateMany({
        where: { id, status: "draft", updatedAt: expectedUpdatedAt },
        data: {
          ...nextData,
          updatedById: actorHint.id,
          validatedProviderConfigurationVersion: null,
          validatedAt: null,
        },
      });
      if (updated.count !== 1) return fail("PLATFORM_AI_ROUTE_CONFLICT");
      const route = await findRoute(id, tx);
      if (route === null) return fail("PLATFORM_AI_ROUTE_CONFLICT");
      await writeAudit(tx, route, "draftUpdated", actorHint.id, parsed.reason);
      return routeResponse(route);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  } catch (error) {
    if (isKnown(error, "P2002") || isSerializationConflict(error)) return fail("PLATFORM_AI_ROUTE_CONFLICT");
    throw error;
  }
}

export async function validatePlatformDefaultAiRoute(
  routeId: string,
  actor: PlatformDefaultAiRouteActor,
  db: PrismaClient = getDb(),
  expectedUpdatedAt: string | Date,
) {
  const actorHint = assertAdmin(actor);
  const id = parseRouteId(routeId);
  const expected = normalizeDate(expectedUpdatedAt);
  try {
    return await withSerializableRetry(() => db.$transaction(async (tx) => {
      await lockAndAssertCurrentAdmin(actorHint, tx);
      const target = await findRouteLockTarget(id, tx);
      if (target === null) return fail("PLATFORM_AI_ROUTE_NOT_FOUND");
      await lockOperation(tx, target.operation);
      await lockProviderConfiguration(tx, target.providerConnectionId);
      await lockProviderRow(tx, target.providerConnectionId);
      const lockedCurrent = await findRoute(id, tx);
      if (lockedCurrent === null) return fail("PLATFORM_AI_ROUTE_NOT_FOUND");
      if (lockedCurrent.status !== "draft") return fail("PLATFORM_AI_ROUTE_NOT_DRAFT");
      if (lockedCurrent.updatedAt.getTime() !== expected.getTime()) return fail("PLATFORM_AI_ROUTE_CONFLICT");
      const currentProvider = lockedCurrent.providerConnection;
      const currentOperation = lockedCurrent.operation;
      const currentModelId = lockedCurrent.modelId;
      const currentPayload = routePayloadFromRecord(lockedCurrent);
      assertProviderUsable(currentOperation, currentModelId, currentPayload, currentProvider);
      const updated = await tx.platformDefaultAiRoute.updateMany({
        where: { id, status: "draft", updatedAt: expected },
        data: {
          status: "verified",
          validatedProviderConfigurationVersion: currentProvider.configurationVersion,
          validatedAt: new Date(),
          updatedById: actorHint.id,
        },
      });
      if (updated.count !== 1) return fail("PLATFORM_AI_ROUTE_CONFLICT");
      const route = await findRoute(id, tx);
      if (route === null) return fail("PLATFORM_AI_ROUTE_CONFLICT");
      await writeAudit(tx, route, "validated", actorHint.id);
      return routeResponse(route);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  } catch (error) {
    if (isSerializationConflict(error)) return fail("PLATFORM_AI_ROUTE_CONFLICT");
    throw error;
  }
}

export async function activatePlatformDefaultAiRoute(
  routeId: string,
  actor: PlatformDefaultAiRouteActor,
  db: PrismaClient = getDb(),
  expectedUpdatedAt: string | Date,
) {
  const actorHint = assertAdmin(actor);
  const id = parseRouteId(routeId);
  const expected = normalizeDate(expectedUpdatedAt);
  try {
    return await withSerializableRetry(() => db.$transaction(async (tx) => {
      await lockAndAssertCurrentAdmin(actorHint, tx);
      const target = await findRouteLockTarget(id, tx);
      if (target === null) return fail("PLATFORM_AI_ROUTE_NOT_FOUND");
      await lockOperation(tx, target.operation);
      await lockProviderConfiguration(tx, target.providerConnectionId);
      await lockProviderRow(tx, target.providerConnectionId);
      const lockedCurrent = await findRoute(id, tx);
      if (lockedCurrent === null) return fail("PLATFORM_AI_ROUTE_NOT_FOUND");
      if (lockedCurrent.updatedAt.getTime() !== expected.getTime()) return fail("PLATFORM_AI_ROUTE_CONFLICT");
      if (lockedCurrent.status !== "verified") {
        return fail("PLATFORM_AI_ROUTE_NOT_VALIDATED");
      }
      if (lockedCurrent.validatedProviderConfigurationVersion === null || lockedCurrent.validatedAt === null) return fail("PLATFORM_AI_ROUTE_NOT_VALIDATED");
      if (lockedCurrent.validatedProviderConfigurationVersion !== lockedCurrent.providerConnection.configurationVersion) return fail("PLATFORM_AI_ROUTE_CONFIGURATION_CHANGED");
      assertProviderUsable(lockedCurrent.operation, lockedCurrent.modelId, routePayloadFromRecord(lockedCurrent), lockedCurrent.providerConnection);

      const active = await tx.platformDefaultAiRoute.findFirst({
        where: { operation: lockedCurrent.operation, status: "active" },
        select: routeSelect,
      });
      if (active !== null && active.id !== lockedCurrent.id) {
        const retired = await tx.platformDefaultAiRoute.updateMany({
          where: { id: active.id, status: "active" },
          data: { status: "retired", updatedById: actorHint.id },
        });
        if (retired.count !== 1) return fail("PLATFORM_AI_ROUTE_CONFLICT");
        const retiredRoute = await findRoute(active.id, tx);
        if (retiredRoute !== null) await writeAudit(tx, retiredRoute, "retired", actorHint.id, "replaced by a newer active route");
      }
      const activated = await tx.platformDefaultAiRoute.updateMany({
        where: { id, status: "verified", updatedAt: expected },
        data: { status: "active", updatedById: actorHint.id },
      });
      if (activated.count !== 1) return fail("PLATFORM_AI_ROUTE_CONFLICT");
      const route = await findRoute(id, tx);
      if (route === null) return fail("PLATFORM_AI_ROUTE_CONFLICT");
      await writeAudit(tx, route, "activated", actorHint.id);
      return routeResponse(route);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  } catch (error) {
    if (isKnown(error, "P2002") || isSerializationConflict(error)) return fail("PLATFORM_AI_ROUTE_CONFLICT");
    throw error;
  }
}

export async function retirePlatformDefaultAiRoute(
  routeId: string,
  actor: PlatformDefaultAiRouteActor,
  reason: unknown,
  db: PrismaClient = getDb(),
  expectedUpdatedAt: string | Date,
) {
  const actorHint = assertAdmin(actor);
  const id = parseRouteId(routeId);
  const parsedReason = z.string().trim().min(1).max(500).safeParse(reason);
  if (!parsedReason.success) return fail("PLATFORM_AI_ROUTE_REASON_REQUIRED");
  const expected = normalizeDate(expectedUpdatedAt);
  try {
    return await withSerializableRetry(() => db.$transaction(async (tx) => {
      await lockAndAssertCurrentAdmin(actorHint, tx);
      const current = await findRoute(id, tx);
      if (current === null) return fail("PLATFORM_AI_ROUTE_NOT_FOUND");
      await lockOperation(tx, current.operation);
      if (current.updatedAt.getTime() !== expected.getTime()) return fail("PLATFORM_AI_ROUTE_CONFLICT");
      if (current.status === "retired") return fail("PLATFORM_AI_ROUTE_CONFLICT");
      const retired = await tx.platformDefaultAiRoute.updateMany({
        where: { id, status: current.status, updatedAt: expected },
        data: { status: "retired", updatedById: actorHint.id },
      });
      if (retired.count !== 1) return fail("PLATFORM_AI_ROUTE_CONFLICT");
      const route = await findRoute(id, tx);
      if (route === null) return fail("PLATFORM_AI_ROUTE_CONFLICT");
      await writeAudit(tx, route, "retired", actorHint.id, parsedReason.data);
      return routeResponse(route);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  } catch (error) {
    if (isSerializationConflict(error)) return fail("PLATFORM_AI_ROUTE_CONFLICT");
    throw error;
  }
}

export type PlatformDefaultAiRouteReadiness = Readonly<{
  operation: PlatformDefaultAiOperation;
  code: PlatformDefaultAiRouteReadinessCode;
  activeRouteId: string | null;
  activeRouteVersion: number | null;
  providerConnectionId: string | null;
  providerConfigurationVersion: number | null;
  validatedProviderConfigurationVersion: number | null;
  validatedAt: Date | null;
  /** The effective Web AI route resolver consumes this control-plane state. */
  runtimeConnected: true;
}>;

function readinessForOperation(
  operation: PlatformDefaultAiOperation,
  route: RouteWithProvider | undefined,
): PlatformDefaultAiRouteReadiness {
  if (route === undefined) {
    return Object.freeze({ operation, code: "missing", activeRouteId: null, activeRouteVersion: null, providerConnectionId: null, providerConfigurationVersion: null, validatedProviderConfigurationVersion: null, validatedAt: null, runtimeConnected: true as const });
  }
  const provider = route.providerConnection;
  let code: PlatformDefaultAiRouteReadinessCode = "ready";
  if (
    provider.scope !== "platform"
    || provider.workspaceId !== null
    || provider.ownerUserId !== null
    || provider.ownershipState !== "confirmed"
  ) code = "provider-invalid";
  else if (provider.disabledAt !== null || provider.status === "disabled") code = "provider-disabled";
  else if (
    route.validatedProviderConfigurationVersion !== null
    && route.validatedProviderConfigurationVersion !== provider.configurationVersion
  ) code = "configuration-changed";
  else if (provider.status !== "verified") code = "provider-not-verified";
  else if (route.validatedAt === null || route.validatedProviderConfigurationVersion === null) code = "not-validated";
  else {
    try {
      assertCapability(route.operation, route.modelId, routePayloadFromRecord(route), provider);
    } catch (error) {
      if (error instanceof PlatformDefaultAiRouteError) code = "capability-mismatch";
      else throw error;
    }
  }
  return Object.freeze({
    operation,
    code,
    activeRouteId: route.id,
    activeRouteVersion: route.version,
    providerConnectionId: route.providerConnectionId,
    providerConfigurationVersion: provider.configurationVersion,
    validatedProviderConfigurationVersion: route.validatedProviderConfigurationVersion,
    validatedAt: route.validatedAt,
    runtimeConnected: true,
  });
}

export async function getPlatformDefaultAiRouteReadiness(
  actor: PlatformDefaultAiRouteActor,
  db: PrismaClient = getDb(),
) {
  const actorHint = assertAdmin(actor);
  await assertCurrentAdmin(actorHint, db);
  const routes = await db.platformDefaultAiRoute.findMany({ where: { status: "active" }, select: routeSelect });
  const byOperation = new Map(routes.map((route) => [route.operation, route]));
  return Object.freeze({
    operations: Object.freeze(Object.fromEntries(
      PLATFORM_DEFAULT_AI_OPERATIONS.map((operation) => [operation, readinessForOperation(operation, byOperation.get(operation))]),
    ) as Record<PlatformDefaultAiOperation, PlatformDefaultAiRouteReadiness>),
    runtimeConnected: true as const,
  });
}

export type PlatformDefaultAiRouteImpact = Readonly<{
  routeId: string;
  operation: PlatformDefaultAiOperation;
  /** This describes resolver integration, not a successful provider call. */
  runtimeConnected: true;
  indexImpact: Readonly<{
    applicable: boolean;
    activeIndexCount: number;
    matchingActiveIndexCount: number;
    mismatchingActiveIndexCount: number;
    affectedProjectCount: number;
    affectedGenerationCount: number;
  }>;
}>;

export async function getPlatformDefaultAiRouteImpact(
  routeId: string,
  actor: PlatformDefaultAiRouteActor,
  db: PrismaClient = getDb(),
): Promise<PlatformDefaultAiRouteImpact> {
  const actorHint = assertAdmin(actor);
  await assertCurrentAdmin(actorHint, db);
  const id = parseRouteId(routeId);
  const route = await findRoute(id, db);
  if (route === null) return fail("PLATFORM_AI_ROUTE_NOT_FOUND");
  if (route.operation !== "embedding") {
    return Object.freeze({
      routeId: route.id,
      operation: route.operation,
      runtimeConnected: true,
      indexImpact: Object.freeze({ applicable: false, activeIndexCount: 0, matchingActiveIndexCount: 0, mismatchingActiveIndexCount: 0, affectedProjectCount: 0, affectedGenerationCount: 0 }),
    });
  }
  const pointers = await db.memoryIndexPointer.findMany({
    select: {
      projectId: true,
      indexGenerationId: true,
      generation: { select: { providerConnectionId: true, modelId: true, dimensions: true } },
    },
  });
  let matchingActiveIndexCount = 0;
  const affectedProjects = new Set<string>();
  const affectedGenerations = new Set<string>();
  for (const pointer of pointers) {
    const matches = pointer.generation.providerConnectionId === route.providerConnectionId
      && pointer.generation.modelId === route.modelId
      && pointer.generation.dimensions === route.embeddingDimensions;
    if (matches) {
      matchingActiveIndexCount += 1;
      continue;
    }
    affectedProjects.add(pointer.projectId);
    affectedGenerations.add(pointer.indexGenerationId);
  }
  return Object.freeze({
    routeId: route.id,
    operation: route.operation,
    runtimeConnected: true,
    indexImpact: Object.freeze({
      applicable: true,
      activeIndexCount: pointers.length,
      matchingActiveIndexCount,
      mismatchingActiveIndexCount: pointers.length - matchingActiveIndexCount,
      affectedProjectCount: affectedProjects.size,
      affectedGenerationCount: affectedGenerations.size,
    }),
  });
}

function auditResponse(audit: Prisma.PlatformDefaultAiRouteAuditGetPayload<{ select: {
  id: true;
  action: true;
  routeId: true;
  operation: true;
  routeVersion: true;
  providerConnectionId: true;
  providerConfigurationVersion: true;
  actorId: true;
  reason: true;
  safeSnapshot: true;
  createdAt: true;
} }>) {
  return Object.freeze({
    id: audit.id,
    action: audit.action,
    routeId: audit.routeId,
    operation: audit.operation,
    routeVersion: audit.routeVersion,
    providerConnectionId: audit.providerConnectionId,
    providerConfigurationVersion: audit.providerConfigurationVersion,
    actorId: audit.actorId,
    reason: audit.reason,
    safeSnapshot: audit.safeSnapshot,
    createdAt: audit.createdAt,
  });
}

export async function listPlatformDefaultAiRouteAudits(
  actor: PlatformDefaultAiRouteActor,
  db: PrismaClient = getDb(),
  limit = 50,
) {
  const actorHint = assertAdmin(actor);
  await assertCurrentAdmin(actorHint, db);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return fail("PLATFORM_AI_ROUTE_INVALID_INPUT");
  const audits = await db.platformDefaultAiRouteAudit.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      action: true,
      routeId: true,
      operation: true,
      routeVersion: true,
      providerConnectionId: true,
      providerConfigurationVersion: true,
      actorId: true,
      reason: true,
      safeSnapshot: true,
      createdAt: true,
    },
  });
  return audits.map(auditResponse);
}

export async function listPlatformDefaultAiRoutes(
  actor: PlatformDefaultAiRouteActor,
  db: PrismaClient = getDb(),
) {
  const actorHint = assertAdmin(actor);
  await assertCurrentAdmin(actorHint, db);
  const [routes, providers, readiness, audits] = await Promise.all([
    db.platformDefaultAiRoute.findMany({ orderBy: [{ operation: "asc" }, { version: "desc" }], select: routeSelect }),
    db.aiProviderConnection.findMany({ where: { scope: "platform" }, orderBy: { createdAt: "asc" }, select: providerListSelect }),
    getPlatformDefaultAiRouteReadiness(actorHint, db),
    listPlatformDefaultAiRouteAudits(actorHint, db),
  ]);
  return Object.freeze({
    operations: PLATFORM_DEFAULT_AI_OPERATIONS,
    routes: routes.map(routeResponse),
    providers,
    readiness,
    audits,
    runtimeConnected: true as const,
  });
}

export async function runPlatformDefaultAiRouteLifecycle(
  routeId: string,
  input: unknown,
  actor: PlatformDefaultAiRouteActor,
  db: PrismaClient = getDb(),
) {
  const actorHint = assertAdmin(actor);
  const parsed = parseLifecycleInput(input);
  if (parsed.action === "validate") {
    return validatePlatformDefaultAiRoute(routeId, actorHint, db, parsed.expectedUpdatedAt);
  }
  if (parsed.action === "activate") {
    return activatePlatformDefaultAiRoute(routeId, actorHint, db, parsed.expectedUpdatedAt);
  }
  return retirePlatformDefaultAiRoute(routeId, actorHint, parsed.reason, db, parsed.expectedUpdatedAt);
}

export const PLATFORM_DEFAULT_AI_ROUTE_OPERATION_LABELS: Readonly<Record<PlatformDefaultAiOperation, string>> = Object.freeze({
  embedding: "embedding",
  visionExtract: "visionExtract",
  autoExtract: "autoExtract",
  sourceSummary: "sourceSummary",
  projectAnalysis: "projectAnalysis",
  generateWithContext: "generateWithContext",
});

export type PlatformDefaultAiRouteProviderStatus = AiProviderConnectionStatus;
export type PlatformDefaultAiRouteStatusValue = PlatformDefaultAiRouteStatus;
