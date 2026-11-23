import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { createWorkspaceInvitation } from "@/lib/workspaces";
import { getDb } from "@/lib/db";
import { installBrowserPhoneAuthConfigFixture } from "./support/browser-phone-auth-config-fixture";
import { expectR02NoHorizontalOverflow, signInR02Admin, signOutR02User } from "./support/r02-admin-navigation";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";

const PUBLIC_PAGE_TITLES = [
  { path: "/help", chinese: "帮助文档", english: "Help documentation" },
  { path: "/contact", chinese: "联系作者", english: "Contact" },
  { path: "/privacy", chinese: "隐私政策", english: "Privacy policy" },
  { path: "/terms", chinese: "服务条款", english: "Terms of service" },
] as const;

async function chooseLanguage(page: Page, language: "zh-CN" | "en") {
  await page.locator(".appearance-controls-trigger").click();
  const appearance = page.locator(".appearance-controls-popover");
  await appearance.getByRole("combobox").nth(0).selectOption(language);
  await page.keyboard.press("Escape");
}

test("public page titles follow the active language before and after switching", async ({ page }) => {
  for (const route of PUBLIC_PAGE_TITLES) {
    await page.context().clearCookies();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(route.path);
    await expect(page).toHaveTitle(`${route.chinese} · AI Project OS`);
    await expect(page.locator("main h1")).toBeVisible();
    await chooseLanguage(page, "en");
    await expect(page).toHaveTitle(`${route.english} · AI Project OS`);
    await chooseLanguage(page, "zh-CN");
    await expect(page).toHaveTitle(`${route.chinese} · AI Project OS`);
    await expectR02NoHorizontalOverflow(page, `${route.path} language selector at 390px`);
  }
});

test("invitation return target survives login and registration without auto-accepting", async ({ page }) => {
  test.skip(process.env.PHONE_AUTH_ENABLED === "true" || process.env.AI_PROJECT_OS_EMAIL_AUTH_ENABLED === "true", "Username registration requires the password-only test configuration.");
  await signInR02Admin(page);
  await signOutR02User(page);
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedBrowserPersonalUser(`invite-owner-${suffix}`, "BrowserInviteOwner2026!");
  const invitation = await createWorkspaceInvitation(owner.workspaceId, {
    email: `invite-${suffix}@example.test`, workspaceRole: "member", requestKey: randomUUID(),
  }, { id: owner.id, role: "user", accountAccessVersion: 1 });
  const { token, acceptPath: invitationPath } = invitation;
  if (!token || !invitationPath) throw new Error("Expected a freshly issued invitation");
  const acceptanceRequests: string[] = [];
  page.on("request", request => {
    if (request.url().endsWith("/api/workspace-invitations/accept")) acceptanceRequests.push(request.method());
  });

  await page.goto(invitationPath);
  await expect(page).toHaveURL(/\/login\?/u);
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe(invitationPath);
  const registrationLink = page.getByRole("link", { name: "创建账号", exact: true });
  expect(new URL(await registrationLink.getAttribute("href") ?? "", page.url()).searchParams.get("returnTo")).toBe(invitationPath);
  await registrationLink.click();
  await expect(page).toHaveURL(/\/register\?/u);
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe(invitationPath);
  const backToLogin = page.getByRole("link", { name: "返回登录", exact: true });
  expect(new URL(await backToLogin.getAttribute("href") ?? "", page.url()).searchParams.get("returnTo")).toBe(invitationPath);

  const username = `invite_return_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const password = "BrowserInviteReturn2026!";
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByLabel("确认密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();

  await expect.poll(() => new URL(page.url()).pathname).toBe("/accept-invitation");
  expect(new URL(page.url()).searchParams.get("token")).toBe(token);
  await expect(page.getByRole("heading", { name: "加入工作区", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "接受邀请", exact: true })).toBeVisible();
  expect(acceptanceRequests).toEqual([]);
  const stored = await getDb().workspaceInvitation.findUniqueOrThrow({
    where: { id: invitation.invitation.id }, select: { acceptedAt: true, acceptedById: true },
  });
  expect(stored).toEqual({ acceptedAt: null, acceptedById: null });
});

test("help and contact guide links preserve anonymous return and remain direct when signed in", async ({ page }) => {
  const user = await seedBrowserPersonalUser(`guide_return_${randomUUID().replaceAll("-", "").slice(0, 12)}`, "BrowserGuideReturn2026!");

  await page.goto("/help");
  const helpGuideLink = page.getByRole("link", { name: "登录后查看完整指南", exact: true });
  await expect(helpGuideLink).toHaveAttribute("href", "/guide");
  await helpGuideLink.click();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fguide$/u);

  await page.goto("/contact");
  const contactGuideLink = page.getByRole("link", { name: "打开操作指南 →", exact: true });
  await expect(contactGuideLink).toHaveAttribute("href", "/guide");
  await contactGuideLink.click();
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fguide$/u);
  await page.getByLabel(/^(?:用户名或手机号|用户名、手机号或已验证邮箱)$/u).fill(user.username);
  await page.getByLabel("密码", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "登 录", exact: true }).click();
  await expect(page).toHaveURL(/\/guide$/u);
  await expect(page.getByRole("heading", { name: "普通用户操作指南", exact: true })).toBeVisible();

  await page.goto("/help");
  await page.getByRole("link", { name: "登录后查看完整指南", exact: true }).click();
  await expect(page).toHaveURL(/\/guide$/u);
  await page.goto("/contact");
  await page.getByRole("link", { name: "打开操作指南 →", exact: true }).click();
  await expect(page).toHaveURL(/\/guide$/u);
});

test("phone auth form accepts native clipboard paste before normalization", async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(process.env.PHONE_AUTH_ENABLED !== "true", "Requires the guarded isolated phone-auth database and app configuration; this case sends no SMS request.");
  await signInR02Admin(page);
  await signOutR02User(page);
  const restorePhoneConfig = await installBrowserPhoneAuthConfigFixture();
  try {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/recover");
    const phone = page.locator("#recover-phone");
    await expect(phone).toBeEnabled();
    expect(await phone.evaluate((input: HTMLInputElement) => input.maxLength)).toBe(-1);

    for (const pasted of ["13800138000", "+8613800138000", "138 0013 8000"]) {
      await phone.fill("");
      await page.evaluate(async value => navigator.clipboard.writeText(value), pasted);
      await phone.click();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
      await expect(phone).toHaveValue("13800138000");
      expect(await phone.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(true);
    }
  } finally {
    await restorePhoneConfig();
  }
});
