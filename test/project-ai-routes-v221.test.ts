import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import type { AccessUser } from "../src/lib/access-control";
import { isSafeModelId } from "../src/lib/ai-providers";
import { mapApiError } from "../src/lib/api-errors";
import {
  ProjectAiRouteError,
  getProjectAiRoutes,
  previewProjectAiRouteChange,
  requireProjectAiRoute,
  upsertProjectAiRoute,
} from "../src/lib/project-ai-routes";
import { WebAiAccessError } from "../src/lib/web-ai-access";
import {
  isMemoryIndexPublicationCurrent,
  resolveMemoryIndexReadiness,
  WebMemoryIndexError,
} from "../src/lib/web-memory-index";

const projectId = "11111111-1111-4111-8111-111111111111";
const foreignProjectId = "99999999-9999-4999-8999-999999999999";
const actorId = "22222222-2222-4222-8222-222222222222";
const routeActor = { id: actorId, role: "member", accountAccessVersion: 1 } satisfies AccessUser;
const workspaceId = "88888888-8888-4888-8888-888888888888";
const openAiConnectionId = "33333333-3333-4333-8333-333333333333";
const qwenConnectionId = "44444444-4444-4444-8444-444444444444";
const userConnectionId = "66666666-6666-4666-8666-666666666666";
const generationId = "55555555-5555-4555-8555-555555555555";
const defaultRouteId = "77777777-7777-4777-8777-777777777777";
const routeUpdatedAt = new Date("2026-09-01T00:00:00.000Z");
const routeFenceFingerprint = "a".repeat(64);

type FakeRoute = {
  operation: "embedding" | "visionExtract" | "autoExtract" | "generateWithContext";
  providerConnectionId: string;
  modelId: string;
  embeddingDimensions: number | null;
  maxOutputTokens: number;
  updatedAt: Date;
};

type FakeProvider = {
  id: string;
  kind: "openai" | "qwen";
  status: "verified" | "error";
  scope: "platform" | "workspace" | "user";
  workspaceId: string | null;
  defaultEmbeddingModelId: string | null;
  defaultVisionModelId: string | null;
  defaultGenerationModelId: string | null;
  embeddingDimensions: number | null;
};

type FakeRouteDbOptions = Readonly<{
  membershipInheritanceMode?: "projectOnly" | "workspaceInherited";
  workspaceRole?: "owner" | "admin" | null;
  projectRole?: "owner" | "editor" | "viewer" | null;
}>;

class FakeRouteDb {
  private membershipInheritanceMode: "projectOnly" | "workspaceInherited" = "projectOnly";
  private workspaceRole: "owner" | "admin" | null = "owner";
  private projectRole: "owner" | "editor" | "viewer" | null = "owner";

  constructor(options: FakeRouteDbOptions = {}) {
    this.membershipInheritanceMode = options.membershipInheritanceMode ?? "projectOnly";
    this.workspaceRole = options.workspaceRole === undefined ? "owner" : options.workspaceRole;
    this.projectRole = options.projectRole === undefined ? "owner" : options.projectRole;
  }

  readonly routes = new Map<string, FakeRoute>();
  readonly providers = new Map<string, FakeProvider>([
    [openAiConnectionId, {
      id: openAiConnectionId,
      kind: "openai",
      status: "verified",
      scope: "platform",
      workspaceId: null,
      defaultEmbeddingModelId: "text-embedding-3-small",
      defaultVisionModelId: "gpt-4.1-mini",
      defaultGenerationModelId: "gpt-4.1-mini",
      embeddingDimensions: 1536,
    }],
    [qwenConnectionId, {
      id: qwenConnectionId,
      kind: "qwen",
      status: "verified",
      scope: "platform",
      workspaceId: null,
      defaultEmbeddingModelId: "text-embedding-v4",
      defaultVisionModelId: "qwen3-vl-plus",
      defaultGenerationModelId: "qwen-plus",
      embeddingDimensions: 1024,
    }],
    [userConnectionId, {
      id: userConnectionId,
      kind: "openai",
      status: "verified",
      scope: "user",
      workspaceId: null,
      defaultEmbeddingModelId: "text-embedding-3-small",
      defaultVisionModelId: "gpt-4.1-mini",
      defaultGenerationModelId: "gpt-4.1-mini",
      embeddingDimensions: 1536,
    }],
  ]);
  readonly revisions: Array<Record<string, unknown>> = [];
  routeReads = 0;
  activeIndex: unknown = null;
  private routeClock = 0;

