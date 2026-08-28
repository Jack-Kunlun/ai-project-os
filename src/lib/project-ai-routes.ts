import { Prisma, type AiOperation, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { getProviderDefinition, isSafeModelId } from "@/lib/ai-providers";
import { getDb } from "@/lib/db";

const SUPPORTED_OPERATIONS = ["embedding", "autoExtract", "generateWithContext"] as const;
const routeSchema = z.object({
  operation: z.enum(SUPPORTED_OPERATIONS),
  providerConnectionId: z.string().uuid(),
  modelId: z.string().trim().min(1).max(128).refine(isSafeModelId),
  embeddingDimensions: z.number().int().min(8).max(8192).nullable().optional(),
  maxOutputTokens: z.number().int().min(128).max(16_384).optional(),
}).strict();

export type ProjectAiRouteErrorCode =
  | "PROJECT_AI_ROUTE_INVALID_INPUT"
  | "PROJECT_NOT_FOUND"
  | "AI_PROVIDER_NOT_FOUND"
  | "AI_PROVIDER_NOT_VERIFIED"
  | "AI_PROVIDER_CAPABILITY_MISMATCH";

export class ProjectAiRouteError extends Error {
  constructor(readonly code: ProjectAiRouteErrorCode) {
    super(code);
    this.name = "ProjectAiRouteError";
  }
}

function fail(code: ProjectAiRouteErrorCode): never {
  throw new ProjectAiRouteError(code);
}

function isKnown(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

export async function getProjectAiRoutes(projectId: string, db: PrismaClient = getDb()) {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (project === null) return fail("PROJECT_NOT_FOUND");
  const [routes, providers] = await Promise.all([
    db.projectAiRoute.findMany({
      where: { projectId, operation: { in: [...SUPPORTED_OPERATIONS] } },
      orderBy: { operation: "asc" },
      select: {
        operation: true,
        providerConnectionId: true,
        modelId: true,
        embeddingDimensions: true,
        maxOutputTokens: true,
        updatedAt: true,
      },
    }),
    db.aiProviderConnection.findMany({
      where: { status: { not: "disabled" } },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        kind: true,
        status: true,
        defaultGenerationModelId: true,
        defaultEmbeddingModelId: true,
        embeddingDimensions: true,
      },
    }),
  ]);
  return Object.freeze({ routes, providers, supportedOperations: SUPPORTED_OPERATIONS });
}

export async function upsertProjectAiRoute(
  projectId: string,
  input: unknown,
  db: PrismaClient = getDb(),
) {
  const parsed = routeSchema.parse(input);
  const provider = await db.aiProviderConnection.findUnique({
    where: { id: parsed.providerConnectionId },
  });
  if (provider === null) return fail("AI_PROVIDER_NOT_FOUND");
  if (provider.status !== "verified") return fail("AI_PROVIDER_NOT_VERIFIED");

  const isEmbedding = parsed.operation === "embedding";
  if (isEmbedding) {
    if (
      !getProviderDefinition(provider.kind).supportsEmbeddings ||
      provider.defaultEmbeddingModelId === null ||
      provider.embeddingDimensions === null ||
      parsed.modelId !== provider.defaultEmbeddingModelId ||
      parsed.embeddingDimensions !== provider.embeddingDimensions
    ) {
      return fail("AI_PROVIDER_CAPABILITY_MISMATCH");
    }
  } else if (parsed.embeddingDimensions != null) {
    return fail("PROJECT_AI_ROUTE_INVALID_INPUT");
  }

  try {
    return await db.projectAiRoute.upsert({
      where: { projectId_operation: { projectId, operation: parsed.operation as AiOperation } },
      create: {
        projectId,
        operation: parsed.operation,
        providerConnectionId: provider.id,
        modelId: parsed.modelId,
        embeddingDimensions: isEmbedding ? parsed.embeddingDimensions : null,
        maxOutputTokens: isEmbedding ? 128 : parsed.maxOutputTokens ?? 2048,
      },
      update: {
        providerConnectionId: provider.id,
        modelId: parsed.modelId,
        embeddingDimensions: isEmbedding ? parsed.embeddingDimensions : null,
        maxOutputTokens: isEmbedding ? 128 : parsed.maxOutputTokens ?? 2048,
      },
      select: {
        operation: true,
        providerConnectionId: true,
        modelId: true,
        embeddingDimensions: true,
        maxOutputTokens: true,
        updatedAt: true,
      },
    });
  } catch (error) {
    if (isKnown(error, "P2003")) return fail("PROJECT_NOT_FOUND");
    throw error;
  }
}

export async function deleteProjectAiRoute(
  projectId: string,
  operation: unknown,
  db: PrismaClient = getDb(),
) {
  const parsed = z.enum(SUPPORTED_OPERATIONS).parse(operation);
  await db.projectAiRoute.deleteMany({ where: { projectId, operation: parsed } });
}

export async function requireProjectAiRoute(
  projectId: string,
  operation: typeof SUPPORTED_OPERATIONS[number],
  db: PrismaClient = getDb(),
) {
  const route = await db.projectAiRoute.findUnique({
    where: { projectId_operation: { projectId, operation } },
    include: { providerConnection: true },
  });
  if (route === null) return fail("PROJECT_AI_ROUTE_INVALID_INPUT");
  if (route.providerConnection.status !== "verified") return fail("AI_PROVIDER_NOT_VERIFIED");
  return route;
}

