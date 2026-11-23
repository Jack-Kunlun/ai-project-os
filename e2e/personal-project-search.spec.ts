import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { signInR02Admin, signOutR02User } from "./support/r02-admin-navigation";

type Deferred = { promise: Promise<void>; resolve: () => void };
type PendingPage = { requested: Deferred; release: Deferred; completed: Deferred };

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function pendingPage(): PendingPage {
  return { requested: deferred(), release: deferred(), completed: deferred() };
}

async function openProjectSearchPanel(page: Page): Promise<void> {
  await page.getByRole("button", { name: "智能检索与索引", exact: true }).click();
  await page.getByRole("button", { name: "项目来源搜索", exact: true }).click();
  await expect(page.getByRole("heading", { name: "搜索我的空间", exact: true })).toBeVisible();
}

test("personal project search makes archived selection explicit and keeps all-accessible scoped to active projects", async ({ page }) => {
  await signInR02Admin(page);
  const user = await seedBrowserPersonalUser(
    `browser-project-search-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    "BrowserProjectSearch2026Password!",
  );
  await signOutR02User(page);
  await page.getByLabel("用户名或手机号", { exact: true }).fill(user.username);
  await page.getByLabel("密码", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "登 录", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/u);

  const activeProjectId = "11111111-1111-4111-8111-111111111111";
  const archivedProjectId = "22222222-2222-4222-8222-222222222222";
  const activeProjects = Array.from({ length: 51 }, (_, index) => ({
    id: index === 0 ? activeProjectId : `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: index === 0 ? "Active Alpha" : index === 50 ? "Active Omega 51" : `Active Project ${index + 1}`,
    archivedAt: null,
  }));
  const archivedProjects = Array.from({ length: 51 }, (_, index) => ({
    id: index === 0 ? archivedProjectId : `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    name: index === 0 ? "Archived Beta" : index === 50 ? "Archived Omega 51" : `Archived Project ${index + 1}`,
    archivedAt: "2026-09-01T00:00:00.000Z",
  }));
  const lastActiveProjectId = activeProjects[50]!.id;
  const lastArchivedProjectId = archivedProjects[50]!.id;
  const projectListRequests: string[] = [];
  await page.route("**/api/projects?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const view = params.get("view");
    const pageNumber = Number(params.get("page") ?? "1");
    projectListRequests.push(`${view}:${pageNumber}`);
    const allProjects = view === "archived" ? archivedProjects : activeProjects;
    const projects = allProjects.slice((pageNumber - 1) * 50, pageNumber * 50);
    await route.fulfill({ json: {
      projects,
      pagination: { page: pageNumber, pageSize: 50, total: allProjects.length, totalPages: 2 },
      counts: { active: activeProjects.length, archived: archivedProjects.length },
      canCreateProject: false,
    } });
  });
  await page.route("**/api/personal/knowledge?query=*&limit=20", (route) => route.fulfill({ json: { documents: [] } }));
  await page.route("**/api/personal/knowledge/project-search", (route) => route.fulfill({ json: { results: [], selectedProjects: [] } }));

  await page.goto("/personal/knowledge");
  await openProjectSearchPanel(page);
  const activeProject = page.getByRole("button").filter({ hasText: "Active Alpha" });
  const archivedProject = page.getByRole("button").filter({ hasText: "Archived Beta" });
  const lastActiveProject = page.getByRole("button").filter({ hasText: "Active Omega 51" });
  const lastArchivedProject = page.getByRole("button").filter({ hasText: "Archived Omega 51" });
  await expect(activeProject).toHaveAttribute("aria-pressed", "true");
  await expect(archivedProject).toContainText("已归档");
  await expect(lastActiveProject).toBeVisible();
  await expect(lastArchivedProject).toBeVisible();
  await archivedProject.click();
  await expect(archivedProject).toHaveAttribute("aria-pressed", "true");
  await lastActiveProject.click();
  await expect(lastActiveProject).toHaveAttribute("aria-pressed", "true");
  await lastArchivedProject.click();
  await expect(lastArchivedProject).toHaveAttribute("aria-pressed", "true");
  await page.getByPlaceholder("例如：发布前检查、当前里程碑…").fill("release evidence");
  const selectedRequestPromise = page.waitForRequest((request) => request.url().includes("/api/personal/knowledge/project-search") && request.method() === "POST");
  await page.getByRole("button", { name: "搜索工作台", exact: true }).click();
  const selectedRequest = await selectedRequestPromise;
  expect(selectedRequest.postDataJSON()).toMatchObject({
    scope: "selected",
    projectIds: [activeProjectId, archivedProjectId, lastActiveProjectId, lastArchivedProjectId],
    query: "release evidence",
  });

  await page.getByText("全部可访问的未归档项目", { exact: true }).click();
  await expect(page.getByText("当前范围：本次搜索时仍有权访问的未归档项目（最多 50 个）")).toBeVisible();
  const allRequestPromise = page.waitForRequest((request) => request.url().includes("/api/personal/knowledge/project-search") && request.method() === "POST");
  await page.getByRole("button", { name: "搜索工作台", exact: true }).click();
  const allRequest = await allRequestPromise;
  expect(allRequest.postDataJSON()).toMatchObject({ scope: "allAccessible", query: "release evidence", take: 10 });
  expect(allRequest.postDataJSON()).not.toHaveProperty("projectIds");
  expect(projectListRequests).toContain("active:2");
  expect(projectListRequests).toContain("archived:2");

  await page.unroute("**/api/projects?*");
  await page.route("**/api/projects?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const view = params.get("view");
    const pageNumber = Number(params.get("page") ?? "1");
    if (view === "active" && pageNumber === 2) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "ISOLATED_PAGE_FAILURE", message: "隔离分页失败" } }) });
      return;
    }
    const allProjects = view === "archived" ? archivedProjects : activeProjects;
    await route.fulfill({
      json: {
        projects: allProjects.slice((pageNumber - 1) * 50, pageNumber * 50),
        pagination: { page: pageNumber, pageSize: 50, total: allProjects.length, totalPages: 2 },
      },
    });
  });
  await page.reload();
  await openProjectSearchPanel(page);
  const searchPanel = page.locator("section[aria-labelledby='personal-project-search-title']");
  await expect(searchPanel.getByRole("alert")).toBeVisible();
  await expect(searchPanel.getByRole("button", { name: "Active Omega 51", exact: false })).toHaveCount(0);

  await page.unroute("**/api/projects?*");
  const heldPage = pendingPage();
  await page.route("**/api/projects?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    const view = params.get("view");
    const pageNumber = Number(params.get("page") ?? "1");
    if (view === "active" && pageNumber === 2) {
      heldPage.requested.resolve();
      await heldPage.release.promise;
      try {
        await route.fulfill({ json: { projects: activeProjects.slice(50), pagination: { page: 2, pageSize: 50, total: 51, totalPages: 2 } } });
      } catch {
        // Navigation cancels the in-flight project list request.
      } finally {
        heldPage.completed.resolve();
      }
      return;
    }
    const allProjects = view === "archived" ? archivedProjects : activeProjects;
    await route.fulfill({
      json: {
        projects: allProjects.slice((pageNumber - 1) * 50, pageNumber * 50),
        pagination: { page: pageNumber, pageSize: 50, total: allProjects.length, totalPages: 2 },
      },
    });
  });
  await page.reload();
  await openProjectSearchPanel(page);
  await heldPage.requested.promise;
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard$/u);
  heldPage.release.resolve();
  await heldPage.completed.promise;
});
