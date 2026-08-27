import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  buildGroundedRagPlan,
  compileOpenAiGroundedRagPlan,
  verifyOpenAiGroundedRagPlanResponse,
} from "@/lib/ai-memory";
import {
  AiRuntimeServiceError,
  OPENAI_GENERATE_WITH_CONTEXT_MODEL_ID,
  buildOpenAiGroundedRagTransportPlan,
  getOpenAiGenerateWithContextProfile,
  inspectOpenAiGroundedRagResponse,
  verifyOpenAiGroundedRagResponse,
  type OpenAiGroundedRagRequest,
  type OpenAiGroundedRagTransportPlan,
} from "@/lib/ai-runtime";
import { getIssuedOpenAiGroundedRagPlanRequest } from "@/lib/ai-runtime/openai-grounded-rag-contract";

const runId = "a1111111-1111-4111-8111-111111111111";
const projectId = "b2222222-2222-4222-8222-222222222222";
const snapshotId = "c3333333-3333-4333-8333-333333333333";
const sourceAId = "d4444444-4444-4444-8444-444444444441";
const sourceBId = "d4444444-4444-4444-8444-444444444442";
const chunkAId = "e5555555-5555-4555-8555-555555555551";
const chunkBId = "e5555555-5555-4555-8555-555555555552";
const operationKey = "a".repeat(64);
const snapshotManifestFingerprint = "b".repeat(64);
const contextFingerprint = "c".repeat(64);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function request(
  overrides: Partial<OpenAiGroundedRagRequest> = {},
): OpenAiGroundedRagRequest {
  const contentA = "项目周报：当前风险是测试数据不足。";
  const contentB = "风险复核：当前风险是接口契约未冻结。";
  return {
    runId,
    operationKey,
    projectId,
    snapshotId,
    snapshotManifestFingerprint,
    contextFingerprint,
    question: "当前风险是什么？",
    contexts: [
      {
        citationKey: "c1",
        sourceId: sourceAId,
        chunkId: chunkAId,
        sourceKind: "manual",
        externalRef: null,
        contentHash: sha256(contentA),
        contentText: contentA,
        rangeUnit: "utf8_byte",
        rangeStart: 0,
        rangeEnd: Buffer.byteLength(contentA, "utf8"),
      },
      {
        citationKey: "c2",
        sourceId: sourceBId,
        chunkId: chunkBId,
        sourceKind: "document",
        externalRef: "docs/risk.md",
        contentHash: sha256(contentB),
        contentText: contentB,
        rangeUnit: "utf8_byte",
        rangeStart: 10,
        rangeEnd: 10 + Buffer.byteLength(contentB, "utf8"),
      },
    ],
    ...overrides,
  };
}

function plan(
  requestOverrides: Partial<OpenAiGroundedRagRequest> = {},
): OpenAiGroundedRagTransportPlan {
  return buildOpenAiGroundedRagTransportPlan(
    getOpenAiGenerateWithContextProfile(),
    request(requestOverrides),
  );
}

function rawResponse(
  compiled: OpenAiGroundedRagTransportPlan,
  output: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const outputText = JSON.stringify(output);
  return {
    id: "resp_grounded_rag_123",
    object: "response",
    model: compiled.body.model,
    status: "completed",
    store: false,
    tool_choice: "none",
    parallel_tool_calls: false,
    tools: [],
    metadata: compiled.body.metadata,
    error: null,
    incomplete_details: null,
    usage: { input_tokens: 120, output_tokens: 40, total_tokens: 160 },
    output: [{
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: outputText }],
    }],
    output_text: outputText,
    ...overrides,
  };
}

