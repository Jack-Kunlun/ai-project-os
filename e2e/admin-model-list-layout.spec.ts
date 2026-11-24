import { expectProviderDefaults } from "./support/provider-defaults";
import { expect, test } from "@playwright/test";
import { expectDialogStyleContract } from "./support/ui-style-contract";
import { expectR02NoHorizontalOverflow, signInR02Admin } from "./support/r02-admin-navigation";

const fixtureId = "00000000-0000-4000-8000-0000000000a1";
const fixtureName = "Browser model fixture";
const fixtureTimestamp = "2026-10-22T00:00:00.000Z";
const operations = ["embedding", "visionExtract", "autoExtract", "sourceSummary", "projectAnalysis", "generateWithContext"] as const;
const candidate = {
  providerConnectionId: fixtureId,
  providerName: fixtureName,
  providerKind: "openai",
  modelId: "gpt-4.1-mini",
  embeddingDimensions: 1536,
  maxOutputTokens: 2048,
};
const provider = {
  id: fixtureId,
  name: fixtureName,
  kind: "openai",
  baseUrl: "https://api.openai.com/v1",
  defaultGenerationModelId: "gpt-4.1-mini",
  defaultEmbeddingModelId: "text-embedding-3-small",
  defaultVisionModelId: "gpt-4.1-mini",
  embeddingDimensions: 1536,
  configurationVersion: 3,
  status: "verified",
  lastTestedAt: fixtureTimestamp,
  lastErrorCode: null,
  credential: { maskedSuffix: "••••fixture", rotatedAt: null, updatedAt: fixtureTimestamp },
  _count: { platformDefaultAiRoutes: 1 },
};
const catalog = [{
  kind: "openai",
  displayName: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  apiKeyLabel: "OpenAI API key",
  generationModelSuggestions: ["gpt-4.1-mini"],
  embeddingModelSuggestions: [{ id: "text-embedding-3-small", dimensions: 1536 }],
  visionModelSuggestions: ["gpt-4.1-mini"],
  supportsEmbeddings: true,
  supportsVision: true,
}];
const active = {
  id: "00000000-0000-4000-8000-0000000000a2",
  version: 1,
  providerConnectionId: fixtureId,
  modelId: "text-embedding-3-small",
  embeddingDimensions: 1536,
  maxOutputTokens: null,
  quotaMultiplierBps: 10_000,
  validatedAt: fixtureTimestamp,
};
const platformOperations = {
  operations: [...operations],
  candidates: Object.fromEntries(operations.map((operation) => [operation, {
    readiness: operation === "embedding" ? "ready" : "missing",
    active: operation === "embedding" ? active : null,
    candidates: [{ ...candidate, modelId: operation === "embedding" ? "text-embedding-3-small" : "gpt-4.1-mini", embeddingDimensions: operation === "embedding" ? 1536 : null, maxOutputTokens: operation === "embedding" ? null : 2048 }],
  }])),
};

test("destructive confirmation uses the same modal geometry inside the admin provider drawer", async ({ page }, testInfo) => {
  await signInR02Admin(page);
  await page.route("**/api/settings/providers", (route) => route.fulfill({ json: {
    providers: [{ ...provider, status: "disabled", _count: { platformDefaultAiRoutes: 0 } }], catalog,
  } }));
  await page.route("**/api/settings/platform-ai-operations", (route) => route.fulfill({ json: { operations, candidates: Object.fromEntries(operations.map((operation) => [operation, { readiness: "missing", active: null, candidates: [] }])) } }));
  const origin = new URL(page.url()).origin;
  for (const mode of [{ theme: "light", width: 1440 }, { theme: "dark", width: 390 }]) {
    await page.context().addCookies([{ name: "aipos-theme", value: mode.theme, url: origin }]);
    await page.setViewportSize({ width: mode.width, height: 844 });
    await page.goto("/admin/models");
    await page.getByRole("button", { name: "管理连接", exact: true }).click();
    await page.getByRole("button", { name: "永久删除", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `永久删除“${fixtureName}”？`, exact: true });
    await expect(dialog).toBeVisible();
    await expectDialogStyleContract(dialog, `admin confirmation ${mode.theme}`);
    if (mode.theme === "light") {
      const original = await dialog.getAttribute("style");
      try {
        await dialog.evaluate((element) => { element.style.borderRadius = "16px"; });
        await expect(expectDialogStyleContract(dialog, "legacy confirmation negative control")).rejects.toThrow();
      } finally {
        await dialog.evaluate((element, value) => value === null ? element.removeAttribute("style") : element.setAttribute("style", value), original);
      }
    }
    const confirm = dialog.getByRole("button", { name: "确认永久删除", exact: true });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole("textbox").fill(fixtureName);
    await expect(confirm).toBeEnabled();
    await expectR02NoHorizontalOverflow(page, `admin confirmation ${mode.width}`);
    await testInfo.attach(`admin-confirm-${mode.theme}-${mode.width}.png`, { body: await page.screenshot(), contentType: "image/png" });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "永久删除", exact: true })).toBeFocused();
  }
});

