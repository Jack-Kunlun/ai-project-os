import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "@/lib/api-errors";
import { invokeVisionCompletion, ProviderTransportError } from "@/lib/ai-providers";
import { visionPageManifestHash } from "@/lib/personal-knowledge-extraction-consent";
import { parsePersonalKnowledgeVisionOutput } from "@/lib/personal-knowledge-vision";

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
