import { AxeBuilder } from "@axe-core/playwright";
import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

export const R02_VIEWPORTS = [1440, 1024, 768, 390] as const;
export const R02_ADMIN_PASSWORD = "BrowserGate2026Password!";
export const R02_OWNER_PASSWORD = "BrowserOwner2026Password!";
const R02_WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

export const R02_PUBLIC_ROUTE_EXPECTATIONS = [
  ["/", "/dashboard"],
  ["/setup", "/dashboard"],
  ["/login", "/dashboard"],
  ["/accept-invitation", "/dashboard"],
  ["/privacy", "/privacy"],
  ["/terms", "/terms"],
  ["/help", "/help"],
  ["/connections", "/profile/connections/git"],
  ["/connections/mcp", "/profile/connections/mcp"],
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
  { path: "/admin", heading: "管理员总览", terminal: { kind: "text", name: "测量于", exact: false }, pendingTexts: ["正在读取就绪证据…", "正在读取默认路由状态…", "读取中…"] },
  { path: "/admin/models", heading: "平台模型", terminal: { kind: "text", name: "从左侧添加第一个模型供应商。" }, pendingTexts: ["读取中…"] },
  { path: "/admin/models/routes", heading: "平台模型", terminal: { kind: "text", name: "平台能力配置" }, pendingTexts: ["读取中…"] },
  { path: "/admin/credits", heading: "平台额度", terminal: { kind: "text", name: "平台额度治理" }, pendingTexts: ["读取中…"] },
  { path: "/admin/operations/probes", heading: "连接探测预算", terminal: { kind: "text", name: "平台连接探测预算" }, pendingTexts: ["读取中…"] },
  { path: "/admin/connectors/mcp", heading: "MCP 工具安全审核", terminal: { kind: "text", name: "当前没有候选记录" }, pendingTexts: ["正在读取安全快照…"] },
  { path: "/admin/users", heading: "用户运营", terminal: { kind: "text", name: "普通用户" }, pendingTexts: ["读取中…"] },
  { path: "/admin/users/memberships", heading: "会员资格管理", terminal: { kind: "text", name: "Git / MCP 私有连接与平台自动化属于独立配置", exact: false }, pendingTexts: ["读取中…"] },
  { path: "/admin/audit", heading: "审计中心", terminal: { kind: "text", name: "当前筛选", exact: false }, pendingTexts: ["正在读取审计快照…"] },
  { path: "/admin/operations/failures", heading: "失败与待对账收件箱", terminal: { kind: "text", name: "测量于", exact: false }, pendingTexts: ["正在读取安全异常…"] },
  { path: "/admin/operations/backups", heading: "生产备份与 COS 同步", terminal: { kind: "heading", name: "恢复演练证据" } },
  { path: "/admin/guide", heading: "管理员操作指南", terminal: { kind: "heading", name: "平台模型" } },
  { path: "/admin/account", heading: "管理员账户", terminal: { kind: "text", name: "维护平台管理员的登录资料与密码。" }, pendingTexts: ["读取中…"] },
] as const;

export function expectedR02AdminNavigationLinkCount(pathname: string): number {
  if (pathname === "/admin") return 1;
  if (pathname === "/admin/users" || pathname.startsWith("/admin/users/") || pathname === "/admin/credits") return 4;
  if (pathname.startsWith("/admin/models") || pathname === "/admin/operations/probes") return 4;
  if (pathname.startsWith("/admin/connectors/mcp") || pathname.startsWith("/admin/audit")) return 3;
  if (pathname.startsWith("/admin/operations/")) return 3;
  return 1;
}

const R02_PROJECT_PENDING_TEXTS = [
  "读取中…",
  "加载中…",
  "正在读取能力注册表…",
  "正在读取工具候选…",
] as const;

