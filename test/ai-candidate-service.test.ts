import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
  OPENAI_RESPONSES_PROFILE_VERSION,
  OPENAI_RESPONSES_PROVIDER_FINGERPRINT,
  OPENAI_RESPONSES_RETENTION_FINGERPRINT,
  buildOpenAiAutoExtractTransportPlan,
  verifyOpenAiAutoExtractResponse,
} from "@/lib/ai-runtime";
import {
  AiCandidateError,
  createAiCandidateService,
} from "@/lib/ai-memory";

const projectId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const actorId = "44444444-4444-4444-8444-444444444444";
const workspaceId = "55555555-5555-4555-8555-555555555555";
const actor = { id: actorId, role: "user" as const, accountAccessVersion: 1 };
const operationKey = "a".repeat(64);
const fingerprint = "b".repeat(64);
const modelId = "gpt-test-model-2026-08-27";

function verifiedResponse(): unknown {
  const plan = buildOpenAiAutoExtractTransportPlan(
    {
      profileVersion: OPENAI_RESPONSES_PROFILE_VERSION,
      providerFingerprint: OPENAI_RESPONSES_PROVIDER_FINGERPRINT,
      profileFingerprint: fingerprint,
      modelId,
      modelFingerprint: fingerprint,
      processorEndpointFingerprint: OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
      processorRegionFingerprint: fingerprint,
      processorRetentionFingerprint: OPENAI_RESPONSES_RETENTION_FINGERPRINT,
      maxInputBytes: 8_192,
      maxOutputTokens: 1_024,
      timeoutMs: 30_000,
    },
    {
      runId,
      operationKey,
      sources: [{ sourceId, content: "前缀：Owner is Cedar." }],
    },
  );
  const outputText = JSON.stringify({
    candidates: [
      {
        itemType: "decision",
        statement: "The owner is Cedar.",
        sourceId,
        sourceExcerpt: "Owner is Cedar.",
      },
    ],
  });
  return verifyOpenAiAutoExtractResponse(plan, {
    id: "resp_candidate_unit_1",
    object: "response",
    status: "completed",
    error: null,
    incomplete_details: null,
    model: modelId,
    store: false,
    tool_choice: "none",
    parallel_tool_calls: false,
    tools: [],
    metadata: { run_id: runId, operation_key: operationKey },
    output: [
      {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: outputText }],
      },
    ],
    output_text: outputText,
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
  });
}

function serviceWithTransactionTrap(): {
  service: ReturnType<typeof createAiCandidateService>;
  transactionCalls: () => number;
} {
  let transactionCalls = 0;
  const db = {
    $transaction: async () => {
      transactionCalls += 1;
      throw new Error("TRANSACTION_MUST_NOT_RUN");
    },
  } as unknown as PrismaClient;
  return {
    service: createAiCandidateService({ db }),
    transactionCalls: () => transactionCalls,
  };
}