  readonly project = {
    findUnique: async () => ({ id: projectId, workspaceId, archivedAt: null, membershipInheritanceMode: this.membershipInheritanceMode }),
  };

  readonly appUser = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      where.id === actorId ? { id: actorId, role: "member" as const, disabledAt: null, accountAccessVersion: 1 } : null,
  };

  readonly workspaceMembership = {
    findMany: async ({ where }: { where: { userId: string } }) =>
      where.userId === actorId && this.workspaceRole !== null
        ? [{ role: this.workspaceRole, accessState: "confirmed" as const }]
        : [],
  };

  readonly projectMembership = {
    findMany: async ({ where }: { where: { projectId: string; userId: string } }) =>
      where.projectId === projectId && where.userId === actorId && this.projectRole !== null
        ? [{ role: this.projectRole, accessState: "confirmed" as const }]
        : [],
  };

  readonly aiProviderConnection = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.providers.get(where.id) ?? null,
    findMany: async ({
      where,
    }: {
      where: {
        status: { not: string };
        OR: Array<{ scope: "platform" | "workspace"; workspaceId?: string | null }>;
      };
    }) => Array.from(this.providers.values())
      .filter((provider) => provider.status !== where.status.not)
      .filter((provider) => where.OR.some((candidate) =>
        candidate.scope === "platform"
          ? provider.scope === "platform"
          : provider.scope === "workspace" && candidate.workspaceId !== undefined && provider.workspaceId === candidate.workspaceId,
      ))
      .map((provider) => ({ ...provider, name: provider.id })),
  };

  readonly projectAiRoute = {
    findUnique: async ({
      where,
      include,
    }: {
      where: { projectId_operation: { projectId: string; operation: FakeRoute["operation"] } };
      include?: { providerConnection?: true };
    }) => {
      this.routeReads += 1;
      const route = this.routes.get(this.routeKey(where.projectId_operation.projectId, where.projectId_operation.operation));
      if (route === undefined || include?.providerConnection !== true) return route ?? null;
      const provider = this.providers.get(route.providerConnectionId);
      return provider === undefined ? null : { ...route, providerConnection: provider };
    },
    findMany: async () => Array.from(this.routes.values()),
    create: async ({ data }: { data: Omit<FakeRoute, "updatedAt"> & { projectId: string } }) => {
      const route: FakeRoute = {
        operation: data.operation,
        providerConnectionId: data.providerConnectionId,
        modelId: data.modelId,
        embeddingDimensions: data.embeddingDimensions,
        maxOutputTokens: data.maxOutputTokens,
        updatedAt: this.nextTimestamp(),
      };
      this.routes.set(this.routeKey(projectId, route.operation), route);
      return route;
    },
    update: async ({ where, data }: { where: { projectId_operation: { projectId: string; operation: FakeRoute["operation"] } }; data: Partial<FakeRoute> }) => {
      const key = this.routeKey(where.projectId_operation.projectId, where.projectId_operation.operation);
      const current = this.routes.get(key);
      if (current === undefined) throw new Error("ROUTE_NOT_FOUND");
      const route: FakeRoute = { ...current, ...data, updatedAt: this.nextTimestamp() };
      this.routes.set(key, route);
      return route;
    },
  };

  readonly memoryIndexPointer = {
    findUnique: async () => this.activeIndex,
  };

  readonly projectAiRouteRevision = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const revision = {
        id: `revision-${this.revisions.length + 1}`,
        ...data,
        createdAt: new Date("2026-08-28T00:00:00.000Z"),
      };
      this.revisions.push(revision);
      return revision;
    },
  };

  async $executeRaw(..._args: unknown[]): Promise<number> {
    void _args;
    return 0;
  }

  async $transaction<T>(callback: (tx: this) => Promise<T>): Promise<T> {
    return callback(this);
  }

  private routeKey(currentProjectId: string, operation: FakeRoute["operation"]): string {
    return `${currentProjectId}:${operation}`;
  }

  private nextTimestamp(): Date {
    this.routeClock += 1;
    return new Date(`2026-08-28T00:00:0${this.routeClock}.000Z`);
  }
}

