import { Prisma, type AiProviderKind, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { createCredential, rotateCredential } from "@/lib/credential-vault";
import { getDb } from "@/lib/db";
import {
  PROVIDER_DEFINITIONS,
  canonicalProviderBaseUrl,
  getProviderDefinition,
  isSafeModelId,
} from "./registry";
import {
  ProviderTransportError,
  invokeChatCompletion,
  invokeEmbeddings,
} from "./transport";

export type ProviderServiceErrorCode =
  | "AI_PROVIDER_INVALID_INPUT"
  | "AI_PROVIDER_NOT_FOUND"
  | "AI_PROVIDER_NAME_CONFLICT"
  | "AI_PROVIDER_IN_USE";

export class ProviderServiceError extends Error {
  constructor(readonly code: ProviderServiceErrorCode) {
    super(code);
    this.name = "ProviderServiceError";
  }
}

const modelIdSchema = z.string().trim().min(1).max(128).refine(isSafeModelId);
const providerKindSchema = z.enum(["openai", "deepseek", "qwen", "glm"]);
const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: providerKindSchema,
  apiKey: z.string().min(8).max(512),
  generationModelId: modelIdSchema,
  embeddingModelId: modelIdSchema.nullable().optional(),
  embeddingDimensions: z.number().int().min(8).max(8192).nullable().optional(),
}).strict();

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  apiKey: z.string().min(8).max(512).optional(),
  generationModelId: modelIdSchema.optional(),
  embeddingModelId: modelIdSchema.nullable().optional(),
  embeddingDimensions: z.number().int().min(8).max(8192).nullable().optional(),
  enabled: z.boolean().optional(),
}).strict();

const providerSelect = {
  id: true,
  name: true,
  kind: true,
  protocol: true,
  baseUrl: true,
  defaultGenerationModelId: true,
  defaultEmbeddingModelId: true,
  embeddingDimensions: true,
  status: true,
  lastTestedAt: true,
  lastErrorCode: true,
  disabledAt: true,
  createdAt: true,
  updatedAt: true,
  credential: { select: { maskedSuffix: true, rotatedAt: true, updatedAt: true } },
  _count: { select: { projectRoutes: true } },
} as const;

function fail(code: ProviderServiceErrorCode): never {
  throw new ProviderServiceError(code);
}

function isKnown(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
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

export function providerCatalog() {
  return PROVIDER_DEFINITIONS.map((definition) => ({
    kind: definition.kind,
    displayName: definition.displayName,
    baseUrl: definition.baseUrl,
    apiKeyLabel: definition.apiKeyLabel,
    generationModelSuggestions: definition.generationModelSuggestions,
    embeddingModelSuggestions: definition.embeddingModelSuggestions,
    supportsEmbeddings: definition.supportsEmbeddings,
  }));
}

export async function listProviderConnections(db: PrismaClient = getDb()) {
  return db.aiProviderConnection.findMany({ orderBy: { createdAt: "asc" }, select: providerSelect });
}

export async function createProviderConnection(input: unknown, db: PrismaClient = getDb()) {
  const parsed = createSchema.parse(input);
  assertEmbeddingConfiguration(parsed.kind, parsed.embeddingModelId, parsed.embeddingDimensions);
  try {
    return await db.$transaction(async (tx) => {
      const credential = await createCredential("aiProvider", parsed.apiKey, tx);
      return tx.aiProviderConnection.create({
        data: {
          name: parsed.name,
          kind: parsed.kind,
          baseUrl: canonicalProviderBaseUrl(parsed.kind),
          credentialId: credential.id,
          defaultGenerationModelId: parsed.generationModelId,
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
  db: PrismaClient = getDb(),
) {
  const parsed = updateSchema.parse(input);
  const existing = await db.aiProviderConnection.findUnique({ where: { id: providerId } });
  if (existing === null) return fail("AI_PROVIDER_NOT_FOUND");
  const nextModel = parsed.embeddingModelId === undefined
    ? existing.defaultEmbeddingModelId
    : parsed.embeddingModelId;
  const nextDimensions = parsed.embeddingDimensions === undefined
    ? existing.embeddingDimensions
    : parsed.embeddingDimensions;
  assertEmbeddingConfiguration(existing.kind, nextModel, nextDimensions);
  try {
    return await db.$transaction(async (tx) => {
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
          ...(parsed.embeddingModelId !== undefined
            ? { defaultEmbeddingModelId: parsed.embeddingModelId }
            : {}),
          ...(parsed.embeddingDimensions !== undefined
            ? { embeddingDimensions: parsed.embeddingDimensions }
            : {}),
          ...(parsed.enabled === undefined
            ? {}
            : parsed.enabled
              ? { status: "configured", disabledAt: null, lastErrorCode: null }
              : { status: "disabled", disabledAt: new Date() }),
          ...(parsed.apiKey !== undefined
            ? { status: "configured", lastErrorCode: null, lastTestedAt: null }
            : {}),
        },
        select: providerSelect,
      });
    });
  } catch (error) {
    if (isKnown(error, "P2002")) return fail("AI_PROVIDER_NAME_CONFLICT");
    throw error;
  }
}

export async function disableProviderConnection(providerId: string, db: PrismaClient = getDb()) {
  const provider = await db.aiProviderConnection.findUnique({
    where: { id: providerId },
    select: { id: true, _count: { select: { projectRoutes: true } } },
  });
  if (provider === null) return fail("AI_PROVIDER_NOT_FOUND");
  if (provider._count.projectRoutes > 0) return fail("AI_PROVIDER_IN_USE");
  return db.aiProviderConnection.update({
    where: { id: providerId },
    data: { status: "disabled", disabledAt: new Date() },
    select: providerSelect,
  });
}

export async function testProviderConnection(providerId: string, db: PrismaClient = getDb()) {
  const provider = await db.aiProviderConnection.findUnique({ where: { id: providerId } });
  if (provider === null) return fail("AI_PROVIDER_NOT_FOUND");
  try {
    const generation = await invokeChatCompletion({
      connection: provider,
      operation: "projectAnalysis",
      modelId: provider.defaultGenerationModelId,
      messages: [
        { role: "system", content: "You are a connectivity probe. Follow the exact reply constraint." },
        { role: "user", content: "Reply with exactly: OK" },
      ],
      maxOutputTokens: 8,
      temperature: 0,
    });
    const embedding = provider.defaultEmbeddingModelId === null
      ? null
      : await invokeEmbeddings({
          connection: provider,
          modelId: provider.defaultEmbeddingModelId,
          texts: ["AI Project OS provider connectivity test"],
          expectedDimensions: provider.embeddingDimensions,
        });
    const now = new Date();
    const updated = await db.aiProviderConnection.update({
      where: { id: providerId },
      data: { status: "verified", lastTestedAt: now, lastErrorCode: null, disabledAt: null },
      select: providerSelect,
    });
    return Object.freeze({
      provider: updated,
      check: {
        generation: generation.content.trim().slice(0, 32),
        embeddingDimensions: embedding?.dimensions ?? null,
      },
    });
  } catch (error) {
    const code = error instanceof ProviderTransportError ? error.code : "AI_PROVIDER_UNAVAILABLE";
    await db.aiProviderConnection.updateMany({
      where: { id: providerId, status: { not: "disabled" } },
      data: { status: "error", lastTestedAt: new Date(), lastErrorCode: code },
    });
    throw error;
  }
}

