import { randomUUID } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { createPasswordRecord } from "@/lib/auth";
import { getDb } from "@/lib/db";

const BROWSER_ADMIN_PASSWORD = "BrowserGate2026Password!";
const BROWSER_AUDIT_USER_PASSWORD = "BrowserAuditUser2026!";
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function signInBrowserAdmin(page: Page): Promise<void> {
  await page.goto("/setup");
  if (/\/setup$/u.test(page.url())) {
    await page.getByLabel("用户名", { exact: true }).fill("browser_admin");
    await page.getByLabel("密码", { exact: true }).fill(BROWSER_ADMIN_PASSWORD);
    await page.getByLabel("再次输入密码", { exact: true }).fill(BROWSER_ADMIN_PASSWORD);
    await page.getByRole("button", { name: "创建管理员并进入" }).click();
  } else {
    await expect(page).toHaveURL(/\/login$/u);
    await page.getByLabel("用户名", { exact: true }).fill("browser_admin");
    await page.getByLabel("密码", { exact: true }).fill(BROWSER_ADMIN_PASSWORD);
    await page.getByRole("button", { name: "登 录", exact: true }).click();
  }
  await expect(page).toHaveURL(/\/dashboard$/u);
}

async function seedSystemAuditFixture(): Promise<{
  auditId: string;
  projectId: string;
  workspaceId: string;
  ordinaryUserId: string;
  ordinaryUsername: string;
}> {
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

  await db.appUser.create({ data: { id: ordinaryUserId, username: ordinaryUsername, role: "user", ...password } });
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
  return { auditId, projectId, workspaceId, ordinaryUserId, ordinaryUsername };
}

function cleanupSystemAuditFixture(fixture: Awaited<ReturnType<typeof seedSystemAuditFixture>>): Promise<void> {
  // The browser runner drops the disposable database after the suite.  Audit
  // rows are append-only, so ordinary relation deletes are intentionally not
  // attempted here.
  void fixture;
  return Promise.resolve();
}

async function expectNoHorizontalOverflow(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/admin/audit");
  await expect(page.getByRole("heading", { name: "审计中心", exact: true })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(dimensions.documentWidth, `admin audit document must not overflow at ${width}px`).toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(dimensions.bodyWidth, `admin audit body must not overflow at ${width}px`).toBeLessThanOrEqual(dimensions.viewportWidth);
  const accessibility = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(accessibility.violations, `admin audit must pass WCAG checks at ${width}px`).toEqual([]);
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

test("administrator audit center exposes new safe sources across viewports and denies ordinary users", async ({ page, browser }: { page: Page; browser: Browser }) => {
  await signInBrowserAdmin(page);
  const fixture = await seedSystemAuditFixture();
  try {
    await page.goto("/admin/audit");
    await expect(page.getByRole("heading", { name: "审计中心", exact: true })).toBeVisible();
    const sourceSelect = page.getByRole("combobox", { name: "来源", exact: true });
    await expect(sourceSelect.locator('option[value="projectGitManualRun"]')).toHaveCount(1);
    const sourceValues = await sourceSelect.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(sourceValues).toContain("projectGitManualRun");
    expect(sourceValues).toContain("projectMcpActionApproval");
    expect(sourceValues).toContain("projectMcpActionRuntime");
    expect(sourceValues).toContain("aiRuntime");
    expect(sourceValues).toContain("webAiConfirmation");
    expect(sourceValues).not.toContain("aiProviderOwnership");
    const actionSelect = page.getByRole("combobox", { name: "动作", exact: true });
    await expect(actionSelect.locator('option[value="runFailed"]')).toHaveCount(1);
    const actionValues = await actionSelect.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(actionValues).not.toContain("legacyOwnershipConfirmed");

    await sourceSelect.selectOption("aiRuntime");
    await page.getByRole("button", { name: "应用筛选", exact: true }).click();
    const auditTable = page.getByRole("table");
    await expect(auditTable.getByText("AI 运行时", { exact: true })).toBeVisible();
    await expect(auditTable.getByText("预检拒绝", { exact: true })).toBeVisible();
    await auditTable.getByRole("button", { name: "查看详情", exact: true }).click();
    await expect(page.getByText("安全错误码：AI_PROVIDER_UNKNOWN", { exact: false })).toBeVisible();
    await expect(page.getByText(`记录 ID：${fixture.auditId}`, { exact: true })).toBeVisible();

    for (const width of [1440, 1024, 768, 390] as const) await expectNoHorizontalOverflow(page, width);

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
