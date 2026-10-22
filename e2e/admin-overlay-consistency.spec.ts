import { expect, test, type Locator, type Page } from "@playwright/test";
import { englishUiMessages } from "../src/lib/ui-dictionary-source";
import { expectR02NoHorizontalOverflow, signInR02Admin } from "./support/r02-admin-navigation";

type AdminProfileFixture = {
  username: "browser_admin",
  displayName: "Browser Admin",
  email: "browser-admin@example.invalid",
  emailVerifiedAt: null,
  hasLocalPassword: boolean,
  phoneE164: string | null,
  phoneAuthStatus: "disabled" | "unavailable" | "available";
  activeSessionCount: 1,
  lastSeenAt: null,
};

const ADMIN_PROFILE: AdminProfileFixture = {
  username: "browser_admin",
  displayName: "Browser Admin",
  email: "browser-admin@example.invalid",
  emailVerifiedAt: null,
  hasLocalPassword: true,
  phoneE164: "+8613800138000",
  phoneAuthStatus: "available",
  activeSessionCount: 1,
  lastSeenAt: null,
};

const MEMBERSHIP_FIXTURES = [
  {
    id: "83000000-0000-4000-8000-000000000001",
    username: "grant-fixture",
    displayName: "Grant Fixture",
    role: "user" as const,
    disabledAt: null,
    membershipSubscription: null,
    membershipApplication: null,
  },
  {
    id: "83000000-0000-4000-8000-000000000002",
    username: "extend-fixture",
    displayName: "Extend Fixture",
    role: "user" as const,
    disabledAt: null,
    membershipSubscription: {
      id: "83000000-0000-4000-8000-000000000012",
      userId: "83000000-0000-4000-8000-000000000002",
      status: "active" as const,
      startsAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2030-10-01T00:00:00.000Z",
      revokedAt: null,
      version: 4,
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
    membershipApplication: null,
  },
] as const;

const DETAIL_USER_ID = "83000000-0000-4000-8000-000000000003";
const PREVIEW_ISSUED_AT = "2026-10-22T00:00:00.000Z";
const PREVIEW_EXPIRES_AT = "2026-10-22T00:10:00.000Z";

const CAPTCHA_IDS = {
  "change-old": "4ab8d9e1-e5da-4a98-8054-324958caa001",
  "change-new": "4ab8d9e1-e5da-4a98-8054-324958caa002",
} as const;

function translated(text: string): string {
  return englishUiMessages[text] ?? text;
}

async function openOperation(page: Page, label: string, title: string): Promise<{ trigger: Locator; dialog: Locator }> {
  const trigger = page.getByRole("button", { name: translated(label), exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: translated(title), exact: true });
  await expect(dialog).toBeVisible();
  return { trigger, dialog };
}

async function closeOperation(trigger: Locator, dialog: Locator): Promise<void> {
  await dialog.getByRole("button", { name: translated("关闭窗口"), exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
}

async function expectModalGeometry(dialog: Locator, viewportWidth: number): Promise<void> {
  const geometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const heading = element.querySelector<HTMLElement>("[data-operation-header] h2");
    const close = element.querySelector<HTMLElement>("[data-dialog-close]");
    const icon = close?.querySelector("svg");
    if (!heading || !close || !icon) throw new Error("ADMIN_OPERATION_GEOMETRY_ELEMENTS_MISSING");
    const closeRect = close.getBoundingClientRect();
    const iconRect = icon.getBoundingClientRect();
    return {
      width: rect.width,
      left: rect.left,
      right: rect.right,
      titleSize: getComputedStyle(heading).fontSize,
      iconCenterOffsetX: Math.abs((closeRect.left + closeRect.right) / 2 - (iconRect.left + iconRect.right) / 2),
      iconCenterOffsetY: Math.abs((closeRect.top + closeRect.bottom) / 2 - (iconRect.top + iconRect.bottom) / 2),
    };
  });
  expect(geometry.width).toBeLessThanOrEqual(920);
  expect(geometry.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.right).toBeLessThanOrEqual(viewportWidth + 1);
  expect(geometry.titleSize).toBe("17px");
  expect(geometry.iconCenterOffsetX).toBeLessThanOrEqual(1);
  expect(geometry.iconCenterOffsetY).toBeLessThanOrEqual(1);
}

function membershipPreviewFixture(input: { action: "grant" | "extend"; userId: string; expectedVersion: number }) {
  const startsAt = input.action === "extend" ? "2030-10-01T00:00:00.000Z" : PREVIEW_ISSUED_AT;
  const expiresAt = input.action === "extend" ? "2031-10-01T00:00:00.000Z" : "2027-10-22T00:00:00.000Z";
  return {
    action: input.action,
    user: { id: input.userId, username: "fixture-user", disabledAt: null },
    current: {
      state: input.action === "extend" ? "active" : "none",
      version: input.expectedVersion,
      startsAt: input.action === "extend" ? "2026-10-01T00:00:00.000Z" : null,
      expiresAt: input.action === "extend" ? "2030-10-01T00:00:00.000Z" : null,
      status: input.action === "extend" ? "active" : null,
    },
    target: { state: "active", version: input.expectedVersion + 1, startsAt, expiresAt, status: "active", revokedAt: null },
    dependencyStats: {
      nonTerminalPersonalDelegations: 0,
      effectivePersonalRouteSelections: 0,
      publishedPersonalIndexes: 0,
      personalModelAutomationsAffected: 0,
      platformAutomationImpact: "unaffected",
      gitMcpImpact: "unaffected",
    },
    blockingCategories: [],
    canExecute: true,
    impactFingerprint: "ui-test-impact-fingerprint",
    requestFingerprint: "ui-test-request-fingerprint",
    previewId: "83000000-0000-4000-8000-000000000099",
    issuedAt: PREVIEW_ISSUED_AT,
    expiresAt: PREVIEW_EXPIRES_AT,
    previewIssuedAt: PREVIEW_ISSUED_AT,
    previewExpiresAt: PREVIEW_EXPIRES_AT,
    applicationId: null,
  };
}

async function setEnglishDarkAppearance(page: Page): Promise<void> {
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([
    { name: "aipos-language", value: "en", url: origin },
    { name: "aipos-theme", value: "dark", url: origin },
  ]);
}

async function expectSingleLineFooterAction(form: Locator, expectedLabel: string): Promise<void> {
  const geometry = await form.getByRole("button", { name: expectedLabel, exact: true }).evaluate((button) => {
    const footer = button.parentElement;
    if (!footer) throw new Error("ADMIN_FOOTER_ACTION_PARENT_MISSING");
    const range = document.createRange();
    range.selectNodeContents(button);
    const buttonRect = button.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const paragraphRect = footer.querySelector("p")?.getBoundingClientRect() ?? null;
    return {
      label: button.textContent?.trim() ?? "",
      textLineCount: range.getClientRects().length,
      button: { left: buttonRect.left, right: buttonRect.right, top: buttonRect.top, bottom: buttonRect.bottom },
      footer: { left: footerRect.left, right: footerRect.right },
      paragraph: paragraphRect ? { left: paragraphRect.left, right: paragraphRect.right, top: paragraphRect.top, bottom: paragraphRect.bottom } : null,
      viewportWidth: window.innerWidth,
    };
  });
  expect(geometry.label).toBe(expectedLabel);
  expect(geometry.textLineCount).toBe(1);
  expect(geometry.button.left).toBeGreaterThanOrEqual(geometry.footer.left - 1);
  expect(geometry.button.right).toBeLessThanOrEqual(Math.min(geometry.footer.right, geometry.viewportWidth) + 1);
  if (geometry.paragraph) {
    const intersects = geometry.button.left < geometry.paragraph.right
      && geometry.button.right > geometry.paragraph.left
      && geometry.button.top < geometry.paragraph.bottom
      && geometry.button.bottom > geometry.paragraph.top;
    expect(intersects).toBe(false);
  }
}

test("admin profile overlays use shared geometry and phone verification stays inside the modal", async ({ page }) => {
  test.setTimeout(120_000);
  await signInR02Admin(page);
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([
    { name: "aipos-language", value: "en", url: origin },
    { name: "aipos-theme", value: "dark", url: origin },
  ]);

  let accountProfile: AdminProfileFixture = { ...ADMIN_PROFILE };
  const captchaPurposes: string[] = [];
  const captchaPayloads: unknown[] = [];
  const smsPurposes: string[] = [];
  const smsPayloads: unknown[] = [];
  const phonePayloads: unknown[] = [];
  let phoneRequestStarted!: () => void;
  const phoneRequestObserved = new Promise<void>((resolve) => { phoneRequestStarted = resolve; });
  let releasePhoneRequest!: () => void;
  const deferredPhoneResponse = new Promise<void>((resolve) => { releasePhoneRequest = resolve; });

  await page.route("**/api/admin/account", async (route) => {
    if (route.request().method() !== "GET") {
      await route.abort();
      return;
    }
    await route.fulfill({ json: { profile: accountProfile } });
  });
  await page.route("**/api/auth/sms/captcha", async (route) => {
    const body = route.request().postDataJSON() as { purpose?: unknown };
    if (body.purpose !== "change-old" && body.purpose !== "change-new") throw new Error("UNEXPECTED_SMS_CAPTCHA_PURPOSE");
    captchaPurposes.push(body.purpose);
    captchaPayloads.push(body);
    const challengeId = body.purpose === "change-old" ? CAPTCHA_IDS["change-old"] : CAPTCHA_IDS["change-new"];
    await route.fulfill({ json: {
      challengeId,
      image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ3cAAAAASUVORK5CYII=",
      expiresInSeconds: 300,
    } });
  });
  await page.route("**/api/auth/sms/send", async (route) => {
    const body = route.request().postDataJSON() as { purpose?: unknown };
    if (body.purpose !== "change-old" && body.purpose !== "change-new") throw new Error("UNEXPECTED_SMS_SEND_PURPOSE");
    smsPurposes.push(body.purpose);
    smsPayloads.push(body);
    await route.fulfill({ json: { challengeId: CAPTCHA_IDS[body.purpose], retryAfterSeconds: 60 } });
  });
  await page.route("**/api/auth/phone", async (route) => {
    phonePayloads.push(route.request().postDataJSON());
    phoneRequestStarted();
    await deferredPhoneResponse;
    await route.fulfill({ status: 409, json: { error: { code: "CONTROLLED_UI_TEST", message: "Controlled UI test response" } } });
  });

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/admin/account");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("heading", { name: translated("管理员账户"), exact: true })).toBeVisible();
  await expect(page.locator("#phone-new-number")).toHaveCount(0);
  const recentActivity = page.getByText(translated("最近活动"), { exact: true }).locator("xpath=..");
  await expect(recentActivity.locator("p").nth(1)).toHaveText(translated("暂无记录"));
  const phoneSection = page.getByRole("heading", { name: translated("绑定手机号"), exact: true }).locator("xpath=..");
  const phoneSectionGap = await phoneSection.evaluate((section) => {
    const previous = section.previousElementSibling;
    if (!previous) throw new Error("ADMIN_PHONE_SECTION_PREVIOUS_SIBLING_MISSING");
    return section.getBoundingClientRect().top - previous.getBoundingClientRect().bottom;
  });
  expect(phoneSectionGap).toBeGreaterThanOrEqual(24);

  let operation = await openOperation(page, "编辑资料", "编辑管理员账户资料");
  await expectModalGeometry(operation.dialog, 1440);
  await page.mouse.click(2, 2);
  await expect(operation.dialog).toBeHidden();
  await expect(operation.trigger).toBeFocused();
  operation = await openOperation(page, "编辑资料", "编辑管理员账户资料");
  await closeOperation(operation.trigger, operation.dialog);

  operation = await openOperation(page, "修改密码", "修改管理员登录密码");
  await expectModalGeometry(operation.dialog, 1440);
  await closeOperation(operation.trigger, operation.dialog);

  operation = await openOperation(page, "更换手机号", "更换手机号");
  await expectModalGeometry(operation.dialog, 1440);
  await expect(operation.dialog.locator("#phone-new-number")).toBeVisible();
  expect(await operation.dialog.innerText()).not.toMatch(/\p{Script=Han}/u);
  await operation.dialog.locator("#phone-new-number").fill("13900000001");
  await closeOperation(operation.trigger, operation.dialog);
  await expect(page.locator("#phone-new-number")).toHaveCount(0);
  expect(captchaPurposes).toEqual([]);
  expect(smsPurposes).toEqual([]);
  expect(phonePayloads).toEqual([]);

  operation = await openOperation(page, "更换手机号", "更换手机号");
  await expect(operation.dialog.locator("#phone-new-number")).toHaveValue("");
  await operation.dialog.locator("#phone-new-number").fill("13900000001");

  const englishGetCode = translated("获取验证码");
  for (const [inputId, code] of [
    ["phone-old-code", "654321"],
    ["phone-new-code", "123456"],
  ] as const) {
    const field = operation.dialog.locator(`#${inputId}`);
    await field.locator("xpath=..").getByRole("button", { name: englishGetCode, exact: true }).click();
    const captcha = page.getByRole("dialog", { name: translated("安全验证"), exact: true });
    await expect(captcha).toBeVisible();
    await captcha.getByLabel(translated("验证码"), { exact: true }).fill("ABC123");
    await captcha.getByRole("button", { name: translated("验证并发送短信"), exact: true }).click();
    await expect(captcha).toBeHidden();
    await field.fill(code);
  }

  await operation.dialog.getByRole("button", { name: translated("确认换绑并重新登录"), exact: true }).click();
  await phoneRequestObserved;
  await expect(operation.dialog.locator("fieldset")).toHaveAttribute("disabled", "");
  await expect(operation.dialog.locator("input").first()).toBeDisabled();
  const closeButton = operation.dialog.getByRole("button", { name: translated("关闭窗口"), exact: true });
  await closeButton.click();
  await expect(operation.dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(operation.dialog).toBeVisible();
  await page.mouse.click(2, 2);
  await expect(operation.dialog).toBeVisible();
  await expect.poll(() => operation.dialog.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  expect(phonePayloads).toEqual([{
    phone: "+8613900000001",
    challengeId: CAPTCHA_IDS["change-new"],
    code: "123456",
    action: "change",
    oldPhone: "+8613800138000",
    oldChallengeId: CAPTCHA_IDS["change-old"],
    oldCode: "654321",
  }]);

  releasePhoneRequest();
  await expect(operation.dialog.getByRole("alert")).toBeVisible();
  await expect(operation.dialog.locator("fieldset")).not.toHaveAttribute("disabled", "");
  await expect(operation.dialog.locator("input").first()).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(operation.dialog).toBeHidden();
  await expect(operation.trigger).toBeFocused();
  await expect(page.locator("#phone-new-number")).toHaveCount(0);
  expect(captchaPurposes).toEqual(["change-old", "change-new"]);
  expect(smsPurposes).toEqual(["change-old", "change-new"]);
  expect(captchaPayloads).toEqual([
    { phone: "+8613800138000", purpose: "change-old" },
    { phone: "+8613900000001", purpose: "change-new" },
  ]);
  expect(smsPayloads).toEqual([
    { phone: "+8613800138000", purpose: "change-old", captcha: { challengeId: CAPTCHA_IDS["change-old"], answer: "ABC123" } },
    { phone: "+8613900000001", purpose: "change-new", captcha: { challengeId: CAPTCHA_IDS["change-new"], answer: "ABC123" } },
  ]);

  for (const [label, title] of [
    ["编辑资料", "编辑管理员账户资料"],
    ["修改密码", "修改管理员登录密码"],
    ["更换手机号", "更换手机号"],
  ] as const) {
    await page.setViewportSize({ width: 390, height: 844 });
    await expectR02NoHorizontalOverflow(page, `admin ${label} before open at 390px English dark`);
    operation = await openOperation(page, label, title);
    await expectModalGeometry(operation.dialog, 390);
    await expectR02NoHorizontalOverflow(page, `admin ${label} overlay at 390px English dark`);
    await closeOperation(operation.trigger, operation.dialog);
  }

  accountProfile = { ...ADMIN_PROFILE, phoneE164: null, hasLocalPassword: false };
  await page.reload();
  const bindButton = page.getByRole("button", { name: translated("绑定手机号"), exact: true });
  await expect(bindButton).toBeDisabled();
  await expect(page.getByText(translated("请先设置本地密码并重新登录，再验证密码和手机号完成绑定。"), { exact: true })).toBeVisible();

  accountProfile = { ...ADMIN_PROFILE, phoneE164: null, hasLocalPassword: true };
  await page.reload();
  const linkPhone = page.getByRole("button", { name: translated("绑定手机号"), exact: true });
  await expect(linkPhone).toBeEnabled();
  const bindOperation = await openOperation(page, "绑定手机号", "绑定手机号");
  await expect(bindOperation.dialog.locator("#phone-current-password")).toBeVisible();
  await expect(bindOperation.dialog.locator("#phone-old-code")).toHaveCount(0);
  await closeOperation(bindOperation.trigger, bindOperation.dialog);

  accountProfile = { ...ADMIN_PROFILE, phoneE164: null, hasLocalPassword: true, phoneAuthStatus: "unavailable" };
  await page.reload();
  await expect(page.getByRole("button", { name: translated("绑定手机号"), exact: true })).toBeDisabled();
});

test("English membership preview copy is complete in list and user detail operations", async ({ page }) => {
  test.setTimeout(120_000);
  await signInR02Admin(page);
  await setEnglishDarkAppearance(page);
  await page.setViewportSize({ width: 390, height: 844 });

  const previewRequests: Array<{ action: string; userId: string }> = [];
  const membershipWrites: string[] = [];
  await page.route((url) => url.pathname === "/api/system/memberships" || url.pathname.startsWith("/api/system/memberships/"), async (route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    if (pathname === "/api/system/memberships" && method === "GET") {
      await route.fulfill({ json: { items: MEMBERSHIP_FIXTURES } });
      return;
    }
    if (pathname === "/api/system/memberships/preview" && method === "POST") {
      const body = route.request().postDataJSON() as { action: "grant" | "extend"; userId: string; expectedVersion: number };
      previewRequests.push({ action: body.action, userId: body.userId });
      await route.fulfill({ json: { preview: membershipPreviewFixture(body) } });
      return;
    }
    if (method === "PATCH") membershipWrites.push(`${method} ${pathname}`);
    await route.abort();
  });

  await page.goto("/admin/users/memberships");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("heading", { name: translated("会员资格管理"), exact: true })).toBeVisible();
  await expectR02NoHorizontalOverflow(page, "admin membership list at 390px English dark");

  for (const [index, action, actionLabel, confirmationLabel] of [
    [0, "grant", "预览授予", "确认授予会员"],
    [1, "extend", "预览延期", "确认延期会员"],
  ] as const) {
    const trigger = page.getByRole("button", { name: translated("管理资格"), exact: true }).nth(index);
    await trigger.click();
    const dialog = page.locator('[data-operation-surface="modal"][aria-modal="true"]:visible').last();
    await expect(dialog).toBeVisible();
    const actionButton = dialog.getByRole("button", { name: translated(actionLabel), exact: true });
    await expect(actionButton).toBeVisible();
    await expect(actionButton).toHaveText(translated(actionLabel));
    await expectR02NoHorizontalOverflow(page, `membership ${action} operation at 390px English dark`);

    await actionButton.click();
    const confirmation = dialog.getByRole("dialog", { name: translated("会员变更确认"), exact: true });
    await expect(confirmation.getByRole("heading", { name: translated(confirmationLabel), exact: true })).toBeVisible();
    await closeOperation(trigger, dialog);
  }

  const userDetail = {
    summary: {
      user: { id: DETAIL_USER_ID, username: "detail-fixture", displayName: "Detail Fixture", state: "enabled", closedAt: null, disabledAt: null, accountAccessVersion: 1 },
      membership: { state: "none", status: null, startsAt: null, expiresAt: null, version: 0 },
      credits: { grantCount: 0, activeGrantCount: 0, availableTokens: 0, reservedTokens: 0, difference: "missing" },
    },
    membershipApplication: null,
    records: { account: [], membership: [], credits: [] },
  };
  await page.route((url) => url.pathname === `/api/admin/users/${DETAIL_USER_ID}`, async (route) => {
    if (route.request().method() !== "GET") {
      await route.abort();
      return;
    }
    await route.fulfill({ json: userDetail });
  });
  await page.route((url) => url.pathname === "/api/admin/credits/grants", async (route) => {
    if (route.request().method() !== "GET") {
      await route.abort();
      return;
    }
    await route.fulfill({ json: {
      grants: [],
      users: [{ id: DETAIL_USER_ID, username: "detail-fixture", displayName: "Detail Fixture", disabled: false, grantCount: 0, activeGrantCount: 0, availableTokens: 0, reservedTokens: 0, difference: "missing" }],
      grantsHasNextPage: false,
      usersHasNextPage: false,
    } });
  });

  await page.goto(`/admin/users/${DETAIL_USER_ID}`);
  const detailTrigger = page.getByRole("button", { name: translated("管理会员资格"), exact: true });
  await expect(detailTrigger).toBeVisible();
  await expectR02NoHorizontalOverflow(page, "admin user detail at 390px English dark");
  await detailTrigger.click();
  const detailDialog = page.locator('[data-operation-surface="modal"][aria-modal="true"]:visible').last();
  await expect(detailDialog).toBeVisible();
  const detailPreviewButton = detailDialog.getByRole("button", { name: translated("预览授予"), exact: true });
  await expect(detailPreviewButton).toHaveText(translated("预览授予"));
  await detailPreviewButton.click();
  await expect(detailDialog.getByRole("button", { name: translated("确认并执行"), exact: true })).toBeVisible();
  await expectR02NoHorizontalOverflow(page, "admin user detail membership preview at 390px English dark");
  await closeOperation(detailTrigger, detailDialog);

  expect(previewRequests).toEqual([
    { action: "grant", userId: MEMBERSHIP_FIXTURES[0].id },
    { action: "extend", userId: MEMBERSHIP_FIXTURES[1].id },
    { action: "grant", userId: DETAIL_USER_ID },
  ]);
  expect(membershipWrites).toEqual([]);
});

test("English credit operation footer actions stay single-line at 390px without overflow", async ({ page }) => {
  test.setTimeout(120_000);
  await signInR02Admin(page);
  await setEnglishDarkAppearance(page);
  await page.setViewportSize({ width: 390, height: 844 });

  const attemptedWrites: string[] = [];
  await page.route((url) => url.pathname === "/api/admin/credits/policies" || url.pathname === "/api/admin/credits/grants", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (route.request().method() !== "GET") {
      attemptedWrites.push(`${route.request().method()} ${pathname}`);
      await route.abort();
      return;
    }
    if (pathname === "/api/admin/credits/policies") {
      await route.fulfill({ json: { policies: [] } });
      return;
    }
    await route.fulfill({ json: {
      grants: [],
      users: [{ id: "83000000-0000-4000-8000-000000000004", username: "credit-fixture", displayName: null, disabled: false, grantCount: 0, activeGrantCount: 0, availableTokens: 0, reservedTokens: 0, difference: "missing" }],
      grantsHasNextPage: false,
      usersHasNextPage: false,
    } });
  });

  await page.goto("/admin/credits");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("heading", { name: translated("新注册平台赠送策略"), exact: true })).toBeVisible();
  await expectR02NoHorizontalOverflow(page, "admin credits at 390px English dark");

  let operation = await openOperation(page, "新建策略版本", "创建新注册赠送策略草稿");
  await expectSingleLineFooterAction(operation.dialog.locator("form"), translated("创建策略草稿"));
  await expectR02NoHorizontalOverflow(page, "admin signup policy modal at 390px English dark");
  await closeOperation(operation.trigger, operation.dialog);

  operation = await openOperation(page, "额度操作", "补发平台额度");
  await expectSingleLineFooterAction(operation.dialog.locator("form"), translated("预览补发"));
  await expectR02NoHorizontalOverflow(page, "admin credit grant modal at 390px English dark");
  await closeOperation(operation.trigger, operation.dialog);
  expect(attemptedWrites).toEqual([]);
});
