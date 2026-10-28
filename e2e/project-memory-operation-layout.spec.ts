import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { getDb } from "@/lib/db";
import { deleteArchivedProject, updateProjectLifecycle } from "@/lib/project-lifecycle";
import { seedBrowserPersonalUser, type BrowserPersonalUser } from "./support/browser-fixtures";
import { signInR02Admin, signInR02PersonalUser, signOutR02User } from "./support/r02-admin-navigation";
import type { WorldPayload } from "@/app/projects/[projectId]/world/project-world-client";

test.setTimeout(120_000);

async function createOwnedProject(page: Page): Promise<{ id: string; name: string }> {
  await page.goto("/projects");
  await page.getByRole("button", { name: "＋ 新建项目", exact: true }).click();
  const name = `Memory layout ${randomUUID().slice(0, 8)}`;
  await page.getByLabel("项目名称", { exact: true }).fill(name);
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name, exact: true }) });
  const href = await card.getByRole("link", { name: `查看项目 ${name}`, exact: true }).getAttribute("href");
  expect(href).toMatch(/^\/projects\/[0-9a-f-]+$/u);
  return { id: href!.slice("/projects/".length), name };
}

async function addSource(page: Page, projectId: string, contentText: string): Promise<void> {
  const result = await page.evaluate(async ({ projectId, contentText }) => fetch(`/api/projects/${projectId}/sources`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contentText }),
  }).then(async (response) => ({ status: response.status, body: await response.json() as unknown })), { projectId, contentText });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
}

async function cleanupProject(projectId: string, owner: BrowserPersonalUser): Promise<void> {
  const db = getDb();
  const account = await db.appUser.findUniqueOrThrow({ where: { id: owner.id }, select: { accountAccessVersion: true } });
  const actor = { id: owner.id, role: "user" as const, accountAccessVersion: account.accountAccessVersion };
  const project = await db.project.findUnique({ where: { id: projectId }, select: { name: true, archivedAt: true, updatedAt: true } });
  if (project === null) return;
  if (project.archivedAt === null) {
    await updateProjectLifecycle({ projectId, actor, action: "archive", expectedUpdatedAt: project.updatedAt }, db);
  }
  const archived = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true, updatedAt: true } });
  await deleteArchivedProject({ projectId, actor, confirmationName: archived.name, expectedUpdatedAt: archived.updatedAt }, db);
}

