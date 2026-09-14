import assert from "node:assert/strict";
import test from "node:test";
import { safeErrorPresentation, safeResponseError } from "../src/lib/safe-error-presentation";

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
