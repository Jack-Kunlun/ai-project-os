import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { englishUiMessages } from "@/lib/ui-dictionary-source";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { seedUiConsistencyDetailFixtures } from "./support/ui-consistency-fixtures";
import { signInR02Admin, signInR02PersonalUser, signOutR02User, expectR02NoHorizontalOverflow } from "./support/r02-admin-navigation";
import { expectDialogStyleContract, expectUiStyleContract } from "./support/ui-style-contract";
import { settleVisualState } from "./support/settle-visual-state";

// Real isolated writes expose success/archived states absent from empty route fixtures.
test("project success, rejected form and archived states keep shared semantic styles", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(10_000);
  await signInR02Admin(page);
  await signOutR02User(page);
  const account = await seedBrowserPersonalUser(`ui-feedback-${randomUUID().slice(0, 10)}`, "UiFeedback2026Password!");
  await signInR02PersonalUser(page, account);
  const origin = new URL(page.url()).origin;
  const headers = { origin };
  for (const mode of [{ language: "zh-CN", theme: "light", width: 1440 }, { language: "en", theme: "dark", width: 390 }]) {
    const t = (source: string) => mode.language === "en" ? englishUiMessages[source] ?? source : source;
    await page.context().addCookies([{ name: "aipos-language", value: mode.language, url: origin }, { name: "aipos-theme", value: mode.theme, url: origin }]);
    await page.setViewportSize({ width: mode.width, height: 900 });
    const created = await page.request.post("/api/projects", { headers, data: { name: `UI feedback ${mode.theme}`, workspaceId: account.workspaceId } });
    expect(created.status()).toBe(201);
    const { project } = await created.json() as { project: { id: string } };
    const details = await seedUiConsistencyDetailFixtures(project.id, account.id);
    const itemCreated = await page.request.post(`/api/projects/${project.id}/items`, { headers, data: { sourceId: details.sourceId, type: "progress", title: "UI acceptance fixture", content: details.sourceText, sourceExcerpt: details.sourceText } });
    expect(itemCreated.status()).toBe(201);
    const item = (await itemCreated.json()).item as { id: string; updatedAt: string };
    const confirmed = await page.request.patch(`/api/projects/${project.id}/items/${item.id}`, { headers, data: { action: "confirm", expectedUpdatedAt: item.updatedAt } });
    expect(confirmed.ok()).toBeTruthy();
    const base = `/projects/${project.id}`;
    const check = async (name: string) => {
      await settleVisualState(page);
      await expectUiStyleContract(page, `${name} ${mode.theme}`);
      await expectR02NoHorizontalOverflow(page, `${name} ${mode.theme}`);
      await page.screenshot({ path: testInfo.outputPath(`${name}-${mode.theme}.png`), animations: "disabled" });
    };
    await page.goto(base);
    await page.getByRole("button", { name: t("生成状态快照"), exact: true }).click();
    const overviewSuccess = page.locator('.app-feedback-success');
    await expect(overviewSuccess).toContainText(t("项目状态快照已更新。"));
    await overviewSuccess.scrollIntoViewIfNeeded();
    await check("overview-success");

    await page.goto(`${base}/plan`);
    await page.getByRole("button", { name: t("新建目标"), exact: true }).click();
    const objective = page.getByRole("dialog", { name: t("创建项目目标"), exact: true });
    await expect(objective.getByRole("button", { name: t("创建目标草稿"), exact: true })).toBeDisabled();
    const goalTitle = "UI acceptance goal with a longer title · 页面实际保存验收";
    await objective.getByRole("textbox", { name: t("目标名称"), exact: true }).fill(goalTitle);
    await objective.getByRole("textbox", { name: t("完成标准或背景"), exact: true }).fill("Long acceptance background. ".repeat(20));
    await settleVisualState(page);
    await expectDialogStyleContract(objective, `filled objective ${mode.theme}`);
    await objective.getByRole("textbox", { name: t("目标名称"), exact: true }).press("Enter");
    await expect(objective).toBeHidden();
    await expect(page.locator('.app-feedback-success')).toContainText(t("目标已创建为草稿，由成员决定何时启动。"));
    await check("plan-success");

    await page.getByRole("button", { name: t("新建工作项"), exact: true }).click();
    const work = page.getByRole("dialog", { name: t("添加人工工作项"), exact: true });
    const itemTitle = "UI acceptance work item with long readable text";
    await work.getByRole("textbox", { name: t("工作项名称"), exact: true }).fill(itemTitle);
    await work.getByRole("textbox", { name: t("工作说明"), exact: true }).fill("Long description. ".repeat(40));
    await work.getByRole("combobox", { name: t("所属目标"), exact: true }).selectOption({ label: goalTitle });
    await page.route(`**${base.replace('/projects/', '/api/projects/')}/plan`, async route => {
      if (route.request().method() !== "POST") return route.fallback();
      await route.fulfill({ status: 503, json: { error: { code: "UI_ACCEPTANCE_UNAVAILABLE", message: "服务暂时不可用，请稍后重试。" } } });
    }, { times: 1 });
    await work.getByRole("button", { name: t("加入项目计划"), exact: true }).click();
    await expect(work.getByRole("alert")).toBeVisible();
    await expect(work.getByRole("textbox", { name: t("工作项名称"), exact: true })).toHaveValue(itemTitle);
    await work.getByRole("alert").scrollIntoViewIfNeeded();
    await check("plan-form-error");
    await work.getByRole("button", { name: t("加入项目计划"), exact: true }).click();
    await expect(work).toBeHidden();
    await expect(page.locator('.app-feedback-success')).toContainText(t("工作项已加入计划。"));
    await page.reload();
    await expect(page.getByRole("button", { name: t("查看工作项：{title}").replace("{title}", itemTitle), exact: true })).toBeVisible();

    await page.getByRole("button", { name: t("查看工作项：{title}").replace("{title}", itemTitle), exact: true }).click();
    const detail = page.getByRole("dialog", { name: itemTitle, exact: true });
    await settleVisualState(page);
    await expectDialogStyleContract(detail, `work item detail ${mode.theme}`);
    await detail.getByRole("button", { name: t("编辑与管理"), exact: true }).click();
    const manage = page.getByRole("dialog", { name: t("管理工作项“{title}”").replace("{title}", itemTitle), exact: true });
    await settleVisualState(page);
    await expectDialogStyleContract(manage, `work item management ${mode.theme}`);
    await expect(manage.getByRole("heading", { name: t("前置依赖"), exact: true })).toBeVisible();
    await manage.getByRole("textbox", { name: t("验收标准"), exact: true }).fill("Saved acceptance criteria from the real browser.");
    await check("work-item-management");
    await manage.getByRole("button", { name: t("保存工作项"), exact: true }).click();
    await expect(manage).toBeHidden();
    await expect(detail, "a replaced nested trigger restores focus to its surviving parent dialog").toBeFocused();
    await page.keyboard.press("Escape");
    await expect(detail).toBeHidden();

    const latest = await page.request.get(`/api/projects/${project.id}`);
    const current = (await latest.json()).project as { updatedAt: string };
    const archived = await page.request.post(`/api/projects/${project.id}/lifecycle`, { headers, data: { action: "archive", expectedUpdatedAt: current.updatedAt } });
    expect(archived.ok()).toBeTruthy();
    for (const route of ["", "/plan"]) {
      await page.goto(base + route);
      await expect(page.locator('.app-feedback-warning')).toBeVisible();
      await check(route ? "plan-archived" : "overview-archived");
    }
    await page.goto(`${base}/materials`);
    await expect(page.locator('h1.app-page-title')).toBeVisible();
    await check("materials-title");
  }
});
