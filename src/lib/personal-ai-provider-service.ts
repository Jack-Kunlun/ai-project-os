import { Prisma, type AiProviderConnection, type AiProviderConnectionStatus, type AiProviderKind, type AiProviderProtocol, type AiProviderScope, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { getMembershipStatus, lockMembershipUser } from "@/lib/ai-entitlements";
import { createCredential, rotateCredential } from "@/lib/credential-vault";
import { getDb } from "@/lib/db";
import { isSerializationConflict } from "@/lib/project-snapshot-errors";
import { canonicalProviderBaseUrl, getProviderDefinition, isSafeModelId } from "@/lib/ai-providers/registry";
import {
  PROVIDER_CONNECTION_TEST_TRANSACTION_TIMEOUT_MS,
  PROVIDER_REQUEST_TIMEOUT_MS,
  ProviderTransportError,
  invokeChatCompletion,
  invokeEmbeddings,
  invokeVisionCompletion,
} from "@/lib/ai-providers/transport";
import { lockProviderConfiguration } from "@/lib/ai-providers/service";

export type PersonalProviderActor = Readonly<{ id: string; role: "admin" | "user" }>;

export type PersonalProviderServiceErrorCode =
  | "AI_PROVIDER_INVALID_INPUT"
  | "AI_PROVIDER_FORBIDDEN"
  | "AI_PROVIDER_NOT_FOUND"
  | "AI_PROVIDER_NAME_CONFLICT"
  | "AI_PROVIDER_IN_USE"
  | "AI_PROVIDER_DELETE_REQUIRES_DISABLED"
  | "AI_PROVIDER_CONFIRMATION_MISMATCH"
  | "AI_PROVIDER_CONNECTION_UNAVAILABLE"
  | "AI_PROVIDER_CONFLICT"
  | "AI_MEMBERSHIP_REQUIRED"
  | "AI_MEMBERSHIP_EXPIRED";

export class PersonalProviderServiceError extends Error {
  constructor(readonly code: PersonalProviderServiceErrorCode) {
    super(code);
    this.name = "PersonalProviderServiceError";
  }
}

type PersonalProviderDb = PrismaClient | Prisma.TransactionClient;

const providerIdSchema = z.string().uuid();
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
}).strict();

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  apiKey: z.string().min(8).max(512).optional(),
  generationModelId: modelIdSchema.nullable().optional(),
  visionModelId: modelIdSchema.nullable().optional(),
  embeddingModelId: modelIdSchema.nullable().optional(),
  embeddingDimensions: z.number().int().min(8).max(8192).nullable().optional(),
  enabled: z.boolean().optional(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

const deleteSchema = z.object({
  confirmationName: z.string().trim().min(1).max(80),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

const publicProviderSelect = {
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
} as const;

const internalProviderSelect = {
  ...publicProviderSelect,
  scope: true,
  ownerUserId: true,
  credentialId: true,
} as const;

const mutationProviderSelect = {
  ...internalProviderSelect,
  _count: { select: { projectRoutes: true } },
} as const;

const deleteProviderSelect = {
  ...internalProviderSelect,
  _count: {
    select: {
      projectRoutes: true,
      aiRouteRevisionsOld: true,
      aiRouteRevisionsNew: true,
      webAiGrants: true,
      memoryIndexGenerations: true,
      ragAnswers: true,
      webAiCandidates: true,
      providerCalls: true,
      intelligenceReports: true,
      projectAgentRuns: true,
      assetExtractionRuns: true,
      assetSegments: true,
      tokenReservations: true,
      platformDefaultAiRoutes: true,
      platformDefaultAiRouteAudits: true,
      ownershipAudits: true,
    },
  },
} as const;

const testProviderSelect = {
  ...internalProviderSelect,
  credential: { select: { secretFingerprint: true } },
} as const;

const testProviderPublicSelect = publicProviderSelect;

// A deterministic 1x1 PNG prevents a connectivity test from sending user or
// project content to the configured provider.
const VISION_PROBE_IMAGE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function fail(code: PersonalProviderServiceErrorCode): never {
  throw new PersonalProviderServiceError(code);
}

function isKnown(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function isPrismaClient(db: PersonalProviderDb): db is PrismaClient {
  return typeof (db as unknown as { $transaction?: unknown }).$transaction === "function";
}

const SERIALIZABLE_RETRY_LIMIT = 3;

async function withSerializableRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= SERIALIZABLE_RETRY_LIMIT; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if ((!isKnown(error, "P2034") && !isSerializationConflict(error)) || attempt === SERIALIZABLE_RETRY_LIMIT) {
        throw error;
      }
    }
  }
  throw new Error("AI_PROVIDER_SERIALIZABLE_RETRY_EXHAUSTED");
}

function parseDate(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return fail("AI_PROVIDER_INVALID_INPUT");
  return date;
}

function parseProviderId(providerId: string): string {
  const parsed = providerIdSchema.safeParse(providerId);
  if (!parsed.success) return fail("AI_PROVIDER_INVALID_INPUT");
  return parsed.data;
}

/**
 * Shape-only actor admission. API routes call requireApiSession first, while
 * this guard keeps direct service callers from smuggling a workspace/platform
 * actor or an invalid identity into the personal-provider boundary.
 */
export function assertPersonalProviderActorHint(actor: unknown): PersonalProviderActor {
  if (typeof actor !== "object" || actor === null) return fail("AI_PROVIDER_FORBIDDEN");
  const candidate = actor as { id?: unknown; role?: unknown };
  const id = z.string().uuid().safeParse(candidate.id);
  if (!id.success || (candidate.role !== "admin" && candidate.role !== "user")) {
    return fail("AI_PROVIDER_FORBIDDEN");
  }
  return Object.freeze({ id: id.data, role: candidate.role });
}

async function assertCurrentActor(actor: PersonalProviderActor, db: PersonalProviderDb): Promise<void> {
  const current = await db.appUser.findUnique({
    where: { id: actor.id },
    select: { id: true, disabledAt: true },
  });
  if (current === null || current.disabledAt !== null) return fail("AI_PROVIDER_FORBIDDEN");
}

async function assertActiveMembership(userId: string, db: PersonalProviderDb): Promise<void> {
  const membership = await getMembershipStatus(userId, db);
  if (membership.status === "none" || membership.status === "revoked") return fail("AI_MEMBERSHIP_REQUIRED");
  if (membership.status !== "active") return fail("AI_MEMBERSHIP_EXPIRED");
}

function assertCapabilities(
  kind: AiProviderKind,
  generationModelId: string | null | undefined,
  visionModelId: string | null | undefined,
  embeddingModelId: string | null | undefined,
  embeddingDimensions: number | null | undefined,
): void {
  if (generationModelId == null && embeddingModelId == null) return fail("AI_PROVIDER_INVALID_INPUT");
  const definition = getProviderDefinition(kind);
  if (!definition.supportsEmbeddings && (embeddingModelId != null || embeddingDimensions != null)) {
    return fail("AI_PROVIDER_INVALID_INPUT");
  }
  if ((embeddingModelId == null) !== (embeddingDimensions == null)) return fail("AI_PROVIDER_INVALID_INPUT");
  if (!definition.supportsVision && visionModelId != null) return fail("AI_PROVIDER_INVALID_INPUT");
  if (kind === "deepseek" && visionModelId != null && visionModelId !== "deepseek-v4-flash-vision-exp") {
    return fail("AI_PROVIDER_INVALID_INPUT");
  }
}

/**
 * Personal connections are deliberately bound to the built-in provider
 * registry. This is checked immediately before any transport call (and after
 * the owner-scoped row has been loaded), so a legacy or tampered row cannot
 * turn the personal test endpoint into an arbitrary outbound proxy.
 */
function assertCanonicalProviderBinding(
  provider: Pick<AiProviderConnection, "kind" | "protocol" | "baseUrl">,
): void {
  let definition: ReturnType<typeof getProviderDefinition>;
  try {
    definition = getProviderDefinition(provider.kind);
  } catch {
    return fail("AI_PROVIDER_CONNECTION_UNAVAILABLE");
  }
  if (provider.protocol !== "chatCompletions" || provider.baseUrl !== definition.baseUrl) {
    return fail("AI_PROVIDER_CONNECTION_UNAVAILABLE");
  }
}

function toPublicProvider(provider: {
  id: string;
  name: string;
  kind: AiProviderKind;
  scope: AiProviderScope;
  protocol: AiProviderProtocol;
  baseUrl: string;
  defaultGenerationModelId: string | null;
  defaultEmbeddingModelId: string | null;
  defaultVisionModelId: string | null;
  embeddingDimensions: number | null;
  configurationVersion: number;
  status: AiProviderConnectionStatus;
  lastTestedAt: Date | null;
  lastErrorCode: string | null;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  credential: { maskedSuffix: string; rotatedAt: Date | null; updatedAt: Date };
}) {
  return Object.freeze({
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    scope: provider.scope,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    defaultGenerationModelId: provider.defaultGenerationModelId,
    defaultEmbeddingModelId: provider.defaultEmbeddingModelId,
    defaultVisionModelId: provider.defaultVisionModelId,
    embeddingDimensions: provider.embeddingDimensions,
    configurationVersion: provider.configurationVersion,
    status: provider.status,
    lastTestedAt: provider.lastTestedAt,
    lastErrorCode: provider.lastErrorCode,
    disabledAt: provider.disabledAt,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
    credential: Object.freeze({
      maskedSuffix: provider.credential.maskedSuffix,
      rotatedAt: provider.credential.rotatedAt,
      updatedAt: provider.credential.updatedAt,
    }),
  });
}

async function personalProviderForOwner<T extends Prisma.AiProviderConnectionSelect>(
  providerId: string,
  ownerUserId: string,
  db: PersonalProviderDb,
  select: T,
): Promise<Prisma.AiProviderConnectionGetPayload<{ select: T }> | null> {
  return db.aiProviderConnection.findFirst({
    where: { id: providerId, scope: "user", ownerUserId },
    select,
  });
}

function isMaintenancePatch(input: z.infer<typeof updateSchema>): boolean {
  return (input.apiKey !== undefined || input.enabled === false) &&
    input.enabled !== true &&
    input.name === undefined &&
    input.generationModelId === undefined &&
    input.visionModelId === undefined &&
    input.embeddingModelId === undefined &&
    input.embeddingDimensions === undefined;
}

function hasUpdateField(input: z.infer<typeof updateSchema>): boolean {
  return input.name !== undefined ||
    input.apiKey !== undefined ||
    input.generationModelId !== undefined ||
    input.visionModelId !== undefined ||
    input.embeddingModelId !== undefined ||
    input.embeddingDimensions !== undefined ||
    input.enabled !== undefined;
}

export async function listPersonalProviderConnections(
  actor: PersonalProviderActor,
  db: PrismaClient = getDb(),
) {
  const actorHint = assertPersonalProviderActorHint(actor);
  await assertCurrentActor(actorHint, db);
  const providers = await db.aiProviderConnection.findMany({
    where: { scope: "user", ownerUserId: actorHint.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: publicProviderSelect,
  });
  return providers.map(toPublicProvider);
}

export async function getPersonalProviderConnection(
  providerId: string,
  actor: PersonalProviderActor,
  db: PrismaClient = getDb(),
) {
  const actorHint = assertPersonalProviderActorHint(actor);
  const parsedProviderId = parseProviderId(providerId);
  await assertCurrentActor(actorHint, db);
  const provider = await personalProviderForOwner(parsedProviderId, actorHint.id, db, publicProviderSelect);
  if (provider === null) return fail("AI_PROVIDER_NOT_FOUND");
  return toPublicProvider(provider);
}

export async function createPersonalProviderConnection(
  input: unknown,
  actor: PersonalProviderActor,
  db: PrismaClient = getDb(),
) {
  const actorHint = assertPersonalProviderActorHint(actor);
  try {
    return await withSerializableRetry(() => db.$transaction(async (tx) => {
      await lockMembershipUser(tx, actorHint.id);
      await assertCurrentActor(actorHint, tx);
      await assertActiveMembership(actorHint.id, tx);
      const parsed = createSchema.safeParse(input);
      if (!parsed.success) return fail("AI_PROVIDER_INVALID_INPUT");
      assertCapabilities(
        parsed.data.kind,
        parsed.data.generationModelId,
        parsed.data.visionModelId,
        parsed.data.embeddingModelId,
        parsed.data.embeddingDimensions,
      );
      const credential = await createCredential("aiProvider", parsed.data.apiKey, tx);
      const provider = await tx.aiProviderConnection.create({
        data: {
          name: parsed.data.name,
          kind: parsed.data.kind,
          scope: "user",
          workspaceId: null,
          ownerUserId: actorHint.id,
          ownershipState: "confirmed",
          protocol: "chatCompletions",
          baseUrl: canonicalProviderBaseUrl(parsed.data.kind),
          credentialId: credential.id,
          defaultGenerationModelId: parsed.data.generationModelId ?? null,
          defaultVisionModelId: parsed.data.visionModelId ?? null,
          defaultEmbeddingModelId: parsed.data.embeddingModelId ?? null,
          embeddingDimensions: parsed.data.embeddingDimensions ?? null,
        },
        select: publicProviderSelect,
      });
      return toPublicProvider(provider);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  } catch (error) {
    if (isKnown(error, "P2002")) return fail("AI_PROVIDER_NAME_CONFLICT");
    if (isKnown(error, "P2034") || isSerializationConflict(error)) return fail("AI_PROVIDER_CONFLICT");
    throw error;
  }
}

export async function updatePersonalProviderConnection(
  providerId: string,
  input: unknown,
  actor: PersonalProviderActor,
  db: PrismaClient = getDb(),
) {
  const actorHint = assertPersonalProviderActorHint(actor);
  const parsedProviderId = parseProviderId(providerId);
  try {
    return await withSerializableRetry(() => db.$transaction(async (tx) => {
      await lockMembershipUser(tx, actorHint.id);
      await assertCurrentActor(actorHint, tx);
      const parsedInput = updateSchema.safeParse(input);
      if (!parsedInput.success || !hasUpdateField(parsedInput.data)) return fail("AI_PROVIDER_INVALID_INPUT");
      const parsed = parsedInput.data;
      const expectedUpdatedAt = parseDate(parsed.expectedUpdatedAt);
      await lockProviderConfiguration(tx, parsedProviderId);
      const current = await personalProviderForOwner(parsedProviderId, actorHint.id, tx, mutationProviderSelect);
      if (current === null) return fail("AI_PROVIDER_NOT_FOUND");
      // The service has no endpoint mutation input. Keep legacy endpoint drift
      // maintainable (rotate or disable) while the test path remains strictly
      // fail-closed before credential decryption or transport dispatch.
      if (expectedUpdatedAt !== undefined && current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
        return fail("AI_PROVIDER_CONFLICT");
      }

      const maintenance = isMaintenancePatch(parsed);
      if (!maintenance) await assertActiveMembership(actorHint.id, tx);

      const nextGeneration = parsed.generationModelId === undefined ? current.defaultGenerationModelId : parsed.generationModelId;
      const nextVision = parsed.visionModelId === undefined ? current.defaultVisionModelId : parsed.visionModelId;
      const nextEmbedding = parsed.embeddingModelId === undefined ? current.defaultEmbeddingModelId : parsed.embeddingModelId;
      const nextDimensions = parsed.embeddingDimensions === undefined ? current.embeddingDimensions : parsed.embeddingDimensions;
      // Credential rotation and explicit disable are maintenance operations
      // available to an expired account; they do not need to re-validate or
      // activate an otherwise stale model configuration.
      if (!maintenance) assertCapabilities(current.kind, nextGeneration, nextVision, nextEmbedding, nextDimensions);

      if (parsed.enabled === false && current._count.projectRoutes > 0) return fail("AI_PROVIDER_IN_USE");

      const modelConfigurationChanged = parsed.apiKey !== undefined ||
        parsed.generationModelId !== undefined ||
        parsed.visionModelId !== undefined ||
        parsed.embeddingModelId !== undefined ||
        parsed.embeddingDimensions !== undefined;
      const currentlyEnabled = current.status !== "disabled" && current.disabledAt === null;
      const disableStateIncomplete = parsed.enabled === false &&
        (current.status !== "disabled" || current.disabledAt === null);
      const lifecycleChanged =
        (parsed.enabled !== undefined && parsed.enabled !== currentlyEnabled) ||
        disableStateIncomplete;
      const configurationChanged = modelConfigurationChanged || lifecycleChanged;
      if (parsed.apiKey !== undefined) await rotateCredential(current.credentialId, "aiProvider", parsed.apiKey, tx);

      const remainsDisabled = parsed.enabled === false || (parsed.enabled === undefined && !currentlyEnabled);
      const data: Prisma.AiProviderConnectionUpdateInput = {
        ...(parsed.name === undefined ? {} : { name: parsed.name }),
        ...(parsed.generationModelId === undefined ? {} : { defaultGenerationModelId: parsed.generationModelId }),
        ...(parsed.visionModelId === undefined ? {} : { defaultVisionModelId: parsed.visionModelId }),
        ...(parsed.embeddingModelId === undefined ? {} : { defaultEmbeddingModelId: parsed.embeddingModelId }),
        ...(parsed.embeddingDimensions === undefined ? {} : { embeddingDimensions: parsed.embeddingDimensions }),
        ...(configurationChanged
          ? {
              configurationVersion: { increment: 1 },
              status: (remainsDisabled ? "disabled" : "configured") as AiProviderConnectionStatus,
              disabledAt: remainsDisabled ? current.disabledAt ?? new Date() : null,
              lastTestedAt: null,
              lastErrorCode: null,
            }
          : {}),
      };
      if (!configurationChanged && parsed.enabled === false && current.status === "disabled" && current.disabledAt !== null) {
        return toPublicProvider(current);
      }
      const updated = await tx.aiProviderConnection.updateMany({
        where: {
          id: current.id,
          scope: "user",
          ownerUserId: actorHint.id,
          updatedAt: current.updatedAt,
        },
        data,
      });
      if (updated.count !== 1) return fail("AI_PROVIDER_CONFLICT");
      const result = await personalProviderForOwner(parsedProviderId, actorHint.id, tx, publicProviderSelect);
      if (result === null) return fail("AI_PROVIDER_CONFLICT");
      return toPublicProvider(result);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  } catch (error) {
    if (isKnown(error, "P2002")) return fail("AI_PROVIDER_NAME_CONFLICT");
    if (isKnown(error, "P2034") || isSerializationConflict(error)) return fail("AI_PROVIDER_CONFLICT");
    throw error;
  }
}

export async function disablePersonalProviderConnection(
  providerId: string,
  actor: PersonalProviderActor,
  db: PrismaClient = getDb(),
) {
  return updatePersonalProviderConnection(providerId, { enabled: false }, actor, db);
}

export async function deletePersonalProviderConnection(
  providerId: string,
  input: unknown,
  actor: PersonalProviderActor,
  db: PrismaClient = getDb(),
) {
  const actorHint = assertPersonalProviderActorHint(actor);
  const parsedProviderId = parseProviderId(providerId);
  try {
    return await withSerializableRetry(() => db.$transaction(async (tx) => {
      await lockMembershipUser(tx, actorHint.id);
      await assertCurrentActor(actorHint, tx);
      const parsedInput = deleteSchema.safeParse(input);
      if (!parsedInput.success) return fail("AI_PROVIDER_INVALID_INPUT");
      const expectedUpdatedAt = parseDate(parsedInput.data.expectedUpdatedAt);
      await lockProviderConfiguration(tx, parsedProviderId);
      const current = await personalProviderForOwner(parsedProviderId, actorHint.id, tx, deleteProviderSelect);
      if (current === null) return fail("AI_PROVIDER_NOT_FOUND");
      if (expectedUpdatedAt !== undefined && current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
        return fail("AI_PROVIDER_CONFLICT");
      }
      if (current.status !== "disabled" || current.disabledAt === null) return fail("AI_PROVIDER_DELETE_REQUIRES_DISABLED");
      if (current.name !== parsedInput.data.confirmationName) return fail("AI_PROVIDER_CONFIRMATION_MISMATCH");
      if (Object.values(current._count).some((count) => count > 0)) return fail("AI_PROVIDER_IN_USE");
      const deleted = await tx.aiProviderConnection.deleteMany({
        where: {
          id: current.id,
          scope: "user",
          ownerUserId: actorHint.id,
          status: "disabled",
          updatedAt: current.updatedAt,
        },
      });
      if (deleted.count !== 1) return fail("AI_PROVIDER_CONFLICT");
      await tx.externalCredential.delete({ where: { id: current.credentialId } });
      return Object.freeze({ id: current.id });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
  } catch (error) {
    if (isKnown(error, "P2003")) return fail("AI_PROVIDER_IN_USE");
    if (isKnown(error, "P2034") || isSerializationConflict(error)) return fail("AI_PROVIDER_CONFLICT");
    throw error;
  }
}

async function markPersonalProviderTestError(
  providerId: string,
  ownerUserId: string,
  startedUpdatedAt: Date,
  startedConfigurationVersion: number,
  credentialSecretFingerprint: string,
  code: string,
  db: PersonalProviderDb,
): Promise<boolean> {
  const marked = await db.aiProviderConnection.updateMany({
    where: {
      id: providerId,
      scope: "user",
      ownerUserId,
      status: { not: "disabled" },
      updatedAt: startedUpdatedAt,
      configurationVersion: startedConfigurationVersion,
      credential: { is: { secretFingerprint: credentialSecretFingerprint } },
    },
    data: { status: "error", lastTestedAt: new Date(), lastErrorCode: code },
  });
  return marked.count === 1;
}

type PersonalProviderTestResult = Readonly<{
  provider: ReturnType<typeof toPublicProvider>;
  check: Readonly<{ generation: boolean; embeddingDimensions: number | null; vision: boolean }>;
}>;

type PersonalProviderTestOutcome =
  | Readonly<{ kind: "success"; value: PersonalProviderTestResult }>
  | Readonly<{ kind: "error"; error: unknown }>;

async function testPersonalProviderInTransaction(
  providerId: string,
  actor: PersonalProviderActor,
  db: Prisma.TransactionClient,
): Promise<PersonalProviderTestOutcome> {
  await lockMembershipUser(db, actor.id);
  await assertCurrentActor(actor, db);
  // Membership is checked before loading the provider or its credential
  // fingerprint, so a free/expired account cannot probe a private connection.
  await assertActiveMembership(actor.id, db);
  await lockProviderConfiguration(db, providerId);
  const provider = await personalProviderForOwner(providerId, actor.id, db, testProviderSelect);
  if (provider === null) return fail("AI_PROVIDER_NOT_FOUND");
  // Keep this admission immediately before capability validation and all
  // transport calls. The query only reads the stored fingerprint; transport
  // is the first operation that can decrypt the credential.
  assertCanonicalProviderBinding(provider);
  if (provider.status === "disabled" || provider.disabledAt !== null) return fail("AI_PROVIDER_CONNECTION_UNAVAILABLE");
  assertCapabilities(
    provider.kind,
    provider.defaultGenerationModelId,
    provider.defaultVisionModelId,
    provider.defaultEmbeddingModelId,
    provider.embeddingDimensions,
  );

  const startedUpdatedAt = provider.updatedAt;
  const startedConfigurationVersion = provider.configurationVersion;
  const credentialSecretFingerprint = provider.credential.secretFingerprint;
  const absoluteDeadlineAt = new Date(Date.now() + PROVIDER_REQUEST_TIMEOUT_MS);
  let generation = false;
  let embeddingDimensions: number | null = null;
  let vision = false;
  try {
    if (provider.defaultGenerationModelId !== null) {
      assertCanonicalProviderBinding(provider);
      await invokeChatCompletion({
        connection: {
          id: provider.id,
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          credentialId: provider.credentialId,
          status: provider.status,
          credentialSecretFingerprint,
        },
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
      generation = true;
    }
    if (provider.defaultEmbeddingModelId !== null) {
      assertCanonicalProviderBinding(provider);
      const result = await invokeEmbeddings({
        connection: {
          id: provider.id,
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          credentialId: provider.credentialId,
          status: provider.status,
          credentialSecretFingerprint,
        },
        modelId: provider.defaultEmbeddingModelId,
        texts: ["AI Project OS personal provider connectivity test"],
        expectedDimensions: provider.embeddingDimensions,
        absoluteDeadlineAt,
      });
      embeddingDimensions = result.dimensions;
    }
    if (provider.defaultVisionModelId !== null) {
      assertCanonicalProviderBinding(provider);
      await invokeVisionCompletion({
        connection: {
          id: provider.id,
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          credentialId: provider.credentialId,
          status: provider.status,
          credentialSecretFingerprint,
        },
        modelId: provider.defaultVisionModelId,
        image: VISION_PROBE_IMAGE,
        mimeType: "image/png",
        prompt: "Return exactly: OK",
        maxOutputTokens: 8,
        absoluteDeadlineAt,
      });
      vision = true;
    }

    // Keep the admission epoch explicit at the commit boundary as well. The
    // actor lock prevents a membership revoke/disable operation from crossing
    // this transaction, while these reads make the linearization contract
    // visible and fail closed if a lower-level database operation changed the
    // account or subscription inside the transaction.
    await assertCurrentActor(actor, db);
    await assertActiveMembership(actor.id, db);

    const finalProvider = await personalProviderForOwner(provider.id, actor.id, db, testProviderSelect);
    if (
      finalProvider === null ||
      finalProvider.updatedAt.getTime() !== startedUpdatedAt.getTime() ||
      finalProvider.configurationVersion !== startedConfigurationVersion ||
      finalProvider.status === "disabled" ||
      finalProvider.disabledAt !== null ||
      finalProvider.credential.secretFingerprint !== credentialSecretFingerprint
    ) return fail("AI_PROVIDER_CONFLICT");

    const verified = await db.aiProviderConnection.updateMany({
      where: {
        id: provider.id,
        scope: "user",
        ownerUserId: actor.id,
        status: { not: "disabled" },
        updatedAt: startedUpdatedAt,
        configurationVersion: startedConfigurationVersion,
        credential: { is: { secretFingerprint: credentialSecretFingerprint } },
      },
      data: { status: "verified", lastTestedAt: new Date(), lastErrorCode: null, disabledAt: null },
    });
    if (verified.count !== 1) return fail("AI_PROVIDER_CONFLICT");
    const result = await personalProviderForOwner(provider.id, actor.id, db, testProviderPublicSelect);
    if (result === null) return fail("AI_PROVIDER_CONFLICT");
    return Object.freeze({
      kind: "success" as const,
      value: Object.freeze({
        provider: toPublicProvider(result),
        check: Object.freeze({ generation, embeddingDimensions, vision }),
      }),
    });
  } catch (error) {
    if (error instanceof PersonalProviderServiceError && [
      "AI_PROVIDER_CONFLICT",
      "AI_PROVIDER_FORBIDDEN",
      "AI_MEMBERSHIP_REQUIRED",
      "AI_MEMBERSHIP_EXPIRED",
    ].includes(error.code)) throw error;
    const code = error instanceof ProviderTransportError ? error.code : "AI_PROVIDER_UNAVAILABLE";
    const marked = await markPersonalProviderTestError(
      provider.id,
      actor.id,
      startedUpdatedAt,
      startedConfigurationVersion,
      credentialSecretFingerprint,
      code,
      db,
    );
    if (!marked) return fail("AI_PROVIDER_CONFLICT");
    // Return an outcome instead of throwing so the interactive transaction
    // can commit the diagnostic status. The public wrapper rethrows only
    // after the transaction has committed, preserving the API error contract
    // without rolling back status=error/lastTestedAt/lastErrorCode.
    return Object.freeze({ kind: "error" as const, error });
  }
}

function unwrapPersonalProviderTestOutcome(outcome: PersonalProviderTestOutcome): PersonalProviderTestResult {
  if (outcome.kind === "error") throw outcome.error;
  return outcome.value;
}

export async function testPersonalProviderConnection(
  providerId: string,
  actor: PersonalProviderActor,
  db: PersonalProviderDb = getDb(),
) {
  const actorHint = assertPersonalProviderActorHint(actor);
  const parsedProviderId = parseProviderId(providerId);
  if (!isPrismaClient(db)) {
    return unwrapPersonalProviderTestOutcome(
      await testPersonalProviderInTransaction(parsedProviderId, actorHint, db),
    );
  }
  try {
    const outcome = await db.$transaction(
      (tx) => testPersonalProviderInTransaction(parsedProviderId, actorHint, tx),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: PROVIDER_CONNECTION_TEST_TRANSACTION_TIMEOUT_MS,
      },
    );
    return unwrapPersonalProviderTestOutcome(outcome);
  } catch (error) {
    if (isKnown(error, "P2034") || isSerializationConflict(error)) return fail("AI_PROVIDER_CONFLICT");
    throw error;
  }
}
