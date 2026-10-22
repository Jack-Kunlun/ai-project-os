import { AxeBuilder } from "@axe-core/playwright";
import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import type { BrowserPersonalUser } from "./browser-fixtures";
import { settleVisualState } from "./settle-visual-state";

export const R02_VIEWPORTS = [1440, 1024, 768, 390] as const;
export const R02_ADMIN_PASSWORD = "BrowserGate2026Password!";
const R02_WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

export const R02_PUBLIC_ROUTE_EXPECTATIONS = [
  ["/", "/dashboard"],
  ["/setup", "/dashboard"],
  ["/login", "/dashboard"],
  ["/accept-invitation", "/dashboard"],
  ["/privacy", "/privacy"],
  ["/terms", "/terms"],
  ["/help", "/help"],
  ["/connections", "/personal/connections/git"],
  ["/connections/mcp", "/personal/connections/mcp"],
  ["/settings", "/dashboard"],
  ["/system/memberships", "/dashboard"],
  ["/system/operations", "/dashboard"],
] as const;

export type R02RouteExpectation = Readonly<{
  path: string;
  heading: string;
  terminal: Readonly<{ kind: "heading" | "text"; name: string; exact?: boolean }>;
  pendingTexts?: readonly string[];
}>;

export const R02_ADMIN_ROUTES: readonly R02RouteExpectation[] = [
  { path: "/admin", heading: "平台总览", terminal: { kind: "text", name: "测量于", exact: false }, pendingTexts: ["正在读取就绪证据…", "正在读取默认路由状态…", "读取中…"] },
  { path: "/admin/models", heading: "模型与能力", terminal: { kind: "heading", name: "供应商连接" }, pendingTexts: ["读取中…"] },
  { path: "/admin/models/routes", heading: "模型与能力", terminal: { kind: "heading", name: "能力分配" }, pendingTexts: ["读取中…"] },
  { path: "/admin/sms", heading: "短信服务", terminal: { kind: "text", name: "尚未配置短信供应商" }, pendingTexts: ["正在读取供应商配置…"] },
  { path: "/admin/credits", heading: "平台额度", terminal: { kind: "text", name: "平台额度治理" }, pendingTexts: ["读取中…"] },
  { path: "/admin/operations/probes", heading: "连接探测预算", terminal: { kind: "text", name: "平台连接探测预算" }, pendingTexts: ["读取中…"] },
  { path: "/admin/connectors/mcp", heading: "MCP 工具安全审核", terminal: { kind: "text", name: "当前没有候选记录" }, pendingTexts: ["正在读取安全快照…"] },
  { path: "/admin/users", heading: "用户运营", terminal: { kind: "text", name: "普通用户" }, pendingTexts: ["读取中…"] },
  { path: "/admin/users/memberships", heading: "会员资格管理", terminal: { kind: "text", name: "Git / MCP 私有连接与平台自动化属于独立配置", exact: false }, pendingTexts: ["读取中…"] },
  { path: "/admin/audit", heading: "审计中心", terminal: { kind: "text", name: "当前筛选", exact: false }, pendingTexts: ["正在读取审计快照…"] },
  { path: "/admin/operations/failures", heading: "失败与待对账收件箱", terminal: { kind: "text", name: "测量于", exact: false }, pendingTexts: ["正在读取安全异常…"] },
  { path: "/admin/operations/backups", heading: "生产备份与 COS 同步", terminal: { kind: "heading", name: "恢复演练证据" }, pendingTexts: ["正在读取服务器资源…", "刷新中…"] },
  { path: "/admin/guide", heading: "管理员操作指南", terminal: { kind: "heading", name: "2. 新增供应商：先测试后保存" } },
  { path: "/admin/account", heading: "管理员账户", terminal: { kind: "heading", name: "登录密码" }, pendingTexts: ["读取中…"] },
] as const;

export function expectedR02AdminNavigationLinkCount(pathname: string): number {
  return pathname.startsWith("/admin") ? 13 : 0;
}

const R02_PROJECT_PENDING_TEXTS = [
  "读取中…",
  "加载中…",
  "正在读取能力注册表…",
  "正在读取工具候选…",
] as const;

