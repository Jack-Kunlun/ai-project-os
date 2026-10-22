import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import {
  expectR02NoAccessibilityViolations,
  expectR02NoHorizontalOverflow,
  signInR02Admin,
  signInR02PersonalUser,
  signOutR02User,
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
  await signOutR02User(page);
  await signInR02PersonalUser(page, user);
  await page.goto("/projects");
  await page.getByRole("button", { name: "＋ 新建项目" }).click();

  const projectName = `Usage flow ${randomUUID().slice(0, 8)}`;
  await page.getByLabel("项目名称", { exact: true }).fill(projectName);
  await page.getByRole("button", { name: "创建项目", exact: true }).click();

  const card = page.locator("article").filter({ has: page.getByRole("heading", { name: projectName, exact: true }) });
  const href = await card.getByRole("link", { name: `查看项目 ${projectName}`, exact: true }).getAttribute("href");
  expect(href).toMatch(/^\/projects\/[0-9a-f-]+$/u);
  return { projectId: href!.slice("/projects/".length), projectName };
}

test("personal knowledge hands off explicitly into project materials and guided AI steps", async ({ page }) => {
  const { projectId, projectName } = await projectFixture(page);
  const projectListReads: string[] = [];
  const projectSourcePosts: string[] = [];
  const questionPosts: string[] = [];
  const extractCalls: ExtractCall[] = [];
  const challengeByClientKey = new Map<string, string>();
  const completedJobs = new Map<string, { id: string; status: string; result: { confirmedCount: number; reviewRequiredCount: number; duplicateCount: number } }>();

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/projects" && url.searchParams.get("view") === "active") {
      projectListReads.push(request.url());
    }
    if (request.method() === "POST" && url.pathname === `/api/projects/${projectId}/sources`) {
      projectSourcePosts.push(request.url());
    }
    if (request.method() === "POST" && /^\/api\/ask(?:\/|$)/u.test(url.pathname)) questionPosts.push(request.url());
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
    const jobId = randomUUID();
    completedJobs.set(jobId, { id: jobId, status: "succeeded", result: { confirmedCount: 1, reviewRequiredCount: 0, duplicateCount: 0 } });
    await route.fulfill({
      status: 202,
      json: {
        job: {
          id: jobId,
          status: "queued",
          result: null,
        },
      },
    });
  });
  await page.route(`**/api/projects/${projectId}/jobs?*`, (route) => {
    const ids = new URL(route.request().url()).searchParams.get("ids")?.split(",") ?? [];
    return route.fulfill({ json: { jobs: ids.flatMap((id) => completedJobs.has(id) ? [completedJobs.get(id)!] : []) } });
  });

  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new DOMException("Clipboard denied", "NotAllowedError"); } },
    });
  });

  await page.goto("/personal/knowledge");
  await expect(page.getByRole("heading", { name: "我的知识", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "切换当前项目", exact: true })).toContainText(projectName);
  const shellProjectListReads = projectListReads.length;
  expect(shellProjectListReads).toBeGreaterThan(0);

  await page.getByRole("button", { name: "新建知识", exact: true }).first().click();
  const createDialog = page.getByRole("dialog", { name: "新建知识", exact: true });
  const createDialogElement = page.locator('dialog[aria-labelledby="knowledge-modal-title"]');
  const title = `个人流程 ${randomUUID().slice(0, 8)}`;
  const body = `这段个人知识需要手动选择并复制到项目。引用编号 ${randomUUID()}`;
  await createDialog.getByRole("textbox", { name: "标题", exact: true }).fill(title);
  await createDialog.getByRole("textbox", { name: /^正文/u }).fill(body);
  await expect(createDialog.getByRole("checkbox", { name: /作为个人通用记忆/u })).not.toBeChecked();
  const projectListReadsBeforeCreate = projectListReads.length;
  await createDialog.getByRole("button", { name: "创建知识", exact: true }).click();

  await expect(createDialogElement).toBeHidden();
  await page.getByRole("button", { name: new RegExp(`^${title} `, "u") }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page.locator("#personal-knowledge-content")).toContainText(body);
  await expect(page.getByRole("region", { name: "知识操作", exact: true })).toBeInViewport();
  expect(projectListReads).toHaveLength(projectListReadsBeforeCreate);
  expect(projectSourcePosts).toHaveLength(0);
  expect(extractCalls).toHaveLength(0);
  await expectR02NoHorizontalOverflow(page, "personal knowledge detail desktop");
  await expectR02NoAccessibilityViolations(page, "personal knowledge detail desktop");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("region", { name: "知识操作", exact: true })).toBeInViewport();
  await expectR02NoHorizontalOverflow(page, "personal knowledge detail 390px");
  await expectR02NoAccessibilityViolations(page, "personal knowledge detail 390px");
  await page.screenshot({ path: "test-results/usage-flow-guidance/personal-detail-mobile.png" });
  const projectListReadsBeforeHandoff = projectListReads.length;
  await page.getByRole("button", { name: "放入项目资料", exact: true }).click();

  const handoff = page.getByRole("dialog", { name: "复制到项目资料", exact: true });
  await expect(handoff).toBeVisible();
  await expect.poll(() => projectListReads.length).toBe(projectListReadsBeforeHandoff + 1);
  await page.keyboard.press("Escape");
  await expect(handoff).toBeHidden();
  await expect(page.getByRole("dialog", { name: "个人知识详情", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "放入项目资料", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "放入项目资料", exact: true }).click();
  await expect(handoff).toBeVisible();
  await expect.poll(() => projectListReads.length).toBe(projectListReadsBeforeHandoff + 2);
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
  const intake = page.getByRole("dialog", { name: "添加资料", exact: true });
  await expect(intake).toBeVisible();
  expect(projectSourcePosts).toHaveLength(0);
  expect(extractCalls).toHaveLength(0);
  await expectR02NoHorizontalOverflow(page, "project add source 390px");
  const inquiryLauncher = intake.getByRole("button", { name: "智能问答", exact: true });
  await expect(inquiryLauncher).toBeVisible();
  const launcherBounds = await inquiryLauncher.boundingBox();
  const closeBounds = await intake.getByRole("button", { name: "关闭窗口", exact: true }).boundingBox();
  expect(launcherBounds).not.toBeNull();
  expect(closeBounds).not.toBeNull();
  const footer = intake.locator("[data-inquiry-footer]");
  await expect(footer).toBeVisible();
  await expect(intake.locator("[data-operation-header] .inquiry-launcher")).toHaveCount(0);
  const footerBounds = await footer.boundingBox();
  expect(launcherBounds!.y).toBeGreaterThanOrEqual(footerBounds!.y);
  expect(launcherBounds!.y + launcherBounds!.height).toBeLessThanOrEqual(footerBounds!.y + footerBounds!.height);
  expect(launcherBounds!.y).toBeGreaterThan(closeBounds!.y + closeBounds!.height);
  expect(launcherBounds!.height).toBeLessThanOrEqual(44);
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

  const organize = intake.getByRole("button", { name: "确认发送并加入队列", exact: true });
  await expect(organize).toBeVisible();
  await expect(organize).toBeInViewport();
  await expect.poll(() => extractCalls.filter((call) => call.phase === "prepare").length).toBe(1);
  expect(extractCalls[0]?.sourceIds).toEqual([sourceId]);
  expect(extractCalls.filter((call) => call.phase === "execute")).toHaveLength(0);

  await organize.click();
  const nextStep = intake.getByRole("link", { name: "打开智能问答", exact: true });
  await expect(nextStep).toBeVisible();
  await expect(nextStep).toHaveAttribute("href", `/ask?scope=project&projectId=${projectId}`);
  expect(extractCalls.filter((call) => call.phase === "execute")).toHaveLength(1);
  expect(extractCalls.filter((call) => call.phase === "execute")[0]?.sourceIds).toEqual([sourceId]);
  await intake.getByRole("button", { name: "关闭窗口", exact: true }).click();
  const stableHeading = page.locator("main h1");
  await expect(stableHeading).toHaveText("项目资料");
  await expect(stableHeading).toHaveAttribute("aria-label", `${projectName} · 项目资料`);
  const columns = page.getByRole("navigation", { name: "项目资料栏目", exact: true });
  await expect(columns.getByRole("link")).toHaveText(["资料", "整理结果", "识别任务"]);
  await expect(intake).toHaveCount(0);
  await expectR02NoHorizontalOverflow(page, "project materials 390px");
  await expectR02NoAccessibilityViolations(page, "project materials 390px");
  await columns.getByRole("link", { name: "资料", exact: true }).click();
  await expect(page.getByRole("heading", { name: "资料来源", exact: true })).toBeVisible();
  await expect(stableHeading).toBeVisible();
  await expect(intake).toHaveCount(0);
  const addButton = page.getByRole("button", { name: "添加资料", exact: true });
  await addButton.click();
  await expect(intake).toBeVisible();
  await intake.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await expect(intake).toBeHidden();
  await expect(addButton).toBeFocused();
  await columns.getByRole("link", { name: "整理结果", exact: true }).click();
  await expect(stableHeading).toBeVisible();
  await expect(page.getByRole("heading", { name: "待核对内容", exact: true })).toBeVisible();
  await expect(intake).toHaveCount(0);
  expect(extractCalls.filter((call) => call.phase === "execute")).toHaveLength(1);
  await columns.getByRole("link", { name: "资料", exact: true }).click();
  await page.locator(`#source-link-${sourceId}`).click();
  await expect(page.getByRole("heading", { name: "项目资料详情", exact: true })).toBeVisible();
  await expect(page.locator("main")).toContainText(body);
  await expect(page.getByRole("link", { name: "智能问答 →", exact: true })).toHaveCount(0);
  const executeCountBeforeDetail = extractCalls.filter((call) => call.phase === "execute").length;
  const detailInquiryLauncher = page.locator(".inquiry-launcher");
  await expect(detailInquiryLauncher).toHaveCount(1);
  await detailInquiryLauncher.click();
  const detailInquiry = page.getByRole("dialog", { name: "智能问答悬浮窗", exact: true });
  await expect(detailInquiry).toBeVisible();
  await detailInquiry.getByRole("combobox", { name: "智能问答内容范围", exact: true }).selectOption("project");
  const questionProject = detailInquiry.getByRole("combobox", { name: "选择智能问答项目", exact: true });
  await questionProject.selectOption(projectId);
  await expect(questionProject).toHaveValue(projectId);
  await detailInquiry.getByRole("button", { name: "收起问答", exact: true }).click();
  await expect(detailInquiry).toBeHidden();
  await expect(detailInquiryLauncher).toBeFocused();
  expect(questionPosts, "opening, selecting a scope and closing Ask never sends a question").toEqual([]);
  expect(extractCalls.filter((call) => call.phase === "execute")).toHaveLength(executeCountBeforeDetail);
  await expectR02NoHorizontalOverflow(page, "project source detail 390px");
  await expectR02NoAccessibilityViolations(page, "project source detail 390px");

  await page.getByRole("button", { name: "继续 AI 整理", exact: true }).click();
  const sourceOrganizer = page.getByRole("dialog", { name: "整理这份资料", exact: true });
  await expect(sourceOrganizer).toBeVisible();
  await expect(sourceOrganizer.getByRole("button", { name: "确认发送并加入队列", exact: true })).toBeVisible();
  await expect.poll(() => extractCalls.filter((call) => call.phase === "prepare").length).toBe(2);
  expect(extractCalls.filter((call) => call.phase === "prepare")[1]?.sourceIds).toEqual([sourceId]);
  expect(extractCalls.filter((call) => call.phase === "execute")).toHaveLength(executeCountBeforeDetail);
  await expectR02NoHorizontalOverflow(page, "source organize dialog 390px");
  await expectR02NoAccessibilityViolations(page, "source organize dialog 390px");
  await page.goto(`/projects/${projectId}/materials?view=ask`);
  await expect(page).toHaveURL(`/ask?scope=project&projectId=${projectId}`);
});

