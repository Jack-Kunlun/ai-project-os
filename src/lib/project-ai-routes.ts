import { Prisma, type AiOperation, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { type AccessUser } from "@/lib/access-control";
import { getProviderDefinition, isSafeModelId } from "@/lib/ai-providers";
import { getDb } from "@/lib/db";

export const SUPPORTED_OPERATIONS = ["embedding", "visionExtract", "autoExtract", "generateWithContext"] as const;
type SupportedOperation = typeof SUPPORTED_OPERATIONS[number];

const routeSchema = z.object({
  operation: z.enum(SUPPORTED_OPERATIONS),
  providerConnectionId: z.string().uuid(),
  modelId: z.string().trim().min(1).max(128).refine(isSafeModelId),
  embeddingDimensions: z.number().int().min(8).max(8192).nullable().optional(),
  maxOutputTokens: z.number().int().min(128).max(16_384).optional(),
  expectedUpdatedAt: z.union([
    z.string().datetime({ offset: true }),
    z.date(),
  ]).nullable().optional(),
  acknowledgeIndexRebuild: z.boolean().optional(),
}).strict();

type ParsedRouteInput = z.infer<typeof routeSchema>;
type RouteDb = PrismaClient | Prisma.TransactionClient;

export type ProjectAiRouteErrorCode =
  | "PROJECT_AI_ROUTE_INVALID_INPUT"
  | "PROJECT_AI_ROUTE_CONFLICT"
  | "PROJECT_AI_ROUTE_CONFIRMATION_REQUIRED"
  | "PROJECT_NOT_FOUND"
  | "AI_PROVIDER_NOT_FOUND"
  | "AI_PROVIDER_NOT_VERIFIED"
  | "AI_PROVIDER_CAPABILITY_MISMATCH"
  | "AI_PROVIDER_SCOPE_FORBIDDEN";

export class ProjectAiRouteError extends Error {
  constructor(readonly code: ProjectAiRouteErrorCode) {
    super(code);
    this.name = "ProjectAiRouteError";
  }
}

/** Route changes can select a workspace BYOK credential, so project-edit
 * permission alone is insufficient; the current workspace Owner/Admin must
 * explicitly approve the change. */
export async function assertProjectAiRouteManager(
  projectId: string,
  actor: AccessUser,
  db: PrismaClient = getDb(),
): Promise<void> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
  if (project === null) return fail("PROJECT_NOT_FOUND");
  const membership = await db.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId: project.workspaceId, userId: actor.id } },
    select: { role: true },
  });
  // Project route writes can select workspace BYOK credentials. A global
  // system-admin role does not grant access to an unrelated workspace.
  if (membership === null || (membership.role !== "owner" && membership.role !== "admin")) {
    return fail("AI_PROVIDER_SCOPE_FORBIDDEN");
  }
}

function fail(code: ProjectAiRouteErrorCode): never {
  throw new ProjectAiRouteError(code);
}

