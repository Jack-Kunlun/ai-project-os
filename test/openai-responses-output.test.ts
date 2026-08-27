import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  AiRuntimeServiceError,
  OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
  OPENAI_RESPONSES_OUTPUT_CONTRACT_VERSION,
  OPENAI_RESPONSES_PROFILE_VERSION,
  OPENAI_RESPONSES_PROVIDER_FINGERPRINT,
  OPENAI_RESPONSES_RETENTION_FINGERPRINT,
  buildOpenAiAutoExtractTransportPlan,
  verifyOpenAiAutoExtractResponse,
  type OpenAiResponsesTransportPlan,
} from "@/lib/ai-runtime";

const runId = "a1111111-1111-4111-8111-111111111111";
const sourceAId = "b2222222-2222-4222-8222-222222222222";
const sourceBId = "c3333333-3333-4333-8333-333333333333";
const operationKey = "a".repeat(64);
const modelFingerprint = "b".repeat(64);
const modelId = "gpt-test-model-2026-08-27";

function plan(): OpenAiResponsesTransportPlan {
  return buildOpenAiAutoExtractTransportPlan(
    {
      profileVersion: OPENAI_RESPONSES_PROFILE_VERSION,
      providerFingerprint: OPENAI_RESPONSES_PROVIDER_FINGERPRINT,
      profileFingerprint: operationKey,
      modelId,
      modelFingerprint,
      processorEndpointFingerprint: OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
      processorRegionFingerprint: operationKey,
      processorRetentionFingerprint: OPENAI_RESPONSES_RETENTION_FINGERPRINT,
      maxInputBytes: 8_192,
      maxOutputTokens: 1_024,
      timeoutMs: 30_000,
    },
    {
      runId,
      operationKey,
      sources: [
        {
          sourceId: sourceBId,
          content: "Owner is Cedar. Risk review is Friday.",
        },
        {
          sourceId: sourceAId,
          content: "Milestone is evidence review.\nOwner is Rowan.",
        },
      ],
    },
  );
}

function candidateOutput(
  candidates: readonly Record<string, unknown>[] = [
    {
      statement: "The project owner is Cedar.",
      sourceId: sourceBId,
      sourceExcerpt: "Owner is Cedar.",
    },
  ],
): string {
  return JSON.stringify({ candidates });
}

function providerResponse(
  outputText = candidateOutput(),
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "resp_safe_response_123",
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
      { type: "reasoning", id: "rs_safe" },
      {
        type: "message",
        id: "msg_safe",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: outputText, annotations: [] }],
      },
    ],
    output_text: outputText,
    usage: { input_tokens: 80, output_tokens: 40, total_tokens: 120 },
    ...overrides,
  };
}

function assertInvalidResponse(callback: () => unknown): void {
  assert.throws(
    callback,
    (error: unknown) =>
      error instanceof AiRuntimeServiceError &&
      error.code === "AI_INVALID_PROVIDER_RESPONSE" &&
      error.message === "AI_INVALID_PROVIDER_RESPONSE",
  );
}

test("verifier accepts one completed structured response and returns only verified evidence", () => {
  const output = candidateOutput([
    {
      statement: "The project owner is Cedar.",
      sourceId: sourceBId,
      sourceExcerpt: "Owner is Cedar.",
    },
    {
      statement: "The milestone is evidence review.",
      sourceId: sourceAId,
      sourceExcerpt: "Milestone is evidence review.",
    },
  ]);
  const verified = verifyOpenAiAutoExtractResponse(
    plan(),
    providerResponse(output),
  );

  assert.equal(
    verified.contractVersion,
    OPENAI_RESPONSES_OUTPUT_CONTRACT_VERSION,
  );
  assert.equal(verified.providerResponseId, "resp_safe_response_123");
  assert.equal(verified.modelId, modelId);
  assert.deepEqual(verified.usage, {
    inputTokens: 80,
    outputTokens: 40,
    requestCount: 1,
  });
  assert.deepEqual(
    verified.candidates.map((candidate) => candidate.sourceId),
    [sourceAId, sourceBId],
  );
  assert.equal(verified.candidates[0]?.sourceStart, 0);
  assert.equal(verified.candidates[0]?.sourceEnd, 29);
  assert.match(verified.candidates[0]?.statementFingerprint ?? "", /^[0-9a-f]{64}$/);
  assert.match(
    verified.candidates[0]?.sourceExcerptFingerprint ?? "",
    /^[0-9a-f]{64}$/,
  );
  assert.match(verified.candidateSetFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.isFrozen(verified.usage), true);
  assert.equal(Object.isFrozen(verified.candidates), true);
  assert.equal(Object.isFrozen(verified.candidates[0]), true);
  assert.equal("rawResponse" in verified, false);
  assert.equal("outputText" in verified, false);
});

