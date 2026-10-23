import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { getDb } from "@/lib/db";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { signInR02Admin, signInR02PersonalUser, signOutR02User, expectR02NoAccessibilityViolations } from "./support/r02-admin-navigation";
import { longTextPdf } from "./support/long-text-pdf";

test.setTimeout(90_000);

async function projectFixture(page: Page) {
  await signInR02Admin(page);
  const user = await seedBrowserPersonalUser(`browser-operations-${randomUUID().slice(0, 8)}`, "BrowserOperations2026Password!");
  await signOutR02User(page);
  await signInR02PersonalUser(page, user);
  await page.goto("/projects");
  await page.getByRole("button", { name: "＋ 新建项目" }).click();
  const name = `Operations browser ${randomUUID().slice(0, 8)}`;
  await page.getByLabel("项目名称", { exact: true }).fill(name);
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name, exact: true }) });
  const href = await card.getByRole("link", { name: `查看项目 ${name}`, exact: true }).getAttribute("href");
  expect(href).toMatch(/^\/projects\/[0-9a-f-]+$/u);
  return href!.slice("/projects/".length);
}

test("project creation dialog traps focus, restores its opener, and stays open while pending", async ({ page }) => {
  await signInR02Admin(page);
  const user = await seedBrowserPersonalUser(`browser-project-dialog-${randomUUID().slice(0, 8)}`, "BrowserProjectDialog2026Password!");
  await signOutR02User(page);
  await signInR02PersonalUser(page, user);

  let resolvePendingCreate!: () => void;
  const pendingCreate = new Promise<void>((resolve) => { resolvePendingCreate = resolve; });
  let markCreateStarted!: () => void;
  const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve; });
  const projectCreateRequests: string[] = [];
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    projectCreateRequests.push(route.request().method());
    markCreateStarted();
    await pendingCreate;
    await route.fulfill({ status: 400, json: { error: { code: "CONTROLLED_UI_TEST", message: "Controlled project creation error" } } });
  });

  for (const appearance of [
    { width: 1440, height: 900, language: "zh-CN", theme: "light", openerName: "＋ 新建项目", dialogName: "创建项目空间", closeName: "关闭", cancelName: "取消" },
    { width: 390, height: 844, language: "en", theme: "dark", openerName: "＋ New project", dialogName: "Create a project workspace", closeName: "Close", cancelName: "Cancel" },
  ] as const) {
    await page.setViewportSize({ width: appearance.width, height: appearance.height });
    const origin = new URL(page.url()).origin;
    await page.context().addCookies([
      { name: "aipos-language", value: appearance.language, url: origin },
      { name: "aipos-theme", value: appearance.theme, url: origin },
    ]);
    await page.goto("/projects");
    await expect(page.locator("html")).toHaveAttribute("lang", appearance.language === "en" ? "en" : "zh-CN");
    await expect(page.locator("html")).toHaveAttribute("data-theme", appearance.theme === "dark" ? "dark" : "light");

    const opener = page.getByRole("button", { name: appearance.openerName, exact: true }).first();
    await opener.click();
    const dialog = page.getByRole("dialog", { name: appearance.dialogName, exact: true });
    const close = dialog.getByRole("button", { name: appearance.closeName, exact: true });
    await expect(dialog).toBeVisible();
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: appearance.cancelName, exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    expect(projectCreateRequests).toEqual([]);

    await opener.click();
    const reopenedDialog = page.getByRole("dialog", { name: appearance.dialogName, exact: true });
    await reopenedDialog.getByRole("button", { name: appearance.closeName, exact: true }).click();
    await expect(reopenedDialog).toBeHidden();
    await expect(opener).toBeFocused();
    expect(projectCreateRequests).toEqual([]);
  }

  const opener = page.getByRole("button", { name: "＋ New project", exact: true }).first();
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Create a project workspace", exact: true });
  await dialog.getByLabel("Project name", { exact: true }).fill("Pending project draft");
  await dialog.getByRole("button", { name: "Create project", exact: true }).click();
  await createStarted;
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  await expect(close).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(dialog).toBeVisible();
  await close.evaluate((button) => (button as HTMLButtonElement).click());
  await expect(dialog).toBeVisible();
  expect(projectCreateRequests).toEqual(["POST"]);

  resolvePendingCreate();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByLabel("Project name", { exact: true })).toHaveValue("Pending project draft");
  await expect(dialog).toBeVisible();
});

