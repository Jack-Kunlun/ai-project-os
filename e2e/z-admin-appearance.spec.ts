import { randomUUID } from "node:crypto";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { adminNavigationItems } from "../src/lib/admin-navigation";
import { englishUiMessages } from "../src/lib/ui-dictionary-source";
import { R02_ADMIN_ROUTES, expectR02NoAccessibilityViolations, expectR02NoHorizontalOverflow, signInR02Admin } from "./support/r02-admin-navigation";

const cases = [
  { language: "zh-CN", theme: "light" }, { language: "zh-CN", theme: "dark" },
  { language: "en", theme: "light" }, { language: "en", theme: "dark" },
] as const;

async function expectFieldInsets(page: Page, surface: string) {
  const cramped = await page.locator("[data-admin-workspace] input:not([type=checkbox]):not([type=radio]):not([type=hidden]), [data-admin-workspace] select:not(.appearance-controls-row select), [data-admin-workspace] textarea").evaluateAll(elements => elements.filter(element => element.getClientRects().length > 0).map(element => {
    const style = getComputedStyle(element);
    return { label: element.getAttribute("aria-label") ?? element.getAttribute("placeholder"), left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight) };
  }).filter(insets => insets.left < 12 || insets.right < 12));
  expect(cramped, `${surface} fields need breathing room inside the border`).toEqual([]);
}

