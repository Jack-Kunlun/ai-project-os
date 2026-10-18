import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { expectR02NoAccessibilityViolations, expectR02NoHorizontalOverflow, signInR02Admin } from "./support/r02-admin-navigation";

test("login keeps drafts and real authentication while fitting the platform on desktop and mobile", async ({ page }) => {
  await signInR02Admin(page);
  await page.getByRole("button", { name: "退出", exact: true }).click();
  const user = await seedBrowserPersonalUser(`browser-login-${randomUUID().slice(0, 10)}`, "BrowserLogin2026Password!");
  await page.goto("/login?returnTo=%2Fpersonal%2Fknowledge");
  await expect(page.getByRole("heading", { name: "登录 AI Project OS", exact: true })).toBeVisible();
  const username = page.getByLabel("用户名或手机号", { exact: true });
  const password = page.getByLabel("密码", { exact: true });
  await username.fill(user.username);
  await password.fill("IncorrectBrowserPassword!");
  await page.getByRole("button", { name: "登 录", exact: true }).click();
  await expect(page.locator("form").getByRole("alert")).toHaveText("用户名或密码错误");
  await expect(username).toHaveValue(user.username);
  await expect(password).toHaveValue("IncorrectBrowserPassword!");
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expectR02NoHorizontalOverflow(page, `login at ${width}px`);
    await expectR02NoAccessibilityViolations(page, `login at ${width}px`);
    await expect(page.getByRole("link", { name: "创建账号", exact: true })).toHaveAttribute("href", "/register");
    await expect(page.getByRole("link", { name: "忘记账号或密码？", exact: true })).toHaveAttribute("href", "/recover");
    await page.screenshot({ path: `test-results/v110/login-${width}.png`, fullPage: true });
  }
  await password.fill(user.password);
  await page.getByRole("button", { name: "登 录", exact: true }).click();
  await expect(page).toHaveURL(/\/personal\/knowledge$/u);
  await expect(page.getByRole("heading", { name: "我的知识", exact: true })).toBeVisible();
});