/** Model responses are isolated fixtures; PostgreSQL service gates prove actual fact persistence. */
async function mockModelFlow(page: Page, projectId: string) {
  const prepared: Array<{ sourceIds: string[]; clientKey: string }> = [];
  const executed: Array<{ sourceIds: string[]; clientKey: string; challengeId: string }> = [];
  const challengeId = randomUUID();
  const completedJobs = new Map<string, { id: string; status: string; result: { confirmedCount: number; reviewRequiredCount: number; duplicateCount: number } }>();
  await page.route(`**/api/projects/${projectId}/memory/extract`, async (route) => {
    const body = route.request().postDataJSON();
    if (body.phase === "prepare") {
      const sources = await getDb().projectSource.findMany({ where: { projectId, id: { in: body.sourceIds } }, select: { contentText: true } });
      expect(sources.reduce((total, source) => total + source.contentText.length, 0), "each consent batch must fit the real endpoint's 200k budget").toBeLessThanOrEqual(200_000);
      prepared.push(body);
      const batchChallengeId = prepared.length === 1 ? challengeId : randomUUID();
      await route.fulfill({ json: { confirmation: { challengeId: batchChallengeId, expiresAt: new Date(Date.now() + 120_000).toISOString(), safeSummary: { route: { provider: { name: "Isolated browser model" }, model: "fixture" } } } } });
    } else {
      executed.push(body);
      const jobId = randomUUID();
      completedJobs.set(jobId, { id: jobId, status: "succeeded", result: { confirmedCount: 2, reviewRequiredCount: 1, duplicateCount: 0 } });
      await route.fulfill({ status: 202, json: { job: { id: jobId, status: "queued", result: null } } });
    }
  });
  await page.route(`**/api/projects/${projectId}/jobs?*`, (route) => {
    const ids = new URL(route.request().url()).searchParams.get("ids")?.split(",") ?? [];
    return route.fulfill({ json: { jobs: ids.flatMap((id) => completedJobs.has(id) ? [completedJobs.get(id)!] : []) } });
  });
  return { prepared, executed, challengeId };
}