test("verifier records UTF-8 byte offsets for non-ASCII source evidence", () => {
  const unicodePlan = buildOpenAiAutoExtractTransportPlan(
    {
      profileVersion: OPENAI_RESPONSES_PROFILE_VERSION,
      providerFingerprint: OPENAI_RESPONSES_PROVIDER_FINGERPRINT,
      profileFingerprint: operationKey,
      modelId,
      modelFingerprint,
      processorEndpointFingerprint: OPENAI_RESPONSES_ENDPOINT_FINGERPRINT,
      processorRegionFingerprint: operationKey,
      processorRetentionFingerprint: OPENAI_RESPONSES_RETENTION_FINGERPRINT,
      maxInputBytes: 8_192,
      maxOutputTokens: 1_024,
      timeoutMs: 30_000,
    },
    {
      runId,
      operationKey,
      sources: [{ sourceId: sourceAId, content: "前缀：里程碑已完成。" }],
    },
  );
  const output = candidateOutput([
    {
      statement: "里程碑已经完成。",
      sourceId: sourceAId,
      sourceExcerpt: "里程碑已完成",
    },
  ]);
  const verified = verifyOpenAiAutoExtractResponse(
    unicodePlan,
    providerResponse(output),
  );

  assert.equal(verified.candidates[0]?.sourceStart, 9);
  assert.equal(verified.candidates[0]?.sourceEnd, 27);
});

test("verifier binds the response to the issued model, metadata and no-tools request", () => {
  for (const invalid of [
    providerResponse(candidateOutput(), { object: "chat.completion" }),
    providerResponse(candidateOutput(), { status: "incomplete" }),
    providerResponse(candidateOutput(), { error: { code: "server_error" } }),
    providerResponse(candidateOutput(), {
      incomplete_details: { reason: "max_output_tokens" },
    }),
    providerResponse(candidateOutput(), { model: "different-model" }),
    providerResponse(candidateOutput(), { store: true }),
    providerResponse(candidateOutput(), { tool_choice: "auto" }),
    providerResponse(candidateOutput(), { parallel_tool_calls: true }),
    providerResponse(candidateOutput(), { tools: [{ type: "web_search" }] }),
    providerResponse(candidateOutput(), {
      metadata: { run_id: runId, operation_key: "b".repeat(64) },
    }),
    providerResponse(candidateOutput(), {
      metadata: {
        run_id: runId,
        operation_key: operationKey,
        secret: "not-allowed",
      },
    }),
    providerResponse(candidateOutput(), { id: "request-id-without-response-prefix" }),
  ]) {
    assertInvalidResponse(() => verifyOpenAiAutoExtractResponse(plan(), invalid));
  }
});

