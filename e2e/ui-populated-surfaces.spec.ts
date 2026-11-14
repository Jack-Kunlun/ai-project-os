import { randomUUID } from "node:crypto";
import { expect, test, type Locator } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { expectR02NoHorizontalOverflow, signInR02Admin, signInR02PersonalUser, signOutR02User } from "./support/r02-admin-navigation";
import { settleVisualState } from "./support/settle-visual-state";

// Exercise populated, collapsed surfaces that an empty route screenshot cannot prove.
test("identity choices and project permission rows retain neutral readable surfaces", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(10_000);
  await signInR02Admin(page);
  await signOutR02User(page);
  const user = await seedBrowserPersonalUser(`ui-populated-${randomUUID().slice(0, 10)}`, "UiPopulated2026Password!");
  await signInR02PersonalUser(page, user);
  const response = await page.request.post("/api/projects", {
    headers: { origin: new URL(page.url()).origin },
    data: { name: "UI-permission-project-with-a-long-unbroken-name-to-check-wrapping", workspaceId: user.workspaceId },
  });
  expect(response.status()).toBe(201);
  const projectId = (await response.json()).project.id as string;
  const providerName = "UI identity provider with a long readable name";
  await page.route("**/api/profile", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const real = await route.fetch();
    const payload = await real.json();
    payload.profile.oidcLinkableProviders = [{ id: randomUUID(), name: providerName, workspace: { id: user.workspaceId, name: "UI acceptance workspace" } }];
    await route.fulfill({ response: real, json: payload });
  });
  const oidcWrites: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/auth/oidc/link/start") oidcWrites.push(request.method());
  });
  for (const mode of [{ theme: "light", width: 1440 }, { theme: "dark", width: 390 }]) {
    await page.setViewportSize({ width: mode.width, height: 900 });
    await page.context().addCookies([{ name: "aipos-theme", value: mode.theme, url: new URL(page.url()).origin }]);
    await page.goto("/profile", { waitUntil: "networkidle" });
    await page.locator("details summary").click();
    const provider = page.getByRole("button").filter({ hasText: providerName });
    await expect(provider).toBeVisible();
    await provider.scrollIntoViewIfNeeded();
    await settleVisualState(page);
    await expect(provider).not.toHaveClass(/\bapp-button-primary\b/u);
    await expect(provider).toHaveCSS("display", "flex");
    const contrast = await new AxeBuilder({ page }).include("details[open]").withRules(["color-contrast"]).analyze();
    expect(contrast.violations).toEqual([]);
    await expectR02NoHorizontalOverflow(page, `populated identity ${mode.theme}`);
    await page.screenshot({ path: testInfo.outputPath(`identity-${mode.theme}-${mode.width}.png`) });

    await page.goto(`/team/${user.workspaceId}?view=permissions`, { waitUntil: "networkidle" });
    const row = page.locator(`main a[href="/projects/${projectId}"]`);
    await expect(row).toBeVisible();
    await settleVisualState(page);
    await expect(row).not.toHaveClass(/\bapp-button-primary\b/u);
    await expect(row).toHaveCSS("display", "grid");
    const rowContrast = await new AxeBuilder({ page }).include(`main a[href="/projects/${projectId}"]`).withRules(["color-contrast"]).analyze();
    expect(rowContrast.violations).toEqual([]);
    await expectR02NoHorizontalOverflow(page, `populated permissions ${mode.theme}`);
    await page.screenshot({ path: testInfo.outputPath(`permissions-${mode.theme}-${mode.width}.png`) });

    for (const [path, count] of [["/personal", 6], [`/team/${user.workspaceId}?view=settings`, 3]] as const) {
      await page.goto(path, { waitUntil: "networkidle" });
      const cards = page.locator("main .app-card-action");
      await expect(cards).toHaveCount(count);
      for (const card of await cards.all()) {
        await expect(card).toHaveCSS("display", "block");
        const layout = await card.evaluate((element) => {
          const children = [...element.children].map(child => child.getBoundingClientRect());
          return { stacked: children.every((child, index) => index === 0 || child.top >= children[index - 1].bottom), padding: parseFloat(getComputedStyle(element).paddingLeft) };
        });
        expect(layout.stacked, `${path}: card contents remain vertically stacked`).toBe(true);
        expect(layout.padding).toBeGreaterThanOrEqual(20);
      }
      await expectR02NoHorizontalOverflow(page, `${path} cards ${mode.theme}`);
      await page.screenshot({ path: testInfo.outputPath(`cards-${count}-${mode.theme}-${mode.width}.png`) });
    }
  }
  expect(oidcWrites, "visual inspection must not start an external identity flow").toEqual([]);
});

