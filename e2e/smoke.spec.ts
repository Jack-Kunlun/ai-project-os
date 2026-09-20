import { createHash, randomUUID } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { activateAccountEntitlements } from "@/lib/account-entitlement-activation-service";
import { createPasswordRecord } from "@/lib/auth";
import { appendWorkspaceMembershipAudit } from "@/lib/membership-governance";
import { getDb, getEntitlementDb } from "@/lib/db";

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
  pendingJobId: string;
  unreadTitle: string;
  pendingTitle: string;
  automationTitle: string;
  automationRunId: string;
  systemTitle: string;
}> {
  const db = getDb();
  const suffix = fixtureDigest(`browser-smoke:${projectId}:${Date.now()}`).slice(0, 12);
  const unreadTitle = `Browser smoke unread activity ${suffix}`;
  const pendingTitle = `Browser smoke pending activity ${suffix}`;
  const automationTitle = `Browser smoke automation failure ${suffix}`;
  const systemTitle = `Browser smoke system history ${suffix}`;
  const now = new Date();
  try {
    const owner = await db.appUser.findUniqueOrThrow({ where: { username: "browser_owner" }, select: { id: true } });
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
        requestedById: owner.id,
        startedAt: new Date(now.getTime() - 1_000),
        completedAt: now,
      },
      select: { id: true },
    });
    const pendingJob = await db.backgroundJob.create({
      data: {
        projectId,
        kind: "projectBrief",
        status: "failed",
        stage: "terminal",
        payload: {},
        failureCode: "BROWSER_SMOKE_PENDING",
        idempotencyKey: fixtureDigest(`browser-smoke-pending-job:${projectId}:${suffix}`),
        requestedById: owner.id,
        completedAt: now,
      },
      select: { id: true },
    });
    const automationRule = await db.automationRule.create({
      data: {
        projectId,
        name: `Browser smoke automation ${suffix}`,
        kind: "projectBrief",
        intervalMinutes: 60,
        config: {},
        nextRunAt: new Date(now.getTime() + 60 * 60_000),
        createdById: owner.id,
      },
      select: { id: true },
    });
    const failedRun = await db.automationRun.create({
      data: {
        automationRuleId: automationRule.id,
        projectId,
        status: "failed",
        scheduledFor: now,
        completedAt: now,
        failureCode: "BROWSER_SMOKE_AUTOMATION_FAILED",
        jobIds: [],
      },
      select: { id: true },
    });
    await db.notification.create({
      data: {
        userId: owner.id,
        projectId,
        subjectKind: "backgroundJob",
        subjectId: job.id,
        attentionIntent: "informational",
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
        userId: owner.id,
        projectId,
        subjectKind: "backgroundJob",
        subjectId: pendingJob.id,
        attentionIntent: "requiresAttention",
        kind: "system",
        severity: "error",
        title: pendingTitle,
        body: "Browser smoke disposable pending notification.",
        actionHref: `/projects/${projectId}/jobs/${pendingJob.id}`,
        dedupeKey: fixtureDigest(`browser-smoke-pending:${projectId}:${suffix}`),
        readAt: null,
      },
    });
    await db.notification.create({
      data: {
        userId: owner.id,
        projectId,
        subjectKind: "automationRun",
        subjectId: failedRun.id,
        attentionIntent: "requiresAttention",
        kind: "automationFailed",
        severity: "error",
        title: automationTitle,
        body: "Browser smoke disposable failed automation notification.",
        actionHref: `/projects/${projectId}/automations?run=${failedRun.id}`,
        dedupeKey: fixtureDigest(`browser-smoke-automation:${projectId}:${suffix}`),
        readAt: null,
      },
    });
    await db.notification.create({
      data: {
        userId: owner.id,
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
    return { jobId: job.id, pendingJobId: pendingJob.id, unreadTitle, pendingTitle, automationTitle, automationRunId: failedRun.id, systemTitle };
  } finally {
    await db.$disconnect();
  }
}

async function seedBrowserPersonalOwner(username: string, password: string): Promise<Readonly<{ userId: string; workspaceId: string }>> {
  const db = getEntitlementDb();
  const userId = randomUUID();
  const workspaceId = randomUUID();
  try {
    const passwordRecord = await createPasswordRecord(password);
    return await db.$transaction(async (tx) => {
      const user = await tx.appUser.create({
        data: { id: userId, username, role: "user", ...passwordRecord },
        select: { id: true, accountAccessVersion: true },
      });
      await tx.workspace.create({
        data: {
          id: workspaceId,
          name: `${username} 的个人工作区`,
          slug: `user-${user.id}`,
          createdById: user.id,
        },
      });
      const membership = await tx.workspaceMembership.create({
        data: {
          id: randomUUID(),
          workspaceId,
          userId: user.id,
          role: "owner",
          accessState: "confirmed",
        },
      });
      await appendWorkspaceMembershipAudit(tx, membership, {
        action: "confirmed",
        previousState: null,
        actorId: user.id,
        reason: "browser_smoke_personal_workspace_created",
      });
      await activateAccountEntitlements({
        userId: user.id,
        source: "localProvisioning",
        actorId: user.id,
        accountAccessVersion: user.accountAccessVersion,
        actorAccountAccessVersion: user.accountAccessVersion,
        evidenceKind: "browser-smoke",
        evidenceRef: "browser-smoke-personal-workspace",
      }, tx);
      return { userId: user.id, workspaceId };
    });
  } finally {
    await db.$disconnect();
  }
}

test("first-run administrator and personal workspace Owner stay separate across protected pages", async ({ page, request }) => {
  test.setTimeout(60_000);
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console:${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`page:${error.message}`));
  const adminUsername = "browser_admin";
  const adminPassword = "BrowserGate2026Password!";
  const ownerUsername = "browser_owner";
  const ownerPassword = "BrowserOwner2026Password!";

  const setupResponse = await page.goto("/setup");
  expect(setupResponse?.status()).toBe(200);
  const landingPath = new URL(page.url()).pathname;
  if (landingPath === "/setup") {
    const headers = setupResponse?.headers() ?? {};
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-powered-by"]).toBeUndefined();
    await expectNoAccessibilityViolations(page, "setup");

    await page.getByLabel("用户名", { exact: true }).fill(adminUsername);
    await page.getByLabel("密码", { exact: true }).fill(adminPassword);
    await page.getByLabel("再次输入密码", { exact: true }).fill(adminPassword);
    await page.getByRole("button", { name: "创建管理员并进入" }).click();
  } else if (landingPath === "/login") {
    await expectNoAccessibilityViolations(page, "login");
    await page.getByLabel("用户名", { exact: true }).fill(adminUsername);
    await page.getByLabel("密码", { exact: true }).fill(adminPassword);
    await page.getByRole("button", { name: "登 录", exact: true }).click();
  } else {
    expect(landingPath).toBe("/admin");
  }

  await expect(page).toHaveURL(/\/admin$/u);
  await expect(page.getByRole("heading", { name: "管理员总览", exact: true })).toBeVisible();

  await seedBrowserPersonalOwner(ownerUsername, ownerPassword);
  await expect(page).toHaveURL(/\/admin$/u);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/admin$/u);
  await expect(page.getByRole("heading", { name: "管理员总览", exact: true })).toBeVisible();

  const browser = page.context().browser();
  if (browser === null) throw new Error("BROWSER_SMOKE_BROWSER_UNAVAILABLE");
  const adminContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const adminPage = await adminContext.newPage();
  await adminPage.goto("/login");
  await adminPage.getByLabel("用户名", { exact: true }).fill(adminUsername);
  await adminPage.getByLabel("密码", { exact: true }).fill(adminPassword);
  await adminPage.getByRole("button", { name: "登 录", exact: true }).click();
  await expect(adminPage).toHaveURL(/\/admin$/u);
  await expect(adminPage.getByRole("heading", { name: "管理员总览", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/u);
  await page.getByLabel("用户名", { exact: true }).fill(ownerUsername);
  await page.getByLabel("密码", { exact: true }).fill(ownerPassword);
  await page.getByRole("button", { name: "登 录", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/u);
  await expect(page.getByRole("heading", { name: `欢迎回来，${ownerUsername}`, exact: true })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/dashboard$/u);
  await expect(page.getByRole("heading", { name: `欢迎回来，${ownerUsername}`, exact: true })).toBeVisible();
  await expect(page.getByText("AI PROJECT OS", { exact: true })).toBeVisible();
  await expect(page.getByText(/内部开发版/u)).toHaveCount(0);
  await expect(page).toHaveTitle("AI Project OS");
  await expect(page.getByText(/当前没有可访问项目/u)).toBeVisible();
  await expect(page.getByText("运行正常", { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page, "/dashboard", `欢迎回来，${ownerUsername}`, "dashboard");
  await expectNoAccessibilityViolations(page, "dashboard");

  const healthResponse = await request.get("/api/health");
  expect(healthResponse.ok()).toBe(true);
  expect(await healthResponse.json()).toMatchObject({
    status: "ok",
    version: "0.5.0-dev.3",
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
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/materials\\?view=add&kind=all$`, "u"));
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

  const sourceSearchInput = page.getByPlaceholder("搜索正文、来源链接或内容哈希");
  await sourceSearchInput.fill("Browser smoke");
  await sourceSearchInput.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/materials\\?search=Browser\\+smoke&kind=all$`, "u"));
  await page.getByLabel("按原始资料类型筛选").selectOption("manual");
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/materials\\?search=Browser\\+smoke&kind=manual$`, "u"));
  await page.getByRole("link", { name: "审核 AI 候选", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/materials/review\\?focus=review-queue&from=materials&returnTo=`, "u"));
  await expect(page.locator("#review-queue")).toBeFocused();
  await expect(page.getByRole("heading", { name: "审核 AI 候选", exact: true }).first()).toBeVisible();
  await expect(page.getByText("当前没有待审核 AI 候选。", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: /返回来源页面/u }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/materials\\?search=Browser\\+smoke&kind=manual&focus=sources-heading$`, "u"));
  await expect(page.getByPlaceholder("搜索正文、来源链接或内容哈希")).toHaveValue("Browser smoke");
  await expect(page.getByLabel("按原始资料类型筛选")).toHaveValue("manual");
  await expect(page.locator("#sources-heading")).toBeFocused();

  const returnedSourceRow = page.getByRole("list", { name: "项目原始资料列表", exact: true }).getByRole("listitem").filter({ hasText: sourceText });
  await expect(returnedSourceRow).toBeVisible();
  const sourceDetailsLink = returnedSourceRow.getByRole("link", { name: "查看详情", exact: true });
  const sourceLinkId = await sourceDetailsLink.getAttribute("id");
  if (sourceLinkId === null || !/^source-link-[0-9a-f-]+$/u.test(sourceLinkId)) throw new Error("source details link id missing");
  const returnedSourceId = sourceLinkId.slice("source-link-".length);
  await sourceDetailsLink.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/materials/sources/[0-9a-f-]+\\?returnTo=`, "u"));
  await expect(page.getByRole("heading", { name: "原始资料内容", exact: true })).toBeVisible();
  await expect(page.getByText(sourceText, { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "返回原始资料", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/materials\\?search=Browser\\+smoke&kind=manual&focus=${returnedSourceId}$`, "u"));
  const restoredSourceLink = page.locator(`#source-link-${returnedSourceId}`);
  await expect(restoredSourceLink).toBeVisible();
  await expect(restoredSourceLink).toBeFocused();

  const browserSmokeFixtures = await seedBrowserSmokeFixtures(projectId);

  await page.goto(`/projects/${projectId}`);
  const failedTasksLink = page.getByRole("link", { name: /任务异常/u });
  await expect(failedTasksLink).toBeVisible();
  await failedTasksLink.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/governance\\?status=failed&focus=task-runs&from=overview&returnTo=`, "u"));
  await expect(page.getByLabel("按任务状态筛选")).toHaveValue("failed");
  await expect(page.locator("#task-runs")).toBeFocused();
  await expect(page.getByText("BROWSER_SMOKE_PENDING", { exact: false })).toBeVisible();
  await page.getByRole("link", { name: "查看详情", exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/jobs/${browserSmokeFixtures.pendingJobId}\\?.*from=governance&returnTo=`, "u"));
  await page.getByRole("link", { name: /返回任务列表/u }).click();
  await expect(page.getByLabel("按任务状态筛选")).toHaveValue("failed");
  await expect(page.locator("#task-runs")).toBeFocused();
  await page.getByRole("link", { name: /返回来源页面/u }).click();
  await expect(page.locator("#current-state")).toBeFocused();

  await page.goto(`/projects/${projectId}/materials/review?focus=review-queue&from=overview&returnTo=${encodeURIComponent(`/projects/${projectId}?focus=current-state`)}`);
  await expect(page.locator("#review-queue")).toBeFocused();
  await expect(page.getByText("原始资料 → AI 候选 → 已确认事实 → AI 可引用记忆", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /返回来源页面/u })).toBeVisible();

  await page.goto(`/projects/${projectId}/intelligence?focus=runtime-readiness`);
  await expect(page.locator("#runtime-readiness")).toBeFocused();
  await expect(page.getByText("就绪条件", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("当前缺失", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "当前 AI 路由边界", exact: true })).toBeVisible();
  await expect(page.getByText(/当前项目/u).first()).toBeVisible();

  await page.goto(`/projects/${projectId}/automations`);
  await page.getByRole("button", { name: "预览并确认", exact: true }).click();
  const automationPreview = page.getByRole("region", { name: "创建前影响预览" });
  await expect(automationPreview).toBeVisible();
  await expect(automationPreview.getByRole("heading", { name: "本次自动化边界", exact: true })).toBeVisible();
  await expect(automationPreview.getByText("不使用模型或个人连接", { exact: true })).toBeVisible();
  await expect(automationPreview.getByText("不产生模型费用", { exact: true })).toBeVisible();
  await expect(automationPreview.getByText("下一次预计运行（UTC）", { exact: true })).toBeVisible();
  await expect(automationPreview.getByText("业务执行失败不会在当前周期内自动重试；Worker 租约过期会按恢复策略安排后续运行；连续失败 3 次后自动暂停规则", { exact: true })).toBeVisible();
  await automationPreview.getByRole("button", { name: "返回修改", exact: true }).click();

  await page.goto("/dashboard");
  const dashboardJobLink = page.locator(`a[href="/projects/${projectId}/jobs/${browserSmokeFixtures.jobId}"]`);
  await expect(dashboardJobLink).toBeVisible();
  await dashboardJobLink.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/jobs/${browserSmokeFixtures.jobId}$`, "u"));
  await expect(page.getByRole("heading", { name: "项目简报", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard$/u);
  await expectNoHorizontalOverflow(page, "/dashboard", `欢迎回来，${ownerUsername}`, "dashboard with recent job");

  const mobileViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");
  const mobileNavigationTargets = [
    { name: /打开通知中心/u, path: /\/notifications$/u },
    { name: `个人中心：${ownerUsername}`, path: /\/profile$/u },
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
    await expect(page.getByRole("heading", { name: `欢迎回来，${ownerUsername}` })).toBeVisible();
  }
  if (mobileViewport !== null) await page.setViewportSize(mobileViewport);

  await expectNoHorizontalOverflow(page, "/notifications", "活动记录", "notifications");
  await page.goto("/notifications");
  await expect(page).toHaveURL(/\/notifications$/u);
  await expect(page.getByRole("heading", { name: "活动记录", exact: true })).toBeVisible();
  const unreadActivity = page.locator("article").filter({ hasText: browserSmokeFixtures.unreadTitle });
  const pendingActivity = page.locator("article").filter({ hasText: browserSmokeFixtures.pendingTitle });
  const automationActivity = page.locator("article").filter({ hasText: browserSmokeFixtures.automationTitle });
  const systemHistory = page.locator("article").filter({ hasText: browserSmokeFixtures.systemTitle });
  await expect(unreadActivity).toBeVisible();
  await expect(pendingActivity).toBeVisible();
  await expect(automationActivity).toBeVisible();
  await expect(systemHistory).toBeVisible();
  await expectNoAccessibilityViolations(page, "notifications");

  await page.getByRole("button", { name: /待处理/u }).click();
  await expect(page.getByText(browserSmokeFixtures.pendingTitle, { exact: true })).toBeVisible();
  const pendingFilteredActivity = page.locator("article").filter({ hasText: browserSmokeFixtures.pendingTitle });
  await pendingFilteredActivity.getByRole("button", { name: "查看详情", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/jobs/${browserSmokeFixtures.pendingJobId}\\?from=notifications&view=pending&focus=[0-9a-f-]+$`, "iu"));
  await expect(page.getByRole("heading", { name: "项目简报", exact: true })).toBeVisible();
  await page.getByRole("link", { name: /返回通知中心/u }).click();
  await expect(page).toHaveURL(/\/notifications\?view=pending&focus=[0-9a-f-]+$/iu);
  const returnedPendingActivity = page.locator("article").filter({ hasText: browserSmokeFixtures.pendingTitle });
  await expect(returnedPendingActivity).toBeVisible();
  await expect(returnedPendingActivity.getByText("待处理", { exact: true })).toBeVisible();
  await expect(returnedPendingActivity.getByText("已读", { exact: true })).toBeVisible();
  await page.goto("/notifications");

  await page.getByRole("button", { name: /待处理/u }).click();
  const pendingAutomationActivity = page.locator("article").filter({ hasText: browserSmokeFixtures.automationTitle });
  await expect(pendingAutomationActivity).toBeVisible();
  await pendingAutomationActivity.getByRole("button", { name: "查看详情", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/automations\\?run=${browserSmokeFixtures.automationRunId}&from=notifications&view=pending&focus=[0-9a-f-]+$`, "iu"));
  await expect(page.getByText("运行详情", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "返回活动记录", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "返回活动记录", exact: true }).click();
  await expect(page).toHaveURL(/\/notifications\?view=pending&focus=[0-9a-f-]+$/iu);
  const returnedAutomationActivity = page.locator("article").filter({ hasText: browserSmokeFixtures.automationTitle });
  await expect(returnedAutomationActivity).toBeVisible();
  await expect(returnedAutomationActivity.getByText("待处理", { exact: true })).toBeVisible();
  await expect(returnedAutomationActivity.getByText("已读", { exact: true })).toBeVisible();
  await page.goto("/notifications");

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
  const mcpBoundary = page.locator("section").filter({ hasText: "当前使用边界" });
  await expect(mcpBoundary).toHaveCount(1);
  await expect(mcpBoundary.getByText(/项目委托控制面已开放/u)).toBeVisible();
  await expect(mcpBoundary.getByText(/远端动作、自动化和调用审批仍未开放/u)).toBeVisible();
  await expect(mcpBoundary.getByText(/MCP 连通性仍未验证/u)).toBeVisible();
  await expectNoAccessibilityViolations(page, "personal MCP connections");
  await page.goto("/profile");

  const membershipGrant = await adminPage.evaluate(async (targetUsername) => {
    const listResponse = await fetch(`/api/system/memberships?search=${encodeURIComponent(targetUsername)}`, { cache: "no-store" });
    if (!listResponse.ok) throw new Error(`membership list failed: ${listResponse.status}`);
    const list = await listResponse.json() as { items: Array<{ id: string; username: string }> };
    const currentUser = list.items.find((item) => item.username === targetUsername);
    if (currentUser === undefined) throw new Error(`${targetUsername} membership row missing`);
    const grantDays = 1;
    const grantNote = "browser smoke disposable";
    const previewResponse = await fetch("/api/system/memberships/preview", {
      method: "POST",
      headers: { "content-type": "application/json", origin: window.location.origin },
      body: JSON.stringify({ userId: currentUser.id, action: "grant", days: grantDays, note: grantNote }),
    });
    const previewBody = await previewResponse.json() as {
      preview?: {
        action: "grant" | "extend" | "revoke";
        current: { version: number };
        blockingCategories: string[];
        canExecute: boolean;
        impactFingerprint: string;
        requestFingerprint: string;
        previewId: string;
        previewIssuedAt: string;
        previewExpiresAt: string;
      };
      error?: { message?: string };
    };
    if (!previewResponse.ok || previewBody.preview === undefined) {
      throw new Error(`membership preview failed: ${previewResponse.status} ${previewBody.error?.message ?? "unknown error"}`);
    }
    const preview = previewBody.preview;
    if (!preview.canExecute || preview.blockingCategories.length > 0) {
      throw new Error(`membership preview blocked: ${preview.blockingCategories.join(", ") || "unknown dependency"}`);
    }
    const requestKey = crypto.randomUUID();
    const response = await fetch(`/api/system/memberships/${currentUser.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: window.location.origin },
      body: JSON.stringify({
        action: preview.action,
        days: grantDays,
        note: grantNote,
        expectedVersion: preview.current.version,
        expectedImpactFingerprint: preview.impactFingerprint,
        requestKey,
        requestFingerprint: preview.requestFingerprint,
        previewId: preview.previewId,
        previewIssuedAt: preview.previewIssuedAt,
        previewExpiresAt: preview.previewExpiresAt,
        confirmation: true,
      }),
    });
    const body = await response.json() as { subscription?: { status?: string }; error?: { message?: string } };
    if (!response.ok) throw new Error(`membership grant failed: ${response.status} ${body.error?.message ?? "unknown error"}`);
    return { status: response.status, body };
  }, ownerUsername);
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

  await adminPage.goto("/admin");
  await expect(adminPage.getByRole("heading", { name: "管理员总览" })).toBeVisible();
  await expect(adminPage.getByRole("navigation", { name: "管理工作台导航" })).toBeVisible();
  await expect(adminPage.getByText("平台额度总览", { exact: true })).toBeVisible();
  const initialPendingActions = adminPage.locator('[aria-labelledby="admin-pending-actions-title"]');
  await expect(initialPendingActions.getByText("无待办", { exact: true })).toHaveCount(1);
  await expect(initialPendingActions.getByText("待处理", { exact: true })).toHaveCount(3);
  await expect(initialPendingActions.getByText("未取得", { exact: true })).toHaveCount(0);
  await expectNoAccessibilityViolations(adminPage, "admin overview");

  await adminPage.goto("/admin/connectors/mcp");
  await expect(adminPage.getByRole("heading", { name: "MCP 工具安全审核", exact: true })).toBeVisible();
  await expect(adminPage.getByText(/审核已经净化的工具快照/u)).toBeVisible();
  await expect(adminPage.getByText(/不开放远端工具操作/u)).toBeVisible();
  await expect(adminPage.getByLabel("Bearer Token", { exact: true })).toHaveCount(0);
  await expectNoAccessibilityViolations(adminPage, "MCP connections");
  expect(browserErrors).toEqual([]);
  await adminContext.close();
});
