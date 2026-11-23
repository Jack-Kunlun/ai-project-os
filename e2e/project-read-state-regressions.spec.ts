import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { getDb } from "@/lib/db";
import { deleteArchivedProject, updateProjectLifecycle } from "@/lib/project-lifecycle";
import { seedBrowserPersonalUser, type BrowserPersonalUser } from "./support/browser-fixtures";

test.setTimeout(180_000);

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function createOwnedProject(page: Page, label: string): Promise<{ id: string; name: string; owner: BrowserPersonalUser }> {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedBrowserPersonalUser(`project-read-${label}-${suffix}`, "ProjectRead2026Password!");
  await signInOwner(page, owner);
  const response = await page.request.post("/api/projects", {
    headers: { origin: new URL(page.url()).origin },
    data: { name: `Project read ${label} ${suffix}`, workspaceId: owner.workspaceId },
  });
  expect(response.status()).toBe(201);
  const payload = await response.json() as { project: { id: string; name: string } };
  return { ...payload.project, owner };
}

async function signInOwner(page: Page, owner: BrowserPersonalUser): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/^(?:用户名或手机号|用户名、手机号或已验证邮箱)$/u).fill(owner.username);
  await page.getByLabel("密码", { exact: true }).fill(owner.password);
  await page.getByRole("button", { name: "登 录", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/u, { timeout: 30_000 });
}

async function prepareOwnerProject(page: Page, label: string) {
  return await createOwnedProject(page, label);
}

async function cleanupProject(projectId: string, owner: BrowserPersonalUser): Promise<void> {
  const db = getDb();
  const account = await db.appUser.findUniqueOrThrow({ where: { id: owner.id }, select: { accountAccessVersion: true } });
  const actor = { id: owner.id, role: "user" as const, accountAccessVersion: account.accountAccessVersion };
  const project = await db.project.findUnique({ where: { id: projectId }, select: { name: true, archivedAt: true, updatedAt: true } });
  if (project === null) return;
  if (project.archivedAt === null) {
    await updateProjectLifecycle({ projectId, actor, action: "archive", expectedUpdatedAt: project.updatedAt }, db);
  }
  const archived = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true, updatedAt: true } });
  await deleteArchivedProject({ projectId, actor, confirmationName: archived.name, expectedUpdatedAt: archived.updatedAt }, db);
}

async function controlledFailure(route: import("@playwright/test").Route, message = "受控读取失败") {
  await route.fulfill({ status: 503, json: { error: { code: "CONTROLLED_READ_FAILURE", message } } });
}

test("T-053 invalidates an automation preview when the rule name changes while it is pending", async ({ page }) => {
  const project = await prepareOwnerProject(page, "automation");
  const owner = project.owner;
  const previewStarted = deferred();
  const releasePreview = deferred();
  const submittedNames: string[] = [];

  try {
    await page.route((url) => url.pathname === `/api/projects/${project.id}/automations/preview`, async (route) => {
      const body = route.request().postDataJSON() as { name: string };
      if (body.name.includes("before")) {
        previewStarted.resolve();
        const response = await route.fetch();
        await releasePreview.promise;
        await route.fulfill({ response });
        return;
      }
      await route.fallback();
    });
    await page.route((url) => url.pathname === `/api/projects/${project.id}/automations` && url.search === "", async (route) => {
      if (route.request().method() !== "POST") return await route.fallback();
      const body = route.request().postDataJSON() as { name: string };
      submittedNames.push(body.name);
      await route.fulfill({ status: 409, json: { error: { code: "TEST_CAPTURED", message: "已捕获确认请求" } } });
    });

    await page.goto(`/projects/${project.id}/automations`);
    await page.getByRole("button", { name: "添加自动化", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "添加自动化", exact: true });
    const name = dialog.getByLabel("规则名称", { exact: true });
    await name.fill("T-053 before");
    await dialog.getByRole("button", { name: "预览并确认", exact: true }).click();
    await previewStarted.promise;
    await name.fill("T-053 after");
    releasePreview.resolve();
    await expect(dialog.getByRole("button", { name: "预览并确认", exact: true })).toBeEnabled();
    await expect(dialog.getByRole("heading", { name: "创建前影响预览", exact: true })).toHaveCount(0);

    await dialog.getByRole("button", { name: "预览并确认", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: "创建前影响预览", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "确认创建", exact: true }).click();
    await expect.poll(() => submittedNames).toEqual(["T-053 after"]);
  } finally {
    await cleanupProject(project.id, owner);
  }
});