async function expectSemanticCard(card: Locator, tone: "warning" | "danger") {
  await expect(card).toBeVisible();
  const colors = await card.evaluate((element, state) => {
    const probe = document.createElement("span");
    probe.style.background = `var(--app-${state}-soft)`;
    probe.style.border = `1px solid var(--app-${state}-border)`;
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe), actual = getComputedStyle(element);
    const result = { background: actual.backgroundColor, border: actual.borderTopColor, radius: actual.borderTopLeftRadius, expectedBackground: expected.backgroundColor, expectedBorder: expected.borderTopColor };
    probe.remove();
    return result;
  }, tone);
  expect(colors.background).toBe(colors.expectedBackground);
  expect(colors.border).toBe(colors.expectedBorder);
  expect(colors.radius).toBe("6px");
}

test("embedded outbound and rejection confirmations preserve semantic state colors", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(10_000);
  await signInR02Admin(page);
  const user = await seedBrowserPersonalUser(`ui-semantic-${randomUUID().slice(0, 10)}`, "UiSemantic2026Password!");
  const timestamp = new Date().toISOString(), expiresAt = new Date(Date.now() + 600_000).toISOString();
  const application = { id: randomUUID(), status: "pending", statusVersion: 1, submittedAt: timestamp, fulfilledAt: null, rejectedAt: null, withdrawnAt: null };
  const executeRequests: string[] = [];
  await page.route("**/api/system/memberships?*", route => route.fulfill({ json: { items: [{ id: user.id, username: user.username, displayName: "UI pending application", role: "user", disabledAt: null, membershipSubscription: null, membershipApplication: application }] } }));
  await page.route(`**/api/admin/users/${user.id}`, async route => {
    const real = await route.fetch();
    const payload = await real.json();
    payload.membershipApplication = application;
    return route.fulfill({ response: real, json: payload });
  });
  await page.route("**/api/system/membership-applications/reject/*", async route => {
    if (!route.request().url().endsWith("/preview")) { executeRequests.push(route.request().url()); return route.abort(); }
    return route.fulfill({ json: { application, preview: { id: randomUUID(), applicationId: application.id, action: "reject", requestKey: "display-fixture", requestFingerprint: "0".repeat(64), impactFingerprint: "1".repeat(64), issuedAt: timestamp, expiresAt, reason: "UI display only" } } });
  });
  const modes = [{ theme: "light", width: 1440 }, { theme: "dark", width: 390 }];
  for (const mode of modes) {
    await page.setViewportSize({ width: mode.width, height: 900 });
    await page.context().addCookies([{ name: "aipos-theme", value: mode.theme, url: new URL(page.url()).origin }]);
    for (const path of ["/admin/users/memberships", `/admin/users/${user.id}`]) {
      await page.goto(path, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: path.endsWith("memberships") ? "管理资格" : "管理会员资格", exact: true }).click();
      await page.getByLabel(path.endsWith("memberships") ? "撤销 / 拒绝原因" : "拒绝原因", { exact: true }).fill("UI display only");
      await page.getByRole("button", { name: "预览拒绝申请", exact: true }).click();
      const confirmation = page.getByRole("dialog", { name: "拒绝会员申请确认", exact: true });
      await expectSemanticCard(confirmation, "danger");
      await confirmation.screenshot({ path: testInfo.outputPath(`reject-${path.endsWith("memberships") ? "list" : "detail"}-${mode.theme}.png`) });
      await page.getByRole("button", { name: "取消", exact: true }).filter({ visible: true }).click();
      await page.locator('[data-operation-surface]:visible').getByRole('button', { name: '关闭窗口', exact: true }).click();
      await expect(page.locator('[data-operation-surface]:visible')).toHaveCount(0);
    }
  }
  await page.unrouteAll({ behavior: "wait" });
  await signOutR02User(page);
  await signInR02PersonalUser(page, user);
  const providerId = randomUUID();
  await page.route("**/api/personal/knowledge/semantic-providers", route => route.fulfill({ json: { providers: [{ id: providerId, name: "UI display provider", status: "verified", disabledAt: null, defaultEmbeddingModelId: "display-model", embeddingDimensions: 3, scope: "platform", billingMode: "platform", quotaMultiplierBps: 10000 }] } }));
  for (const kind of ["index", "search"]) {
    await page.route(`**/api/personal/knowledge/semantic-${kind}`, route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { status: "not_available", label: "尚未建立/不可用" } });
      if (route.request().postDataJSON().phase !== "prepare") { executeRequests.push(route.request().url()); return route.abort(); }
      return route.fulfill({ json: { challengeId: randomUUID(), kind: kind === "index" ? "build" : "search", issuedAt: timestamp, expiresAt, safeSummary: { action: kind === "index" ? "personalKnowledgeSemanticBuild" : "personalKnowledgeSemanticSearch", corpusEpoch: 1, documents: [{ documentId: randomUUID(), title: "UI acceptance document", version: 1, revisionId: randomUUID(), chunkCount: 1, sourceBytes: 64 }], totalChunks: 1, totalSourceBytes: 64, provider: { name: "UI display provider", model: "display-model", dimensions: 3 }, billing: { mode: "platform", estimatedCredits: 10 }, expiresAt } } });
    });
  }
  for (const mode of modes) {
    await page.setViewportSize({ width: mode.width, height: 900 });
    await page.context().addCookies([{ name: "aipos-theme", value: mode.theme, url: new URL(page.url()).origin }]);
    await page.goto("/personal/knowledge", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "智能检索与索引", exact: true }).click();
    for (const kind of ["index", "search"]) {
      await page.getByRole("button", { name: kind === "index" ? "索引管理" : "个人语义搜索", exact: true }).click();
      if (kind === "search") await page.getByRole("textbox", { name: "搜索个人知识库", exact: true }).fill("UI acceptance");
      await page.getByRole("button", { name: kind === "index" ? "建立语义索引" : "准备搜索", exact: true }).click();
      const confirmation = page.locator(`[aria-labelledby="personal-semantic-${kind === "index" ? "index-" : ""}confirm-title"]`);
      await expectSemanticCard(confirmation, "warning");
      const submit = confirmation.getByRole('button', { name: kind === 'index' ? '确认并建立' : '确认并搜索', exact: true });
      await submit.click({ trial: true });
      await page.screenshot({ path: testInfo.outputPath(`outbound-${kind}-${mode.theme}.png`) });
      await page.getByRole("button", { name: "取消", exact: true }).filter({ visible: true }).click();
    }
  }
  expect(executeRequests, "display acceptance must never execute membership or model operations").toEqual([]);
});

