import assert from "node:assert/strict";
import test from "node:test";
import { safeErrorPresentation, safeResponseError } from "../src/lib/safe-error-presentation";

test("referenced source deletion explains the retained source without advising retries", () => {
  const result = safeErrorPresentation({ error: { code: "SOURCE_IN_USE", message: "private references" } }, "资料删除失败");
  assert.match(result.summary, /项目记录引用/u);
  assert.match(result.nextStep, /保留该资料/u);
  assert.doesNotMatch(result.message, /刷新|重试|private references/u);
});

test("upload failures distinguish unsupported format, damaged content and size limits", () => {
  for (const [code, reason] of [
    ["ASSET_FILE_TYPE_UNSUPPORTED", /文件扩展名/u],
    ["ASSET_FILE_SIGNATURE_INVALID", /实际内容不一致/u],
    ["ASSET_FILE_TOO_LARGE", /大小限制/u],
    ["ASSET_DOCUMENT_TOO_LARGE", /页数或解析内容/u],
    ["ASSET_ARCHIVE_ENCRYPTED", /带密码/u],
    ["ASSET_ARCHIVE_UNSAFE_PATH", /内部路径/u],
  ] as const) {
    const result = safeErrorPresentation({ error: { code, message: "private file internals" } }, "上传失败");
    assert.equal(result.code, code);
    assert.match(result.summary, reason);
    assert.doesNotMatch(result.message, /private file internals/u);
  }
});

test("safe error presentation maps known codes to one actionable next step", () => {
  const result = safeErrorPresentation({ error: { code: "ACCESS_FORBIDDEN", message: "private stack and tenant details" } }, "加载失败");
  assert.equal(result.code, "ACCESS_FORBIDDEN");
  assert.match(result.message, /当前账号没有/u);
  assert.match(result.message, /下一步：/u);
  assert.doesNotMatch(result.message, /private stack|tenant details/u);
});

test("safe error presentation keeps stable conflict semantics without trusting server prose", () => {
  const result = safeErrorPresentation({ error: { code: "PROJECT_PLAN_WRITE_CONFLICT", message: "secret" } }, "保存失败");
  assert.match(result.message, /页面状态已变化/u);
  assert.match(result.message, /刷新最新状态/u);
  assert.doesNotMatch(result.message, /secret/u);
});

test("unknown and malformed payloads use the caller fallback", async () => {
  assert.equal(safeErrorPresentation({ error: { code: "bad-code", message: "unsafe" } }, "任务加载失败").code, null);
  assert.equal(safeErrorPresentation({ error: { code: "INTERNAL_DATABASE_PASSWORD_LEAK", message: "unsafe" } }, "任务加载失败").code, null);
  const response = new Response("not-json", { status: 500 });
  const result = await safeResponseError(response, "任务加载失败");
  assert.equal(result.summary, "任务加载失败");
  assert.match(result.nextStep, /刷新页面后重试/u);
});

test("membership preview recovery retains only its two stable failure codes", async () => {
  for (const code of ["MEMBERSHIP_APPLICATION_PREVIEW_EXPIRED", "MEMBERSHIP_APPLICATION_PREVIEW_STALE"]) {
    const result = await safeResponseError(new Response(JSON.stringify({ error: { code, message: "private database detail" } }), { status: 409 }), "申请预览失败");
    assert.equal(result.code, code);
    assert.doesNotMatch(result.message, /private database/u);
  }
});

test("provider probe failures explain each reviewed cause without exposing provider prose", () => {
  for (const [suffix, reason] of [
    ["BUDGET_REQUIRED", /没有生效.*已过期/u],
    ["BUDGET_EXHAUSTED", /额度不足/u],
    ["PROVIDER_AUTH_FAILED", /凭据无效或权限不足/u],
    ["PROVIDER_RATE_LIMITED", /限流或配额不足/u],
    ["PROVIDER_REJECTED", /拒绝/u],
    ["PROVIDER_TIMEOUT", /超时/u],
    ["PROVIDER_UNAVAILABLE", /不可用/u],
    ["PROVIDER_INVALID_RESPONSE", /无法验证/u],
    ["PROVIDER_RESPONSE_TOO_LARGE", /超过.*限制/u],
    ["PROVIDER_EMBEDDING_UNSUPPORTED", /不支持.*向量/u],
    ["PROVIDER_VISION_UNSUPPORTED", /不支持.*协议/u],
    ["RECONCILIATION_REQUIRED", /未知/u],
    ["RECONCILIATION_HOLD", /待核对/u],
  ] as const) {
    const code = `PLATFORM_PROVIDER_PROBE_${suffix}`;
    const result = safeErrorPresentation({ error: { code, message: "secret=private-provider-key" } }, "供应商连接测试未通过");
    assert.equal(result.code, code);
    assert.match(result.summary, reason);
    assert.ok(result.nextStep.length > 0);
    assert.doesNotMatch(result.message, /private-provider-key|secret=/u);
    if (suffix.startsWith("RECONCILIATION_")) assert.match(result.nextStep, /先核对/u);
  }
});
