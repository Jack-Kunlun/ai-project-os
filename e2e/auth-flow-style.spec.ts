import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { getEntitlementDb } from "@/lib/db";
import { installBrowserPhoneAuthConfigFixture } from "./support/browser-phone-auth-config-fixture";
import { expectR02NoAccessibilityViolations, expectR02NoHorizontalOverflow, signInR02Admin, signOutR02User } from "./support/r02-admin-navigation";

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
  test.skip(process.env.PHONE_AUTH_ENABLED === "true" || process.env.AI_PROJECT_OS_EMAIL_AUTH_ENABLED === "true", "This real legacy registration case requires all verification channels disabled.");
  await signInR02Admin(page);
  await signOutR02User(page);
  await page.getByRole("link", { name: "创建账号", exact: true }).click();
  await expect(page.getByRole("heading", { name: "创建账号", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "返回登录", exact: true })).toHaveAttribute("href", "/login");
  await checkAuthLayout(page, "register");

  const usernameInput = page.getByLabel("用户名", { exact: true });
  await usernameInput.fill("valid-name.01");
  expect(await usernameInput.evaluate((element: HTMLInputElement) => element.checkValidity())).toBe(true);
  await usernameInput.fill("invalid!name");
  expect(await usernameInput.evaluate((element: HTMLInputElement) => element.validity.patternMismatch)).toBe(true);
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

test("email registration stays local until the final submit and preserves the challenge while editing", async ({ page }) => {
  await signInR02Admin(page);
  await signOutR02User(page);

  const sentEmails: Array<{ email?: string; purpose?: string }> = [];
  const issuedChallengeIds: string[] = [];
  const registrations: Array<{ username?: string; method?: string; email?: string; challengeId?: string; code?: string; remember?: boolean }> = [];
  await page.route("**/api/auth/email/captcha", async route => {
    await route.fulfill({ json: {
      challengeId: randomUUID(),
      image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jcWQAAAAASUVORK5CYII=",
      expiresInSeconds: 300,
    } });
  });
  await page.route("**/api/auth/email/send", async route => {
    const body = route.request().postDataJSON() as { email?: string; purpose?: string };
    sentEmails.push(body);
    const challengeId = randomUUID();
    issuedChallengeIds.push(challengeId);
    await route.fulfill({ json: { challengeId, retryAfterSeconds: 60 } });
  });
  await page.route("**/api/auth/register", async route => {
    registrations.push(route.request().postDataJSON() as typeof registrations[number]);
    await route.fulfill({ status: 201, contentType: "application/json", body: "{}" });
  });

  await page.goto("/register");
  const email = page.locator("#register-email");
  const code = page.locator("#register-email-code");
  test.skip(await email.count() !== 1 || await code.isDisabled(), "Requires an enabled email registration channel; all external email calls are intercepted.");

  await email.fill("first@example.com");
  await page.getByRole("button", { name: "继续设置账号", exact: true }).click();
  await expect(page.locator("form").getByRole("alert")).toHaveText("请先获取并填写邮箱验证码。");
  expect(registrations).toHaveLength(0);

  const captcha = page.getByRole("dialog", { name: "安全验证", exact: true });
  const sendCode = page.locator("#register-email-code + button");
  await sendCode.click();
  await expect(captcha).toBeVisible();
  // Exercise an identifier prop change while a native dialog is open (for
  // example, an autofill update); the old dialog must be disposed immediately.
  await email.evaluate((element: HTMLInputElement) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setValue) throw new Error("INPUT_VALUE_SETTER_REQUIRED");
    setValue.call(element, "changed-before-send@example.com");
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(captcha).toBeHidden();
  await expect(code).toHaveValue("");
  expect(sentEmails).toHaveLength(0);
  await email.fill("first@example.com");
  await sendCode.click();
  await expect(captcha).toBeVisible();
  await captcha.getByLabel("验证码", { exact: true }).fill("ABC123");
  await captcha.getByRole("button", { name: "验证并发送邮件", exact: true }).click();
  await expect(captcha).toBeHidden();
  await expect.poll(() => sentEmails.length).toBe(1);
  await expect(sendCode).toBeDisabled();
  await code.fill("123456");
  await page.getByRole("button", { name: "继续设置账号", exact: true }).click();
  await expect(page.getByText("待验证邮箱", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "修改", exact: true }).click();
  await expect(email).toHaveValue("first@example.com");
  await expect(code).toHaveValue("123456");
  await expect(sendCode).toBeDisabled();
  await email.fill("second@example.com");
  await expect(code).toHaveValue("");
  await page.getByRole("button", { name: "继续设置账号", exact: true }).click();
  await expect(page.locator("form").getByRole("alert")).toHaveText("请先获取并填写邮箱验证码。");
  expect(registrations).toHaveLength(0);

  const secondSendCode = page.getByRole("button", { name: "获取验证码", exact: true });
  await secondSendCode.click();
  await expect(captcha).toBeVisible();
  await captcha.getByLabel("验证码", { exact: true }).fill("ABC123");
  await captcha.getByRole("button", { name: "验证并发送邮件", exact: true }).click();
  await expect(captcha).toBeHidden();
  await expect.poll(() => sentEmails.length).toBe(2);
  await code.fill("654321");
  await page.getByRole("button", { name: "继续设置账号", exact: true }).click();

  await page.getByLabel("用户名", { exact: true }).fill("email_flow_owner");
  await page.getByLabel("密码", { exact: true }).fill("BrowserAuthFlow2026!");
  await page.getByLabel("确认密码", { exact: true }).fill("BrowserAuthFlow2026!");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await expect.poll(() => registrations.length).toBe(1);
  expect(registrations[0]).toMatchObject({
    username: "email_flow_owner",
    method: "email",
    email: "second@example.com",
    code: "654321",
    remember: true,
  });
  expect(registrations[0]?.challengeId).toBe(issuedChallengeIds[1]);
  expect(sentEmails.map(request => request.email)).toEqual(["first@example.com", "second@example.com"]);
});