function dbWithRoute(route: FakeRoute): FakeRouteDb {
  const db = new FakeRouteDb();
  db.routes.set(`${projectId}:${route.operation}`, route);
  return db;
}

function activeIndexFor(
  providerConnectionId: string,
  modelId: string,
  dimensions: number,
) {
  return {
    indexGenerationId: generationId,
    generation: {
      providerConnectionId,
      modelId,
      dimensions,
      providerConnection: { name: "OpenAI", kind: "openai" },
    },
  };
}

test("route preview marks generation changes as future-only and preserves the index", async () => {
  const currentUpdatedAt = new Date("2026-08-28T00:00:00.000Z");
  const db = dbWithRoute({
    operation: "autoExtract",
    providerConnectionId: openAiConnectionId,
    modelId: "gpt-4.1-mini",
    embeddingDimensions: null,
    maxOutputTokens: 1024,
    updatedAt: currentUpdatedAt,
  });

  const preview = await previewProjectAiRouteChange(projectId, {
    operation: "autoExtract",
    providerConnectionId: qwenConnectionId,
    modelId: "qwen-plus",
    maxOutputTokens: 2048,
  }, routeActor, db as unknown as PrismaClient);

  assert.equal(preview.impact.changed, true);
  assert.equal(preview.impact.onlyFutureRuns, true);
  assert.equal(preview.impact.indexInvalidated, false);
  assert.equal(preview.impact.requiresIndexRebuildAcknowledgement, false);
  assert.equal(preview.current?.modelId, "gpt-4.1-mini");
  assert.equal(preview.next.modelId, "qwen-plus");
});

test("vision route accepts only the provider's configured vision model and stays future-only", async () => {
  const db = new FakeRouteDb();
  const preview = await previewProjectAiRouteChange(projectId, {
    operation: "visionExtract",
    providerConnectionId: qwenConnectionId,
    modelId: "qwen3-vl-plus",
    maxOutputTokens: 2048,
  }, routeActor, db as unknown as PrismaClient);
  assert.equal(preview.impact.onlyFutureRuns, true);
  assert.equal(preview.impact.indexInvalidated, false);
  await assert.rejects(
    () => previewProjectAiRouteChange(projectId, {
      operation: "visionExtract",
      providerConnectionId: qwenConnectionId,
      modelId: "qwen-vl-unconfigured",
      maxOutputTokens: 2048,
    }, routeActor, db as unknown as PrismaClient),
    (error: unknown) => error instanceof ProjectAiRouteError && error.code === "AI_PROVIDER_CAPABILITY_MISMATCH",
  );
});

test("legacy project routes fail closed for user-scoped providers", async () => {
  const input = {
    operation: "autoExtract" as const,
    providerConnectionId: userConnectionId,
    modelId: "gpt-4.1-mini",
    maxOutputTokens: 2048,
    expectedUpdatedAt: null,
  };
  const db = new FakeRouteDb();

  await assert.rejects(
    () => previewProjectAiRouteChange(projectId, input, routeActor, db as unknown as PrismaClient),
    (error: unknown) => error instanceof ProjectAiRouteError && error.code === "AI_PROVIDER_SCOPE_FORBIDDEN",
  );
  await assert.rejects(
    () => upsertProjectAiRoute(projectId, input, routeActor, db as unknown as PrismaClient),
    (error: unknown) => error instanceof ProjectAiRouteError && error.code === "AI_PROVIDER_SCOPE_FORBIDDEN",
  );

  db.routes.set(`${projectId}:autoExtract`, {
    operation: "autoExtract",
    providerConnectionId: userConnectionId,
    modelId: "gpt-4.1-mini",
    embeddingDimensions: null,
    maxOutputTokens: 2048,
    updatedAt: new Date("2026-08-28T00:00:00.000Z"),
  });
  await assert.rejects(
    () => requireProjectAiRoute(projectId, "autoExtract", db as unknown as PrismaClient),
    (error: unknown) => error instanceof ProjectAiRouteError && error.code === "AI_PROVIDER_SCOPE_FORBIDDEN",
  );

  const listed = await getProjectAiRoutes(
    projectId,
    routeActor,
    db as unknown as PrismaClient,
  );
  assert.equal(listed.providers.some((provider) => provider.id === userConnectionId), false);
});

