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
  modelId: "gpt-4.1-mini",
  embeddingDimensions: 1536,
  maxOutputTokens: 2048,
  quotaMultiplierBps: 10_000,
  validatedAt: fixtureTimestamp,
};
const platformOperations = {
  operations: [...operations],
  candidates: Object.fromEntries(operations.map((operation) => [operation, {
    readiness: operation === "embedding" ? "ready" : "missing",
    active: operation === "embedding" ? active : null,
    candidates: [candidate],
  }])),
};

test("admin models use compact lists and open read-only drawers across narrow and desktop layouts", async ({ page }) => {
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
    await expect(configuredModelCount).toHaveText("3 models");
    await expect(configuredModelCount).not.toContainText("projects");
    await expect(providerRow.getByRole("button", { name: "Manage connection", exact: true })).toBeVisible();
    const embeddingRow = page.locator('[data-operation="embedding"]');
    await expect(embeddingRow).toContainText(fixtureName);
    await expect(embeddingRow).toContainText("gpt-4.1-mini");
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

    const configure = embeddingRow.getByRole("button", { name: "Configure", exact: true });
    await configure.click();
    const operationDrawer = page.locator('[data-operation-config="embedding"]').locator('xpath=ancestor::*[@role="dialog"]');
    await expect(operationDrawer).toBeVisible();
    await expectR02NoHorizontalOverflow(page, `capability drawer en-dark ${width}`);
    await operationDrawer.getByRole("combobox", { name: "Select a verified connection and capability model", exact: true }).waitFor();
    await operationDrawer.getByRole("button", { name: "Close dialog", exact: true }).click();
    await expect(configure).toBeFocused();
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
    expect(dialogGeometry.headingFontSize).toBe("17px");
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
