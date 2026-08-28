import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { invokeEmbeddings, ProviderTransportError } from "../src/lib/ai-providers";
import { PROVIDER_REQUEST_TIMEOUT_MS } from "../src/lib/ai-providers/transport";
import {
  EMBEDDING_BATCH_SIZE,
  buildMemoryIndexEmbeddingWorklist,
  estimateMemoryIndexProviderCalls,
  isMemoryIndexDeadlineEligible,
  inputManifest,
  isMemoryIndexPublicationCurrent,
  MEMORY_INDEX_ESTIMATED_CALL_MS,
  MEMORY_INDEX_MAX_DURATION_MS,
  memoryEmbeddingFingerprint,
  memoryInputFingerprint,
  planFingerprint,
  resolveMemoryIndexReadiness,
  resolveMemoryIndexReconciliationOutcome,
  toPublicMemoryIndexPlan,
  type IndexInput,
} from "../src/lib/web-memory-index";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function input(overrides: Partial<IndexInput> = {}): IndexInput {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    scope: "projectSource",
    projectSourceId: "00000000-0000-4000-8000-000000000002",
    projectRepositoryLinkId: null,
    frozenCommitSha: null,
    path: null,
    externalRef: "notes://decision",
    rangeStart: 1,
    rangeEnd: 2,
    contentText: "采用统一项目记忆索引。",
    contentHash: "a".repeat(64),
    ...overrides,
  };
}

test("memory input manifest and fingerprints are deterministic and preserve provenance", () => {
  const first = input();
  const second = input({ id: "00000000-0000-4000-8000-000000000003", externalRef: "notes://same" });
  assert.equal(inputManifest([first, second]), inputManifest([second, first]));
  assert.equal(memoryInputFingerprint(first), memoryInputFingerprint({ ...first, id: "another-runtime-id" }));
  assert.notEqual(memoryInputFingerprint(first), memoryInputFingerprint({ ...first, externalRef: "notes://different" }));
  assert.notEqual(memoryEmbeddingFingerprint(first), memoryEmbeddingFingerprint({ ...first, contentText: "内容已变化。" }));

  const moved = { ...first, frozenCommitSha: "b".repeat(40), path: "src/moved.ts", externalRef: "github://org/repo/src/moved.ts@b" };
  assert.notEqual(memoryInputFingerprint(first), memoryInputFingerprint(moved));
  assert.equal(memoryEmbeddingFingerprint(first), memoryEmbeddingFingerprint(moved));
});

test("public memory index plan mapper is a strict runtime boundary", () => {
  const runtimePlan = {
    planFingerprint: "a".repeat(64),
    mode: "incremental" as const,
    providerConnectionId: "provider-id",
    providerName: "OpenAI",
    providerKind: "openai",
    modelId: "text-embedding-3-small",
    dimensions: 8,
    routeUpdatedAt: "2026-08-28T00:00:00.000Z",
    currentInputManifestFingerprint: "b".repeat(64),
    expectedInputCount: 2,
    reuseCount: 1,
    generateCount: 1,
    deleteCount: 0,
    baselineGenerationId: "generation-id",
    baselineManifestFingerprint: "c".repeat(64),
    estimatedProviderCalls: 1,
    deadlineAt: "2026-08-28T00:04:00.000Z",
    deadlineEligible: true,
    ineligibleCode: null,
    route: { providerConnectionId: "provider-id", credentialId: "secret-id", baseUrl: "https://secret.invalid" },
    records: [{ contentText: "do not serialize source" }],
    baselineRecords: [{ embedding: [0.1, 0.2] }],
    reuseByInputFingerprint: new Map([["input", { embedding: [0.1, 0.2] }]]),
    deadlineAtDate: new Date("2026-08-28T00:04:00.000Z"),
  } as unknown as Parameters<typeof toPublicMemoryIndexPlan>[0];
  const publicPlan = toPublicMemoryIndexPlan(runtimePlan);
  assert.deepEqual(Object.keys(publicPlan).sort(), [
    "baselineGenerationId",
    "baselineManifestFingerprint",
    "currentInputManifestFingerprint",
    "deadlineAt",
    "deadlineEligible",
    "deleteCount",
    "dimensions",
    "estimatedProviderCalls",
    "expectedInputCount",
    "generateCount",
    "ineligibleCode",
    "mode",
    "modelId",
    "planFingerprint",
    "providerConnectionId",
    "providerKind",
    "providerName",
    "reuseCount",
    "routeUpdatedAt",
  ]);
  const serialized = JSON.stringify(publicPlan);
  for (const forbiddenKey of ["contentText", "embedding", "credentialId", "baseUrl", "records", "route", "baselineRecords", "reuseByInputFingerprint"]) {
    assert.equal(Object.hasOwn(publicPlan, forbiddenKey), false, forbiddenKey);
  }
  assert.doesNotMatch(serialized, /do not serialize source|secret-id|secret\.invalid/);
});