test("legacy memory questions prepare stale material and require separate confirmation before every model send", async ({ page }) => {
  const { projectId } = await projectFixture(page);
  const sourceText = `Synthetic project delivery evidence ${randomUUID()}`;
  const sourceResponse = await page.request.post(`/api/projects/${projectId}/sources`, {
    headers: { origin: new URL(page.url()).origin },
    data: { contentText: sourceText },
  });
  expect(sourceResponse.status()).toBe(201);
  const sourceId = (await sourceResponse.json()).source.id as string;
  const generationId = randomUUID();
  let ready = false;
  const answers: unknown[] = [];
  const calls: { endpoint: string; phase: string; question?: string }[] = [];
  const confirmations = new Map<string, string>();
  const planFingerprint = "a".repeat(64);
  const index = () => ({
    activeIndex: ready ? { publishedAt: new Date().toISOString(), generation: { id: generationId, status: "complete", buildMode: "full", modelId: "fixture-embedding", dimensions: 8, recordCount: 1, inputManifestFingerprint: planFingerprint, completedAt: new Date().toISOString(), providerConnection: { name: "浏览器隔离向量模型" } } } : null,
    latestJob: null, compatible: ready, readiness: ready ? "ready" : "indexMissing",
    inputs: { projectSourceCount: 1, hasCodeSnapshot: false, repositoryMaterialGenerationCount: 0, manifestFingerprint: planFingerprint },
    route: { source: "platform_default", modelId: "fixture-embedding", embeddingDimensions: 8, providerConnection: { name: "浏览器隔离向量模型", status: "verified" } },
  });
  // Browser interaction fixture only. No provider or production endpoint is called.
  await page.route(`**/api/projects/${projectId}/memory/status`, (route) => route.fulfill({ json: { index: index(), sources: [], candidates: [], answers } }));
  await page.route(`**/api/projects/${projectId}/memory/index?*`, (route) => route.fulfill({ json: { plan: { planFingerprint, mode: "full", providerName: "浏览器隔离向量模型", modelId: "fixture-embedding", expectedInputCount: 1, generateCount: 1, reuseCount: 0, deleteCount: 0, deadlineEligible: true, ineligibleCode: null } } }));
  for (const endpoint of ["index", "answers"]) {
    await page.route(`**/api/projects/${projectId}/memory/${endpoint}`, async (route) => {
      const body = route.request().postDataJSON() as { phase: string; clientKey: string; challengeId?: string; question?: string };
      calls.push({ endpoint, phase: body.phase, question: body.question });
      if (body.phase === "prepare") {
        const challengeId = randomUUID(); confirmations.set(body.clientKey, challengeId);
        await route.fulfill({ json: { confirmation: { challengeId, targetAction: endpoint === "index" ? "memoryIndex" : "memoryAnswer", expiresAt: new Date(Date.now() + 120_000).toISOString(), safeSummary: { route: endpoint === "index" ? { provider: { name: "浏览器隔离向量模型" }, model: "fixture-embedding" } : { generation: { provider: { name: "浏览器隔离生成模型" }, model: "fixture-generation" } }, scope: { inputCount: 1, personalDefaultCount: 0 } } } } });
      } else {
        expect(body.challengeId).toBe(confirmations.get(body.clientKey));
        if (endpoint === "index") ready = true;
        else answers.push({ id: randomUUID(), question: body.question, answer: `引用资料：${sourceText}`, citations: [{ id: sourceId, scope: "projectSource", path: null, excerpt: sourceText }], providerConnection: { name: "浏览器隔离生成模型" }, modelId: "fixture-generation", createdAt: new Date().toISOString() });
        await route.fulfill({ json: { job: { id: randomUUID(), status: "succeeded", result: { indexGenerationId: generationId } } } });
      }
    });
  }
  await page.goto(`/projects/${projectId}/memory?view=ask`);
  const heading = page.getByRole("heading", { name: "问项目", exact: true });
  await expect(heading).toBeVisible();
  const question = page.getByRole("textbox", { name: "你想了解什么？", exact: true });
  await question.fill("本次交付范围是什么？");
  await page.getByRole("button", { name: "提问", exact: true }).click();
  await expect(page.getByRole("heading", { name: "先准备项目资料", exact: true })).toBeVisible();
  expect(calls.filter((call) => call.phase === "execute")).toHaveLength(0);
  await question.fill("交付资料的依据是什么？");
  await expect(page.getByRole("region", { name: "确认本次发送", exact: true })).toHaveCount(0);
  expect(calls.filter((call) => call.phase === "execute")).toHaveLength(0);
  await page.getByRole("button", { name: "提问", exact: true }).click();
  await page.getByRole("button", { name: "确认并准备资料", exact: true }).click();
  await expect(page.getByRole("heading", { name: "确认本次提问", exact: true })).toBeVisible();
  expect(calls.filter((call) => call.endpoint === "index" && call.phase === "execute")).toHaveLength(1);
  expect(calls.filter((call) => call.endpoint === "answers" && call.phase === "execute")).toHaveLength(0);
  await expect(heading).toBeVisible();
  await expect(page.getByRole("dialog", { name: "添加资料", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "确认提问", exact: true }).click();
  await expect(page.getByText(`引用资料：${sourceText}`, { exact: true })).toBeVisible();
  expect(calls.filter((call) => call.endpoint === "answers" && call.phase === "execute")).toHaveLength(1);
  await page.getByText("引用原文 1", { exact: true }).click();
  await expect(page.locator("blockquote").filter({ hasText: sourceText })).toBeVisible();
  await page.reload();
  await expect(page.getByText(`引用资料：${sourceText}`, { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectR02NoHorizontalOverflow(page, "project question preparation 390px");
  await expectR02NoAccessibilityViolations(page, "project question preparation 390px");
  await page.screenshot({ path: "test-results/usage-flow-guidance/project-question-inline-mobile.png" });
});

test("processing tasks preserve background state and only offer safe cancellation", async ({ page }) => {
  const { projectId } = await projectFixture(page);
  const queuedId = randomUUID();
  const runningId = randomUUID();
  const finishedId = randomUUID();
  const jobs = [
    { id: queuedId, kind: "autoExtract", status: "queued", stage: "worker_queued", canCancel: true, inputSummary: { sourceCount: 2, sourceLabels: ["青禾交付说明", "青禾会议记录"] }, createdAt: "2026-10-17T12:00:00Z", progressCurrent: 0, progressTotal: 2, result: null },
    { id: runningId, kind: "assetExtract", status: "running", stage: "recognizing", canCancel: false, inputSummary: { displayName: "交付草图", fileName: "交付草图.png" }, createdAt: "2026-10-17T12:01:00Z", progressCurrent: 1, progressTotal: 3, result: null },
    { id: finishedId, kind: "autoExtract", status: "succeeded", stage: "succeeded", canCancel: false, inputSummary: { sourceCount: 1, sourceLabels: ["青禾历史约定"] }, createdAt: "2026-10-17T11:00:00Z", progressCurrent: 2, progressTotal: 2, result: { confirmedCount: 1, reviewRequiredCount: 1, duplicateCount: 0 } },
    { id: randomUUID(), kind: "autoExtract", status: "unknown", stage: "unknown", failureCode: "AI_PROVIDER_INVALID_RESPONSE", reconciliationRequired: true, canCancel: false, inputSummary: { sourceCount: 7, sourceLabels: ["未收口资料"] }, createdAt: "2026-10-17T12:02:00Z", progressCurrent: 0, progressTotal: 7, result: null },
    { id: randomUUID(), kind: "autoExtract", status: "unknown", stage: "reconciled_unknown", failureCode: "AI_PROVIDER_INVALID_RESPONSE", reconciliationRequired: false, canCancel: false, inputSummary: { sourceCount: 7, sourceLabels: ["已收口资料"] }, createdAt: "2026-10-17T12:03:00Z", progressCurrent: 0, progressTotal: 7, result: null },
  ];
  const cancellations: string[] = [];
  // UI fixture only; queue admission, dispatch fences and cancellation are covered by PostgreSQL gates.
  await page.route(`**/api/projects/${projectId}/jobs`, (route) => route.fulfill({ json: { jobs } }));
  await page.route(`**/api/projects/${projectId}/jobs/${queuedId}`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({ action: "cancel" });
    cancellations.push(queuedId);
    Object.assign(jobs[0]!, { status: "cancelled", stage: "cancelled", canCancel: false });
    await route.fulfill({ json: { job: jobs[0] } });
  });
  await page.goto(`/projects/${projectId}/materials?view=tasks`);
  await expect(page.locator("main h1")).toHaveText("项目资料");
  const tasks = page.locator('section[aria-labelledby="project-processing-tasks-title"]');
  await expect(tasks.getByRole("heading", { name: "识别任务", exact: true })).toBeVisible();
  await expect(tasks.getByRole("article")).toHaveCount(5);
  await expect(tasks.getByRole("article").filter({ hasText: "青禾交付说明" }).getByRole("button", { name: "取消任务", exact: true })).toBeVisible();
  await expect(tasks.getByRole("article").filter({ hasText: "青禾历史约定" }).getByRole("button", { name: "取消任务", exact: true })).toHaveCount(0);
  await expect(tasks.getByText(/创建于/u)).toHaveCount(5);
  await expect(tasks.getByRole("button", { name: "取消任务", exact: true })).toHaveCount(1);
  await expect(tasks.getByText("1/3（33%）", { exact: true })).toBeVisible();
  await expect(tasks.getByRole("link", { name: "查看整理结果", exact: true })).toHaveAttribute("href", `/projects/${projectId}/materials?view=review&from=materials`);
  for (const name of ["未收口资料", "已收口资料"]) {
    const abnormal = tasks.getByRole("article").filter({ hasText: name });
    await expect(abnormal.getByText(/抽取未完成/u)).toBeVisible();
    await expect(abnormal.getByText(/模型响应未通过校验/u)).toBeVisible();
    await expect(abnormal.getByRole("button", { name: "取消任务", exact: true })).toHaveCount(0);
    await expect(abnormal.getByRole("link", { name: "查看整理结果", exact: true })).toHaveCount(0);
  }
  await expect(tasks.getByRole("article").filter({ hasText: "未收口资料" }).getByText(/仍需核对/u)).toBeVisible();
  const closed = tasks.getByRole("article").filter({ hasText: "已收口资料" });
  await expect(closed.getByText(/已人工收口，无须再确认任务状态/u)).toBeVisible();
  await expect(closed.getByText(/仍需核对|后台处理中/u)).toHaveCount(0);
  await tasks.getByRole("button", { name: "取消任务", exact: true }).click();
  await expect(tasks.getByText("任务已取消，尚未发送的请求不会继续执行。", { exact: true })).toBeVisible();
  expect(cancellations).toEqual([queuedId]);
  await expect(tasks.getByRole("button", { name: "取消任务", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(tasks.getByText("任务已取消，原始资料仍保留。", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(tasks.getByText("1/3（33%）", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "添加资料", exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectR02NoHorizontalOverflow(page, "processing task queue 390px");
  await expectR02NoAccessibilityViolations(page, "processing task queue 390px");
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([
    { name: "aipos-language", value: "en", url: origin },
    { name: "aipos-theme", value: "dark", url: origin },
  ]);
  await page.reload();
  await expect(tasks.getByText("Facts created: 1 · To review: 1 · Duplicates: 0", { exact: true })).toBeVisible();
  await expect(tasks.getByText("The model response failed validation, so this extraction did not complete. (AI_PROVIDER_INVALID_RESPONSE)", { exact: true })).toHaveCount(2);
  await expect(tasks.getByText("1/3 (33%)", { exact: true })).toBeVisible();
  await expect(tasks.getByText(/^The task record has been manually reconciled\./u)).toBeVisible();
  await expectR02NoHorizontalOverflow(page, "processing task queue English dark 390px");
});


test("invalid extraction detail separates incomplete output from open and closed call records", async ({ page }) => {
  const { projectId, projectName } = await projectFixture(page);
  const job = {
    id: randomUUID(), projectId, kind: "autoExtract", status: "unknown", stage: "unknown",
    failureCode: "AI_PROVIDER_INVALID_RESPONSE", reconciliationRequired: true,
    result: null, progressCurrent: 0, progressTotal: 7,
    createdAt: "2026-10-17T13:54:59Z", startedAt: "2026-10-17T13:54:59Z", completedAt: "2026-10-17T13:55:08Z",
    attempts: [{ id: randomUUID(), attemptNumber: 1, status: "unknown", leasedAt: "2026-10-17T13:54:59Z", leaseExpiresAt: "2026-10-17T13:55:59Z", heartbeatAt: "2026-10-17T13:55:08Z", dispatchState: "dispatched", safeFailureCode: "AI_PROVIDER_INVALID_RESPONSE", completedAt: "2026-10-17T13:55:08Z" }],
  };
  // UI projection fixture only: no provider call, reconciliation or quota mutation is made.
  const writes: string[] = [];
  await page.route(`**/api/projects/${projectId}/jobs/${job.id}`, async (route) => {
    if (route.request().method() !== "GET") writes.push(route.request().method());
    await route.fulfill({ json: { job } });
  });
  await page.goto(`/projects/${projectId}/jobs/${job.id}`);
  const state = page.locator("section").filter({ has: page.getByText("当前状态", { exact: true }) });
  await expect(state.getByText("抽取未完成", { exact: true })).toHaveCount(2);
  await expect(state.getByText(/模型响应未通过校验/u)).toBeVisible();
  await expect(state.getByText(/外部调用记录仍需核对/u)).toBeVisible();
  await expect(page.getByText(/本任务没有完整的抽取结果可供确认。可能已有部分候选保存/u)).toBeVisible();
  await expect(page.getByText("结果待确认", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "进入候选审核 →", exact: true })).toHaveCount(0);
  await page.screenshot({ path: "test-results/job-outcome/extraction-open-1440.png", fullPage: true });

  Object.assign(job, { stage: "reconciled_unknown", reconciliationRequired: false });
  await page.reload();
  await expect(state.getByText("执行阶段：任务记录已收口", { exact: true })).toBeVisible();
  await expect(state.getByText(/已人工收口，无须再确认任务状态/u)).toBeVisible();
  await expect(state.getByText(/仍需核对|需要到/u)).toHaveCount(0);
  await expect(state.getByText("抽取未完成", { exact: true })).toHaveCount(2);
  await page.screenshot({ path: "test-results/job-outcome/extraction-closed-1440.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectR02NoHorizontalOverflow(page, "incomplete extraction 390px");
  await expectR02NoAccessibilityViolations(page, "incomplete extraction 390px");
  await page.screenshot({ path: "test-results/job-outcome/extraction-closed-390.png", fullPage: true });

  Object.assign(job, { status: "failed", stage: "failed", failureCode: "AUTO_EXTRACT_OUTPUT_TRUNCATED" });
  Object.assign(job.attempts[0]!, { status: "failed", safeFailureCode: "AUTO_EXTRACT_OUTPUT_TRUNCATED" });
  await page.reload();
  await expect(state.getByText("模型输出达到长度上限，未得到完整的抽取结果。", { exact: true })).toBeVisible();
  await expect(state.getByText(/缩短资料或减少单次整理范围.*重新确认并发起整理/u)).toBeVisible();
  await expect(state.getByText(/任务记录已人工收口/u)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "进入候选审核 →", exact: true })).toHaveCount(0);
  Object.assign(job, { status: "unknown", stage: "reconciled_unknown", failureCode: "AI_PROVIDER_INVALID_RESPONSE" });
  Object.assign(job.attempts[0]!, { status: "unknown", safeFailureCode: "AI_PROVIDER_INVALID_RESPONSE" });

  await page.route(`**/api/projects/${projectId}/governance/operations?*`, (route) => route.fulfill({
    json: { items: [
      { ...job, capability: { action: null, reason: "alreadyReconciled" }, destination: `/projects/${projectId}/jobs/${job.id}`, githubSync: null },
      { ...job, id: randomUUID(), kind: "githubProjectSync", failureCode: "RECONCILIATION_REQUIRED", capability: { action: null, reason: "specializedReconciliationRequired" }, destination: `/projects/${projectId}/repositories`, githubSync: { id: randomUUID(), status: "partial", warnings: [], failureCode: null, counts: { added: 1, updated: 0, deleted: 0, withheld: 1 } } },
    ], nextCursor: null },
  }));
  await page.goto(`/projects/${projectId}?focus=task-runs`);
  const runs = page.locator("#task-runs");
  await expect(runs.getByText("抽取未完成", { exact: true })).toBeVisible();
  await expect(runs.getByText(/任务记录已人工收口，无须再确认任务状态/u)).toBeVisible();
  await expect(runs.getByText(/抽取未正常完成。任务记录已人工收口/u)).toBeVisible();
  await expect(runs.getByText(/reconciled_unknown/u)).toHaveCount(0);
  await expect(runs.getByRole("button", { name: "人工收口", exact: true })).toHaveCount(0);
  await expect(runs.getByRole("link", { name: "查看详情", exact: true })).toHaveCount(2);
  await expect(runs.getByText("部分完成", { exact: true })).toBeVisible();
  await expect(runs.getByText(/该旧式 GitHub 任务仍有子运行阻塞/u)).toBeVisible();
  await expectR02NoHorizontalOverflow(page, "incomplete extraction task runs 390px");

  await page.route(/\/api\/dashboard(?:\?.*)?$/u, async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.recentJobs = [{ ...job, project: { id: projectId, name: projectName } }];
    await route.fulfill({ response, json: payload });
  });
  await page.goto("/dashboard");
  await expect(page.getByText("自动抽取 · 抽取未完成", { exact: true })).toBeVisible();
  await expect(page.getByText("自动抽取结果待确认", { exact: true })).toHaveCount(0);
  await expectR02NoHorizontalOverflow(page, "incomplete extraction dashboard 390px");
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([
    { name: "aipos-language", value: "en", url: origin },
    { name: "aipos-theme", value: "dark", url: origin },
  ]);
  await page.goto(`/projects/${projectId}/jobs/${job.id}`);
  await expect(page.getByText("The model response failed validation, so this extraction did not complete.", { exact: true })).toBeVisible();
  await expect(page.getByText(/^The task record has been manually reconciled\./u)).toBeVisible();
  await expect(page.getByText(/^This task has no complete extraction result to confirm\./u)).toBeVisible();
  await expectR02NoHorizontalOverflow(page, "incomplete extraction English dark 390px");
  await page.goto(`/projects/${projectId}/governance?tab=usage`);
  await expect(page.getByText(/The model response failed validation, so this extraction did not complete\./u)).toBeVisible();
  await expect(page.getByText(/The task record has been manually reconciled\./u)).toBeVisible();
  await expect(page.getByText(/complete\. The task record has been manually reconciled\./u)).toBeVisible();
  await expectR02NoHorizontalOverflow(page, "incomplete extraction compatible governance English dark 390px");
  expect(writes).toEqual([]);
});
