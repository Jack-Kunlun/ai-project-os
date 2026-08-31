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
  await expect(page.getByText("Project intelligence · V5.1.0", { exact: true })).toBeVisible();
  await expectNoAccessibilityViolations(page, "dashboard");

  const healthResponse = await request.get("/api/health");
  expect(healthResponse.ok()).toBe(true);
  expect(await healthResponse.json()).toMatchObject({
    status: "ok",
    version: "5.1.0",
    database: "up",
    worker: { status: "up", consecutiveFailures: 0 },
  });

  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "我的项目" })).toBeVisible();
  await expectNoAccessibilityViolations(page, "projects");

  await page.goto("/guide");
  await expect(page.getByRole("heading", { name: "由管理员认证精确工具" })).toBeVisible();
  await expect(page.getByText(/远端声明本身不产生授权资格/u)).toBeVisible();
  await expectNoAccessibilityViolations(page, "guide");

  await page.goto("/connections/mcp");
  await expect(page.getByRole("heading", { name: "MCP 只读工具连接" })).toBeVisible();
  await expect(page.getByText(/管理员认证精确定义、网络和凭据指纹/u)).toBeVisible();
  await expectNoAccessibilityViolations(page, "MCP connections");
  expect(browserErrors).toEqual([]);
});
