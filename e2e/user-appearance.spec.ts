import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { expect, test, type ElementHandle, type Page } from "@playwright/test";
import {
  expectR02NoAccessibilityViolations,
  expectR02NoHorizontalOverflow,
  signInR02Admin,
  signInR02PersonalUser,
  signOutR02User,
} from "./support/r02-admin-navigation";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { englishUiMessages } from "../src/lib/ui-dictionary-source";

type AppearanceCase = Readonly<{
  language: "zh-CN" | "en";
  theme: "light" | "dark";
  closePopoverWith: "outside" | "escape";
}>;

const APPEARANCE_CASES: readonly AppearanceCase[] = [
  { language: "zh-CN", theme: "light", closePopoverWith: "outside" },
  { language: "zh-CN", theme: "dark", closePopoverWith: "escape" },
  { language: "en", theme: "light", closePopoverWith: "outside" },
  { language: "en", theme: "dark", closePopoverWith: "escape" },
];

const GLOBAL_ROUTES = [
  "/dashboard",
  "/ask",
  "/personal/projects",
  "/personal/knowledge",
  "/personal/knowledge/graph",
] as const;

const PROJECT_SECTIONS = [
  "",
  "/plan",
  "/materials",
  "/intelligence",
  "/automations",
  "/governance",
] as const;

const PERSONAL_ROUTES = [
  "/personal",
  "/personal/configuration",
  "/personal/usage",
  "/personal/models",
  "/personal/connections/git",
  "/personal/connections/mcp",
  "/credits",
  "/team",
  "/profile",
  "/notifications",
  "/guide",
] as const;

const GLOBAL_NAVIGATION_LABELS = {
  "zh-CN": ["工作台", "智能问答", "我的项目", "我的知识", "知识图谱"],
  en: ["Dashboard", "Ask AI", "My projects", "My knowledge", "Knowledge graph"],
} as const;

const PROJECT_NAVIGATION_LABELS = {
  "zh-CN": ["项目概览", "项目计划", "项目资料", "简报与调查", "项目自动化", "项目管理"],
  en: ["Project overview", "Project plan", "Project sources", "Briefs & research", "Automations", "Project management"],
} as const;

const GOVERNANCE_TAB_LABELS = {
  "zh-CN": ["事实与关系", "记忆质量", "动作审批", "用量记录", "成员权限", "资源与配置"],
  en: ["Facts & relationships", "Knowledge quality", "Action approvals", "Usage records", "Member permissions", "Resources & settings"],
} as const;

function safeRouteFileName(route: string): string {
  return route.replace(/[^A-Za-z0-9_-]+/gu, "_").replace(/^_+|_+$/gu, "") || "root";
}

async function signInIsolatedPersonalUser(page: Page, username: string, activeMembership = false): Promise<void> {
  // Initialize or authenticate the administrator first so this spec also runs
  // by itself against a fresh isolated browser database.
  await signInR02Admin(page);
  const user = await seedBrowserPersonalUser(username, "Appearance2026Password!");
  if (activeMembership) {
    const headers = { origin: new URL(page.url()).origin };
    const note = "Isolated appearance form fixture";
    const prepared = await page.request.post("/api/system/memberships/preview", {
      headers, data: { userId: user.id, action: "grant", days: 1, note },
    });
    expect(prepared.status()).toBe(200);
    const { preview } = await prepared.json();
    expect(preview.canExecute).toBe(true);
    expect(preview.blockingCategories).toEqual([]);
    const granted = await page.request.patch(`/api/system/memberships/${user.id}`, {
      headers, data: {
        action: preview.action, days: 1, note, expectedVersion: preview.current.version,
        expectedImpactFingerprint: preview.impactFingerprint, requestKey: randomUUID(),
        requestFingerprint: preview.requestFingerprint, previewId: preview.previewId,
        previewIssuedAt: preview.previewIssuedAt, previewExpiresAt: preview.previewExpiresAt,
        confirmation: true,
      },
    });
    expect(granted.status()).toBe(200);
    expect((await granted.json()).subscription.status).toBe("active");
  }
  await signOutR02User(page);
  await signInR02PersonalUser(page, user);
}

async function createBrowserSources(page: Page, suffix: string): Promise<string> {
  const headers = { origin: new URL(page.url()).origin, "content-type": "application/json" };
  const projectResponse = await page.request.post("/api/projects", {
    headers,
    data: { name: `外观验收项目 ${suffix}`, description: "仅供隔离浏览器验收使用。" },
  });
  expect(projectResponse.status()).toBe(201);
  const projectPayload = await projectResponse.json() as { project: { id: string } };

  const knowledgeResponse = await page.request.post("/api/personal/knowledge", {
    headers,
    data: {
      title: `外观验收个人知识 ${suffix}`,
      content: `这是一条用于检查页面主题、语言和知识列表状态的个人资料 ${suffix}。`,
      isDefaultMemory: false,
    },
  });
  expect(knowledgeResponse.status()).toBe(201);
  return projectPayload.project.id;
}

async function openAppearancePopover(page: Page) {
  const trigger = page.locator(".appearance-controls-trigger");
  await expect(trigger).toBeVisible();
  await trigger.click();
  const popover = page.locator('.appearance-controls [role="dialog"]');
  await expect(popover).toBeVisible();
  return { trigger, popover };
}

async function clickSafeBlankOutsidePopover(page: Page): Promise<void> {
  const point = await page.evaluate(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const sidebar = document.querySelector("aside[aria-label]");
    const sidebarRight = sidebar?.getBoundingClientRect().right ?? 220;
    const xs = [
      Math.ceil(sidebarRight + 3),
      Math.ceil(sidebarRight + 18),
      Math.floor(viewport.width * 0.52),
      viewport.width - 18,
    ];
    const ys = [
      Math.floor(viewport.height * 0.78),
      Math.floor(viewport.height * 0.9),
      Math.floor(viewport.height * 0.6),
      Math.floor(viewport.height * 0.42),
    ];
    const interactive = "a[href], button, input, select, textarea, [role=button], [tabindex]:not([tabindex='-1'])";
    for (const y of ys) {
      for (const x of xs) {
        if (x < 1 || y < 1 || x >= viewport.width || y >= viewport.height) continue;
        const target = document.elementFromPoint(x, y);
        if (!target || target.closest(interactive) || target.closest(".appearance-controls, .inquiry-root")) continue;
        return { x, y };
      }
    }
    return null;
  });
  expect(point, "find a blank, non-interactive point outside the appearance popover").not.toBeNull();
  await page.mouse.click(point!.x, point!.y);
}