test("guide chapter navigation stays beside or above the reading content", async ({ page }, testInfo) => {
  page.setDefaultTimeout(10_000);
  await signInR02Admin(page);
  const user = await seedBrowserPersonalUser(`ui-guide-${randomUUID().slice(0, 10)}`, "UiGuide2026Password!");
  for (const path of ["/admin/guide", "/guide"]) {
    if (path === "/guide") {
      await signOutR02User(page);
      await page.context().addCookies([{ name: "aipos-language", value: "zh-CN", url: new URL(page.url()).origin }]);
      await signInR02PersonalUser(page, user);
    }
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.context().addCookies([
        { name: "aipos-theme", value: width === 390 ? "dark" : "light", url: new URL(page.url()).origin },
        { name: "aipos-language", value: width === 390 ? "en" : "zh-CN", url: new URL(page.url()).origin },
      ]);
      await page.goto(path, { waitUntil: "networkidle" });
      const nav = page.locator('nav[aria-labelledby$="guide-nav-label"]');
      const chapter = page.locator('article[id], section[id]').first();
      const navigation = await nav.boundingBox(), reading = await chapter.boundingBox();
      expect(navigation).not.toBeNull();
      expect(reading).not.toBeNull();
      if (width === 390) expect(navigation!.y + navigation!.height + 16).toBeLessThanOrEqual(reading!.y);
      else expect(navigation!.x + navigation!.width + 20).toBeLessThanOrEqual(reading!.x);
      await expectR02NoHorizontalOverflow(page, `${path} ${width}`);
      await page.screenshot({ path: testInfo.outputPath(`guide-${path.includes("admin") ? "admin" : "user"}-${width}.png`) });
    }
  }
});