test("AI route preview and upsert reject a foreign project before reading route state", async () => {
  const input = {
    operation: "autoExtract" as const,
    providerConnectionId: openAiConnectionId,
    modelId: "gpt-4.1-mini",
    maxOutputTokens: 2048,
    expectedUpdatedAt: null,
  };
  const previewDb = new FakeRouteDb();
  await assert.rejects(
    () => previewProjectAiRouteChange(foreignProjectId, input, routeActor, previewDb as unknown as PrismaClient),
    (error: unknown) => error instanceof WebAiAccessError && error.code === "ACCESS_FORBIDDEN",
  );
  assert.equal(previewDb.routeReads, 0);

  const upsertDb = new FakeRouteDb();
  await assert.rejects(
    () => upsertProjectAiRoute(foreignProjectId, input, routeActor, upsertDb as unknown as PrismaClient),
    (error: unknown) => error instanceof WebAiAccessError && error.code === "ACCESS_FORBIDDEN",
  );
  assert.equal(upsertDb.routeReads, 0);
});

test("AI route writes require a direct project owner grant when workspace access is inherited", async () => {
  const input = {
    operation: "autoExtract" as const,
    providerConnectionId: openAiConnectionId,
    modelId: "gpt-4.1-mini",
    maxOutputTokens: 2048,
    expectedUpdatedAt: null,
  };

  for (const workspaceRole of ["owner", "admin"] as const) {
    const db = new FakeRouteDb({
      membershipInheritanceMode: "workspaceInherited",
      workspaceRole,
      projectRole: null,
    });
    await assert.rejects(
      () => previewProjectAiRouteChange(projectId, input, routeActor, db as unknown as PrismaClient),
      (error: unknown) => error instanceof ProjectAiRouteError && error.code === "AI_PROVIDER_SCOPE_FORBIDDEN",
      `workspace ${workspaceRole} without a direct project owner grant must be rejected`,
    );
    await assert.rejects(
      () => upsertProjectAiRoute(projectId, input, routeActor, db as unknown as PrismaClient),
      (error: unknown) => error instanceof ProjectAiRouteError && error.code === "AI_PROVIDER_SCOPE_FORBIDDEN",
      `workspace ${workspaceRole} without a direct project owner grant must be rejected`,
    );
    assert.equal(db.routeReads, 0, `workspace ${workspaceRole} must be rejected before route state reads`);
  }

  const directOwnerDb = new FakeRouteDb({
    membershipInheritanceMode: "workspaceInherited",
    workspaceRole: null,
    projectRole: "owner",
  });
  await assert.doesNotReject(() => previewProjectAiRouteChange(projectId, input, routeActor, directOwnerDb as unknown as PrismaClient));
  await assert.doesNotReject(() => upsertProjectAiRoute(projectId, input, routeActor, directOwnerDb as unknown as PrismaClient));
  assert.ok(directOwnerDb.routeReads > 0);
});

