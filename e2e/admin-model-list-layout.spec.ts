import { expect, test } from "@playwright/test";
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

test("new provider tests display safe failure reasons and clear stale results", async ({ page }) => {
  await signInR02Admin(page);
  await page.route("**/api/settings/providers", (route) => route.fulfill({ json: { providers: [provider], catalog } }));
  await page.route("**/api/admin/platform-provider-probe/budget", (route) => route.fulfill({ json: { budget: null } }));
  await page.route("**/api/settings/platform-ai-operations", (route) => route.fulfill({ json: platformOperations }));
  let probeReply: { status: number; body: unknown } | null = null;
  await page.route("**/api/settings/providers/draft-probe", (route) => probeReply === null
    ? route.abort("failed")
    : route.fulfill({ status: probeReply.status, json: probeReply.body }));
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([{ name: "aipos-language", value: "zh-CN", url: origin }]);
  await page.setViewportSize({ width: 390, height: 740 });
  await page.goto("/admin/models");
  await page.getByRole("button", { name: "新增供应商", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新增供应商", exact: true });
  await dialog.getByRole("combobox", { name: "供应商", exact: true }).selectOption("openai");
  await dialog.getByRole("textbox", { name: "OpenAI API key", exact: true }).fill("isolated-browser-fixture-key");
  const run = dialog.getByRole("button", { name: "测试连接", exact: true });
  const save = dialog.getByRole("button", { name: "保存连接", exact: true });
  for (const [suffix, reason] of [
    ["BUDGET_REQUIRED", "当前没有生效的模型测试额度"],
    ["BUDGET_EXHAUSTED", "平台连接测试额度不足"],
    ["PROVIDER_AUTH_FAILED", "供应商凭据无效或权限不足"],
    ["PROVIDER_RATE_LIMITED", "供应商触发限流或配额不足"],
    ["PROVIDER_TIMEOUT", "供应商响应超时"],
    ["RECONCILIATION_REQUIRED", "连接测试结果未知，需要核对"],
  ]) {
    const code = `PLATFORM_PROVIDER_PROBE_${suffix}`;
    probeReply = { status: 200, body: { draftProbeId: null, attempt: { safeErrorCode: code } } };
    await run.click();
    const alert = dialog.getByRole("alert");
    await expect(alert).toContainText(reason);
    await expect(alert).toContainText(code);
    await expect(save).toBeDisabled();
    if (suffix.startsWith("BUDGET_")) await expect(alert.getByRole("link", { name: "调整测试额度" })).toHaveAttribute("href", "/admin/operations/probes");
  }
  probeReply = { status: 401, body: { error: { code: "PLATFORM_PROVIDER_PROBE_PROVIDER_AUTH_FAILED", message: "secret=private-provider-detail" } } };
  await run.click();
  await expect(dialog.getByRole("alert")).toContainText("供应商凭据无效或权限不足");
  await expect(dialog).not.toContainText("private-provider-detail");
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
  probeReply = { status: 200, body: { draftProbeId: fixtureId, attempt: { safeErrorCode: null } } };
  await run.click();
  await expect(dialog.getByRole("status")).toContainText("真实连接测试通过");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(save).toBeEnabled();
  await dialog.getByLabel("连接名称", { exact: true }).fill("Changed after test");
  await expect(dialog.getByRole("status")).toHaveCount(0);
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
  await page.route("**/api/admin/platform-provider-probe/budget", async (route) => {
    if (route.request().method() !== "GET") return route.abort();
    return route.fulfill({ json: { budget: null } });
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
    const bodies = new Map<string, { clientRequestKey: string; modelId: string }>();
    await page.route("**/api/settings/providers", (route) => route.fulfill({ json: { providers: [provider], catalog } }));
    await page.route("**/api/admin/platform-provider-probe/budget", (route) => {
      expect(route.request().method()).toBe("GET");
      return route.fulfill({ json: { budget: { version: 1, status: "active", unitLimit: 10, availableUnits: 10, reservedUnits: 0, settledUnits: 0, heldUnits: 0, alertThresholdUnits: 8, startsAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString() } } });
    });
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
