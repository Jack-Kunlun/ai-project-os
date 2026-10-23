import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { expectR02NoAccessibilityViolations, expectR02NoHorizontalOverflow, signInR02Admin, signOutR02User } from "./support/r02-admin-navigation";
import { englishUiMessages } from "../src/lib/ui-dictionary-source";
import { expectIconOnlyAlignment } from "./support/icon-label-alignment";

function loginText(source: string, language: "zh-CN" | "en"): string {
  return language === "en" ? englishUiMessages[source] ?? source : source;
}

async function expectLoginFieldAndActionSpacing(page: Page, language: "zh-CN" | "en"): Promise<void> {
  const spacing = await page.locator("form").evaluate((form, otherMethodsLabel) => {
    const username = form.querySelector<HTMLInputElement>("#login-username");
    const password = form.querySelector<HTMLInputElement>("#login-password");
    const fieldMetrics = (input: HTMLInputElement | null) => {
      const shell = input?.id === "login-username" ? input.parentElement : input?.parentElement?.parentElement;
      const icon = shell?.firstElementChild;
      if (!input || !shell || !icon) return null;
      const inputRect = input.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      const iconRect = icon.getBoundingClientRect();
      const textStart = inputRect.left + Number.parseFloat(getComputedStyle(input).paddingLeft);
      return { textInset: textStart - shellRect.left, iconGap: textStart - iconRect.right, bottom: inputRect.bottom };
    };
    const usernameMetrics = fieldMetrics(username);
    const passwordMetrics = fieldMetrics(password);
    const recover = form.querySelector<HTMLAnchorElement>('a[href="/recover"]');
    const recoverRect = recover?.getBoundingClientRect();
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const submitRect = submit?.getBoundingClientRect();
    const nextAction = submit?.parentElement?.firstElementChild;
    const nextRect = nextAction?.getBoundingClientRect();
    const register = form.querySelector<HTMLAnchorElement>('a[href="/register"]');
    const registerRect = register?.parentElement?.getBoundingClientRect();
    const divider = Array.from(form.querySelectorAll("div")).find((element) => element.textContent?.trim() === otherMethodsLabel);
    const dividerRect = divider?.getBoundingClientRect();
    const providerRect = divider?.nextElementSibling?.getBoundingClientRect();
    return {
      username: usernameMetrics,
      password: passwordMetrics,
      recoverTopGap: passwordMetrics && recoverRect ? recoverRect.top - passwordMetrics.bottom : null,
      recoverBottomGap: recoverRect && nextRect ? nextRect.top - recoverRect.bottom : null,
      submitPromptGap: submitRect && registerRect ? registerRect.top - submitRect.bottom : null,
      promptDividerGap: registerRect && dividerRect ? dividerRect.top - registerRect.bottom : null,
      dividerProviderGap: dividerRect && providerRect ? providerRect.top - dividerRect.bottom : null,
    };
  }, loginText("其他登录方式", language));

  expect(spacing.username, "username input and its leading icon should be measurable").not.toBeNull();
  expect(spacing.password, "password input and its leading icon should be measurable").not.toBeNull();
  if (!spacing.username || !spacing.password) return;
  expect(Math.abs(spacing.username.textInset - spacing.password.textInset), "username and password text should start at the same inset").toBeLessThanOrEqual(0.5);
  expect(spacing.username.iconGap, "username icon should have breathing room before the text").toBeGreaterThanOrEqual(10);
  expect(spacing.password.iconGap, "password icon should have breathing room before the text").toBeGreaterThanOrEqual(10);
  expect(spacing.recoverTopGap, "password field should be separated from the recovery link").toBeGreaterThanOrEqual(8);
  expect(spacing.recoverBottomGap, "recovery link should be separated from the next action").toBeGreaterThanOrEqual(12);
  expect(spacing.submitPromptGap, "submit button should be separated from the create-account prompt").toBeGreaterThanOrEqual(12);
  expect(spacing.promptDividerGap, "create-account prompt should be separated from the provider divider").toBeGreaterThanOrEqual(16);
  expect(spacing.dividerProviderGap, "provider action should be separated from its divider").toBeGreaterThanOrEqual(12);
}

async function checkErrorStateLayout(page: Page, language: "zh-CN" | "en", theme: "light" | "dark"): Promise<void> {
  const languageName = language === "en" ? "en" : "zh-CN";
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await expect(page.locator("html")).toHaveAttribute("lang", languageName);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.getByRole("heading", { name: loginText("登录 AI Project OS", language), exact: true })).toBeVisible();
    await expect(page.locator("#login-username")).toHaveValue(/browser-login-/u);
    await expect(page.locator("#login-password")).toHaveValue("IncorrectBrowserPassword!");
    await expect(page.locator("form").getByRole("alert")).toHaveText(loginText("用户名或密码错误", language));
    await expectR02NoHorizontalOverflow(page, `login error at ${width}px (${language}/${theme})`);
    await page.locator(".appearance-controls-trigger").hover();
    await expectR02NoAccessibilityViolations(page, `login error at ${width}px (${language}/${theme})`);
    expect(await expectIconOnlyAlignment(page.locator("#login-password").locator(".."), `login error at ${width}px (${language}/${theme})`)).toBe(1);
    await expect(page.locator("main h1")).toHaveCount(1);
    await expect(page.locator("main h1")).toHaveText(loginText("登录 AI Project OS", language));
    await expect(page.locator("main h1")).toBeVisible();
    await expect(page.getByRole("link", { name: loginText("创建账号", language), exact: true })).toHaveAttribute("href", "/register");
    await expect(page.getByRole("link", { name: loginText("忘记账号或密码？", language), exact: true })).toHaveAttribute("href", "/recover");
    await expectLoginFieldAndActionSpacing(page, language);
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
  await page.setViewportSize({ width: 390, height: 844 });
  await expectLoginFieldAndActionSpacing(page, "zh-CN");
  await page.screenshot({ path: "test-results/v110/login-normal-zh-CN-light-390.png", fullPage: true });
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
