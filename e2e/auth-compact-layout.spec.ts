import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { englishUiMessages } from "@/lib/ui-dictionary-source";
import {
  expectR02NoAccessibilityViolations,
  expectR02NoHorizontalOverflow,
  signInR02Admin,
  signOutR02User,
} from "./support/r02-admin-navigation";
import { installBrowserPhoneAuthConfigFixture } from "./support/browser-phone-auth-config-fixture";

const AUTH_LAYOUT_VIEWPORTS = [
  { name: "desktop", width: 1280, height: 720 },
  { name: "mobile", width: 390, height: 844 },
] as const;

const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jcWQAAAAASUVORK5CYII=";

async function setEnglishDarkAndOpen(page: Page, route: "/register" | "/recover"): Promise<void> {
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([
    { name: "aipos-language", value: "en", url: origin },
    { name: "aipos-theme", value: "dark", url: origin },
  ]);
  await page.goto(route);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
}

async function checkAuthStepLayout(page: Page, flow: string, step: 1 | 2): Promise<void> {
  await mkdir("test-results/auth-compact-layout", { recursive: true });
  for (const viewport of AUTH_LAYOUT_VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expectR02NoHorizontalOverflow(page, `${flow} step ${step}, ${viewport.name}`);
    const dimensions = await page.evaluate(() => ({
      documentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
      documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      viewportHeight: document.documentElement.clientHeight,
      viewportWidth: document.documentElement.clientWidth,
    }));
    expect(dimensions.documentWidth, `${flow} step ${step} must not overflow horizontally at ${viewport.width}px`).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
    expect(dimensions.documentHeight, `${flow} step ${step} default content should fit at ${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(dimensions.viewportHeight + 2);
    await expect.poll(() => page.locator("main > header").evaluate(element => element.getBoundingClientRect().top), {
      message: `${flow} step ${step} header should remain in view after resizing`,
    }).toBeGreaterThanOrEqual(-1);
    await expectR02NoAccessibilityViolations(page, `${flow} step ${step}, ${viewport.name}, English dark`);
    await page.screenshot({
      path: `test-results/auth-compact-layout/${flow}-step-${step}-${viewport.width}x${viewport.height}.png`,
      fullPage: true,
    });
  }
}

async function mockEmailVerification(page: Page) {
  const calls = { captcha: 0, send: 0, finalSubmit: 0 };
  await page.route("**/api/auth/email/captcha", async route => {
    calls.captcha += 1;
    await route.fulfill({ json: { challengeId: randomUUID(), image: TINY_PNG, expiresInSeconds: 300 } });
  });
  await page.route("**/api/auth/email/send", async route => {
    calls.send += 1;
    await route.fulfill({ json: { challengeId: randomUUID(), retryAfterSeconds: 60 } });
  });
  await page.route("**/api/auth/register", async route => {
    calls.finalSubmit += 1;
    await route.fulfill({ status: 500, json: { error: { message: "Unexpected registration submit in layout test." } } });
  });
  return calls;
}

async function mockSmsVerification(page: Page) {
  const calls = { captcha: 0, send: 0, finalSubmit: 0 };
  await page.route("**/api/auth/sms/captcha", async route => {
    calls.captcha += 1;
    await route.fulfill({ json: { challengeId: randomUUID(), image: TINY_PNG, expiresInSeconds: 300 } });
  });
  await page.route("**/api/auth/sms/send", async route => {
    calls.send += 1;
    await route.fulfill({ json: { challengeId: randomUUID(), retryAfterSeconds: 60 } });
  });
  await page.route("**/api/auth/recovery", async route => {
    calls.finalSubmit += 1;
    await route.fulfill({ status: 500, json: { error: { message: "Unexpected recovery submit in layout test." } } });
  });
  return calls;
}

test("email registration steps fit desktop and mobile viewports in English dark mode", async ({ page }) => {
  test.skip(process.env.AI_PROJECT_OS_EMAIL_AUTH_ENABLED !== "true", "Requires the enabled local email-auth configuration; captcha and send routes are intercepted.");

  await signInR02Admin(page);
  await signOutR02User(page);
  const calls = await mockEmailVerification(page);
  await setEnglishDarkAndOpen(page, "/register");

  const email = page.locator("#register-email");
  const code = page.locator("#register-email-code");
  await expect(page.getByRole("heading", { name: "Create an account", exact: true })).toBeVisible();
  await expect(email).toBeEnabled();
  await expect(code).toBeEnabled();
  await email.fill("layout@example.com");
  const captcha = page.getByRole("dialog", { name: "Security check", exact: true });
  await page.getByRole("button", { name: "Get code", exact: true }).click();
  await expect(captcha).toBeVisible();
  await captcha.getByLabel("Verification code", { exact: true }).fill("ABC123");
  await captcha.getByRole("button", { name: "Verify and send email", exact: true }).click();
  await expect(captcha).toBeHidden();
  await expect.poll(() => calls.send).toBe(1);
  await code.fill("123456");
  await checkAuthStepLayout(page, "register", 1);

  await page.getByRole("button", { name: "Continue to account details", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Set up your account", exact: true })).toBeVisible();
  await expect(page.getByLabel("Username", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Confirm password", { exact: true })).toBeVisible();
  await checkAuthStepLayout(page, "register", 2);

  expect(calls).toMatchObject({ captcha: 1, send: 1, finalSubmit: 0 });
});

test("phone recovery steps fit desktop and mobile viewports in English dark mode", async ({ page }) => {
  test.skip(process.env.PHONE_AUTH_ENABLED !== "true", "Requires the guarded local phone-auth fixture; captcha and send routes are intercepted.");

  await signInR02Admin(page);
  await signOutR02User(page);
  const restorePhoneConfig = await installBrowserPhoneAuthConfigFixture();
  try {
    const calls = await mockSmsVerification(page);
    await setEnglishDarkAndOpen(page, "/recover");

    const phone = page.locator("#recover-phone");
    const code = page.locator("#recover-code");
    await expect(page.getByRole("heading", { name: "Recover your account and password", exact: true })).toBeVisible();
    await expect(phone).toBeEnabled();
    await expect(code).toBeEnabled();
    await phone.fill("13800138000");
    const captcha = page.getByRole("dialog", { name: "Security check", exact: true });
    await page.getByRole("button", { name: "Get code", exact: true }).click();
    await expect(captcha).toBeVisible();
    await captcha.getByLabel("Verification code", { exact: true }).fill("ABC123");
    await captcha.getByRole("button", { name: "Verify and send SMS", exact: true }).click();
    await expect(captcha).toBeHidden();
    await expect.poll(() => calls.send).toBe(1);
    await code.fill("123456");
    await checkAuthStepLayout(page, "recover", 1);

    await page.getByRole("button", { name: "Continue to new password", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Set a new password", exact: true })).toBeVisible();
    await expect(page.getByLabel("New password", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Re-enter your new password", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: englishUiMessages["修改"], exact: true })).toBeVisible();
    await checkAuthStepLayout(page, "recover", 2);

    expect(calls).toMatchObject({ captcha: 1, send: 1, finalSubmit: 0 });
  } finally {
    await restorePhoneConfig();
  }
});
