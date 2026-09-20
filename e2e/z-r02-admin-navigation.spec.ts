import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { grantWorkspaceMembership } from "@/lib/membership-governance";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createControlledMembership } from "../test/membership-fixture";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import {
  expectR02MobileDrawer,
  expectR02InViewport,
  expectR02NoAccessibilityViolations,
  expectR02NoHorizontalOverflow,
  expectR02SettledRoute,
  expectedR02AdminNavigationLinkCount,
  r02ProjectGuardRoutes,
  r02ProjectRoutes,
  R02_PUBLIC_ROUTE_EXPECTATIONS,
  R02_ADMIN_ROUTES,
  R02_VIEWPORTS,
  signInR02Admin,
  signInR02PersonalUser,
} from "./support/r02-admin-navigation";

const R02_ACTOR_PASSWORD = "R02Actor2026Password!";

async function expectR02OverviewErrorState(page: Page): Promise<void> {
  const overviewRoute = "**/api/system/overview";
  await page.route(overviewRoute, async (route) => {
    await route.abort();
  });
  await page.goto("/admin");
  const unavailableActions = page.locator('[aria-labelledby="admin-pending-actions-title"]');
  await expect(page.locator('p[role="alert"]')).toBeVisible();
  await expect(unavailableActions.getByText("未取得", { exact: true })).toHaveCount(8);
  await expect(unavailableActions.getByText("0", { exact: true })).toHaveCount(0);
  await page.unroute(overviewRoute);
}

async function expectR02AdminBrand(page: Page): Promise<void> {
  const brand = page.getByRole("link", { name: "AI Project OS 平台管理总览", exact: true });
  await expect(brand).toHaveCount(1);
  await expect(brand).toHaveAttribute("href", "/admin");
}

