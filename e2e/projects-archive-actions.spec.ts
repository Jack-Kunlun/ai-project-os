import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { englishUiMessages } from "@/lib/ui-dictionary-source";
import { getDb } from "@/lib/db";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { expectR02NoHorizontalOverflow, signInR02Admin, signInR02PersonalUser, signOutR02User } from "./support/r02-admin-navigation";

for (const mode of [
  { language: "zh-CN", theme: "light", width: 1440 },
  { language: "en", theme: "dark", width: 390 },
] as const) {
  test(`archived project quick deletion preserves confirmation and refreshes the list (${mode.language}/${mode.theme})`, async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const suffix = randomUUID().slice(0, 8);
    await signInR02Admin(page);
    await signOutR02User(page);
    const user = await seedBrowserPersonalUser(`archive-action-${suffix}`, "ArchiveAction2026Password!");
    await signInR02PersonalUser(page, user);
    const origin = new URL(page.url()).origin;
    const headers = { origin };
    const name = `Archive action ${suffix}`;
    const created = await page.request.post("/api/projects", { headers, data: { name, workspaceId: user.workspaceId } });
    expect(created.status()).toBe(201);
    const { project } = await created.json() as { project: { id: string; updatedAt: string } };
    const endpoint = `/api/projects/${project.id}`;
    const t = (source: string) => mode.language === "en" ? englishUiMessages[source] ?? source : source;
    await page.context().addCookies([
      { name: "aipos-language", value: mode.language, url: origin },
      { name: "aipos-theme", value: mode.theme, url: origin },
    ]);
    await page.setViewportSize({ width: mode.width, height: 900 });
    await page.goto("/personal/projects");
    const list = page.getByRole("region", { name: t("项目列表"), exact: true });
    const card = list.getByRole("article").filter({ has: page.getByRole("heading", { name, exact: true }) });
    await expect(card).toBeVisible();
    await expect(card.getByRole("button", { name: new RegExp(t("永久删除"), "u") })).toHaveCount(0);
    const archived = await page.request.post(`${endpoint}/lifecycle`, { headers, data: { action: "archive", expectedUpdatedAt: project.updatedAt } });
    expect(archived.ok()).toBeTruthy();
    const archivedState = await page.request.get(endpoint);
    const { project: current } = await archivedState.json() as { project: { updatedAt: string } };
    await page.getByRole("button", { name: new RegExp(`^${t("已归档")} `, "u") }).click();
    await page.getByRole("textbox", { name: t("搜索项目"), exact: true }).fill(suffix);
    await expect(card).toBeVisible();
    const trigger = card.getByRole("button", { name: `${t("永久删除")} ${name}`, exact: true });
    await expect(trigger).toBeVisible();
    await expectR02NoHorizontalOverflow(page, `${mode.language} archived project actions`);
    await testInfo.attach("archived-project-actions", { body: await page.screenshot(), contentType: "image/png" });

    const writes: unknown[] = [];
    let failure = 403;
    await page.route(`**${endpoint}`, async route => {
      if (route.request().method() !== "DELETE") return route.fallback();
      writes.push(route.request().postDataJSON());
      if (failure) return route.fulfill({ status: failure, json: { error: { code: failure === 409 ? "PROJECT_HAS_UNRESOLVED_JOBS" : "FORBIDDEN", message: failure === 403 ? "Only project owners may delete" : "项目仍有运行中或待人工收口的任务，暂不能归档或永久删除" } } });
      return route.fallback();
    });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: t("永久删除「{name}」").replace("{name}", name), exact: true });
    const confirm = dialog.getByRole("button", { name: t("确认永久删除"), exact: true });
    const input = dialog.getByRole("textbox", { name: t("输入项目名称以确认"), exact: true });
    await expect(dialog).toBeVisible();
    await expect(confirm).toBeDisabled();
    await input.fill("wrong project");
    await expect(confirm).toBeDisabled();
    await input.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(writes).toEqual([]);

    await trigger.click();
    await input.fill(name);
    await expectR02NoHorizontalOverflow(page, `${mode.language} project delete confirmation`);
    await testInfo.attach("project-delete-confirmation", { body: await page.screenshot(), contentType: "image/png" });
    await confirm.click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(card).toBeVisible();
    await expect(confirm).toBeEnabled();
    failure = 409;
    await confirm.click();
    await expect(dialog.getByRole("alert")).toHaveText(t("项目仍有运行中或待人工收口的任务，暂不能归档或永久删除"));
    await expect(confirm).toBeEnabled();
    await expect(dialog.getByRole("button", { name: t("重新读取项目"), exact: true })).toHaveCount(0);
    failure = 0;
    const restored = await page.request.post(`${endpoint}/lifecycle`, { headers, data: { action: "restore", expectedUpdatedAt: current.updatedAt } });
    expect(restored.ok()).toBeTruthy();
    const restoredState = await page.request.get(endpoint);
    const { project: active } = await restoredState.json() as { project: { updatedAt: string } };
    const rearchived = await page.request.post(`${endpoint}/lifecycle`, { headers, data: { action: "archive", expectedUpdatedAt: active.updatedAt } });
    expect(rearchived.ok()).toBeTruthy();
    const latestState = await page.request.get(endpoint);
    const { project: latest } = await latestState.json() as { project: { updatedAt: string } };
    expect(latest.updatedAt).not.toBe(current.updatedAt);
    await confirm.click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(confirm).toBeDisabled();
    expect(writes).toHaveLength(3);
    for (const write of writes) expect(write).toEqual({ confirmationName: name, expectedUpdatedAt: current.updatedAt });
    await dialog.getByRole("button", { name: t("重新读取项目"), exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(input).toHaveValue("");
    await input.fill(name);
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    await expect(card).toHaveCount(0);
    await expect(page).toHaveURL(/\/personal\/projects$/u);
    await expect(page.getByRole("textbox", { name: t("搜索项目"), exact: true })).toHaveValue(suffix);
    await expect(page.getByRole("button", { name: `${t("已归档")} 0`, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(`select option[value="${project.id}"]`)).toHaveCount(0);
    expect(await getDb().project.findUnique({ where: { id: project.id }, select: { id: true } })).toBeNull();
    expect(writes).toHaveLength(4);
    expect(writes[3]).toEqual({ confirmationName: name, expectedUpdatedAt: latest.updatedAt });
  });
}
