import { expect, test, type Page, type Route } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { signInR02Admin, signInR02PersonalUser, signOutR02User } from "./support/r02-admin-navigation";

test.setTimeout(120_000);

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function fulfillJson(route: Route, payload: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
}

async function signInPersonalUser(page: Page): Promise<void> {
  await signInR02Admin(page);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const user = await seedBrowserPersonalUser(`t051-personal-${suffix}`, "T051BrowserPersonal2026Password!");
  await signOutR02User(page);
  await signInR02PersonalUser(page, user);
}

async function failRead(page: Page, routePattern: string, path: string, falseEmpty: string): Promise<void> {
  await page.route(routePattern, (route) => fulfillJson(route, {
    error: { code: "ISOLATED_READ_FAILURE", message: "隔离读取失败" },
  }, 503));
  await page.goto(path);
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(page.getByText(falseEmpty, { exact: true })).toHaveCount(0);
  await page.unroute(routePattern);
}

test("T-064 personal pages show read failures instead of successful empty states", async ({ page }) => {
  await signInPersonalUser(page);

  await failRead(page, "**/api/me/ai-providers", "/personal/models", "还没有个人模型连接");
  const personalModelConnections = page.locator("section").filter({ has: page.getByRole("heading", { name: "已有连接", exact: true }) });
  await expect(personalModelConnections.getByText("暂不可用", { exact: true })).toBeVisible();

  await failRead(page, "**/api/me/git-connections", "/personal/connections/git", "还没有个人 Git 连接");
  const gitConnections = page.locator("section").filter({ has: page.getByRole("heading", { name: "已有连接", exact: true }) });
  await expect(gitConnections.getByText("暂不可用", { exact: true })).toBeVisible();

  await failRead(page, "**/api/me/mcp-connections", "/personal/connections/mcp", "还没有个人 MCP 连接");
  const mcpConnections = page.locator("section").filter({ has: page.getByRole("heading", { name: "已有连接", exact: true }) });
  await expect(mcpConnections.getByText("暂不可用", { exact: true })).toBeVisible();

  await failRead(page, "**/api/personal/knowledge?*", "/personal/knowledge", "还没有个人知识");

  await page.route("**/api/projects?*", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("view") === "active" && query.get("pageSize") === "8") {
      await fulfillJson(route, { error: { code: "ISOLATED_READ_FAILURE", message: "隔离项目读取失败" } }, 503);
      return;
    }
    await route.fallback();
  });
  await page.goto("/personal");
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(page.getByText("当前没有可访问的进行中项目", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "我的空间统计" }).getByText("暂不可用").first()).toBeVisible();
  await page.unroute("**/api/projects?*");

  await failRead(page, "**/api/credits?*", "/credits", "当前筛选范围暂无用量记录");
  const membership = page.locator("section").filter({ has: page.getByRole("heading", { name: "会员资格", exact: true }) });
  await expect(membership.getByText("暂时无法读取", { exact: true })).toBeVisible();

  await failRead(page, "**/api/notifications?*", "/notifications", "还没有活动记录。耗时任务完成、失败或需要人工确认后会出现在这里。");
  await expect(page.getByText("— 条未读", { exact: true })).toBeVisible();

  await failRead(page, "**/api/ask/conversations?*", "/ask?history=1", "暂无匹配会话");
});

test("T-054 changing Ask history view hides old rows and actions until that view succeeds", async ({ page }) => {
  await signInPersonalUser(page);
  const id = "81000000-0000-4000-8000-000000000054";
  let deletedReads = 0;
  await page.route("**/api/ask/conversations?*", async (route) => {
    const view = new URL(route.request().url()).searchParams.get("view");
    if (view === "deleted") {
      deletedReads += 1;
      if (deletedReads === 1) {
        await fulfillJson(route, { error: { code: "ISOLATED_READ_FAILURE", message: "回收站读取失败" } }, 503);
      } else {
        await fulfillJson(route, { conversations: [], pagination: { page: 1, totalPages: 1, total: 0 } });
      }
      return;
    }
    await fulfillJson(route, {
      conversations: [{ id, title: "Audit active conversation", updatedAt: "2026-11-01T00:00:00.000Z", turnCount: 1, deleted: false, archived: false, pinned: false, presentationRevision: 1 }],
      pagination: { page: 1, totalPages: 1, total: 1 },
    });
  });

  await page.goto("/ask?history=1");
  const rail = page.getByRole("complementary", { name: "最近会话" });
  await expect(rail.getByText("Audit active conversation", { exact: true })).toBeVisible();
  await rail.getByLabel("会话列表").selectOption("deleted");
  await expect(rail.getByRole("alert")).toBeVisible();
  await expect(rail.getByText("Audit active conversation", { exact: true })).toHaveCount(0);
  await expect(rail.getByRole("button", { name: "会话操作 · Audit active conversation", exact: true })).toHaveCount(0);
  await rail.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(rail.getByText("暂无匹配会话", { exact: true })).toBeVisible();
  await expect(rail.getByText("Audit active conversation", { exact: true })).toHaveCount(0);
});

