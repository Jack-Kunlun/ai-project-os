import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  OPENAI_AUTO_EXTRACT_MODEL_ID,
  OPENAI_EMBEDDING_DIMENSIONS,
  OPENAI_EMBEDDING_MODEL_ID,
  OPENAI_GENERATE_WITH_CONTEXT_MODEL_ID,
  OPENAI_PROJECT_ANALYSIS_MODEL_ID,
  OPENAI_SOURCE_SUMMARY_MODEL_ID,
  buildOpenAiAutoExtractTransportPlan,
  buildOpenAiEmbeddingsTransportPlan,
  getOpenAiAutoExtractProfile,
  getOpenAiEmbeddingProfile,
  getOpenAiGenerateWithContextProfile,
  getOpenAiProjectAnalysisProfile,
  getOpenAiSourceSummaryProfile,
} from "@/lib/ai-runtime";

const runId = "a1111111-1111-4111-8111-111111111111";
const inputId = "b2222222-2222-4222-8222-222222222222";
const operationKey = "a".repeat(64);

test("server-owned profiles compile into both fixed provider plans", () => {
  const autoExtractProfile = getOpenAiAutoExtractProfile();
  const embeddingProfile = getOpenAiEmbeddingProfile();
  const generateWithContextProfile = getOpenAiGenerateWithContextProfile();
  const sourceSummaryProfile = getOpenAiSourceSummaryProfile();
  const projectAnalysisProfile = getOpenAiProjectAnalysisProfile();

  assert.equal(autoExtractProfile.modelId, OPENAI_AUTO_EXTRACT_MODEL_ID);
  assert.equal(embeddingProfile.modelId, OPENAI_EMBEDDING_MODEL_ID);
  assert.equal(
    generateWithContextProfile.modelId,
    OPENAI_GENERATE_WITH_CONTEXT_MODEL_ID,
  );
  assert.equal(embeddingProfile.dimensions, OPENAI_EMBEDDING_DIMENSIONS);
  assert.equal(sourceSummaryProfile.modelId, OPENAI_SOURCE_SUMMARY_MODEL_ID);
  assert.equal(projectAnalysisProfile.modelId, OPENAI_PROJECT_ANALYSIS_MODEL_ID);
  assert.doesNotMatch(autoExtractProfile.modelId, /latest/i);
  assert.doesNotMatch(embeddingProfile.modelId, /latest/i);
  assert.doesNotMatch(generateWithContextProfile.modelId, /latest/i);
  assert.doesNotMatch(sourceSummaryProfile.modelId, /latest/i);
  assert.doesNotMatch(projectAnalysisProfile.modelId, /latest/i);
  assert.equal(Object.isFrozen(autoExtractProfile), true);
  assert.equal(Object.isFrozen(embeddingProfile), true);
  assert.equal(Object.isFrozen(generateWithContextProfile), true);
  assert.equal(Object.isFrozen(sourceSummaryProfile), true);
  assert.equal(Object.isFrozen(projectAnalysisProfile), true);
  assert.notEqual(
    sourceSummaryProfile.profileFingerprint,
    projectAnalysisProfile.profileFingerprint,
  );

  const responsePlan = buildOpenAiAutoExtractTransportPlan(
    autoExtractProfile,
    {
      runId,
      operationKey,
      sources: [{ sourceId: inputId, content: "Owner is Cedar." }],
    },
  );
  const embeddingPlan = buildOpenAiEmbeddingsTransportPlan(
    embeddingProfile,
    {
      runId,
      operationKey,
      inputs: [{ inputId, content: "Owner is Cedar." }],
    },
  );
  assert.equal(responsePlan.body.model, OPENAI_AUTO_EXTRACT_MODEL_ID);
  assert.equal(embeddingPlan.body.model, OPENAI_EMBEDDING_MODEL_ID);
  assert.equal(
    embeddingPlan.body.dimensions,
    OPENAI_EMBEDDING_DIMENSIONS,
  );
});

test("profile module contains no environment, credential or transport access", () => {
  const source = readFileSync(
    join(process.cwd(), "src/lib/ai-runtime/openai-runtime-profile.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /process\.env|authorization|api[-_]?key|bearer\s|\bfetch\s*\(|console\.|logger\./i,
  );
});
