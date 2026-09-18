import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Browser, Locator, Page, Route } from "@playwright/test";
import { activateAccountEntitlements } from "@/lib/account-entitlement-activation-service";
import { createPasswordRecord } from "@/lib/auth";
import { getDb } from "@/lib/db";

const BROWSER_ADMIN_PASSWORD = "BrowserGate2026Password!";
const BROWSER_AUDIT_USER_PASSWORD = "BrowserAuditUser2026!";
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const SCREENSHOT_DIR = "evidence/v0.3x/T09-workbuddy/screenshots";
const SOURCE_LABEL_SHORT = "账号权益激活";
const RESULT_LABEL_SHORT = "已生效";
const PRINCIPAL_HEADER_SHORT = "操作者";
const DETAIL_BUTTON_SHORT = "查看详情";

/** A desktop screen at 200% zoom has half the CSS width available. */
const DESKTOP_WIDTHS = [1440, 1280, 1024, 768, 390] as const;

test.setTimeout(300_000);

type AuditFixture = Readonly<{
  auditId: string;
  activationAuditId: string;
  projectId: string;
  workspaceId: string;
  ordinaryUserId: string;
  ordinaryUsername: string;
}>;

async function settleBrowserAdmin(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/(?:onboarding|admin)$/u);
  if (new URL(page.url()).pathname === "/onboarding") {
    await page.getByLabel("Owner 用户名", { exact: true }).fill("browser_owner");
    await page.getByLabel("初始密码", { exact: true }).fill("BrowserOwner2026Password!");
    await page.getByLabel("确认密码", { exact: true }).fill("BrowserOwner2026Password!");
    await page.getByRole("button", { name: "创建 Owner 并进入管理后台", exact: true }).click();
  }
  await expect(page).toHaveURL(/\/admin$/u);
}

async function signInBrowserAdmin(page: Page): Promise<void> {
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/(?:setup|login|onboarding|admin)$/u);
  const landingPath = new URL(page.url()).pathname;
  if (landingPath === "/setup") {
    await page.getByLabel("用户名", { exact: true }).fill("browser_admin");
    await page.getByLabel("密码", { exact: true }).fill(BROWSER_ADMIN_PASSWORD);
    await page.getByLabel("再次输入密码", { exact: true }).fill(BROWSER_ADMIN_PASSWORD);
    await page.getByRole("button", { name: "创建管理员并进入" }).click();
  } else if (landingPath === "/login") {
    await page.getByLabel("用户名", { exact: true }).fill("browser_admin");
    await page.getByLabel("密码", { exact: true }).fill(BROWSER_ADMIN_PASSWORD);
    await page.getByRole("button", { name: "登 录", exact: true }).click();
  } else {
    expect(["/onboarding", "/admin"]).toContain(landingPath);
  }
  await settleBrowserAdmin(page);
}

/**
 * Seeds a mixed audit page: an entitlement activation record that renders the
 * short labels under review, and enough AI runtime records to keep the cursor
 * pagination contract exercised.
 */
