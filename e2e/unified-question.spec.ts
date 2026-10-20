import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { expectR02NoAccessibilityViolations, expectR02NoHorizontalOverflow, signInR02Admin, signInR02PersonalUser, signOutR02User } from "./support/r02-admin-navigation";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";

type SourcePreview = Readonly<{
  id: string;
  scope: "personal" | "project";
  projectId?: string;
  sourceId: string;
  revision: string;
  contentHash: string;
  title: string;
  excerpt: string;
}>;

type CitationSnapshot = SourcePreview & Readonly<{
  id: string;
  version?: number;
  content: string;
}>;

type AskTurnFixture = Readonly<{
  id: string;
  sequence: number;
  scope: "personal" | "project";
  projectId?: string;
  contextName: string;
  question: string;
  answer: string;
  modelId: string;
  providerName: string;
  createdAt: string;
  citations: readonly CitationSnapshot[];
}>;

type AskConversationFixture = Readonly<{
  id: string;
  title: string;
  turns: readonly AskTurnFixture[];
  lastTurnId: string | null;
}>;

async function personalCitation(page: Page, documentId: string): Promise<CitationSnapshot> {
  const [directoryResponse, detailResponse] = await Promise.all([
    page.request.get(`/api/ask/sources?scope=personal&focusDocumentId=${encodeURIComponent(documentId)}`),
    page.request.get(`/api/personal/knowledge/${encodeURIComponent(documentId)}`),
  ]);
  expect(directoryResponse.status()).toBe(200);
  expect(detailResponse.status()).toBe(200);
  const directory = await directoryResponse.json() as { sources: SourcePreview[] };
  const source = directory.sources.find((candidate) => candidate.sourceId === documentId);
  if (!source) throw new Error("The real personal source is missing from the Ask directory.");
  const detail = await detailResponse.json() as { document: { content: string; version: number; contentHash: string } };
  expect(detail.document.contentHash).toBe(source.contentHash);
  return { ...source, id: "s1", version: detail.document.version, content: detail.document.content };
}

async function projectCitation(page: Page, projectId: string, sourceId: string): Promise<CitationSnapshot> {
  const [directoryResponse, detailResponse] = await Promise.all([
    page.request.get(`/api/ask/sources?scope=project&projectId=${encodeURIComponent(projectId)}`),
    page.request.get(`/api/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}`),
  ]);
  expect(directoryResponse.status()).toBe(200);
  expect(detailResponse.status()).toBe(200);
  const directory = await directoryResponse.json() as { sources: SourcePreview[] };
  const source = directory.sources.find((candidate) => candidate.sourceId === sourceId);
  if (!source) throw new Error("The real project source is missing from the Ask directory.");
  const detail = await detailResponse.json() as { source: { contentText: string; contentHash: string } };
  expect(detail.source.contentHash).toBe(source.contentHash);
  return { ...source, id: "s1", content: detail.source.contentText };
}

