import { expectIconLabelAlignment } from "./support/icon-label-alignment";
import prototypeRoutes from "./support/prototype-route-catalog.json";
import { readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { englishUiMessages } from "@/lib/ui-dictionary-source";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { seedUiConsistencyDetailFixtures } from "./support/ui-consistency-fixtures";
import { expectR02NoHorizontalOverflow, signInR02Admin, signInR02PersonalUser } from "./support/r02-admin-navigation";

type MatrixRole = "admin" | "user" | "anonymous";
type MatrixMode = Readonly<{
  id: "zh-light-1440" | "zh-light-390" | "en-dark-1440" | "en-dark-390";
  language: "zh-CN" | "en";
  theme: "light" | "dark";
  width: 1440 | 390;
}>;
type DynamicIds = Readonly<Record<"projectId" | "userId" | "workspaceId" | "sourceId" | "jobId" | "syncRunId", string>>;
type MatrixRoute = Readonly<{ source: string; path: string; role: MatrixRole }>;
type MatrixEntry = Readonly<{
  mode: MatrixMode["id"];
  source: string;
  path: string;
  role: MatrixRole;
  status: number | null;
  finalPath: string;
  expectedPath: string;
  gatedNotFound: boolean;
  iconCount: number;
  prototype?: unknown;
  parentLinks: readonly string[];
  untranslatedSystemKeys: readonly string[];
  serverErrors: readonly Readonly<{ status: number; url: string }>[];
  outcome: "passed" | "failed";
  error?: string;
}>;
type ParentNavigationResult = Readonly<{
  mode: MatrixMode["id"];
  source: string;
  pagePath: string;
  role: MatrixRole;
  href: string;
  expectedUrl: string;
  actualUrl: string | null;
  outcome: "passed" | "failed";
  error?: string;
}>;

const MATRIX_MODES: readonly MatrixMode[] = [
  { id: "zh-light-1440", language: "zh-CN", theme: "light", width: 1440 },
  { id: "zh-light-390", language: "zh-CN", theme: "light", width: 390 },
  { id: "en-dark-1440", language: "en", theme: "dark", width: 1440 },
  { id: "en-dark-390", language: "en", theme: "dark", width: 390 },
];

const PUBLIC_ANONYMOUS_ROUTES = new Set([
  "/accept-invitation",
  "/contact",
  "/help",
  "/login",
  "/privacy",
  "/recover",
  "/register",
  "/setup",
  "/terms",
]);

const KNOWN_TRANSLATED_SYSTEM_KEYS = Object.entries(englishUiMessages)
  .filter(([key, value]) => key !== value && [...key].length >= 4 && /\p{Script=Han}/u.test(key))
  .map(([key]) => key);

const ROUTE_DESTINATIONS: Readonly<Record<string, Readonly<Partial<Record<MatrixRole, string>>>>> = {
  "/": { admin: "/admin", user: "/dashboard", anonymous: "/login" },
  "/accept-invitation": { anonymous: "/login" },
  "/setup": { admin: "/admin", user: "/dashboard", anonymous: "/login" },
  "/login": { admin: "/admin", user: "/dashboard" },
  "/register": { admin: "/admin", user: "/dashboard" },
  "/profile/models": { admin: "/admin", user: "/personal/models", anonymous: "/login" },
  "/profile/connections/git": { admin: "/admin", user: "/personal/connections/git", anonymous: "/login" },
  "/profile/connections/mcp": { admin: "/admin", user: "/personal/connections/mcp", anonymous: "/login" },
  "/projects": { admin: "/admin", user: "/personal/projects", anonymous: "/login" },
  "/connections": { admin: "/admin", user: "/personal/connections/git", anonymous: "/login" },
  "/connections/mcp": { admin: "/admin", user: "/personal/connections/mcp", anonymous: "/login" },
  "/settings": { admin: "/admin/models", user: "/dashboard", anonymous: "/login" },
  "/system/memberships": { admin: "/admin/users/memberships", user: "/dashboard", anonymous: "/login" },
  "/system/operations": { admin: "/admin/operations/backups", user: "/dashboard", anonymous: "/login" },
  "/system/account-access": { admin: "/admin/users", user: "/dashboard", anonymous: "/login" },
  "/admin/connectors/git": { admin: "/admin", user: "/dashboard", anonymous: "/login" },
  "/admin/models/routes": { admin: "/admin/models", user: "/dashboard", anonymous: "/login" },
  "/admin/models/governance": { admin: "/admin/models", user: "/dashboard", anonymous: "/login" },
};

function discoverAppPageRoutes(): MatrixRoute[] {
  const appRoot = join(process.cwd(), "src", "app");
  const pageFiles: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === "page.tsx") pageFiles.push(path);
    }
  };
  visit(appRoot);

  return pageFiles.sort().map((file) => {
    const source = relative(appRoot, file).split(sep).join("/");
    const routePattern = source === "page.tsx" ? "/" : `/${source.slice(0, -"/page.tsx".length)}`;
    const role: MatrixRole = routePattern.startsWith("/admin/") || routePattern === "/admin" || routePattern.startsWith("/system/") || routePattern === "/system"
      ? "admin"
      : PUBLIC_ANONYMOUS_ROUTES.has(routePattern)
        ? "anonymous"
        : "user";
    return { source: `src/app/${source}`, path: routePattern, role };
  });
}