export function r02ProjectRoutes(projectId: string, projectName: string): readonly R02RouteExpectation[] {
  return [
    { path: `/projects/${projectId}`, heading: projectName, terminal: { kind: "heading", name: "当前目标" }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/plan`, heading: projectName, terminal: { kind: "heading", name: "项目计划" }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/materials`, heading: `${projectName} · 项目资料`, terminal: { kind: "heading", name: "资料来源" }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/materials/review`, heading: "审核 AI 候选", terminal: { kind: "text", name: "当前没有待核对的整理结果。" }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/intelligence`, heading: "简报与调查", terminal: { kind: "heading", name: "项目简报" }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/governance`, heading: "项目管理", terminal: { kind: "heading", name: "当前项目事实" }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/memory`, heading: projectName, terminal: { kind: "heading", name: "项目语义索引" }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/memory-quality`, heading: "记忆质量与生命周期", terminal: { kind: "text", name: "当前没有待处理质量问题" }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/automations`, heading: "项目自动化", terminal: { kind: "text", name: "还没有自动化规则。", exact: false }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/actions`, heading: "动作与审批", terminal: { kind: "text", name: "还没有动作", exact: false }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/control`, heading: projectName, terminal: { kind: "heading", name: "项目模型使用方式" }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/assets`, heading: `${projectName} · 文件资料`, terminal: { kind: "text", name: "还没有文件。", exact: false }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/external-sources`, heading: "外部资料入口", terminal: { kind: "text", name: "还没有网页来源", exact: false }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/repositories`, heading: "代码仓库", terminal: { kind: "text", name: "还没有仓库授权记录" }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/tools`, heading: "项目工具权限", terminal: { kind: "text", name: "当前没有可授权的 V2 工具。" }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/world`, heading: `${projectName} · 状态治理`, terminal: { kind: "text", name: "尚无当前有效事实" }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
  ];
}

export function r02ProjectGuardRoutes(projectId: string): string[] {
  const missingId = "00000000-0000-4000-8000-000000000002";
  return [
    `/projects/${projectId}/materials/sources/${missingId}`,
    `/projects/${projectId}/jobs/${missingId}`,
  ];
}

export async function settleR02Admin(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/admin$/u, { timeout: 15_000 });
}

export async function signInR02Admin(page: Page): Promise<void> {
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/(?:setup|login|admin)$/u);
  const pathname = new URL(page.url()).pathname;
  if (pathname === "/setup") {
    await page.getByLabel("用户名", { exact: true }).fill("browser_admin");
    await page.getByLabel("密码", { exact: true }).fill(R02_ADMIN_PASSWORD);
    await page.getByLabel("再次输入密码", { exact: true }).fill(R02_ADMIN_PASSWORD);
    await page.getByRole("button", { name: "创建管理员并进入", exact: true }).click();
  } else if (pathname === "/login") {
    await page.getByLabel(/^(?:用户名或手机号|用户名、手机号或已验证邮箱)$/u).fill("browser_admin");
    await page.getByLabel("密码", { exact: true }).fill(R02_ADMIN_PASSWORD);
    await page.getByRole("button", { name: "登 录", exact: true }).click();
  }
  await settleR02Admin(page);
}

export async function signInR02PersonalUser(page: Page, user: BrowserPersonalUser): Promise<void> {
  await page.goto("/login");
  await expect(page).toHaveURL(/\/login$/u);
  await page.getByLabel(/^(?:用户名或手机号|用户名、手机号或已验证邮箱)$/u).fill(user.username);
  await page.getByLabel("密码", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "登 录", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/u);
}

export async function signOutR02User(page: Page): Promise<void> {
  const logout = page.getByRole("button", { name: /^(退出|Sign out)$/u, exact: true });
  if (await logout.isVisible()) {
    await logout.click();
    await expect(page).toHaveURL(/\/login$/u);
    return;
  }

  const accountMenu = page.getByRole("button", { name: /^(账户菜单|Account menu)$/u, exact: true });
  await expect(accountMenu).toBeVisible();
  await accountMenu.click();
  await expect(logout).toBeVisible();
  await logout.click();
  await expect(page).toHaveURL(/\/login$/u);
}

export async function expectR02NoHorizontalOverflow(page: Page, surface: string): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  const overflowing = dimensions.documentWidth > dimensions.viewportWidth || dimensions.bodyWidth > dimensions.viewportWidth
    ? await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("body *")]
      .map((element) => ({ element, right: element.getBoundingClientRect().right }))
      .filter(({ right }) => right > window.innerWidth + 1)
      .sort((left, right) => right.right - left.right)
      .slice(0, 6)
      .map(({ element, right }) => ({ tag: element.tagName, className: typeof element.className === "string" ? element.className.slice(0, 120) : "", right: Math.round(right), text: element.textContent?.trim().slice(0, 80) ?? "" })))
    : [];
  expect(dimensions.documentWidth, `${surface} document must not overflow: ${JSON.stringify(overflowing)}`).toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(dimensions.bodyWidth, `${surface} body must not overflow: ${JSON.stringify(overflowing)}`).toBeLessThanOrEqual(dimensions.viewportWidth);
}

export async function expectR02SettledRoute(page: Page, route: R02RouteExpectation, surface: string): Promise<void> {
  await expect(page.getByRole("heading", { name: route.heading, exact: true }).first(), `${surface} heading`).toBeVisible();
  const terminal = route.terminal.kind === "heading"
    ? page.getByRole("heading", { name: route.terminal.name, exact: true })
    : page.getByText(route.terminal.name, { exact: route.terminal.exact ?? true });
  // Aggregate projections can finish after the independently rendered header. This checks readiness, not a latency budget.
  await expect(route.terminal.kind === "heading" ? terminal.first() : terminal.last(), `${surface} terminal content`).toBeVisible({ timeout: 15_000 });
  for (const pendingText of route.pendingTexts ?? []) {
    await expect(page.getByText(pendingText, { exact: true }), `${surface} must complete ${pendingText}`).toHaveCount(0);
  }
  await expect(page.locator('[aria-label^="正在加载"], [aria-label^="正在读取"]'), `${surface} must leave labelled loading states`).toHaveCount(0);
  await expect(page.locator(".animate-pulse"), `${surface} must leave loading skeletons`).toHaveCount(0);
  await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)'), `${surface} must not settle into a soft error`).toHaveCount(0);
}

export async function expectR02InViewport(page: Page, locator: Locator, surface: string): Promise<void> {
  const [box, viewport] = await Promise.all([locator.boundingBox(), page.evaluate(() => ({ height: window.innerHeight, width: window.innerWidth }))]);
  expect(box, `${surface} must have a rendered box`).not.toBeNull();
  expect(box!.x + box!.width, `${surface} must intersect the horizontal viewport`).toBeGreaterThan(0);
  expect(box!.x, `${surface} must start before the horizontal viewport ends`).toBeLessThan(viewport.width);
  expect(box!.y + box!.height, `${surface} must intersect the vertical viewport`).toBeGreaterThan(0);
  expect(box!.y, `${surface} must start before the vertical viewport ends`).toBeLessThan(viewport.height);
}

export async function readR02AccessibilityViolations(page: Page) {
  await settleVisualState(page);
  const result = await new AxeBuilder({ page }).withTags(R02_WCAG_TAGS).analyze();
  return result.violations.map((violation) => ({
    help: violation.help,
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.map((node) => node.target),
    details: violation.nodes.map((node) => node.failureSummary),
  }));
}

export async function expectR02NoAccessibilityViolations(page: Page, surface: string): Promise<void> {
  expect(await readR02AccessibilityViolations(page), `${surface} must satisfy automated WCAG 2.2 A/AA checks`).toEqual([]);
}

export async function expectR02MobileDrawer(page: Page, pathname = "/admin"): Promise<void> {
  const trigger = page.getByRole("button", { name: "打开导航", exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const drawer = page.getByRole("dialog", { name: "管理工作台导航" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("navigation", { name: "管理工作台导航", exact: true }).getByRole("link")).toHaveCount(expectedR02AdminNavigationLinkCount(pathname));
  const close = drawer.getByRole("button", { name: "关闭窗口", exact: true });
  await expect(close).toBeFocused();
  const focusable = drawer.locator('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
  await focusable.first().focus();
  await page.keyboard.down("Shift");
  await page.keyboard.press("Tab");
  await page.keyboard.up("Shift");
  await expect(focusable.last()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(focusable.first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
}