test("T-056 completing a profile write leaves a newly opened username dialog and draft intact", async ({ page }) => {
  await signInPersonalUser(page);
  const started = deferred();
  const release = deferred();
  await page.route("**/api/profile", async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    const input = route.request().postDataJSON() as { displayName?: string | null; email?: string | null };
    started.resolve();
    await release.promise;
    await fulfillJson(route, { user: { displayName: input.displayName ?? null, email: input.email ?? null, emailVerifiedAt: null } });
  });

  await page.goto("/profile");
  await page.getByRole("button", { name: "编辑资料", exact: true }).click();
  const profileDialog = page.getByRole("dialog", { name: "编辑个人资料", exact: true });
  await profileDialog.getByLabel("显示名称", { exact: true }).fill("Delayed profile update");
  await profileDialog.getByRole("button", { name: "保存个人资料", exact: true }).click();
  await started.promise;
  await profileDialog.getByRole("button", { name: "关闭窗口", exact: true }).click();

  await page.getByRole("button", { name: "登录名", exact: true }).click();
  const usernameDialog = page.getByRole("dialog", { name: "登录名", exact: true });
  const draft = `draft-${randomUUID().slice(0, 8)}`;
  await usernameDialog.getByLabel("登录名", { exact: true }).fill(draft);
  release.resolve();

  await expect(usernameDialog).toBeVisible();
  await expect(usernameDialog.getByLabel("登录名", { exact: true })).toHaveValue(draft);
  const username = usernameDialog.getByLabel("登录名", { exact: true });
  expect(await username.evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(true);
  await username.fill("invalid name");
  expect(await username.evaluate((input: HTMLInputElement) => input.validity.patternMismatch)).toBe(true);
});

test("T-057 personal model allowance bars show available balance and omit unknown balance", async ({ page }) => {
  await signInPersonalUser(page);
  let status = 200;
  let availableCredits = 0;
  await page.route("**/api/credits?*", (route) => fulfillJson(route, status === 200
    ? { report: { summary: { totalCredits: 100, availableCredits, usedCredits: 20 } } }
    : { error: { code: "ISOLATED_READ_FAILURE", message: "隔离额度读取失败" } }, status));

  await page.goto("/personal/models");
  const quota = page.locator("[data-model-overview] section").filter({ has: page.getByRole("heading", { name: "我的平台额度", exact: true }) });
  const progress = quota.locator('[aria-hidden="true"] span');
  await expect(progress).toHaveAttribute("style", "width: 0%;");

  availableCredits = 50;
  await page.reload();
  await expect(progress).toHaveAttribute("style", "width: 50%;");

  status = 503;
  await page.reload();
  await expect(progress).toHaveCount(0);
  await expect(quota.getByText("暂时无法读取", { exact: true })).toBeVisible();
});

test("T-058 a delayed pre-read cannot restore the notification badge after mark-all-read", async ({ page }) => {
  await signInPersonalUser(page);
  const oldReadStarted = deferred();
  const releaseOldRead = deferred();
  const zeroReadCompleted = deferred();
  let querylessReads = 0;
  const notification = {
    id: "82000000-0000-4000-8000-000000000058",
    kind: "system",
    severity: "info",
    body: "Controlled unread notification",
    title: "Controlled unread notification",
    createdAt: "2026-11-01T00:00:00.000Z",
    readAt: null,
    actionHref: null,
    actionState: "none",
    destination: null,
  };
  let markedAllRead = false;

  await page.route("**/api/notifications**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/read-all")) {
      markedAllRead = true;
      await fulfillJson(route, { markedReadCount: 1 });
      return;
    }
    if (url.search !== "") {
      await fulfillJson(route, { notifications: markedAllRead ? [{ ...notification, readAt: "2026-11-23T00:00:00.000Z" }] : [notification], unreadCount: markedAllRead ? 0 : 1, pendingCount: 0, nextCursor: null });
      return;
    }
    querylessReads += 1;
    if (querylessReads === 1) {
      oldReadStarted.resolve();
      await releaseOldRead.promise;
      await fulfillJson(route, { unreadCount: 1 });
      return;
    }
    await fulfillJson(route, { unreadCount: 0 });
    zeroReadCompleted.resolve();
  });

  await page.goto("/notifications");
  await oldReadStarted.promise;
  await page.getByRole("button", { name: "全部标记为已读", exact: true }).click();
  await expect(page.getByText("0 条未读", { exact: true })).toBeVisible();
  await zeroReadCompleted.promise;
  releaseOldRead.resolve();
  await expect(page.getByRole("link", { name: "通知中心", exact: true }).locator("span.bg-app-danger")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "全部标记为已读", exact: true })).toBeDisabled();
});