function materializeRoute(route: MatrixRoute, ids: DynamicIds): string {
  return route.path.replace(/\[([^\]]+)\]/gu, (_placeholder, name: string) => {
    const value = ids[name as keyof DynamicIds];
    if (!value) throw new Error(`UI_MATRIX_FIXTURE_ID_MISSING:${name}:${route.source}`);
    return value;
  });
}

function expectedDestination(path: string, role: MatrixRole): string {
  return ROUTE_DESTINATIONS[path]?.[role] ?? path;
}

async function setAppearance(page: Page, origin: string, language: MatrixMode["language"], theme: MatrixMode["theme"]): Promise<void> {
  await page.context().addCookies([
    { name: "aipos-language", value: language, url: origin, sameSite: "Lax" },
    { name: "aipos-theme", value: theme, url: origin, sameSite: "Lax" },
  ]);
}

async function createProjectThroughPost(page: Page, workspaceId: string): Promise<Readonly<{ id: string; name: string }>> {
  const name = `UI Matrix Project ${randomUUID().slice(0, 8)}`;
  const response = await page.context().request.post(new URL("/api/projects", page.url()).toString(), {
    headers: { origin: new URL(page.url()).origin },
    data: { name, description: "Real isolated project for the all-route UI matrix.", workspaceId },
  });
  const responseBody = await response.text();
  expect(response.status(), responseBody).toBe(201);
  const payload = JSON.parse(responseBody) as { project?: { id?: string; name?: string } };
  expect(payload.project?.id).toMatch(/^[0-9a-f-]{36}$/iu);
  expect(payload.project?.name).toBe(name);
  return { id: payload.project!.id!, name };
}

async function readIconMetrics(page: Page): Promise<readonly Readonly<{ width: number; height: number; strokeWidth: string | null; spriteResolved: boolean }>[]> {
  return page.locator("svg.app-icon").evaluateAll((icons) => icons
    .filter((icon) => {
      const style = getComputedStyle(icon);
      return style.display !== "none" && style.visibility !== "hidden" && icon.getClientRects().length > 0;
    })
    .map((icon) => {
      const rect = icon.getBoundingClientRect();
      const reference = icon.querySelector("use")?.getAttribute("href");
      const target = reference?.startsWith("#") ? document.getElementById(reference.slice(1)) : null;
      return { width: rect.width, height: rect.height, strokeWidth: icon.getAttribute("stroke-width"), spriteResolved: Boolean(target?.querySelector("path")) };
    }));
}

