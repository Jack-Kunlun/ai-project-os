import assert from "node:assert/strict";
import test from "node:test";
import {
  AiRuntimeServiceError,
  FAKE_PROFILE,
  OPENAI_AUTO_EXTRACT_MAX_BUDGET_MICROS,
  OPENAI_AUTO_EXTRACT_MAX_INPUT_TOKENS,
  OPENAI_AUTO_EXTRACT_PRICING_SNAPSHOT_ID,
  calculateAiExecutionBudgetMicros,
  getOpenAiAutoExtractProfile,
  getOpenAiEmbeddingProfile,
  getSyntheticAiExecutionProfile,
  resolveAiExecutionProfile,
  scanLocalSourcesForModelTransfer,
} from "@/lib/ai-runtime";

const sourceAId = "11111111-1111-4111-8111-111111111111";
const sourceBId = "22222222-2222-4222-8222-222222222222";

function openAiAutoExtractBoundary() {
  const profile = getOpenAiAutoExtractProfile();
  return {
    profileFingerprint: profile.profileFingerprint,
    providerFingerprint: profile.providerFingerprint,
    modelFingerprint: profile.modelFingerprint,
    modelId: profile.modelId,
    regionFingerprint: profile.processorRegionFingerprint,
    retentionFingerprint: profile.processorRetentionFingerprint,
    endpointFingerprint: profile.processorEndpointFingerprint,
  };
}

function assertBudgetDenied(action: () => unknown): void {
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof AiRuntimeServiceError &&
      error.code === "AI_BUDGET_DENIED",
  );
}

test("auto extract resolves only the exact frozen OpenAI execution boundary", () => {
  const boundary = openAiAutoExtractBoundary();
  const profile = resolveAiExecutionProfile("autoExtract", boundary);
  assert.notEqual(profile, null);
  assert.equal(profile?.kind, "openaiAutoExtract");
  assert.equal(profile?.pricingSnapshotId, OPENAI_AUTO_EXTRACT_PRICING_SNAPSHOT_ID);
  assert.equal(profile?.maxInputTokens, OPENAI_AUTO_EXTRACT_MAX_INPUT_TOKENS);
  assert.equal(profile?.maxBudgetMicros, OPENAI_AUTO_EXTRACT_MAX_BUDGET_MICROS);
  assert.ok(Object.isFrozen(profile));

  for (const changedField of Object.keys(boundary) as Array<keyof typeof boundary>) {
    assert.equal(
      resolveAiExecutionProfile("autoExtract", {
        ...boundary,
        [changedField]: changedField === "modelId" ? "different-model" : "a".repeat(64),
      }),
      null,
      changedField,
    );
  }

  const embedding = getOpenAiEmbeddingProfile();
  assert.equal(
    resolveAiExecutionProfile("embedding", {
      profileFingerprint: embedding.profileFingerprint,
      providerFingerprint: embedding.providerFingerprint,
      modelFingerprint: embedding.modelFingerprint,
      modelId: embedding.modelId,
      regionFingerprint: embedding.processorRegionFingerprint,
      retentionFingerprint: embedding.processorRetentionFingerprint,
      endpointFingerprint: embedding.processorEndpointFingerprint,
    }),
    null,
  );
});

test("frozen token pricing rounds upward and enforces every budget ceiling", () => {
  const profile = resolveAiExecutionProfile(
    "autoExtract",
    openAiAutoExtractBoundary(),
  );
  assert.notEqual(profile, null);
  if (profile === null) throw new Error("profile must resolve");

  assert.equal(
    calculateAiExecutionBudgetMicros(profile, {
      inputBytes: 1,
      inputTokens: 1,
      outputTokens: 1,
    }),
    6,
  );
  assert.equal(
    calculateAiExecutionBudgetMicros(profile, {
      inputBytes: profile.maxInputBytes,
      inputTokens: profile.maxInputTokens,
      outputTokens: profile.maxOutputTokens,
    }),
    57_216,
  );
  assertBudgetDenied(() =>
    calculateAiExecutionBudgetMicros(profile, {
      inputBytes: profile.maxInputBytes + 1,
      inputTokens: 0,
      outputTokens: 0,
    }),
  );
  assertBudgetDenied(() =>
    calculateAiExecutionBudgetMicros(profile, {
      inputBytes: 1,
      inputTokens: profile.maxInputTokens + 1,
      outputTokens: 0,
    }),
  );
  assertBudgetDenied(() =>
    calculateAiExecutionBudgetMicros(profile, {
      inputBytes: 1,
      inputTokens: 0,
      outputTokens: profile.maxOutputTokens + 1,
    }),
  );

  const synthetic = getSyntheticAiExecutionProfile();
  assert.equal(synthetic.promptFingerprint, FAKE_PROFILE.promptFingerprint);
  assert.equal(
    calculateAiExecutionBudgetMicros(synthetic, {
      inputBytes: 12,
      inputTokens: 3,
      outputTokens: 4,
    }),
    140,
  );
});

test("local source scanning exposes only a stable passed or blocked result", () => {
  const safe = scanLocalSourcesForModelTransfer([
    { sourceId: sourceAId, content: "项目负责人是 Cedar。" },
    { sourceId: sourceBId, content: "状态：已完成本地验证。" },
  ]);
  assert.equal(safe.result, "passed");
  assert.deepEqual(Object.keys(safe).sort(), [
    "result",
    "scannerFingerprint",
    "scannerVersion",
  ]);
  assert.ok(Object.isFrozen(safe));

  const blockedContents = [
    `OPENAI_API_KEY=sk-${"a".repeat(30)}`,
    `GITHUB_TOKEN=ghp_${"b".repeat(24)}`,
    `GITHUB_TOKEN=github_pat_${"c".repeat(30)}`,
    "-----BEGIN PRIVATE KEY-----",
    "password=credential-value",
    "https://user:credential@example.invalid/path",
  ];
  for (const content of blockedContents) {
    const result = scanLocalSourcesForModelTransfer([{ sourceId: sourceAId, content }]);
    assert.equal(result.result, "blocked");
    assert.doesNotMatch(JSON.stringify(result), /credential|password|OPENAI|GITHUB/i);
  }

  assert.equal(
    scanLocalSourcesForModelTransfer([{
      sourceId: sourceAId,
      content: "apiKey = process.env.OPENAI_API_KEY",
    }]).result,
    "passed",
  );

  for (const invalid of [
    [],
    [
      { sourceId: sourceAId, content: "safe" },
      { sourceId: sourceAId, content: "duplicate" },
    ],
    [{ sourceId: sourceAId, content: "e\u0301" }],
    [{ sourceId: sourceAId, content: "\ud800" }],
    [{ sourceId: sourceAId, content: "safe", extra: true }],
  ]) {
    assert.equal(scanLocalSourcesForModelTransfer(invalid as never).result, "blocked");
  }
});
