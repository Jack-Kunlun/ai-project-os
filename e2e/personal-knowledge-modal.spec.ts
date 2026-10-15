import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { signInR02Admin } from "./support/r02-admin-navigation";

test("knowledge modals protect drafts, show small-screen validation and persist saved versions", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await signInR02Admin(page);
  const user = await seedBrowserPersonalUser(`browser-knowledge-${randomUUID().slice(0, 12)}`, "Test2026");
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await page.getByLabel("用户名或手机号", { exact: true }).fill(user.username);
  await page.getByLabel("密码", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "登 录", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/u);
  await page.goto("/personal/knowledge");
  await expect(page.getByRole("heading", { name: "我的内容", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "标题", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "新建内容", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "新建个人知识", exact: true });
  await expect(modal).toBeVisible();
  const title = modal.getByRole("textbox", { name: "标题", exact: true });
  await title.fill("未保存的验收草稿");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(title).toHaveValue("未保存的验收草稿");
  await modal.getByRole("button", { name: "关闭", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(modal.getByRole("button", { name: "创建内容", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(modal.getByRole("button", { name: "关闭", exact: true })).toBeFocused();

  const savedTitle = `个人知识弹窗验收 ${randomUUID().slice(0, 8)}`;
  await title.fill(savedTitle);
  await modal.getByRole("textbox", { name: /^正文/u }).fill("验".repeat(2001));
  await modal.getByRole("checkbox", { name: /作为个人通用记忆/u }).check();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const error = modal.getByRole("alert");
    await expect(error).toContainText("2,000 字符");
    const measurements = await Promise.all([
      error.boundingBox(), modal.getByRole("button", { name: "创建内容", exact: true }).boundingBox(),
      page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, documentWidth: document.documentElement.scrollWidth })),
    ]);
    const [errorBox, submitBox, viewport] = measurements;
    expect(errorBox).not.toBeNull();
    expect(submitBox).not.toBeNull();
    expect(errorBox!.y + errorBox!.height).toBeLessThanOrEqual(viewport.height);
    expect(submitBox!.y + submitBox!.height).toBeLessThanOrEqual(viewport.height);
    expect(viewport.documentWidth).toBeLessThanOrEqual(viewport.width);
  }
  let creates = 0;
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/personal/knowledge") creates += 1;
  });
  await modal.getByRole("button", { name: "创建内容", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("2,000 字符");
  expect(creates).toBe(0);
  await modal.getByRole("checkbox", { name: /作为个人通用记忆/u }).uncheck();
  await modal.getByRole("button", { name: "创建内容", exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByRole("heading", { name: savedTitle, exact: true })).toBeVisible();
  expect(creates).toBe(1);
  await page.reload();
  await page.getByRole("button").filter({ has: page.getByRole("heading", { name: savedTitle, exact: true }) }).click();
  await expect(page.getByRole("heading", { name: savedTitle, exact: true })).toBeVisible();
  const providerResponse = await page.request.get("/api/me/ai-providers");
  expect(providerResponse.status()).toBe(200);
  expect(await providerResponse.json()).toHaveProperty("providers");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "编辑个人知识", exact: true });
  await expect(edit.getByRole("textbox", { name: "标题", exact: true })).toHaveValue(savedTitle);
  const revisedTitle = `${savedTitle} v2`;
  await edit.getByRole("textbox", { name: "标题", exact: true }).fill(revisedTitle);
  await edit.getByRole("button", { name: "保存新版本", exact: true }).click();
  await expect(edit).toHaveCount(0);
  await expect(page.getByRole("heading", { name: revisedTitle, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await edit.getByRole("textbox", { name: "标题", exact: true }).fill("将被放弃的改动");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "放弃修改并离开", exact: true }).click();
  await expect(edit).toHaveCount(0);
  await expect(page.getByRole("heading", { name: revisedTitle, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  await page.getByRole("button", { name: "← 返回我的内容", exact: true }).click();
  await page.getByRole("button", { name: "导入文件", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "导入个人知识", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  expect(pageErrors).toEqual([]);
});
