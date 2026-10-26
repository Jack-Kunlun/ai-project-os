import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { signInR02Admin, signInR02PersonalUser, signOutR02User } from "./support/r02-admin-navigation";

test("project picker preserves the selected section across desktop and mobile navigation", async ({ page }) => {
  test.setTimeout(120_000);

  await signInR02Admin(page);
  const suffix = randomUUID().slice(0, 8);
  const user = await seedBrowserPersonalUser(`user-shell-${suffix}`, "UserShell2026Password!");
  await signOutR02User(page);
  await signInR02PersonalUser(page, user);

  const createProject = async (name: string) => {
    const response = await page.request.post("/api/projects", {
      headers: { origin: new URL(page.url()).origin },
      data: { name, workspaceId: user.workspaceId },
    });
    expect(response.status()).toBe(201);
    const body = await response.json() as { project: { id: string; name: string } };
    return body.project;
  };
  const firstProject = await createProject(`Shell navigation A ${suffix}`);
  const secondProject = await createProject(`Shell navigation B ${suffix}`);
  await page.reload();

  const projectPicker = page.locator("#user-shell-project-picker");
  const globalNavigation = page.getByRole("navigation", { name: "全局入口", exact: true });
  const openNavigationButton = page.getByRole("button", { name: "打开导航", exact: true });
  const assertGlobalDestinations = async () => {
    await expect(globalNavigation.getByRole("link", { name: "工作台", exact: true })).toHaveAttribute("href", "/dashboard");
    await expect(globalNavigation.getByRole("link", { name: "我的项目", exact: true })).toHaveAttribute("href", "/personal/projects");
    await expect(globalNavigation.getByRole("link", { name: "我的知识", exact: true })).toHaveAttribute("href", "/personal/knowledge");
  };
  const assertProjectPage = async (project: typeof firstProject, section: "overview" | "plan") => {
    const expectedPath = section === "overview" ? `/projects/${project.id}` : `/projects/${project.id}/plan`;
    await expect(page).toHaveURL(new RegExp(`${expectedPath}$`, "u"));
    await expect(page.getByRole("heading", { name: project.name, exact: true })).toBeVisible({ timeout: 15_000 });
    if (section === "plan") await expect(page.getByRole("heading", { name: "项目计划", exact: true })).toBeVisible({ timeout: 15_000 });
  };
  const assertProjectNavigation = async (project: typeof firstProject) => {
    const projectNavigation = page.getByRole("navigation", { name: `${project.name} 项目导航`, exact: true });
    await expect(projectNavigation.getByRole("link", { name: "项目概览", exact: true })).toHaveAttribute("href", `/projects/${project.id}`);
    await expect(projectNavigation.getByRole("link", { name: "项目计划", exact: true })).toHaveAttribute("href", `/projects/${project.id}/plan`);
  };
  const assertProjectSection = async (project: typeof firstProject, section: "overview" | "plan") => {
    await assertProjectPage(project, section);
    await assertProjectNavigation(project);
  };

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(globalNavigation).toBeVisible({ timeout: 15_000 });
  await expect(projectPicker).toBeEnabled({ timeout: 15_000 });
  await expect(projectPicker.locator(`option[value="${firstProject.id}"]`)).toBeAttached();
  await projectPicker.selectOption(firstProject.id);
  await assertProjectSection(firstProject, "overview");
  await assertGlobalDestinations();

  await projectPicker.selectOption(secondProject.id);
  await assertProjectSection(secondProject, "overview");
  await expect(page.getByRole("heading", { name: firstProject.name, exact: true })).toHaveCount(0);
  await assertGlobalDestinations();

  await page.getByRole("navigation", { name: `${secondProject.name} 项目导航`, exact: true })
    .getByRole("link", { name: "项目计划", exact: true }).click();
  await assertProjectSection(secondProject, "plan");
  await projectPicker.selectOption(firstProject.id);
  await assertProjectSection(firstProject, "plan");
  await expect(page.getByRole("heading", { name: secondProject.name, exact: true })).toHaveCount(0);
  await assertGlobalDestinations();

  await page.setViewportSize({ width: 390, height: 844 });
  await openNavigationButton.click();
  await expect(openNavigationButton).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => page.locator("#user-shell-navigation").evaluate(element => Math.round(element.getBoundingClientRect().x))).toBe(0);
  await assertProjectSection(firstProject, "plan");
  await assertGlobalDestinations();

  await projectPicker.click();
  await page.keyboard.press("Escape");
  await expect(projectPicker).toBeFocused();
  await expect(openNavigationButton).toHaveAttribute("aria-expanded", "true");

  await projectPicker.selectOption(secondProject.id);
  await assertProjectPage(secondProject, "plan");
  await expect(openNavigationButton).toHaveAttribute("aria-expanded", "false");
  await openNavigationButton.click();
  await expect(openNavigationButton).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => page.locator("#user-shell-navigation").evaluate(element => Math.round(element.getBoundingClientRect().x))).toBe(0);
  await assertProjectNavigation(secondProject);
  await assertGlobalDestinations();
});