test("grounded RAG compiler produces one fixed no-tools request bound to the snapshot", () => {
  const compiled = plan();
  assert.equal(compiled.operation, "generateWithContext");
  assert.equal(compiled.body.model, OPENAI_GENERATE_WITH_CONTEXT_MODEL_ID);
  assert.equal(compiled.endpoint, "https://api.openai.com/v1/responses");
  assert.equal(compiled.maximumAttempts, 1);
  assert.equal(compiled.automaticRetry, false);
  assert.equal(compiled.body.store, false);
  assert.deepEqual(compiled.body.tools, []);
  assert.equal(compiled.body.tool_choice, "none");
  assert.equal(compiled.body.parallel_tool_calls, false);
  assert.equal(Object.isFrozen(compiled), true);
  assert.equal(Object.isFrozen(compiled.body), true);

  const canonical = JSON.parse(compiled.body.input[0].content[0].text) as {
    operation: string;
    snapshotId: string;
    contextFingerprint: string;
    contexts: Array<{ citationKey: string; contentText: string }>;
  };
  assert.equal(canonical.operation, "generateWithContext");
  assert.equal(canonical.snapshotId, snapshotId);
  assert.equal(canonical.contextFingerprint, contextFingerprint);
  assert.deepEqual(canonical.contexts.map((context) => context.citationKey), ["c1", "c2"]);
  assert.equal(canonical.contexts[0]?.contentText, request().contexts[0]?.contentText);
  assert.deepEqual(getIssuedOpenAiGroundedRagPlanRequest(compiled), request());
  assert.equal(
    getIssuedOpenAiGroundedRagPlanRequest(JSON.parse(JSON.stringify(compiled))),
    null,
  );
});

test("grounded RAG compiler rejects profile, provenance and request expansion", () => {
  const profile = getOpenAiGenerateWithContextProfile();
  const base = request();
  const invalid: Array<[unknown, unknown]> = [
    [{ ...profile, modelId: "different-model" }, base],
    [profile, { ...base, extra: true }],
    [profile, {
      ...base,
      contexts: [{ ...base.contexts[0]!, citationKey: "c2" }],
    }],
    [profile, {
      ...base,
      contexts: [{ ...base.contexts[0]!, contentHash: "d".repeat(64) }],
    }],
    [profile, {
      ...base,
      contexts: [base.contexts[0], { ...base.contexts[0]!, citationKey: "c2" }],
    }],
    [profile, {
      ...base,
      contexts: [{ ...base.contexts[0]!, externalRef: " bad" }],
    }],
  ];
  for (const [rawProfile, rawRequest] of invalid) {
    assert.throws(
      () => buildOpenAiGroundedRagTransportPlan(rawProfile, rawRequest),
      (error: unknown) =>
        error instanceof AiRuntimeServiceError &&
        error.code === "AI_INVALID_OPERATION_KEY_INPUT",
    );
  }
});

test("provider output is normalized only after exact answer, conflict or refusal checks", () => {
  const compiled = plan();
  const answer = verifyOpenAiGroundedRagResponse(compiled, rawResponse(compiled, {
    kind: "answer",
    claims: [{
      text: "当前风险是测试数据不足",
      citations: [{ citationKey: "c1", excerpt: "当前风险是测试数据不足" }],
    }],
    conflicts: [],
    reasonCode: null,
  }));
  assert.deepEqual(answer.output, {
    kind: "answer",
    claims: [{
      text: "当前风险是测试数据不足",
      citations: [{ citationKey: "c1", excerpt: "当前风险是测试数据不足" }],
    }],
  });
  assert.equal(answer.usage.requestCount, 1);
  assert.match(answer.outputFingerprint, /^[0-9a-f]{64}$/);

  const conflict = verifyOpenAiGroundedRagResponse(compiled, rawResponse(compiled, {
    kind: "conflict",
    claims: [],
    conflicts: [{
      factKey: "current.risk",
      left: {
        text: "当前风险是测试数据不足",
        citations: [{ citationKey: "c1", excerpt: "当前风险是测试数据不足" }],
      },
      right: {
        text: "当前风险是接口契约未冻结",
        citations: [{ citationKey: "c2", excerpt: "当前风险是接口契约未冻结" }],
      },
    }],
    reasonCode: null,
  }));
  assert.equal(conflict.output.kind, "conflict");

  const refusal = verifyOpenAiGroundedRagResponse(compiled, rawResponse(compiled, {
    kind: "refusal",
    claims: [],
    conflicts: [],
    reasonCode: "INSUFFICIENT_EVIDENCE",
  }));
  assert.deepEqual(refusal.output, {
    kind: "refusal",
    reasonCode: "INSUFFICIENT_EVIDENCE",
  });
});

