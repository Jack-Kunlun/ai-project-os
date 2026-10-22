import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { expectR02NoHorizontalOverflow, signInR02PersonalUser } from "./support/r02-admin-navigation";

async function createProject(page: import("@playwright/test").Page, workspaceId: string) {
  const name = `Detail list project ${randomUUID().slice(0, 8)}`;
  const response = await page.context().request.post(new URL("/api/projects", page.url()).toString(), {
    headers: { origin: new URL(page.url()).origin },
    data: { name, description: "Isolated read-only display fixture.", workspaceId },
  });
  const responseText = await response.text();
  expect(response.status(), responseText).toBe(201);
  const payload = JSON.parse(responseText) as { project?: { id?: string } };
  expect(payload.project?.id).toMatch(/^[0-9a-f-]{36}$/iu);
  return { id: payload.project!.id!, name };
}

const longMemberName = `LongUnbrokenProjectMember${"x".repeat(96)}`;

const modes = [
  { language: "zh-CN", theme: "light", width: 1440 },
  { language: "en", theme: "dark", width: 1440 },
  { language: "en", theme: "dark", width: 1100 },
  { language: "zh-CN", theme: "light", width: 390 },
  { language: "en", theme: "dark", width: 390 },
] as const;

test("source detail and project members follow prototype reading layouts (isolated GET display fixtures)", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const user = await seedBrowserPersonalUser(`detail-list-${randomUUID().slice(0, 8)}`, "DetailList2026Password!");
  await signInR02PersonalUser(page, user);
  const project = await createProject(page, user.workspaceId);
  const sourceId = randomUUID();
  const sourceText = "A read-only source detail fixture with a preserved original text body.";
  const origin = new URL(page.url()).origin;
  const evidence = { sourceGet: false, membersGet: false, blockedWrites: [] as string[] };

  // Setup writes are complete. GET fixtures below exercise display branches only,
  // not server authorization. All subsequent write requests are blocked.
  await page.route("**/*", (route) => {
    const method = route.request().method();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return route.fallback();
    evidence.blockedWrites.push(`${method} ${new URL(route.request().url()).pathname}`);
    return route.abort();
  });
  await page.route(`**/api/projects/${project.id}/sources/${sourceId}*`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    evidence.sourceGet = true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ source: {
        id: sourceId,
        kind: "manual",
        externalRef: "https://example.test/source-document",
        contentText: sourceText,
        contentHash: "a".repeat(64),
        capturedAt: null,
        ingestedAt: "2026-10-22T00:00:00.000Z",
      } }),
    });
  });
  await page.route(`**/api/projects/${project.id}/members`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    evidence.membersGet = true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        project: { id: project.id, name: project.name, workspaceId: user.workspaceId, membershipInheritanceMode: "teamOwnerFirst" },
        canManage: true,
        canManageWorkspace: false,
        truncated: false,
        members: [{
          userId: user.id,
          username: user.username,
          displayName: longMemberName,
          workspaceRole: "owner",
          membershipId: randomUUID(),
          projectRole: "editor",
          inheritedOwner: false,
          canGrant: true,
        }],
      }),
    });
  });

  for (const mode of modes) {
    const modeName = `${mode.language}-${mode.theme}-${mode.width}`;
    await page.setViewportSize({ width: mode.width, height: mode.width === 390 ? 844 : 1000 });
    await page.context().addCookies([
      { name: "aipos-language", value: mode.language, url: origin, sameSite: "Lax" },
      { name: "aipos-theme", value: mode.theme, url: origin, sameSite: "Lax" },
    ]);

    await page.goto(`/projects/${project.id}/materials/sources/${sourceId}`);
    const sourceDocument = page.locator("[data-source-document]");
    await expect(sourceDocument).toBeVisible();
    await expect(sourceDocument).toHaveText(sourceText);
    const readingBox = await sourceDocument.locator("..").boundingBox();
    const metadataBox = await page.locator("[data-page-content]").getByRole("complementary").boundingBox();
    expect(readingBox).not.toBeNull();
    expect(metadataBox).not.toBeNull();
    if (mode.width === 1440) expect(metadataBox!.x).toBeGreaterThan(readingBox!.x + readingBox!.width);
    else expect(metadataBox!.y).toBeGreaterThan(readingBox!.y + readingBox!.height);
    await expect(page.getByText(sourceId, { exact: true })).toBeVisible();
    await expectR02NoHorizontalOverflow(page, `source detail ${modeName}`);
    if (mode.language === "en") {
      expect(await page.locator("[data-page-content]").innerText()).not.toMatch(/\p{Script=Han}/u);
    }
    await page.screenshot({ path: testInfo.outputPath(`source-detail-${modeName}.png`), fullPage: true });

    await page.goto(`/projects/${project.id}/members`);
    const membersTable = page.getByRole("table");
    await expect(membersTable).toBeVisible();
    await expect(membersTable.getByRole("row")).toHaveCount(2);
    await expect(membersTable).toContainText(user.username);
    await expect(membersTable).toContainText(longMemberName);
    await expectR02NoHorizontalOverflow(page, `project members ${modeName}`);
    const expectedDisplay = mode.width === 390 ? "block" : "table";
    await expect.poll(() => membersTable.evaluate((table) => getComputedStyle(table).display)).toBe(expectedDisplay);
    const tableInk = await membersTable.evaluate((table) => ({
      color: getComputedStyle(table).color,
      background: getComputedStyle(table).backgroundColor,
      surface: getComputedStyle(document.documentElement).getPropertyValue("--app-surface").trim(),
    }));
    expect(tableInk.color).not.toBe(tableInk.background);
    expect(tableInk.surface).toBeTruthy();
    if (mode.language === "en") {
      expect(await page.locator("[data-page-content]").innerText()).not.toMatch(/\p{Script=Han}/u);
    }
    await page.screenshot({ path: testInfo.outputPath(`project-members-${modeName}.png`), fullPage: true });
    const edit = membersTable.getByRole("button", { name: mode.language === "en" ? "Edit permissions" : "编辑权限", exact: true });
    await expect(edit).toHaveCount(1);
    await edit.click();
    const editor = page.getByRole("dialog").filter({ has: page.locator("select") });
    await expect(editor).toBeVisible();
    await editor.getByRole("combobox").selectOption("viewer");
    await editor.getByRole("button", { name: mode.language === "en" ? "Close dialog" : "关闭窗口", exact: true }).click();
    await expect(editor).toBeHidden();
    await expect(edit).toBeFocused();
  }

  expect(evidence.sourceGet).toBe(true);
  expect(evidence.membersGet).toBe(true);
  expect(evidence.blockedWrites).toEqual([]);
});
