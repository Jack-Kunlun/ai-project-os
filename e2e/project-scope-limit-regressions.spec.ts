import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { ProjectItemRevisionAction } from "@prisma/client";
import { getDb, getEntitlementDb } from "@/lib/db";
import { grantWorkspaceMembership } from "@/lib/membership-governance";
import { appendProjectItemRevision, createPrimaryProjectItemEvidence } from "@/lib/project-item-history";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { signInR02Admin, signInR02PersonalUser, signOutR02User } from "./support/r02-admin-navigation";

test.describe("project scope limits", () => {
  test.use({ timezoneId: "America/Los_Angeles" });

  test("the workspace picker searches and pages beyond the first 100 without resetting its saved selection", async ({ page }) => {
    test.setTimeout(120_000);
    await signInR02Admin(page);
    const suffix = randomUUID().slice(0, 8);
    const user = await seedBrowserPersonalUser(`scope-workspace-${suffix}`, "ScopeWorkspace2026Password!");
    await signOutR02User(page);
    await signInR02PersonalUser(page, user);

    const db = getEntitlementDb();
    const targetId = randomUUID();
    const targetName = `Z T046 target ${suffix}`;
    await db.$transaction(async (tx) => {
      for (let index = 0; index < 100; index += 1) {
        const workspace = await tx.workspace.create({
          data: {
            name: `A T046 ${suffix} ${String(index).padStart(3, "0")}`,
            slug: `t046-${suffix}-${String(index).padStart(3, "0")}`,
            createdById: user.id,
          },
        });
        await grantWorkspaceMembership(tx, { workspaceId: workspace.id, userId: user.id, role: "owner", actorId: user.id, reason: "t046_browser_fixture" });
      }
      const target = await tx.workspace.create({ data: { id: targetId, name: targetName, slug: `t046-${suffix}-target`, createdById: user.id } });
      await grantWorkspaceMembership(tx, { workspaceId: target.id, userId: user.id, role: "owner", actorId: user.id, reason: "t046_browser_fixture" });
    }, { timeout: 120_000 });

    const storageKey = `ai-project-os:workspace:${user.username}`;
    const picker = page.locator("#user-shell-workspace-picker");
    await page.evaluate((key) => localStorage.removeItem(key), storageKey);
    await page.reload();
    await expect(picker).toBeEnabled({ timeout: 15_000 });
    await expect(picker.locator(`option[value="${targetId}"]`)).toHaveCount(0);

    await page.getByRole("button", { name: "查找其他工作区", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "查找其他工作区", exact: true });
    await dialog.getByLabel("搜索工作区名称", { exact: true }).fill("Z");
    await dialog.getByRole("button", { name: "搜索工作区名称", exact: true }).click();
    const targetResult = dialog.getByRole("button", { name: targetName, exact: true });
    await expect(targetResult).toBeVisible();
    await targetResult.click();
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe(targetId);
    await expect(picker).toHaveValue(targetId);

    await page.reload();
    await expect(picker).toHaveValue(targetId);
    await expect(picker.locator(`option[value="${targetId}"]`)).toHaveCount(1);

    await page.evaluate((key) => localStorage.removeItem(key), storageKey);
    await page.reload();
    await expect(picker).toHaveValue(user.workspaceId);
    await page.getByRole("button", { name: "查找其他工作区", exact: true }).click();
    const browseDialog = page.getByRole("dialog", { name: "查找其他工作区", exact: true });
    await browseDialog.getByRole("button", { name: "搜索工作区名称", exact: true }).click();
    const browsedTarget = browseDialog.getByRole("button", { name: targetName, exact: true });
    for (let pageIndex = 0; pageIndex < 6 && !(await browsedTarget.isVisible().catch(() => false)); pageIndex += 1) {
      const next = browseDialog.getByRole("button", { name: "下一页", exact: true });
      if (!(await next.isVisible().catch(() => false))) break;
      await next.click();
    }
    await expect(browsedTarget).toBeVisible();
  });

  test("the plan displays date-only values consistently and searches old facts and sources for persistent linking", async ({ page }) => {
    test.setTimeout(120_000);
    await signInR02Admin(page);
    const suffix = randomUUID().slice(0, 8);
    const user = await seedBrowserPersonalUser(`scope-evidence-${suffix}`, "ScopeEvidence2026Password!");
    await signOutR02User(page);
    await signInR02PersonalUser(page, user);

    const origin = new URL(page.url()).origin;
    const createProjectResponse = await page.request.post("/api/projects", {
      headers: { origin },
      data: { name: `Scope evidence ${suffix}`, workspaceId: user.workspaceId },
    });
    expect(createProjectResponse.status()).toBe(201);
    const { project } = await createProjectResponse.json() as { project: { id: string } };

    const planUrl = `/api/projects/${project.id}/plan`;
    const objectiveResponse = await page.request.post(planUrl, {
      headers: { origin, "content-type": "application/json" },
      data: { operation: "createObjective", title: `Date target ${suffix}`, targetDate: "2026-11-23" },
    });
    expect(objectiveResponse.status()).toBe(201);
    const workItemResponse = await page.request.post(planUrl, {
      headers: { origin, "content-type": "application/json" },
      data: { operation: "createWorkItem", title: `Evidence target ${suffix}` },
    });
    expect(workItemResponse.status()).toBe(201);

    const db = getDb();
    const targetCreatedAt = new Date("2020-01-01T00:00:00.000Z");
    const targetItemTitle = `Legacy confirmed fact ${suffix}`;
    let targetItemId = "";
    let targetSourceId = "";
    await db.$transaction(async (tx) => {
      for (let index = 0; index <= 100; index += 1) {
        const old = index === 0;
        const content = old ? `Z old source ${suffix}` : `recent evidence source ${suffix} ${index}`;
        const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
        const source = await tx.projectSource.create({
          data: {
            projectId: project.id,
            kind: "manual",
            contentText: content,
            contentHash,
            manualContentDedupeKey: contentHash,
            ingestedAt: old ? targetCreatedAt : undefined,
          },
        });
        const item = await tx.projectItem.create({
          data: {
            projectId: project.id,
            sourceId: source.id,
            type: "progress",
            reviewStatus: "confirmed",
            title: old ? targetItemTitle : `Recent confirmed fact ${suffix} ${index}`,
            content: old ? `Only the body has the Z marker ${suffix}.` : `Recent confirmed content ${index}.`,
            sourceExcerpt: content,
            confirmedAt: old ? targetCreatedAt : new Date(),
            createdAt: old ? targetCreatedAt : undefined,
            updatedAt: old ? targetCreatedAt : undefined,
          },
        });
        const evidence = await createPrimaryProjectItemEvidence(tx, {
          projectId: project.id,
          projectItemId: item.id,
          projectSourceId: source.id,
          sourceText: content,
          sourceExcerpt: content,
          createdAt: item.createdAt,
        });
        await appendProjectItemRevision(tx, {
          item,
          action: ProjectItemRevisionAction.manualCreated,
          actorId: user.id,
          evidences: [evidence],
          createdAt: item.createdAt,
        });
        if (old) {
          targetSourceId = source.id;
          targetItemId = item.id;
        }
      }
    }, { timeout: 120_000 });

    await page.goto(`/projects/${project.id}/plan`);
    await expect(page.getByRole("heading", { name: `Scope evidence ${suffix}`, exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: `查看工作项：Evidence target ${suffix}`, exact: true })).toBeVisible();
    await page.locator("#objectives").locator("summary").click();
    await expect(page.locator("#objectives").getByText("2026年11月23日", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: `查看工作项：Evidence target ${suffix}`, exact: true }).click();
    await page.getByRole("button", { name: "编辑与管理", exact: true }).click();
    const managementDialog = page.getByRole("dialog", { name: `管理工作项“Evidence target ${suffix}”`, exact: true });
    const evidenceSelect = managementDialog.getByLabel("选择计划证据", { exact: true });
    await expect(evidenceSelect.locator("option").filter({ hasText: targetItemTitle })).toHaveCount(0);

    await managementDialog.getByRole("button", { name: "搜索证据", exact: true }).click();
    const loadMore = managementDialog.getByRole("button", { name: "加载更多", exact: true });
    await loadMore.click();
    await loadMore.click();
    await expect(evidenceSelect.locator(`option[value="projectItem:${targetItemId}"]`)).toContainText(targetItemTitle);
    await expect(evidenceSelect.locator(`option[value="projectSource:${targetSourceId}"]`)).toHaveCount(1);

    const searchInput = managementDialog.getByLabel("按标题或内容查找证据", { exact: true });
    await searchInput.fill("Z");
    await managementDialog.getByRole("button", { name: "搜索证据", exact: true }).click();
    await expect(evidenceSelect.locator(`option[value="projectItem:${targetItemId}"]`)).toContainText(targetItemTitle);
    await expect(evidenceSelect.locator(`option[value="projectSource:${targetSourceId}"]`)).toHaveCount(1);

    await evidenceSelect.selectOption(`projectItem:${targetItemId}`);
    await managementDialog.getByRole("button", { name: "关联证据", exact: true }).click();
    await expect(page.getByRole("dialog", { name: `Evidence target ${suffix}`, exact: true })).toBeVisible();
    let savedPlan = await page.request.get(planUrl).then((response) => response.json()) as { evidenceLinks: Array<{ projectItemId: string | null; projectSourceId: string | null }> };
    expect(savedPlan.evidenceLinks.some((link) => link.projectItemId === targetItemId)).toBe(true);

    await page.getByRole("button", { name: "编辑与管理", exact: true }).click();
    const sourceManagementDialog = page.getByRole("dialog", { name: `管理工作项“Evidence target ${suffix}”`, exact: true });
    const sourceSearch = sourceManagementDialog.getByLabel("按标题或内容查找证据", { exact: true });
    await sourceSearch.fill("Z");
    await sourceManagementDialog.getByRole("button", { name: "搜索证据", exact: true }).click();
    const sourceEvidenceSelect = sourceManagementDialog.getByLabel("选择计划证据", { exact: true });
    await sourceEvidenceSelect.selectOption(`projectSource:${targetSourceId}`);
    await sourceManagementDialog.getByRole("button", { name: "关联证据", exact: true }).click();
    savedPlan = await page.request.get(planUrl).then((response) => response.json()) as typeof savedPlan;
    expect(savedPlan.evidenceLinks.some((link) => link.projectSourceId === targetSourceId)).toBe(true);
  });
});