test("memory index deadline budgets the transport timeout, not a nominal call estimate", () => {
  assert.equal(MEMORY_INDEX_ESTIMATED_CALL_MS, PROVIDER_REQUEST_TIMEOUT_MS + 2_000);
  assert.ok(MEMORY_INDEX_ESTIMATED_CALL_MS >= 45_000);
  assert.equal(isMemoryIndexDeadlineEligible(5), true);
  assert.equal(isMemoryIndexDeadlineEligible(6), false);
  assert.equal(isMemoryIndexDeadlineEligible(Math.ceil(MEMORY_INDEX_MAX_DURATION_MS / EMBEDDING_BATCH_SIZE)), false);
});

test("sparse reuse builds one global provider worklist and estimates its batches", () => {
  const records = Array.from({ length: 34 }, (_, index) => input({
    id: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
    externalRef: `notes://sparse/${index}`,
    contentText: `sparse record ${index}`,
    contentHash: index.toString(16).padStart(64, "0"),
  }));
  const reused = new Map(records.filter((_, index) => index % 2 === 0).map((record) => [memoryInputFingerprint(record), true]));
  const worklist = buildMemoryIndexEmbeddingWorklist(records, reused);
  assert.equal(worklist.length, 17);
  assert.equal(estimateMemoryIndexProviderCalls(worklist.length), 2);
  assert.equal(estimateMemoryIndexProviderCalls(worklist.length), Math.ceil(worklist.length / EMBEDDING_BATCH_SIZE));
});

test("memory reconciliation resolves an already-published candidate or abandons unknown in one local step", () => {
  const published = resolveMemoryIndexReconciliationOutcome({
    jobStatus: "unknown",
    jobReconciliationRequired: true,
    generationStatus: "complete",
    generationReconciliationRequired: false,
    generationId: "generation",
    pointerGenerationId: "generation",
  });
  assert.equal(published, "publishedLocally");
  const abandoned = resolveMemoryIndexReconciliationOutcome({
    jobStatus: "unknown",
    jobReconciliationRequired: true,
    generationStatus: "unknown",
    generationReconciliationRequired: true,
    generationId: "generation",
    pointerGenerationId: "previous",
  });
  assert.equal(abandoned, "explicitAbandon");
  assert.equal(resolveMemoryIndexReconciliationOutcome({
    jobStatus: "unknown",
    jobReconciliationRequired: true,
    generationStatus: "complete",
    generationReconciliationRequired: false,
    generationId: "generation",
    pointerGenerationId: "previous",
  }), "explicitAbandon");
  assert.equal(resolveMemoryIndexReconciliationOutcome({
    jobStatus: "unknown",
    jobReconciliationRequired: false,
    generationStatus: "unknown",
    generationReconciliationRequired: false,
    generationId: "generation",
    pointerGenerationId: null,
  }), null);
});

test("incremental plan fingerprint changes for mode, route, dimension and baseline", () => {
  const base = {
    mode: "full" as const,
    route: { providerConnectionId: "provider", modelId: "embedding-v1", embeddingDimensions: 8 },
    routeUpdatedAt: "2026-08-28T00:00:00.000Z",
    inputManifestFingerprint: "a".repeat(64),
    expectedInputCount: 2,
    generateCount: 2,
    reuseCount: 0,
    deleteCount: 0,
    baselineGenerationId: null,
    baselineManifestFingerprint: null,
    reusedInputFingerprints: [],
  };
  const fingerprint = planFingerprint(base);
  assert.notEqual(fingerprint, planFingerprint({ ...base, mode: "incremental" }));
  assert.notEqual(fingerprint, planFingerprint({ ...base, route: { ...base.route, modelId: "embedding-v2" } }));
  assert.notEqual(fingerprint, planFingerprint({ ...base, route: { ...base.route, embeddingDimensions: 16 } }));
  assert.notEqual(fingerprint, planFingerprint({ ...base, baselineGenerationId: "generation" }));
});

test("publication CAS includes route updatedAt when supplied", () => {
  const common = {
    expectedActiveIndexGenerationId: "generation",
    currentActiveIndexGenerationId: "generation",
    expectedRoute: { providerConnectionId: "provider", modelId: "embedding-v1", embeddingDimensions: 8, updatedAt: "2026-08-28T00:00:00.000Z" },
    currentRoute: { providerConnectionId: "provider", modelId: "embedding-v1", embeddingDimensions: 8, providerVerified: true, updatedAt: "2026-08-28T00:00:00.000Z" },
    expectedInputManifestFingerprint: "a".repeat(64),
    currentInputManifestFingerprint: "a".repeat(64),
  };
  assert.equal(isMemoryIndexPublicationCurrent(common), true);
  assert.equal(isMemoryIndexPublicationCurrent({ ...common, currentRoute: { ...common.currentRoute, updatedAt: "2026-08-28T00:00:01.000Z" } }), false);
});

