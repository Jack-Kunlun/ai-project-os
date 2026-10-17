import { randomUUID } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { signInR02Admin } from "./support/r02-admin-navigation";

type Deferred = { promise: Promise<void>; resolve: () => void };
type DelayedResponse = { requested: Deferred; release: Deferred; completed: Deferred };

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function delayedResponse(): DelayedResponse {
  return { requested: deferred(), release: deferred(), completed: deferred() };
}

async function signInPersonalUser(page: Page): Promise<void> {
  await signInR02Admin(page);
  const user = await seedBrowserPersonalUser(
    `browser-material-race-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    "BrowserMaterialRace2026Password!",
  );
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await page.getByLabel("用户名或手机号", { exact: true }).fill(user.username);
  await page.getByLabel("密码", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "登 录", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/u);
}

async function createProject(page: Page): Promise<string> {
  await page.goto("/projects");
  const name = `资料请求竞态 ${randomUUID().slice(0, 8)}`;
  await page.getByRole("button", { name: "＋ 新建项目" }).click();
  await page.getByLabel("项目名称", { exact: true }).fill(name);
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name, exact: true }) });
  const href = await card.getByRole("link", { name: "进入项目", exact: true }).getAttribute("href");
  expect(href).toMatch(/^\/projects\/[0-9a-f-]+$/u);
  return href!.split("/")[2]!;
}

function sourcePayload(title: string, kind: "manual" | "document" = "manual") {
  const id = kind === "document" ? "44444444-4444-4444-8444-444444444444" : "33333333-3333-4333-8333-333333333333";
  return {
    sources: [{ id, kind, preview: title, capturedAt: null, ingestedAt: "2026-10-16T00:00:00.000Z" }],
    pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
  };
}

function itemPayload(status: "candidate" | "confirmed" | "dismissed" | "all") {
  const item = status === "all" ? null : {
    id: `55555555-5555-4555-8555-55555555555${status === "candidate" ? "1" : status === "confirmed" ? "2" : "3"}`,
    type: "progress" as const,
    reviewStatus: status,
    title: `${status} response item`,
    content: "用于列表请求竞态的隔离响应。",
    sourceExcerpt: "隔离测试原文摘录",
    occurredAt: null,
    confirmedAt: status === "confirmed" ? "2026-10-16T00:00:00.000Z" : null,
    sourceId: "33333333-3333-4333-8333-333333333333",
    createdAt: "2026-10-16T00:00:00.000Z",
    updatedAt: "2026-10-16T00:00:00.000Z",
    aiCandidateClaim: null,
    webAiCandidate: null,
    source: {
      id: "33333333-3333-4333-8333-333333333333",
      kind: "manual" as const,
      externalRef: null,
      contentHash: "a".repeat(64),
      capturedAt: null,
      ingestedAt: "2026-10-16T00:00:00.000Z",
    },
  };
  return {
    items: item ? [item] : [],
    counts: { candidate: status === "candidate" || status === "all" ? 1 : 0, confirmed: status === "confirmed" ? 1 : 0, dismissed: status === "dismissed" ? 1 : 0, superseded: 0 },
    pagination: { page: 1, pageSize: 20, total: item ? 1 : 0, totalPages: 1 },
  };
}

async function fulfillJson(route: Route, json: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
}

test("materials lists ignore delayed responses after filter changes and unmount", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await signInPersonalUser(page);
  const projectId = await createProject(page);

  const itemHolds = new Map<string, DelayedResponse>();
  const sourceHolds = new Map<string, DelayedResponse>();
  await page.route(`**/api/projects/${projectId}`, (route) => fulfillJson(route, {
    project: {
      id: projectId,
      name: "资料请求竞态隔离项目",
      slug: "materials-request-race",
      description: null,
      createdAt: "2026-10-16T00:00:00.000Z",
      updatedAt: "2026-10-16T00:00:00.000Z",
      _count: { sources: 1, assets: 0, items: 1, scans: 0, snapshots: 0 },
    },
  }));
  await page.route(`**/api/projects/${projectId}/assets`, (route) => fulfillJson(route, { assets: [], policy: { maxFiles: 10 } }));
  await page.route(`**/api/projects/${projectId}/sources?*`, async (route) => {
    const query = new URL(route.request().url()).searchParams;
    const search = query.get("search") ?? "";
    const kind = query.get("kind") ?? "all";
    const key = `${search}|${kind}`;
    const hold = sourceHolds.get(key);
    if (hold) {
      sourceHolds.delete(key);
      hold.requested.resolve();
      await hold.release.promise;
    }
    const title = search === "stale-search"
      ? "过期搜索资料"
      : search === "latest-search"
        ? "最新搜索资料"
        : kind === "manual"
          ? "过期类型资料"
          : kind === "document"
            ? "最新类型资料"
            : "默认原始资料";
    try {
      await fulfillJson(route, sourcePayload(title, kind === "document" ? "document" : "manual"));
    } catch {
      // A newer filter or route unmount may have already cancelled this request.
    } finally {
      hold?.completed.resolve();
    }
  });
  await page.route(`**/api/projects/${projectId}/sources/*`, async (route) => {
    const sourceId = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    await fulfillJson(route, {
      source: {
        id: sourceId,
        kind: sourceId === "44444444-4444-4444-8444-444444444444" ? "document" : "manual",
        preview: "资料原文",
        capturedAt: null,
        ingestedAt: "2026-10-16T00:00:00.000Z",
        contentText: "资料请求竞态原文内容。",
        contentHash: "b".repeat(64),
      },
    });
  });
  await page.route(`**/api/projects/${projectId}/items?*`, async (route) => {
    const status = new URL(route.request().url()).searchParams.get("reviewStatus") ?? "all";
    const hold = itemHolds.get(status);
    if (hold) {
      itemHolds.delete(status);
      hold.requested.resolve();
      await hold.release.promise;
    }
    const responseStatus = status === "candidate" || status === "confirmed" || status === "dismissed" ? status : "all";
    try {
      await fulfillJson(route, itemPayload(responseStatus));
    } catch {
      // A newer filter or route unmount may have already cancelled this request.
    } finally {
      hold?.completed.resolve();
    }
  });

  await page.goto(`/projects/${projectId}/materials`);
  await expect(page.getByRole("heading", { name: "原始资料来源库", exact: true })).toBeVisible();
  await expect(page.getByText("默认原始资料", { exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "项目资料栏目" }).getByRole("link", { name: /^整理结果(?:\s+\d+)?$/u }).click();
  const statusFilter = page.getByRole("combobox", { name: "按审核状态筛选", exact: true });
  await expect(statusFilter).toHaveValue("confirmed");
  await expect(page.getByRole("list", { name: "全部项目条目列表" }).getByRole("heading", { name: "confirmed response item", exact: true })).toBeVisible();

  const candidate = delayedResponse();
  const confirmed = delayedResponse();
  itemHolds.set("candidate", candidate);
  itemHolds.set("confirmed", confirmed);
  await statusFilter.selectOption("candidate");
  await candidate.requested.promise;
  await statusFilter.selectOption("confirmed");
  await confirmed.requested.promise;
  candidate.release.resolve();
  await candidate.completed.promise;
  await expect(page.getByLabel("正在加载项目条目")).toBeVisible();
  await expect(page.locator("#confirmed-facts").getByRole("alert")).toHaveCount(0);
  confirmed.release.resolve();
  await expect(page.getByLabel("正在加载项目条目")).toHaveCount(0);
  const itemList = page.getByRole("list", { name: "全部项目条目列表" });
  await expect(itemList.getByRole("heading", { name: "confirmed response item", exact: true })).toBeVisible();
  await expect(itemList.getByText("candidate response item", { exact: true })).toHaveCount(0);

  await page.getByRole("navigation", { name: "项目资料栏目" }).getByRole("link", { name: "资料", exact: true }).click();
  const sourceSearch = page.getByLabel("搜索原始资料", { exact: true });
  const staleSearch = delayedResponse();
  const latestSearch = delayedResponse();
  sourceHolds.set("stale-search|all", staleSearch);
  sourceHolds.set("latest-search|all", latestSearch);
  await sourceSearch.fill("stale-search");
  await staleSearch.requested.promise;
  await sourceSearch.fill("latest-search");
  await latestSearch.requested.promise;
  staleSearch.release.resolve();
  await staleSearch.completed.promise;
  await expect(page.getByLabel("正在加载项目资料")).toBeVisible();
  await expect(page.locator("#source-library").getByRole("alert")).toHaveCount(0);
  latestSearch.release.resolve();
  await expect(page.getByLabel("正在加载项目资料")).toHaveCount(0);
  const sourceList = page.getByRole("list", { name: "项目原始资料列表" });
  await expect(sourceList.getByText("最新搜索资料", { exact: true })).toBeVisible();
  await expect(sourceList.getByText("过期搜索资料", { exact: true })).toHaveCount(0);

  await sourceSearch.fill("");
  await expect(sourceList.getByText("默认原始资料", { exact: true })).toBeVisible();
  const staleKind = delayedResponse();
  const latestKind = delayedResponse();
  sourceHolds.set("|manual", staleKind);
  sourceHolds.set("|document", latestKind);
  const kindFilter = page.getByRole("combobox", { name: "按原始资料类型筛选", exact: true });
  await kindFilter.selectOption("manual");
  await staleKind.requested.promise;
  await kindFilter.selectOption("document");
  await latestKind.requested.promise;
  staleKind.release.resolve();
  await staleKind.completed.promise;
  await expect(page.getByLabel("正在加载项目资料")).toBeVisible();
  await expect(page.locator("#source-library").getByRole("alert")).toHaveCount(0);
  latestKind.release.resolve();
  await expect(page.getByLabel("正在加载项目资料")).toHaveCount(0);
  await expect(sourceList.getByText("最新类型资料", { exact: true })).toBeVisible();
  await expect(sourceList.getByText("过期类型资料", { exact: true })).toHaveCount(0);

  const unmountedRequest = delayedResponse();
  itemHolds.set("dismissed", unmountedRequest);
  await page.getByRole("navigation", { name: "项目资料栏目" }).getByRole("link", { name: /^整理结果(?:\s+\d+)?$/u }).click();
  await statusFilter.selectOption("dismissed");
  await unmountedRequest.requested.promise;
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard$/u);
  unmountedRequest.release.resolve();
  await unmountedRequest.completed.promise;
  expect(pageErrors).toEqual([]);
});