async function readParentLinks(page: Page): Promise<readonly string[]> {
  const current = new URL(page.url());
  const links = page.locator("a.parent-page-link:visible");
  const values: string[] = [];
  for (let index = 0; index < await links.count(); index += 1) {
    const href = await links.nth(index).getAttribute("href");
    expect(href, `parent link ${index} on ${current.pathname} must have a destination`).toBeTruthy();
    expect(href, `parent link ${index} on ${current.pathname} must be an internal path`).toMatch(/^\//u);
    const destination = new URL(href!, current.origin);
    expect(destination.origin, `parent link ${href} on ${current.pathname} must stay in this application`).toBe(current.origin);
    expect(`${destination.pathname}${destination.search}${destination.hash}`, `parent link ${href} must not point to itself`).not.toBe(`${current.pathname}${current.search}${current.hash}`);
    values.push(href!);
  }
  return values;
}

async function exerciseParentLinks(input: Readonly<{
  page: Page;
  hrefs: readonly string[];
  origin: string;
  currentPath: string;
  source: string;
  role: MatrixRole;
  mode: MatrixMode["id"];
  results: ParentNavigationResult[];
  failures: Array<Readonly<{ mode: MatrixMode["id"]; source: string; path: string; role: MatrixRole; phase: "route" | "parent-navigation"; error: string }>>;
}>): Promise<void> {
  const { page, hrefs, origin, currentPath, source, role, mode, results, failures } = input;
  for (let index = 0; index < hrefs.length; index += 1) {
    const href = hrefs[index]!;
    const requested = new URL(href, origin);
    const expectedPath = expectedDestination(requested.pathname, role);
    const expectedUrl = `${expectedPath}${requested.search}${requested.hash}`;
    let actualUrl: string | null = null;
    try {
      const link = page.locator("a.parent-page-link:visible").nth(index);
      await expect(link, `${source}@${mode} parent link ${href} must remain visible`).toBeVisible();
      await link.click();
      await page.waitForURL((url) => `${url.pathname}${url.search}${url.hash}` === expectedUrl, { timeout: 15_000 });
      const destination = new URL(page.url());
      actualUrl = `${destination.pathname}${destination.search}${destination.hash}`;
      expect(actualUrl, `${source}@${mode} parent link must navigate to ${expectedUrl}`).toBe(expectedUrl);
      results.push({ mode, source, pagePath: currentPath, role, href, expectedUrl, actualUrl, outcome: "passed" });
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      actualUrl = `${new URL(page.url()).pathname}${new URL(page.url()).search}${new URL(page.url()).hash}`;
      results.push({ mode, source, pagePath: currentPath, role, href, expectedUrl, actualUrl, outcome: "failed", error });
      failures.push({ mode, source, path: currentPath, role, phase: "parent-navigation", error: `${href} → ${expectedUrl}: ${error}` });
    }

    if (index + 1 < hrefs.length) {
      try {
        await page.goto(currentPath, { waitUntil: "domcontentloaded" });
        await expect(page.locator("body"), `${source}@${mode} must restore the source page before testing its next parent link`).toBeVisible();
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        failures.push({ mode, source, path: currentPath, role, phase: "parent-navigation", error: `restore before ${hrefs[index + 1]}: ${error}` });
      }
    }
  }
}

async function readUntranslatedSystemKeys(page: Page): Promise<readonly string[]> {
  return page.evaluate((knownKeys) => {
    const keys = new Set(knownKeys);
    const candidates = new Set<string>();
    for (const element of document.querySelectorAll<HTMLElement>("body *")) {
      if (element.getAttribute("aria-hidden") === "true") continue;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (element.children.length === 0) {
        const text = (element.innerText ?? element.textContent ?? "").trim();
        if (text) candidates.add(text);
      }
      for (const attribute of ["aria-label", "title", "placeholder"] as const) {
        const value = element.getAttribute(attribute)?.trim();
        if (value) candidates.add(value);
      }
    }
    return [...candidates].filter((candidate) => keys.has(candidate)).sort();
  }, KNOWN_TRANSLATED_SYSTEM_KEYS);
}

async function assertUserShellInteractions(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  const openNavigation = page.getByRole("button", { name: "打开导航", exact: true });
  await openNavigation.click();
  const sidebarClose = page.locator('aside[aria-label="主导航"] button[aria-label="关闭导航"]');
  const backdrop = page.locator('button[aria-label="关闭导航"][tabindex="0"]');
  await expect(sidebarClose).toBeFocused();
  await expect(openNavigation).toHaveAttribute("aria-expanded", "true");
  await backdrop.click({ position: { x: 350, y: 400 } });
  await expect(openNavigation).toHaveAttribute("aria-expanded", "false");
  await expect(openNavigation).toBeFocused();
  await expect(page).toHaveURL(/\/dashboard$/u);

  await openNavigation.click();
  await expect(sidebarClose).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(openNavigation).toHaveAttribute("aria-expanded", "false");
  await expect(openNavigation).toBeFocused();

  const safeHeading = page.getByRole("heading", { name: "工作台", exact: true });
  const appearanceTrigger = page.getByRole("button", { name: "语言与外观", exact: true });
  await appearanceTrigger.click();
  await expect(page.getByRole("dialog", { name: "语言与外观", exact: true })).toBeVisible();
  await safeHeading.click({ position: { x: 4, y: 10 } });
  await expect(page.getByRole("dialog", { name: "语言与外观", exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/dashboard$/u);
  await appearanceTrigger.click();
  await page.keyboard.press("Escape");
  await expect(appearanceTrigger).toBeFocused();

  const accountTrigger = page.getByRole("button", { name: "账户菜单", exact: true });
  await accountTrigger.click();
  await expect(page.getByRole("link", { name: "账户设置", exact: true })).toBeVisible();
  await safeHeading.click({ position: { x: 4, y: 10 } });
  await expect(page.getByRole("link", { name: "账户设置", exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/dashboard$/u);
  await accountTrigger.click();
  await page.keyboard.press("Escape");
  await expect(accountTrigger).toBeFocused();
}

test("all page routes remain consistent across Chinese light and English dark desktop/mobile", async ({ browser }, testInfo) => {
  test.setTimeout(720_000);
  const routes = discoverAppPageRoutes();
  expect(routes, "route discovery must cover every current src/app/**/page.tsx page").toHaveLength(77);
  for (const route of routes) expect(prototypeRoutes[route.path as keyof typeof prototypeRoutes], `${route.path} needs an explicit prototype view or compatibility destination`).toBeDefined();

  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const userContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const anonymousContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const adminPage = await adminContext.newPage();
  const userPage = await userContext.newPage();
  const anonymousPage = await anonymousContext.newPage();
  const routePages: Readonly<Record<MatrixRole, Page>> = { admin: adminPage, user: userPage, anonymous: anonymousPage };
  const responseErrors = new Map<Page, Array<{ status: number; url: string }>>();
  for (const page of [adminPage, userPage, anonymousPage]) {
    responseErrors.set(page, []);
    page.on("response", (response) => {
      if (response.status() >= 500) responseErrors.get(page)!.push({ status: response.status(), url: response.url() });
    });
  }

  const matrix: MatrixEntry[] = [];
  const routeFailures: Array<Readonly<{ mode: MatrixMode["id"]; source: string; path: string; role: MatrixRole; phase: "route" | "parent-navigation"; error: string }>> = [];
  const parentNavigationResults: ParentNavigationResult[] = [];
  const guardResults: Array<Readonly<{ path: string; role: MatrixRole; status: number | null; finalPath: string; expectedPath: string }>> = [];
  const contexts: readonly BrowserContext[] = [adminContext, userContext, anonymousContext];
  const extraContexts: BrowserContext[] = [];
  const origin: { value: string | null } = { value: null };
  const fixtureIds: { value: DynamicIds | null } = { value: null };
  const fixtureDetails: { value: Awaited<ReturnType<typeof seedUiConsistencyDetailFixtures>> | null } = { value: null };
  try {
    await signInR02Admin(adminPage);
    origin.value = new URL(adminPage.url()).origin;
    const suffix = randomUUID().replaceAll("-", "").slice(0, 14);
    const user = await seedBrowserPersonalUser(`ui-matrix-${suffix}`, "UiMatrix2026Password!");
    await signInR02PersonalUser(userPage, user);
    const project = await createProjectThroughPost(userPage, user.workspaceId);
    const details = await seedUiConsistencyDetailFixtures(project.id, user.id);
    fixtureDetails.value = details;
    const ids: DynamicIds = {
      projectId: project.id,
      userId: user.id,
      workspaceId: user.workspaceId,
      sourceId: details.sourceId,
      jobId: details.jobId,
      syncRunId: details.syncRunId,
    };
    fixtureIds.value = ids;

    for (const mode of MATRIX_MODES) {
      for (const page of [adminPage, userPage, anonymousPage]) {
        await page.setViewportSize({ width: mode.width, height: mode.width === 390 ? 844 : 900 });
        await setAppearance(page, origin.value!, mode.language, mode.theme);
      }

      for (const route of routes) {
        const page = routePages[route.role];
        const path = materializeRoute(route, ids);
        const expectedPath = expectedDestination(route.path, route.role);
        const expectedFullPath = path === route.path ? expectedPath : expectedPath.replace(route.path, path);
        responseErrors.set(page, []);
        let status: number | null = null;
        let finalPath = path;
        let gatedNotFound = false;
        let iconCount = 0;
        let parentLinks: readonly string[] = [];
        let untranslatedSystemKeys: readonly string[] = [];
        let parentLinksAttempted = false;
        try {
          const response = await page.goto(path, { waitUntil: "domcontentloaded" });
          status = response?.status() ?? null;
          await expect(page.locator("body"), `${path} must render a body for ${route.role}/${mode.id}`).toBeVisible();
          await page.waitForTimeout(80);
          const finalUrl = new URL(page.url());
          finalPath = `${finalUrl.pathname}${finalUrl.search}`;
          gatedNotFound = route.path === "/projects/[projectId]/mcp-actions" || route.path === "/projects/[projectId]/mcp-export";

          if (!(gatedNotFound && status === 404)) {
            expect(status, `${path} (${route.source}) must render or redirect successfully in ${mode.id}`).toBeLessThan(400);
          }
          expect(finalUrl.pathname, `${path} (${route.role}) must reach its declared destination in ${mode.id}`).toBe(new URL(expectedFullPath, finalUrl.origin).pathname);
          expect(finalUrl.search, `${path} must preserve its destination query in ${mode.id}`).toBe(new URL(expectedFullPath, finalUrl.origin).search);
          await expect(page.locator("html")).toHaveAttribute("data-language", mode.language);
          await expect(page.locator("html")).toHaveAttribute("data-theme", mode.theme);
          await expectR02NoHorizontalOverflow(page, `${path}@${mode.id}`);

          const iconMetrics = await readIconMetrics(page);
          iconCount = iconMetrics.length;
          for (const icon of iconMetrics) {
            expect(Math.abs(icon.width - icon.height), `${path}@${mode.id} app-icon must be square`).toBeLessThanOrEqual(1.5);
            expect(icon.width, `${path}@${mode.id} app-icon must be visible`).toBeGreaterThan(0);
            expect(icon.spriteResolved, `every visible icon must resolve its server-rendered Tabler definition`).toBe(true);
            expect(icon.strokeWidth, `${path}@${mode.id} Tabler app-icon stroke`).toBe("1.75");
          }
          await expectIconLabelAlignment(page.locator("body"), `${path}@${mode.id}`);
          if (route.role !== "anonymous" && !gatedNotFound) {
            const geometry = await page.locator("h1").first().evaluate(heading => {
              let container = heading.parentElement;
              while (container && Number.parseFloat(getComputedStyle(container).paddingLeft) < 12) container = container.parentElement;
              if (!container) return null;
              const style = getComputedStyle(container);
              return { left:Number.parseFloat(style.paddingLeft), right:Number.parseFloat(style.paddingRight), width:container.getBoundingClientRect().width };
            });
            expect(geometry, `${path}@${mode.id} needs the shared prototype reading container`).not.toBeNull();
            expect(geometry!.left, `${path}@${mode.id} prototype left inset`).toBe(mode.width <= 700 ? 18 : 32);
            expect(geometry!.right, `${path}@${mode.id} prototype right inset`).toBe(mode.width <= 700 ? 18 : 32);
            expect(geometry!.width, `${path}@${mode.id} prototype maximum content width`).toBeLessThanOrEqual(1500);
          }
          parentLinks = await readParentLinks(page);
          untranslatedSystemKeys = mode.language === "en" ? await readUntranslatedSystemKeys(page) : [];
          expect(untranslatedSystemKeys, `${path}@${mode.id} must not leave exact translated dictionary keys in system UI`).toEqual([]);

          if (mode.id === "zh-light-1440" && path === "/dashboard") {
            await testInfo.attach("ui-matrix-dashboard-zh-light-1440.png", { body: await page.screenshot(), contentType: "image/png" });
          }
          if (mode.id === "en-dark-390" && path === "/admin") {
            await testInfo.attach("ui-matrix-admin-en-dark-390.png", { body: await page.screenshot(), contentType: "image/png" });
          }
          if (!gatedNotFound) await page.screenshot({path:testInfo.outputPath(`pages/${mode.id}/${route.path.replaceAll(/[^a-zA-Z0-9_-]/g,"_") || "index"}.png`)});
          parentLinksAttempted = true;
          await exerciseParentLinks({
            page,
            hrefs: parentLinks,
            origin: origin.value!,
            currentPath: path,
            source: route.source,
            role: route.role,
            mode: mode.id,
            results: parentNavigationResults,
            failures: routeFailures,
          });
          const parentFailure = routeFailures.find((failure) => failure.mode === mode.id && failure.source === route.source && failure.phase === "parent-navigation");
          if (parentFailure) throw new Error(parentFailure.error);
          const serverErrors = responseErrors.get(page) ?? [];
          expect(serverErrors, `${path}@${mode.id} and its parent links must not cause HTTP 5xx responses`).toEqual([]);

          matrix.push({
            mode: mode.id,
            source: route.source,
            path,
            role: route.role,
            status,
            finalPath,
            expectedPath: expectedFullPath,
            gatedNotFound: gatedNotFound && status === 404,
            iconCount,
            prototype: prototypeRoutes[route.path as keyof typeof prototypeRoutes],
            parentLinks,
            untranslatedSystemKeys,
            serverErrors,
            outcome: "passed",
          });
        } catch (cause) {
          const error = cause instanceof Error ? cause.message : String(cause);
          const finalUrl = new URL(page.url());
          finalPath = `${finalUrl.pathname}${finalUrl.search}`;
          const hasRecordedParentFailure = routeFailures.some((failure) => failure.mode === mode.id && failure.source === route.source && failure.phase === "parent-navigation");
          if (!hasRecordedParentFailure) routeFailures.push({ mode: mode.id, source: route.source, path, role: route.role, phase: "route", error });
          if (!parentLinksAttempted) {
            try {
              if (parentLinks.length === 0) parentLinks = await readParentLinks(page);
              parentLinksAttempted = true;
              await exerciseParentLinks({
                page,
                hrefs: parentLinks,
                origin: origin.value!,
                currentPath: path,
                source: route.source,
                role: route.role,
                mode: mode.id,
                results: parentNavigationResults,
                failures: routeFailures,
              });
            } catch (parentCause) {
              const parentError = parentCause instanceof Error ? parentCause.message : String(parentCause);
              routeFailures.push({ mode: mode.id, source: route.source, path, role: route.role, phase: "parent-navigation", error: parentError });
            }
          }
          matrix.push({
            mode: mode.id,
            source: route.source,
            path,
            role: route.role,
            status,
            finalPath,
            expectedPath: expectedFullPath,
            gatedNotFound: gatedNotFound && status === 404,
            iconCount,
            parentLinks,
            untranslatedSystemKeys,
            serverErrors: responseErrors.get(page) ?? [],
            outcome: "failed",
            error,
          });
        }
      }
    }

    // Compatibility routes with role-dependent destinations and permission
    // guards are exercised against the real project and actual user fixtures.
    const validInvitationToken = "A".repeat(40);
    const invitationPath = `/accept-invitation?token=${validInvitationToken}`;
    const guardCases: readonly Readonly<{ page: Page; path: string; expectedPath: string; expectedSearch?: string; expectedStatus?: number }>[] = [
      { page: userPage, path: "/admin", expectedPath: "/dashboard" },
      { page: adminPage, path: "/", expectedPath: "/admin" },
      { page: anonymousPage, path: "/", expectedPath: "/login" },
      { page: adminPage, path: "/login", expectedPath: "/admin" },
      { page: userPage, path: "/login", expectedPath: "/dashboard" },
      { page: adminPage, path: "/register", expectedPath: "/admin" },
      { page: userPage, path: "/register", expectedPath: "/dashboard" },
      { page: adminPage, path: "/setup", expectedPath: "/admin" },
      { page: userPage, path: "/setup", expectedPath: "/dashboard" },
      { page: adminPage, path: "/settings", expectedPath: "/admin/models" },
      { page: userPage, path: "/settings", expectedPath: "/dashboard" },
      { page: anonymousPage, path: "/settings", expectedPath: "/login" },
      { page: anonymousPage, path: "/dashboard", expectedPath: "/login" },
      { page: anonymousPage, path: "/projects", expectedPath: "/login" },
      { page: adminPage, path: "/projects", expectedPath: "/admin" },
      { page: anonymousPage, path: "/profile/models", expectedPath: "/login" },
      { page: adminPage, path: "/profile/models", expectedPath: "/admin" },
      { page: anonymousPage, path: "/profile/connections/git", expectedPath: "/login" },
      { page: adminPage, path: "/profile/connections/git", expectedPath: "/admin" },
      { page: anonymousPage, path: "/profile/connections/mcp", expectedPath: "/login" },
      { page: adminPage, path: "/profile/connections/mcp", expectedPath: "/admin" },
      { page: anonymousPage, path: "/connections", expectedPath: "/login" },
      { page: adminPage, path: "/connections", expectedPath: "/admin" },
      { page: anonymousPage, path: "/connections/mcp", expectedPath: "/login" },
      { page: adminPage, path: "/connections/mcp", expectedPath: "/admin" },
      { page: adminPage, path: "/system/account-access", expectedPath: "/admin/users" },
      { page: userPage, path: "/system/account-access", expectedPath: "/dashboard" },
      { page: anonymousPage, path: "/system/account-access", expectedPath: "/login" },
      { page: anonymousPage, path: "/system/memberships", expectedPath: "/login" },
      { page: anonymousPage, path: "/system/operations", expectedPath: "/login" },
      { page: adminPage, path: "/admin/connectors/git", expectedPath: "/admin" },
      { page: userPage, path: "/admin/connectors/git", expectedPath: "/dashboard" },
      { page: anonymousPage, path: "/admin/connectors/git", expectedPath: "/login" },
      { page: userPage, path: "/admin/models/routes", expectedPath: "/dashboard" },
      { page: anonymousPage, path: "/admin/models/routes", expectedPath: "/login" },
      { page: userPage, path: "/admin/models/governance", expectedPath: "/dashboard" },
      { page: anonymousPage, path: "/admin/models/governance", expectedPath: "/login" },
      { page: userPage, path: "/system/memberships", expectedPath: "/dashboard" },
      { page: userPage, path: "/system/operations", expectedPath: "/dashboard" },
      { page: userPage, path: `/admin/users/${ids.userId}`, expectedPath: "/dashboard" },
      { page: anonymousPage, path: `/projects/${ids.projectId}`, expectedPath: "/login" },
      { page: anonymousPage, path: invitationPath, expectedPath: "/login", expectedSearch: `?returnTo=${encodeURIComponent(invitationPath)}` },
    ];
    for (const guard of guardCases) {
      const response = await guard.page.goto(guard.path, { waitUntil: "domcontentloaded" });
      expect(response?.status(), `${guard.path} must preserve its access guard`).toBeLessThan(400);
      const actualUrl = new URL(guard.page.url());
      expect(actualUrl.pathname, `${guard.path} must redirect to its role-appropriate path`).toBe(guard.expectedPath);
      expect(actualUrl.search, `${guard.path} must preserve or omit its query as declared`).toBe(guard.expectedSearch ?? "");
      guardResults.push({
        path: guard.path,
        role: guard.page === adminPage ? "admin" : guard.page === anonymousPage ? "anonymous" : "user",
        status: response?.status() ?? null,
        finalPath: `${actualUrl.pathname}${actualUrl.search}`,
        expectedPath: `${guard.expectedPath}${guard.expectedSearch ?? ""}`,
      });
    }

    const outsider = await seedBrowserPersonalUser(`ui-matrix-outsider-${randomUUID().replaceAll("-", "").slice(0, 12)}`, "UiMatrixOutsider2026Password!");
    const outsiderContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    extraContexts.push(outsiderContext);
    const outsiderPage = await outsiderContext.newPage();
    await signInR02PersonalUser(outsiderPage, outsider);
    for (const path of [
      `/projects/${ids.projectId}`,
      `/projects/${ids.projectId}/configuration`,
      `/projects/${ids.projectId}/github-syncs/${ids.syncRunId}`,
    ]) {
      const response = await outsiderPage.goto(path, { waitUntil: "domcontentloaded" });
      expect(response?.status(), `${path} uses a valid project fixture but must be hidden from a non-member`).toBe(404);
      expect(new URL(outsiderPage.url()).pathname).toBe(path);
      guardResults.push({ path, role: "user", status: response?.status() ?? null, finalPath: new URL(outsiderPage.url()).pathname, expectedPath: path });
    }
    const memberPageResponse = await outsiderPage.goto(`/projects/${ids.projectId}/members`, { waitUntil: "domcontentloaded" });
    expect(memberPageResponse?.status(), "project layout must hide the members page from a non-member").toBe(404);
    const memberApiResponse = await outsiderPage.request.get(`/api/projects/${ids.projectId}/members`);
    expect(memberApiResponse.status(), "a valid project ID must not expose members to a non-member").toBe(403);
    const forbiddenMembers = await memberApiResponse.json();
    expect(Object.keys(forbiddenMembers)).toEqual(["error"]);
    expect(forbiddenMembers.error.code).toBe("ACCESS_FORBIDDEN");

    await setAppearance(userPage, origin.value!, "zh-CN", "light");
    await assertUserShellInteractions(userPage);
    expect(matrix, "every discovered page route must be visited in each appearance/viewport mode").toHaveLength(routes.length * MATRIX_MODES.length);
    expect(routeFailures, "all discovered routes must satisfy each appearance, viewport, icon, translation, link and server-error assertion").toEqual([]);
  } finally {
    const matrixPath = testInfo.outputPath("ui-consistency-matrix.json");
    await writeFile(matrixPath, JSON.stringify({
        discoveredPageCount: routes.length,
        matrixModeCount: MATRIX_MODES.length,
        expectedRouteVisits: routes.length * MATRIX_MODES.length,
        actualRouteVisits: matrix.length,
        successfulRouteVisits: matrix.filter((entry) => entry.outcome === "passed").length,
        failedRouteVisits: matrix.filter((entry) => entry.outcome === "failed").length,
        routeFailures,
        parentNavigationCount: parentNavigationResults.length,
        parentNavigationSuccesses: parentNavigationResults.filter((entry) => entry.outcome === "passed").length,
        parentNavigationFailures: parentNavigationResults.filter((entry) => entry.outcome === "failed").length,
        parentNavigationResults,
        dynamicIds: fixtureIds.value,
        dynamicFixtureIds: fixtureDetails.value ? {
          sourceId: fixtureDetails.value.sourceId,
          jobId: fixtureDetails.value.jobId,
          syncRunId: fixtureDetails.value.syncRunId,
        } : null,
        guards: guardResults,
        routes: matrix,
      }, null, 2));
    await testInfo.attach("ui-consistency-matrix.json", {
      path: matrixPath,
      contentType: "application/json",
    });
    await Promise.all([...contexts, ...extraContexts].map((context) => context.close()));
  }
});
