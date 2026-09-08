import { createHash } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { getDb } from "@/lib/db";

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

const BROWSER_SMOKE_VIEWPORTS = [1440, 1024, 768, 390] as const;

async function expectNoHorizontalOverflow(
  page: Page,
  path: string,
  readyHeading: string,
  surface: string,
): Promise<void> {
  const originalViewport = page.viewportSize();
  try {
    for (const width of BROWSER_SMOKE_VIEWPORTS) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(path);
      await expect(page.getByRole("heading", { name: readyHeading, exact: true })).toBeVisible();
      const dimensions = await page.evaluate(() => ({
        bodyWidth: document.body.scrollWidth,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      }));
      expect(dimensions.documentWidth, `${surface} document must not overflow at ${width}px`).toBeLessThanOrEqual(dimensions.viewportWidth);
      expect(dimensions.bodyWidth, `${surface} body must not overflow at ${width}px`).toBeLessThanOrEqual(dimensions.viewportWidth);
    }
  } finally {
    if (originalViewport !== null) await page.setViewportSize(originalViewport);
  }
}

function fixtureDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function seedBrowserSmokeFixtures(projectId: string): Promise<{
  jobId: string;
  unreadTitle: string;
  systemTitle: string;
}> {
  const db = getDb();
  const suffix = fixtureDigest(`browser-smoke:${projectId}:${Date.now()}`).slice(0, 12);
  const unreadTitle = `Browser smoke unread activity ${suffix}`;
  const systemTitle = `Browser smoke system history ${suffix}`;
  const now = new Date();
  try {
    const admin = await db.appUser.findUniqueOrThrow({ where: { username: "browser_admin" }, select: { id: true } });
    const job = await db.backgroundJob.create({
      data: {
        projectId,
        kind: "projectBrief",
        status: "succeeded",
        stage: "terminal",
        payload: {},
        result: { browserSmoke: true },
        progressCurrent: 1,
        progressTotal: 1,
        idempotencyKey: fixtureDigest(`browser-smoke-job:${projectId}:${suffix}`),
        requestedById: admin.id,
        startedAt: new Date(now.getTime() - 1_000),
        completedAt: now,
      },
      select: { id: true },
    });
    await db.notification.create({
      data: {
        userId: admin.id,
        projectId,
        kind: "actionCompleted",
        severity: "info",
        title: unreadTitle,
        body: "Browser smoke disposable unread notification.",
        actionHref: `/projects/${projectId}/jobs/${job.id}`,
        dedupeKey: fixtureDigest(`browser-smoke-unread:${projectId}:${suffix}`),
        readAt: null,
      },
    });
    await db.notification.create({
      data: {
        userId: admin.id,
        projectId: null,
        kind: "system",
        severity: "info",
        title: systemTitle,
        body: "Browser smoke disposable read system history.",
        actionHref: null,
        dedupeKey: fixtureDigest(`browser-smoke-system:${projectId}:${suffix}`),
        readAt: new Date(now.getTime() - 2_000),
      },
    });
    return { jobId: job.id, unreadTitle, systemTitle };
  } finally {
    await db.$disconnect();
  }
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
  await expect(page.getByText("内部开发版 · 0.2.0-dev.1", { exact: true })).toBeVisible();
  await expect(page.getByText(/当前没有可访问项目/u)).toBeVisible();
  await expect(page.getByText("运行正常", { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page, "/dashboard", "欢迎回来，browser_admin", "dashboard");
  await expectNoAccessibilityViolations(page, "dashboard");

  const healthResponse = await request.get("/api/health");
  expect(healthResponse.ok()).toBe(true);
  expect(await healthResponse.json()).toMatchObject({
    status: "ok",
    version: "0.2.0-dev.1",
    database: "up",
    worker: { status: "up", consecutiveFailures: 0 },
  });

  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "我的项目" })).toBeVisible();
  await expect(page.getByText("匹配 0 个", { exact: true })).toBeVisible();
  await expect(page.getByText(/第 1 \/ 1 页/u)).toHaveCount(0);
  await expectNoAccessibilityViolations(page, "projects");

  await page.getByRole("button", { name: "＋ 新建项目" }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("Browser layout project");
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  const projectHref = await page.getByRole("link", { name: "Browser layout project", exact: true }).getAttribute("href");
  expect(projectHref).toMatch(/^\/projects\/[0-9a-f-]+$/u);
  const projectId = projectHref!.split("/")[2]!;
  await page.goto(`${projectHref!}/materials`);
  await expect(page.getByRole("heading", { name: "原始资料来源库", exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page, `${projectHref!}/materials`, "原始资料来源库", "project materials");

  const addSourceTrigger = page.locator("#add-source-trigger");
  await expect(addSourceTrigger).toBeVisible();
  await addSourceTrigger.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/materials\\?kind=all&view=add$`, "u"));
  const addSourceDialog = page.getByRole("dialog", { name: "添加来源" });
  await expect(addSourceDialog).toBeVisible();
  const closeSourceDialog = addSourceDialog.getByRole("button", { name: "关闭", exact: true });
  await expect(closeSourceDialog).toBeFocused();
  await closeSourceDialog.press("Tab");
  await expect(addSourceDialog.getByRole("link", { name: "管理已上传文件", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(addSourceDialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/materials\\?kind=all$`, "u"));
  await expect(addSourceTrigger).toBeFocused();

  const sourceText = `Browser smoke original source ${projectId}`;
  await addSourceTrigger.click();
  await expect(addSourceDialog).toBeVisible();
  await addSourceDialog.locator("#manual-text textarea").fill(sourceText);
  await addSourceDialog.getByRole("button", { name: "加入原始资料", exact: true }).click();
  await expect(addSourceDialog.getByRole("status")).toContainText("加入原始资料来源库");
  await closeSourceDialog.click();
  await expect(addSourceDialog).toHaveCount(0);
  await expect(addSourceTrigger).toBeFocused();

  const sourceList = page.getByRole("list", { name: "项目原始资料列表", exact: true });
  const sourceRow = sourceList.getByRole("listitem").filter({ hasText: sourceText });
  await expect(sourceRow).toBeVisible();

  await page.getByRole("link", { name: "审核 AI 候选", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/materials/review$`, "u"));
  await expect(page.getByRole("heading", { name: "审核 AI 候选", exact: true }).first()).toBeVisible();
  await expect(page.getByText("当前没有待审核 AI 候选。", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "返回项目资料", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/materials$`, "u"));
  await expect(page.getByRole("heading", { name: "原始资料来源库", exact: true })).toBeVisible();

  const returnedSourceRow = page.getByRole("list", { name: "项目原始资料列表", exact: true }).getByRole("listitem").filter({ hasText: sourceText });
  await expect(returnedSourceRow).toBeVisible();
  await returnedSourceRow.getByRole("link", { name: "查看详情", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/materials/sources/[0-9a-f-]+\\?returnTo=`, "u"));
  await expect(page.getByRole("heading", { name: "原始资料内容", exact: true })).toBeVisible();
  await expect(page.getByText(sourceText, { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "返回原始资料", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/materials\\?kind=all&focus=[0-9a-f-]+$`, "u"));
  await expect(page.locator("a[id^='source-link-']").first()).toBeFocused();

  const browserSmokeFixtures = await seedBrowserSmokeFixtures(projectId);

  await page.goto("/dashboard");
  const dashboardJobLink = page.locator(`a[href="/projects/${projectId}/jobs/${browserSmokeFixtures.jobId}"]`);
  await expect(dashboardJobLink).toBeVisible();
  await dashboardJobLink.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/jobs/${browserSmokeFixtures.jobId}$`, "u"));
  await expect(page.getByRole("heading", { name: "项目简报", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard$/u);
  await expectNoHorizontalOverflow(page, "/dashboard", "欢迎回来，browser_admin", "dashboard with recent job");

  const mobileViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");
  const mobileNavigationTargets = [
    { name: /打开通知中心/u, path: /\/notifications$/u },
    { name: "个人中心：browser_admin", path: /\/profile$/u },
    { name: "管理工作台", path: /\/admin$/u },
  ] as const;
  for (const target of mobileNavigationTargets) {
    const link = page.getByRole("link", { name: target.name });
    await expect(link).toBeVisible();
    await link.focus();
    await expect(link).toBeFocused();
    await link.press("Enter");
    await expect(page).toHaveURL(target.path);
    await page.goBack();
    await expect(page).toHaveURL(/\/dashboard$/u);
    await expect(page.getByRole("heading", { name: "欢迎回来，browser_admin" })).toBeVisible();
  }
  if (mobileViewport !== null) await page.setViewportSize(mobileViewport);

  await expectNoHorizontalOverflow(page, "/notifications", "活动记录", "notifications");
  await page.goto("/notifications");
  await expect(page).toHaveURL(/\/notifications$/u);
  await expect(page.getByRole("heading", { name: "活动记录", exact: true })).toBeVisible();
  const unreadActivity = page.locator("article").filter({ hasText: browserSmokeFixtures.unreadTitle });
  const systemHistory = page.locator("article").filter({ hasText: browserSmokeFixtures.systemTitle });
  await expect(unreadActivity).toBeVisible();
  await expect(systemHistory).toBeVisible();
  await expectNoAccessibilityViolations(page, "notifications");

  await unreadActivity.getByRole("button", { name: "查看详情", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/jobs/${browserSmokeFixtures.jobId}\\?from=notifications&view=all&focus=[0-9a-f-]+$`, "iu"));
  await expect(page.getByRole("heading", { name: "项目简报", exact: true })).toBeVisible();
  await page.getByRole("link", { name: /返回通知中心/u }).click();
  await expect(page).toHaveURL(/\/notifications\?view=all&focus=[0-9a-f-]+$/iu);
  const returnedUnreadActivity = page.locator("article").filter({ hasText: browserSmokeFixtures.unreadTitle });
  await expect(returnedUnreadActivity).toBeVisible();
  await expect(returnedUnreadActivity.getByText("已读", { exact: true })).toBeVisible();
  await expect(returnedUnreadActivity).toBeFocused();

  const unreadFilter = page.getByRole("button", { name: "未读", exact: true });
  await unreadFilter.focus();
  await expect(unreadFilter).toBeFocused();
  await unreadFilter.press("Enter");
  await expect(page.getByText(browserSmokeFixtures.unreadTitle, { exact: true })).toHaveCount(0);
  await expect(page.getByText("当前没有未读通知。", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "系统", exact: true }).click();
  await expect(page.getByText(browserSmokeFixtures.systemTitle, { exact: true })).toBeVisible();
  await expect(page.getByText(browserSmokeFixtures.unreadTitle, { exact: true })).toHaveCount(0);

  await page.goto("/guide");
  await expect(page.getByRole("heading", { name: "从账号进入，到可信的项目协作。" })).toBeVisible();
  await expect(page.getByText(/项目概览 → 项目计划 → 项目资料 → AI 工作台 → 项目自动化 → 项目管理/u)).toBeVisible();
  await expectNoAccessibilityViolations(page, "guide");

  await page.goto("/profile");
  await expect(page.getByText("账户详情", { exact: true })).toBeVisible();
  await expect(page.locator("details[open]").filter({ hasText: "账户详情" })).toHaveCount(1);
  await expect(page.getByRole("link", { name: /^我的 Git 连接/u })).toBeVisible();
  await expect(page.getByRole("link", { name: /^我的 MCP 连接/u })).toBeVisible();
  await expectNoAccessibilityViolations(page, "profile");

  await page.getByRole("link", { name: /^我的 Git 连接/u }).click();
  await expect(page).toHaveURL(/\/profile\/connections\/git$/u);
  await expect(page.getByRole("heading", { name: "我的 Git 连接", exact: true })).toBeVisible();
  await expect(page.getByText(/项目页已支持一次性手动只读委托/u)).toBeVisible();
  await expect(page.getByText(/自动化、写入\/提交和旧 PAT 路径保持关闭/u)).toBeVisible();
  await expectNoAccessibilityViolations(page, "personal Git connections");

  await page.goto("/profile/connections/mcp");
  await expect(page.getByRole("heading", { name: "我的 MCP 连接", exact: true })).toBeVisible();
  await expect(page.getByText(/当前连接不能用于项目或自动化/u)).toBeVisible();
  await expectNoAccessibilityViolations(page, "personal MCP connections");
  await page.goto("/profile");

  const membershipGrant = await page.evaluate(async () => {
    const listResponse = await fetch("/api/system/memberships?search=browser_admin", { cache: "no-store" });
    if (!listResponse.ok) throw new Error(`membership list failed: ${listResponse.status}`);
    const list = await listResponse.json() as { items: Array<{ id: string; username: string }> };
    const currentUser = list.items.find((item) => item.username === "browser_admin");
    if (currentUser === undefined) throw new Error("browser_admin membership row missing");
    const response = await fetch(`/api/system/memberships/${currentUser.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: window.location.origin },
      body: JSON.stringify({ action: "grant", days: 1, note: "browser smoke disposable" }),
    });
    return { status: response.status, body: await response.json() as { subscription?: { status?: string } } };
  });
  expect(membershipGrant.status).toBe(200);
  expect(membershipGrant.body.subscription?.status).toBe("active");

  await page.reload();
  await expect(page.getByRole("link", { name: "管理我的模型", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "管理我的模型", exact: true }).click();
  await expect(page).toHaveURL(/\/profile\/models$/u);
  await expect(page.getByRole("heading", { name: "我的模型", exact: true })).toBeVisible();
  await expect(page.getByText("会员有效", { exact: true })).toBeVisible();
  await expect(page.getByText(/固定官方端点不可修改/u)).toBeVisible();
  await expect(page.getByText("生成模型或向量模型至少配置一项。", { exact: true })).toBeVisible();

  const smokeConnectionName = "Browser smoke personal model";
  const smokeConnectionNameUpdated = "Browser smoke personal model updated";
  const smokeKey = "smoke-local-key-2026";
  await page.getByLabel("连接名称", { exact: true }).fill(smokeConnectionName);
  const createKeyInput = page.getByLabel("OpenAI API Key", { exact: true });
  await createKeyInput.fill(smokeKey);
  await page.getByRole("button", { name: "保存个人连接", exact: true }).click();
  await expect(createKeyInput).toHaveValue("");
  await expect(page.getByRole("heading", { name: smokeConnectionName, exact: true })).toBeVisible();

  await page.getByRole("button", { name: "编辑配置", exact: true }).click();
  await expect(page.getByLabel("新的 API Key", { exact: true })).toHaveCount(0);
  await page.getByLabel("连接名称", { exact: true }).last().fill(smokeConnectionNameUpdated);
  await page.getByLabel("生成模型（可选）", { exact: true }).last().fill("gpt-4.1");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByRole("heading", { name: smokeConnectionNameUpdated, exact: true })).toBeVisible();

  const personalModelCard = page.locator("article").filter({ has: page.getByRole("heading", { name: smokeConnectionNameUpdated, exact: true }) });
  await personalModelCard.getByRole("button", { name: "停用", exact: true }).click();
  await expect(personalModelCard.getByText("已停用", { exact: true })).toBeVisible();
  await personalModelCard.getByRole("button", { name: "删除", exact: true }).click();
  const deleteDialog = page.getByRole("dialog");
  await deleteDialog.getByRole("textbox").fill(smokeConnectionNameUpdated);
  await deleteDialog.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.getByRole("heading", { name: smokeConnectionNameUpdated, exact: true })).toHaveCount(0);

  const originalViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth)).toBe(true);
  await expectNoAccessibilityViolations(page, "personal models mobile");
  if (originalViewport !== null) await page.setViewportSize(originalViewport);

  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "管理员总览" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "管理工作台导航" })).toBeVisible();
  await expect(page.getByText("平台 Token 总览", { exact: true })).toBeVisible();
  await expectNoAccessibilityViolations(page, "admin overview");

  await page.goto("/admin/connectors/mcp");
  await expect(page.getByRole("heading", { name: "MCP 连接配置已冻结", exact: true })).toBeVisible();
  await expect(page.getByText(/管理员只负责后续安全证据审查与工具认证/u)).toBeVisible();
  await expect(page.getByLabel("Bearer Token", { exact: true })).toHaveCount(0);
  await expectNoAccessibilityViolations(page, "MCP connections");
  expect(browserErrors).toEqual([]);
});