test("new provider tests display safe failure reasons and clear stale results", async ({ page }) => {
  await signInR02Admin(page);
  await page.route("**/api/settings/providers", (route) => route.fulfill({ json: { providers: [provider], catalog } }));
  await page.route("**/api/settings/platform-ai-operations", (route) => route.fulfill({ json: platformOperations }));
  let probeReply: { status: number; body: unknown } | null = null;
  let probeGate = Promise.resolve();
  await page.route("**/api/settings/providers/draft-probe", async (route) => {
    await probeGate;
    return probeReply === null ? route.abort("failed") : route.fulfill({ status: probeReply.status, json: probeReply.body });
  });
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([{ name: "aipos-language", value: "zh-CN", url: origin }]);
  await page.setViewportSize({ width: 390, height: 740 });
  await page.goto("/admin/models");
  await page.getByRole("button", { name: "新增供应商", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新增供应商", exact: true });
  await dialog.getByRole("combobox", { name: "供应商", exact: true }).selectOption("openai");
  await dialog.getByRole("textbox", { name: "OpenAI API key", exact: true }).fill("isolated-browser-fixture-key");
  const run = dialog.getByRole("button", { name: "测试连接", exact: true });
  const save = dialog.getByRole("button", { name: /^(?:保存连接|保存中…)$/u });
  for (const [suffix, reason] of [
    ["PROVIDER_AUTH_FAILED", "供应商凭据无效或权限不足"],
    ["PROVIDER_RATE_LIMITED", "供应商触发限流或配额不足"],
    ["PROVIDER_TIMEOUT", "供应商响应超时"],
    ["RECONCILIATION_REQUIRED", "连接测试结果未知，需要核对"],
    ["RECONCILED_NO_DISPATCH", "有模型测试未发出，连接验证未完成"],
  ]) {
    const code = `PLATFORM_PROVIDER_PROBE_${suffix}`;
    probeReply = { status: 200, body: { draftProbeId: null, attempt: { safeErrorCode: code } } };
    await run.click();
    const alert = dialog.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(reason);
    await expect(alert).toContainText(code);
    await expect(save).toBeDisabled();
  }
  probeReply = { status: 401, body: { error: { code: "PLATFORM_PROVIDER_PROBE_PROVIDER_AUTH_FAILED", message: "secret=private-provider-detail" } } };
  await run.click();
  await expect(dialog.getByRole("alert")).toContainText("供应商凭据无效或权限不足");
  await expect(dialog).not.toContainText("private-provider-detail");
  probeReply = { status: 400, body: { error: { code: "PLATFORM_PROVIDER_PROBE_INVALID_INPUT", message: "secret=private-validation-detail" } } };
  await run.click();
  await expect(dialog.getByRole("alert")).toContainText("提交的供应商配置未通过校验");
  await expect(dialog.getByRole("alert")).toContainText("PLATFORM_PROVIDER_PROBE_INVALID_INPUT");
  await expect(dialog).not.toContainText("private-validation-detail");
  probeReply = { status: 200, body: { draftProbeId: null, attempt: { safeErrorCode: "SECRET_INTERNAL_CODE" } } };
  await run.click();
  await expect(dialog.getByRole("alert")).toContainText("供应商连接测试未通过");
  await expect(dialog).not.toContainText("SECRET_INTERNAL_CODE");
  probeReply = { status: 200, body: {} };
  await run.click();
  await expect(dialog.getByRole("alert")).toContainText("供应商连接测试未通过");
  await expect(save).toBeDisabled();
  probeReply = null;
  await run.click();
  await expect(dialog.getByRole("alert")).toContainText("未能取得连接测试结果，请检查网络后重试");
  probeReply = { status: 200, body: { draftProbeId: fixtureId, expiresAt: new Date(Date.now() + 300_000).toISOString(), attempt: { safeErrorCode: null } } };
  let finishProbe!: () => void;
  probeGate = new Promise<void>((resolve) => { finishProbe = resolve; });
  await run.click();
  await expect(dialog.getByRole("textbox", { name: "连接名称", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("combobox", { name: "供应商", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("textbox", { name: "OpenAI API key", exact: true })).toBeDisabled();
  await expect(save).toBeDisabled();
  finishProbe();
  await expect(dialog.getByRole("status")).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText("测试通过");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(save).toBeEnabled();
  const badge = dialog.locator("header").getByText("测试通过", { exact: true });
  await expect(badge).toBeVisible();
  const footer = await dialog.locator("footer").boundingBox();
  const action = await save.boundingBox();
  expect(footer!.x + footer!.width - action!.x - action!.width).toBeLessThanOrEqual(32);
  const badgeColor = await badge.evaluate(el => getComputedStyle(el).color);
  const [red, green] = (badgeColor.match(/\d+/gu) ?? []).map(Number);
  expect(green).toBeGreaterThan(red);
  await dialog.getByLabel("连接名称", { exact: true }).fill("Change verified configuration");
  await expect(badge).toBeHidden();
  await expect(save).toBeDisabled();
  await run.click();
  await expect(save).toBeEnabled();
  await page.route("**/api/settings/providers", (route) => route.fulfill({ status: 409, json: { error: { code: "PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT", message: "secret=private-proof-detail" } } }));
  await save.click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText("连接配置或测试证明已变化或过期");
  await expect(dialog.getByRole("alert")).toContainText("PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT");
  await expect(dialog).not.toContainText("private-proof-detail");
  await expect(save).toBeDisabled();
  await dialog.getByLabel("连接名称", { exact: true }).fill("Changed after test");
  await expect(dialog.locator("header").getByRole("status")).toHaveText("");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(save).toBeDisabled();
  await expectR02NoHorizontalOverflow(page, "provider test feedback 390px");
});

test("admin models use inline capability selection and read-only provider drawers across narrow and desktop layouts", async ({ page }) => {
  await signInR02Admin(page);
  const mutationRequests: string[] = [];
  page.on("request", (request) => {
    if (["POST", "PATCH", "DELETE"].includes(request.method()) && new URL(request.url()).pathname.startsWith("/api/")) {
      mutationRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  await page.route("**/api/settings/providers", async (route) => {
    if (route.request().method() !== "GET") return route.abort();
    return route.fulfill({ json: { providers: [provider], catalog } });
  });
  await page.route("**/api/settings/platform-ai-operations", async (route) => {
    if (route.request().method() !== "GET") return route.abort();
    return route.fulfill({ json: platformOperations });
  });

  const origin = new URL(page.url()).origin;
  await page.context().addCookies([
    { name: "aipos-language", value: "en", url: origin },
    { name: "aipos-theme", value: "dark", url: origin },
  ]);

  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/models");
    await expect(page.getByRole("heading", { name: "Models & capabilities", exact: true })).toBeVisible();
    const providerTable = page.getByRole("table", { name: "Provider connections", exact: true });
    const providerRow = providerTable.getByRole("row").filter({ hasText: fixtureName });
    await expect(page.getByText("1 provider", { exact: true })).toBeVisible();
    await expect(providerRow).toContainText("gpt-4.1-mini");
    const configuredModelCount = providerRow.getByRole("cell").nth(2);
    await expect(configuredModelCount.getByText("2 models", { exact: true })).toBeVisible();
    await expect(configuredModelCount).toContainText("gpt-4.1-mini · text-embedding-3-small");
    await expect(configuredModelCount).not.toContainText("projects");
    await expect(providerRow.getByRole("button", { name: "Manage connection", exact: true })).toBeVisible();
    const embeddingRow = page.locator('[data-operation="embedding"]');
    await expect(embeddingRow).toContainText(fixtureName);
    await expect(embeddingRow).toContainText("text-embedding-3-small");
    await expectR02NoHorizontalOverflow(page, `admin models en-dark ${width}`);

    const manage = providerRow.getByRole("button", { name: "Manage connection", exact: true });
    await manage.click();
    const providerDrawer = page.getByRole("dialog", { name: `${fixtureName} · Provider connections`, exact: true });
    await expect(providerDrawer).toBeVisible();
    const providerModelDetails = providerDrawer.locator("dl").nth(1);
    await expect(providerModelDetails.getByText("Generation model", { exact: true })).toBeVisible();
    await expect(providerModelDetails.getByText("Image recognition", { exact: true })).toBeVisible();
    await expect(providerModelDetails.getByText("Embedding model", { exact: true })).toBeVisible();
    await expectR02NoHorizontalOverflow(page, `provider drawer en-dark ${width}`);
    await providerDrawer.getByRole("button", { name: "Edit", exact: true }).click();
    const editDialog = page.getByRole("dialog", { name: `Edit provider: ${fixtureName}`, exact: true });
    const connectionName = editDialog.getByRole("textbox", { name: "Connection name", exact: true });
    await connectionName.fill("Unsaved provider draft");
    await editDialog.getByRole("button", { name: "Close dialog", exact: true }).click();
    await expect(providerDrawer).toBeVisible();
    await providerDrawer.getByRole("button", { name: "Close dialog", exact: true }).click();
    await expect(manage).toBeFocused();

    await manage.click();
    const reopenedProviderDrawer = page.getByRole("dialog", { name: `${fixtureName} · Provider connections`, exact: true });
    await reopenedProviderDrawer.getByRole("button", { name: "Edit", exact: true }).click();
    const reopenedEditDialog = page.getByRole("dialog", { name: `Edit provider: ${fixtureName}`, exact: true });
    await expect(reopenedEditDialog.getByRole("textbox", { name: "Connection name", exact: true })).toHaveValue("Unsaved provider draft");
    await reopenedEditDialog.getByRole("button", { name: "Close dialog", exact: true }).click();
    await reopenedProviderDrawer.getByRole("button", { name: "Close dialog", exact: true }).click();

    await expect(embeddingRow.getByRole("combobox")).toBeVisible();
    await expect(embeddingRow.getByRole("checkbox")).not.toBeChecked();
    await page.getByRole("button", { name: "Select all", exact: true }).click();
    await expect(embeddingRow.getByRole("checkbox")).toBeChecked();
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(embeddingRow.getByRole("checkbox")).not.toBeChecked();
    await expect(page.getByRole("button", { name: "Test and enable selected", exact: true })).toBeDisabled();
    await expectR02NoHorizontalOverflow(page, `inline capabilities en-dark ${width}`);
  }

  for (const [width, height] of [[1440, 900], [390, 480]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto("/admin/models");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const addProvider = page.getByRole("button", { name: "Add provider", exact: true }).first();
    await expect(addProvider).toBeVisible();
    await addProvider.click();

    const createDialog = page.getByRole("dialog", { name: "Add provider", exact: true });
    await expect(createDialog).toBeVisible();
    const dialogGeometry = await createDialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const heading = element.querySelector("h2");
      const style = getComputedStyle(element);
      return {
        left: rect.left,
        right: rect.right,
        width: rect.width,
        borderRadius: style.borderRadius,
        headingFontSize: heading ? getComputedStyle(heading).fontSize : null,
      };
    });
    expect(dialogGeometry.width).toBeLessThanOrEqual(920);
    expect(dialogGeometry.left).toBeGreaterThanOrEqual(0);
    expect(dialogGeometry.right).toBeLessThanOrEqual(width);
    expect(dialogGeometry.borderRadius).toBe("6px");
    expect(dialogGeometry.headingFontSize).toBe("16px");
    await expectR02NoHorizontalOverflow(page, `add provider dialog en-dark ${width}`);

    if (width === 390) {
      const scrollRegion = createDialog.locator("form > div").first();
      const scrollMetrics = await scrollRegion.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        overflowY: getComputedStyle(element).overflowY,
      }));
      expect(scrollMetrics.overflowY).toBe("auto");
      expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
      await scrollRegion.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      expect(await scrollRegion.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    }

    await createDialog.getByRole("button", { name: "Close add provider", exact: true }).click();
    await expect(createDialog).not.toBeVisible();
    await expect(addProvider).toBeFocused();
  }

  expect(mutationRequests, "opening and closing drawers must not test or change provider settings").toEqual([]);
});

for (const uncertain of [false, true]) {
  test(`capability batch confirms once and ${uncertain ? "stops after an uncertain test" : "enables each successful item immediately"}`, async ({ page }) => {
    await signInR02Admin(page);
    const origin = new URL(page.url()).origin;
    await page.context().addCookies([{ name: "aipos-language", value: "en", url: origin }]);
    const calls: string[] = [];
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/admin/platform-provider-probe/budget") calls.push("obsolete allowance request"); });
    const bodies = new Map<string, { clientRequestKey: string; modelId: string }>();
    await page.route("**/api/settings/providers", (route) => route.fulfill({ json: { providers: [provider], catalog } }));
    await page.route("**/api/settings/platform-ai-operations", (route) => route.fulfill({ json: platformOperations }));
    await page.route("**/api/settings/platform-ai-operations/*/probe", async (route) => {
      const operation = new URL(route.request().url()).pathname.split("/").at(-2)!;
      const body = route.request().postDataJSON();
      bodies.set(operation, body);
      calls.push(`probe:${operation}`);
      expect(body).not.toHaveProperty("providerName");
      expect(body).not.toHaveProperty("providerKind");
      expect(body.modelId).toBe(operation === "embedding" ? "text-embedding-3-small" : "gpt-4.1-mini");
      expect(body.embeddingDimensions).toBe(operation === "embedding" ? 1536 : null);
      expect(body.maxOutputTokens).toBe(operation === "embedding" ? null : 2048);
      return route.fulfill({ json: uncertain && operation === "autoExtract"
        ? { status: "held", probeId: null, expiresAt: null, safeErrorCode: "PLATFORM_PROVIDER_PROBE_RECONCILIATION_HOLD" }
        : { status: "settled", probeId: `proof-${operation}`, expiresAt: new Date(Date.now() + 300_000).toISOString(), safeErrorCode: null } });
    });
    await page.route("**/api/settings/platform-ai-operations/*/apply", async (route) => {
      const operation = new URL(route.request().url()).pathname.split("/").at(-2)!;
      const body = route.request().postDataJSON();
      calls.push(`apply:${operation}`);
      expect(body.clientRequestKey).toBe(bodies.get(operation)?.clientRequestKey);
      expect(body.modelId).toBe(bodies.get(operation)?.modelId);
      expect(body.probeId).toBe(`proof-${operation}`);
      expect(body).not.toHaveProperty("expiresAt");
      return route.fulfill({ json: { route: { status: "active" } } });
    });
    await page.goto("/admin/models");
    await expect(page.locator('[data-operation="embedding"]').getByRole("combobox")).toBeVisible();
    await page.getByRole("button", { name: "Select all", exact: true }).click();
    await page.getByRole("button", { name: "Test and enable selected", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Confirm model batch", exact: true });
    await expect(confirmation).toBeVisible();
    expect(calls).toEqual([]);
    await confirmation.getByRole("button", { name: "Confirm test and enable", exact: true }).evaluate((element) => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
    await expect(page.getByRole("dialog", { name: "Batch results", exact: true })).toBeVisible();
    expect(calls).toEqual(uncertain
      ? ["probe:embedding", "apply:embedding", "probe:visionExtract", "apply:visionExtract", "probe:autoExtract"]
      : operations.flatMap((operation) => [`probe:${operation}`, `apply:${operation}`]));
    expect(new Set([...bodies.values()].map((body) => body.clientRequestKey)).size).toBe(bodies.size);
  });
}

test("admin model defaults and scrolling work at desktop and mobile viewport sizes", async ({ page }, testInfo) => {
  await signInR02Admin(page);
  for (const viewport of [{ width: 1680, height: 970 }, { width: 390, height: 740 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/admin/models");
    await page.getByRole("button", { name: "新增供应商", exact: true }).first().click();
    const form = page.getByRole("dialog", { name: "新增供应商", exact: true });
    await expectProviderDefaults(form, false);
    const generation = form.getByLabel("生成模型（可选）", { exact: true });
    await generation.focus();
    await generation.scrollIntoViewIfNeeded();
    if (page.context().browser()?.browserType().name() === "chromium") {
      const session = await page.context().newCDPSession(page);
      try {
        const box = await generation.boundingBox();
        if (!box) throw new Error("Generation model input has no visible bounds");
        const hit = await session.send("DOM.getNodeForLocation", {
          x: Math.round(box.x + box.width - 20),
          y: Math.round(box.y + box.height / 2),
          includeUserAgentShadowDOM: true,
        });
        const { node } = await session.send("DOM.describeNode", { backendNodeId: hit.backendNodeId });
        expect(node.attributes).toContain("-webkit-calendar-picker-indicator");
      } finally {
        await session.detach();
      }
    }
    await expect(form.getByRole("button", { name: "保存连接", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(form).toBeHidden();
    const body = page.locator("main.admin-page-scroll");
    const geometry = await body.evaluate(el => {
      el.scrollTop = el.scrollHeight;
      return { documentHeight: document.documentElement.scrollHeight, viewport: innerHeight, documentOffset: scrollY,
        bottom: Math.round(el.getBoundingClientRect().bottom), scrolled: el.scrollTop, content: el.scrollHeight, available: el.clientHeight };
    });
    expect(geometry.documentHeight).toBe(geometry.viewport);
    expect(geometry.documentOffset).toBe(0);
    expect(geometry.bottom).toBe(geometry.viewport);
    expect(geometry.scrolled).toBeGreaterThanOrEqual(geometry.content - geometry.available - 1);
    await testInfo.attach(`model-page-scroll-${viewport.width}.json`, { body: JSON.stringify(geometry), contentType: "application/json" });
  }
});