async function expectProviderDialogScrollsOnlyItsContent(page: Page): Promise<void> {
  await page.locator("main header").getByRole("button", { name: "新增供应商", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新增供应商", exact: true });
  await expect(dialog).toBeVisible();
  const geometry = await dialog.evaluate((element) => {
    const header = element.querySelector("header");
    const content = element.querySelector("form > div");
    const footer = element.querySelector("footer");
    if (!header || !content || !footer) throw new Error("PROVIDER_DIALOG_STRUCTURE_INVALID");
    const headerTop = header.getBoundingClientRect().top;
    const footerTop = footer.getBoundingClientRect().top;
    const scrollable = content.scrollHeight > content.clientHeight;
    content.scrollTop = content.scrollHeight;
    return {
      height: element.getBoundingClientRect().height,
      viewportHeight: window.innerHeight,
      scrollable,
      scrolled: content.scrollTop > 0,
      headerStayed: Math.abs(header.getBoundingClientRect().top - headerTop) < 1,
      footerStayed: Math.abs(footer.getBoundingClientRect().top - footerTop) < 1,
    };
  });
  expect(geometry.height).toBeLessThanOrEqual(Math.min(544, geometry.viewportHeight - 48) + 1);
  expect(geometry.scrollable).toBe(true);
  expect(geometry.scrolled).toBe(true);
  expect(geometry.headerStayed).toBe(true);
  expect(geometry.footerStayed).toBe(true);
  await dialog.getByRole("button", { name: "关闭新增供应商" }).click();
  await expect(dialog).toHaveCount(0);
}

type R02ActorKind = "free" | "active" | "expired" | "disabled";
type R02Actor = Readonly<{ id: string; username: string; password: string; workspaceId: string; kind: R02ActorKind }>;
type R02Actors = Readonly<Record<R02ActorKind, R02Actor>>;

async function seedR02Actors(): Promise<R02Actors> {
  const db = getDb();
  try {
    const admin = await db.appUser.findUniqueOrThrow({ where: { username: "browser_admin" }, select: { id: true } });
    const actors = {} as Record<R02ActorKind, R02Actor>;
    for (const kind of ["free", "active", "expired", "disabled"] as const) {
      const username = `r02-${kind}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const personalUser = await seedBrowserPersonalUser(username, R02_ACTOR_PASSWORD);
      actors[kind] = { id: personalUser.id, username: personalUser.username, password: personalUser.password, workspaceId: personalUser.workspaceId, kind };
    }
    await db.$transaction(async (tx) => {
      await grantWorkspaceMembership(tx, {
        workspaceId: actors.disabled.workspaceId,
        userId: actors.active.id,
        role: "owner",
        actorId: actors.disabled.id,
        reason: "r02_disable_preserves_confirmed_workspace_owner",
      });
    });
    const now = new Date();
    await createControlledMembership(db, {
      adminId: admin.id,
      userId: actors.active.id,
      startsAt: new Date(now.getTime() - 60_000),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
      note: "R02 browser active membership fixture",
    });
    await createControlledMembership(db, {
      adminId: admin.id,
      userId: actors.expired.id,
      startsAt: new Date(now.getTime() - 2 * 24 * 60 * 60_000),
      expiresAt: new Date(now.getTime() - 60_000),
      note: "R02 browser expired membership fixture",
    });
    return actors;
  } finally {
    await db.$disconnect();
  }
}

async function createR02Project(page: Parameters<typeof signInR02Admin>[0]): Promise<Readonly<{ id: string; name: string }>> {
  await page.goto("/projects");
  await page.getByRole("button", { name: "＋ 新建项目", exact: true }).click();
  const name = `R02 browser project ${randomUUID().slice(0, 8)}`;
  await page.getByLabel("项目名称", { exact: true }).fill(name);
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  const href = await page.getByRole("link", { name, exact: true }).getAttribute("href");
  expect(href).toMatch(/^\/projects\/[0-9a-f-]+$/u);
  return { id: href!.split("/")[2]!, name };
}

async function seedR02DetailFixtures(projectId: string, actorId: string): Promise<Readonly<{ sourceId: string; sourceText: string; jobId: string; syncRunId: string }>> {
  const db = getDb();
  try {
    const owner = await db.appUser.findUniqueOrThrow({ where: { id: actorId }, select: { id: true } });
    const sourceText = "R02 valid source detail fixture";
    const contentHash = createHash("sha256").update(sourceText).digest("hex");
    const source = await db.projectSource.create({
      data: { projectId, kind: "manual", contentText: sourceText, contentHash, manualContentDedupeKey: contentHash },
      select: { id: true },
    });
    const completedAt = new Date();
    const job = await db.backgroundJob.create({
      data: {
        projectId,
        kind: "projectBrief",
        status: "succeeded",
        stage: "terminal",
        payload: { source: "r02-browser" },
        result: { summary: "R02 valid completed job" },
        progressCurrent: 1,
        progressTotal: 1,
        idempotencyKey: createHash("sha256").update(`r02-job:${projectId}:${randomUUID()}`).digest("hex"),
        requestedById: owner.id,
        startedAt: completedAt,
        completedAt,
      },
      select: { id: true },
    });
    const syncJob = await db.backgroundJob.create({
      data: {
        projectId,
        kind: "githubProjectSync",
        status: "succeeded",
        stage: "terminal",
        payload: { source: "r02-browser" },
        progressCurrent: 0,
        progressTotal: 0,
        idempotencyKey: createHash("sha256").update(`r02-sync-job:${projectId}:${randomUUID()}`).digest("hex"),
        requestedById: owner.id,
        startedAt: completedAt,
        completedAt,
      },
      select: { id: true },
    });
    const syncRun = await db.projectGitHubSyncRun.create({
      data: {
        projectId,
        parentJobId: syncJob.id,
        status: "succeeded",
        stage: "terminal",
        scopeFingerprint: createHash("sha256").update(`r02-sync-scope:${projectId}`).digest("hex"),
        manifestFingerprint: createHash("sha256").update(`r02-sync-manifest:${projectId}`).digest("hex"),
        deadlineAt: new Date(completedAt.getTime() + 60_000),
        warnings: [],
        startedAt: completedAt,
        completedAt,
      },
      select: { id: true },
    });
    await db.backgroundJob.update({
      where: { id: syncJob.id },
      data: { result: { syncRunId: syncRun.id, counts: { added: 0, updated: 0, deleted: 0, withheld: 0 }, warnings: [] } },
    });
    return { sourceId: source.id, sourceText, jobId: job.id, syncRunId: syncRun.id };
  } finally {
    await db.$disconnect();
  }
}

async function signInR02Actor(page: Parameters<typeof signInR02Admin>[0], actor: R02Actor, returnTo = "/profile"): Promise<void> {
  await page.goto(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  await expect(page).toHaveURL(/\/login(?:\?returnTo=.*)?$/u);
  await page.getByLabel("用户名", { exact: true }).fill(actor.username);
  await page.getByLabel("密码", { exact: true }).fill(actor.password);
  await page.getByRole("button", { name: "登 录", exact: true }).click();
  await expect.poll(() => {
    const url = new URL(page.url());
    return `${url.pathname}${url.search}`;
  }).toBe(returnTo);
}

async function postR02PersonalProvider(page: Parameters<typeof signInR02Admin>[0]): Promise<Readonly<{ status: number; body: string }>> {
  return page.evaluate(async () => {
    const response = await fetch("/api/me/ai-providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "R02 denied model fixture",
        kind: "openai",
        apiKey: "r02-placeholder-key-2026",
        generationModelId: "gpt-4.1",
        visionModelId: null,
        embeddingModelId: null,
        embeddingDimensions: null,
      }),
    });
    return { status: response.status, body: await response.text() };
  });
}

async function disableR02Actor(page: Parameters<typeof signInR02Admin>[0], actor: R02Actor): Promise<void> {
  const result = await page.evaluate(async ({ id, username }) => {
    const previewResponse = await fetch(`/api/system/account-access/${id}/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "disable", reason: "R02 browser account lifecycle fixture" }),
    });
    const previewBody = await previewResponse.json() as {
      preview?: {
        current: { accountAccessVersion: number };
        impactFingerprint: string;
        requestFingerprint: string;
        previewId: string;
        previewIssuedAt: string;
        previewExpiresAt: string;
      };
    };
    if (!previewResponse.ok || previewBody.preview === undefined) {
      return { status: previewResponse.status, body: JSON.stringify(previewBody) };
    }
    const preview = previewBody.preview;
    const requestKey = crypto.randomUUID();
    const response = await fetch(`/api/system/account-access/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "disable",
        reason: "R02 browser account lifecycle fixture",
        expectedVersion: preview.current.accountAccessVersion,
        expectedImpactFingerprint: preview.impactFingerprint,
        requestKey,
        requestFingerprint: preview.requestFingerprint,
        previewId: preview.previewId,
        previewIssuedAt: preview.previewIssuedAt,
        previewExpiresAt: preview.previewExpiresAt,
        confirmation: true,
        confirmationUsername: username,
      }),
    });
    return { status: response.status, body: await response.text() };
  }, { id: actor.id, username: actor.username });
  expect(result.status, result.body).toBe(200);
}

test("R02 production pages preserve the trusted admin entry and responsive admin navigation", async ({ page, browser }) => {
  test.setTimeout(360_000);
  await signInR02Admin(page);

  const personalUser = await seedBrowserPersonalUser(`r02-personal-${randomUUID().replaceAll("-", "").slice(0, 16)}`, "R02Personal2026Password!");
  const ownerContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  await signInR02PersonalUser(ownerPage, personalUser);

  await expectR02OverviewErrorState(page);

  for (const path of ["/dashboard", "/projects", "/team"] as const) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/admin$/u);
  }

  for (const path of ["/dashboard", "/projects", "/team", "/notifications", "/profile", "/guide"] as const) {
    for (const width of R02_VIEWPORTS) {
      await ownerPage.setViewportSize({ width, height: 844 });
      await ownerPage.goto(path);
      await expect(ownerPage.getByRole("link", { name: "管理工作台", exact: true })).toHaveCount(0);
      await expectR02NoHorizontalOverflow(ownerPage, `${path}@${width}`);
    }
  }

  for (const [path, expectedPath] of R02_PUBLIC_ROUTE_EXPECTATIONS) {
    const response = await ownerPage.goto(path);
    expect(response?.status(), `${path} must be reachable or redirect safely`).toBeLessThan(400);
    await expect.poll(() => {
      const url = new URL(ownerPage.url());
      return `${url.pathname}${url.search}`;
    }).toBe(expectedPath);
  }

  for (const [path, expectedPath] of [
    ["/settings", "/admin/models"],
    ["/system/memberships", "/admin/users/memberships"],
    ["/system/operations", "/admin/operations/backups"],
  ] as const) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`${expectedPath.replaceAll("/", "\\/")}$`, "u"));
  }

  await ownerPage.setViewportSize({ width: 1440, height: 844 });
  await ownerPage.goto("/projects?focus=r02-header");
  await expect(ownerPage.getByRole("link", { name: "管理工作台", exact: true })).toHaveCount(0);
  await ownerPage.goto("/projects?focus=r02-header");
  await expectR02NoAccessibilityViolations(ownerPage, "projects shared header@1440");

  for (const width of R02_VIEWPORTS) {
    await page.setViewportSize({ width, height: 844 });
    for (const route of R02_ADMIN_ROUTES) {
      await page.setViewportSize({ width, height: route.path === "/admin/models" && width === 1440 ? 900 : 844 });
      const response = await page.goto(route.path);
      expect(response?.status(), `${route.path}@${width} must be reachable in production browser`).toBeLessThan(400);
      await expectR02SettledRoute(page, route, `${route.path}@${width}`);
      await expectR02AdminBrand(page);
      await expectR02NoHorizontalOverflow(page, `${route.path}@${width}`);
      if (width >= 1024) {
        await expect(page.getByRole("navigation", { name: "管理工作台导航", exact: true })).toBeVisible();
        await expect(page.getByRole("navigation", { name: "管理工作台导航", exact: true }).getByRole("link")).toHaveCount(expectedR02AdminNavigationLinkCount(route.path));
      } else {
        await expect(page.getByRole("button", { name: "打开导航", exact: true })).toBeVisible();
      }
      if (route.path === "/admin") {
        const readinessHeading = page.getByRole("heading", { name: "管理员总览", exact: true });
        await expectR02InViewport(page, readinessHeading, `admin primary heading@${width}`);
        const pendingActionsHeading = page.getByRole("heading", { name: "待处理事项", exact: true });
        await expectR02InViewport(page, pendingActionsHeading, `admin pending actions@${width}`);
      }
      if (route.path === "/admin/models") {
        await expect(page.locator("main header").getByRole("button", { name: "新增供应商", exact: true }), `platform model primary action@${width}`).toBeVisible();
        if (width === 1440 || width === 390) await expectProviderDialogScrollsOnlyItsContent(page);
      }
      if (width < 1024) await expectR02MobileDrawer(page, route.path);
    }
    if (width === 390) await expectR02NoAccessibilityViolations(page, "admin representative@390");
  }

  await page.goto("/admin/connectors/git");
  await expect(page).toHaveURL(/\/admin$/u);
  await expect(page.getByRole("heading", { name: "管理员总览", exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/admin");
  await expectR02SettledRoute(page, R02_ADMIN_ROUTES[0], "admin drawer navigation source@390");
  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  const mobileDrawer = page.getByRole("dialog", { name: "管理工作台导航" });
  await mobileDrawer.getByRole("button", { name: "展开安全中心", exact: true }).click();
  await mobileDrawer.getByRole("link", { name: "审计记录", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/audit$/u);
  await expect(mobileDrawer).toBeHidden();
  await expectR02SettledRoute(page, R02_ADMIN_ROUTES.find((route) => route.path === "/admin/audit")!, "admin drawer navigation target@390");

  await page.setViewportSize({ width: 1440, height: 844 });
  const project = await createR02Project(ownerPage);
  const projectRoutes = r02ProjectRoutes(project.id, project.name);
  for (const route of projectRoutes) {
    const response = await ownerPage.goto(route.path);
    expect(response?.status(), `${route.path} must be reachable in production browser`).toBeLessThan(400);
    await expectR02SettledRoute(ownerPage, route, `${route.path}@1440`);
    await expect(ownerPage.getByRole("link", { name: "管理工作台", exact: true })).toHaveCount(0);
    await expectR02NoHorizontalOverflow(ownerPage, `${route.path}@1440`);
  }
  const representativePaths = new Set([
    `/projects/${project.id}`,
    `/projects/${project.id}/materials`,
    `/projects/${project.id}/intelligence`,
    `/projects/${project.id}/automations`,
    `/projects/${project.id}/governance`,
  ]);
  for (const width of R02_VIEWPORTS.slice(1)) {
    await ownerPage.setViewportSize({ width, height: 844 });
    for (const route of projectRoutes.filter((candidate) => representativePaths.has(candidate.path))) {
      await ownerPage.goto(route.path);
      await expectR02SettledRoute(ownerPage, route, `${route.path}@${width} representative`);
      await expect(ownerPage.getByRole("link", { name: "管理工作台", exact: true })).toHaveCount(0);
      await expectR02NoHorizontalOverflow(ownerPage, `${route.path}@${width} representative`);
    }
  }
  for (const path of r02ProjectGuardRoutes(project.id)) {
    const response = await ownerPage.goto(path);
    expect(response?.status(), `${path} guard must render without a server error`).toBeLessThan(500);
    await expect(ownerPage.locator('[role="alert"]:not(#__next-route-announcer__)')).toBeVisible();
    await expect(ownerPage.getByRole("link", { name: "管理工作台", exact: true })).toHaveCount(0);
  }

  const details = await seedR02DetailFixtures(project.id, personalUser.id);
  await ownerPage.setViewportSize({ width: 390, height: 844 });
  const materialReturnTo = `/projects/${project.id}/materials?kind=all&focus=${details.sourceId}`;
  await ownerPage.goto(`/projects/${project.id}/materials/sources/${details.sourceId}?returnTo=${encodeURIComponent(materialReturnTo)}`);
  await expect(ownerPage.getByRole("heading", { name: "项目资料详情", exact: true })).toBeVisible();
  await expect(ownerPage.getByRole("heading", { name: "原始资料内容", exact: true })).toBeVisible();
  await expect(ownerPage.getByText(details.sourceText, { exact: true })).toBeVisible();
  await expect(ownerPage.locator(".animate-pulse")).toHaveCount(0);
  await expect(ownerPage.locator('[role="alert"]:not(#__next-route-announcer__)')).toHaveCount(0);
  await expectR02NoHorizontalOverflow(ownerPage, "valid source detail@390");
  await ownerPage.getByRole("link", { name: "返回原始资料", exact: true }).click();
  await expect.poll(() => `${new URL(ownerPage.url()).pathname}${new URL(ownerPage.url()).search}`).toBe(materialReturnTo);
  await expect(ownerPage.locator(`#source-link-${details.sourceId}`)).toBeFocused();

  const projectReturnTo = `/projects/${project.id}`;
  await ownerPage.goto(`/projects/${project.id}/jobs/${details.jobId}?from=governance&returnTo=${encodeURIComponent(projectReturnTo)}`);
  await expect(ownerPage.getByRole("heading", { name: "项目简报", exact: true })).toBeVisible();
  await expect(ownerPage.getByRole("heading", { name: "任务结果", exact: true })).toBeVisible();
  await expect(ownerPage.getByText("执行阶段：terminal", { exact: true })).toBeVisible();
  await expect(ownerPage.getByText("1 / 1 · 100%", { exact: true })).toBeVisible();
  await expect(ownerPage.locator(".animate-pulse")).toHaveCount(0);
  await expect(ownerPage.locator('[role="alert"]:not(#__next-route-announcer__)')).toHaveCount(0);
  await expectR02NoHorizontalOverflow(ownerPage, "valid job detail@390");
  await ownerPage.getByRole("link", { name: /返回任务列表/u }).click();
  await expect(ownerPage).toHaveURL(new RegExp(`/projects/${project.id}/governance\\?`, "u"));
  await expect(ownerPage.locator("#task-runs")).toBeFocused();

  await ownerPage.goto(`/projects/${project.id}/github-syncs/${details.syncRunId}`);
  await expect(ownerPage.getByRole("heading", { name: "一键同步详情", exact: true })).toBeVisible();
  await expect(ownerPage.getByRole("heading", { name: "冻结目标执行状态", exact: true })).toBeVisible();
  await expect(ownerPage.locator('[role="alert"]:not(#__next-route-announcer__)')).toHaveCount(0);
  await expectR02NoHorizontalOverflow(ownerPage, "valid GitHub sync detail@390");
  await ownerPage.getByRole("link", { name: /返回上一级/u }).click();
  await expect(ownerPage).toHaveURL(new RegExp(`/projects/${project.id}/repositories$`, "u"));

  const actors = await seedR02Actors();
  const freeContext = await browser.newContext();
  const activeContext = await browser.newContext();
  const expiredContext = await browser.newContext();
  const disabledContext = await browser.newContext();
  const freePage = await freeContext.newPage();
  const activePage = await activeContext.newPage();
  const expiredPage = await expiredContext.newPage();
  const disabledPage = await disabledContext.newPage();
  try {
    await signInR02Actor(freePage, actors.free, "/projects?focus=r02-return");
    await expect(freePage).toHaveURL(/\/projects\?focus=r02-return$/u);
    await expect(freePage.getByRole("link", { name: "管理工作台", exact: true })).toHaveCount(0);
    await freePage.goto("/admin");
    await expect(freePage).toHaveURL(/\/dashboard$/u);
    const projectResponse = await freePage.goto(`/projects/${project.id}`);
    expect(projectResponse?.status()).toBe(404);
    await expect(freePage.getByText(project.name, { exact: true })).toHaveCount(0);
    const projectApi = await freePage.evaluate(async (projectId) => {
      const response = await fetch(`/api/projects/${projectId}`);
      return { status: response.status, body: await response.text() };
    }, project.id);
    expect(projectApi.status).toBe(403);
    expect(projectApi.body).not.toContain(project.name);
    await freePage.goto("/profile");
    await expect(freePage.getByRole("link", { name: /查看我的模型/u })).toBeVisible();
    await expect(freePage.getByRole("link", { name: /管理我的模型/u })).toHaveCount(0);
    await freePage.goto("/profile/models");
    await expect(freePage.getByRole("heading", { name: "我的模型", exact: true })).toBeVisible();
    await expect(freePage.getByText("普通用户", { exact: true })).toBeVisible();
    await expect(freePage.getByRole("button", { name: "保存个人连接", exact: true })).toHaveCount(0);
    const freeProviderAttempt = await postR02PersonalProvider(freePage);
    expect(freeProviderAttempt.status).toBe(403);
    expect(freeProviderAttempt.body).not.toContain("r02-placeholder-key-2026");

    await signInR02Actor(activePage, actors.active);
    await expect(activePage.getByRole("link", { name: /管理我的模型/u })).toBeVisible();
    await activePage.goto("/profile/models");
    await expect(activePage.getByText("会员有效", { exact: true })).toBeVisible();
    await expect(activePage.getByRole("button", { name: "保存个人连接", exact: true })).toBeVisible();
    const activeProviderList = await activePage.evaluate(async () => {
      const response = await fetch("/api/me/ai-providers");
      return response.status;
    });
    expect(activeProviderList).toBe(200);

    await signInR02Actor(expiredPage, actors.expired);
    await expect(expiredPage.getByRole("link", { name: /查看我的模型/u })).toBeVisible();
    await expect(expiredPage.getByRole("link", { name: /管理我的模型/u })).toHaveCount(0);
    await expiredPage.goto("/profile/models");
    await expect(expiredPage.getByText("会员已到期", { exact: true })).toBeVisible();
    await expect(expiredPage.getByRole("button", { name: "保存个人连接", exact: true })).toHaveCount(0);
    const expiredProviderAttempt = await postR02PersonalProvider(expiredPage);
    expect(expiredProviderAttempt.status).toBe(403);
    expect(expiredProviderAttempt.body).not.toContain("r02-placeholder-key-2026");

    await signInR02Actor(disabledPage, actors.disabled);
    await expect(disabledPage).toHaveURL(/\/profile$/u);
    await disableR02Actor(page, actors.disabled);
    await disabledPage.goto("/dashboard");
    await expect(disabledPage).toHaveURL(/\/login$/u);
    await disabledPage.getByLabel("用户名", { exact: true }).fill(actors.disabled.username);
    await disabledPage.getByLabel("密码", { exact: true }).fill(actors.disabled.password);
    await disabledPage.getByRole("button", { name: "登 录", exact: true }).click();
    await expect(disabledPage).toHaveURL(/\/login$/u);
    await expect(disabledPage.getByText("用户名或密码错误", { exact: true })).toBeVisible();
  } finally {
    await Promise.all([ownerContext.close(), freeContext.close(), activeContext.close(), expiredContext.close(), disabledContext.close()]);
  }
});