async function selectAppearance(page: Page, appearance: AppearanceCase): Promise<void> {
  const { trigger, popover } = await openAppearancePopover(page);
  await popover.getByRole("combobox").nth(0).selectOption(appearance.language);
  await expect(page.locator("html")).toHaveAttribute("lang", appearance.language);
  await expect(popover.getByRole("status")).toHaveCount(0);
  await popover.getByRole("combobox").nth(1).selectOption(appearance.theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme", appearance.theme);
  await expect(page.locator("html")).toHaveAttribute("data-theme-preference", appearance.theme);

  if (appearance.language === "zh-CN" && appearance.theme === "light") {
    await expectR02NoAccessibilityViolations(page, "Chinese light appearance popover");
  } else if (appearance.language === "en" && appearance.theme === "dark") {
    await expectR02NoAccessibilityViolations(page, "English dark appearance popover");
  }

  if (appearance.closePopoverWith === "escape") {
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(trigger).toBeFocused();
  } else {
    await clickSafeBlankOutsidePopover(page);
    await expect(popover).toHaveCount(0);
  }
}

async function expectGlobalNavigation(page: Page, language: AppearanceCase["language"]): Promise<void> {
  const label = language === "en" ? "Global navigation" : "全局入口";
  const navigation = page.getByRole("navigation", { name: label, exact: true });
  for (const destination of GLOBAL_NAVIGATION_LABELS[language]) {
    await expect(navigation.getByRole("link", { name: destination, exact: true })).toBeVisible();
  }
  const shellHeader = page.locator("[data-user-shell-root] > header");
  await expect(shellHeader.getByRole("button", { name: language === "en" ? "Search and navigate" : "搜索与跳转", exact: true })).toBeVisible();
  await expect(shellHeader.getByRole("link", { name: language === "en" ? "Help" : "帮助", exact: true })).toBeVisible();
  await expect(shellHeader.getByRole("link", { name: language === "en" ? "Notifications" : "通知中心", exact: true })).toBeVisible();
  await expect(shellHeader.getByRole("button", { name: language === "en" ? "Account menu" : "账户菜单", exact: true })).toBeVisible();
  if (new URL(page.url()).pathname !== "/ask") {
    await expect(page.locator(".inquiry-launcher > span")).toHaveText(language === "en" ? "Ask AI" : "智能问答");
  }
}

async function expectRoute(page: Page, path: string, appearance: AppearanceCase): Promise<void> {
  await page.goto(path);
  await expect.poll(() => new URL(page.url()).pathname).toBe(path);
  await expect(page.locator("main h1").first(), `${path} should render its primary heading`).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", appearance.language);
  await expect(page.locator("html")).toHaveAttribute("data-theme", appearance.theme);
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)'), `${path} must not display a soft error`).toHaveCount(0);
  await expect(page.locator('[aria-label^="正在加载"], [aria-label^="正在读取"], [aria-label^="Loading"], [aria-label^="Reading"], [aria-label^="Fetching"], [class*="projectSkeleton"], [class*="skeletonPage"], [class*="loadingRows"], .animate-pulse'), `${path} must finish its visible loading state`).toHaveCount(0);
  await expectGlobalNavigation(page, appearance.language);
  await expectR02NoHorizontalOverflow(page, `${path} (${appearance.language}/${appearance.theme})`);
}

async function expectSameConnectedNode(
  handle: ElementHandle<HTMLElement | SVGElement> | null,
  selector: string,
  description: string,
): Promise<void> {
  expect(handle, `${description} handle`).not.toBeNull();
  const unchanged = await handle!.evaluate((element, query) => element.isConnected && document.querySelector(query) === element, selector);
  expect(unchanged, `${description} should remain the same connected DOM node`).toBe(true);
}