async function expectCitationDrawer(
  page: Page,
  turnNumber: number,
  citation: CitationSnapshot,
  content: string,
): Promise<void> {
  const versionLabel = citation.version === undefined ? "当时版本" : `v${citation.version}`;
  const turn = page.getByRole("article", { name: `第 ${turnNumber} 轮`, exact: true });
  await turn.getByRole("button", { name: `[1] ${citation.title} · ${versionLabel}`, exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "当时的引用来源", exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { name: citation.title, exact: true })).toBeVisible();
  await expect(drawer).toContainText(citation.revision);
  await expect(drawer.getByText(content, { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await expect(page.locator("dialog").filter({ hasText: "当时的引用来源" })).toBeHidden();
}

test("unified Ask keeps real source snapshots across scopes (isolated client route fixture; history persistence is not proven here)", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const user = await seedBrowserPersonalUser(`browser-ask-${suffix}`, "BrowserAsk2026Password!");
  await signInR02PersonalUser(page, user);
  const writeHeaders = { origin: new URL(page.url()).origin, "content-type": "application/json" };
  const projectName = `Unified Ask ${suffix}`;
  const projectResponse = await page.request.post("/api/projects", {
    headers: writeHeaders,
    data: { name: projectName, description: "隔离浏览器验收使用的真实项目来源。" },
  });
  expect(projectResponse.status()).toBe(201);
  const projectPayload = await projectResponse.json() as { project: { id: string } };
  const projectId = projectPayload.project.id;

  const personalTitle = `个人知识来源 ${suffix}`;
  const personalContentV1 = `个人知识原文版本一 ${suffix}：第一轮应保留这一版完整引用内容。`;
  const personalCreate = await page.request.post("/api/personal/knowledge", {
    headers: writeHeaders,
    data: { title: personalTitle, content: personalContentV1, isDefaultMemory: false },
  });
  expect(personalCreate.status()).toBe(201);
  const personalCreatePayload = await personalCreate.json() as { document: { id: string } };
  const documentId = personalCreatePayload.document.id;

  const projectContent = `项目资料真实原文 ${suffix}：第二轮引用应保留项目来源的完整正文。`;
  const projectSourceResponse = await page.request.post(`/api/projects/${projectId}/sources`, {
    headers: writeHeaders,
    data: { contentText: projectContent },
  });
  expect(projectSourceResponse.status()).toBe(201);
  const projectSourcePayload = await projectSourceResponse.json() as { source: { id: string } };
  const projectSourceId = projectSourcePayload.source.id;

  const personalV1 = await personalCitation(page, documentId);
  const projectSource = await projectCitation(page, projectId, projectSourceId);
  expect(personalV1.version).toBe(1);
  expect(personalV1.content).toBe(personalContentV1);
  expect(projectSource.content).toBe(projectContent);

  const thirdQuestion = `第三轮核对个人知识版本 ${suffix}`;
  const conversationId = randomUUID(), otherConversationId = randomUUID();
  const conversationTitle = `统一问答验收 ${suffix}`;
  const prepareBodies: Record<string, unknown>[] = [];
  const executeBodies: Record<string, unknown>[] = [];
  const confirmationIds: string[] = [];
  const pendingConfirmations = new Map<string, Readonly<{
    scope: "personal" | "project";
    projectId?: string;
    question: string;
    expectedLastTurnId: string | null;
    conversationId: string;
    contextName: string;
    source: CitationSnapshot;
  }>>();
  let currentConversation: AskConversationFixture | null = null;
  let waitExecute: Promise<void> | null = null, waitPrepare: Promise<void> | null = null, waitRead: Promise<void> | null = null;
  let releaseExecute = () => {}, releasePrepare = () => {}, releaseRead = () => {};
  let delayedReads = 0;


  // Only Ask conversation/turn HTTP responses are isolated fixtures. Project,
  // personal knowledge, and Ask source-directory requests above and in the UI
  // remain authenticated database-backed APIs. This fixture never calls a model.
  await page.route("**/api/ask/turns", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    if (body.phase === "prepare") {
      prepareBodies.push(body);
      const scope = body.scope === "project" ? "project" : "personal";
      const turnProjectId = scope === "project" ? String(body.projectId) : undefined;
      const title = scope === "project" ? projectName : "个人空间";
      const source = scope === "project" ? projectSource : body.question === thirdQuestion
        ? await personalCitation(page, documentId)
        : personalV1;
      const id = randomUUID();
      const targetConversationId = typeof body.conversationId === "string" ? body.conversationId : conversationId;
      const expectedLastTurnId = typeof body.expectedLastTurnId === "string" ? body.expectedLastTurnId : null;
      const confirmation = {
        confirmationId: id,
        conversationId: targetConversationId,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        modelId: "isolated-client-fixture-model",
        providerName: "隔离的客户端交互 fixture",
        billing: { mode: "platform", quotaMultiplierBps: 15_000, maxOutputTokens: 2_048, estimatedTokens: 24, estimatedRawTokens: 24, estimatedChargedTokens: 36 },
        contextTurnCount: currentConversation?.turns.length ?? 0,
        contextName: title,
        sources: [source],
        question: String(body.question),
        expectedLastTurnId,
      };
      pendingConfirmations.set(id, {
        scope,
        ...(turnProjectId === undefined ? {} : { projectId: turnProjectId }),
        question: String(body.question),
        expectedLastTurnId,
        conversationId: targetConversationId,
        contextName: title,
        source,
      });
      confirmationIds.push(id);
      if (waitPrepare) await waitPrepare;
      await route.fulfill({ json: { confirmation } });
      return;
    }

    const challengeId = String(body.challengeId ?? body.confirmationId ?? "");
    const prepared = pendingConfirmations.get(challengeId);
    if (body.phase !== "execute" || !prepared) {
      await route.fulfill({ status: 409, json: { error: { message: "No matching isolated confirmation fixture." } } });
      return;
    }
    executeBodies.push(body);
    if (waitExecute) await waitExecute;
    expect(body).toMatchObject({
      phase: "execute",
      conversationId: prepared.conversationId,
      expectedLastTurnId: prepared.expectedLastTurnId,
      scope: prepared.scope,
      question: prepared.question,
      challengeId,
      ...(prepared.projectId ? { projectId: prepared.projectId } : {}),
    });
    pendingConfirmations.delete(challengeId);
    const turnId = randomUUID();
    const sequence = (currentConversation?.turns.length ?? 0) + 1;
    const turn: AskTurnFixture = {
      id: turnId,
      sequence,
      scope: prepared.scope,
      ...(prepared.projectId ? { projectId: prepared.projectId } : {}),
      contextName: prepared.contextName,
      question: prepared.question,
      answer: `隔离客户端交互 fixture 回复：第 ${sequence} 轮 ${prepared.contextName}。`,
      modelId: "isolated-client-fixture-model",
      providerName: "隔离的客户端交互 fixture",
      createdAt: new Date(Date.now() + sequence * 1_000).toISOString(),
      citations: [prepared.source],
    };
    currentConversation = {
      id: prepared.conversationId,
      title: currentConversation?.title ?? conversationTitle,
      turns: [...(currentConversation?.turns ?? []), turn],
      lastTurnId: turnId,
    };
    await route.fulfill({ json: { conversation: currentConversation } });
  });

  let displayRevision = 0, pinned = false, forceRenameConflict = false;
  await page.route("**/api/ask/conversations**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "PATCH" && url.pathname === `/api/ask/conversations/${conversationId}` && currentConversation) {
      const body = route.request().postDataJSON() as { expectedRevision: number; title?: string; pinned?: boolean };
      if (forceRenameConflict) { displayRevision++; forceRenameConflict = false; }
      if (body.expectedRevision !== displayRevision) {
        await route.fulfill({ status: 409, json: { error: { code: "UNIFIED_QUESTION_CONFLICT" } } }); return;
      }
      displayRevision++;
      if (body.title !== undefined) currentConversation = { ...currentConversation, title: body.title };
      if (body.pinned !== undefined) pinned = body.pinned;
      await route.fulfill({ json: { presentation: { id: conversationId, title: currentConversation.title, pinned, presentationRevision: displayRevision } } }); return;
    }
    if (route.request().method() !== "GET") { await route.fallback(); return; }
    if (url.pathname === "/api/ask/conversations") {
      const search = (url.searchParams.get("search") ?? "").toLocaleLowerCase();
      const searchable = JSON.stringify(currentConversation ?? {}).toLocaleLowerCase();
      const conversations = currentConversation !== null && (search.length === 0 || searchable.includes(search)) ? [{
        id: currentConversation.id,
        title: currentConversation.title,
        pinned, presentationRevision: displayRevision,
        usage: { status: "known", requestCount: 2, knownRequestCount: 2, unknownRequestCount: 0, inputTokens: 120, outputTokens: 40, totalTokens: 160 },
        updatedAt: currentConversation.turns.at(-1)?.createdAt ?? new Date().toISOString(),
        turnCount: currentConversation.turns.length,
        ranges: [...new Set(currentConversation.turns.map((turn) => turn.contextName))],
      }] : [];
      await route.fulfill({ json: { conversations, pagination: { page: 1, totalPages: 1, total: conversations.length } } });
      return;
    }
    if (url.pathname === `/api/ask/conversations/${otherConversationId}`) {
      await route.fulfill({ json: { conversation: { id: otherConversationId, title: "另一个会话", turns: [], lastTurnId: null } } }); return;
    }
    if (url.pathname === `/api/ask/conversations/${conversationId}` && currentConversation !== null) {
      const snapshot = { ...currentConversation, pinned, presentationRevision: displayRevision };
      if (waitRead) { delayedReads++; await waitRead; }
      await route.fulfill({ json: { conversation: snapshot } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: { message: "Fixture conversation not found." } } });
  });

  await page.goto(`/ask?scope=personal&focusDocumentId=${encodeURIComponent(documentId)}`);
  await expect(page.getByRole("heading", { name: "智能问答", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });
  const emptyRounds = page.getByLabel("会话内容", { exact: true });
  const welcomeTitle = emptyRounds.getByRole("heading", { name: "想了解什么？", exact: true });
  await expect(welcomeTitle).toBeVisible();
  await expect.poll(() => emptyRounds.evaluate(element => element.scrollTop)).toBe(0);
  const welcomeBox = await welcomeTitle.boundingBox(), roundsBox = await emptyRounds.boundingBox();
  expect(welcomeBox!.y).toBeGreaterThanOrEqual(roundsBox!.y);
  expect(await emptyRounds.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
  for (const theme of ["light", "dark"]) {
    await page.context().addCookies([
      { name: "aipos-language", value: "en", url: new URL(page.url()).origin },
      { name: "aipos-theme", value: theme, url: new URL(page.url()).origin },
    ]);
    await page.reload();
    const englishRounds = page.getByLabel("Conversation content", { exact: true });
    await expect(englishRounds.getByRole("heading", { name: "What would you like to know?", exact: true })).toBeVisible();
    expect(await englishRounds.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `test-results/unified-question/empty-en-${theme}-1280.png` });
  }
  await page.context().addCookies([
    { name: "aipos-language", value: "zh-CN", url: new URL(page.url()).origin },
    { name: "aipos-theme", value: "light", url: new URL(page.url()).origin },
  ]);
  await page.reload();
  await page.setViewportSize({ width: 1440, height: 900 });
  const sourceDirectory = page.locator("aside").filter({ has: page.getByRole("heading", { name: "范围内的内容", exact: true }) });
  await expect(sourceDirectory.getByText(personalTitle, { exact: true })).toBeVisible();
  await expect(sourceDirectory.getByText(/1\s*条内容/u)).toBeVisible();

  async function prepareAndExecute(question: string, round: number, source: CitationSnapshot, contextName: string): Promise<void> {
    await page.getByRole("textbox", { name: "输入问题", exact: true }).fill(question);
    await page.getByRole("button", { name: "核对并提问", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "确认本轮提问", exact: true });
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText(contextName);
    await expect(confirmation.getByText(source.content, { exact: true })).toBeVisible();
    const consent = confirmation.getByRole("checkbox", { name: /我已核对本轮问题/u });
    const submit = confirmation.getByRole("button", { name: "确认并提问", exact: true });
    await expect(consent).not.toBeChecked();
    await expect(submit).toBeDisabled();
    expect(executeBodies).toHaveLength(round - 1);
    if (round === 1) {
      await expect(confirmation).toContainText(/预计预留\s*36\s*额度 Token/u);
      await expect(confirmation).toContainText(/额度倍率\s*1\.5\s*倍/u);
      await expect(confirmation).toContainText(/最多输出\s*2,048\s*Token/u);
    }
    if (round === 3) {
      await expect(confirmation).toContainText(/前\s*2\s*轮完整问答/u);
      await confirmation.getByText("查看本轮携带的历史问答", { exact: true }).click();
      await expect(confirmation).toContainText("个人空间");
      await expect(confirmation).toContainText(projectName);
    }
    await consent.check();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.locator("dialog").filter({ hasText: "确认本轮提问" })).toBeHidden();
    const turn = page.getByRole("article", { name: `第 ${round} 轮`, exact: true });
    await expect(turn).toBeVisible();
    await expect(turn).toContainText(question);
    await expect(turn).toContainText(contextName);
  }

  const firstQuestion = `统一问答验收 ${suffix} 的个人资料包含什么？`;
  await prepareAndExecute(firstQuestion, 1, personalV1, "个人空间");

  await page.getByRole("combobox", { name: "智能问答内容范围", exact: true }).selectOption("project");
  const askProjectPicker = page.getByRole("combobox", { name: "选择智能问答项目", exact: true });
  await expect(askProjectPicker.locator(`option[value="${projectId}"]`)).toHaveCount(1);
  await askProjectPicker.selectOption(projectId);
  await expect(sourceDirectory.getByText(projectSource.title, { exact: true })).toBeVisible();
  await expect(page.getByText(new RegExp(`本轮检索：${projectName}`, "u"))).toBeVisible();
  const secondQuestion = `项目资料 ${suffix} 中记录了什么依据？`;
  await prepareAndExecute(secondQuestion, 2, projectSource, projectName);

  const personalContentV2 = `个人知识原文版本二 ${suffix}：第三轮应显示更新后的新快照。`;
  const updateResponse = await page.request.patch(`/api/personal/knowledge/${encodeURIComponent(documentId)}`, {
    headers: writeHeaders,
    data: { expectedVersion: 1, title: personalTitle, content: personalContentV2 },
  });
  expect(updateResponse.status()).toBe(200);
  const personalV2 = await personalCitation(page, documentId);
  expect(personalV2.version).toBe(2);
  expect(personalV2.revision).not.toBe(personalV1.revision);
  expect(personalV2.content).toBe(personalContentV2);

  await page.getByRole("button", { name: "历史会话", exact: true }).click();
  const history = page.getByRole("dialog", { name: "历史会话", exact: true });
  await expect(history).toBeVisible();
  const historySearch = history.getByRole("textbox", { name: "搜索历史会话", exact: true });
  await historySearch.fill(suffix);
  const historyResult = history.getByRole("button", { name: new RegExp(`统一问答验收 ${suffix}`, "u") });
  await expect(historyResult).toBeVisible();
  await expect(historyResult).toContainText("2 轮问答");
  // Conversation APIs are isolated client interaction fixtures, not persisted AI output.
  // PostgreSQL gates separately verify real owner access, revisions and persistence.
  // Capture the reported hover state and verify it does not move the row.
  await historyResult.hover();
  await page.screenshot({ path: "test-results/unified-question/history-zh-CN-light.png" });
  for (const variant of [
    { language: "zh-CN", theme: "dark", width: 1440 },
    { language: "en", theme: "light", width: 1440 },
    { language: "en", theme: "dark", width: 1440 },
    { language: "en", theme: "dark", width: 390 },
  ]) {
    await page.context().addCookies([
      { name: "aipos-language", value: variant.language, url: new URL(page.url()).origin },
      { name: "aipos-theme", value: variant.theme, url: new URL(page.url()).origin },
    ]);
    await page.setViewportSize({ width: variant.width, height: 900 });
    await page.reload();
    const english = variant.language === "en";
    await page.getByRole("button", { name: english ? "Conversation history" : "历史会话", exact: true }).click();
    const matrixHistory = page.getByRole("dialog", { name: english ? "Conversation history" : "历史会话", exact: true });
    await matrixHistory.getByRole("textbox", { name: english ? "Search conversation history" : "搜索历史会话", exact: true }).fill(suffix);
    const row = matrixHistory.getByRole("button", { name: new RegExp(`统一问答验收 ${suffix}`, "u") });
    await expect(row).toBeVisible();
    const before = await row.boundingBox();
    await row.hover();
    const after = await row.boundingBox();
    expect(after).toEqual(before);
    await expect(row).toContainText("160");
    const pin = matrixHistory.getByRole("button", { name: english ? (pinned ? "Unpin conversation" : "Pin conversation") : (pinned ? "取消置顶" : "置顶会话"), exact: true });
    const previousPin = pinned;
    const pinRefresh = page.waitForResponse(response => new URL(response.url()).pathname === "/api/ask/conversations" && response.request().method() === "GET");
    await pin.click();
    await pinRefresh;
    await expect(matrixHistory.getByRole("button", { name: english ? (previousPin ? "Pin conversation" : "Unpin conversation") : (previousPin ? "置顶会话" : "取消置顶"), exact: true })).toHaveAttribute("aria-pressed", String(!previousPin));
    await matrixHistory.getByRole("button", { name: english ? "Rename conversation" : "重命名会话", exact: true }).click();
    const rename = page.getByRole("dialog", { name: english ? "Rename conversation" : "重命名会话", exact: true });
    const nameInput = rename.getByRole("textbox", { name: english ? "Conversation name" : "会话名称", exact: true });
    const newTitle = `${conversationTitle} ${variant.language}-${variant.theme}`;
    await nameInput.fill(newTitle);
    forceRenameConflict = true;
    await rename.getByRole("button", { name: english ? "Save" : "保存", exact: true }).click();
    await expect(rename.getByRole("alert")).toContainText(english ? "updated in another window" : "其他窗口");
    await expect(nameInput).toHaveValue(newTitle);
    await expectR02NoHorizontalOverflow(page, `rename dialog ${variant.language}/${variant.theme}/${variant.width}`);
    await expectR02NoAccessibilityViolations(page, `rename dialog ${variant.language}/${variant.theme}/${variant.width}`);
    expect(await nameInput.evaluate(element => Number.parseFloat(getComputedStyle(element).paddingLeft))).toBeGreaterThanOrEqual(12);
    await page.screenshot({ path: `test-results/unified-question/rename-${variant.language}-${variant.theme}-${variant.width}.png` });
    await rename.getByRole("button", { name: english ? "Load latest state" : "读取最新状态", exact: true }).click();
    await expect(rename.getByRole("alert")).toHaveCount(0);
    await expect(nameInput).toHaveValue(newTitle);
    const renameRefresh = page.waitForResponse(response => new URL(response.url()).pathname === "/api/ask/conversations" && response.request().method() === "GET");
    await rename.getByRole("button", { name: english ? "Save" : "保存", exact: true }).click();
    await expect(rename).toBeHidden();
    await renameRefresh;
    await expect(matrixHistory.getByRole("button", { name: english ? "Rename conversation" : "重命名会话", exact: true })).toBeFocused();
    await expect(row).toContainText(newTitle);
    await expectR02NoHorizontalOverflow(page, `conversation history ${variant.language}/${variant.theme}/${variant.width}`);
    await expectR02NoAccessibilityViolations(page, `conversation history ${variant.language}/${variant.theme}/${variant.width}`);
    await page.screenshot({ path: `test-results/unified-question/history-${variant.language}-${variant.theme}-${variant.width}.png` });
  }
  await page.context().addCookies([
    { name: "aipos-language", value: "zh-CN", url: new URL(page.url()).origin },
    { name: "aipos-theme", value: "light", url: new URL(page.url()).origin },
  ]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  await page.getByRole("button", { name: "历史会话", exact: true }).click();
  await historySearch.fill(suffix);
  await historyResult.click();
  await expect(page.locator("dialog").filter({ hasText: "历史会话" })).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/ask\\?conversation=${conversationId}$`, "u"));
  await expect(page.getByRole("article", { name: "第 1 轮", exact: true })).toBeVisible();
  await expect(page.getByRole("article", { name: "第 2 轮", exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("article", { name: "第 1 轮", exact: true })).toContainText(firstQuestion);
  await expect(page.getByRole("article", { name: "第 2 轮", exact: true })).toContainText(secondQuestion);
  await expect(page.getByRole("article", { name: "第 1 轮", exact: true })).toContainText("个人空间");
  await expect(page.getByRole("article", { name: "第 2 轮", exact: true })).toContainText(projectName);
  await expectCitationDrawer(page, 1, personalV1, personalContentV1);
  await expectCitationDrawer(page, 2, projectSource, projectContent);

  await page.getByRole("combobox", { name: "智能问答内容范围", exact: true }).selectOption("personal");
  const thirdSourceDirectory = page.locator("aside").filter({ has: page.getByRole("heading", { name: "范围内的内容", exact: true }) });
  await expect(thirdSourceDirectory.getByText(personalTitle, { exact: true })).toBeVisible();
  await prepareAndExecute(thirdQuestion, 3, personalV2, "个人空间");
  await expectCitationDrawer(page, 3, personalV2, personalContentV2);
  expect(prepareBodies).toHaveLength(3);
  expect(executeBodies).toHaveLength(3);
  expect(prepareBodies[0]).toMatchObject({ scope: "personal", focusDocumentId: documentId, expectedLastTurnId: null });
  expect(prepareBodies[0]).not.toHaveProperty("projectId");
  const finalConversation = (() => currentConversation)() as AskConversationFixture | null;
  if (finalConversation === null) throw new Error("The client fixture must preserve its completed conversation.");
  expect(finalConversation.turns).toHaveLength(3);
  expect(prepareBodies[1]).toMatchObject({ conversationId, scope: "project", projectId, expectedLastTurnId: finalConversation.turns[0]?.id });
  expect(prepareBodies[1]).not.toHaveProperty("focusDocumentId");
  expect(prepareBodies[2]).toMatchObject({ conversationId, scope: "personal", expectedLastTurnId: finalConversation.turns[1]?.id });
  expect(prepareBodies[2]).not.toHaveProperty("projectId");
  expect(executeBodies.map((body) => body.challengeId)).toEqual(confirmationIds);
  await page.screenshot({ path: "test-results/v110/ask-desktop.png" });

  await page.setViewportSize({ width: 390, height: 844 });
  await expectR02NoHorizontalOverflow(page, "unified Ask at 390px");
  await expectR02NoAccessibilityViolations(page, "unified Ask at 390px");
  await page.screenshot({ path: "test-results/v110/ask-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/dashboard");
  const launcher = page.locator(".inquiry-launcher");
  await launcher.click();
  const floating = page.locator('[data-floating-inquiry-root]');
  await floating.getByRole("button", { name: "历史会话", exact: true }).click();
  const floatingHistory = floating.getByRole("dialog", { name: "历史会话", exact: true });
  await floatingHistory.getByRole("button", { name: "重命名会话", exact: true }).click();
  const nestedRename = floating.getByRole("dialog", { name: "重命名会话", exact: true });
  await expect(nestedRename).toBeVisible();
  await nestedRename.getByRole("textbox").press("Alt+j");
  await expect(nestedRename).toBeVisible();
  await nestedRename.getByRole("textbox").press("Escape");
  await expect(nestedRename).toBeHidden();
  await expect(floatingHistory).toBeVisible();
  await floatingHistory.getByRole("button", { name: "关闭窗口", exact: true }).press("Escape");
  await expect(floatingHistory).toBeHidden();
  await expect(floating.getByRole("textbox", { name: "输入问题", exact: true })).toBeVisible();
  await floating.getByRole("textbox", { name: "输入问题", exact: true }).press("Escape");
  await expect(launcher).toHaveAttribute("aria-expanded", "false");
  await launcher.click();
  await expect(floating.getByRole("textbox", { name: "输入问题", exact: true })).toBeVisible();

  // Reopen first so the following full-page round carries the existing head.
  await floating.getByRole("button", { name: "历史会话", exact: true }).click();
  await floatingHistory.getByRole("button", { name: new RegExp(conversationTitle, "u") }).click();
  await expect(floating.getByRole("article", { name: "第 3 轮", exact: true })).toBeVisible();
  // Keep an older GET in flight in the floating instance while the full page
  // appends a new round. Releasing it later must not remove that round.
  waitRead = new Promise<void>(resolve => { releaseRead = resolve; });
  await floating.getByRole("button", { name: "历史会话", exact: true }).click();
  await floatingHistory.getByRole("button", { name: new RegExp(conversationTitle, "u") }).click();
  await expect.poll(() => delayedReads).toBe(1);
  await floatingHistory.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await floating.getByRole("button", { name: "收起问答", exact: true }).click();
  await page.getByRole("link", { name: "智能问答", exact: true }).first().click();
  await expect(page).toHaveURL(/\/ask$/u);
  // Opening the full page without an id preserves the current shared context.
  await page.getByRole("combobox", { name: "智能问答内容范围", exact: true }).selectOption("personal");
  const fourthQuestion = `后台继续问答 ${suffix}`;
  await page.getByRole("textbox", { name: "输入问题", exact: true }).fill(fourthQuestion);
  await page.getByRole("button", { name: "核对并提问", exact: true }).click();
  const backgroundConfirmation = page.getByRole("dialog", { name: "确认本轮提问", exact: true });
  await backgroundConfirmation.getByRole("checkbox", { name: /我已核对本轮问题/u }).check();
  waitExecute = new Promise<void>(resolve => { releaseExecute = resolve; });
  await backgroundConfirmation.getByRole("button", { name: "确认并提问", exact: true }).click();
  await expect(backgroundConfirmation).toBeHidden();
  await expect.poll(() => executeBodies.length).toBe(4);
  await page.getByRole("link", { name: "我的知识", exact: true }).first().click();
  await expect(page).toHaveURL(/\/personal\/knowledge$/u);
  await launcher.click();
  await expect(floating.getByRole("textbox", { name: "输入问题", exact: true })).toBeDisabled();
  await floating.getByRole("button", { name: "收起问答", exact: true }).click();
  await page.getByRole("button", { name: "新建知识", exact: true }).first().click();
  const editor = page.getByRole("dialog", { name: "新建知识", exact: true });
  const untouchedDraft = `问答期间继续编辑 ${suffix}`;
  await editor.getByRole("textbox", { name: "标题", exact: true }).fill(untouchedDraft);
  const completion = page.waitForResponse(response => new URL(response.url()).pathname === "/api/ask/turns" && response.request().postDataJSON()?.phase === "execute");
  releaseExecute(); waitExecute = null;
  await completion;
  const oldReadCompletion = page.waitForResponse(response => new URL(response.url()).pathname === `/api/ask/conversations/${conversationId}` && response.request().method() === "GET");
  releaseRead(); waitRead = null;
  await oldReadCompletion;
  await expect(floating.locator('textarea[aria-label="输入问题"]')).toBeEnabled();
  await expect(editor.getByRole("textbox", { name: "标题", exact: true })).toHaveValue(untouchedDraft);
  await expect(page).toHaveURL(/\/personal\/knowledge$/u);
  await editor.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("dialog", { name: "离开编辑页面？", exact: true }).getByRole("button", { name: "放弃修改并离开", exact: true }).click();
  await launcher.click();
  await expect(floating.getByRole("article", { name: "第 4 轮", exact: true })).toContainText(fourthQuestion);
  await expect(floating.getByRole("textbox", { name: "输入问题", exact: true })).toBeEnabled();
  expect(executeBodies).toHaveLength(4);
  await floating.getByRole("button", { name: "收起问答", exact: true }).click();

  // Native History API is supported by the App Router. Simulate a saved
  // conversation target arriving while the current confirmation owns the lock.
  await page.getByRole("link", { name: "智能问答", exact: true }).first().click();
  await page.getByRole("textbox", { name: "输入问题", exact: true }).fill(`确认历史快照 ${suffix}`);
  await page.getByRole("button", { name: "核对并提问", exact: true }).click();
  const frozenConfirmation = page.getByRole("dialog", { name: "确认本轮提问", exact: true });
  await frozenConfirmation.getByText("查看本轮携带的历史问答", { exact: true }).click();
  await page.evaluate(id => window.history.pushState(null, "", `/ask?conversation=${id}`), otherConversationId);
  await expect(page).toHaveURL(new RegExp(`conversation=${otherConversationId}$`, "u"));
  await expect(frozenConfirmation).toContainText(fourthQuestion);
  await expect(frozenConfirmation).not.toContainText("另一个会话");
  await frozenConfirmation.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await expect(page.locator('[data-ask-page]')).toContainText("另一个会话");
  expect(executeBodies).toHaveLength(4);

  // Public navigation disposes the old floating instance before a late prepare
  // can open a native modal in a hidden ancestor.
  await page.getByRole("link", { name: "帮助", exact: true }).click();
  await page.getByRole("link", { name: "联系作者", exact: true }).click();
  await expect(page).toHaveURL(/\/contact$/u);
  await page.goBack();
  await expect(page).toHaveURL(/\/guide$/u);
  await launcher.click();
  await floating.getByRole("textbox", { name: "输入问题", exact: true }).fill(`未发送确认 ${suffix}`);
  waitPrepare = new Promise<void>(resolve => { releasePrepare = resolve; });
  await floating.getByRole("button", { name: "核对并提问", exact: true }).click();
  await expect.poll(() => prepareBodies.length).toBe(6);
  await page.goForward();
  await expect(page).toHaveURL(/\/contact$/u);
  releasePrepare(); waitPrepare = null;
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await page.getByRole("link", { name: "隐私政策", exact: true }).click();
  await expect(page).toHaveURL(/\/privacy$/u);
  expect(executeBodies).toHaveLength(4);

  // An old account's delayed history response cannot populate the next account.
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(/\/guide$/u);
  await launcher.click();
  waitRead = new Promise<void>(resolve => { releaseRead = resolve; });
  const beforeDelayedReads = delayedReads;
  await floating.getByRole("button", { name: "历史会话", exact: true }).click();
  await floatingHistory.getByRole("button", { name: new RegExp(conversationTitle, "u") }).click();
  await expect.poll(() => delayedReads).toBe(beforeDelayedReads + 1);
  await floatingHistory.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await floating.getByRole("button", { name: "收起问答", exact: true }).click();
  const nextUser = await seedBrowserPersonalUser(`browser-ask-next-${suffix}`, "BrowserAsk2026Password!");
  await signOutR02User(page);
  // Stay in the client navigation session so the original promise stays alive.
  await page.getByLabel("用户名或手机号", { exact: true }).fill(nextUser.username);
  await page.getByLabel("密码", { exact: true }).fill(nextUser.password);
  await page.getByRole("button", { name: "登 录", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/u);
  releaseRead(); waitRead = null;
  await launcher.click();
  await expect(floating.getByRole("textbox", { name: "输入问题", exact: true })).toHaveValue("");
  await expect(floating.getByRole("article")).toHaveCount(0);
  await expect(floating).not.toContainText(fourthQuestion);
});

test("3D knowledge graph rotates, pans, zooms and drags without losing direct source details", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInR02Admin(page);
  await signOutR02User(page);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const user = await seedBrowserPersonalUser(`browser-graph-${suffix}`, "BrowserGraph2026Password!");
  await signInR02PersonalUser(page, user);
  const writeHeaders = { origin: new URL(page.url()).origin, "content-type": "application/json" };
  const projectName = `Knowledge graph ${suffix}`;
  const projectResponse = await page.request.post("/api/projects", {
    headers: writeHeaders,
    data: { name: projectName, description: "图谱用例通过实际项目 API 写入来源。" },
  });
  expect(projectResponse.status()).toBe(201);
  const projectPayload = await projectResponse.json() as { project: { id: string } };
  const projectId = projectPayload.project.id;

  const personalTitle = `真实个人图谱来源 ${suffix}`;
  const personalContent = `真实个人图谱原文 ${suffix}：这是个人知识 API 保存的正文。`;
  const personalResponse = await page.request.post("/api/personal/knowledge", {
    headers: writeHeaders,
    data: { title: personalTitle, content: personalContent, isDefaultMemory: false },
  });
  expect(personalResponse.status()).toBe(201);
  const personalPayload = await personalResponse.json() as { document: { id: string } };

  const projectContent = `真实项目图谱来源 ${suffix}：这是项目来源 API 保存的完整原文。`;
  const projectSourceResponse = await page.request.post(`/api/projects/${projectId}/sources`, {
    headers: writeHeaders,
    data: { contentText: projectContent },
  });
  expect(projectSourceResponse.status()).toBe(201);
  const sourcePayload = await projectSourceResponse.json() as { source: { id: string } };
  const factTitle = `已确认的图谱事实 ${suffix}`;
  const factResponse = await page.request.post(`/api/projects/${projectId}/items`, {
    headers: writeHeaders,
    data: {
      type: "decision", sourceId: sourcePayload.source.id,
      title: factTitle, content: projectContent, sourceExcerpt: projectContent,
    },
  });
  expect(factResponse.status()).toBe(201);
  const factPayload = await factResponse.json() as { item: { id: string; updatedAt: string } };
  const confirmFactResponse = await page.request.patch(`/api/projects/${projectId}/items/${factPayload.item.id}`, {
    headers: writeHeaders,
    data: { action: "confirm", expectedUpdatedAt: factPayload.item.updatedAt },
  });
  expect(confirmFactResponse.status()).toBe(200);

  await page.goto("/personal/knowledge/graph?scope=personal");
  await expect(page.getByRole("heading", { name: "知识图谱", exact: true })).toBeVisible();
  await expect(page.getByText("1 个来源", { exact: true })).toBeVisible();
  await expect(page.getByText("0 条关联事实", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `来源：${personalTitle}`, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: personalTitle, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "打开来源", exact: true }).click();
  const personalSourceDialog = page.getByRole("dialog", { name: "来源内容", exact: true });
  await expect(personalSourceDialog.getByText(personalContent, { exact: true })).toBeVisible();
  await personalSourceDialog.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await expect(page.locator("dialog").filter({ hasText: "来源内容" })).toBeHidden();

  const space = page.getByTestId("knowledge-graph-space");
  const personalNode = page.getByRole("button", { name: `来源：${personalTitle}`, exact: true });
  const initialYaw = await space.getAttribute("data-yaw");
  const beforeRotationX = await personalNode.locator("..").getAttribute("x");
  const viewport = (await space.boundingBox())!;
  const blank = { x: viewport.x + 20, y: viewport.y + 20 };
  await page.mouse.move(blank.x, blank.y);
  await page.mouse.down();
  await page.mouse.move(blank.x + 70, blank.y + 32, { steps: 8 });
  await page.mouse.up();
  await expect(space).not.toHaveAttribute("data-yaw", initialYaw!);
  await expect(personalNode.locator("..")).not.toHaveAttribute("x", beforeRotationX!);
  const initialPan = await space.getAttribute("data-pan-x");
  await page.keyboard.down("Shift");
  await page.mouse.move(blank.x, blank.y);
  await page.mouse.down();
  await page.mouse.move(blank.x + 40, blank.y + 20, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(space).not.toHaveAttribute("data-pan-x", initialPan!);
  const initialDistance = Number(await space.getAttribute("data-distance"));
  await page.mouse.move(blank.x + 10, blank.y + 10);
  await page.mouse.wheel(0, -150);
  await expect.poll(async () => Number(await space.getAttribute("data-distance"))).toBeGreaterThan(initialDistance);
  const wheelDistance = Number(await space.getAttribute("data-distance"));
  await page.getByRole("button", { name: "缩小图谱", exact: true }).click();
  await expect.poll(async () => Number(await space.getAttribute("data-distance"))).toBeLessThan(wheelDistance);
  await page.getByRole("button", { name: "重置布局", exact: true }).click();
  await expect(space).toHaveAttribute("data-yaw", initialYaw!);
  const nodeBox = (await personalNode.boundingBox())!;
  const originalNodeX = await personalNode.locator("..").getAttribute("x");
  await page.mouse.move(nodeBox.x + nodeBox.width / 2, nodeBox.y + nodeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(nodeBox.x + nodeBox.width / 2 + 45, nodeBox.y + nodeBox.height / 2 + 24, { steps: 8 });
  await page.mouse.up();
  await expect(personalNode.locator("..")).not.toHaveAttribute("x", originalNodeX!);
  await expect(page).toHaveURL(/\/personal\/knowledge\/graph/u);
  await page.getByRole("button", { name: "适应全图", exact: true }).click();
  const keyboardYaw = await space.getAttribute("data-yaw");
  await space.focus();
  await page.keyboard.press("ArrowRight");
  await expect(space).not.toHaveAttribute("data-yaw", keyboardYaw!);
  await personalNode.focus();
  const beforeKeyboardMove = await personalNode.locator("..").getAttribute("x");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(personalNode.locator("..")).not.toHaveAttribute("x", beforeKeyboardMove!);
  await expectR02NoAccessibilityViolations(page, "3D personal graph on desktop");
  await page.screenshot({ path: "test-results/v110/graph-3d-desktop.png" });
  // A click goes straight to the actual document detail; dragging above did not navigate.
  await personalNode.click();
  await expect(page).toHaveURL(`/personal/knowledge?document=${personalPayload.document.id}`);
  const personalDetail = page.getByRole("dialog", { name: "个人知识详情", exact: true });
  await expect(personalDetail.getByRole("heading", { name: personalTitle, exact: true })).toBeVisible();
  await expect(personalDetail).toContainText(personalContent);
  await page.goto("/personal/knowledge/graph?scope=personal");

  await page.getByRole("combobox", { name: "图谱内容范围", exact: true }).selectOption("project");
  const graphProjectPicker = page.getByRole("combobox", { name: "选择图谱项目", exact: true });
  await expect(graphProjectPicker.locator(`option[value="${projectId}"]`)).toHaveCount(1);
  await graphProjectPicker.selectOption(projectId);
  const projectNodeTitle = projectContent.replace(/\s+/gu, " ").trim().slice(0, 52);
  await expect(page.getByText("1 个来源", { exact: true })).toBeVisible();
  await expect(page.getByText("1 条关联事实", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `来源：${projectNodeTitle}`, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: projectNodeTitle, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "打开来源", exact: true }).click();
  const projectSourceDialog = page.getByRole("dialog", { name: "来源内容", exact: true });
  await expect(projectSourceDialog.getByText(projectContent, { exact: true })).toBeVisible();
  await projectSourceDialog.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await expect(page.locator("dialog").filter({ hasText: "来源内容" })).toBeHidden();
  // Both the project source and its fact open the same real evidence detail.
  await page.getByRole("button", { name: `来源：${projectNodeTitle}`, exact: true }).click();
  await expect(page).toHaveURL(`/projects/${projectId}/materials/sources/${sourcePayload.source.id}`);
  await expect(page.getByText(projectContent, { exact: true }).first()).toBeVisible();
  await page.goto(`/personal/knowledge/graph?scope=project&projectId=${projectId}`);
  await page.getByRole("button", { name: `事实：${factTitle}`, exact: true }).press("Enter");
  await expect(page).toHaveURL(`/projects/${projectId}/materials/sources/${sourcePayload.source.id}`);
  await expect(page.getByText(projectContent, { exact: true }).first()).toBeVisible();
  await page.goto(`/personal/knowledge/graph?scope=project&projectId=${projectId}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "放大图谱", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "放大图谱", exact: true }).click();
  await page.getByRole("button", { name: "适应全图", exact: true }).click();
  await expectR02NoHorizontalOverflow(page, "knowledge graph at 390px");
  await expectR02NoAccessibilityViolations(page, "knowledge graph at 390px");
  await page.screenshot({ path: "test-results/v110/graph-mobile.png" });
});