function serviceWithCandidateAccessFixture(options: Readonly<{
  storedRole: "admin" | "user";
  disabledAt?: Date | null;
  accessible?: boolean;
  projectRole?: "owner" | "editor" | "viewer";
}>): {
  service: ReturnType<typeof createAiCandidateService>;
  candidateReads: () => number;
  transactionCalls: () => number;
} {
  let candidateReads = 0;
  let transactionCalls = 0;
  const db = {
    appUser: {
      findUnique: async () => ({
        id: actorId,
        role: options.storedRole,
        disabledAt: options.disabledAt ?? null,
        accountAccessVersion: 1,
      }),
    },
    project: {
      count: async () => 1,
      findUnique: async (query: { select?: { id?: boolean; workspaceId?: boolean; membershipInheritanceMode?: boolean; archivedAt?: boolean; workspace?: unknown; memberships?: unknown } }) => {
        if (query.select?.archivedAt === true && query.select?.id !== true) return { archivedAt: null };
        if (query.select?.id === true && query.select?.workspaceId === true && query.select?.membershipInheritanceMode !== true) {
          return { id: projectId, workspaceId };
        }
        if (query.select?.membershipInheritanceMode === true && query.select.workspace === undefined && query.select.memberships === undefined) {
          return { id: projectId, workspaceId, archivedAt: null, membershipInheritanceMode: "projectOnly" as const };
        }
        return {
          membershipInheritanceMode: "projectOnly" as const,
          workspace: { memberships: [] },
          memberships: options.accessible
            ? [{ role: options.projectRole ?? "viewer", accessState: "confirmed" as const }]
            : [],
        };
      },
    },
    workspaceMembership: {
      findUnique: async () => null,
      findMany: async () => [],
    },
    projectMembership: {
      findUnique: async () => options.accessible
        ? { role: options.projectRole ?? "viewer", accessState: "confirmed" as const }
        : null,
      findMany: async () => options.accessible
        ? [{ role: options.projectRole ?? "viewer", accessState: "confirmed" as const }]
        : [],
    },
    aiCandidateClaim: {
      findMany: async () => {
        candidateReads += 1;
        return [];
      },
    },
    $transaction: async (callback: (value: unknown) => Promise<unknown>) => {
      transactionCalls += 1;
      return callback({
        appUser: db.appUser,
        project: db.project,
        workspaceMembership: db.workspaceMembership,
        projectMembership: db.projectMembership,
        aiCandidateClaim: db.aiCandidateClaim,
        $executeRaw: async () => 0,
      });
    },
  } as unknown as PrismaClient;
  return {
    service: createAiCandidateService({ db }),
    candidateReads: () => candidateReads,
    transactionCalls: () => transactionCalls,
  };
}

async function assertInvalidWithoutTransaction(response: unknown): Promise<void> {
  const { service, transactionCalls } = serviceWithTransactionTrap();
  await assert.rejects(
    service.persistVerifiedCandidates({ projectId, aiRunId: runId, verifiedResponse: response }),
    (error: unknown) =>
      error instanceof AiCandidateError &&
      error.code === "AI_CANDIDATE_INVALID_INPUT",
  );
  assert.equal(transactionCalls(), 0);
}

test("candidate persistence rejects changed verified text before opening a transaction", async () => {
  const forged = JSON.parse(JSON.stringify(verifiedResponse())) as {
    candidates: Array<{ statement: string }>;
  };
  forged.candidates[0]!.statement = "Changed after verification";
  await assertInvalidWithoutTransaction(forged);
});

test("candidate persistence rejects raw or unknown response fields", async () => {
  const forged = {
    ...(JSON.parse(JSON.stringify(verifiedResponse())) as Record<string, unknown>),
    rawResponse: { secret: "must-not-cross-boundary" },
  };
  await assertInvalidWithoutTransaction(forged);
});

test("candidate persistence rejects internally inconsistent evidence offsets", async () => {
  const forged = JSON.parse(JSON.stringify(verifiedResponse())) as {
    candidates: Array<{ sourceStart: number; sourceEnd: number }>;
  };
  forged.candidates[0]!.sourceStart = 3;
  forged.candidates[0]!.sourceEnd = 19;
  await assertInvalidWithoutTransaction(forged);
});

test("candidate completion can reuse the caller transaction without nesting one", async () => {
  const { service, transactionCalls } = serviceWithTransactionTrap();
  let runReads = 0;
  const tx = {
    aiRun: {
      findUnique: async () => {
        runReads += 1;
        return null;
      },
    },
  };
  await assert.rejects(
    service.persistVerifiedCandidatesInTransaction(tx as never, {
      projectId,
      aiRunId: runId,
      verifiedResponse: verifiedResponse(),
    }),
    (error: unknown) =>
      error instanceof AiCandidateError &&
      error.code === "AI_CANDIDATE_RUN_NOT_FOUND",
  );
  assert.equal(runReads, 1);
  assert.equal(transactionCalls(), 0);
});

