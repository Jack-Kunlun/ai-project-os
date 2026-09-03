import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { isSafeModelId } from "../src/lib/ai-providers";
import { mapApiError } from "../src/lib/api-errors";
import {
  ProjectAiRouteError,
  previewProjectAiRouteChange,
  upsertProjectAiRoute,
} from "../src/lib/project-ai-routes";
import {
  isMemoryIndexPublicationCurrent,
  resolveMemoryIndexReadiness,
  WebMemoryIndexError,
} from "../src/lib/web-memory-index";

const projectId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const openAiConnectionId = "33333333-3333-4333-8333-333333333333";
const qwenConnectionId = "44444444-4444-4444-8444-444444444444";
const generationId = "55555555-5555-4555-8555-555555555555";

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
  scope: "platform" | "workspace";
  workspaceId: string | null;
  defaultEmbeddingModelId: string | null;
  defaultVisionModelId: string | null;
  defaultGenerationModelId: string | null;
  embeddingDimensions: number | null;
};

class FakeRouteDb {
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
  ]);
  readonly revisions: Array<Record<string, unknown>> = [];
  activeIndex: unknown = null;
  private routeClock = 0;

  readonly project = {
    findUnique: async () => ({ id: projectId, workspaceId: null }),
  };

  readonly appUser = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      where.id === actorId ? { id: actorId } : null,
  };

  readonly workspaceMembership = {
    findUnique: async ({ where }: { where: { workspaceId_userId: { userId: string } } }) =>
      where.workspaceId_userId.userId === actorId ? { role: "owner" as const } : null,
  };

  readonly aiProviderConnection = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.providers.get(where.id) ?? null,
  };

  readonly projectAiRoute = {
    findUnique: async ({ where }: { where: { projectId_operation: { projectId: string; operation: FakeRoute["operation"] } } }) =>
      this.routes.get(this.routeKey(where.projectId_operation.projectId, where.projectId_operation.operation)) ?? null,
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
  }, db as unknown as PrismaClient);

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
  }, db as unknown as PrismaClient);
  assert.equal(preview.impact.onlyFutureRuns, true);
  assert.equal(preview.impact.indexInvalidated, false);
  await assert.rejects(
    () => previewProjectAiRouteChange(projectId, {
      operation: "visionExtract",
      providerConnectionId: qwenConnectionId,
      modelId: "qwen-vl-unconfigured",
      maxOutputTokens: 2048,
    }, db as unknown as PrismaClient),
    (error: unknown) => error instanceof ProjectAiRouteError && error.code === "AI_PROVIDER_CAPABILITY_MISMATCH",
  );
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
  }, db as unknown as PrismaClient);

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
    }, db as unknown as PrismaClient, actorId),
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
  }, db as unknown as PrismaClient, actorId);
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
    }, db as unknown as PrismaClient, actorId),
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
    },
    currentRoute: {
      providerConnectionId: openAiConnectionId,
      modelId: "text-embedding-3-small",
      embeddingDimensions: 1536,
      providerVerified: true,
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
    },
    activeIndex: {
      providerConnectionId: openAiConnectionId,
      modelId: "text-embedding-3-small",
      dimensions: 1536,
      inputManifestFingerprint: "manifest-a",
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
