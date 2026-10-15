import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@/lib/api-errors";
import { invokeVisionCompletion, ProviderTransportError } from "@/lib/ai-providers";
import { visionPageManifestHash } from "@/lib/personal-knowledge-extraction-consent";
import { parsePersonalKnowledgeVisionOutput } from "@/lib/personal-knowledge-vision";
import { personalVisionProviderVerified, type PersonalVisionProvider } from "@/lib/personal-knowledge-vision-provider";

test("visual extraction consent binds the selected PDF pages and ignores text-only pages", () => {
  const scanned = { ordinal: 1, pageNumber: 2, locatorLabel: "第 2 页", requiresVision: true };
  const textOnly = { ordinal: 0, pageNumber: 1, locatorLabel: "第 1 页", requiresVision: false };
  assert.equal(visionPageManifestHash([textOnly, scanned]), visionPageManifestHash([scanned]));
  assert.notEqual(visionPageManifestHash([scanned]), visionPageManifestHash([{ ...scanned, pageNumber: 3 }]));
  assert.notEqual(visionPageManifestHash([scanned]), visionPageManifestHash([{ ...scanned, requiresVision: false }]));
});

test("vision result keeps the source locator and extracted content", () => {
  assert.equal(
    parsePersonalKnowledgeVisionOutput('```json\n{"transcript":"发票编号 123","description":"表格"}\n```', "第 2 页"),
    "第 2 页\n文字识别：\n发票编号 123\n\n视觉描述：\n表格",
  );
});

test("vision result rejects empty, malformed and oversized content", () => {
  for (const raw of ["not JSON", '{}', '{"transcript":"","description":""}', JSON.stringify({ transcript: "x".repeat(20_001), description: "" })]) {
    assert.throws(
      () => parsePersonalKnowledgeVisionOutput(raw, "原始图片"),
      (error: unknown) => error instanceof ApiError && error.code === "PERSONAL_KNOWLEDGE_VISION_INVALID",
    );
  }
});

test("vision input rejected before transport is classified as not dispatched", async () => {
  await assert.rejects(() => invokeVisionCompletion({
    connection: { id: "test", kind: "deepseek", baseUrl: "https://api.deepseek.com", credentialId: "test", status: "verified" },
    modelId: "deepseek-flash", image: Buffer.alloc(0), mimeType: "image/png", prompt: "识别内容", maxOutputTokens: 64,
  }), (error: unknown) => error instanceof ProviderTransportError && error.requestDispatched === false);
});

test("only the two explicitly supported DeepSeek vision models qualify for personal vision", () => {
  const provider = {
    id: "provider", name: "DeepSeek", kind: "deepseek", scope: "platform", ownerUserId: null,
    protocol: "chatCompletions", baseUrl: "https://api.deepseek.com", credentialId: "credential",
    configurationVersion: 1, ownerAccountAccessVersion: null, status: "verified", disabledAt: null,
    defaultVisionModelId: "deepseek-flash", credential: { kind: "aiProvider", secretFingerprint: "a".repeat(64) },
  } satisfies PersonalVisionProvider;
  assert.equal(personalVisionProviderVerified(provider), true);
  assert.equal(personalVisionProviderVerified({ ...provider, defaultVisionModelId: "deepseek-v4-flash-vision-exp" }), true);
  assert.equal(personalVisionProviderVerified({ ...provider, defaultVisionModelId: "deepseek-v4-flash" }), false);
});

test("vision transport exposes only validated usage before rejecting malformed completion content", async () => {
  const previousFetch = globalThis.fetch;
  const observations: Array<{ inputTokens: number; outputTokens: number; usageKnown: boolean; providerRequestId: string | null }> = [];
  globalThis.fetch = async () => Response.json({ usage: { prompt_tokens: 13, completion_tokens: 2 }, choices: [] }, { headers: { "x-request-id": "request-test-1" } });
  try {
    await assert.rejects(() => invokeVisionCompletion({
      connection: { id: "test", kind: "openai", baseUrl: "https://provider.invalid/v1", credentialId: "test", status: "verified", apiKey: "synthetic-test-key" },
      modelId: "gpt-4o-mini", image: Buffer.from("image"), mimeType: "image/png", prompt: "识别文本", maxOutputTokens: 64,
      onUsage: (usage) => observations.push(usage),
    }), (error: unknown) => error instanceof ProviderTransportError && error.requestDispatched === true && error.responseReceived === true);
    assert.deepEqual(observations, [{ inputTokens: 13, outputTokens: 2, usageKnown: true, providerRequestId: "request-test-1" }]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("vision transport preserves validated usage when the response body arrives after the deadline", async () => {
  const previousFetch = globalThis.fetch;
  const observations: Array<{ inputTokens: number; outputTokens: number; usageKnown: boolean; providerRequestId: string | null }> = [];
  globalThis.fetch = async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return Response.json({ usage: { prompt_tokens: 13, completion_tokens: 2 }, choices: [{ message: { content: "ok" } }] }, { headers: { "x-request-id": "request-late-1" } });
  };
  try {
    await assert.rejects(() => invokeVisionCompletion({
      connection: { id: "test", kind: "openai", baseUrl: "https://provider.invalid/v1", credentialId: "test", status: "verified", apiKey: "synthetic-test-key" },
      modelId: "gpt-4o-mini", image: Buffer.from("image"), mimeType: "image/png", prompt: "识别文本", maxOutputTokens: 64,
      absoluteDeadlineAt: new Date(Date.now() + 100),
      onUsage: (usage) => observations.push(usage),
    }), (error: unknown) => error instanceof ProviderTransportError && error.code === "AI_PROVIDER_TIMEOUT" && error.requestDispatched === true && error.responseReceived === true);
    assert.deepEqual(observations, [{ inputTokens: 13, outputTokens: 2, usageKnown: true, providerRequestId: "request-late-1" }]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
