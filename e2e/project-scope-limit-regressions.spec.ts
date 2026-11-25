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

  test("the workspace dropdown searches and pages beyond the first 100 without resetting its saved selection", async ({ page }, testInfo) => {
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
    const picker = page.getByRole("button", { name: "切换工作空间", exact: true });
    await page.evaluate((key) => localStorage.removeItem(key), storageKey);
    await page.reload();
    await expect(picker).toBeEnabled({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "查找其他工作区", exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("desktop-closed.png"), fullPage: true });
    const navigation = page.getByRole("navigation", { name: "全局入口", exact: true });
    const navigationBefore = await navigation.boundingBox();
    await picker.click();
    const dropdown = page.locator("[data-workspace-dropdown]");
    const search = dropdown.getByRole("combobox", { name: "搜索工作区名称", exact: true });
    await expect(search).toBeFocused();
    expect(await navigation.boundingBox()).toEqual(navigationBefore);
    await expect(page.getByRole("option", { name: targetName, exact: true })).toHaveCount(0);
    await search.fill("Z");
    const targetResult = dropdown.getByRole("option", { name: targetName, exact: true });
    await expect(targetResult).toBeVisible();
    await search.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
    await expect(dropdown).toBeVisible();
    await expect(picker).toHaveAttribute("data-workspace-id", user.workspaceId);
    await search.dispatchEvent("keydown", { key: "Escape", code: "Escape", isComposing: true });
    await expect(dropdown).toBeVisible();
    await expect(search).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("desktop-search.png"), fullPage: true });
    await targetResult.click();
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey)).toBe(targetId);
    await expect(picker).toHaveAttribute("data-workspace-id", targetId);

    await page.reload();
    await expect(picker).toHaveAttribute("data-workspace-id", targetId);
    await expect(picker).toHaveAttribute("title", targetName);

    await page.evaluate((key) => localStorage.removeItem(key), storageKey);
    await page.reload();
    await expect(picker).toHaveAttribute("data-workspace-id", user.workspaceId);
    await picker.click();
    const browseResults = dropdown.getByRole("listbox", { name: "工作区搜索结果", exact: true });
    await expect(browseResults.getByRole("option").first()).toBeVisible();
    await expect(browseResults).toHaveAttribute("aria-busy", "false");
    await search.press("ArrowDown");
    const activeBeforePaging = await search.getAttribute("aria-activedescendant");
    const nextPage = dropdown.getByRole("button", { name: "下一页", exact: true });
    await nextPage.focus();
    const previousCount = await browseResults.getByRole("option").count();
    const resultsRegion = dropdown.getByRole("region", { name: "工作区搜索结果", exact: true });
    const scrollBeforePaging = await resultsRegion.evaluate((element) => element.scrollTop);
    await nextPage.press("Enter");
    await expect.poll(() => browseResults.getByRole("option").count()).toBeGreaterThan(previousCount);
    await expect(search).toHaveAttribute("aria-activedescendant", activeBeforePaging!);
    await expect(nextPage).toBeFocused();
    expect(await resultsRegion.evaluate((element) => element.scrollTop)).toBeGreaterThanOrEqual(scrollBeforePaging);
    const browsedTarget = dropdown.getByRole("option", { name: targetName, exact: true });
    while (!(await browsedTarget.isVisible().catch(() => false))) {
      const next = dropdown.getByRole("button", { name: "下一页", exact: true });
      if (!(await next.isVisible().catch(() => false)) || !(await next.isEnabled().catch(() => false))) break;
      const previousCount = await browseResults.getByRole("option").count();
      await next.click();
      await expect.poll(() => browseResults.getByRole("option").count()).toBeGreaterThan(previousCount);
    }
    await expect(browsedTarget).toBeVisible();
    await search.fill("Z");
    await expect(dropdown.getByRole("option")).toHaveCount(1);
    await search.press("ArrowDown");
    await search.press("Enter");
    await expect(dropdown).toBeHidden();
    await expect(picker).toHaveAttribute("data-workspace-id", targetId);
    await expect(picker).toBeFocused();
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
    const { objective } = await objectiveResponse.json() as { objective: { id: string; targetDate: string | null } };
    expect(objective.targetDate).toBe("2026-11-23T00:00:00.000Z");
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
    const dateObjective = page.locator("#objectives article").filter({ hasText: `Date target ${suffix}` });
    await expect(dateObjective).toHaveCount(1);
    await expect(dateObjective).toContainText("2026年11月23日");

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
    const itemLinkResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith(planUrl) && response.request().method() === "POST",
    );
    await managementDialog.getByRole("button", { name: "关联证据", exact: true }).click();
    const itemLinkResponse = await itemLinkResponsePromise;
    const itemLinkPayload = await itemLinkResponse.json().catch(() => null);
    expect(itemLinkResponse.ok(), `Project item evidence link failed: ${itemLinkResponse.status()} ${JSON.stringify(itemLinkPayload)}`).toBe(true);
    await expect(page.getByRole("dialog", { name: `Evidence target ${suffix}`, exact: true })).toBeVisible();
    type SavedPlan = { evidenceLinks: Array<{ projectItemId: string | null; projectSourceId: string | null }> };
    await expect.poll(async () => {
      const savedPlan = await page.request.get(planUrl).then((response) => response.json()) as SavedPlan;
      return savedPlan.evidenceLinks.some((link) => link.projectItemId === targetItemId);
    }).toBe(true);

    await page.getByRole("button", { name: "编辑与管理", exact: true }).click();
    const sourceManagementDialog = page.getByRole("dialog", { name: `管理工作项“Evidence target ${suffix}”`, exact: true });
    const sourceSearch = sourceManagementDialog.getByLabel("按标题或内容查找证据", { exact: true });
    await sourceSearch.fill("Z");
    await sourceManagementDialog.getByRole("button", { name: "搜索证据", exact: true }).click();
    const sourceEvidenceSelect = sourceManagementDialog.getByLabel("选择计划证据", { exact: true });
    await sourceEvidenceSelect.selectOption(`projectSource:${targetSourceId}`);
    const sourceLinkResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith(planUrl) && response.request().method() === "POST",
    );
    await sourceManagementDialog.getByRole("button", { name: "关联证据", exact: true }).click();
    const sourceLinkResponse = await sourceLinkResponsePromise;
    const sourceLinkPayload = await sourceLinkResponse.json().catch(() => null);
    expect(sourceLinkResponse.ok(), `Source evidence link failed: ${sourceLinkResponse.status()} ${JSON.stringify(sourceLinkPayload)}`).toBe(true);
    await expect.poll(async () => {
      const savedPlan = await page.request.get(planUrl).then((response) => response.json()) as SavedPlan;
      return savedPlan.evidenceLinks.some((link) => link.projectSourceId === targetSourceId);
    }).toBe(true);
  });
});
