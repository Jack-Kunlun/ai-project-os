import assert from "node:assert/strict";
import test from "node:test";
import { getUserTokenUsagePage, parseUserTokenUsageFilter } from "../src/lib/user-token-usage";

const actor = { id: "11111111-1111-4111-8111-111111111111", role: "user" as const, accountAccessVersion: 1 };
const now = new Date("2026-10-20T12:00:00.000Z");

for (const operation of ["vision", "graph"]) {
  test(`${operation} extraction entries include output tokens and agree with the usage summary`, async () => {
    const rows = [
      { id: "22222222-2222-4222-8222-222222222222", status: "succeeded", modelId: "test-model", operation, requestCount: 3, usageKnown: true, inputTokens: 100, outputTokens: 60, issuedAt: now },
      { id: "33333333-3333-4333-8333-333333333333", status: "unknown", modelId: "test-model", operation, requestCount: 2, usageKnown: false, inputTokens: 0, outputTokens: 0, issuedAt: now },
    ];
    const db = {
      personalKnowledgeExtractionAttempt: {
        findMany: async () => rows,
        groupBy: async () => rows.map(row => ({ usageKnown: row.usageKnown, _sum: { requestCount: row.requestCount, inputTokens: row.inputTokens, outputTokens: row.outputTokens } })),
      },
    } as unknown as NonNullable<Parameters<typeof getUserTokenUsagePage>[2]>;
    const filter = parseUserTokenUsageFilter(new URLSearchParams({ kind: "extraction" }), now);
    const page = await getUserTokenUsagePage(actor, filter, db);
    const known = page.entries.find(entry => entry.id === rows[0]!.id)!.usage;
    const unknown = page.entries.find(entry => entry.id === rows[1]!.id)!.usage;
    assert.deepEqual(known, { status: "known", requestCount: 3, knownRequestCount: 3, unknownRequestCount: 0, inputTokens: 100, outputTokens: 60, totalTokens: 160 });
    assert.deepEqual(unknown, { status: "unknown", requestCount: 2, knownRequestCount: 0, unknownRequestCount: 2, inputTokens: null, outputTokens: null, totalTokens: null });
    assert.deepEqual(page.summary, { status: "partial", requestCount: 5, knownRequestCount: 3, unknownRequestCount: 2, inputTokens: 100, outputTokens: 60, totalTokens: 160 });
    assert.equal(page.summary.totalTokens, known.totalTokens);
  });
}