test("T-059 an old usage page failure cannot replace a newer successful filter", async ({ page }) => {
  await signInPersonalUser(page);
  const oldPageStarted = deferred();
  const releaseOldPage = deferred();
  await page.route("**/api/personal/usage?*", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.has("cursor")) {
      oldPageStarted.resolve();
      await releaseOldPage.promise;
      try {
        await fulfillJson(route, { error: { code: "ISOLATED_READ_FAILURE", message: "旧分页失败" } }, 503);
      } catch {
        // The new filter aborts this obsolete page request.
      }
      return;
    }
    const response = await route.fetch();
    const body = await response.json() as { usage: { nextCursor: string | null } };
    if (query.get("status") === "all") body.usage.nextCursor = "t051-test-next-page";
    await route.fulfill({ response, json: body });
  });

  await page.goto("/personal/usage");
  await page.getByRole("button", { name: "加载更多", exact: true }).click();
  await oldPageStarted.promise;
  await page.getByRole("combobox", { name: "调用状态", exact: true }).selectOption("succeeded");
  await expect(page.getByText("当前筛选范围暂无调用记录。", { exact: true })).toBeVisible();
  releaseOldPage.resolve();
  await expect(page.getByText("当前筛选范围暂无调用记录。", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "用量记录暂不可用" })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "调用状态", exact: true })).toHaveValue("succeeded");
});

test("T-065 click and Enter submissions keep the top workspace dialog focused on mobile", async ({ page }) => {
  await signInPersonalUser(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/workspaces/current?*", (route) => fulfillJson(route, { availableWorkspaces: [], hasMore: false, nextCursor: null }));

  await page.getByRole("button", { name: "打开导航", exact: true }).click();
  const sidebar = page.locator("#user-shell-navigation");
  await sidebar.getByRole("button", { name: "查找其他工作区", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "查找其他工作区", exact: true });
  const search = dialog.getByRole("textbox", { name: "搜索工作区名称", exact: true });
  await search.fill("no matching workspace");
  await dialog.getByRole("button", { name: "搜索工作区名称", exact: true }).click();
  await expect(dialog.getByText("没有匹配的工作区", { exact: true })).toBeVisible();
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(sidebar).toBeVisible();

  await sidebar.getByRole("button", { name: "查找其他工作区", exact: true }).click();
  const secondDialog = page.getByRole("dialog", { name: "查找其他工作区", exact: true });
  const secondSearch = secondDialog.getByRole("textbox", { name: "搜索工作区名称", exact: true });
  await secondSearch.fill("no matching workspace");
  await secondSearch.press("Enter");
  await expect(secondDialog.getByText("没有匹配的工作区", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(secondDialog).toBeHidden();
  await expect(sidebar).toBeVisible();
});

test("T-066 personal source version failure stays in its dialog and can be retried there", async ({ page }) => {
  await signInPersonalUser(page);
  const documentId = "83000000-0000-4000-8000-000000000066";
  let revisionReads = 0;
  await page.route("**/api/projects?*", (route) => fulfillJson(route, {
    projects: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 }, counts: { active: 0, archived: 0 },
  }));
  await page.route("**/api/personal/knowledge/graph", (route) => fulfillJson(route, {
    documents: { nodes: [{ id: documentId, title: "Personal source for retry", version: 1 }], edges: [], truncated: false },
    suggestions: [], truncated: false,
  }));
  await page.route(`**/api/personal/knowledge/${documentId}/revisions/1`, (route) => {
    revisionReads += 1;
    return revisionReads === 1
      ? fulfillJson(route, { error: { code: "ISOLATED_READ_FAILURE", message: "来源版本读取失败" } }, 503)
      : fulfillJson(route, { revision: { content: "Recovered source version content." } });
  });

  await page.goto("/personal/knowledge/graph");
  await page.getByRole("button", { name: "来源：Personal source for retry", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "知识点详情", exact: true });
  await expect(detail.getByRole("alert")).toBeVisible();
  await expect(detail.getByText("图谱加载失败", { exact: false })).toHaveCount(0);
  await expect(page.getByTestId("knowledge-graph-space")).toBeVisible();
  await detail.getByRole("button", { name: "重新读取来源", exact: true }).click();
  await expect(detail.getByText("Recovered source version content.", { exact: true })).toBeVisible();
  expect(revisionReads).toBe(2);
});