test("issued project evidence compiles and verifies end to end without transport", () => {
  const source = request().contexts[0]!;
  const grounded = buildGroundedRagPlan({
    projectId,
    snapshotId,
    snapshotManifestFingerprint,
    question: "当前风险是什么？",
    contexts: [{
      projectId,
      sourceId: source.sourceId,
      chunkId: source.chunkId,
      sourceKind: source.sourceKind,
      externalRef: source.externalRef,
      contentHash: source.contentHash,
      contentText: source.contentText,
      rangeUnit: source.rangeUnit,
      rangeStart: source.rangeStart,
      rangeEnd: source.rangeEnd,
    }],
  });
  const compiled = compileOpenAiGroundedRagPlan(grounded, { runId, operationKey });
  const verified = verifyOpenAiGroundedRagPlanResponse(
    grounded,
    compiled,
    rawResponse(compiled, {
      kind: "answer",
      claims: [{
        text: "当前风险是测试数据不足",
        citations: [{ citationKey: "c1", excerpt: "当前风险是测试数据不足" }],
      }],
      conflicts: [],
      reasonCode: null,
    }),
  );
  assert.equal(verified.result.kind, "answer");
  if (verified.result.kind === "answer") {
    assert.equal(verified.result.claims[0]?.citations[0]?.sourceId, sourceAId);
  }
});

test("provider output rejects unsupported claims, forged plans, tools and metadata drift", () => {
  const compiled = plan();
  const invalidOutputs = [
    {
      kind: "answer",
      claims: [{
        text: "负责人是岚",
        citations: [{ citationKey: "c1", excerpt: "当前风险是测试数据不足" }],
      }],
      conflicts: [],
      reasonCode: null,
    },
    {
      kind: "answer",
      claims: [{
        text: "当前风险",
        citations: [{ citationKey: "missing", excerpt: "当前风险" }],
      }],
      conflicts: [],
      reasonCode: null,
    },
    {
      kind: "refusal",
      claims: [],
      conflicts: [],
      reasonCode: "INSUFFICIENT_EVIDENCE",
      tool: "shell",
    },
  ];
  for (const output of invalidOutputs) {
    assert.throws(
      () => verifyOpenAiGroundedRagResponse(compiled, rawResponse(compiled, output)),
      (error: unknown) =>
        error instanceof AiRuntimeServiceError &&
        error.code === "AI_INVALID_PROVIDER_RESPONSE",
    );
  }

  assert.throws(
    () => verifyOpenAiGroundedRagResponse(
      { ...compiled },
      rawResponse(compiled, {
        kind: "refusal",
        claims: [],
        conflicts: [],
        reasonCode: "INSUFFICIENT_EVIDENCE",
      }),
    ),
    (error: unknown) =>
      error instanceof AiRuntimeServiceError &&
      error.code === "AI_INVALID_OPERATION_KEY_INPUT",
  );
  assert.throws(
    () => inspectOpenAiGroundedRagResponse(compiled, rawResponse(compiled, {
      kind: "refusal",
      claims: [],
      conflicts: [],
      reasonCode: "INSUFFICIENT_EVIDENCE",
    }, {
      metadata: { ...compiled.body.metadata, operation_key: "d".repeat(64) },
    })),
    (error: unknown) =>
      error instanceof AiRuntimeServiceError &&
      error.code === "AI_INVALID_PROVIDER_RESPONSE",
  );
  assert.throws(
    () => inspectOpenAiGroundedRagResponse(compiled, rawResponse(compiled, {
      kind: "refusal",
      claims: [],
      conflicts: [],
      reasonCode: "INSUFFICIENT_EVIDENCE",
    }, { tools: [{ type: "function" }] })),
    (error: unknown) =>
      error instanceof AiRuntimeServiceError &&
      error.code === "AI_INVALID_PROVIDER_RESPONSE",
  );
});

test("grounded RAG contract has no transport, credential or logging access", () => {
  for (const file of [
    "src/lib/ai-runtime/openai-grounded-rag-contract.ts",
    "src/lib/ai-runtime/openai-grounded-rag-output.ts",
  ]) {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    assert.doesNotMatch(
      source,
      /process\.env|authorization|api[-_]?key|bearer\s|\bfetch\s*\(|console\.|logger\./i,
    );
  }
});