function isKnown(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function normalizeExpectedUpdatedAt(value: ParsedRouteInput["expectedUpdatedAt"]): Date | null | undefined {
  if (value === undefined || value === null) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return fail("PROJECT_AI_ROUTE_INVALID_INPUT");
  return date;
}

function routeData(input: ParsedRouteInput) {
  const isEmbedding = input.operation === "embedding";
  return {
    providerConnectionId: input.providerConnectionId,
    modelId: input.modelId,
    embeddingDimensions: isEmbedding ? input.embeddingDimensions ?? null : null,
    maxOutputTokens: isEmbedding ? 128 : input.maxOutputTokens ?? 2_048,
  };
}

function routeValuesEqual(
  current: Readonly<{
    providerConnectionId: string;
    modelId: string;
    embeddingDimensions: number | null;
    maxOutputTokens: number;
  }> | null,
  next: ReturnType<typeof routeData>,
): boolean {
  return current !== null &&
    current.providerConnectionId === next.providerConnectionId &&
    current.modelId === next.modelId &&
    current.embeddingDimensions === next.embeddingDimensions &&
    current.maxOutputTokens === next.maxOutputTokens;
}

function embeddingMatchesIndex(
  index: Readonly<{
    providerConnectionId: string;
    modelId: string;
    dimensions: number;
  }> | null,
  next: ReturnType<typeof routeData>,
): boolean {
  return index !== null &&
    next.embeddingDimensions !== null &&
    index.providerConnectionId === next.providerConnectionId &&
    index.modelId === next.modelId &&
    index.dimensions === next.embeddingDimensions;
}

function validateTarget(
  input: ParsedRouteInput,
  provider: Readonly<{
    id: string;
    kind: Parameters<typeof getProviderDefinition>[0];
    status: string;
    defaultEmbeddingModelId: string | null;
    defaultVisionModelId: string | null;
    defaultGenerationModelId: string | null;
    embeddingDimensions: number | null;
    scope: "platform" | "workspace";
    workspaceId: string | null;
  }> | null,
  projectWorkspaceId?: string,
): void {
  if (provider === null) return fail("AI_PROVIDER_NOT_FOUND");
  if (provider.status !== "verified") return fail("AI_PROVIDER_NOT_VERIFIED");
  if (provider.scope === "platform" && (provider.workspaceId !== null)) return fail("AI_PROVIDER_SCOPE_FORBIDDEN");
  if (provider.scope === "workspace" && (projectWorkspaceId === undefined || provider.workspaceId !== projectWorkspaceId)) return fail("AI_PROVIDER_SCOPE_FORBIDDEN");

  const isEmbedding = input.operation === "embedding";
  if (isEmbedding) {
    if (
      !getProviderDefinition(provider.kind).supportsEmbeddings ||
      provider.defaultEmbeddingModelId === null ||
      provider.embeddingDimensions === null ||
      input.modelId !== provider.defaultEmbeddingModelId ||
      input.embeddingDimensions !== provider.embeddingDimensions
    ) {
      return fail("AI_PROVIDER_CAPABILITY_MISMATCH");
    }
  } else if (input.operation === "visionExtract") {
    if (
      !getProviderDefinition(provider.kind).supportsVision ||
      provider.defaultVisionModelId === null ||
      input.modelId !== provider.defaultVisionModelId
    ) {
      return fail("AI_PROVIDER_CAPABILITY_MISMATCH");
    }
  } else if (input.embeddingDimensions != null) {
    return fail("PROJECT_AI_ROUTE_INVALID_INPUT");
  }
  if (input.operation !== "embedding" && input.operation !== "visionExtract" && input.modelId !== provider.defaultGenerationModelId) {
    return fail("AI_PROVIDER_CAPABILITY_MISMATCH");
  }
}

const routeSelect = {
  operation: true,
  providerConnectionId: true,
  modelId: true,
  embeddingDimensions: true,
  maxOutputTokens: true,
  updatedAt: true,
} as const;

type RouteRecord = {
  operation: AiOperation;
  providerConnectionId: string;
  modelId: string;
  embeddingDimensions: number | null;
  maxOutputTokens: number;
  updatedAt: Date;
};

function routeResponse(route: RouteRecord) {
  return Object.freeze({
    operation: route.operation,
    providerConnectionId: route.providerConnectionId,
    modelId: route.modelId,
    embeddingDimensions: route.embeddingDimensions,
    maxOutputTokens: route.maxOutputTokens,
    updatedAt: route.updatedAt,
  });
}

function currentResponse(route: RouteRecord | null) {
  return route === null ? null : routeResponse(route);
}

type ActiveIndex = {
  indexGenerationId: string;
  generation: {
    providerConnectionId: string;
    modelId: string;
    dimensions: number;
    providerConnection: { name: string; kind: string };
  };
};

function impactSummary(
  operation: SupportedOperation,
  changed: boolean,
  activeIndex: ActiveIndex | null,
  next: ReturnType<typeof routeData>,
) {
  const indexInvalidated = changed && operation === "embedding" &&
    activeIndex !== null && !embeddingMatchesIndex(activeIndex.generation, next);
  return Object.freeze({
    changed,
    onlyFutureRuns: operation !== "embedding",
    indexInvalidated,
    requiresIndexRebuildAcknowledgement: indexInvalidated,
    activeIndexGenerationId: activeIndex?.indexGenerationId ?? null,
    activeIndex: activeIndex === null ? null : Object.freeze({
      indexGenerationId: activeIndex.indexGenerationId,
      providerConnectionId: activeIndex.generation.providerConnectionId,
      providerName: activeIndex.generation.providerConnection.name,
      providerKind: activeIndex.generation.providerConnection.kind,
      modelId: activeIndex.generation.modelId,
      dimensions: activeIndex.generation.dimensions,
    }),
  });
}

async function lockProjectRouteScope(db: RouteDb, projectId: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 29082026))`;
}

async function readOperationState(
  projectId: string,
  operation: SupportedOperation,
  providerConnectionId: string,
  db: RouteDb,
) {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true, workspaceId: true } });
  if (project === null) return fail("PROJECT_NOT_FOUND");
  const provider = await db.aiProviderConnection.findUnique({
    where: { id: providerConnectionId },
    select: {
      id: true,
      kind: true,
      status: true,
      defaultEmbeddingModelId: true,
      defaultVisionModelId: true,
      defaultGenerationModelId: true,
      embeddingDimensions: true,
      scope: true,
      workspaceId: true,
    },
  });
  const current = await db.projectAiRoute.findUnique({
    where: { projectId_operation: { projectId, operation } },
    select: routeSelect,
  });
  const activeIndex = operation === "embedding"
    ? await db.memoryIndexPointer.findUnique({
        where: { projectId },
        select: {
          indexGenerationId: true,
          generation: {
            select: {
              providerConnectionId: true,
              modelId: true,
              dimensions: true,
              providerConnection: { select: { name: true, kind: true } },
            },
          },
        },
      })
    : null;
  return { project, provider, current, activeIndex };
}

export type ProjectAiRouteChangePreview = Readonly<{
  operation: SupportedOperation;
  current: ReturnType<typeof currentResponse>;
  next: Readonly<{
    operation: SupportedOperation;
    providerConnectionId: string;
    modelId: string;
    embeddingDimensions: number | null;
    maxOutputTokens: number;
  }>;
  impact: ReturnType<typeof impactSummary>;
}>;

export async function previewProjectAiRouteChange(
  projectId: string,
  input: unknown,
  db: PrismaClient = getDb(),
): Promise<ProjectAiRouteChangePreview> {
  const parsed = routeSchema.parse(input);
  const next = routeData(parsed);
  const state = await readOperationState(projectId, parsed.operation, parsed.providerConnectionId, db);
  validateTarget(parsed, state.provider, state.project.workspaceId);
  const changed = !routeValuesEqual(state.current, next);
  return Object.freeze({
    operation: parsed.operation,
    current: currentResponse(state.current),
    next: Object.freeze({ operation: parsed.operation, ...next }),
    impact: impactSummary(parsed.operation, changed, state.activeIndex, next),
  });
}

export async function getProjectAiRoutes(projectId: string, actor: AccessUser, db: PrismaClient = getDb()) {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true, workspaceId: true } });
  if (project === null) return fail("PROJECT_NOT_FOUND");
  const canViewWorkspaceProviders = await db.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId: project.workspaceId, userId: actor.id } },
    select: { userId: true },
  }) !== null;
  const [routes, providers] = await Promise.all([
    db.projectAiRoute.findMany({
      where: { projectId, operation: { in: [...SUPPORTED_OPERATIONS] } },
      orderBy: { operation: "asc" },
      select: routeSelect,
    }),
    db.aiProviderConnection.findMany({
      where: { status: { not: "disabled" }, OR: [
        { scope: "platform" },
        ...(canViewWorkspaceProviders ? [{ scope: "workspace" as const, workspaceId: project.workspaceId }] : []),
      ] },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        kind: true,
        status: true,
        defaultGenerationModelId: true,
        defaultEmbeddingModelId: true,
        defaultVisionModelId: true,
        embeddingDimensions: true,
        scope: true,
        workspaceId: true,
      },
    }),
  ]);
  return Object.freeze({ routes, providers, supportedOperations: SUPPORTED_OPERATIONS });
}

export async function upsertProjectAiRoute(
  projectId: string,
  input: unknown,
  db: PrismaClient = getDb(),
  actorId?: string,
) {
  const parsed = routeSchema.parse(input);
  const expectedUpdatedAt = normalizeExpectedUpdatedAt(parsed.expectedUpdatedAt);
  if (actorId !== undefined && expectedUpdatedAt === undefined) {
    return fail("PROJECT_AI_ROUTE_INVALID_INPUT");
  }
  const next = routeData(parsed);

  try {
    return await db.$transaction(async (tx) => {
      await lockProjectRouteScope(tx, projectId);
      const state = await readOperationState(projectId, parsed.operation, parsed.providerConnectionId, tx);
      validateTarget(parsed, state.provider, state.project.workspaceId);
      if (actorId !== undefined) {
        const actor = await tx.appUser.findUnique({ where: { id: actorId }, select: { id: true } });
        if (actor === null) return fail("PROJECT_AI_ROUTE_INVALID_INPUT");
        const membership = await tx.workspaceMembership.findUnique({
          where: { workspaceId_userId: { workspaceId: state.project.workspaceId, userId: actorId } },
          select: { role: true },
        });
        if (membership === null || (membership.role !== "owner" && membership.role !== "admin")) {
          return fail("AI_PROVIDER_SCOPE_FORBIDDEN");
        }
      }

      if (expectedUpdatedAt !== undefined) {
        const matches = expectedUpdatedAt === null
          ? state.current === null
          : state.current !== null && state.current.updatedAt.getTime() === expectedUpdatedAt.getTime();
        if (!matches) return fail("PROJECT_AI_ROUTE_CONFLICT");
      }

      const changed = !routeValuesEqual(state.current, next);
      const impact = impactSummary(parsed.operation, changed, state.activeIndex, next);
      if (impact.requiresIndexRebuildAcknowledgement && parsed.acknowledgeIndexRebuild !== true) {
        return fail("PROJECT_AI_ROUTE_CONFIRMATION_REQUIRED");
      }

      if (!changed && state.current !== null) {
        return Object.freeze({
          route: routeResponse(state.current),
          impact,
          revision: null,
        });
      }

      const saved = state.current === null
        ? await tx.projectAiRoute.create({
            data: {
              projectId,
              operation: parsed.operation,
              ...next,
            },
            select: routeSelect,
          })
        : await tx.projectAiRoute.update({
            where: { projectId_operation: { projectId, operation: parsed.operation } },
            data: next,
            select: routeSelect,
          });
      const revision = await tx.projectAiRouteRevision.create({
        data: {
          projectId,
          operation: parsed.operation as AiOperation,
          oldProviderConnectionId: state.current?.providerConnectionId ?? null,
          oldModelId: state.current?.modelId ?? null,
          oldEmbeddingDimensions: state.current?.embeddingDimensions ?? null,
          oldMaxOutputTokens: state.current?.maxOutputTokens ?? null,
          newProviderConnectionId: saved.providerConnectionId,
          newModelId: saved.modelId,
          newEmbeddingDimensions: saved.embeddingDimensions,
          newMaxOutputTokens: saved.maxOutputTokens,
          onlyFutureRuns: impact.onlyFutureRuns,
          indexInvalidated: impact.indexInvalidated,
          activeIndexGenerationId: impact.activeIndexGenerationId,
          actorId: actorId ?? null,
        },
        select: {
          id: true,
          operation: true,
          oldProviderConnectionId: true,
          oldModelId: true,
          oldEmbeddingDimensions: true,
          oldMaxOutputTokens: true,
          newProviderConnectionId: true,
          newModelId: true,
          newEmbeddingDimensions: true,
          newMaxOutputTokens: true,
          onlyFutureRuns: true,
          indexInvalidated: true,
          activeIndexGenerationId: true,
          actorId: true,
          createdAt: true,
        },
      });
      return Object.freeze({
        route: routeResponse(saved),
        impact,
        revision: Object.freeze(revision),
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (isKnown(error, "P2003")) return fail("PROJECT_NOT_FOUND");
    if (isKnown(error, "P2034")) return fail("PROJECT_AI_ROUTE_CONFLICT");
    throw error;
  }
}

export async function requireProjectAiRoute(
  projectId: string,
  operation: SupportedOperation,
  db: RouteDb = getDb(),
) {
  const [route, project] = await Promise.all([
    db.projectAiRoute.findUnique({
    where: { projectId_operation: { projectId, operation } },
    include: { providerConnection: true },
    }),
    db.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } }),
  ]);
  if (project === null) return fail("PROJECT_NOT_FOUND");
  if (route === null) return fail("PROJECT_AI_ROUTE_INVALID_INPUT");
  if (route.providerConnection.status !== "verified") return fail("AI_PROVIDER_NOT_VERIFIED");
  if (
    (route.providerConnection.scope === "platform" && route.providerConnection.workspaceId !== null) ||
    (route.providerConnection.scope === "workspace" && route.providerConnection.workspaceId !== project.workspaceId)
  ) return fail("AI_PROVIDER_SCOPE_FORBIDDEN");
  if (operation === "embedding" && (route.modelId !== route.providerConnection.defaultEmbeddingModelId || route.embeddingDimensions !== route.providerConnection.embeddingDimensions)) {
    return fail("AI_PROVIDER_CAPABILITY_MISMATCH");
  }
  if (operation === "visionExtract" && route.modelId !== route.providerConnection.defaultVisionModelId) {
    return fail("AI_PROVIDER_CAPABILITY_MISMATCH");
  }
  if (operation !== "embedding" && operation !== "visionExtract" && route.modelId !== route.providerConnection.defaultGenerationModelId) {
    return fail("AI_PROVIDER_CAPABILITY_MISMATCH");
  }
  return route;
}