for (const appearance of APPEARANCE_CASES) {
  test(`user appearance ${appearance.language}/${appearance.theme} covers all primary routes`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1680, height: 960 });
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    await signInIsolatedPersonalUser(page, `appearance-${appearance.language.toLowerCase()}-${appearance.theme}-${suffix}`, true);
    const projectId = await createBrowserSources(page, suffix);
    await selectAppearance(page, appearance);

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", appearance.language);
    await expect(page.locator("html")).toHaveAttribute("data-theme", appearance.theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme-preference", appearance.theme);
    const savedAppearance = await openAppearancePopover(page);
    await expect(savedAppearance.popover.getByRole("combobox").nth(0)).toHaveValue(appearance.language);
    await expect(savedAppearance.popover.getByRole("combobox").nth(1)).toHaveValue(appearance.theme);
    await clickSafeBlankOutsidePopover(page);
    await expect(savedAppearance.popover).toHaveCount(0);

    const projectRoutes = PROJECT_SECTIONS.map((section) => `/projects/${projectId}${section}`);
    const routes = [...GLOBAL_ROUTES, ...projectRoutes, ...PERSONAL_ROUTES];
    expect(routes.length).toBeGreaterThanOrEqual(20);
    await mkdir("test-results/user-appearance", { recursive: true });

    for (const route of routes) {
      await expectRoute(page, route, appearance);
      if (route === "/dashboard" || route === "/personal/projects") {
        await expect(page.locator("main").getByText(`外观验收项目 ${suffix}`, { exact: true }).filter({ visible: true })).toBeVisible();
      }
      if (route === `/projects/${projectId}/plan`) {
        await expect(page.getByRole("group", { name: appearance.language === "en" ? "Project plan view" : "项目计划视图", exact: true })).toBeVisible();
      }
      // A missing loading indicator can precede the first effect. Capture the
      // actual saved knowledge and graph, rather than that transient empty view.
      if (route === "/personal/knowledge") {
        await expect(page.getByText(`外观验收个人知识 ${suffix}`, { exact: true })).toBeVisible();
      }
      if (route === "/personal/knowledge/graph") {
        await expect(page.getByRole("region", { name: appearance.language === "en" ? "Knowledge relationship graph" : "知识关系图", exact: true })).toBeVisible();
      }
      if (route === "/credits") {
        await expect(page.locator("summary").filter({ hasText: appearance.language === "en" ? "View daily values" : "查看每日数值" })).toBeVisible();
      }
      await page.screenshot({
        path: `test-results/user-appearance/${appearance.language}-${appearance.theme}-${safeRouteFileName(route)}.png`,
      });

      if (route === "/personal/models" || route === `/projects/${projectId}/automations`) {
        const tr = (text: string) => appearance.language === "en" ? englishUiMessages[text] ?? text : text;
        await page.getByRole("button", { name: tr(route === "/personal/models" ? "添加连接" : "添加自动化"), exact: true }).click();
        const editor = page.locator('[data-operation-surface][aria-modal="true"]').filter({ visible: true });
        await expect(editor).toBeVisible();
        await expect(editor.getByRole("heading", { level: 2 })).toHaveCount(1);
        await expect(editor.locator("[data-operation-content] > section, [data-operation-content] > form")).toHaveCSS("padding-left", "0px");
        await expect(editor.getByRole("button", { name: tr("关闭窗口"), exact: true })).toBeVisible();
        if (route.endsWith("/automations")) {
          await expect(editor.getByRole("textbox", { name: tr("规则名称"), exact: true })).toHaveValue(tr("每日记忆质量检查"));
        }
        await expect(editor.locator('button[type="submit"]')).toHaveCSS("background-color", appearance.theme === "dark" ? "rgb(71, 116, 198)" : "rgb(53, 102, 201)");
        const fields = editor.locator("input:not([type=checkbox]):not([type=radio]),select,textarea");
        expect(await fields.count()).toBeGreaterThan(0);
        await expect(fields.first()).toHaveCSS("border-radius", "4px");
        const cramped = await fields.evaluateAll(elements => elements.filter(element => element.getClientRects().length > 0).map(element => ({
          left: parseFloat(getComputedStyle(element).paddingLeft), right: parseFloat(getComputedStyle(element).paddingRight),
        })).filter(inset => inset.left < 12 || inset.right < 12));
        expect(cramped).toEqual([]);
        await expectR02NoAccessibilityViolations(page, `${route} form ${appearance.language}/${appearance.theme}`);
        await page.screenshot({ path: `test-results/user-appearance/${appearance.language}-${appearance.theme}-${safeRouteFileName(route)}-editor.png` });
        await page.keyboard.press("Escape");
        await expect(editor).toHaveCount(0);
      }

      if (route === "/personal/connections/git" || route === "/personal/connections/mcp") {
        const tr = (text: string) => appearance.language === "en" ? englishUiMessages[text] ?? text : text;
        const add = page.getByRole("button", { name: tr(route === "/personal/connections/git" ? "添加 Git 服务" : "添加 MCP 服务"), exact: true });
        await expect(add).toBeEnabled();
        await add.click();
        const editor = page.locator("[data-connection-dialog]");
        await expect(editor).toBeVisible();
        await expect(editor.getByRole("heading", { level: 2 })).toHaveCount(1);
        await expect(editor.locator("[data-dialog-body] > section")).toHaveCSS("padding-left", "0px");
        const action = editor.getByRole("button", { name: tr("测试连接"), exact: true });
        await expect(action).toHaveCSS("background-color", appearance.theme === "dark" ? "rgb(71, 116, 198)" : "rgb(53, 102, 201)");
        if (route.endsWith("/git")) {
          const hintName = appearance.language === "en" ? `${tr("服务地址")} example` : "服务地址填写示例";
          await editor.getByRole("button", { name: hintName, exact: true }).click();
          await expect(page.getByRole("tooltip")).toBeVisible();
        }
        await expectR02NoAccessibilityViolations(page, `${route} editor ${appearance.language}/${appearance.theme}`);
        await page.screenshot({ path: `test-results/user-appearance/${appearance.language}-${appearance.theme}-${safeRouteFileName(route)}-editor.png` });
        await editor.getByRole("button", { name: tr("关闭弹窗"), exact: true }).click();
        await expect(editor).toHaveCount(0);
      }
      if (route === "/dashboard") {
        await expectR02NoAccessibilityViolations(page, `${appearance.language}/${appearance.theme} dashboard`);
      }
      if (route === "/ask") {
        const documentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
        expect(documentHeight, "the full-page Ask AI view should fit a 1680×960 viewport without document scrolling").toBeLessThanOrEqual(961);
        if (appearance.language === "zh-CN" && appearance.theme === "light") {
          await expectR02NoAccessibilityViolations(page, "Ask AI full page");
        }
      }
      if (route === "/credits") {
        const summary = page.locator('[class*="summaryCard"]');
        await expect(summary).toHaveCount(3);
        const bounds = await summary.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
        expect(Math.max(...bounds.map(box => box.y)) - Math.min(...bounds.map(box => box.y))).toBeLessThanOrEqual(1);
        expect(Math.max(...bounds.map(box => box.bottom)) - Math.min(...bounds.map(box => box.bottom))).toBeLessThanOrEqual(1);
        const trend = await page.locator('[class*="trendLayout"] > section').boundingBox();
        const rules = await page.locator('[class*="trendLayout"] > aside').boundingBox();
        expect(Math.abs(trend!.y + trend!.height - rules!.y - rules!.height)).toBeLessThanOrEqual(1);
        const modelFilter = page.getByLabel(appearance.language === "en" ? "Model filter" : "模型筛选", { exact: true });
        expect(await modelFilter.evaluate(element => parseFloat(getComputedStyle(element).paddingLeft))).toBeGreaterThanOrEqual(12);
        await expectR02NoAccessibilityViolations(page, `${appearance.language}/${appearance.theme} credits`);
      }
      if (route === "/personal/knowledge") {
        const sidebar = page.getByRole("complementary", { name: appearance.language === "en" ? "Main navigation" : "主导航" });
        const globalNavigation = sidebar.getByRole("navigation", { name: appearance.language === "en" ? "Global navigation" : "全局入口", exact: true });
        await expect(globalNavigation.getByRole("link", { name: GLOBAL_NAVIGATION_LABELS[appearance.language][3], exact: true })).toBeVisible();
        if (appearance.language === "zh-CN" && appearance.theme === "light") {
          await expectR02NoAccessibilityViolations(page, "personal knowledge library");
        }
      }
      if (route === "/personal/knowledge/graph" && appearance.language === "zh-CN" && appearance.theme === "light") {
        await expectR02NoAccessibilityViolations(page, "personal knowledge graph");
      }
      if (route === `/projects/${projectId}`) {
        const sidebar = page.getByRole("complementary", { name: appearance.language === "en" ? "Main navigation" : "主导航" });
        const projectNavigation = sidebar.getByRole("navigation").nth(1);
        for (const destination of PROJECT_NAVIGATION_LABELS[appearance.language]) {
          await expect(projectNavigation.getByRole("link", { name: destination, exact: true })).toBeVisible();
        }
        if (appearance.language === "zh-CN" && appearance.theme === "light") {
          await expectR02NoAccessibilityViolations(page, "project overview");
        }
      }
      if (route === `/projects/${projectId}/governance`) {
        const tablist = page.getByRole("tablist", { name: appearance.language === "en" ? "Project management section" : "项目管理栏目", exact: true });
        await expect(tablist.getByRole("tab")).toHaveCount(6, { timeout: 15_000 });
        for (const label of GOVERNANCE_TAB_LABELS[appearance.language]) {
          const tab = tablist.getByRole("tab", { name: label, exact: true });
          await expect(tab).toBeVisible();
          await tab.click();
          await expect(tab).toHaveAttribute("aria-selected", "true");
          if (appearance.language === "en" && label === "Usage records") {
            await expect(page.getByText(englishUiMessages["直接查看项目当前使用的模型路由、调用次数与 Token。供应商实际账单与本地调用审计分开显示。"], { exact: true })).toBeVisible();
            await expect(page.getByText(englishUiMessages["未知结果不会自动重试。只有具备对应不可变证据的任务才显示人工收口动作。"], { exact: true })).toBeVisible();
          }
          await expect(page.locator("main h1").first(), `${label} should retain a visible page title`).toBeVisible();
          await expectR02NoHorizontalOverflow(page, `project management ${label} (${appearance.language}/${appearance.theme})`);
        }
      }
    }
  });
}