test("verifier rejects tool, refusal and ambiguous message output items", () => {
  const text = candidateOutput();
  for (const output of [
    [{ type: "function_call", name: "unsafe", arguments: "{}" }],
    [
      {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "refusal", refusal: "cannot comply" }],
      },
    ],
    [
      {
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
    [
      {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          { type: "output_text", text },
          { type: "output_text", text },
        ],
      },
    ],
    [
      {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
      {
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
  ]) {
    assertInvalidResponse(() =>
      verifyOpenAiAutoExtractResponse(
        plan(),
        providerResponse(text, { output }),
      ),
    );
  }
});

test("verifier rejects malformed candidate JSON and unsupported fields", () => {
  for (const outputText of [
    "not-json",
    JSON.stringify([]),
    JSON.stringify({ candidates: [], extra: true }),
    JSON.stringify({ candidates: "not-an-array" }),
    candidateOutput([
      {
        statement: "The project owner is Cedar.",
        sourceId: sourceBId,
        sourceExcerpt: "Owner is Cedar.",
        confidence: 1,
      },
    ]),
    candidateOutput([
      {
        statement: "",
        sourceId: sourceBId,
        sourceExcerpt: "Owner is Cedar.",
      },
    ]),
    candidateOutput([
      {
        statement: "unsafe\u0001control",
        sourceId: sourceBId,
        sourceExcerpt: "Owner is Cedar.",
      },
    ]),
    candidateOutput([
      {
        statement: "unpaired\ud800",
        sourceId: sourceBId,
        sourceExcerpt: "Owner is Cedar.",
      },
    ]),
  ]) {
    assertInvalidResponse(() =>
      verifyOpenAiAutoExtractResponse(
        plan(),
        providerResponse(outputText),
      ),
    );
  }
});

test("verifier requires authorized exact evidence and rejects duplicate candidates", () => {
  const valid = {
    statement: "The project owner is Cedar.",
    sourceId: sourceBId,
    sourceExcerpt: "Owner is Cedar.",
  };
  for (const candidates of [
    [{ ...valid, sourceId: "d4444444-4444-4444-8444-444444444444" }],
    [{ ...valid, sourceExcerpt: "Owner is Alice." }],
    [{ ...valid, sourceExcerpt: "   " }],
    [valid, valid],
  ]) {
    const outputText = candidateOutput(candidates);
    assertInvalidResponse(() =>
      verifyOpenAiAutoExtractResponse(
        plan(),
        providerResponse(outputText),
      ),
    );
  }
});

test("verifier rejects invalid usage, mismatched output_text and forged plans", () => {
  for (const invalid of [
    providerResponse(candidateOutput(), { usage: null }),
    providerResponse(candidateOutput(), {
      usage: { input_tokens: -1, output_tokens: 40, total_tokens: 39 },
    }),
    providerResponse(candidateOutput(), {
      usage: { input_tokens: 80, output_tokens: 1_025, total_tokens: 1_105 },
    }),
    providerResponse(candidateOutput(), {
      usage: { input_tokens: 80, output_tokens: 40, total_tokens: 121 },
    }),
    providerResponse(candidateOutput(), { output_text: "{}" }),
  ]) {
    assertInvalidResponse(() => verifyOpenAiAutoExtractResponse(plan(), invalid));
  }

  const issuedPlan = plan();
  const forgedPlan = JSON.parse(
    JSON.stringify(issuedPlan),
  ) as OpenAiResponsesTransportPlan;
  assert.throws(
    () => verifyOpenAiAutoExtractResponse(forgedPlan, providerResponse()),
    (error: unknown) =>
      error instanceof AiRuntimeServiceError &&
      error.code === "AI_INVALID_OPERATION_KEY_INPUT",
  );
});

test("verifier does not invoke response or output array accessors", () => {
  let accessorRead = false;
  const responseWithAccessor = providerResponse();
  Object.defineProperty(responseWithAccessor, "status", {
    enumerable: true,
    get: () => {
      accessorRead = true;
      return "completed";
    },
  });
  assertInvalidResponse(() =>
    verifyOpenAiAutoExtractResponse(plan(), responseWithAccessor),
  );
  assert.equal(accessorRead, false);

  const outputWithAccessor: unknown[] = [];
  Object.defineProperty(outputWithAccessor, "0", {
    enumerable: true,
    get: () => {
      accessorRead = true;
      return { type: "message" };
    },
  });
  outputWithAccessor.length = 1;
  assertInvalidResponse(() =>
    verifyOpenAiAutoExtractResponse(
      plan(),
      providerResponse(candidateOutput(), { output: outputWithAccessor }),
    ),
  );
  assert.equal(accessorRead, false);
});

test("verifier module has no transport, credential access or logging", () => {
  const source = readFileSync(
    join(process.cwd(), "src/lib/ai-runtime/openai-responses-output.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /\bfetch\s*\(|\baxios\b|from\s+["']openai["']/i);
  assert.doesNotMatch(
    source,
    /process\.env|authorization|api[-_]?key|bearer\s|console\.|logger\./i,
  );
});