test("materials keep editing separate, retain drafts, and chain text import into one explicit model consent", async ({ page }) => {
  const projectId = await projectFixture(page);
  const flow = await mockModelFlow(page, projectId);
  await page.goto(`/projects/${projectId}/materials`);
  await expect(page.getByRole("heading", { name: "资料来源", exact: true })).toBeVisible();
  await expect(page.locator("#project-item-form")).toHaveCount(0);
  await page.getByRole("navigation", { name: "项目资料栏目" }).getByRole("link", { name: "整理结果", exact: true }).click();
  const editTrigger = page.getByRole("button", { name: "手动补充", exact: true });
  await editTrigger.click();
  const editor = page.getByRole("dialog", { name: "手动补充事实", exact: true });
  await expect(editor).toBeVisible();
  await editor.locator("#item-title").fill("保留草稿");
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await expect(editTrigger).toBeFocused();
  await editTrigger.click();
  await expect(editor.locator("#item-title")).toHaveValue("保留草稿");
  await editor.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await page.screenshot({ path: "test-results/page-workflows-auto-facts/materials-view.png" });
  await page.locator("#add-source-trigger").click();
  const intake = page.getByRole("dialog", { name: "添加资料", exact: true });
  const text = `Browser imported factual source ${randomUUID()}`;
  await intake.locator("#manual-text textarea").fill(text);
  await intake.getByRole("button", { name: "加入原始资料", exact: true }).click();
  const organize = intake.getByRole("button", { name: "确认发送并加入队列", exact: true });
  await expect(organize).toBeVisible({ timeout: 15_000 });
  const source = await getDb().projectSource.findFirstOrThrow({ where: { projectId, contentText: text }, select: { id: true } });
  expect(flow.prepared).toHaveLength(1);
  expect(flow.prepared[0]!.sourceIds).toEqual([source.id]);
  expect(flow.executed).toHaveLength(0);
  await organize.evaluate((element) => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  await expect(intake.getByText("自动形成 2 条事实 · 1 条待处理 · 跳过 0 条重复记录", { exact: true })).toBeVisible();
  expect(flow.executed).toHaveLength(1);
  expect(flow.executed[0]!.challengeId).toBe(flow.challengeId);
  expect(flow.executed[0]!.clientKey).toBe(flow.prepared[0]!.clientKey);
});

test("material intake keeps its close control beside translated headings at narrow widths", async ({ page }) => {
  const projectId = await projectFixture(page);
  const origin = new URL(page.url()).origin;
  for (const appearance of [
    { width: 1440, height: 1000, language: "zh-CN", theme: "light", title: "添加资料", close: "关闭窗口" },
    { width: 390, height: 844, language: "zh-CN", theme: "light", title: "添加资料", close: "关闭窗口" },
    { width: 1440, height: 1000, language: "en", theme: "dark", title: "Add materials", close: "Close dialog" },
    { width: 390, height: 844, language: "en", theme: "dark", title: "Add materials", close: "Close dialog" },
  ]) {
    await page.setViewportSize({ width: appearance.width, height: appearance.height });
    await page.context().addCookies([
      { name: "aipos-language", value: appearance.language, url: origin },
      { name: "aipos-theme", value: appearance.theme, url: origin },
    ]);
    await page.goto(`/projects/${projectId}/materials`);
    await page.locator("#add-source-trigger").click();
    const intake = page.getByRole("dialog", { name: appearance.title, exact: true });
    const heading = intake.getByRole("heading", { name: appearance.title, exact: true });
    await expect(heading).toBeVisible();
    const close = intake.getByRole("button", { name: appearance.close, exact: true });
    const [headingBox, closeBox] = await Promise.all([heading.boundingBox(), close.boundingBox()]);
    expect(headingBox).not.toBeNull();
    expect(closeBox).not.toBeNull();
    expect(closeBox!.x).toBeGreaterThanOrEqual(headingBox!.x + headingBox!.width);
    expect(Math.abs(closeBox!.y - headingBox!.y)).toBeLessThanOrEqual(4);
    expect(closeBox!.width).toBe(32);
    expect(closeBox!.height).toBe(32);
    await page.screenshot({ path: `test-results/page-workflows-auto-facts/materials-header-${appearance.language}-${appearance.width}.png` });
    await close.click();
    await expect(intake).toBeHidden();
  }
});

test("long PDF pages use a dedicated import workspace and fit each consent batch", async ({ page }) => {
  const projectId = await projectFixture(page);
  const flow = await mockModelFlow(page, projectId);
  let parsingReads = 0;
  await page.route(`**/api/projects/${projectId}/assets`, async (route) => {
    if (route.request().method() !== "POST") { await route.fallback(); return; }
    const response = await route.fetch();
    const payload = await response.json();
    // Simulate the worker claiming local parsing before the upload response.
    payload.asset.status = "parsing";
    payload.asset.segments = [];
    await route.fulfill({ response, json: payload });
  });
  page.on("request", (request) => { if (request.method() === "GET" && new URL(request.url()).pathname.startsWith(`/api/projects/${projectId}/assets/`)) parsingReads += 1; });
  await page.goto(`/projects/${projectId}/assets`);
  await expect(page.getByRole("heading", { name: "已上传文件", exact: true })).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await page.getByRole("button", { name: "导入文件或文件夹", exact: true }).click();
  const intake = page.getByRole("dialog", { name: "导入文件并整理事实", exact: true });
  await expect(intake).toBeVisible();
  await intake.locator('input[type="file"]').first().setInputFiles({ name: "operations-long-pages.pdf", mimeType: "application/pdf", buffer: longTextPdf() });
  await intake.getByRole("button", { name: "上传并解析", exact: true }).click();
  const organize = intake.getByRole("button", { name: "确认发送并加入队列", exact: true });
  await expect(organize).toBeVisible({ timeout: 15_000 });
  expect(flow.prepared).toHaveLength(2);
  expect(parsingReads).toBeGreaterThanOrEqual(1);
  const sources = await getDb().projectSource.findMany({ where: { projectId }, select: { id: true, contentText: true } });
  expect(sources).toHaveLength(3);
  expect(sources.every((source) => source.contentText.length > 60_000 && source.contentText.length <= 100_000)).toBe(true);
  expect(sources.reduce((total, source) => total + source.contentText.length, 0)).toBeGreaterThan(200_000);
  expect(flow.prepared.flatMap((batch) => batch.sourceIds).sort()).toEqual(sources.map((source) => source.id).sort());
  expect(flow.prepared.every((batch) => batch.sourceIds.length <= 2)).toBe(true);
  expect(flow.executed).toHaveLength(0);
  await expectR02NoAccessibilityViolations(page, "dedicated file import workspace");
  await organize.click();
  await expect(intake.getByText("自动形成 4 条事实 · 2 条待处理 · 跳过 0 条重复记录", { exact: true })).toBeVisible();
  await expect(intake.getByRole("link", { name: "处理待核对内容", exact: true }).first()).toBeVisible();
  expect(flow.executed).toHaveLength(2);
  expect(new Set(flow.executed.map((batch) => batch.challengeId)).size).toBe(2);
  for (const batch of flow.executed) expect(batch.sourceIds).toEqual(flow.prepared.find((prepared) => prepared.clientKey === batch.clientKey)!.sourceIds);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "test-results/page-workflows-auto-facts/assets-import-mobile.png" });
});