test("T-060 ignores an old web-source filter failure after the disabled list succeeds", async ({ page }) => {
  const project = await prepareOwnerProject(page, "web-sources");
  const owner = project.owner;
  const activeStarted = deferred();
  const releaseActive = deferred();
  const source = {
    id: randomUUID(), name: "受控停用来源", url: "https://example.test/", allowPrivateNetwork: false,
    authenticationMode: "none", bearerConfigured: false, status: "disabled", lastFetchedAt: null,
    lastErrorCode: null, pendingReview: null, pointer: null,
  };

  try {
    await page.route((url) => url.pathname === `/api/projects/${project.id}/web-sources`, async (route) => {
      const status = new URL(route.request().url()).searchParams.get("status");
      if (status === "active") {
        activeStarted.resolve();
        await releaseActive.promise;
        await controlledFailure(route, "受控的旧筛选失败");
        return;
      }
      await route.fulfill({ json: {
        sources: status === "disabled" || status === "all" ? [source] : [],
        pagination: { page: 1, pageSize: 10, total: 1, totalPages: 1 },
        canManageCredentials: true, canReview: true, browserEnabled: false,
      } });
    });

    await page.goto(`/projects/${project.id}/external-sources`);
    const status = page.getByRole("combobox", { name: "筛选网页资料状态", exact: true });
    await expect(status).toBeEnabled();
    await status.selectOption("active");
    await activeStarted.promise;
    await status.selectOption("disabled");
    await expect(page.getByText("受控停用来源", { exact: true })).toBeVisible();
    releaseActive.resolve();
    await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
    await expect(status).toHaveValue("disabled");
    await expect(page.getByText("受控停用来源", { exact: true })).toBeVisible();
    await status.selectOption("active");
    await expect(page.locator("main").getByRole("alert")).toBeVisible();
    await expect(page.getByText("受控停用来源", { exact: true })).toHaveCount(0);
    await expect(page.getByText("没有匹配的网页资料。", { exact: true })).toHaveCount(0);
  } finally {
    releaseActive.resolve();
    await cleanupProject(project.id, owner);
  }
});

test("T-067 ignores a failed task response after the completed filter succeeds", async ({ page }) => {
  const project = await prepareOwnerProject(page, "governance");
  const owner = project.owner;
  const failedStarted = deferred();
  const releaseFailed = deferred();

  try {
    await page.route((url) => url.pathname === `/api/projects/${project.id}/governance/operations`, async (route) => {
      const status = new URL(route.request().url()).searchParams.get("status");
      if (status === "failed") {
        failedStarted.resolve();
        await releaseFailed.promise;
        await controlledFailure(route, "受控的失败任务查询");
        return;
      }
      await route.fulfill({ json: { items: [], nextCursor: null } });
    });

    await page.goto(`/projects/${project.id}/governance?tab=usage`);
    const status = page.getByRole("combobox", { name: "按任务状态筛选", exact: true });
    await status.selectOption("failed");
    await failedStarted.promise;
    await status.selectOption("succeeded");
    const taskRuns = page.locator("#task-runs");
    await expect(taskRuns.getByText("当前筛选条件下没有项目任务。", { exact: true })).toBeVisible();
    await expect(taskRuns.getByRole("alert")).toHaveCount(0);
    releaseFailed.resolve();
    await expect(status).toHaveValue("succeeded");
    await expect(taskRuns.getByRole("alert")).toHaveCount(0);
    await expect(taskRuns.getByText("当前筛选条件下没有项目任务。", { exact: true })).toBeVisible();
  } finally {
    releaseFailed.resolve();
    await cleanupProject(project.id, owner);
  }
});

