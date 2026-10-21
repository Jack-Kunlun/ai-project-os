import assert from "node:assert/strict";
import test from "node:test";
import { translateUiErrorText } from "../src/components/ui-error-text";
import { safeResponseError } from "../src/lib/safe-error-presentation";

const messages = { "项目搜索失败": "Project search failed" };

test("system errors preserve only reviewed dictionary messages in either language", () => {
  assert.equal(translateUiErrorText("项目搜索失败", "zh-CN", messages), "项目搜索失败");
  assert.equal(translateUiErrorText("项目搜索失败", "en", messages), "Project search failed");
  assert.equal(translateUiErrorText("Project search failed", "en", messages), "Project search failed");
  for (const language of ["zh-CN", "en"] as const) {
    for (const text of ["内部异常 secret=secret-value", "Internal failure secret=secret-value", "失败 下一步：联系管理员（错误代码：SECRET_VALUE）"]) {
      const result = translateUiErrorText(text, language, messages);
      assert.doesNotMatch(result, /secret|SECRET_VALUE|内部异常|Internal failure/u);
      if (language === "en") assert.doesNotMatch(result, /\p{Script=Han}/u);
    }
  }
});

test("validated API errors retain public guidance and whitelisted codes through legacy string state", async () => {
  const error = await safeResponseError(new Response(JSON.stringify({ error: { code: "ACCESS_FORBIDDEN", message: "secret=private-value" } })), "读取失败");
  const known = { [error.summary]: "Permission denied.", [error.nextStep]: "Ask an administrator to check access." };
  assert.equal(translateUiErrorText(error.message, "zh-CN", known), error.message);
  assert.match(translateUiErrorText(error.message, "en", known), /Permission denied.*ACCESS_FORBIDDEN/u);
  for (const language of ["zh-CN", "en"] as const) assert.doesNotMatch(translateUiErrorText(error.message, language, known), /secret|private-value/u);
  const unknown = await safeResponseError(new Response(JSON.stringify({ error: { code: "SECRET_VALUE", message: "private-value" } })), "读取失败");
  assert.doesNotMatch(translateUiErrorText(unknown.message, "en", {}), /SECRET_VALUE|private-value|\p{Script=Han}/u);
  assert.doesNotMatch(translateUiErrorText("unknown successful status", "en", {}, "status"), /not be completed/u);
});

test("caller fallbacks remain untrusted even when a response has a whitelisted code", async () => {
  for (const body of ["{}", "not-json", JSON.stringify({ error: { code: "AUTH_REQUIRED" } })]) {
    const error = await safeResponseError(new Response(body), "internal secret=private-value（错误代码：FAKE_SECRET）");
    for (const language of ["zh-CN", "en"] as const) {
      assert.doesNotMatch(translateUiErrorText(error.message, language, {}), /internal|private-value|FAKE_SECRET/u);
    }
  }
});
