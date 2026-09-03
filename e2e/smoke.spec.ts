import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function expectNoAccessibilityViolations(page: Page, surface: string): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const violations = result.violations.map((violation) => ({
    help: violation.help,
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.map((node) => node.target),
  }));
  expect(violations, `${surface} must satisfy automated WCAG 2.2 A/AA checks`).toEqual([]);
}

test("first-run administrator can reach protected pages with production security headers", async ({ page, request }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console:${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`page:${error.message}`));

  const setupResponse = await page.goto("/setup");
  expect(setupResponse?.status()).toBe(200);
  const headers = setupResponse?.headers() ?? {};
  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-powered-by"]).toBeUndefined();
  await expectNoAccessibilityViolations(page, "setup");

  await page.getByLabel("用户名", { exact: true }).fill("browser_admin");
  await page.getByLabel("密码", { exact: true }).fill("BrowserGate2026Password!");
  await page.getByLabel("再次输入密码", { exact: true }).fill("BrowserGate2026Password!");
  await page.getByRole("button", { name: "创建管理员并进入" }).click();

  await expect(page).toHaveURL(/\/dashboard$/u);
  await expect(page.getByRole("heading", { name: "欢迎回来，browser_admin" })).toBeVisible();
  await expect(page.getByText("内部开发版 · 0.1.0-dev.1", { exact: true })).toBeVisible();
  await expectNoAccessibilityViolations(page, "dashboard");

  const healthResponse = await request.get("/api/health");
  expect(healthResponse.ok()).toBe(true);
  expect(await healthResponse.json()).toMatchObject({
    status: "ok",
    version: "0.1.0-dev.1",
    database: "up",
    worker: { status: "up", consecutiveFailures: 0 },
  });

  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "我的项目" })).toBeVisible();
  await expect(page.getByText("匹配 0 个", { exact: true })).toBeVisible();
  await expect(page.getByText(/第 1 \/ 1 页/u)).toHaveCount(0);
  await expectNoAccessibilityViolations(page, "projects");

  await page.getByRole("button", { name: "＋ 新建项目" }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("Browser layout project");
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  const projectHref = await page.getByRole("link", { name: "Browser layout project", exact: true }).getAttribute("href");
  expect(projectHref).toMatch(/^\/projects\/[0-9a-f-]+$/u);
  await page.goto(`${projectHref!}/materials`);
  const itemForm = page.locator("#project-item-form");
  const selectedSourcePanel = page.getByRole("heading", { name: "所选 Source 原文" }).locator("..");
  await expect(itemForm).toBeVisible();
  await expect(selectedSourcePanel).toBeVisible();
  const [itemFormBox, selectedSourceBox] = await Promise.all([itemForm.boundingBox(), selectedSourcePanel.boundingBox()]);
  expect(itemFormBox).not.toBeNull();
  expect(selectedSourceBox).not.toBeNull();
  expect(Math.abs(itemFormBox!.height - selectedSourceBox!.height)).toBeLessThanOrEqual(1);

  await page.goto("/guide");
  await expect(page.getByRole("heading", { name: "从账号进入，到可信的项目协作。" })).toBeVisible();
  await expect(page.getByText(/项目概览 → 项目计划 → 项目资料 → AI 工作台 → 项目自动化 → 项目管理/u)).toBeVisible();
  await expectNoAccessibilityViolations(page, "guide");

  await page.goto("/profile");
  await expect(page.getByText("账户详情", { exact: true })).toBeVisible();
  await expect(page.locator("details[open]").filter({ hasText: "账户详情" })).toHaveCount(1);
  await expectNoAccessibilityViolations(page, "profile");

  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "管理员总览" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "管理工作台导航" })).toBeVisible();
  await expect(page.getByText("平台 Token 总览", { exact: true })).toBeVisible();
  await expectNoAccessibilityViolations(page, "admin overview");

  await page.goto("/admin/connectors/mcp");
  await expect(page.getByRole("heading", { name: "MCP 只读工具连接" })).toBeVisible();
  await expect(page.getByText(/管理员认证精确定义、网络和凭据指纹/u)).toBeVisible();
  await expectNoAccessibilityViolations(page, "MCP connections");
  expect(browserErrors).toEqual([]);
});