test("knowledge and floating Ask AI preserve both drafts across tabs, modal transitions, and guarded close", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1680, height: 960 });
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  await signInIsolatedPersonalUser(page, `appearance-drafts-${suffix}`);
  const headers = { origin: new URL(page.url()).origin, "content-type": "application/json" };
  const sourceResponse = await page.request.post("/api/personal/knowledge", {
    headers,
    data: { title: `浮窗验收来源 ${suffix}`, content: `真实个人知识来源 ${suffix}。`, isDefaultMemory: false },
  });
  expect(sourceResponse.status()).toBe(201);
  await page.goto("/personal/knowledge");
  await expect(page.locator("main h1").first()).toBeVisible();

  const launcher = page.locator(".inquiry-launcher");
  const panel = page.getByRole("dialog", { name: "智能问答悬浮窗", exact: true });
  await expect(launcher).toBeVisible();
  await launcher.click();
  await expect(panel).toBeVisible();
  const question = panel.getByRole("textbox", { name: "输入问题", exact: true });
  await expect(question).toBeFocused();
  const questionDraft = `保留未发送的问答草稿 ${suffix}`;
  await question.fill(questionDraft);
  await question.focus();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(launcher).toBeFocused();
  await page.keyboard.press("Alt+j");
  await expect(panel).toBeVisible();
  await expect(question).toBeFocused();
  await expect(question).toHaveValue(questionDraft);
  await panel.getByRole("button", { name: "收起问答", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(launcher).toBeFocused();
  await launcher.click();
  await expect(panel).toBeVisible();
  await expect(question).toHaveValue(questionDraft);

  const questionHandle = await question.elementHandle();
  const questionSelector = '#global-inquiry-panel textarea[aria-label="输入问题"]';
  await expectSameConnectedNode(questionHandle, questionSelector, "Ask AI question");

  const knowledgeTabs = page.getByRole("navigation", { name: "知识栏目", exact: true });
  await knowledgeTabs.getByRole("button", { name: "通用记忆", exact: true }).click();
  await expect(knowledgeTabs.getByRole("button", { name: "通用记忆", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expectSameConnectedNode(questionHandle, questionSelector, "Ask AI question after changing knowledge tab");
  await knowledgeTabs.getByRole("button", { name: "全部知识", exact: true }).click();
  await expect(knowledgeTabs.getByRole("button", { name: "全部知识", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(question).toHaveValue(questionDraft);

  await page.locator('header[class*="heading"]').getByRole("button", { name: "新建知识", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "新建知识", exact: true });
  await expect(editor).toBeVisible();
  await expect.poll(() => panel.evaluate(node => node.matches(":modal"))).toBe(false);
  await expect(editor.locator("[data-dialog-body]")).toHaveCSS("visibility", "visible");
  const title = editor.getByRole("textbox", { name: "标题", exact: true });
  await title.click();
  await expect(title).toBeFocused();
  await expect(panel).toBeVisible();
  await expect(question).toHaveValue(questionDraft);
  await panel.getByRole("button", { name: "收起问答", exact: true }).click();
  await expect(panel).toBeHidden();
  const body = editor.getByRole("textbox", { name: /^正文/u });
  const titleDraft = `新知识草稿标题 ${suffix}`;
  const bodyDraft = `新知识草稿正文 ${suffix}，当前不会提交或调用外部模型。`;
  await title.fill(titleDraft);
  await body.fill(bodyDraft);
  const titleHandle = await title.elementHandle();
  const titleSelector = 'dialog[data-variant="create"] input[required]';
  await expectSameConnectedNode(questionHandle, questionSelector, "Ask AI question when the editor opens");
  await expectSameConnectedNode(titleHandle, titleSelector, "knowledge title");
  await expectR02NoAccessibilityViolations(page, "new personal-knowledge editor dialog");

  await launcher.click();
  await expect(panel).toBeVisible();
  await expect(question).toBeFocused();
  await panel.getByRole("button", { name: "收起问答", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(launcher).toBeFocused();
  await expect(title).toHaveValue(titleDraft);
  await expect(body).toHaveValue(bodyDraft);
  await expectSameConnectedNode(titleHandle, titleSelector, "knowledge title while returning to the form");
  await launcher.click();
  await expect(panel).toBeVisible();
  await expect(question).toHaveValue(questionDraft);
  await expectSameConnectedNode(questionHandle, questionSelector, "Ask AI question after returning from the form");
  await panel.getByRole("button", { name: "收起问答", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(title).toHaveValue(titleDraft);
  await expect(body).toHaveValue(bodyDraft);
  await expectSameConnectedNode(questionHandle, questionSelector, "Ask AI question after closing the floating panel");

  const editorBounds = await editor.boundingBox();
  expect(editorBounds).not.toBeNull();
  const backdropX = editorBounds!.x >= 20
    ? Math.max(1, Math.floor(editorBounds!.x / 2))
    : Math.min(1678, Math.ceil(editorBounds!.x + editorBounds!.width + 12));
  await page.mouse.click(backdropX, 480);
  const discardConfirmation = page.getByRole("dialog", { name: "离开编辑页面？", exact: true });
  await expect(discardConfirmation).toBeVisible();
  await expectR02NoAccessibilityViolations(page, "unsaved knowledge discard confirmation");
  await discardConfirmation.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(title).toHaveValue(titleDraft);
  await expect(body).toHaveValue(bodyDraft);

  await page.keyboard.press("Escape");
  await expect(discardConfirmation).toBeVisible();
  await discardConfirmation.getByRole("button", { name: "继续编辑", exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(title).toHaveValue(titleDraft);
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  await expect(discardConfirmation).toBeVisible();
  await discardConfirmation.getByRole("button", { name: "放弃修改并离开", exact: true }).click();
  await expect(page.locator('dialog[aria-labelledby="knowledge-modal-title"]')).toBeHidden();
  await launcher.click();
  await expect(panel).toBeVisible();
  await expect(question).toHaveValue(questionDraft);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
});

test("usage details keep native modal focus, close on Escape and backdrop, and place Ask AI in the secondary footer", async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 960 });
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  await signInIsolatedPersonalUser(page, `appearance-usage-${suffix}`);
  // A read-only UI fixture exercises the drawer without generating a model call.
  // Real ledger ownership, revoked access and filters are covered by the PG gate.
  const usage = { status: "known", requestCount: 1, knownRequestCount: 1, unknownRequestCount: 0, inputTokens: 120, outputTokens: 80, totalTokens: 200 };
  await page.route("**/api/personal/usage?*", async route => {
    await route.fulfill({ json: { usage: { summary: usage, entries: [{
      id: randomUUID(), source: "unifiedQuestion", occurredAt: new Date().toISOString(), status: "succeeded",
      modelId: "local-ui-acceptance", operation: "unifiedQuestion", scope: "all", project: null, usage,
    }], nextCursor: null } } });
  });
  await page.goto("/personal/usage");
  const trigger = page.locator("tbody").getByRole("button").first();
  await trigger.click();
  const details = page.getByRole("dialog", { name: "用量详情", exact: true });
  await expect(details).toBeVisible();
  await expect(details.getByRole("button", { name: "关闭窗口", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  expect(await details.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await expectR02NoAccessibilityViolations(page, "usage details native drawer");
  const ask = details.locator(".inquiry-launcher");
  await expect(ask).toBeVisible();
  const bounds = await ask.boundingBox();
  const header = await details.locator("[data-dialog-header]").boundingBox();
  const footer = await details.locator("[data-inquiry-footer]").boundingBox();
  expect(bounds).not.toBeNull(); expect(header).not.toBeNull(); expect(footer).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(footer!.y);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(footer!.y + footer!.height);
  expect(bounds!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
  await expect(details.locator("[data-dialog-header] .inquiry-launcher")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(details).toBeVisible();
  await page.mouse.click(300, 480);
  await expect(details).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("credits membership stays independent of usage filters and preserves confirmation keys and drafts (isolated UI fixtures)", async ({ page }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  await signInIsolatedPersonalUser(page, `credit-ui-${randomUUID().slice(0, 10)}`);
  const initial = await page.request.get("/api/credits?range=7d&timezone=UTC");
  expect(initial.ok()).toBeTruthy();
  const { report } = await initial.json();
  report.summary.membership = { status: "none", startsAt: null, expiresAt: null, version: null };
  report.membershipApplication = null;
  await page.route("**/api/credits?**", route => route.fulfill({ json: { report } }));
  const previewBodies: Array<{ requestKey: string; reason: string }> = [];
  const executionKeys: string[] = [];
  let releasePreview: (() => void) | undefined;
  let holdPreview: Promise<void> | null = null;
  let executionMode: "expired" | "uncertain" | "success" = "expired";
  await page.route("**/api/profile/membership-applications/preview", async route => {
    const body = route.request().postDataJSON(); previewBodies.push(body);
    if (holdPreview) await holdPreview;
    await route.fulfill({ json: { application: null, preview: { id: randomUUID(), action: "submit", applicationId: null, requestKey: body.requestKey, requestFingerprint: "request-proof", impactFingerprint: "impact-proof", issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString(), reason: body.reason } } });
  });
  await page.route("**/api/profile/membership-applications/execute", async route => {
    executionKeys.push(route.request().postDataJSON().requestKey);
    if (executionMode === "expired") {
      await route.fulfill({ status: 409, json: { error: { code: "MEMBERSHIP_APPLICATION_PREVIEW_EXPIRED" } } });
    } else if (executionMode === "uncertain") {
      await route.abort("failed");
    } else {
      report.membershipApplication = { id: randomUUID(), status: "pending", statusVersion: 1, submittedAt: new Date().toISOString(), fulfilledAt: null, rejectedAt: null, withdrawnAt: null };
      await route.fulfill({ json: { application: report.membershipApplication } });
    }
  });
  await page.goto("/credits");
  await expect(page.getByRole("heading", { name: "每日用量", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "自定义", exact: true }).click();
  await expect(page.getByLabel("账单开始日期", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: /^查看会员资格/u }).click();
  const dialog = page.getByRole("dialog", { name: "会员信息", exact: true });
  const reason = dialog.getByRole("textbox", { name: "申请说明", exact: true });
  await reason.fill("用于项目协作与资料整理");
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: /^查看会员资格/u }).click();
  await expect(reason).toHaveValue("用于项目协作与资料整理");
  await expect(reason).toBeEnabled();
  holdPreview = new Promise<void>(resolve => { releasePreview = resolve; });
  try {
    await dialog.getByRole("button", { name: "预览申请", exact: true }).click();
    await expect.poll(() => previewBodies.length).toBe(1);
    await expect(reason).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
  } finally { releasePreview?.(); holdPreview = null; }
  await expect(dialog.getByRole("button", { name: "确认并执行", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "确认并执行", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("申请说明已保留");
  await expect(reason).toHaveValue("用于项目协作与资料整理");
  await dialog.getByRole("button", { name: "预览申请", exact: true }).click();
  await expect.poll(() => previewBodies.length).toBe(2);
  expect(previewBodies[1].requestKey).not.toBe(previewBodies[0].requestKey);
  executionMode = "uncertain";
  await dialog.getByRole("button", { name: "确认并执行", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "确认并执行", exact: true })).toBeEnabled();
  executionMode = "success";
  await dialog.getByRole("button", { name: "确认并执行", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "申请已提交" })).toBeVisible();
  expect(executionKeys).toHaveLength(3);
  expect(executionKeys[1]).toBe(executionKeys[2]);
  await expect(dialog.getByText("等待管理员处理", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await expectR02NoHorizontalOverflow(page, "narrow credits page");
  await page.getByRole("button", { name: /^查看会员资格/u }).click();
  await expect(dialog).toBeVisible();
  await expectR02NoHorizontalOverflow(page, "narrow membership dialog");
  await page.screenshot({ path: "test-results/user-appearance/credits-membership-narrow.png" });
});

test("Git creation waits for its real provider catalog before accepting a click", async ({ page }) => {
  test.setTimeout(60_000);
  await signInIsolatedPersonalUser(page, `git-ready-${randomUUID().slice(0, 10)}`);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route("**/api/me/git-connections", async route => { requested = true; await held; await route.continue(); });
  try {
    await page.goto("/personal/connections/git");
    await expect.poll(() => requested).toBe(true);
    const add = page.getByRole("button", { name: "添加 Git 服务", exact: true });
    await expect(add).toBeDisabled();
    release();
    await expect(add).toBeEnabled();
    await add.click();
    const dialog = page.getByRole("dialog", { name: "添加 Git 服务", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "添加 Git 服务", exact: true })).toHaveCount(1);
    await expect(dialog.locator("[data-dialog-body] > section")).toHaveCSS("padding-left", "0px");
    const palette = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--app-accent").trim());
    const expectedColor = await page.evaluate(color => { const element = document.createElement("div"); element.style.color = color; document.body.append(element); const resolved = getComputedStyle(element).color; element.remove(); return resolved; }, palette);
    await expect(dialog.getByRole("button", { name: "测试连接", exact: true })).toHaveCSS("background-color", expectedColor);
  } finally { release(); }
});

test("project memory shows its real project title while the index projection is pending", async ({ page }) => {
  test.setTimeout(60_000);
  const suffix = randomUUID().slice(0, 10);
  await signInIsolatedPersonalUser(page, `memory-ready-${suffix}`);
  const projectId = await createBrowserSources(page, suffix);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route(`**/api/projects/${projectId}/memory/status`, async route => { requested = true; await held; await route.continue(); });
  try {
    await page.goto(`/projects/${projectId}/memory`);
    await expect.poll(() => requested).toBe(true);
    await expect(page.getByRole("heading", { name: `外观验收项目 ${suffix}`, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "项目语义索引", exact: true })).toHaveCount(0);
    release();
    await expect(page.getByRole("heading", { name: "项目语义索引", exact: true })).toBeVisible({ timeout: 15_000 });
    const nextProject = await createBrowserSources(page, `${suffix}-next`);
    let releaseStale!: () => void;
    const stale = new Promise<void>(resolve => { releaseStale = resolve; });
    let staleRequested = false, aborted = false;
    page.on("requestfailed", request => { if (request.url().endsWith(`/api/projects/${projectId}/memory/status`)) aborted = true; });
    await page.route(`**/api/projects/${projectId}/memory/status`, async route => { staleRequested = true; await stale; await route.continue().catch(() => undefined); });
    try {
      await page.reload();
      await expect.poll(() => staleRequested).toBe(true);
      await page.getByRole("link", { name: "返回 AI 工作台", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/intelligence$`, "u"));
      await expect.poll(() => aborted).toBe(true);
      releaseStale();
      await page.goto(`/projects/${nextProject}/memory`);
      await expect(page.getByRole("heading", { name: `外观验收项目 ${suffix}-next`, exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "项目语义索引", exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("heading", { name: `外观验收项目 ${suffix}`, exact: true })).toHaveCount(0);
    } finally { releaseStale(); }
    let failStatus = true;
    await page.route(`**/api/projects/${nextProject}/memory/status`, async route => {
      if (failStatus) { failStatus = false; await route.fulfill({ status: 503, json: { error: { code: "SERVICE_UNAVAILABLE" } } }); }
      else await route.continue();
    });
    await page.reload();
    await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText("智能记忆加载失败");
    await expect(page.locator(".animate-pulse")).toHaveCount(0);
    await expectR02NoAccessibilityViolations(page, "memory read error and retry");
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await expect(page.getByRole("heading", { name: "项目语义索引", exact: true })).toBeVisible({ timeout: 15_000 });
  } finally { release(); }
});

test("dashboard feedback keeps direct actions, title counts, independent graph and top-layer Ask (isolated UI fixtures)", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  await page.setViewportSize({ width: 1680, height: 944 });
  const suffix = randomUUID().slice(0, 8);
  await signInIsolatedPersonalUser(page, `feedback-${suffix}`);
  await expect(page.getByRole("link", { name: /先选择项目/u })).toHaveAttribute("href", "/projects");
  const headers = { origin: new URL(page.url()).origin, "content-type": "application/json" };
  const created = await page.request.post("/api/projects", { headers, data: { name: `UI feedback ${suffix}`, description: "Isolated browser acceptance" } });
  expect(created.status()).toBe(201);
  const { project } = await created.json() as { project: { id: string; name: string } };
  await page.request.post("/api/personal/knowledge", { headers, data: { title: `UI source ${suffix}`, content: "This is a disposable source for client interaction checks.", isDefaultMemory: false } });
  // Keep authenticated projects and workspace APIs real; only an attention
  // signal is a presentation fixture, with no job or external model execution.
  await page.route("**/api/dashboard?*", async route => {
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({ json: { ...payload, operations: [], worlds: [], projects: payload.projects.map((entry: { pendingReviewCount: number }) => ({ ...entry, pendingReviewCount: 0 })), recentJobs: [{ id: randomUUID(), kind: "autoExtract", status: "failed", stage: "failed", failureCode: "UI_FIXTURE", reconciliationRequired: false, createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), attempts: [], project }] } });
  });
  await page.goto("/dashboard");
  await page.locator("#user-shell-project-picker").selectOption(project.id);
  await page.goto("/dashboard");
  const addSource = page.getByRole("link", { name: /添加项目资料/u });
  await expect(addSource).toHaveAttribute("href", `/projects/${project.id}/materials?view=add`);
  const attention = page.locator('section[aria-labelledby="attention-heading"]');
  const common = page.locator('aside[aria-labelledby="common-actions-heading"]');
  const badge = attention.getByLabel("1 项待处理", { exact: true });
  await expect(badge).toBeVisible();
  expect(await badge.evaluate(node => node.parentElement?.contains(document.querySelector("#attention-heading")))).toBe(true);
  const red = await badge.evaluate(node => getComputedStyle(node).color.match(/[\d.]+/g)?.map(Number));
  expect(red![0]).toBeGreaterThan(red![1]);
  const bounds = await Promise.all([attention.boundingBox(), common.boundingBox(), attention.locator("h2").boundingBox(), common.locator("h2").boundingBox()]);
  expect(Math.abs(bounds[0]!.y - bounds[1]!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(bounds[0]!.y + bounds[0]!.height - bounds[1]!.y - bounds[1]!.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(bounds[2]!.y - bounds[3]!.y)).toBeLessThanOrEqual(1);
  const surfaces = await Promise.all([attention, common, attention.locator('a').filter({ has: page.locator('strong') }).first(), common.getByRole('link', { name: /添加项目资料/u })].map(locator => locator.evaluate(node => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, border: style.border, radius: style.borderRadius };
  })));
  expect(surfaces[0]).toEqual(surfaces[1]);
  expect(surfaces[2]).toEqual(surfaces[3]);
  const cardActionBounds = await Promise.all([attention.getByRole('link', { name: '通知中心', exact: true }).boundingBox(), common.getByRole('link', { name: '了解使用流程', exact: true }).boundingBox()]);
  expect(Math.abs(cardActionBounds[0]!.y - cardActionBounds[1]!.y)).toBeLessThanOrEqual(1);
  const rightInsets = cardActionBounds.map((action, index) => bounds[index]!.x + bounds[index]!.width - action!.x - action!.width);
  expect(Math.abs(rightInsets[0] - rightInsets[1])).toBeLessThanOrEqual(1);
  for (let index = 0; index < cardActionBounds.length; index += 1) {
    expect(cardActionBounds[index]!.y - bounds[index]!.y).toBeLessThanOrEqual(48);
  }
  await expect(common.getByText("选择一个入口，开始今天的工作。", { exact: true })).toBeVisible();
  const actionCards = common.locator('a').filter({ has: page.locator('strong') });
  await expect(actionCards).toHaveCount(2);
  await expect(common.getByRole("link", { name: /发起智能问答/u })).toHaveCount(0);
  for (const card of await actionCards.all()) {
    await expect(card.locator('svg[aria-hidden="true"]')).toHaveCount(2);
    expect((await card.boundingBox())!.height).toBeGreaterThanOrEqual(66);
  }
  await expectR02NoAccessibilityViolations(page, "dashboard feedback actions and count");
  await mkdir("test-results/ui-feedback", { recursive: true });
  await page.screenshot({ path: "test-results/ui-feedback/dashboard.png" });

  const shellHeader = page.locator("[data-user-shell-root] header");
  const headerBefore = await shellHeader.boundingBox();
  const accountBefore = await page.locator("[data-user-shell-root]").getByRole("button", { name: "账户菜单", exact: true }).boundingBox();
  expect(headerBefore).not.toBeNull();
  expect(accountBefore).not.toBeNull();
  await page.locator(".inquiry-launcher").click();
  const question = page.locator("#global-inquiry-panel");
  await expect(question).toBeVisible();
  await expect(question.getByRole("textbox", { name: "输入问题", exact: true })).toBeVisible();
  await question.getByRole("button", { name: "并排停靠", exact: true }).click();
  await expect.poll(() => page.locator("body").getAttribute("class")).toContain("inquiry-docked");
  expect(await shellHeader.boundingBox()).toEqual(headerBefore);
  expect(await page.locator("[data-user-shell-root]").getByRole("button", { name: "账户菜单", exact: true }).boundingBox()).toEqual(accountBefore);
  await page.screenshot({ path: "test-results/ui-feedback/docked-header.png" });
  await question.getByRole("button", { name: "恢复悬浮", exact: true }).click();
  const expand = question.getByRole("button", { name: "放大窗口", exact: true });
  const fullPage = question.getByRole("link", { name: "在完整页面打开", exact: true });
  expect(await expand.locator("svg").innerHTML()).not.toBe(await fullPage.locator("svg").innerHTML());
  await expand.hover();
  await expect(expand.getByRole("tooltip")).toBeVisible();
  await expand.focus();
  await page.keyboard.press("Tab");
  await expect(fullPage).toBeFocused();
  await expect(fullPage.getByRole("tooltip")).toBeVisible();
  const input = question.getByRole("textbox", { name: "输入问题", exact: true });
  await input.fill("Discard this unsent question");
  await question.getByRole("button", { name: "新建会话", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await expect(question.getByRole("status").filter({ hasText: "新会话已准备好" })).toBeVisible();
  await page.keyboard.press("Alt+j");
  await expect(question).toBeHidden();

  await common.getByRole("link", { name: /新建个人知识/u }).click();
  const editor = page.getByRole("dialog", { name: "新建知识", exact: true });
  await expect(editor).toBeVisible();
  const title = editor.getByRole("textbox", { name: "标题", exact: true });
  await title.fill("Isolated unsaved form draft");
  await editor.locator(".inquiry-launcher").click();
  await expect.poll(() => question.evaluate(node => node.matches(":modal"))).toBe(false);
  await expect(editor.locator("[data-dialog-body]")).toHaveCSS("visibility", "visible");
  await title.click();
  await expect(title).toBeFocused();
  await expect(question).toBeVisible();
  await expectR02NoAccessibilityViolations(page, "Ask above personal knowledge editor");
  await question.getByRole("textbox", { name: "输入问题", exact: true }).press("Escape");
  await expect(question).toBeHidden();
  await expect(title).toHaveValue("Isolated unsaved form draft");
  await expect(editor.locator(".inquiry-launcher")).toBeFocused();
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("dialog", { name: "离开编辑页面？", exact: true }).getByRole("button", { name: "放弃修改并离开", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "知识栏目", exact: true }).getByRole("link", { name: "知识图谱", exact: true })).toHaveCount(0);
  await page.goto("/personal/knowledge/graph");
  await expect(page.getByRole("heading", { name: "知识图谱", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "我的知识栏目", exact: true })).toHaveCount(0);

  await page.goto(`/projects/${project.id}/memory-quality`);
  await expect(page.getByRole("heading", { name: "记忆质量与生命周期", exact: true })).toBeVisible();
  await expect(page.getByText("当前没有待处理质量问题", { exact: true })).toBeVisible();
  await page.goto(`/projects/${project.id}/governance`);
  await page.getByRole("tab", { name: "记忆质量", exact: true }).click();
  await expect(page.getByRole("heading", { name: "待处理问题", exact: true })).toBeVisible();
  await expect(page.getByText("当前没有待处理质量问题", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新检查", exact: true })).toBeEnabled();
  await expect(page).toHaveURL(/\/governance\?tab=quality$/u);
  // Tab content can settle before Next.js finishes updating navigation metadata.
  await expect(page).toHaveTitle("AI Project OS");
  await expectR02NoAccessibilityViolations(page, "shared quality client in project management");

  await page.goto("/personal/projects?create=1");
  const projectModal = page.getByRole("dialog", { name: "创建项目空间", exact: true });
  await projectModal.getByRole("textbox", { name: "项目名称", exact: true }).fill("Do not create this project");
  await expect(page.locator(".inquiry-launcher:visible")).toHaveCount(0);
  await page.keyboard.press("Alt+j");
  await expect(question).toBeHidden();
  await expect(projectModal.getByRole("textbox", { name: "项目名称", exact: true })).toHaveValue("Do not create this project");
  await projectModal.getByRole("button", { name: "取消", exact: true }).click();

  await page.goto("/dashboard");
  await selectAppearance(page, { language: "en", theme: "dark", closePopoverWith: "escape" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(common.getByText("Choose an entry to start your day.", { exact: true })).toBeVisible();
  await expect(common.getByText("Save methods, experience, and agreements", { exact: true })).toBeVisible();
  const narrowFooterBounds = await Promise.all([attention.getByRole('link', { name: 'Notifications', exact: true }).boundingBox(), common.getByRole('link', { name: 'Read the guide', exact: true }).boundingBox()]);
  expect(Math.abs(narrowFooterBounds[0]!.x + narrowFooterBounds[0]!.width - narrowFooterBounds[1]!.x - narrowFooterBounds[1]!.width)).toBeLessThanOrEqual(1);
  await expectR02NoHorizontalOverflow(page, "reference dashboard cards English dark at 390px");
  await expectR02NoAccessibilityViolations(page, "reference dashboard cards English dark");
  await page.screenshot({ path: "test-results/ui-feedback/dashboard-en-dark-mobile.png", fullPage: true });
  await page.locator(".inquiry-launcher").click();
  await expect(question).toBeVisible();
  const mobile = await question.boundingBox();
  const available = await page.evaluate(() => document.documentElement.clientWidth);
  expect(mobile!.x).toBeGreaterThanOrEqual(0);
  expect(mobile!.x + mobile!.width).toBeLessThanOrEqual(available);
  await expectR02NoHorizontalOverflow(page, "feedback floating Ask at 390px");
  await expectR02NoAccessibilityViolations(page, "feedback floating Ask English dark");
  await page.screenshot({ path: "test-results/ui-feedback/question-en-dark-mobile.png" });
});
