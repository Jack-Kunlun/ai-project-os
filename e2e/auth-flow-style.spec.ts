import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { getEntitlementDb } from "@/lib/db";
import { expectR02NoAccessibilityViolations, expectR02NoHorizontalOverflow, signInR02Admin } from "./support/r02-admin-navigation";

async function checkAuthLayout(page: Page, name: string) {
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expectR02NoHorizontalOverflow(page, `${name} at ${width}px`);
    await expectR02NoAccessibilityViolations(page, `${name} at ${width}px`);
    await expect(page.getByRole("link", { name: "隐私政策", exact: true })).toHaveAttribute("href", "/privacy");
    await expect(page.getByRole("link", { name: "服务条款", exact: true })).toHaveAttribute("href", "/terms");
    await page.screenshot({ path: `test-results/auth-flow/${name}-${width}.png`, fullPage: true });
  }
}

test("registration shares the login layout, preserves a rejected draft, and creates a real personal account", async ({ page }) => {
  await signInR02Admin(page);
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await page.getByRole("link", { name: "创建账号", exact: true }).click();
  await expect(page.getByRole("heading", { name: "创建账号", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "返回登录", exact: true })).toHaveAttribute("href", "/login");
  await checkAuthLayout(page, "register");

  const username = `auth_style_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const password = "BrowserAuthStyle2026!";
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByLabel("确认密码", { exact: true }).fill("DifferentAuthStyle2026!");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await expect(page.locator("form").getByRole("alert")).toHaveText("两次输入的密码不一致。");
  await expect(page.getByLabel("用户名", { exact: true })).toHaveValue(username);
  await expect(page.getByLabel("密码", { exact: true })).toHaveValue(password);
  await page.getByLabel("确认密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/u);
  await expect(page.getByRole("heading", { name: "工作台", exact: true })).toBeVisible();
  const user = await getEntitlementDb().appUser.findUniqueOrThrow({ where: { username } });
  expect(user.role).toBe("user");
  expect(await getEntitlementDb().workspaceMembership.count({ where: { userId: user.id, role: "owner", accessState: "confirmed" } })).toBe(1);
});

test("unavailable phone recovery keeps its controls disabled and returns to the same login experience", async ({ page }) => {
  await signInR02Admin(page);
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await page.getByRole("link", { name: "忘记账号或密码？", exact: true }).click();
  await expect(page.getByRole("heading", { name: "找回账号与密码", exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "短信找回暂不可用" })).toBeVisible();
  await expect(page.locator("#recover-phone")).toBeDisabled();
  await expect(page.locator("#recover-code")).toBeDisabled();
  await expect(page.locator("#recover-password")).toBeDisabled();
  await expect(page.getByRole("button", { name: "验证并重设密码", exact: true })).toBeDisabled();
  await checkAuthLayout(page, "recover-unavailable");
  await page.getByRole("link", { name: "返回登录", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/u);
  await expect(page.getByRole("heading", { name: "登录 AI Project OS", exact: true })).toBeVisible();
});