test("phone registration remains local until final submit and clears the challenge when the phone changes", async ({ page }) => {
  test.skip(process.env.PHONE_AUTH_ENABLED !== "true", "Requires the guarded local phone-auth environment; all SMS endpoints are intercepted.");
  await signInR02Admin(page);
  await signOutR02User(page);

  const restorePhoneConfig = await installBrowserPhoneAuthConfigFixture();
  try {
  const sentSms: Array<{ phone?: string; purpose?: string }> = [];
  const issuedChallengeIds: string[] = [];
  const registrations: Array<{ username?: string; phone?: string; challengeId?: string; code?: string; remember?: boolean }> = [];
  await page.route("**/api/auth/sms/captcha", async route => {
    await route.fulfill({ json: {
      challengeId: randomUUID(),
      image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jcWQAAAAASUVORK5CYII=",
      expiresInSeconds: 300,
    } });
  });
  await page.route("**/api/auth/sms/send", async route => {
    const body = route.request().postDataJSON() as { phone?: string; purpose?: string };
    sentSms.push(body);
    const challengeId = randomUUID();
    issuedChallengeIds.push(challengeId);
    await route.fulfill({ json: { challengeId, retryAfterSeconds: 60 } });
  });
  await page.route("**/api/auth/register", async route => {
    registrations.push(route.request().postDataJSON() as typeof registrations[number]);
    await route.fulfill({ status: 201, contentType: "application/json", body: "{}" });
  });

  await page.goto("/register");
  const phone = page.locator("#register-phone");
  const code = page.locator("#register-sms-code");
  const methods = page.locator('input[name="registration-method"]');
  if (await methods.count() === 2) await methods.nth(1).check();
  await expect(phone).toHaveCount(1);
  await expect(phone).toBeEnabled();
  await expect(code).toBeEnabled();

  await phone.fill("13800138000");
  await page.getByRole("button", { name: "继续设置账号", exact: true }).click();
  await expect(page.locator("form").getByRole("alert")).toHaveText("请先获取并填写短信验证码。");
  expect(registrations).toHaveLength(0);

  const captcha = page.getByRole("dialog", { name: "安全验证", exact: true });
  const sendCode = page.locator("#register-sms-code + button");
  await sendCode.click();
  await expect(captcha).toBeVisible();
  await captcha.getByLabel("验证码", { exact: true }).fill("ABC123");
  await captcha.getByRole("button", { name: "验证并发送短信", exact: true }).click();
  await expect(captcha).toBeHidden();
  await expect.poll(() => sentSms.length).toBe(1);
  await expect(sendCode).toBeDisabled();
  await code.fill("123456");
  await page.getByRole("button", { name: "继续设置账号", exact: true }).click();
  await expect(page.getByText("待验证手机号", { exact: true })).toBeVisible();
  expect(registrations).toHaveLength(0);

  await page.getByRole("button", { name: "修改", exact: true }).click();
  await expect(phone).toHaveValue("13800138000");
  await expect(code).toHaveValue("123456");
  await expect(sendCode).toBeDisabled();
  await phone.fill("13800138001");
  await expect(code).toHaveValue("");
  await page.getByRole("button", { name: "继续设置账号", exact: true }).click();
  await expect(page.locator("form").getByRole("alert")).toHaveText("请先获取并填写短信验证码。");
  expect(registrations).toHaveLength(0);

  const secondSendCode = page.getByRole("button", { name: "获取验证码", exact: true });
  await secondSendCode.click();
  await expect(captcha).toBeVisible();
  await captcha.getByLabel("验证码", { exact: true }).fill("ABC123");
  await captcha.getByRole("button", { name: "验证并发送短信", exact: true }).click();
  await expect(captcha).toBeHidden();
  await expect.poll(() => sentSms.length).toBe(2);
  await code.fill("654321");
  await page.getByRole("button", { name: "继续设置账号", exact: true }).click();

  await page.getByLabel("用户名", { exact: true }).fill("phone_flow_owner");
  await page.getByLabel("密码", { exact: true }).fill("BrowserPhoneFlow2026!");
  await page.getByLabel("确认密码", { exact: true }).fill("BrowserPhoneFlow2026!");
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await expect.poll(() => registrations.length).toBe(1);
  expect(registrations[0]).toMatchObject({
    username: "phone_flow_owner",
    phone: "+8613800138001",
    challengeId: issuedChallengeIds[1],
    code: "654321",
    remember: true,
  });
  expect(sentSms.map(request => request.phone)).toEqual(["+8613800138000", "+8613800138001"]);
  expect(sentSms.every(request => request.purpose === "register")).toBe(true);
  } finally {
    await restorePhoneConfig();
  }
});

