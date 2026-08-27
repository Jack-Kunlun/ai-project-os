import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  READ_ONLY_AGENT_PROHIBITED_CAPABILITIES,
  READ_ONLY_AGENT_PLANNING_RULES,
  READ_ONLY_AGENT_TOOLS,
  ReadOnlyAgentError,
  createReadOnlyProjectAgent,
  verifyReadOnlyAgentPlan,
  type ProjectSearchResponse,
} from "@/lib/ai-memory";
import { promptInjectionSamples } from "./fixtures/ai-memory-eval-v1";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const chunkId = "44444444-4444-4444-8444-444444444444";
const snapshotId = "55555555-5555-4555-8555-555555555555";
const sourceText = "当前风险是回归样本不足。";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fakeDb() {
  const projectLookups: unknown[] = [];
  const sourceLookups: unknown[] = [];
  const project = {
    findUnique: async (input: unknown) => {
      projectLookups.push(input);
      const id = (input as { where: { id: string } }).where.id;
      return id === projectId
        ? {
            id: projectId,
            name: "只读代理项目",
            slug: "read-only-agent",
            description: "项目内只读证据",
            _count: { sources: 1, items: 1, snapshots: 0, scans: 0 },
          }
        : null;
    },
  };
  const projectSource = {
    findFirst: async (input: unknown) => {
      sourceLookups.push(input);
      const where = (input as { where: { projectId: string; id: string } }).where;
      return where.projectId === projectId && where.id === sourceId
        ? {
            id: sourceId,
            kind: "manual" as const,
            externalRef: null,
            contentText: sourceText,
            contentHash: sha256(sourceText),
            revisionKey: "66666666-6666-4666-8666-666666666666",
          }
        : null;
    },
    findMany: async () => [],
  };
  const db = {
    $transaction: async () => { throw new Error("must not open a write transaction"); },
    project,
    projectSource,
    projectSnapshot: { findFirst: async () => null },
  } as unknown as PrismaClient;
  return { db, projectLookups, sourceLookups };
}

function searchResponse(): ProjectSearchResponse {
  return {
    searchVersion: "project-search:v1",
    mode: "lexical",
    snapshot: {
      id: snapshotId,
      manifestFingerprint: "a".repeat(64),
      manualIndexGenerationId: "77777777-7777-4777-8777-777777777777",
      manualCorpusGenerationId: "88888888-8888-4888-8888-888888888888",
      effectivePolicyVersion: 1,
      publishedAt: new Date("2026-08-28T00:00:00.000Z"),
    },
    results: [{
      rank: 1,
      score: 1,
      matchedFeatures: ["substring"],
      componentRanks: {
        vector: null,
        cjk: 1,
        identifier: null,
        substring: 1,
        token: 1,
      },
      citation: {
        projectId,
        sourceId,
        sourceKind: "manual",
        externalRef: null,
        chunkId,
        rangeUnit: "utf8_byte",
        rangeStart: 0,
        rangeEnd: Buffer.byteLength(sourceText, "utf8"),
        contentHash: sha256(sourceText),
        excerpt: sourceText,
      },
    }],
  };
}

test("read-only plans accept only the four project-scoped tools and exact arguments", () => {
  const plan = verifyReadOnlyAgentPlan({
    calls: [
      { callId: "a1", tool: "read_project", arguments: {} },
      { callId: "a2", tool: "search_memory", arguments: { query: "当前风险", take: 5 } },
      { callId: "a3", tool: "get_source", arguments: { sourceId } },
      { callId: "a4", tool: "get_snapshot", arguments: { snapshotId: null } },
    ],
  });
  assert.deepEqual(plan.calls.map((call) => call.tool), READ_ONLY_AGENT_TOOLS);
  assert.match(plan.planFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(plan), true);

  const invalid = [
    { calls: [] },
    { calls: [{ callId: "a2", tool: "read_project", arguments: {} }] },
    { calls: [{ callId: "a1", tool: "read_project", arguments: { projectId } }] },
    { calls: [{ callId: "a1", tool: "search_memory", arguments: { query: "风险", take: 21 } }] },
    { calls: [{ callId: "a1", tool: "get_source", arguments: { sourceId, path: "/tmp" } }] },
    { calls: [{ callId: "a1", tool: "get_snapshot", arguments: { snapshotId: null, url: "https://example.com" } }] },
    { calls: [{ callId: "a1", tool: "shell", arguments: {} }] },
  ];
  for (const value of invalid) {
    assert.throws(
      () => verifyReadOnlyAgentPlan(value),
      (error: unknown) =>
        error instanceof ReadOnlyAgentError &&
        error.code === "READ_ONLY_AGENT_INVALID_PLAN",
    );
  }
});