test("candidate review rejects malformed actor identity before opening a transaction", async () => {
  const { service, transactionCalls } = serviceWithTransactionTrap();
  await assert.rejects(
    service.dismissCandidate({
      projectId,
      candidateId: sourceId,
      actor: { id: "not-a-uuid", role: "user" },
      expectedItemUpdatedAt: new Date(0),
    }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ACCESS_FORBIDDEN",
  );
  assert.equal(transactionCalls(), 0);
});

test("candidate listing authorizes the current actor before reading claims", async () => {
  const scenarios = [
    {
      name: "viewer",
      actor,
      options: { storedRole: "user" as const, accessible: true, projectRole: "viewer" as const },
      expected: "allowed",
    },
    {
      name: "non-member",
      actor,
      options: { storedRole: "user" as const },
      expected: "ACCESS_FORBIDDEN",
    },
    {
      name: "disabled",
      actor,
      options: { storedRole: "user" as const, disabledAt: new Date("2026-09-04T00:00:00.000Z") },
      expected: "ACCOUNT_DISABLED",
    },
    {
      name: "forged-admin-role",
      actor: { id: actorId, role: "admin" as const, accountAccessVersion: 1 },
      options: { storedRole: "user" as const },
      expected: "ACCESS_FORBIDDEN",
    },
    {
      name: "cross-project",
      actor,
      options: { storedRole: "user" as const, accessible: false },
      expected: "ACCESS_FORBIDDEN",
    },
  ] as const;
  for (const scenario of scenarios) {
    const fixture = serviceWithCandidateAccessFixture(scenario.options);
    if (scenario.expected === "allowed") {
      assert.deepEqual(
        await fixture.service.listCandidates({ projectId, actor: scenario.actor }),
        [],
        scenario.name,
      );
      assert.equal(fixture.candidateReads(), 1, scenario.name);
      continue;
    }
    await assert.rejects(
      () => fixture.service.listCandidates({ projectId, actor: scenario.actor }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === scenario.expected,
      scenario.name,
    );
    assert.equal(fixture.candidateReads(), 0, `${scenario.name} read claims`);
  }
});

test("candidate review authorizes edit access before opening the write transaction", async () => {
  const scenarios = [
    {
      name: "viewer",
      actor,
      options: { storedRole: "user" as const, accessible: true, projectRole: "viewer" as const },
      expected: "ACCESS_FORBIDDEN",
    },
    {
      name: "non-member",
      actor,
      options: { storedRole: "user" as const },
      expected: "ACCESS_FORBIDDEN",
    },
    {
      name: "disabled",
      actor,
      options: { storedRole: "user" as const, disabledAt: new Date("2026-09-04T00:00:00.000Z") },
      expected: "ACCOUNT_DISABLED",
    },
    {
      name: "forged-admin-role",
      actor: { id: actorId, role: "admin" as const, accountAccessVersion: 1 },
      options: { storedRole: "user" as const },
      expected: "ACCESS_FORBIDDEN",
    },
    {
      name: "cross-project",
      actor,
      options: { storedRole: "user" as const, accessible: false },
      expected: "ACCESS_FORBIDDEN",
    },
  ] as const;
  for (const scenario of scenarios) {
    const fixture = serviceWithCandidateAccessFixture(scenario.options);
    await assert.rejects(
      () => fixture.service.dismissCandidate({
        projectId,
        candidateId: sourceId,
        actor: scenario.actor,
        expectedItemUpdatedAt: new Date("2026-09-04T00:00:00.000Z"),
      }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === scenario.expected,
      scenario.name,
    );
    assert.equal(fixture.transactionCalls(), 0, `${scenario.name} opened a write transaction`);
  }
});

test("candidate review rejects a missing item version before opening a transaction", async () => {
  const { service, transactionCalls } = serviceWithTransactionTrap();
  await assert.rejects(
    service.acceptCandidate({
      projectId,
      candidateId: sourceId,
      actor,
      expectedItemUpdatedAt: null as unknown as Date,
      item: {
        type: "decision",
        title: "Candidate title",
        content: "Candidate content",
        occurredAt: null,
      },
    }),
    (error: unknown) =>
      error instanceof AiCandidateError &&
      error.code === "AI_CANDIDATE_INVALID_INPUT",
  );
  assert.equal(transactionCalls(), 0);
});

test("candidate review reports stale visible item state before any mutation", async () => {
  let itemWrites = 0;
  const tx = {
    appUser: {
      findUnique: async () => ({ id: actorId, role: "user", disabledAt: null, accountAccessVersion: 1 }),
    },
    project: {
      findUnique: async (query: { select?: { id?: boolean; workspaceId?: boolean; membershipInheritanceMode?: boolean; archivedAt?: boolean; workspace?: unknown; memberships?: unknown } }) => {
        if (query.select?.archivedAt === true && query.select?.id !== true) return { archivedAt: null };
        if (query.select?.id === true && query.select?.workspaceId === true && query.select?.membershipInheritanceMode !== true) {
          return { id: projectId, workspaceId };
        }
        if (query.select?.membershipInheritanceMode === true && query.select.workspace === undefined && query.select.memberships === undefined) {
          return { id: projectId, workspaceId, archivedAt: null, membershipInheritanceMode: "projectOnly" as const };
        }
        return { membershipInheritanceMode: "projectOnly" as const, workspace: { memberships: [] }, memberships: [{ role: "editor", accessState: "confirmed" as const }] };
      },
      count: async () => 1,
    },
    workspaceMembership: { findUnique: async () => null, findMany: async () => [] },
    projectMembership: {
      findUnique: async () => ({ role: "editor" as const, accessState: "confirmed" as const }),
      findMany: async () => [{ role: "editor" as const, accessState: "confirmed" as const }],
    },
    aiCandidateClaim: {
      findUnique: async () => ({
        id: sourceId,
        aiRunId: runId,
        sourceId,
        projectItemId: runId,
        reviewStatus: "candidate",
        projectItem: {
          reviewStatus: "candidate",
          updatedAt: new Date("2026-08-28T10:00:01.000Z"),
          source: { kind: "manual", retiredAt: null },
          evidences: [],
        },
        source: { kind: "manual", retiredAt: null },
      }),
    },
    projectItem: {
      updateMany: async () => {
        itemWrites += 1;
        return { count: 1 };
      },
    },
    $executeRaw: async () => 0,
  };
  const db = {
    appUser: {
      findUnique: async () => ({ id: actorId, role: "user", disabledAt: null, accountAccessVersion: 1 }),
    },
    project: {
      findUnique: async (query: { select?: { id?: boolean; workspaceId?: boolean; membershipInheritanceMode?: boolean; archivedAt?: boolean; workspace?: unknown; memberships?: unknown } }) => {
        if (query.select?.archivedAt === true && query.select?.id !== true) return { archivedAt: null };
        if (query.select?.id === true && query.select?.workspaceId === true && query.select?.membershipInheritanceMode !== true) {
          return { id: projectId, workspaceId };
        }
        if (query.select?.membershipInheritanceMode === true && query.select.workspace === undefined && query.select.memberships === undefined) {
          return { id: projectId, workspaceId, archivedAt: null, membershipInheritanceMode: "projectOnly" as const };
        }
        return { membershipInheritanceMode: "projectOnly" as const, workspace: { memberships: [] }, memberships: [{ role: "editor", accessState: "confirmed" as const }] };
      },
      count: async () => 1,
    },
    workspaceMembership: { findUnique: async () => null, findMany: async () => [] },
    projectMembership: {
      findUnique: async () => ({ role: "editor" as const, accessState: "confirmed" as const }),
      findMany: async () => [{ role: "editor" as const, accessState: "confirmed" as const }],
    },
    $executeRaw: async () => 0,
    $transaction: async (callback: (value: typeof tx) => Promise<unknown>) =>
      callback(tx),
  } as unknown as PrismaClient;
  const service = createAiCandidateService({ db });
  await assert.rejects(
    service.dismissCandidate({
      projectId,
      candidateId: sourceId,
      actor,
      expectedItemUpdatedAt: new Date("2026-08-28T10:00:00.000Z"),
    }),
    (error: unknown) =>
      error instanceof AiCandidateError &&
      error.code === "AI_CANDIDATE_VERSION_CONFLICT",
  );
  assert.equal(itemWrites, 0);
});

test("candidate review repeats actor and membership authorization inside the write transaction", async () => {
  for (const operation of ["accept", "dismiss"] as const) {
    let actorLookups = 0;
    let membershipLookups = 0;
    let candidateReads = 0;
    let itemWrites = 0;
    let claimWrites = 0;
    let revisionWrites = 0;
    const appUser = {
      findUnique: async () => {
        actorLookups += 1;
        return { id: actorId, role: "user", disabledAt: null, accountAccessVersion: 1 };
      },
    };
    const project = {
      findUnique: async (query: { select?: { id?: boolean; workspaceId?: boolean; membershipInheritanceMode?: boolean; archivedAt?: boolean; workspace?: unknown; memberships?: unknown } }) => {
        if (query.select?.archivedAt === true && query.select?.id !== true) return { archivedAt: null };
        if (query.select?.id === true && query.select?.workspaceId === true && query.select?.membershipInheritanceMode !== true) {
          return { id: projectId, workspaceId };
        }
        if (query.select?.membershipInheritanceMode === true && query.select.workspace === undefined && query.select.memberships === undefined) {
          return { id: projectId, workspaceId, archivedAt: null, membershipInheritanceMode: "projectOnly" as const };
        }
        return { membershipInheritanceMode: "projectOnly" as const, workspace: { memberships: [] }, memberships: [{ role: "editor", accessState: "confirmed" as const }] };
      },
      count: async () => 1,
    };
    const workspaceMembership = { findUnique: async () => null, findMany: async () => [] };
    const projectMembership = {
      findUnique: async () => ({ role: "editor" as const, accessState: "confirmed" as const }),
      findMany: async () => [{ role: "editor" as const, accessState: "confirmed" as const }],
    };
    const txProjectMembership = {
      findUnique: async () => {
        membershipLookups += 1;
        return null;
      },
      findMany: async () => {
        membershipLookups += 1;
        return [];
      },
    };
    const tx = {
      appUser,
      project,
      workspaceMembership,
      projectMembership: txProjectMembership,
      $executeRaw: async () => 0,
      aiCandidateClaim: {
        findUnique: async () => {
          candidateReads += 1;
          return null;
        },
        updateMany: async () => {
          claimWrites += 1;
          return { count: 1 };
        },
      },
      projectItem: {
        updateMany: async () => {
          itemWrites += 1;
          return { count: 1 };
        },
      },
      projectItemEvidence: { findFirst: async () => null },
      projectItemRevision: {
        findFirst: async () => null,
        create: async () => {
          revisionWrites += 1;
          return { id: sourceId, revisionNumber: 1 };
        },
      },
      projectItemRevisionEvidence: { createMany: async () => ({ count: 0 }) },
    };
    const db = {
      appUser,
      project,
      workspaceMembership,
      projectMembership,
      $transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
    } as unknown as PrismaClient;
    const service = createAiCandidateService({ db });
    await assert.rejects(
      () => operation === "accept"
        ? service.acceptCandidate({
            projectId,
            candidateId: sourceId,
            actor,
            expectedItemUpdatedAt: new Date("2026-09-04T00:00:00.000Z"),
            item: { type: "decision", title: "Candidate title", content: "Candidate content", occurredAt: null },
          })
        : service.dismissCandidate({
            projectId,
            candidateId: sourceId,
            actor,
            expectedItemUpdatedAt: new Date("2026-09-04T00:00:00.000Z"),
          }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ACCESS_FORBIDDEN",
      operation,
    );
    assert.equal(actorLookups, 5, `${operation} reloads actor inside transaction`);
    assert.equal(membershipLookups, 1, `${operation} reloads membership inside transaction`);
    assert.equal(candidateReads, 0, `${operation} reads no candidate after revoke`);
    assert.equal(itemWrites, 0, `${operation} writes no item after revoke`);
    assert.equal(claimWrites, 0, `${operation} writes no claim after revoke`);
    assert.equal(revisionWrites, 0, `${operation} writes no revision after revoke`);
  }
});
