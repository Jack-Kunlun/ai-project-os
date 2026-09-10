import { Prisma, type AiProviderKind, type AiProviderScope, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { lockMembershipUser } from "@/lib/ai-entitlements";
import { createCredential, rotateCredential } from "@/lib/credential-vault";
import { getDb } from "@/lib/db";
import {
  PROVIDER_DEFINITIONS,
  canonicalProviderBaseUrl,
  getProviderDefinition,
  isSafeModelId,
} from "./registry";
import {
  PROVIDER_CONNECTION_TEST_TRANSACTION_TIMEOUT_MS,
  PROVIDER_REQUEST_TIMEOUT_MS,
  ProviderTransportError,
  invokeChatCompletion,
  invokeEmbeddings,
  invokeVisionCompletion,
} from "./transport";
import { isSerializationConflict } from "@/lib/project-snapshot-errors";
import { AccountAccessGuardError, assertAccountAccessForActor, requireAccountAccessVersion } from "@/lib/account-access-guard";

export type ProviderServiceErrorCode =
  | "AI_PROVIDER_INVALID_INPUT"
  | "AI_PROVIDER_ADMIN_REQUIRED"
  | "AI_PROVIDER_NOT_FOUND"
  | "AI_PROVIDER_NAME_CONFLICT"
  | "AI_PROVIDER_IN_USE"
  | "AI_PROVIDER_DELETE_REQUIRES_DISABLED"
  | "AI_PROVIDER_CONFIRMATION_MISMATCH"
  | "AI_PROVIDER_CONNECTION_UNAVAILABLE"
  | "AI_PROVIDER_CONFLICT";

export class ProviderServiceError extends Error {
  constructor(readonly code: ProviderServiceErrorCode) {
    super(code);
    this.name = "ProviderServiceError";
  }
}

export type ProviderDb = PrismaClient | Prisma.TransactionClient;

/**
 * The platform provider control plane is a system-admin-only surface. Keep
 * this actor contract separate from workspace actors so a workspace role can
 * never accidentally authorize a platform-owned connection.
 */
export type PlatformProviderActor = Readonly<{ id: string; role: string; accountAccessVersion?: number }>;

function isPrismaClient(db: ProviderDb): db is PrismaClient {
  return typeof (db as unknown as { $transaction?: unknown }).$transaction === "function";
}

const modelIdSchema = z.string().trim().min(1).max(128).refine(isSafeModelId);
const providerKindSchema = z.enum(["openai", "deepseek", "qwen", "glm"]);
const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: providerKindSchema,
  apiKey: z.string().min(8).max(512),
  generationModelId: modelIdSchema.nullable().optional(),
  visionModelId: modelIdSchema.nullable().optional(),
  embeddingModelId: modelIdSchema.nullable().optional(),
  embeddingDimensions: z.number().int().min(8).max(8192).nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.generationModelId == null && value.embeddingModelId == null) {
    context.addIssue({ code: "custom", path: ["generationModelId"], message: "至少配置一种模型能力" });
  }
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  apiKey: z.string().min(8).max(512).optional(),
  generationModelId: modelIdSchema.nullable().optional(),
  visionModelId: modelIdSchema.nullable().optional(),
  embeddingModelId: modelIdSchema.nullable().optional(),
  embeddingDimensions: z.number().int().min(8).max(8192).nullable().optional(),
  enabled: z.boolean().optional(),
}).strict();

const deleteSchema = z.object({
  confirmationName: z.string().min(1).max(80),
}).strict();

// A deterministic 1x1 PNG keeps the vision probe bounded and avoids sending
// user/project content merely to establish that the configured capability is
// reachable. A vision capability is not marked verified unless this probe
// succeeds alongside the other configured capability probes.
const VISION_PROBE_IMAGE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const providerSelect = {
  id: true,
  name: true,
  kind: true,
  scope: true,
  protocol: true,
  baseUrl: true,
  defaultGenerationModelId: true,
  defaultEmbeddingModelId: true,
  defaultVisionModelId: true,
  embeddingDimensions: true,
  configurationVersion: true,
  status: true,
  lastTestedAt: true,
  lastErrorCode: true,
  disabledAt: true,
  createdAt: true,
  updatedAt: true,
  credential: { select: { maskedSuffix: true, rotatedAt: true, updatedAt: true } },
  _count: {
    select: {
      platformDefaultAiRoutes: { where: { status: "active" } },
    },
  },
} as const;