test("embedding changes require acknowledgement, record provenance, and reject stale CAS writes", async () => {
  const currentUpdatedAt = new Date("2026-08-28T00:00:00.000Z");
  const db = dbWithRoute({
    operation: "embedding",
    providerConnectionId: openAiConnectionId,
    modelId: "text-embedding-3-small",
    embeddingDimensions: 1536,
    maxOutputTokens: 128,
    updatedAt: currentUpdatedAt,
  });
  db.activeIndex = activeIndexFor(openAiConnectionId, "text-embedding-3-small", 1536);

  const preview = await previewProjectAiRouteChange(projectId, {
    operation: "embedding",
    providerConnectionId: qwenConnectionId,
    modelId: "text-embedding-v4",
    embeddingDimensions: 1024,
  }, routeActor, db as unknown as PrismaClient);

  assert.equal(preview.impact.onlyFutureRuns, false);
  assert.equal(preview.impact.indexInvalidated, true);
  assert.equal(preview.impact.requiresIndexRebuildAcknowledgement, true);
  assert.equal(preview.impact.activeIndex?.providerConnectionId, openAiConnectionId);

  await assert.rejects(
    () => upsertProjectAiRoute(projectId, {
      operation: "embedding",
      providerConnectionId: qwenConnectionId,
      modelId: "text-embedding-v4",
      embeddingDimensions: 1024,
      expectedUpdatedAt: currentUpdatedAt.toISOString(),
    }, routeActor, db as unknown as PrismaClient),
    (error: unknown) => error instanceof ProjectAiRouteError && error.code === "PROJECT_AI_ROUTE_CONFIRMATION_REQUIRED",
  );
  assert.equal(db.revisions.length, 0);

  const saved = await upsertProjectAiRoute(projectId, {
    operation: "embedding",
    providerConnectionId: qwenConnectionId,
    modelId: "text-embedding-v4",
    embeddingDimensions: 1024,
    expectedUpdatedAt: currentUpdatedAt.toISOString(),
    acknowledgeIndexRebuild: true,
  }, routeActor, db as unknown as PrismaClient);
  assert.equal(saved.impact.indexInvalidated, true);
  assert.equal(saved.revision?.oldProviderConnectionId, openAiConnectionId);
  assert.equal(saved.revision?.oldModelId, "text-embedding-3-small");
  assert.equal(saved.revision?.newProviderConnectionId, qwenConnectionId);
  assert.equal(saved.revision?.newModelId, "text-embedding-v4");
  assert.equal(saved.revision?.actorId, actorId);
  assert.equal("apiKey" in saved.revision!, false);
  assert.equal(db.revisions.length, 1);

  await assert.rejects(
    () => upsertProjectAiRoute(projectId, {
      operation: "embedding",
      providerConnectionId: openAiConnectionId,
      modelId: "text-embedding-3-small",
      embeddingDimensions: 1536,
      expectedUpdatedAt: currentUpdatedAt.toISOString(),
      acknowledgeIndexRebuild: true,
    }, routeActor, db as unknown as PrismaClient),
    (error: unknown) => error instanceof ProjectAiRouteError && error.code === "PROJECT_AI_ROUTE_CONFLICT",
  );
  assert.equal(db.routes.get(`${projectId}:embedding`)?.providerConnectionId, qwenConnectionId);
  assert.equal(db.revisions.length, 1);
});

test("memory index publication guard rejects pointer, route, provider, or input drift", () => {
  const expected = {
    expectedActiveIndexGenerationId: generationId,
    currentActiveIndexGenerationId: generationId,
    expectedRoute: {
      providerConnectionId: openAiConnectionId,
      modelId: "text-embedding-3-small",
      embeddingDimensions: 1536,
      updatedAt: routeUpdatedAt,
      source: "platform_default",
      routeId: defaultRouteId,
      routeVersion: 1,
      providerConfigurationVersion: 1,
      routeFenceFingerprint,
    },
    currentRoute: {
      providerConnectionId: openAiConnectionId,
      modelId: "text-embedding-3-small",
      embeddingDimensions: 1536,
      providerVerified: true,
      updatedAt: routeUpdatedAt,
      source: "platform_default",
      routeId: defaultRouteId,
      routeVersion: 1,
      providerConfigurationVersion: 1,
      routeFenceFingerprint,
    },
    expectedInputManifestFingerprint: "manifest-a",
    currentInputManifestFingerprint: "manifest-a",
  } as const;

  assert.equal(isMemoryIndexPublicationCurrent(expected), true);
  assert.equal(isMemoryIndexPublicationCurrent({
    ...expected,
    currentActiveIndexGenerationId: "stale-generation",
  }), false);
  assert.equal(isMemoryIndexPublicationCurrent({
    ...expected,
    currentRoute: { ...expected.currentRoute, modelId: "text-embedding-v4" },
  }), false);
  assert.equal(isMemoryIndexPublicationCurrent({
    ...expected,
    currentRoute: { ...expected.currentRoute, providerVerified: false },
  }), false);
  assert.equal(isMemoryIndexPublicationCurrent({
    ...expected,
    currentInputManifestFingerprint: "manifest-b",
  }), false);
});

