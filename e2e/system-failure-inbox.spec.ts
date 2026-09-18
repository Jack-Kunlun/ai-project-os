import { randomUUID } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { createPasswordRecord } from "@/lib/auth";
import { getDb } from "@/lib/db";

const BROWSER_ADMIN_PASSWORD = "BrowserGate2026Password!";
const BROWSER_FAILURE_USER_PASSWORD = "BrowserFailureUser2026!";
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

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
  }
  await settleBrowserAdmin(page);
}

async function seedFailureInboxUser(): Promise<{ username: string }> {
  const db = getDb();
  const username = `failure-inbox-browser-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await db.appUser.create({ data: { username, role: "user", ...(await createPasswordRecord(BROWSER_FAILURE_USER_PASSWORD)) } });
  return { username };
}

test("administrator can open the read-only failure inbox and non-admins remain blocked", async ({ page, browser }: { page: Page; browser: Browser }) => {
  await signInBrowserAdmin(page);
  await page.goto("/admin/operations/failures");
  await expect(page.getByRole("heading", { name: "失败与待对账收件箱", exact: true })).toBeVisible();
  await expect(page.getByText("这里只读汇总平台待核对、Worker / 后台任务、索引、个人连接、自动化和受控动作异常。", { exact: false })).toBeVisible();
  await expect(page.getByText("实时测量结果，不承诺跨页严格历史快照", { exact: false })).toBeVisible();

  const sourceSelect = page.getByRole("combobox", { name: "来源", exact: true });
  const lifecycleSelect = page.getByRole("combobox", { name: "状态", exact: true });
  await expect(sourceSelect.locator('option[value="providerHeld"]')).toHaveCount(1);
  await expect(sourceSelect.locator('option[value="controlledAction"]')).toHaveCount(1);
  await expect(lifecycleSelect.locator('option[value="requires_reconciliation"]')).toHaveCount(1);
  await expect(lifecycleSelect.locator('option[value="requires_owner_review"]')).toHaveCount(1);
  await expect(lifecycleSelect.locator('option[value="observed_failure"]')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "应用筛选", exact: true })).toBeVisible();

  const writeActionButtons = page.getByRole("button").filter({ hasText: /重试|恢复|重新执行|关闭异常|确认处理/u });
  await expect(writeActionButtons).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  const dimensions = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  const accessibility = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(accessibility.violations).toEqual([]);

  const fixture = await seedFailureInboxUser();
  const ordinaryContext = await browser.newContext();
  const ordinaryPage = await ordinaryContext.newPage();
  try {
    const origin = new URL(page.url()).origin;
    await ordinaryPage.goto(`${origin}/login?returnTo=%2Fadmin%2Foperations%2Ffailures`);
    await ordinaryPage.getByLabel("用户名", { exact: true }).fill(fixture.username);
    await ordinaryPage.getByLabel("密码", { exact: true }).fill(BROWSER_FAILURE_USER_PASSWORD);
    await ordinaryPage.getByRole("button", { name: "登 录", exact: true }).click();
    await expect(ordinaryPage).toHaveURL(/\/dashboard$/u);
    await ordinaryPage.goto(`${origin}/admin/operations/failures`);
    await expect(ordinaryPage).toHaveURL(/\/dashboard$/u);
  } finally {
    await ordinaryContext.close();
  }
});