export function r02ProjectRoutes(projectId: string, projectName: string): readonly R02RouteExpectation[] {
  return [
    { path: `/projects/${projectId}`, heading: projectName, terminal: { kind: "heading", name: "项目当前状态" }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/plan`, heading: projectName, terminal: { kind: "heading", name: "项目目标" }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/materials`, heading: `${projectName} · 原始资料`, terminal: { kind: "heading", name: "原始资料来源库" }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/materials/review`, heading: "审核 AI 候选", terminal: { kind: "text", name: "当前没有待审核 AI 候选", exact: false }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/intelligence`, heading: `${projectName} · AI 工作台`, terminal: { kind: "heading", name: "当前 AI 能力" }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/memory`, heading: projectName, terminal: { kind: "heading", name: "项目语义索引" }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/memory-quality`, heading: "记忆质量与生命周期", terminal: { kind: "text", name: "当前没有待处理质量问题" }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/automations`, heading: "项目自动化", terminal: { kind: "text", name: "还没有可运行的自动化规则。", exact: false }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/governance`, heading: "项目管理", terminal: { kind: "heading", name: "AI 用量与计费" }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/actions`, heading: "动作与审批", terminal: { kind: "text", name: "还没有动作", exact: false }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/control`, heading: projectName, terminal: { kind: "heading", name: "项目模型使用方式" }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/assets`, heading: `${projectName} · 文件资料`, terminal: { kind: "text", name: "还没有文件。", exact: false }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/external-sources`, heading: "外部资料入口", terminal: { kind: "text", name: "还没有网页来源", exact: false }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
    { path: `/projects/${projectId}/repositories`, heading: "项目 Git 委托", terminal: { kind: "text", name: "还没有项目 Git 委托" }, pendingTexts: R02_PROJECT_PENDING_TEXTS },
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
  await expect(page).toHaveURL(/\/(?:onboarding|admin)$/u);
  if (new URL(page.url()).pathname === "/onboarding") {
    await page.getByLabel("Owner 用户名", { exact: true }).fill("browser_owner");
    await page.getByLabel("初始密码", { exact: true }).fill("BrowserOwner2026Password!");
    await page.getByLabel("确认密码", { exact: true }).fill("BrowserOwner2026Password!");
    await page.getByRole("button", { name: "创建 Owner 并进入管理后台", exact: true }).click();
  }
  await expect(page).toHaveURL(/\/admin$/u);
}

export async function signInR02Admin(page: Page): Promise<void> {
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/(?:setup|login|onboarding|admin)$/u);
  const pathname = new URL(page.url()).pathname;
  if (pathname === "/setup") {
    await page.getByLabel("用户名", { exact: true }).fill("browser_admin");
    await page.getByLabel("密码", { exact: true }).fill(R02_ADMIN_PASSWORD);
    await page.getByLabel("再次输入密码", { exact: true }).fill(R02_ADMIN_PASSWORD);
    await page.getByRole("button", { name: "创建管理员并进入", exact: true }).click();
  } else if (pathname === "/login") {
    await page.getByLabel("用户名", { exact: true }).fill("browser_admin");
    await page.getByLabel("密码", { exact: true }).fill(R02_ADMIN_PASSWORD);
    await page.getByRole("button", { name: "登 录", exact: true }).click();
  }
  await settleR02Admin(page);
}

export async function signInR02Owner(page: Page): Promise<void> {
  await page.goto("/login");
  await expect(page).toHaveURL(/\/login$/u);
  await page.getByLabel("用户名", { exact: true }).fill("browser_owner");
  await page.getByLabel("密码", { exact: true }).fill(R02_OWNER_PASSWORD);
  await page.getByRole("button", { name: "登 录", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/u);
}

export async function expectR02NoHorizontalOverflow(page: Page, surface: string): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(dimensions.documentWidth, `${surface} document must not overflow`).toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(dimensions.bodyWidth, `${surface} body must not overflow`).toBeLessThanOrEqual(dimensions.viewportWidth);
}

export async function expectR02SettledRoute(page: Page, route: R02RouteExpectation, surface: string): Promise<void> {
  await expect(page.getByRole("heading", { name: route.heading, exact: true }).first(), `${surface} heading`).toBeVisible();
  const terminal = route.terminal.kind === "heading"
    ? page.getByRole("heading", { name: route.terminal.name, exact: true })
    : page.getByText(route.terminal.name, { exact: route.terminal.exact ?? true });
  await expect(route.terminal.kind === "heading" ? terminal.first() : terminal.last(), `${surface} terminal content`).toBeVisible();
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

export async function expectR02NoAccessibilityViolations(page: Page, surface: string): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(R02_WCAG_TAGS).analyze();
  const violations = result.violations.map((violation) => ({
    help: violation.help,
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.map((node) => node.target),
  }));
  expect(violations, `${surface} must satisfy automated WCAG 2.2 A/AA checks`).toEqual([]);
}

export async function expectR02MobileDrawer(page: Page, pathname = "/admin"): Promise<void> {
  const trigger = page.getByRole("button", { name: "打开导航", exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const drawer = page.getByRole("dialog", { name: "管理工作台导航" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("link")).toHaveCount(expectedR02AdminNavigationLinkCount(pathname));
  const close = drawer.getByRole("button", { name: "关闭管理导航", exact: true });
  await expect(close).toBeFocused();
  const focusable = drawer.locator('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
  await page.keyboard.down("Shift");
  await page.keyboard.press("Tab");
  await page.keyboard.up("Shift");
  await expect(focusable.last()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
}
