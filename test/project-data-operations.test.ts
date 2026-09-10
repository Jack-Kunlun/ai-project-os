import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getProjectUsageSummary } from "../src/lib/project-usage";
import { sanitizeProjectExportMetadata } from "../src/lib/project-export";
import { createProjectExportSchema } from "../src/lib/validation";

test("usage summary combines independent current and legacy ledgers without counting run rows as requests", async () => {
  const db = {
    project: {
      findUnique: async () => ({ id: "11111111-1111-4111-8111-111111111111", name: "Usage", archivedAt: null }),
    },
    providerCallAudit: {
      groupBy: async () => [{
        providerConnectionId: "22222222-2222-4222-8222-222222222222",
        operation: "autoExtract",
        modelId: "qwen-plus",
        status: "succeeded",
        _count: { _all: 2 },
        _sum: { inputTokens: 120, outputTokens: 30 },
      }],
    },
    aiRun: {
      groupBy: async () => [{
        operation: "projectAnalysis",
        modelId: "legacy-model",
        status: "succeeded",
        _count: { _all: 3 },
        _sum: { requestCount: 4, inputTokens: 80, outputTokens: 20 },
      }],
    },
    aiProviderConnection: {
      findMany: async () => [{
        id: "22222222-2222-4222-8222-222222222222",
        name: "Qwen",
        kind: "qwen",
        scope: "platform",
        ownerUserId: null,
        status: "verified",
      }],
    },
  };
  const usage = await getProjectUsageSummary("11111111-1111-4111-8111-111111111111", 30, db as never);
  assert.ok(usage);
  assert.equal(usage.totals.recordCount, 5);
  assert.equal(usage.totals.requestCount, 6);
  assert.equal(usage.totals.inputTokens, 200);
  assert.equal(usage.totals.outputTokens, 50);
  assert.equal(usage.byProvider.length, 2);
  assert.equal(usage.byProvider.find((entry) => entry.source === "legacy")?.requestCount, 4);
  assert.equal(usage.sources.current, "ProviderCallAudit，每条受审计模型调用尝试计一次");
  assert.equal(usage.pricing.available, false);
  assert.match(usage.pricing.reason, /缓存命中和峰谷时段/u);
});

test("usage summary aggregates personal providers without exposing identity or model keys", async () => {
  const firstProviderId = "22222222-2222-4222-8222-222222222222";
  const secondProviderId = "33333333-3333-4333-8333-333333333333";
  const db = {
    project: { findUnique: async () => ({ id: "11111111-1111-4111-8111-111111111111", name: "Usage", archivedAt: null }) },
    providerCallAudit: {
      groupBy: async () => [
        { providerConnectionId: firstProviderId, operation: "autoExtract", modelId: "private-a", status: "succeeded", _count: { _all: 1 }, _sum: { inputTokens: 10, outputTokens: 2 } },
        { providerConnectionId: secondProviderId, operation: "autoExtract", modelId: "private-b", status: "succeeded", _count: { _all: 1 }, _sum: { inputTokens: 20, outputTokens: 3 } },
      ],
    },
    aiRun: { groupBy: async () => [] },
    aiProviderConnection: {
      findMany: async () => [
        { id: firstProviderId, name: "Private A", kind: "openai", scope: "user", ownerUserId: "44444444-4444-4444-8444-444444444444", status: "verified" },
        { id: secondProviderId, name: "Private B", kind: "qwen", scope: "user", ownerUserId: "55555555-5555-4555-8555-555555555555", status: "verified" },
      ],
    },
  };
  const usage = await getProjectUsageSummary("11111111-1111-4111-8111-111111111111", 30, db as never);
  assert.ok(usage);
  assert.equal(usage.byProvider.length, 1);
  assert.deepEqual(usage.byProvider[0], {
    providerName: null,
    providerKind: null,
    providerStatus: null,
    modelId: null,
    source: "current",
    recordCount: 2,
    requestCount: 2,
    inputTokens: 30,
    outputTokens: 5,
    succeededRequests: 2,
    failedRequests: 0,
    unknownRequests: 0,
    runningRequests: 0,
    totalTokens: 35,
  });
  assert.equal(usage.sources.current, "ProviderCallAudit，每条受审计模型调用尝试计一次");
  assert.doesNotMatch(JSON.stringify(usage), /Private A|Private B|private-a|private-b|22222222|33333333/u);
});

test("safe export request is optimistic and strict", () => {
  const expectedUpdatedAt = "2026-08-29T08:00:00.000Z";
  assert.deepEqual(createProjectExportSchema.parse({ expectedUpdatedAt }), { expectedUpdatedAt });
  assert.equal(createProjectExportSchema.safeParse({ expectedUpdatedAt, includeCredentials: true }).success, false);
});

test("export metadata removes private provider handles without deleting evidence fingerprints", () => {
  assert.deepEqual(sanitizeProjectExportMetadata({
    providerConnectionId: "private-provider",
    statementFingerprint: "statement-evidence",
    nested: { secretFingerprint: "private-secret", contentFingerprint: "content-evidence" },
  }), {
    statementFingerprint: "statement-evidence",
    nested: { contentFingerprint: "content-evidence" },
  });
});

test("export uses an authenticated POST, bounded attachment headers, and an explicit field whitelist", async () => {
  const route = await readFile("src/app/api/projects/[projectId]/export/route.ts", "utf8");
  const service = await readFile("src/lib/project-export.ts", "utf8");
  assert.match(route, /export async function POST/u);
  assert.match(route, /assertSameOrigin\(request\)/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /content-disposition/u);
  assert.match(route, /x-content-type-options/u);
  assert.match(route, /x-ai-project-os-export-sha256/u);
  assert.match(service, /PROJECT_EXPORT_MAX_BYTES = 20 \* 1024 \* 1024/u);
  assert.match(service, /contentText: true/u);
  for (const forbidden of ["ciphertext:", "nonce:", "authTag:", "secretFingerprint:", "providerRequestId:", "idempotencyKey:", "leaseTokenHash:", "embedding:"]) {
    assert.doesNotMatch(service, new RegExp(forbidden, "u"));
  }
});

test("usage API is a strict authenticated no-store read", async () => {
  const route = await readFile("src/app/api/projects/[projectId]/governance/usage/route.ts", "utf8");
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /getProjectPermission\(user, projectId\)/u);
  assert.match(route, /readProviderBalance: permission === "owner"/u);
  assert.match(route, /z\.enum\(\["7", "30", "90"\]\)/u);
  assert.match(route, /cache-control": "no-store"/u);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/u);
});
