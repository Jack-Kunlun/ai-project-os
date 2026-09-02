import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getProjectUsageSummary } from "../src/lib/project-usage";
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
    projectAiRoute: {
      findMany: async () => [{
        operation: "autoExtract",
        providerConnectionId: "22222222-2222-4222-8222-222222222222",
        modelId: "qwen-plus",
        providerConnection: { name: "Qwen", kind: "qwen", status: "verified" },
      }],
    },
    aiProviderConnection: {
      findMany: async () => [{ id: "22222222-2222-4222-8222-222222222222", name: "Qwen", kind: "qwen" }],
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
  assert.deepEqual(usage.routes, [{
    operation: "autoExtract",
    providerConnectionId: "22222222-2222-4222-8222-222222222222",
    providerName: "Qwen",
    providerKind: "qwen",
    providerStatus: "verified",
    modelId: "qwen-plus",
    balanceAvailable: false,
  }]);
  assert.equal(usage.pricing.available, false);
  assert.match(usage.pricing.reason, /缓存命中和峰谷时段/u);
});

test("safe export request is optimistic and strict", () => {
  const expectedUpdatedAt = "2026-08-29T08:00:00.000Z";
  assert.deepEqual(createProjectExportSchema.parse({ expectedUpdatedAt }), { expectedUpdatedAt });
  assert.equal(createProjectExportSchema.safeParse({ expectedUpdatedAt, includeCredentials: true }).success, false);
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
