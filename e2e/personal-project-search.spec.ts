import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { signInR02Admin } from "./support/r02-admin-navigation";

test("personal project search makes archived selection explicit and keeps all-accessible scoped to active projects", async ({ page }) => {
  await signInR02Admin(page);
  const user = await seedBrowserPersonalUser(
    `browser-project-search-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    "BrowserProjectSearch2026Password!",
  );
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await page.getByLabel("用户名", { exact: true }).fill(user.username);
  await page.getByLabel("密码", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "登 录", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/u);

  const activeProjectId = "11111111-1111-4111-8111-111111111111";
  const archivedProjectId = "22222222-2222-4222-8222-222222222222";
  await page.route("**/api/projects?*", async (route) => {
    const view = new URL(route.request().url()).searchParams.get("view");
    await route.fulfill({ json: { projects: view === "archived"
      ? [{ id: archivedProjectId, name: "Archived Beta", archivedAt: "2026-09-01T00:00:00.000Z" }]
      : [{ id: activeProjectId, name: "Active Alpha", archivedAt: null }] } });
  });
  await page.route("**/api/personal/knowledge?query=*&limit=20", (route) => route.fulfill({ json: { documents: [] } }));
  await page.route("**/api/personal/knowledge/project-search", (route) => route.fulfill({ json: { results: [], selectedProjects: [] } }));

  await page.goto("/personal/knowledge");
  await expect(page.getByRole("heading", { name: "搜索我的空间", exact: true })).toBeVisible();
  const activeProject = page.getByRole("button").filter({ hasText: "Active Alpha" });
  const archivedProject = page.getByRole("button").filter({ hasText: "Archived Beta" });
  await expect(activeProject).toHaveAttribute("aria-pressed", "true");
  await expect(archivedProject).toContainText("已归档");
  await archivedProject.click();
  await expect(archivedProject).toHaveAttribute("aria-pressed", "true");
  await page.getByPlaceholder("例如：发布前检查、当前里程碑…").fill("release evidence");
  const selectedRequestPromise = page.waitForRequest((request) => request.url().includes("/api/personal/knowledge/project-search") && request.method() === "POST");
  await page.getByRole("button", { name: "搜索工作台", exact: true }).click();
  const selectedRequest = await selectedRequestPromise;
  expect(selectedRequest.postDataJSON()).toMatchObject({ scope: "selected", projectIds: [activeProjectId, archivedProjectId], query: "release evidence" });

  await page.getByText("全部可访问的未归档项目", { exact: true }).click();
  await expect(page.getByText("当前范围：本次搜索时仍有权访问的未归档项目（最多 50 个）")).toBeVisible();
  const allRequestPromise = page.waitForRequest((request) => request.url().includes("/api/personal/knowledge/project-search") && request.method() === "POST");
  await page.getByRole("button", { name: "搜索工作台", exact: true }).click();
  const allRequest = await allRequestPromise;
  expect(allRequest.postDataJSON()).toMatchObject({ scope: "allAccessible", query: "release evidence", take: 10 });
  expect(allRequest.postDataJSON()).not.toHaveProperty("projectIds");
});