test("readiness uses one precedence order and keeps generation provider failure last", () => {
  const base = {
    embeddingRoute: {
      providerConnectionId: openAiConnectionId,
      modelId: "text-embedding-3-small",
      embeddingDimensions: 1536,
      providerVerified: true,
      routeSource: "platform_default",
      routeId: defaultRouteId,
      routeVersion: 1,
      routeUpdatedAt,
      providerConfigurationVersion: 1,
      routeFenceFingerprint,
    },
    activeIndex: {
      providerConnectionId: openAiConnectionId,
      modelId: "text-embedding-3-small",
      dimensions: 1536,
      inputManifestFingerprint: "manifest-a",
      routeSource: "platform_default",
      routeId: defaultRouteId,
      routeVersion: 1,
      routeUpdatedAt,
      providerConfigurationVersion: 1,
      routeFenceFingerprint,
    },
    currentInputManifestFingerprint: "manifest-a",
  } as const;

  assert.equal(resolveMemoryIndexReadiness({ ...base, embeddingRoute: null }).state, "routeMissing");
  assert.equal(resolveMemoryIndexReadiness({
    ...base,
    embeddingRoute: { ...base.embeddingRoute, providerVerified: false },
    activeIndex: null,
  }).state, "providerUnavailable");
  assert.equal(resolveMemoryIndexReadiness({ ...base, activeIndex: null }).state, "indexMissing");
  assert.equal(resolveMemoryIndexReadiness({
    ...base,
    embeddingRoute: { ...base.embeddingRoute, modelId: "text-embedding-v4" },
    currentInputManifestFingerprint: "manifest-b",
  }).state, "routeIncompatible");
  assert.equal(resolveMemoryIndexReadiness({ ...base, currentInputManifestFingerprint: "manifest-b" }).state, "inputsChanged");
  assert.equal(resolveMemoryIndexReadiness({ ...base, generationProviderVerified: false }).state, "generationProviderUnavailable");
  assert.equal(resolveMemoryIndexReadiness({ ...base, generationProviderVerified: false }).indexCompatible, true);
  assert.equal(resolveMemoryIndexReadiness(base).ready, true);
});

test("publication conflicts map to 409 while input failures remain 422", () => {
  const conflict = mapApiError(new WebMemoryIndexError("MEMORY_INDEX_PUBLICATION_CONFLICT"));
  const empty = mapApiError(new WebMemoryIndexError("MEMORY_INDEX_EMPTY"));
  const routeConflict = mapApiError(new ProjectAiRouteError("PROJECT_AI_ROUTE_CONFLICT"));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "MEMORY_INDEX_PUBLICATION_CONFLICT");
  assert.equal(empty.status, 422);
  assert.equal(routeConflict.status, 409);
});

test("route deletion is not an exposed operation and revision checks match safe model IDs", () => {
  const routeSource = readFileSync(join(process.cwd(), "src/app/api/projects/[projectId]/ai-routes/route.ts"), "utf8");
  const serviceSource = readFileSync(join(process.cwd(), "src/lib/project-ai-routes.ts"), "utf8");
  const controlSource = readFileSync(join(process.cwd(), "src/app/projects/[projectId]/control/project-control-client.tsx"), "utf8");
  const schemaSource = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
  const migrationSource = readFileSync(join(process.cwd(), "prisma/migrations/20260829110000_add_project_ai_route_revisions/migration.sql"), "utf8");
  assert.doesNotMatch(routeSource, /export async function DELETE/u);
  assert.doesNotMatch(serviceSource, /deleteProjectAiRoute/u);
  assert.match(controlSource, /response\.status === 409/u);
  assert.match(controlSource, /refreshPreviewAfterConflict/u);
  assert.match(controlSource, /影响预览已刷新；请重新确认后再次保存/u);
  assert.match(schemaSource, /activeIndexGeneration\s+MemoryIndexGeneration\?\s+@relation\(fields: \[projectId, activeIndexGenerationId\], references: \[projectId, id\]/u);
  assert.match(migrationSource, /FOREIGN KEY \("projectId", "activeIndexGenerationId"\) REFERENCES "MemoryIndexGeneration"\("projectId", "id"\)/u);
  assert.equal(migrationSource.includes('"ProjectAiRouteRevision_projectId_activeIndexGenerationId_idx"'), true);
  assert.equal(migrationSource.includes('"MemoryIndexGeneration_projectId_expectedActiveIndexGenerationId_idx"'), true);
  assert.equal(isSafeModelId("qwen-plus-latest"), true);
  assert.equal(isSafeModelId("sk-compatible-model"), true);
  assert.equal(migrationSource.includes("\"newModelId\" !~ '://'") , true);
  assert.equal(migrationSource.includes("\"newModelId\" !~ '\\.\\.'"), true);
  assert.doesNotMatch(migrationSource, /newModelId" !~\*.*(?:latest|sk-)/u);
});
