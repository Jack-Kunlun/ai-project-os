import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { signInR02Admin, signOutR02User } from "./support/r02-admin-navigation";

async function expectKnowledgeDialogsClosed(page: Page): Promise<void> {
  const dialogs = page.locator('dialog[aria-label="个人知识详情"], dialog[aria-labelledby="knowledge-modal-title"]');
  await expect(dialogs).toHaveCount(2);
  await expect(dialogs.nth(0)).toBeHidden();
  await expect(dialogs.nth(1)).toBeHidden();
}

test("knowledge modals protect drafts, show small-screen validation and persist saved versions", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await signInR02Admin(page);
  const user = await seedBrowserPersonalUser(`browser-knowledge-${randomUUID().slice(0, 12)}`, "Test2026");
  await signOutR02User(page);
  await page.getByLabel("用户名或手机号", { exact: true }).fill(user.username);
  await page.getByLabel("密码", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "登 录", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/u);
  await page.goto("/personal/knowledge");
  await expect(page.getByRole("heading", { name: "我的知识", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "标题", exact: true })).toHaveCount(0);
  await page.locator("header").filter({ has: page.getByRole("heading", { name: "我的知识", exact: true }) }).getByRole("button", { name: "新建知识", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "新建知识", exact: true });
  const modalElement = page.locator('dialog[aria-labelledby="knowledge-modal-title"]');
  await expect(modal).toBeVisible();
  const title = modal.getByRole("textbox", { name: "标题", exact: true });
  await title.fill("未保存的验收草稿");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(title).toHaveValue("未保存的验收草稿");
  await expect(modal.locator(".inquiry-launcher")).toBeVisible();
  await modal.locator(".inquiry-launcher").focus();
  await page.keyboard.press("Shift+Tab");
  await expect(modal.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(modal.locator(".inquiry-launcher")).toBeFocused();

  const savedTitle = `个人知识弹窗验收 ${randomUUID().slice(0, 8)}`;
  await title.fill(savedTitle);
  await modal.getByRole("textbox", { name: /^正文/u }).fill("验".repeat(2001));
  await modal.getByRole("checkbox", { name: /作为个人通用记忆/u }).check();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const error = modal.getByRole("alert");
    await expect(error).toContainText("2,000 字符");
    const measurements = await Promise.all([
      error.boundingBox(), modal.getByRole("button", { name: "创建知识", exact: true }).boundingBox(),
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
  await modal.getByRole("button", { name: "创建知识", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("2,000 字符");
  expect(creates).toBe(0);
  await modal.getByRole("checkbox", { name: /作为个人通用记忆/u }).uncheck();
  await modal.getByRole("button", { name: "创建知识", exact: true }).click();
  await expect(modalElement).toBeHidden();
  const savedRow = page.getByRole("button").filter({ has: page.getByText(savedTitle, { exact: true }) });
  await expect(savedRow).toBeVisible();
  expect(creates).toBe(1);
  await page.reload();
  await page.getByRole("button").filter({ has: page.getByText(savedTitle, { exact: true }) }).click();
  const detail = page.getByRole("dialog", { name: "个人知识详情", exact: true });
  await expect(detail.getByRole("heading", { name: savedTitle, exact: true })).toBeVisible();
  const providerResponse = await page.request.get("/api/me/ai-providers");
  expect(providerResponse.status()).toBe(200);
  expect(await providerResponse.json()).toHaveProperty("providers");
  await detail.getByRole("button", { name: "编辑", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "编辑知识", exact: true });
  const editElement = page.locator('dialog[aria-labelledby="knowledge-modal-title"]');
  await expect(edit.getByRole("textbox", { name: "标题", exact: true })).toHaveValue(savedTitle);
  const revisedTitle = `${savedTitle} v2`;
  await edit.getByRole("textbox", { name: "标题", exact: true }).fill(revisedTitle);
  await edit.getByRole("button", { name: "保存新版本", exact: true }).click();
  await expect(editElement).toBeHidden();
  await expect(detail.getByRole("heading", { name: revisedTitle, exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "编辑", exact: true }).click();
  await edit.getByRole("textbox", { name: "标题", exact: true }).fill("将被放弃的改动");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "放弃修改并离开", exact: true }).click();
  await expect(editElement).toBeHidden();
  await expect(detail.getByRole("heading", { name: revisedTitle, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  await detail.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "导入文件", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "导入知识", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expectKnowledgeDialogsClosed(page);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  expect(pageErrors).toEqual([]);
  await page.screenshot({ path: "test-results/v110/personal-knowledge-desktop.png" });
});

test("personal vision import defaults to platform and requires page and billing confirmation", async ({ page }) => {
  // These browser fixtures verify the consent interaction; real accounting is
  // covered separately by the runtime-principal PostgreSQL extraction gate.
  const providerId = "6049be4c-aaba-4cd4-a4f3-d72bc660199b";
  let executions = 0;
  await page.route("**/api/personal/knowledge/vision-providers", route => route.fulfill({
    json: {
      providers: [{ id: providerId, name: "平台视觉验收", modelId: "deepseek-flash", billingMode: "platform", quotaMultiplierBps: 15_000, isDefault: true }],
      platformRouteAvailable: true,
    },
  }));
  await page.route("**/api/personal/knowledge/import", route => {
    const body = route.request().postDataBuffer()?.toString("latin1") ?? "";
    const action = /name="action"\r\n\r\n(prepare|execute)/u.exec(body)?.[1];
    if (action === "prepare") return route.fulfill({ json: { confirmation: {
      attemptId: randomUUID(), expiresAt: new Date(Date.now() + 120_000).toISOString(),
      providerName: "平台视觉验收", modelId: "deepseek-flash", pageCount: 1,
      billingMode: "platform", quotaMultiplierBps: 15_000,
      maxOutputTokens: 2_048,
      pages: [{ pageIndex: 1, ordinal: 0, pageNumber: null, locatorLabel: "合成图片 1" }],
    } } });
    if (action === "execute") {
      executions += 1;
      return route.fulfill({ json: { preview: { title: "视觉导入验收", content: "合成图片识别预览，尚未保存。" } } });
    }
    return route.fulfill({ status: 422, json: { error: { code: "PERSONAL_KNOWLEDGE_IMPORT_VISION_REQUIRED" } } });
  });
  await signInR02Admin(page);
  const user = await seedBrowserPersonalUser(`browser-vision-${randomUUID().slice(0, 12)}`, "Test2026");
  await signOutR02User(page);
  await page.getByLabel("用户名或手机号", { exact: true }).fill(user.username);
  await page.getByLabel("密码", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "登 录", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/u);
  await page.goto("/personal/knowledge");
  await expect(page.getByText("还没有个人知识", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "导入文件", exact: true }).click();
  const importing = page.getByRole("dialog", { name: "导入知识", exact: true });
  await expect(importing.getByRole("combobox", { name: "图片及扫描 PDF 识别模型", exact: true })).toHaveValue(providerId);
  const file = {
    name: "synthetic-vision.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT9sAAAAASUVORK5CYII=", "base64"),
  };
  await importing.getByLabel("选择文件", { exact: true }).setInputFiles(file);
  const confirmation = page.getByRole("dialog", { name: "发送图片或扫描页给视觉模型？", exact: true });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("合成图片 1");
  await expect(confirmation).toContainText("deepseek-flash");
  await expect(confirmation).toContainText("1.5×");
  expect(executions).toBe(0);
  await confirmation.getByRole("button", { name: "返回", exact: true }).click();
  await expect(importing).toBeVisible();
  expect(executions).toBe(0);
  await importing.getByLabel("选择文件", { exact: true }).setInputFiles(file);
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "确认发送", exact: true }).click();
  const preview = page.getByRole("dialog", { name: "新建知识", exact: true });
  await expect(preview).toBeVisible();
  await expect(preview.getByRole("textbox", { name: "标题", exact: true })).toHaveValue("视觉导入验收");
  await expect(preview.getByRole("textbox", { name: /^正文/u })).toHaveValue("合成图片识别预览，尚未保存。");
  expect(executions).toBe(1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "放弃修改并离开", exact: true }).click();
  await expectKnowledgeDialogsClosed(page);
});
