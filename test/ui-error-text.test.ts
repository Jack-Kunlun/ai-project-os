import assert from "node:assert/strict";
import test from "node:test";
import { translateUiErrorText } from "../src/lib/ui-error-text";
import { safeResponseError } from "../src/lib/safe-error-presentation";
import { englishUiMessages } from "../src/lib/ui-dictionary-source";

const messages = { "项目搜索失败": "Project search failed" };

test("provider failures retain their cause, recovery guidance and code in both languages", async () => {
  for (const suffix of ["BUDGET_REQUIRED", "BUDGET_EXHAUSTED", "PROVIDER_AUTH_FAILED", "PROVIDER_RATE_LIMITED", "PROVIDER_TIMEOUT", "PROVIDER_INVALID_RESPONSE", "PROVIDER_UNAVAILABLE", "PROVIDER_RESPONSE_TOO_LARGE", "PROVIDER_EMBEDDING_UNSUPPORTED", "PROVIDER_VISION_UNSUPPORTED", "RECONCILIATION_REQUIRED", "RECONCILIATION_HOLD"]) {
    const code = `PLATFORM_PROVIDER_PROBE_${suffix}`;
    const failure = await safeResponseError(new Response(JSON.stringify({ error: { code, message: "private-key" } })), "供应商连接测试失败");
    assert.ok(Object.hasOwn(englishUiMessages, failure.summary), failure.summary);
    assert.ok(Object.hasOwn(englishUiMessages, failure.nextStep), failure.nextStep);
    assert.equal(translateUiErrorText(failure.message, "zh-CN", englishUiMessages), failure.message);
    const english = translateUiErrorText(failure.message, "en", englishUiMessages);
    assert.match(english, new RegExp(code));
    assert.doesNotMatch(english, /\p{Script=Han}|private-key|current status/u);
  }
});

test("file upload guidance retains its reviewed reason and code in both languages", async () => {
  const error = await safeResponseError(new Response(JSON.stringify({ error: { code: "ASSET_FILE_SIGNATURE_INVALID", message: "private file internals" } }), { status: 422 }), "上传失败");
  assert.match(translateUiErrorText(error.message, "zh-CN", englishUiMessages), /实际内容不一致.*ASSET_FILE_SIGNATURE_INVALID/u);
  const english = translateUiErrorText(error.message, "en", englishUiMessages);
  assert.match(english, /contents do not match.*ASSET_FILE_SIGNATURE_INVALID/u);
  assert.doesNotMatch(english, /\p{Script=Han}|private file internals/u);
});

test("referenced source deletion retains safe guidance in both languages", async () => {
  const error = await safeResponseError(new Response(JSON.stringify({ error: { code: "SOURCE_IN_USE", message: "private reference details" } }), { status: 409 }), "资料删除失败");
  const chinese = translateUiErrorText(error.message, "zh-CN", englishUiMessages);
  assert.match(chinese, /原始资料已被项目记录引用.*保留该资料以便追溯.*SOURCE_IN_USE/u);
  assert.doesNotMatch(chinese, /private reference details/u);
  const english = translateUiErrorText(error.message, "en", englishUiMessages);
  assert.match(english, /referenced by project records.*Keep this source for traceability.*SOURCE_IN_USE/u);
  assert.doesNotMatch(english, /\p{Script=Han}|private reference details/u);
});

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


test("feedback SSR uses neutral copy before the interpreter loads in both languages", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { AppearanceProvider, UiErrorText, UiFeedbackText } = await import("../src/components/appearance-provider");
  for (const language of ["zh-CN", "en"] as const) {
    for (const component of [UiErrorText, UiFeedbackText]) {
      const markup = renderToStaticMarkup(createElement(AppearanceProvider, { initialLanguage: language, initialMessages: messages, children: createElement(component, { text: "内部错误 secret=private-value" }) }));
      assert.doesNotMatch(markup, /private-value|secret=|内部错误/u);
      assert.match(markup, language === "en" ? /current status/iu : /当前状态/u);
      if (language === "en") assert.doesNotMatch(markup, /\p{Script=Han}/u);
    }
  }
});

test("project lifecycle conflicts retain actionable reviewed guidance in both languages", () => {
  for (const text of [
    "项目仍有运行中或待人工收口的任务，暂不能归档或永久删除",
    "项目仍有上传请求或文件解析租约，请稍后再删除",
    "项目仍有待审批或已批准的 MCP 动作，请先取消或完成处理",
    "项目状态已变化，请刷新后重试",
  ]) {
    assert.ok(englishUiMessages[text]);
    assert.equal(translateUiErrorText(text, "zh-CN", englishUiMessages), text);
    assert.equal(translateUiErrorText(text, "en", englishUiMessages), englishUiMessages[text]);
  }
});