test("phone recovery stays local until final submit and preserves the challenge while editing", async ({ page }) => {
  test.skip(process.env.PHONE_AUTH_ENABLED !== "true", "Requires the guarded local phone-auth environment; all SMS endpoints are intercepted.");
  await signInR02Admin(page);
  await signOutR02User(page);

  const restorePhoneConfig = await installBrowserPhoneAuthConfigFixture();
  try {
  const sentSms: Array<{ phone?: string; purpose?: string }> = [];
  const issuedChallengeIds: string[] = [];
  const recoveries: Array<{ phone?: string; challengeId?: string; code?: string; newPassword?: string }> = [];
  await page.route("**/api/auth/sms/captcha", async route => {
    await route.fulfill({ json: {
      challengeId: randomUUID(),
      image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jcWQAAAAASUVORK5CYII=",
      expiresInSeconds: 300,
    } });
  });
  await page.route("**/api/auth/sms/send", async route => {
    const body = route.request().postDataJSON() as { phone?: string; purpose?: string };
    sentSms.push(body);
    const challengeId = randomUUID();
    issuedChallengeIds.push(challengeId);
    await route.fulfill({ json: { challengeId, retryAfterSeconds: 60 } });
  });
  await page.route("**/api/auth/recovery", async route => {
    recoveries.push(route.request().postDataJSON() as typeof recoveries[number]);
    await route.fulfill({ status: 200, json: { username: "recovered_owner" } });
  });

  await page.goto("/recover");
  const phone = page.locator("#recover-phone");
  const code = page.locator("#recover-code");
  await expect(phone).toHaveCount(1);
  await expect(phone).toBeEnabled();
  await expect(code).toBeEnabled();

  await phone.fill("13800138000");
  await page.getByRole("button", { name: "继续设置新密码", exact: true }).click();
  await expect(page.locator("form").getByRole("alert")).toHaveText("请先获取并填写短信验证码。");
  expect(recoveries).toHaveLength(0);

  const captcha = page.getByRole("dialog", { name: "安全验证", exact: true });
  const sendCode = page.locator("#recover-code + button");
  await sendCode.click();
  await expect(captcha).toBeVisible();
  await captcha.getByLabel("验证码", { exact: true }).fill("ABC123");
  await captcha.getByRole("button", { name: "验证并发送短信", exact: true }).click();
  await expect(captcha).toBeHidden();
  await expect.poll(() => sentSms.length).toBe(1);
  await expect(sendCode).toBeDisabled();
  await code.fill("123456");
  await page.getByRole("button", { name: "继续设置新密码", exact: true }).click();
  await expect(page.getByText("待验证手机号", { exact: true })).toBeVisible();
  expect(recoveries).toHaveLength(0);

  await page.getByRole("button", { name: "修改", exact: true }).click();
  await expect(phone).toHaveValue("13800138000");
  await expect(code).toHaveValue("123456");
  await expect(sendCode).toBeDisabled();
  await phone.fill("13800138001");
  await expect(code).toHaveValue("");
  await page.getByRole("button", { name: "继续设置新密码", exact: true }).click();
  await expect(page.locator("form").getByRole("alert")).toHaveText("请先获取并填写短信验证码。");
  expect(recoveries).toHaveLength(0);

  const secondSendCode = page.getByRole("button", { name: "获取验证码", exact: true });
  await secondSendCode.click();
  await expect(captcha).toBeVisible();
  await captcha.getByLabel("验证码", { exact: true }).fill("ABC123");
  await captcha.getByRole("button", { name: "验证并发送短信", exact: true }).click();
  await expect(captcha).toBeHidden();
  await expect.poll(() => sentSms.length).toBe(2);
  await code.fill("654321");
  await page.getByRole("button", { name: "继续设置新密码", exact: true }).click();

  await page.getByLabel("新密码", { exact: true }).fill("BrowserRecovery2026!");
  await page.getByLabel("再次输入新密码", { exact: true }).fill("BrowserRecovery2026!");
  await page.getByRole("button", { name: "验证并重设密码", exact: true }).click();
  await expect.poll(() => recoveries.length).toBe(1);
  expect(recoveries[0]).toEqual({
    phone: "+8613800138001",
    challengeId: issuedChallengeIds[1],
    code: "654321",
    newPassword: "BrowserRecovery2026!",
  });
  expect(sentSms.map(request => request.phone)).toEqual(["+8613800138000", "+8613800138001"]);
  expect(sentSms.every(request => request.purpose === "recover")).toBe(true);
  await expect(page.getByRole("status").getByText("recovered_owner", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("所有设备已退出登录，请使用新密码重新登录。");
  } finally {
    await restorePhoneConfig();
  }
});

test("unavailable phone recovery keeps its controls disabled and returns to the same login experience", async ({ page }) => {
  test.skip(process.env.PHONE_AUTH_ENABLED === "true", "The unavailable-phone baseline runs with phone auth disabled.");
  await signInR02Admin(page);
  await signOutR02User(page);
  await page.getByRole("link", { name: "忘记账号或密码？", exact: true }).click();
  await expect(page.getByRole("heading", { name: "找回账号与密码", exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "短信找回暂不可用" })).toBeVisible();
  await expect(page.locator("#recover-phone")).toBeDisabled();
  await expect(page.locator("#recover-code")).toBeDisabled();
  await expect(page.locator("#recover-password")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "验证并重设密码", exact: true })).toHaveCount(0);
  await checkAuthLayout(page, "recover-unavailable");
  await page.getByRole("link", { name: "返回登录", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/u);
  await expect(page.getByRole("heading", { name: "登录 AI Project OS", exact: true })).toBeVisible();
});