async function seedSystemAuditFixture(): Promise<AuditFixture> {
  const db = getDb();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const projectId = randomUUID();
  const workspaceId = randomUUID();
  const policyRevisionId = randomUUID();
  const auditId = randomUUID();
  const ordinaryUserId = randomUUID();
  const ordinaryUsername = `audit-viewer-${suffix}`;
  const fingerprint = "a".repeat(64);
  const password = await createPasswordRecord(BROWSER_AUDIT_USER_PASSWORD);
  const browserAdmin = await db.appUser.findUniqueOrThrow({
    where: { username: "browser_admin" },
    select: { id: true, role: true, accountAccessVersion: true },
  });
  if (browserAdmin.role !== "admin") throw new Error("BROWSER_AUDIT_ADMIN_FIXTURE_INVALID");

  const ordinaryUser = await db.appUser.create({
    data: { id: ordinaryUserId, username: ordinaryUsername, role: "user", ...password },
    select: { id: true, accountAccessVersion: true },
  });
  await db.workspace.create({ data: { id: workspaceId, name: `Browser audit ${suffix}`, slug: `browser-audit-${suffix}` } });
  await db.project.create({ data: { id: projectId, workspaceId, name: `Browser audit ${suffix}`, slug: `browser-audit-${suffix}-project` } });
  await db.projectAiPolicyRevision.create({
    data: {
      id: policyRevisionId,
      projectId,
      revision: 1,
      policyFingerprint: fingerprint,
      profileFingerprint: fingerprint,
      processorFingerprint: fingerprint,
      regionFingerprint: fingerprint,
      retentionFingerprint: fingerprint,
      endpointFingerprint: fingerprint,
      budgetFingerprint: fingerprint,
      scannerFingerprint: fingerprint,
    },
  });
  await db.aiAuditEvent.create({
    data: {
      id: auditId,
      projectId,
      policyRevisionId,
      eventType: "preflightRejected",
      safeCode: "aiProviderUnknown",
      createdAt: new Date(Date.now() - 5_000),
    },
  });
  const extraIds = Array.from({ length: 24 }, () => randomUUID());
  await db.aiAuditEvent.createMany({
    data: extraIds.map((id, index) => ({
      id,
      projectId,
      policyRevisionId,
      eventType: "preflightRejected",
      safeCode: "aiProviderUnknown",
      createdAt: new Date(Date.now() - 60_000 - index * 1_000),
    })),
  });
  const activation = await activateAccountEntitlements({
    userId: ordinaryUser.id,
    source: "localProvisioning",
    actorId: browserAdmin.id,
    actorAccountAccessVersion: browserAdmin.accountAccessVersion,
    accountAccessVersion: ordinaryUser.accountAccessVersion,
    evidenceKind: "browser-audit",
    evidenceRef: `browser-audit:${ordinaryUser.id}`,
  });
  const activationAudit = await db.accountEntitlementActivationAudit.findFirstOrThrow({
    where: { activationId: activation.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  return { auditId, activationAuditId: activationAudit.id, projectId, workspaceId, ordinaryUserId, ordinaryUsername };
}

function cleanupSystemAuditFixture(fixture: AuditFixture): Promise<void> {
  // The browser runner drops the disposable database after the suite.  Audit
  // rows are append-only, so ordinary relation deletes are intentionally not
  // attempted here.
  void fixture;
  return Promise.resolve();
}

type TextMetrics = Readonly<{ lines: number; height: number; width: number; lineHeight: number }>;

/** Counts the real line boxes produced by the browser for an element's text. */
async function measureText(locator: Locator): Promise<TextMetrics> {
  return locator.evaluate((node) => {
    const element = node as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(element);
    const lines = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0).length;
    const box = element.getBoundingClientRect();
    const parsed = Number.parseFloat(window.getComputedStyle(element).lineHeight);
    return { lines, height: box.height, width: box.width, lineHeight: Number.isFinite(parsed) ? parsed : 0 };
  });
}

async function expectSingleLine(locator: Locator, label: string, context: string): Promise<void> {
  const metrics = await measureText(locator);
  expect(metrics.width, `${context}：${label} 必须有可见宽度`).toBeGreaterThan(0);
  expect(metrics.lines, `${context}：${label} 必须保持单行，实际 ${metrics.lines} 行`).toBe(1);
}

async function expectNoClippedContent(locator: Locator, label: string, context: string): Promise<void> {
  const box = await locator.evaluate((node) => {
    const element = node as HTMLElement;
    return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
  });
  expect(box.scrollWidth, `${context}：${label} 内容不得溢出单元格（scrollWidth ${box.scrollWidth} > clientWidth ${box.clientWidth}）`)
    .toBeLessThanOrEqual(box.clientWidth + 1);
}

async function expectActionReachable(page: Page, locator: Locator, label: string, context: string): Promise<void> {
  await expect(locator, `${context}：${label} 必须可见`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${context}：${label} 必须有布局盒`).not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport, `${context}：需要视口尺寸`).not.toBeNull();
  const viewportWidth = viewport?.width ?? 0;
  expect(box?.x ?? -1, `${context}：${label} 必须落在视口内`).toBeGreaterThanOrEqual(-1);
  expect((box?.x ?? 0) + (box?.width ?? 0), `${context}：${label} 不得被挤出视口右侧`).toBeLessThanOrEqual(viewportWidth + 1);
}

async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(dimensions.documentWidth, `${label}：document 不得横向溢出`).toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(dimensions.bodyWidth, `${label}：body 不得横向溢出`).toBeLessThanOrEqual(dimensions.viewportWidth);
}

async function expectNoAccessibilityViolations(page: Page, label: string): Promise<void> {
  const accessibility = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(accessibility.violations, `${label}：必须通过 WCAG 检查`).toEqual([]);
}

/**
 * Measures the four short strings called out by UX-301 on the seeded
 * activation record, plus the action button, and records a screenshot.
 */
async function measureShortLabels(page: Page, fixture: AuditFixture, label: string): Promise<void> {
  const table = page.getByRole("table");
  const activationRow = page.locator(`tr[data-audit-id="${fixture.activationAuditId}"]`);
  await expect(activationRow, `${label}：短文字样本行必须存在`).toHaveCount(1);

  const sourceCell = activationRow.getByText(SOURCE_LABEL_SHORT, { exact: true });
  await expect(sourceCell, `${label}：必须渲染“${SOURCE_LABEL_SHORT}”`).toBeVisible();
  await expectSingleLine(sourceCell, `来源标签“${SOURCE_LABEL_SHORT}”`, label);
  await expectNoClippedContent(activationRow.locator("td").nth(1), "来源 / 动作单元格", label);

  const resultPill = activationRow.getByText(RESULT_LABEL_SHORT, { exact: true });
  await expect(resultPill, `${label}：必须渲染“${RESULT_LABEL_SHORT}”`).toBeVisible();
  await expectSingleLine(resultPill, `结果标签“${RESULT_LABEL_SHORT}”`, label);

  await expectSingleLine(table.getByRole("columnheader", { name: PRINCIPAL_HEADER_SHORT, exact: true }), `表头“${PRINCIPAL_HEADER_SHORT}”`, label);

  const detailButton = activationRow.getByRole("button", { name: DETAIL_BUTTON_SHORT, exact: true });
  await expectSingleLine(detailButton, `按钮“${DETAIL_BUTTON_SHORT}”`, label);
  await expectActionReachable(page, detailButton, `按钮“${DETAIL_BUTTON_SHORT}”`, label);

  await expect(table.getByText(fixture.projectId, { exact: false }), `${label}：列表不得铺开技术标识`).toHaveCount(0);
  await expect(table.getByText(fixture.ordinaryUserId, { exact: false }), `${label}：列表不得铺开技术标识`).toHaveCount(0);
}

async function assertForbiddenAuditApis(page: Page, auditId: string): Promise<void> {
  const result = await page.evaluate(async (id) => {
    const list = await fetch("/api/system/audit?source=aiRuntime", { cache: "no-store" });
    const detail = await fetch(`/api/system/audit/aiRuntime/${id}`, { cache: "no-store" });
    return { listStatus: list.status, listBody: await list.text(), detailStatus: detail.status, detailBody: await detail.text() };
  }, auditId);
  expect(result.listStatus).toBe(403);
  expect(result.detailStatus).toBe(403);
  expect(result.listBody).not.toContain(auditId);
  expect(result.detailBody).not.toContain(auditId);
}

test("administrator audit center keeps short labels on one line and separates common from advanced filters", async ({ page, browser }: { page: Page; browser: Browser }) => {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await signInBrowserAdmin(page);
  const fixture = await seedSystemAuditFixture();
  try {
    await page.goto("/admin/audit");
    await expect(page.getByRole("heading", { name: "审计中心", exact: true })).toBeVisible();

    // Common filters are usable immediately; identifier filters stay collapsed.
    await expect(page.getByRole("combobox", { name: "来源", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "结果", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "操作者", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "主体", exact: true })).toBeVisible();
    await expect(page.getByLabel("开始时间", { exact: true })).toBeVisible();
    await expect(page.getByLabel("结束时间", { exact: true })).toBeVisible();
    const advancedToggle = page.getByRole("button", { name: "高级筛选", exact: true });
    await expect(advancedToggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("combobox", { name: "动作", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "项目 ID", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "工作区 ID", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "用户 ID", exact: true })).toHaveCount(0);

    const sourceSelect = page.getByRole("combobox", { name: "来源", exact: true });
    await expect(sourceSelect.locator('option[value="projectGitManualRun"]')).toHaveCount(1);
    const sourceValues = await sourceSelect.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(sourceValues).toContain("projectGitManualRun");
    expect(sourceValues).toContain("projectMcpActionApproval");
    expect(sourceValues).toContain("projectMcpActionRuntime");
    expect(sourceValues).toContain("aiRuntime");
    expect(sourceValues).toContain("webAiConfirmation");
    expect(sourceValues).not.toContain("aiProviderOwnership");

    await advancedToggle.click();
    const expandedToggle = page.getByRole("button", { name: "收起高级筛选", exact: true });
    await expect(expandedToggle).toHaveAttribute("aria-expanded", "true");
    const actionSelect = page.getByRole("combobox", { name: "动作", exact: true });
    await expect(actionSelect).toBeVisible();
    await expect(actionSelect.locator('option[value="runFailed"]')).toHaveCount(1);
    const actionValues = await actionSelect.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(actionValues).not.toContain("legacyOwnershipConfirmed");
    await expect(page.getByRole("textbox", { name: "项目 ID", exact: true })).toBeVisible();
    await expandedToggle.click();
    await expect(page.getByRole("combobox", { name: "动作", exact: true })).toHaveCount(0);

    // Short-label typography is measured directly at every required viewport.
    for (const width of DESKTOP_WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/admin/audit");
      await expect(page.getByRole("heading", { name: "审计中心", exact: true })).toBeVisible();
      await measureShortLabels(page, fixture, `${width}px`);
      await expectNoHorizontalOverflow(page, `${width}px`);
      await page.screenshot({ path: `${SCREENSHOT_DIR}/audit-list-${width}.png` });
      await expectNoAccessibilityViolations(page, `${width}px`);
    }

    // Desktop at 200% zoom behaves like a 720 CSS px wide viewport.
    const zoomContext = await browser.newContext({
      viewport: { width: 720, height: 450 },
      deviceScaleFactor: 2,
      storageState: await page.context().storageState(),
    });
    try {
      const zoomPage = await zoomContext.newPage();
      const origin = new URL(page.url()).origin;
      await zoomPage.goto(`${origin}/admin/audit`);
      await expect(zoomPage.getByRole("heading", { name: "审计中心", exact: true })).toBeVisible();
      await measureShortLabels(zoomPage, fixture, "1440px@200%");
      await expectNoHorizontalOverflow(zoomPage, "1440px@200%");
      await zoomPage.screenshot({ path: `${SCREENSHOT_DIR}/audit-list-1440-zoom200.png` });
      await expectNoAccessibilityViolations(zoomPage, "1440px@200%");
    } finally {
      await zoomContext.close();
    }

    // Filtering, active-filter summary and cursor pagination.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/admin/audit");
    await page.getByRole("combobox", { name: "来源", exact: true }).selectOption("aiRuntime");
    await page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await expect(page.getByText("来源：AI 运行时", { exact: true })).toBeVisible();
    await expect(page.getByText("第 1 页", { exact: true })).toBeVisible();
    const auditTable = page.getByRole("table");
    await expect(auditTable.getByText("AI 运行时", { exact: true }).first()).toBeVisible();
    await expect(auditTable.getByText("预检拒绝", { exact: true }).first()).toBeVisible();
    await expect(auditTable.getByText(fixture.projectId, { exact: false })).toHaveCount(0);

    const firstRowOnPageOne = await auditTable.getByRole("row").nth(1).getAttribute("data-audit-id");
    expect(firstRowOnPageOne).not.toBeNull();
    await expect(page.getByRole("button", { name: "上一页", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(page.getByText("第 2 页", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "上一页", exact: true })).toBeEnabled();
    const firstRowOnPageTwo = await auditTable.getByRole("row").nth(1).getAttribute("data-audit-id");
    expect(firstRowOnPageTwo).not.toBe(firstRowOnPageOne);
    await page.getByRole("button", { name: "上一页", exact: true }).click();
    await expect(page.getByText("第 1 页", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "上一页", exact: true })).toBeDisabled();
    await expect(page.getByText("来源：AI 运行时", { exact: true })).toBeVisible();

    // Reset drops the filter set and returns to the first page.
    await page.getByRole("button", { name: "重置", exact: true }).click();
    await expect(page.getByText("未设置，显示全部来源", { exact: true })).toBeVisible();
    await expect(page.getByText("来源：AI 运行时", { exact: true })).toHaveCount(0);

    const ordinaryContext = await browser.newContext();
    const ordinaryPage = await ordinaryContext.newPage();
    try {
      const origin = new URL(page.url()).origin;
      await ordinaryPage.goto(`${origin}/login?returnTo=%2Fadmin%2Faudit`);
      await ordinaryPage.getByLabel("用户名", { exact: true }).fill(fixture.ordinaryUsername);
      await ordinaryPage.getByLabel("密码", { exact: true }).fill(BROWSER_AUDIT_USER_PASSWORD);
      await ordinaryPage.getByRole("button", { name: "登 录", exact: true }).click();
      await expect(ordinaryPage).toHaveURL(/\/dashboard$/u);
      await assertForbiddenAuditApis(ordinaryPage, fixture.auditId);
      await ordinaryPage.goto(`${origin}/admin/audit`);
      await expect(ordinaryPage).toHaveURL(/\/dashboard$/u);
    } finally {
      await ordinaryContext.close();
    }
  } finally {
    await cleanupSystemAuditFixture(fixture);
  }
});

test("audit detail drawer handles loading, failure, close and restores focus and list position", async ({ page }: { page: Page }) => {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await signInBrowserAdmin(page);
  const fixture = await seedSystemAuditFixture();
  const detailRoute = "**/api/system/audit/*/*";
  try {
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.goto("/admin/audit");
    await page.getByRole("combobox", { name: "来源", exact: true }).selectOption("aiRuntime");
    await page.getByRole("button", { name: "应用筛选", exact: true }).click();
    await expect(page.getByText("来源：AI 运行时", { exact: true })).toBeVisible();

    const targetRow = page.locator(`tr[data-audit-id="${fixture.auditId}"]`);
    await expect(targetRow).toHaveCount(1);
    const trigger = targetRow.getByRole("button", { name: DETAIL_BUTTON_SHORT, exact: true });

    // Loading state: the detail request is held open long enough to observe it.
    const delayedHandler = async (route: Route): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      try {
        await route.continue();
      } catch (error) {
        if (!(error instanceof Error) || !/Route is already handled/u.test(error.message)) throw error;
      }
    };
    await page.route(detailRoute, delayedHandler, { times: 1 });
    await trigger.focus();
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText("正在读取详情…", { exact: true })).toBeVisible();
    await expect(page.getByText("完整技术引用", { exact: true })).toBeVisible();
    await expect(drawer.getByText(fixture.projectId, { exact: true })).toBeVisible();
    await expect(page.getByText("安全错误码：AI_PROVIDER_UNKNOWN", { exact: false })).toBeVisible();
    await expect(drawer.getByText(fixture.auditId, { exact: true })).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/audit-detail-drawer.png` });
    await expect(drawer.getByText("正在读取详情…", { exact: true })).toHaveCount(0);

    // Focus stays inside the dialog while it is open.
    await drawer.getByRole("button", { name: "复制项目引用", exact: true }).focus();
    await page.keyboard.press("Tab");
    const focusInsideDialog = await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null);
    expect(focusInsideDialog).toBeTruthy();

    // Escape closes the drawer and returns focus to the triggering record.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.getByText("来源：AI 运行时", { exact: true })).toBeVisible();
    await expect(page.getByText("第 1 页", { exact: true })).toBeVisible();
    await page.unroute(detailRoute, delayedHandler);

    // Failure state is visible and recoverable.
    const failureHandler = async (route: Route): Promise<void> => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "SYSTEM_AUDIT_DETAIL_FAILED", message: "审计详情加载失败" } }),
      });
    };
    await page.route(detailRoute, failureHandler, { times: 1 });
    await trigger.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByText("审计详情加载失败", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "重新读取", exact: true })).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOT_DIR}/audit-detail-failure.png` });
    await page.unroute(detailRoute, failureHandler);
    await page.getByRole("button", { name: "重新读取", exact: true }).click();
    await expect(page.getByRole("dialog").getByText(fixture.projectId, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "关闭详情", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // Opening and closing the drawer keeps filters, page and scroll position.
    const scrollBefore = await page.evaluate(() => {
      const previousScrollBehavior = document.documentElement.style.scrollBehavior;
      document.documentElement.style.scrollBehavior = "auto";
      window.scrollTo(0, 320);
      const stableScrollY = window.scrollY;
      document.documentElement.style.scrollBehavior = previousScrollBehavior;
      return stableScrollY;
    });
    expect(scrollBefore, "列表必须足够长以便验证滚动位置").toBeGreaterThan(0);
    await trigger.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("来源：AI 运行时", { exact: true })).toBeVisible();
    await expect(page.getByText("第 1 页", { exact: true })).toBeVisible();
    await expect
      .poll(async () => Math.abs((await page.evaluate(() => window.scrollY)) - scrollBefore), { message: "关闭详情后滚动位置偏差必须不超过 1 CSS 像素" })
      .toBeLessThanOrEqual(1);
    await expect(trigger).toBeFocused();
  } finally {
    await cleanupSystemAuditFixture(fixture);
  }
});
