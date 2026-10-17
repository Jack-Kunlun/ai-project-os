import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import {
  expectR02NoAccessibilityViolations,
  expectR02NoHorizontalOverflow,
  signInR02Admin,
  signInR02PersonalUser,
} from "./support/r02-admin-navigation";

test.setTimeout(120_000);

type ExtractCall = Readonly<{
  phase: "prepare" | "execute";
  clientKey: string;
  sourceIds: string[];
  challengeId?: string;
}>;

async function projectFixture(page: Page): Promise<{ projectId: string; projectName: string }> {
  await signInR02Admin(page);
  const user = await seedBrowserPersonalUser(`browser-flow-${randomUUID().slice(0, 10)}`, "BrowserFlow2026Password!");
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await signInR02PersonalUser(page, user);
  await page.goto("/projects");
  await page.getByRole("button", { name: "＋ 新建项目" }).click();

  const projectName = `Usage flow ${randomUUID().slice(0, 8)}`;
  await page.getByLabel("项目名称", { exact: true }).fill(projectName);
  await page.getByRole("button", { name: "创建项目", exact: true }).click();

  const card = page.locator("article").filter({ has: page.getByRole("heading", { name: projectName, exact: true }) });
  const href = await card.getByRole("link", { name: "进入项目", exact: true }).getAttribute("href");
  expect(href).toMatch(/^\/projects\/[0-9a-f-]+$/u);
  return { projectId: href!.slice("/projects/".length), projectName };
}