function fail(code: ProviderServiceErrorCode): never {
  throw new ProviderServiceError(code);
}

function isKnown(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

// Provider configuration writes and default-route lifecycle transitions share
// this transaction-scoped advisory lock. That closes the check-then-write gap
// between a route activation/readiness check and a provider lifecycle change.
export async function lockProviderConfiguration(db: ProviderDb, providerId: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${providerId}, 40904005))`;
}

/**
 * Reload a provider only after joining the control-plane configuration fence.
 * Dispatch callers must use the returned row for capability/ownership checks;
 * a provider object captured before this lock is only a routing hint.
 */
export async function reloadProviderConfiguration(
  db: ProviderDb,
  providerId: string,
) {
  await lockProviderConfiguration(db, providerId);
  return db.aiProviderConnection.findUnique({ where: { id: providerId } });
}

function assertEmbeddingConfiguration(
  kind: AiProviderKind,
  modelId: string | null | undefined,
  dimensions: number | null | undefined,
): void {
  const supports = getProviderDefinition(kind).supportsEmbeddings;
  if (!supports && (modelId != null || dimensions != null)) return fail("AI_PROVIDER_INVALID_INPUT");
  if ((modelId == null) !== (dimensions == null)) return fail("AI_PROVIDER_INVALID_INPUT");
}

function assertVisionConfiguration(kind: AiProviderKind, modelId: string | null | undefined): void {
  if (!getProviderDefinition(kind).supportsVision && modelId != null) return fail("AI_PROVIDER_INVALID_INPUT");
  if (kind === "deepseek" && modelId != null && modelId !== "deepseek-v4-flash-vision-exp") {
    return fail("AI_PROVIDER_INVALID_INPUT");
  }
}

function assertAtLeastOneCapability(
  generationModelId: string | null | undefined,
  visionModelId: string | null | undefined,
  embeddingModelId: string | null | undefined,
): void {
  if (generationModelId == null && embeddingModelId == null) {
    return fail("AI_PROVIDER_INVALID_INPUT");
  }
}

export function providerCatalog() {
  return PROVIDER_DEFINITIONS.map((definition) => ({
    kind: definition.kind,
    displayName: definition.displayName,
    baseUrl: definition.baseUrl,
    apiKeyLabel: definition.apiKeyLabel,
    generationModelSuggestions: definition.generationModelSuggestions,
    embeddingModelSuggestions: definition.embeddingModelSuggestions,
    visionModelSuggestions: definition.visionModelSuggestions,
    supportsEmbeddings: definition.supportsEmbeddings,
    supportsVision: definition.supportsVision,
  }));
}

/**
 * Authorize platform provider administration before parsing request input or
 * touching any provider/credential row. The role carried by a session is only
 * a hint for direct service callers; the current AppUser row is reloaded so a
 * disabled or demoted administrator cannot keep using a stale actor object.
 */
export function assertPlatformProviderAdminHint(actor: unknown): PlatformProviderActor {
  if (typeof actor !== "object" || actor === null) return fail("AI_PROVIDER_ADMIN_REQUIRED");
  const candidate = actor as { id?: unknown; role?: unknown; accountAccessVersion?: unknown };
  const parsedId = z.string().uuid().safeParse(candidate.id);
  if (!parsedId.success || candidate.role !== "admin") return fail("AI_PROVIDER_ADMIN_REQUIRED");
  let accountAccessVersion: number;
  try {
    accountAccessVersion = requireAccountAccessVersion(candidate);
  } catch (error) {
    if (error instanceof AccountAccessGuardError) return fail("AI_PROVIDER_ADMIN_REQUIRED");
    throw error;
  }
  return Object.freeze({ id: parsedId.data, role: "admin", accountAccessVersion });
}

async function assertPlatformProviderAdminRecord(
  actor: PlatformProviderActor,
  db: ProviderDb,
): Promise<PlatformProviderActor> {
  const current = await db.appUser.findUnique({
    where: { id: actor.id },
    select: { id: true, role: true, disabledAt: true, accountAccessVersion: true },
  });
  if (current === null || current.role !== "admin" || current.disabledAt !== null) {
    return fail("AI_PROVIDER_ADMIN_REQUIRED");
  }
  try {
    await assertAccountAccessForActor(db, actor);
  } catch (error) {
    if (error instanceof AccountAccessGuardError) return fail("AI_PROVIDER_ADMIN_REQUIRED");
    throw error;
  }
  return Object.freeze({ id: current.id, role: "admin", accountAccessVersion: current.accountAccessVersion });
}

/**
 * Read-only callers can use this guard directly. Mutating and network paths
 * must call the shape-only hint first and then re-check the row after taking
 * the actor lock inside their transaction.
 */
export async function assertPlatformProviderAdmin(
  actor: unknown,
  db: ProviderDb,
): Promise<PlatformProviderActor> {
  return assertPlatformProviderAdminRecord(assertPlatformProviderAdminHint(actor), db);
}

export async function listProviderConnections(
  actor: PlatformProviderActor,
  db: PrismaClient = getDb(),
) {
  await assertPlatformProviderAdmin(actor, db);
  return db.aiProviderConnection.findMany({ where: { scope: "platform" }, orderBy: { createdAt: "asc" }, select: providerSelect });
}

export async function createProviderConnection(
  input: unknown,
  actor: PlatformProviderActor,
  db: PrismaClient = getDb(),
) {
  const actorHint = assertPlatformProviderAdminHint(actor);
  try {
    return await db.$transaction(async (tx) => {
      await lockMembershipUser(tx, actorHint.id);
      await assertPlatformProviderAdminRecord(actorHint, tx);
      const parsed = createSchema.parse(input);
      assertEmbeddingConfiguration(parsed.kind, parsed.embeddingModelId, parsed.embeddingDimensions);
      assertVisionConfiguration(parsed.kind, parsed.visionModelId);
      assertAtLeastOneCapability(parsed.generationModelId, parsed.visionModelId, parsed.embeddingModelId);
      const credential = await createCredential("aiProvider", parsed.apiKey, tx);
      return tx.aiProviderConnection.create({
        data: {
          name: parsed.name,
          kind: parsed.kind,
          scope: "platform",
          ownerUserId: null,
          baseUrl: canonicalProviderBaseUrl(parsed.kind),
          credentialId: credential.id,
          defaultGenerationModelId: parsed.generationModelId ?? null,
          defaultVisionModelId: parsed.visionModelId ?? null,
          defaultEmbeddingModelId: parsed.embeddingModelId ?? null,
          embeddingDimensions: parsed.embeddingDimensions ?? null,
        },
        select: providerSelect,
      });
    });
  } catch (error) {
    if (isKnown(error, "P2002")) return fail("AI_PROVIDER_NAME_CONFLICT");
    throw error;
  }
}

export async function updateProviderConnection(
  providerId: string,
  input: unknown,
  actor: PlatformProviderActor,
  db: PrismaClient = getDb(),
) {
  const actorHint = assertPlatformProviderAdminHint(actor);
  try {
    return await db.$transaction(async (tx) => {
      await lockMembershipUser(tx, actorHint.id);
      await assertPlatformProviderAdminRecord(actorHint, tx);
      const parsed = updateSchema.parse(input);
      await lockProviderConfiguration(tx, providerId);
      const existing = await tx.aiProviderConnection.findFirst({ where: { id: providerId, scope: "platform" } });
      if (existing === null) return fail("AI_PROVIDER_NOT_FOUND");
      if (parsed.enabled === false) {
        const activeDefaultRouteCount = await tx.platformDefaultAiRoute.count({
          where: { providerConnectionId: providerId, status: "active" },
        });
        if (activeDefaultRouteCount > 0) return fail("AI_PROVIDER_IN_USE");
      }
      const nextModel = parsed.embeddingModelId === undefined
        ? existing.defaultEmbeddingModelId
        : parsed.embeddingModelId;
      const nextDimensions = parsed.embeddingDimensions === undefined
        ? existing.embeddingDimensions
        : parsed.embeddingDimensions;
      assertEmbeddingConfiguration(existing.kind, nextModel, nextDimensions);
      assertVisionConfiguration(
        existing.kind,
        parsed.visionModelId === undefined ? existing.defaultVisionModelId : parsed.visionModelId,
      );
      const nextGeneration = parsed.generationModelId === undefined ? existing.defaultGenerationModelId : parsed.generationModelId;
      const nextVision = parsed.visionModelId === undefined ? existing.defaultVisionModelId : parsed.visionModelId;
      assertAtLeastOneCapability(nextGeneration, nextVision, nextModel);
      const modelConfigurationChanged =
        (parsed.generationModelId !== undefined && parsed.generationModelId !== existing.defaultGenerationModelId)
        || (parsed.visionModelId !== undefined && parsed.visionModelId !== existing.defaultVisionModelId)
        || (parsed.embeddingModelId !== undefined && parsed.embeddingModelId !== existing.defaultEmbeddingModelId)
        || (parsed.embeddingDimensions !== undefined && parsed.embeddingDimensions !== existing.embeddingDimensions)
        || parsed.apiKey !== undefined;
      const currentlyEnabled = existing.status !== "disabled" && existing.disabledAt === null;
      const lifecycleChanged = parsed.enabled !== undefined && parsed.enabled !== currentlyEnabled;
      const configurationChanged = modelConfigurationChanged || lifecycleChanged;
      if (parsed.apiKey !== undefined) {
        await rotateCredential(existing.credentialId, "aiProvider", parsed.apiKey, tx);
      }
      return tx.aiProviderConnection.update({
        where: { id: providerId },
        data: {
          ...(parsed.name !== undefined ? { name: parsed.name } : {}),
          ...(parsed.generationModelId !== undefined
            ? { defaultGenerationModelId: parsed.generationModelId }
            : {}),
          ...(parsed.visionModelId !== undefined
            ? { defaultVisionModelId: parsed.visionModelId }
            : {}),
          ...(parsed.embeddingModelId !== undefined
            ? { defaultEmbeddingModelId: parsed.embeddingModelId }
            : {}),
          ...(parsed.embeddingDimensions !== undefined
            ? { embeddingDimensions: parsed.embeddingDimensions }
            : {}),
          ...(configurationChanged
            ? {
                configurationVersion: { increment: 1 },
                status: parsed.enabled === false ? "disabled" : "configured",
                disabledAt: parsed.enabled === false ? new Date() : null,
                lastErrorCode: null,
                lastTestedAt: null,
              }
            : {}),
        },
        select: providerSelect,
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error) {
    if (isKnown(error, "P2002")) return fail("AI_PROVIDER_NAME_CONFLICT");
    if (isSerializationConflict(error)) return fail("AI_PROVIDER_CONFLICT");
    throw error;
  }
}

export async function disableProviderConnection(
  providerId: string,
  actor: PlatformProviderActor,
  db: PrismaClient = getDb(),
) {
  const actorHint = assertPlatformProviderAdminHint(actor);
  try {
    return await db.$transaction(async (tx) => {
      await lockMembershipUser(tx, actorHint.id);
      await assertPlatformProviderAdminRecord(actorHint, tx);
      await lockProviderConfiguration(tx, providerId);
      const provider = await tx.aiProviderConnection.findFirst({
        where: { id: providerId, scope: "platform" },
        select: {
          id: true,
          status: true,
          disabledAt: true,
        },
      });
      if (provider === null) return fail("AI_PROVIDER_NOT_FOUND");
      const activeDefaultRouteCount = await tx.platformDefaultAiRoute.count({
        where: { providerConnectionId: providerId, status: "active" },
      });
      if (activeDefaultRouteCount > 0) return fail("AI_PROVIDER_IN_USE");
      if (provider.status === "disabled" && provider.disabledAt !== null) {
        return tx.aiProviderConnection.findFirst({ where: { id: providerId, scope: "platform" }, select: providerSelect });
      }
      return tx.aiProviderConnection.update({
        where: { id: providerId },
        data: { status: "disabled", disabledAt: new Date(), configurationVersion: { increment: 1 } },
        select: providerSelect,
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error) {
    if (isSerializationConflict(error)) return fail("AI_PROVIDER_CONFLICT");
    throw error;
  }
}

export async function deleteProviderConnection(
  providerId: string,
  input: unknown,
  actor: PlatformProviderActor,
  db: PrismaClient = getDb(),
) {
  const actorHint = assertPlatformProviderAdminHint(actor);
  try {
    return await db.$transaction(async (tx) => {
      await lockMembershipUser(tx, actorHint.id);
      await assertPlatformProviderAdminRecord(actorHint, tx);
      const parsed = deleteSchema.parse(input);
      await lockProviderConfiguration(tx, providerId);
      const provider = await tx.aiProviderConnection.findFirst({
        where: { id: providerId, scope: "platform" },
        select: {
          id: true,
          name: true,
          status: true,
          credentialId: true,
          _count: {
            select: {
              webAiGrants: true,
              memoryIndexGenerations: true,
              ragAnswers: true,
              webAiCandidates: true,
              providerCalls: true,
              intelligenceReports: true,
              projectAgentRuns: true,
              assetExtractionRuns: true,
              assetSegments: true,
              platformDefaultAiRoutes: true,
            },
          },
        },
      });
      if (provider === null) return fail("AI_PROVIDER_NOT_FOUND");
      if (provider.status !== "disabled") return fail("AI_PROVIDER_DELETE_REQUIRES_DISABLED");
      if (provider.name !== parsed.confirmationName) return fail("AI_PROVIDER_CONFIRMATION_MISMATCH");
      if (Object.values(provider._count).some((count) => count > 0)) return fail("AI_PROVIDER_IN_USE");
      await tx.aiProviderConnection.delete({ where: { id: provider.id } });
      await tx.externalCredential.delete({ where: { id: provider.credentialId } });
      return Object.freeze({ id: provider.id });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (isKnown(error, "P2003")) return fail("AI_PROVIDER_IN_USE");
    if (isSerializationConflict(error)) return fail("AI_PROVIDER_CONFLICT");
    throw error;
  }
}

export type ProviderTestOptions = Readonly<{
  expectedUpdatedAt?: Date;
  expectedOwnerUserId?: string | null;
}>;

async function commitVerifiedProviderInTransaction(
  providerId: string,
  scope: AiProviderScope,
  startedUpdatedAt: Date,
  db: ProviderDb,
  options: ProviderTestOptions = {},
) {
  if (options.expectedOwnerUserId !== undefined) {
    const current = await db.aiProviderConnection.findFirst({
      where: { id: providerId, scope, status: { not: "disabled" }, updatedAt: startedUpdatedAt },
      select: { ownerUserId: true },
    });
    if (current === null || current.ownerUserId !== options.expectedOwnerUserId) return fail("AI_PROVIDER_CONFLICT");
  }
  const updated = await db.aiProviderConnection.updateMany({
    where: { id: providerId, scope, status: { not: "disabled" }, updatedAt: startedUpdatedAt },
    data: { status: "verified", lastTestedAt: new Date(), lastErrorCode: null, disabledAt: null },
  });
  if (updated.count !== 1) return fail("AI_PROVIDER_CONFLICT");
  return db.aiProviderConnection.findFirst({ where: { id: providerId, scope }, select: providerSelect });
}

async function commitVerifiedProvider(
  providerId: string,
  scope: AiProviderScope,
  startedUpdatedAt: Date,
  db: ProviderDb,
  options: ProviderTestOptions = {},
) {
  if (!isPrismaClient(db)) return commitVerifiedProviderInTransaction(providerId, scope, startedUpdatedAt, db, options);
  return db.$transaction((tx) => commitVerifiedProviderInTransaction(providerId, scope, startedUpdatedAt, tx, options));
}

async function markProviderTestErrorInTransaction(
  providerId: string,
  scope: AiProviderScope,
  startedUpdatedAt: Date,
  code: string,
  db: ProviderDb,
  options: ProviderTestOptions,
): Promise<boolean> {
  if (options.expectedOwnerUserId !== undefined) {
    const current = await db.aiProviderConnection.findFirst({
      where: { id: providerId, scope, status: { not: "disabled" }, updatedAt: startedUpdatedAt },
      select: { ownerUserId: true },
    });
    if (current === null || current.ownerUserId !== options.expectedOwnerUserId) return false;
  }
  const marked = await db.aiProviderConnection.updateMany({
    where: { id: providerId, scope, status: { not: "disabled" }, updatedAt: startedUpdatedAt },
    data: { status: "error", lastTestedAt: new Date(), lastErrorCode: code },
  });
  return marked.count === 1;
}

async function markProviderTestError(
  providerId: string,
  scope: AiProviderScope,
  startedUpdatedAt: Date,
  code: string,
  db: ProviderDb,
  options: ProviderTestOptions,
): Promise<boolean> {
  if (!isPrismaClient(db)) {
    return markProviderTestErrorInTransaction(providerId, scope, startedUpdatedAt, code, db, options);
  }
  return db.$transaction((tx) => markProviderTestErrorInTransaction(providerId, scope, startedUpdatedAt, code, tx, options));
}

async function testProviderConnectionInScope(
  providerId: string,
  db: ProviderDb = getDb(),
  scope: AiProviderScope = "platform",
  options: ProviderTestOptions = {},
) {
  const provider = await db.aiProviderConnection.findFirst({ where: { id: providerId, scope } });
  if (provider === null) return fail("AI_PROVIDER_NOT_FOUND");
  if (options.expectedUpdatedAt !== undefined && provider.updatedAt.getTime() !== options.expectedUpdatedAt.getTime()) {
    return fail("AI_PROVIDER_CONFLICT");
  }
  if (options.expectedOwnerUserId !== undefined && provider.ownerUserId !== options.expectedOwnerUserId) {
    return fail("AI_PROVIDER_CONFLICT");
  }
  if (provider.status === "disabled" || provider.disabledAt !== null) return fail("AI_PROVIDER_CONNECTION_UNAVAILABLE");
  const startedUpdatedAt = provider.updatedAt;
  const absoluteDeadlineAt = new Date(Date.now() + PROVIDER_REQUEST_TIMEOUT_MS);
  try {
    const generation = provider.defaultGenerationModelId === null
      ? null
      : await invokeChatCompletion({
          connection: provider,
          operation: "projectAnalysis",
          modelId: provider.defaultGenerationModelId,
          messages: [
            { role: "system", content: "You are a connectivity probe. Follow the exact reply constraint." },
            { role: "user", content: "Reply with exactly: OK" },
          ],
          maxOutputTokens: 8,
          temperature: 0,
          absoluteDeadlineAt,
        });
    const embedding = provider.defaultEmbeddingModelId === null
      ? null
      : await invokeEmbeddings({
          connection: provider,
          modelId: provider.defaultEmbeddingModelId,
          texts: ["AI Project OS provider connectivity test"],
          expectedDimensions: provider.embeddingDimensions,
          absoluteDeadlineAt,
        });
    const vision = provider.defaultVisionModelId === null
      ? null
      : await invokeVisionCompletion({
          connection: provider,
          modelId: provider.defaultVisionModelId,
          image: VISION_PROBE_IMAGE,
          mimeType: "image/png",
          prompt: "Return exactly: OK",
          maxOutputTokens: 8,
          absoluteDeadlineAt,
        });
    const updated = await commitVerifiedProvider(providerId, scope, startedUpdatedAt, db, options);
    if (updated === null) return fail("AI_PROVIDER_CONFLICT");
    return Object.freeze({
      provider: updated,
      check: {
        generation: generation?.content.trim().slice(0, 32) ?? null,
        embeddingDimensions: embedding?.dimensions ?? null,
        vision: vision?.content.trim().slice(0, 32) ?? null,
      },
    });
  } catch (error) {
    // A failed final membership/CAS re-check is a conflict, not a provider
    // probe failure. Never overwrite the connection with an error state after
    // another operation changed its authorization or lifecycle state.
    if (error instanceof ProviderServiceError && error.code === "AI_PROVIDER_CONFLICT") throw error;
    const code = error instanceof ProviderTransportError ? error.code : "AI_PROVIDER_UNAVAILABLE";
    let markedError = false;
    try {
      markedError = await markProviderTestError(providerId, scope, startedUpdatedAt, code, db, options);
    } catch {
      return fail("AI_PROVIDER_CONFLICT");
    }
    if (!markedError) return fail("AI_PROVIDER_CONFLICT");
    throw error;
  }
}

/**
 * Explicit platform probe entry point. Authorization is performed before the
 * provider row, credential vault, or transport can be touched.
 */
export async function testPlatformProviderConnection(
  providerId: string,
  actor: PlatformProviderActor,
  db: ProviderDb = getDb(),
) {
  const actorHint = assertPlatformProviderAdminHint(actor);
  if (!isPrismaClient(db)) {
    await lockMembershipUser(db, actorHint.id);
    await assertPlatformProviderAdminRecord(actorHint, db);
    await lockProviderConfiguration(db, providerId);
    return testProviderConnectionInScope(providerId, db, "platform");
  }
  return db.$transaction(
    async (tx) => {
      await lockMembershipUser(tx, actorHint.id);
      await assertPlatformProviderAdminRecord(actorHint, tx);
      await lockProviderConfiguration(tx, providerId);
      return testProviderConnectionInScope(providerId, tx, "platform");
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: PROVIDER_CONNECTION_TEST_TRANSACTION_TIMEOUT_MS,
    },
  );
}
