import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { expectR02NoAccessibilityViolations, expectR02NoHorizontalOverflow, signInR02Admin, signOutR02User } from "./support/r02-admin-navigation";
import { englishUiMessages } from "../src/lib/ui-dictionary-source";

function loginText(source: string, language: "zh-CN" | "en"): string {
  return language === "en" ? englishUiMessages[source] ?? source : source;
}

async function checkErrorStateLayout(page: Page, language: "zh-CN" | "en", theme: "light" | "dark"): Promise<void> {
  const languageName = language === "en" ? "en" : "zh-CN";
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator("html")).toHaveAttribute("lang", languageName);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.getByRole("heading", { name: loginText("登录 AI Project OS", language), exact: true })).toBeVisible();
    await expect(page.locator("#login-username")).toHaveValue(/browser-login-/u);
    await expect(page.locator("#login-password")).toHaveValue("IncorrectBrowserPassword!");
    await expect(page.locator("form").getByRole("alert")).toHaveText(loginText("用户名或密码错误", language));
    await expectR02NoHorizontalOverflow(page, `login error at ${width}px (${language}/${theme})`);
    await page.locator(".appearance-controls-trigger").hover();
    await expectR02NoAccessibilityViolations(page, `login error at ${width}px (${language}/${theme})`);
    await expect(page.getByRole("link", { name: loginText("创建账号", language), exact: true })).toHaveAttribute("href", "/register");
    await expect(page.getByRole("link", { name: loginText("忘记账号或密码？", language), exact: true })).toHaveAttribute("href", "/recover");
    await page.screenshot({ path: `test-results/v110/login-${languageName}-${theme}-${width}.png`, fullPage: true });
  }
}

async function switchToEnglishDark(page: Page): Promise<void> {
  await page.getByRole("button", { name: "语言与外观", exact: true }).click();
  const trigger = page.locator(".appearance-controls-trigger");
  const popover = page.locator('.appearance-controls [role="dialog"]');
  await expect(popover.getByRole("combobox", { name: "语言", exact: true })).toBeVisible();
  await popover.getByRole("combobox", { name: "语言", exact: true }).selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(popover.getByRole("status")).toHaveCount(0);
  await expect(popover.getByRole("combobox", { name: "Language", exact: true })).toBeVisible();
  await expect(popover.getByRole("combobox", { name: "Theme", exact: true })).toBeVisible();
  await popover.getByRole("combobox", { name: "Theme", exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme-preference", "dark");
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(trigger).toBeFocused();
}

test("login preserves authentication drafts and error-state links in Chinese light and English dark", async ({ page }) => {
  await signInR02Admin(page);
  await signOutR02User(page);
  const user = await seedBrowserPersonalUser(`browser-login-${randomUUID().slice(0, 10)}`, "BrowserLogin2026Password!");
  await page.goto("/login?returnTo=%2Fpersonal%2Fknowledge");
  await expect(page.getByRole("heading", { name: "登录 AI Project OS", exact: true })).toBeVisible();
  const username = page.locator("#login-username");
  const password = page.locator("#login-password");
  await username.fill(user.username);
  await password.fill("IncorrectBrowserPassword!");
  await page.getByRole("button", { name: "登 录", exact: true }).click();
  await expect(page.locator("form").getByRole("alert")).toHaveText("用户名或密码错误");
  await expect(username).toHaveValue(user.username);
  await expect(password).toHaveValue("IncorrectBrowserPassword!");
  await checkErrorStateLayout(page, "zh-CN", "light");
  await switchToEnglishDark(page);
  await checkErrorStateLayout(page, "en", "dark");
  await expect(username).toHaveValue(user.username);
  await expect(password).toHaveValue("IncorrectBrowserPassword!");

  await password.fill(user.password);
  await page.getByRole("button", { name: loginText("登 录", "en"), exact: true }).click();
  await expect(page).toHaveURL(/\/personal\/knowledge$/u);
  await expect(page.getByRole("heading", { name: loginText("我的知识", "en"), exact: true })).toBeVisible();
});