for (const appearance of cases) {
  test(`admin prototype presentation ${appearance.language}/${appearance.theme}`, async ({ page }) => {
    test.setTimeout(240_000);
    const tr = (text: string) => appearance.language === "en" ? englishUiMessages[text] ?? text : text;
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(`${new URL(page.url()).pathname}: ${error.message}`));
    await signInR02Admin(page);
    const user = await seedBrowserPersonalUser(`admin_appearance_${randomUUID().slice(0, 8)}`, "Appearance2026Password!");
    await page.setViewportSize({ width: 1680, height: 960 });
    const trigger = page.locator(".appearance-controls-trigger");
    await trigger.click();
    const popover = page.locator(".appearance-controls-popover");
    await popover.getByRole("combobox").nth(0).selectOption(appearance.language);
    await expect(page.locator("html")).toHaveAttribute("lang", appearance.language);
    await expect(popover.locator('[role="status"]')).toHaveCount(0);
    await popover.getByRole("combobox").nth(1).selectOption(appearance.theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", appearance.theme);
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await mkdir("test-results/admin-appearance", { recursive: true });

    for (const route of R02_ADMIN_ROUTES) {
      await page.goto(route.path);
      const surface = `${route.path} ${appearance.language}/${appearance.theme}`;
      await expect(page.getByRole("heading", { name: tr(route.heading), exact: true }).first(), surface).toBeVisible();
      const terminalKey = appearance.language === "en" && !englishUiMessages[route.terminal.name]
        ? Object.keys(englishUiMessages).find(key => key.startsWith(route.terminal.name)) ?? route.terminal.name
        : route.terminal.name;
      const terminalText = tr(terminalKey);
      const terminal = route.terminal.kind === "heading" ? page.getByRole("heading", { name: terminalText, exact: true }).first() : page.getByText(terminalText, { exact: route.terminal.exact ?? true }).last();
      await expect(terminal, `${surface} data ready`).toBeVisible({ timeout: 15_000 });
      for (const pending of route.pendingTexts ?? []) await expect(page.getByText(tr(pending), { exact: true })).toHaveCount(0);
      await expect(page.locator('.animate-pulse, [role="alert"]:not(#__next-route-announcer__)')).toHaveCount(0);
      const nav = page.getByRole("navigation", { name: tr("管理工作台导航"), exact: true });
      await expect(nav.getByRole("link")).toHaveCount(13);
      await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
      for (const item of adminNavigationItems) await expect(nav.getByRole("link", { name: tr(item.label), exact: true })).toHaveAttribute("href", item.href);
      await expectR02NoHorizontalOverflow(page, surface);
      const mainWidth = await page.locator(".admin-page-scroll").evaluate(element => element.scrollWidth - element.clientWidth);
      expect(mainWidth, `${surface} main pane must not scroll horizontally`).toBeLessThanOrEqual(1);
      await expectFieldInsets(page, surface);
      await expectR02NoAccessibilityViolations(page, surface);
      if (route.path === "/admin/operations/backups") {
        const endpoint = "**/api/system/operations/backups";
        const original = await page.request.get("/api/system/operations/backups");
        expect(original.status()).toBe(200);
        const snapshot = await original.json();
        const runbook = page.getByRole("link", { name: tr("打开恢复演练 Runbook"), exact: true });
        // A fresh isolated deployment correctly has no drill record. Supply a
        // read-only UI fixture to check the populated footer, then restore the
        // real response; this is not evidence of a completed recovery drill.
        if (snapshot.recoveryDrill === null) await expect(runbook).toHaveCount(0);
        const finishedAt = new Date().toISOString();
        await page.route(endpoint, route => route.fulfill({ json: {
          ...snapshot, recoveryDrillSourceStatus: "ready", recoveryDrill: {
            formatVersion: 1, drillId: "20261020T000000Z-abcdef1234567890",
            environment: "local", scope: "isolated-local", status: "failed",
            startedAt: new Date(Date.parse(finishedAt) - 60_000).toISOString(), completedAt: finishedAt,
            durationSeconds: 60, sourceArtifact: null, validationSha256: null,
            checks: { pgRestore: "failed", migrationLedger: "failed", securityCounts: "failed", masterKeyVolume: "failed", uploadsManifest: "failed", serviceHealth: "failed" },
            migrationCount: 149, securityCounts: { users: 0, workspaces: 0, projects: 0, credentials: 0, projectAssets: 0 },
            errorCode: "ISOLATED_UI_FIXTURE",
          },
        } }));
        const refresh = page.locator(".admin-page-header").getByRole("button", { name: tr("刷新状态"), exact: true });
        await refresh.click();
        await expect(runbook).toBeVisible({ timeout: 10_000 });
        await runbook.hover();
        await expectR02NoAccessibilityViolations(page, `backup Runbook hover ${surface}`);
        await page.screenshot({ path: `test-results/admin-appearance/${appearance.language}-${appearance.theme}-backup-drill-ui-fixture.png` });
        await page.unroute(endpoint);
        await refresh.click();
        if (snapshot.recoveryDrill === null) await expect(runbook).toHaveCount(0);
      }
      await page.screenshot({ path: `test-results/admin-appearance/${appearance.language}-${appearance.theme}-${route.path.replaceAll("/", "_")}.png` });
      if (route.path === "/admin/users") {
        await page.goto(`/admin/users/${user.id}`);
        await expect(page.getByRole("heading", { name: user.username, exact: true })).toBeVisible();
        await expect(page.getByRole("heading", { name: tr("额度摘要"), exact: true })).toBeVisible();
        await expectR02NoAccessibilityViolations(page, `user detail ${surface}`);
        await page.screenshot({ path: `test-results/admin-appearance/${appearance.language}-${appearance.theme}-user-detail.png` });
        await page.getByRole("button", { name: tr("管理账号状态"), exact: true }).click();
        const operation = page.locator('[data-operation-surface][aria-modal="true"]').filter({ visible: true });
        await expect(operation).toBeVisible();
        await operation.getByRole("textbox", { name: tr("操作原因"), exact: true }).fill("Presentation check only");
        await expect(operation.getByRole("textbox", { name: tr("操作原因"), exact: true })).toHaveCSS("padding-left", "12px");
        await expectR02NoAccessibilityViolations(page, `user status operation ${surface}`);
        await page.screenshot({ path: `test-results/admin-appearance/${appearance.language}-${appearance.theme}-user-status-operation.png` });
        await page.keyboard.press("Escape");
        await expect(operation).toHaveCount(0);
      }
      if (route.path === "/admin/models") {
        await page.locator("main header").getByRole("button", { name: tr("新增供应商"), exact: true }).click();
        const editor = page.getByRole("dialog", { name: tr("新增供应商"), exact: true });
        await expect(editor).toBeVisible();
        await page.keyboard.press("Control+k");
        await expect(page.getByRole("dialog", { name: tr("搜索功能页面"), exact: true })).toBeHidden();
        await expectFieldInsets(page, `model editor ${surface}`);
        await expectR02NoAccessibilityViolations(page, `model editor ${surface}`);
        await page.screenshot({ path: `test-results/admin-appearance/${appearance.language}-${appearance.theme}-model-editor.png` });
        await editor.getByRole("button", { name: tr("关闭新增供应商"), exact: true }).click();
        await expect(editor).toHaveCount(0);
      }
      if (route.path === "/admin/sms") {
        await page.getByRole("button", { name: tr("新增供应商"), exact: true }).click();
        const editor = page.getByRole("dialog", { name: tr("新增短信供应商"), exact: true });
        await expect(editor).toBeVisible();
        await expectFieldInsets(page, `SMS editor ${surface}`);
        await expectR02NoAccessibilityViolations(page, `SMS editor ${surface}`);
        await page.screenshot({ path: `test-results/admin-appearance/${appearance.language}-${appearance.theme}-sms-editor.png` });
        await page.mouse.click(4, 4);
        await expect(editor).toBeHidden();
      }
    }

    await page.goto("/admin");
    const searchButton = page.getByRole("button", { name: tr("搜索功能页面"), exact: true });
    await searchButton.click();
    const searchDialog = page.getByRole("dialog", { name: tr("搜索功能页面"), exact: true });
    await expect(searchDialog).toBeVisible();
    await searchDialog.getByRole("searchbox").fill(tr("模型测试额度"));
    await expect(searchDialog.getByRole("link")).toHaveCount(1);
    await searchDialog.getByRole("link", { name: tr("模型测试额度"), exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/operations\/probes$/u);
    await expect(searchDialog).toBeHidden();
    await expect(page.getByRole("heading", { name: tr("模型测试额度"), exact: true })).toBeVisible();

    await page.getByRole("button", { name: tr("账户菜单"), exact: true }).click();
    await expect(page.getByRole("link", { name: tr("账户设置"), exact: true })).toHaveAttribute("href", "/admin/account");
    await expect(page.getByRole("button", { name: tr("退出"), exact: true })).toBeVisible();
    await page.getByRole("heading", { name: tr("模型测试额度"), exact: true }).click();
    await expect(page.locator(".header-account-popover")).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await expectR02NoHorizontalOverflow(page, `narrow admin header ${appearance.language}/${appearance.theme}`);
    await page.getByRole("button", { name: tr("打开导航"), exact: true }).click();
    const drawer = page.getByRole("dialog", { name: tr("管理工作台导航"), exact: true });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("link")).toHaveCount(13);
    await expectR02NoAccessibilityViolations(page, `admin navigation drawer ${appearance.language}/${appearance.theme}`);
    await page.screenshot({ path: `test-results/admin-appearance/${appearance.language}-${appearance.theme}-mobile-navigation.png` });
    await drawer.getByRole("link", { name: tr("管理员账户"), exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(page).toHaveURL(/\/admin\/account$/u);
    await expect(page.getByRole("heading", { name: tr("登录密码"), exact: true })).toBeVisible();
    await expectR02NoHorizontalOverflow(page, `narrow admin account ${appearance.language}/${appearance.theme}`);
    await expectR02NoAccessibilityViolations(page, `narrow admin account ${appearance.language}/${appearance.theme}`);
    await page.screenshot({ path: `test-results/admin-appearance/${appearance.language}-${appearance.theme}-mobile-account.png` });
    expect(pageErrors, "admin routes and lazy-loaded editors must not throw client exceptions").toEqual([]);
  });
}

test("admin navigation and search stay exclusive while the dialog chunk loads and restore focus", async ({ page }) => {
  test.setTimeout(90_000);
  await signInR02Admin(page);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const first of ["navigation", "search", "shortcut"] as const) {
    let release!: () => void;
    const pendingChunk = new Promise<void>(resolve => { release = resolve; });
    let requests = 0;
    const chunkPattern = "**/_next/static/chunks/workspace-presentation-*.js";
    await page.route(chunkPattern, async route => {
      requests += 1;
      await pendingChunk;
      await route.continue();
    });
    try {
      await page.goto("/admin");
      // The shortcut is registered during hydration; a measured overview proves the client is ready.
      await expect(page.getByText("测量于", { exact: false })).toBeVisible();
      const navigation = page.getByRole("button", { name: "打开导航", exact: true });
      const search = page.getByRole("button", { name: "搜索功能页面", exact: true });
      const opener = first === "search" ? search : navigation;
      const other = first === "navigation" ? search : navigation;
      if (first === "shortcut") {
        await opener.focus();
        await page.keyboard.press("Control+k");
      } else await opener.click();
      await expect.poll(() => requests).toBeGreaterThan(0);
      await expect(page.locator("dialog[open]")).toHaveCount(0);
      if (first === "navigation") await expect(other).toBeDisabled();
      else {
        await expect(other).toHaveAttribute("aria-disabled", "true");
        await other.dispatchEvent("click");
      }
      await page.keyboard.press("Control+k");
      release();
      const dialog = page.getByRole("dialog", { name: first === "navigation" ? "管理工作台导航" : "搜索功能页面", exact: true });
      await expect(dialog).toBeVisible();
      await expect(page.locator("dialog[open]")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
      await expect(other).toBeEnabled();
      if (first === "shortcut") await page.keyboard.press("Control+k");
      else await opener.click();
      await dialog.getByRole("button", { name: "关闭窗口", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
    } finally {
      release();
      await page.unroute(chunkPattern);
    }
  }
});

test("SMS captcha lazy-loads, retries and closes without sending a message (isolated UI fixtures)", async ({ page }) => {
  await signInR02Admin(page);
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  // Only the client readiness flag is overridden; no provider is configured or called.
  await page.route("**/api/admin/sms", async route => {
    const response = await route.fetch();
    const state = await response.json();
    await route.fulfill({ response, json: { ...state, smsLimitsReady: true } });
  });
  let sends = 0;
  await page.route("**/api/admin/sms/test", async route => {
    sends += 1;
    await route.fulfill({ status: 409, json: { error: { code: "UI_FIXTURE_SEND_BLOCKED", message: "No SMS is sent by this UI check." } } });
  });
  let challenges = 0;
  await page.route("**/api/auth/sms/captcha", async route => {
    challenges += 1;
    if (challenges === 2) {
      await route.fulfill({ status: 503, json: { error: { message: "图形验证码暂时无法加载，请稍后重试。" } } });
    } else {
      await route.fulfill({ json: { challengeId: "isolated-ui-captcha", image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jcWQAAAAASUVORK5CYII=", expiresInSeconds: 300 } });
    }
  });
  await page.goto("/admin/sms");
  await expect(page.getByText("尚未配置短信供应商", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "新增供应商", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "新增短信供应商", exact: true });
  await editor.getByLabel("AccessKey ID", { exact: true }).fill("isolated-ui-key");
  await editor.getByLabel("AccessKey Secret", { exact: true }).fill("isolated-ui-secret");
  await editor.getByLabel("短信签名", { exact: true }).fill("UI preview");
  await editor.getByLabel("验证码模板 Code", { exact: true }).fill("UI_ONLY");
  await editor.getByLabel("测试手机号（中国大陆 +86）", { exact: true }).fill("13800138000");
  await editor.getByRole("button", { name: "发送真实测试短信", exact: true }).click();
  const captcha = page.getByRole("dialog", { name: "安全验证", exact: true });
  await expect(captcha).toBeVisible();
  await expect(captcha.getByRole("img", { name: "图形验证码", exact: true })).toBeVisible();
  await expect(captcha.getByLabel("验证码", { exact: true })).toBeEnabled();
  await expectR02NoAccessibilityViolations(page, "lazy-loaded SMS captcha");
  await captcha.getByRole("button", { name: "刷新验证码", exact: true }).click();
  await expect(captcha.getByRole("alert")).toHaveText("图形验证码暂时无法加载，请稍后重试。");
  await captcha.getByRole("button", { name: "刷新验证码", exact: true }).click();
  await expect(captcha.getByRole("img", { name: "图形验证码", exact: true })).toBeVisible();
  await captcha.getByRole("button", { name: "关闭图形验证码", exact: true }).click();
  await expect(captcha).toBeHidden();
  await expect(editor.getByRole("button", { name: "发送真实测试短信", exact: true })).toBeFocused();
  expect(challenges).toBe(3);
  expect(sends).toBe(0);
  expect(pageErrors).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
});
