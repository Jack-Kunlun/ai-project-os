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

test("candidate review rejects unsafe reviewer identity before opening a transaction", async () => {
  const { service, transactionCalls } = serviceWithTransactionTrap();
  await assert.rejects(
    service.dismissCandidate({
      projectId,
      candidateId: sourceId,
      reviewedBy: "Bearer secret",
    }),
    (error: unknown) =>
      error instanceof AiCandidateError &&
      error.code === "AI_CANDIDATE_INVALID_INPUT",
  );
  assert.equal(transactionCalls(), 0);
});