test("personal knowledge hands off explicitly into project materials and guided AI steps", async ({ page }) => {
  const { projectId, projectName } = await projectFixture(page);
  const projectListReads: string[] = [];
  const projectSourcePosts: string[] = [];
  const extractCalls: ExtractCall[] = [];
  const challengeByClientKey = new Map<string, string>();

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/projects" && url.searchParams.get("view") === "active") {
      projectListReads.push(request.url());
    }
    if (request.method() === "POST" && url.pathname === `/api/projects/${projectId}/sources`) {
      projectSourcePosts.push(request.url());
    }
  });

  // These synthetic responses stop at the browser boundary; no model provider is contacted.
  await page.route(`**/api/projects/${projectId}/memory/extract`, async (route) => {
    const body = route.request().postDataJSON() as ExtractCall;
    extractCalls.push(body);
    if (body.phase === "prepare") {
      const challengeId = randomUUID();
      challengeByClientKey.set(body.clientKey, challengeId);
      await route.fulfill({
        json: {
          confirmation: {
            challengeId,
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
            safeSummary: { route: { provider: { name: "隔离浏览器模型夹具" }, model: "fixture" } },
          },
        },
      });
      return;
    }

    expect(body.challengeId).toBe(challengeByClientKey.get(body.clientKey));
    await route.fulfill({
      json: {
        job: {
          id: randomUUID(),
          status: "succeeded",
          result: { confirmedCount: 1, reviewRequiredCount: 0, duplicateCount: 0 },
        },
      },
    });
  });

  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new DOMException("Clipboard denied", "NotAllowedError"); } },
    });
  });

  await page.goto("/personal/knowledge");
  await expect(page.getByRole("heading", { name: "我的内容", exact: true })).toBeVisible();
  expect(projectListReads).toHaveLength(0);

  await page.getByRole("button", { name: "新建内容", exact: true }).click();
  const createDialog = page.getByRole("dialog", { name: "新建个人知识", exact: true });
  const title = `个人流程 ${randomUUID().slice(0, 8)}`;
  const body = `这段个人知识需要手动选择并复制到项目。引用编号 ${randomUUID()}`;
  await createDialog.getByRole("textbox", { name: "标题", exact: true }).fill(title);
  await createDialog.getByRole("textbox", { name: /^正文/u }).fill(body);
  await expect(createDialog.getByRole("checkbox", { name: /作为个人通用记忆/u })).not.toBeChecked();
  await createDialog.getByRole("button", { name: "创建内容", exact: true }).click();

  await expect(createDialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page.locator("#personal-knowledge-content")).toContainText(body);
  await expect(page.locator("#personal-knowledge-next-steps")).toBeInViewport();
  expect(projectListReads).toHaveLength(0);
  expect(projectSourcePosts).toHaveLength(0);
  expect(extractCalls).toHaveLength(0);
  await expectR02NoHorizontalOverflow(page, "personal knowledge detail desktop");
  await expectR02NoAccessibilityViolations(page, "personal knowledge detail desktop");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#personal-knowledge-next-steps")).toBeInViewport();
  await expectR02NoHorizontalOverflow(page, "personal knowledge detail 390px");
  await expectR02NoAccessibilityViolations(page, "personal knowledge detail 390px");
  await page.screenshot({ path: "test-results/usage-flow-guidance/personal-detail-mobile.png" });
  await page.getByRole("button", { name: "放入项目资料", exact: true }).click();

  const handoff = page.getByRole("dialog", { name: "复制到项目资料", exact: true });
  await expect(handoff).toBeVisible();
  await expect.poll(() => projectListReads.length).toBe(1);
  const projectPicker = handoff.getByRole("combobox", { name: "选择目标项目", exact: true });
  await expect(projectPicker).toContainText(projectName);
  await projectPicker.selectOption(projectId);
  await handoff.getByRole("button", { name: "复制正文", exact: true }).click();
  await expect(handoff.getByRole("alert")).toContainText("自动复制失败");
  await expect(handoff.getByLabel("待手动复制的个人知识正文", { exact: true })).toHaveValue(body);
  await expect(handoff.getByRole("status").filter({ hasText: "正文已复制" })).toHaveCount(0);
  const handoffLink = handoff.getByRole("link", { name: "前往项目并粘贴", exact: true });
  const destination = new URL(await handoffLink.getAttribute("href") ?? "", "http://127.0.0.1");
  expect(destination.pathname).toBe(`/projects/${projectId}/materials`);
  expect(destination.searchParams.get("view")).toBe("add");
  expect(destination.searchParams.get("kind")).toBe("manual");
  expect(destination.href).not.toContain(body);

  const personalNavigationState = await page.evaluate(() => ({
    url: window.location.href,
    localStorage: Object.values(window.localStorage).join("\n"),
    sessionStorage: Object.values(window.sessionStorage).join("\n"),
  }));
  expect(personalNavigationState.url).not.toContain(body);
  expect(personalNavigationState.localStorage).not.toContain(body);
  expect(personalNavigationState.sessionStorage).not.toContain(body);
  await expectR02NoHorizontalOverflow(page, "personal project handoff 390px");
  await expectR02NoAccessibilityViolations(page, "personal project handoff 390px");

  await page.screenshot({ path: "test-results/usage-flow-guidance/personal-project-handoff-mobile.png" });
  await handoffLink.click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/materials\\?view=add&kind=manual$`, "u"));
  const intake = page.getByRole("dialog", { name: "添加来源", exact: true });
  await expect(intake).toBeVisible();
  expect(projectSourcePosts).toHaveLength(0);
  expect(extractCalls).toHaveLength(0);
  await expectR02NoHorizontalOverflow(page, "project add source 390px");
  await expectR02NoAccessibilityViolations(page, "project add source 390px");

  await page.screenshot({ path: "test-results/usage-flow-guidance/project-import-mobile.png" });
  await intake.getByPlaceholder("直接输入或粘贴项目资料…", { exact: true }).fill(body);
  const sourceResponsePromise = page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === "POST" && new URL(response.url()).pathname === `/api/projects/${projectId}/sources`;
  });
  await intake.getByRole("button", { name: "加入原始资料", exact: true }).click();
  const sourceResponse = await sourceResponsePromise;
  expect(sourceResponse.ok()).toBe(true);
  const sourcePayload = await sourceResponse.json() as { source: { id: string } };
  const sourceId = sourcePayload.source.id;
  expect(projectSourcePosts).toHaveLength(1);

  const organize = intake.getByRole("button", { name: "确认发送并自动整理", exact: true });
  await expect(organize).toBeVisible();
  await expect(organize).toBeInViewport();
  await expect.poll(() => extractCalls.filter((call) => call.phase === "prepare").length).toBe(1);
  expect(extractCalls[0]?.sourceIds).toEqual([sourceId]);
  expect(extractCalls.filter((call) => call.phase === "execute")).toHaveLength(0);

  await organize.click();
  const nextStep = intake.getByRole("link", { name: "下一步：更新索引并问答", exact: true });
  await expect(nextStep).toBeVisible();
  expect(extractCalls.filter((call) => call.phase === "execute")).toHaveLength(1);
  expect(extractCalls.filter((call) => call.phase === "execute")[0]?.sourceIds).toEqual([sourceId]);
  await nextStep.click();

  await expect.poll(() => new URL(page.url()).searchParams.get("focus")).toBe("memory-index");
  await expect(page.locator("#memory-index")).toBeInViewport();
  const queryPanel = page.locator("#memory-query");
  await expect(queryPanel.getByText(/请先建立或更新索引/u)).toBeVisible();
  await expectR02NoHorizontalOverflow(page, "project memory 390px");
  await expectR02NoAccessibilityViolations(page, "project memory 390px");

  await queryPanel.getByRole("link", { name: "去更新索引 →", exact: true }).click();
  await expect(page).toHaveURL(/#memory-index$/u);
  await expect(page.locator("#memory-index")).toBeInViewport();

  const projectSteps = page.getByRole("navigation", { name: "项目操作步骤", exact: true });
  const addFromGuide = projectSteps.getByRole("link", { name: "添加资料", exact: true });
  await addFromGuide.click();
  await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("add");
  await expect.poll(() => new URL(page.url()).searchParams.get("kind")).toBe("manual");
  await expect(intake).toBeVisible();
  await intake.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(intake).toBeHidden();

  const materialSteps = page.getByRole("navigation", { name: "项目操作步骤", exact: true });
  const searchFromGuide = materialSteps.getByRole("link", { name: "检索与问答", exact: true });
  await expect(searchFromGuide).toHaveAttribute("href", new RegExp(`/projects/${projectId}/memory\\?focus=memory-index`));
  await searchFromGuide.click();
  await expect.poll(() => new URL(page.url()).searchParams.get("focus")).toBe("memory-index");
  await expect(page.locator("#memory-index")).toBeInViewport();

  await page.getByRole("link", { name: "项目资料", exact: true }).click();
  await page.locator(`#source-link-${sourceId}`).click();
  await expect(page.getByRole("heading", { name: "项目资料详情", exact: true })).toBeVisible();
  await expect(page.locator("main")).toContainText(body);
  const executeCountBeforeDetail = extractCalls.filter((call) => call.phase === "execute").length;
  await expectR02NoHorizontalOverflow(page, "project source detail 390px");
  await expectR02NoAccessibilityViolations(page, "project source detail 390px");

  await page.getByRole("button", { name: "继续 AI 整理", exact: true }).click();
  const sourceOrganizer = page.getByRole("dialog", { name: "整理这份资料", exact: true });
  await expect(sourceOrganizer).toBeVisible();
  await expect(sourceOrganizer.getByRole("button", { name: "确认发送并自动整理", exact: true })).toBeVisible();
  await expect.poll(() => extractCalls.filter((call) => call.phase === "prepare").length).toBe(2);
  expect(extractCalls.filter((call) => call.phase === "prepare")[1]?.sourceIds).toEqual([sourceId]);
  expect(extractCalls.filter((call) => call.phase === "execute")).toHaveLength(executeCountBeforeDetail);
  await expectR02NoHorizontalOverflow(page, "source organize dialog 390px");
  await expectR02NoAccessibilityViolations(page, "source organize dialog 390px");
});