test("non-complete active candidates never report semantic readiness", () => {
  const result = resolveMemoryIndexReadiness({
    embeddingRoute: { providerConnectionId: "provider", modelId: "embedding-v1", embeddingDimensions: 8, providerVerified: true },
    activeIndex: { providerConnectionId: "provider", modelId: "embedding-v1", dimensions: 8, inputManifestFingerprint: "a".repeat(64), status: "building" },
    currentInputManifestFingerprint: "a".repeat(64),
  });
  assert.equal(result.state, "indexMissing");
  assert.equal(result.ready, false);
});

test("legacy active generations require an explicit full rebuild", () => {
  const result = resolveMemoryIndexReadiness({
    embeddingRoute: { providerConnectionId: "provider", modelId: "embedding-v1", embeddingDimensions: 8, providerVerified: true },
    activeIndex: {
      providerConnectionId: "provider",
      modelId: "embedding-v1",
      dimensions: 8,
      inputManifestFingerprint: "a".repeat(64),
      legacy: true,
      status: "complete",
    },
    currentInputManifestFingerprint: "a".repeat(64),
  });
  assert.equal(result.state, "legacyIndex");
  assert.equal(result.indexCompatible, false);
  assert.equal(result.ready, false);
});

test("embedding deadline is deterministic before credential/fetch dispatch", async () => {
  let fetchCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => invokeEmbeddings({
        connection: {
          id: "00000000-0000-4000-8000-000000000001",
          kind: "openai",
          baseUrl: "https://example.invalid/v1",
          credentialId: "00000000-0000-4000-8000-000000000002",
          status: "verified",
        },
        modelId: "text-embedding-3-small",
        texts: ["deadline test"],
        expectedDimensions: 8,
        absoluteDeadlineAt: new Date(Date.now() - 1),
      }),
      (error: unknown) => error instanceof ProviderTransportError &&
        error.code === "AI_PROVIDER_TIMEOUT" && error.requestDispatched === false,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("memory index schema and API contracts expose candidate guards and explicit mode", () => {
  const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");
  const migration = readFileSync(join(root, "prisma/migrations/20260829141000_add_memory_index_candidates/migration.sql"), "utf8");
  const route = readFileSync(join(root, "src/app/api/projects/[projectId]/memory/index/route.ts"), "utf8");
  const client = readFileSync(join(root, "src/app/projects/[projectId]/memory/project-memory-client.tsx"), "utf8");
  const rag = readFileSync(join(root, "src/lib/web-rag.ts"), "utf8");
  assert.match(schema, /buildMode\s+MemoryIndexBuildMode/);
  assert.match(schema, /job\s+BackgroundJob\?/);
  assert.match(schema, /reusedFromMemoryRecord\s+MemoryRecord\?/);
  assert.match(schema, /model MemoryIndexReconciliation/);
  assert.match(schema, /@@index\(\[projectId, indexGenerationId, inputFingerprint\], map: "MemoryRecord_project_generation_input_fingerprint_idx"\)/u);
  assert.match(schema, /@@index\(\[projectId, embeddingFingerprint\], map: "MemoryRecord_project_embedding_fingerprint_idx"\)/u);
  assert.match(migration, /CREATE UNIQUE INDEX "MemoryIndexGeneration_active_candidate_key"/);
  assert.match(migration, /CREATE UNIQUE INDEX "MemoryIndexGeneration_active_candidate_key"[\s\S]*WHERE "jobId" IS NOT NULL/u);
  assert.match(migration, /OLD\."status" = 'complete'[\s\S]*NOT EXISTS \([\s\S]*"MemoryIndexPointer"/u);
  assert.match(migration, /OLD\."status" = 'unknown'[\s\S]*EXISTS \([\s\S]*"MemoryIndexReconciliation"/u);
  assert.match(migration, /CREATE TRIGGER "MemoryIndexPointer_guard"/);
  assert.match(migration, /CREATE TRIGGER "MemoryRecord_candidate_guard"/);
  assert.match(migration, /IF TG_OP = 'DELETE'[\s\S]*RETURN OLD;/u);
  assert.match(route, /mode: modeSchema/);
  assert.match(route, /planFingerprint/);
  assert.match(client, /增量构建（仅复用兼容向量）/);
  assert.match(client, /MEMORY_INDEX_PLAN_STALE/);
  assert.match(client, /activeGenerationId/);
  assert.match(client, /generation\.status === "complete"/);
  assert.match(client, /function MemoryIndexConsentCheck/);
  assert.match(client, /estimatedProviderCalls/);
  assert.match(client, /所有待生成片段会发送给该供应商；复用片段不会再次外发/);
  assert.match(client, /setAcknowledged\(false\);\n    setPlanLoading/u);
  assert.match(client, /setAcknowledged\(false\);\n          await loadPlan/u);
  assert.match(readFileSync(join(root, "docs/operation-manual.md"), "utf8"), /所有待生成片段会发送给供应商/);
  assert.match(rag, /pointer\.generation\.jobId === null/);
});