test("T-064 distinguishes read failures from empty data across all six project pages", async ({ page }) => {
  const project = await prepareOwnerProject(page, "unknown-state");
  const owner = project.owner;

  try {
    const failures: Array<{ pathname: string; pagePath: string; emptyText: string }> = [
      { pathname: `/api/projects/${project.id}/assets`, pagePath: "assets", emptyText: "还没有文件。" },
      { pathname: `/api/projects/${project.id}/jobs`, pagePath: "control", emptyText: "还没有页面任务。" },
      { pathname: `/api/projects/${project.id}/web-sources`, pagePath: "external-sources", emptyText: "还没有网页来源。公开静态网页添加后会抓取；认证及浏览器来源需手动抓取和审核。" },
      { pathname: `/api/projects/${project.id}/memory-quality`, pagePath: "memory-quality", emptyText: "当前没有待处理质量问题" },
      { pathname: `/api/projects/${project.id}/world`, pagePath: "world", emptyText: "尚无当前有效事实" },
      { pathname: `/api/projects/${project.id}/mcp-tool-grants`, pagePath: "tools", emptyText: "还没有工具授权。" },
    ];

    for (const scenario of failures) {
      const matchesScenario = (url: URL) => url.pathname === scenario.pathname;
      await page.route(matchesScenario, async (route) => {
        await controlledFailure(route, `受控读取失败：${scenario.pagePath}`);
      });
      await page.goto(`/projects/${project.id}/${scenario.pagePath}`);
      await expect(page.locator("main").getByRole("alert")).toBeVisible();
      await expect(page.getByText(scenario.emptyText, { exact: true })).toHaveCount(0);
      await page.unroute(matchesScenario);
    }
    await expect(page.getByRole("heading", { name: "V2 只读工具授权", exact: true })).toBeVisible();
    await expect(page.getByText("工具授权暂不可用，请检查上方错误并重试。", { exact: true })).toBeVisible();
  } finally {
    await cleanupProject(project.id, owner);
  }
});

test("T-068 keeps a successful audit read visible through grant failure and clears the recovered error", async ({ page }) => {
  const project = await prepareOwnerProject(page, "mcp-export");
  const owner = project.owner;
  const recipient = `受控 MCP 客户端 ${randomUUID().slice(0, 6)}`;
  const audit = {
    id: randomUUID(), recipientLabel: recipient, oauthClientId: "client-fixture", oauthClientName: recipient,
    provider: "隔离测试服务", model: "fixture", operation: "project_summary", inputFingerprint: "a".repeat(64),
    contentFingerprint: "b".repeat(64), createdAt: new Date().toISOString(),
  };
  let grantReads = 0;
  let outboundWrites = 0;

  try {
    await page.route((url) => url.pathname === "/api/me/mcp-export-grants", async (route) => {
      if (route.request().method() !== "GET") {
        outboundWrites += 1;
        await route.fallback();
        return;
      }
      grantReads += 1;
      if (grantReads === 1) await controlledFailure(route, "受控凭证列表失败");
      else await route.fulfill({ json: { grants: [] } });
    });
    await page.route((url) => url.pathname === "/api/me/mcp-export-audits", async (route) => {
      await route.fulfill({ json: { audits: [audit] } });
    });

    await page.goto(`/projects/${project.id}/mcp-export`);
    await expect(page.getByRole("heading", { name: "最近外发记录", exact: true })).toBeVisible();
    await expect(page.getByText(`${recipient} · project_summary`, { exact: true })).toBeVisible();
    await expect(page.locator("main").getByRole("alert")).toBeVisible();
    await expect(page.getByText("暂无外发记录。", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "刷新记录", exact: true }).click();
    await expect.poll(() => grantReads).toBe(2);
    await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
    await expect(page.getByText(`${recipient} · project_summary`, { exact: true })).toBeVisible();
    expect(outboundWrites).toBe(0);
  } finally {
    await cleanupProject(project.id, owner);
  }
});