test("select all project sources, review the complete scope, and keep confirmation beside inquiry", async ({ page }) => {
  await page.setViewportSize({ width: 1265, height: 720 });
  await signInR02Admin(page);
  const owner = await seedBrowserPersonalUser(`browser-memory-layout-${randomUUID().slice(0, 8)}`, "BrowserMemoryLayout2026Password!");
  await signOutR02User(page);
  await signInR02PersonalUser(page, owner);
  const project = await createOwnedProject(page);

  try {
    for (let index = 1; index <= 12; index += 1) {
      await addSource(page, project.id, `Memory layout source ${index}: ${randomUUID()}`);
    }

    const prepared: Array<{ sourceIds: string[] }> = [];
    const executed: Array<{ sourceIds: string[] }> = [];
    await page.route(`**/api/projects/${project.id}/memory/extract`, async (route) => {
      const body = route.request().postDataJSON() as { phase?: string; sourceIds?: string[] };
      if (body.phase === "prepare") {
        prepared.push({ sourceIds: body.sourceIds ?? [] });
        await route.fulfill({ json: { confirmation: {
          challengeId: randomUUID(),
          targetAction: "memoryExtract",
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
          safeSummary: {
            action: "memoryExtract",
            route: { provider: { name: "隔离测试模型" }, model: "mock" },
            scope: { sourceCount: body.sourceIds?.length ?? 0 },
          },
        } } });
        return;
      }
      executed.push({ sourceIds: body.sourceIds ?? [] });
      await route.fulfill({ status: 202, json: { job: { id: randomUUID(), status: "queued" } } });
    });

    await page.goto(`/projects/${project.id}/memory`);
    await expect(page.getByRole("heading", { name: "项目语义索引", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "整理已有资料", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "整理已有项目资料", exact: true });
    await expect(dialog).toBeVisible();

    const header = dialog.locator("[data-operation-header]");
    const close = header.getByRole("button", { name: "关闭窗口", exact: true });
    const [headerBox, closeBox] = await Promise.all([header.boundingBox(), close.boundingBox()]);
    if (headerBox === null || closeBox === null) throw new Error("OPERATION_PANEL_HEADER_BOUNDS_MISSING");
    expect(headerBox.height).toBeGreaterThanOrEqual(72);
    expect(headerBox.height).toBeLessThanOrEqual(74);
    expect(closeBox.width).toBeCloseTo(32, 1);
    expect(closeBox.height).toBeCloseTo(32, 1);
    expect(Math.abs(closeBox.y + closeBox.height / 2 - (headerBox.y + headerBox.height / 2))).toBeLessThanOrEqual(1);
    await expect(header.getByRole("heading", { name: "整理已有项目资料", exact: true })).toHaveCSS("font-size", "16px");

    await dialog.getByRole("button", { name: "全选", exact: true }).click();
    const sources = dialog.getByLabel("可选项目资料", { exact: true });
    await expect(sources.locator("input[type=checkbox]:checked")).toHaveCount(12);
    const prepareButton = dialog.getByRole("button", { name: "读取本次外发摘要", exact: true });
    await expect(prepareButton).toBeInViewport();
    await prepareButton.click();

    const summary = dialog.locator("[data-extract-consent-summary]");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText(project.name);
    await expect(summary).toContainText("整理项目资料");
    await expect(summary).toContainText("隔离测试模型 · mock");
    await expect(summary).toContainText(/12\s*份资料/u);
    await expect(summary).toContainText(/6\s*个批次/u);
    await expect(summary.locator("[data-extract-consent-batch]")).toHaveCount(6);
    await expect(summary.locator("[data-extract-consent-batch]").first()).toContainText("有效期至");
    expect(prepared).toHaveLength(6);
    expect(prepared.every((batch) => batch.sourceIds.length === 2)).toBe(true);
    expect(new Set(prepared.flatMap((batch) => batch.sourceIds)).size).toBe(12);

    const footer = dialog.locator("[data-operation-footer]");
    const confirm = footer.getByRole("button", { name: "确认发送并加入队列", exact: true });
    const inquiry = footer.locator(".inquiry-launcher");
    await expect(confirm).toBeVisible();
    await expect(confirm).toBeInViewport();
    await expect(inquiry).toBeVisible();
    const expectFooterRow = async () => {
      await expect.poll(async () => {
        const [inquiryBox, confirmBox] = await Promise.all([inquiry.boundingBox(), confirm.boundingBox()]);
        return inquiryBox && confirmBox
          ? Math.abs(inquiryBox.y + inquiryBox.height / 2 - confirmBox.y - confirmBox.height / 2)
          : Infinity;
      }, { message: "assistance and confirmation must share the footer row" }).toBeLessThanOrEqual(2);
    };
    await expectFooterRow();
    await dialog.locator("[data-operation-content]").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(confirm).toBeInViewport();
    expect(executed).toHaveLength(0);
    await page.screenshot({ path: "test-results/ui-layout-polish/materials-footer-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(confirm).toBeInViewport();
    await expectFooterRow();
    await page.screenshot({ path: "test-results/ui-layout-polish/materials-footer-mobile.png" });
    await dialog.getByRole("button", { name: "返回选择", exact: true }).click();
    await expect(sources.locator("input[type=checkbox]:checked")).toHaveCount(12);
    await close.click();

    await page.route(`**/api/projects/${project.id}/memory/status`, async route => {
      const response = await route.fetch();
      const payload = await response.json();
      payload.index = {
        ...payload.index,
        readiness: "ready",
        compatible: true,
        route: { source: "platform", modelId: "mock-embedding", embeddingDimensions: 3, providerConnection: { name: "隔离索引模型", status: "active" } },
        activeIndex: { publishedAt: new Date().toISOString(), generation: { id: randomUUID(), status: "complete", buildMode: "full", modelId: "mock-embedding", dimensions: 3, recordCount: 12, inputManifestFingerprint: "0".repeat(64), completedAt: new Date().toISOString(), providerConnection: { name: "隔离索引模型", status: "active" } } },
      };
      await route.fulfill({ response, json: payload });
    });
    await page.route(`**/api/projects/${project.id}/memory/index?mode=*`, route => route.fulfill({ status: 400, json: { error: { code: "MEMORY_INDEX_TOO_LARGE", message: "当前索引输入超过单次安全上限" } } }));
    await page.reload();
    await expect(page.getByRole("link", { name: "索引已就绪，去提问 →", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "更新语义索引", exact: true }).click();
    const maintenance = page.getByRole("dialog", { name: "维护项目语义索引", exact: true });
    await expect(maintenance.getByRole("alert")).toContainText("MEMORY_INDEX_TOO_LARGE");
    await expect(maintenance.getByRole("alert")).toContainText("5,000 个片段或 24 MiB");
    await expect(maintenance.getByRole("button", { name: "读取本次外发摘要", exact: true })).toBeDisabled();
    expect(executed).toHaveLength(0);
    await maintenance.getByRole("button", { name: "关闭窗口", exact: true }).click();
    await page.route(`**/api/projects/${project.id}/world`, async route => {
      const response = await route.fetch();
      const payload = await response.json() as WorldPayload;
      payload.facts = [1, 2].map(index => ({
        id: randomUUID(), type: "progress", reviewStatus: "confirmed", lifecycle: "active",
        title: `审计布局事实 ${index}`, content: `审计布局事实 ${index}`,
        occurredAt: null, confirmedAt: null, validFrom: null, validUntil: null, updatedAt: new Date().toISOString(),
        revision: { id: randomUUID(), number: 2, evidenceManifestFingerprint: "a".repeat(64), createdAt: new Date().toISOString() },
        source: { id: randomUUID(), kind: "manual", externalRef: "隔离布局示例", contentHash: "b".repeat(64), retiredAt: null }, workItems: [],
      }));
      payload.state.counts.activeFacts = 2;
      await route.fulfill({ response, json: payload });
    });
    await page.goto(`/projects/${project.id}/governance`);
    await page.getByRole("button", { name: "状态与审计 →", exact: true }).click();
    const audit = page.getByRole("dialog", { name: "项目状态与审计", exact: true });
    const metrics = audit.getByRole("region", { name: "项目状态指标", exact: true });
    await expect(metrics).toBeVisible();
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const columns = await metrics.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length);
      expect(columns).toBe(width === 390 ? 2 : 3);
      const facts = [audit.getByRole("article").filter({ has: page.getByRole("heading", { name: "审计布局事实 1", exact: true }) }), audit.getByRole("article").filter({ has: page.getByRole("heading", { name: "审计布局事实 2", exact: true }) })];
      const [first, second] = await Promise.all(facts.map(fact => fact.boundingBox()));
      expect(first).not.toBeNull(); expect(second).not.toBeNull();
      expect(first!.x).toBeCloseTo(second!.x, 0);
      await expect(facts[0]!.getByText("审计布局事实 1", { exact: true })).toHaveCount(1);
      await page.screenshot({ path: `test-results/ui-layout-polish/audit-drawer-${width}.png` });
    }
  } finally {
    await cleanupProject(project.id, owner);
  }
});