test("profile operations preserve a failed draft and return to the updated view on success", async ({ page }) => {
  await projectFixture(page);
  await page.goto("/profile");
  const edit = page.getByRole("button", { name: "编辑资料", exact: true });
  await expect(edit).toBeEnabled();
  await expect(page.getByLabel("显示名称", { exact: true })).toHaveCount(0);
  await edit.click();
  const details = page.getByRole("dialog", { name: "编辑个人资料", exact: true });
  const displayName = `Saved profile ${randomUUID().slice(0, 8)}`;
  await details.getByLabel("显示名称", { exact: true }).fill(displayName);
  await page.route("**/api/profile", async (route) => {
    if (route.request().method() !== "PATCH") { await route.fallback(); return; }
    await route.fulfill({ status: 400, json: { error: { message: "Isolated profile retry error" } } });
  });
  await details.getByRole("button", { name: "保存个人资料", exact: true }).click();
  await expect(details.getByRole("alert")).toContainText("操作需要核对");
  await expect(details.getByRole("alert")).not.toContainText("Isolated profile retry error");
  await details.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await edit.click();
  await expect(details.getByLabel("显示名称", { exact: true })).toHaveValue(displayName);
  await expectR02NoAccessibilityViolations(page, "profile operation workspace");
  await page.unroute("**/api/profile");
  await details.getByRole("button", { name: "保存个人资料", exact: true }).click();
  await expect(details).toBeHidden();
  await expect(page.getByText(displayName, { exact: true }).first()).toBeVisible();
  await expect(edit).toBeFocused();

  await page.getByRole("button", { name: "登录名", exact: true }).click();
  const username = page.getByRole("dialog", { name: "登录名", exact: true });
  const nextUsername = `operations-${randomUUID().slice(0, 8)}`;
  await username.getByLabel("登录名", { exact: true }).fill(nextUsername);
  await username.getByRole("button", { name: "保存", exact: true }).click();
  await expect(username).toBeHidden();
  await expect(page.getByText("登录名已更新，下次请使用新登录名。", { exact: true })).toBeVisible();
});