test("all frozen prompt injections fail before any prohibited capability can run", async () => {
  assert.equal(promptInjectionSamples.length, 20);
  assert.deepEqual(
    promptInjectionSamples[0]?.forbiddenCapabilities,
    READ_ONLY_AGENT_PROHIBITED_CAPABILITIES.slice(0, 5),
  );
  for (const sample of promptInjectionSamples) {
    const { db, sourceLookups } = fakeDb();
    const agent = createReadOnlyProjectAgent({
      db,
      searchService: { search: async () => { throw new Error("must not search"); } },
      resolvePlan: async (input) => {
        assert.equal(input.question, sample.input);
        return { calls: [{ callId: "a1", tool: "shell", arguments: {} }] };
      },
      resolveFinal: async () => { throw new Error("must not resolve final"); },
    });
    await assert.rejects(
      () => agent.run({ projectId, question: sample.input }),
      (error: unknown) =>
        error instanceof ReadOnlyAgentError &&
        error.code === "READ_ONLY_AGENT_INVALID_PLAN",
    );
    assert.equal(sourceLookups.length, 0);
  }
});

test("agent executes project reads only and returns an exactly cited result", async () => {
  const { db, projectLookups, sourceLookups } = fakeDb();
  let searchCalls = 0;
  let finalCalls = 0;
  const agent = createReadOnlyProjectAgent({
    db,
    searchService: {
      search: async (input) => {
        searchCalls += 1;
        assert.deepEqual(input, { projectId, query: "当前风险", take: 5 });
        return searchResponse();
      },
    },
    resolvePlan: async (input) => {
      assert.deepEqual(input.tools, READ_ONLY_AGENT_TOOLS);
      assert.deepEqual(input.prohibitedCapabilities, READ_ONLY_AGENT_PROHIBITED_CAPABILITIES);
      assert.deepEqual(input.rules, READ_ONLY_AGENT_PLANNING_RULES);
      return {
        calls: [
          { callId: "a1", tool: "read_project", arguments: {} },
          { callId: "a2", tool: "search_memory", arguments: { query: "当前风险", take: 5 } },
          { callId: "a3", tool: "get_source", arguments: { sourceId } },
        ],
      };
    },
    resolveFinal: async (plan) => {
      finalCalls += 1;
      assert.equal(plan.projectId, projectId);
      assert.equal(plan.snapshotId, snapshotId);
      assert.equal(plan.contexts.every((entry) => entry.projectId === projectId), true);
      return {
        kind: "answer",
        claims: [{
          text: "当前风险是回归样本不足",
          citations: [{ citationKey: "c1", excerpt: "当前风险是回归样本不足" }],
        }],
      };
    },
  });
  const run = await agent.run({ projectId, question: "当前风险是什么？" });
  assert.equal(run.result.kind, "answer");
  assert.equal(run.capabilities.writeCount, 0);
  assert.deepEqual(run.capabilities.tools, READ_ONLY_AGENT_TOOLS);
  assert.deepEqual(run.capabilities.prohibited, READ_ONLY_AGENT_PROHIBITED_CAPABILITIES);
  assert.deepEqual(run.trace.map((entry) => entry.tool), [
    "read_project",
    "search_memory",
    "get_source",
  ]);
  assert.equal(searchCalls, 1);
  assert.equal(finalCalls, 1);
  assert.equal(projectLookups.length, 1);
  assert.equal(sourceLookups.length, 1);
  assert.deepEqual(
    (sourceLookups[0] as { where: unknown }).where,
    { projectId, id: sourceId },
  );

  await assert.rejects(
    () => agent.run({ projectId: otherProjectId, question: "当前风险是什么？" }),
    (error: unknown) =>
      error instanceof ReadOnlyAgentError &&
      error.code === "READ_ONLY_AGENT_PROJECT_NOT_FOUND",
  );
});

test("agent executor contains no outbound, host, connector or mutation capability", () => {
  const source = readFileSync(
    join(process.cwd(), "src/lib/ai-memory/read-only-agent.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /node:(?:fs|child_process|net|http|https)|\bfetch\s*\(|\bMCP\b.*(?:call|client)|\.\$(?:executeRaw|executeRawUnsafe)\s*\(/iu,
  );
  assert.doesNotMatch(
    source,
    /\boptions\.db\.[A-Za-z][A-Za-z0-9_]*\.(?:create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/u,
  );
});

test("metadata-only plans refuse without invoking the final model", async () => {
  const { db } = fakeDb();
  let finalCalls = 0;
  const agent = createReadOnlyProjectAgent({
    db,
    searchService: { search: async () => { throw new Error("must not search"); } },
    resolvePlan: async () => ({
      calls: [{ callId: "a1", tool: "read_project", arguments: {} }],
    }),
    resolveFinal: async () => {
      finalCalls += 1;
      return {};
    },
  });
  const run = await agent.run({ projectId, question: "谁负责？" });
  assert.equal(run.result.kind, "refusal");
  assert.equal(finalCalls, 0);
  assert.equal(run.capabilities.writeCount, 0);
});
