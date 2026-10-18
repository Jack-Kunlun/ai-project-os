import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import test from "node:test";

const read = (file: string) => readFile(file, "utf8");

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.isFile() && [".ts", ".tsx"].includes(extname(entry.name)) ? [file] : [];
  }));
  return nested.flat();
}

test("system-admin identity is passed from protected server pages to shared headers", async () => {
  const [projectsPage, personalProjectsPage, teamPage, projectPages] = await Promise.all([
    read("src/app/projects/page.tsx"),
    read("src/app/personal/projects/page.tsx"),
    read("src/app/team/page.tsx"),
    Promise.all((await sourceFiles("src/app/projects/[projectId]")).map(read)),
  ]);

  assert.match(projectsPage, /redirect\("\/personal\/projects"\)/u);
  assert.match(personalProjectsPage, /requirePageSession\(\)/u);
  assert.match(personalProjectsPage, /isSystemAdmin=\{user\.role === "admin"\}/u);
  assert.match(teamPage, /isSystemAdmin=\{user\.role === "admin"\}/u);
  for (const source of projectPages) {
    if (!source.includes("<AppHeader")) continue;
    assert.match(
      source,
      /<AppHeader[\s\S]{0,800}?\bisSystemAdmin=\{(?:isSystemAdmin|user\.role === "admin")\}/u,
      "every project page header must receive an explicit trusted admin value",
    );
  }
  assert.doesNotMatch(projectsPage, /isSystemAdmin\s*:\s*true/u);
  assert.doesNotMatch(teamPage, /isSystemAdmin\s*:\s*true/u);
});

test("admin navigation is five direct destinations with a separate section bar and accessible mobile drawer", async () => {
  const [shell, workspaceStyles] = await Promise.all([
    read("src/components/admin-shell.tsx"),
    read("src/app/admin/admin-workspace.module.css"),
  ]);
  const primarySource = shell.split("const primaryItems", 2)[1]?.split("];", 1)[0] ?? "";
  const itemKeys = [...primarySource.matchAll(/key:\s*"([A-Za-z]+)"/gu)].map((match) => match[1]);
  assert.equal(itemKeys.length, 5);
  for (const [label, href] of [["平台总览", "/admin"], ["用户与权益", "/admin/users"], ["配置中心", "/admin/models"], ["安全中心", "/admin/connectors/mcp"], ["运维中心", "/admin/operations/failures"]]) {
    assert.match(primarySource, new RegExp(`label: "${label}", href: "${href.replaceAll("/", "\\/")}"`, "u"));
  }
  assert.match(shell, /<nav aria-label="管理工作台导航" className="admin-primary-navigation">/u);
  assert.match(shell, /<nav aria-label="管理栏目" className="admin-module-navigation">/u);
  assert.doesNotMatch(shell, /aria-expanded=\{isExpanded\}|admin-nav-/u);
  assert.match(workspaceStyles, /width: 218px/u);
  assert.match(workspaceStyles, /flex: 0 0 59px/u);
  assert.match(workspaceStyles, /@media \(max-width: 900px\)/u);
  assert.match(shell, /role="dialog" aria-modal="true"/u);
  assert.match(shell, /aria-labelledby="admin-mobile-navigation-title" aria-label="管理工作台导航"/u);
  assert.match(shell, /event\.key === "Escape"/u);
  assert.match(shell, /previousFocus\?\.focus\(\)/u);
  assert.match(shell, /document\.activeElement === first/u);
  assert.match(shell, /document\.activeElement === last/u);
  assert.match(shell, /aria-current=\{current \? \(pathname === item\.href \? "page" : "location"\) : undefined\}/u);
  assert.match(shell, /aria-current=\{current \? "page" : undefined\}/u);
  for (const label of ["用户", "会员", "额度", "模型能力", "短信服务", "探测预算", "MCP 审核", "审计记录", "失败收件箱", "资源与备份"]) assert.match(shell, new RegExp(`label: "${label}"`, "u"));
});

test("R02 browser coverage keeps first-run smoke ordering and direct lifecycle guards", async () => {
  const spec = await read("e2e/z-r02-admin-navigation.spec.ts");
  const support = await read("e2e/support/r02-admin-navigation.ts");
  assert.equal(["smoke.spec.ts", "z-r02-admin-navigation.spec.ts"].sort().at(-1), "z-r02-admin-navigation.spec.ts");
  for (const route of ["/", "/setup", "/login", "/accept-invitation", "/privacy", "/terms", "/help", "/connections", "/connections/mcp", "/settings", "/system/memberships", "/system/operations"]) {
    assert.match(support, new RegExp(`\\[?"${route.replaceAll("/", "\\/")}"`, "u"));
  }
  for (const width of ["1440", "1024", "768", "390"]) assert.match(support, new RegExp(`R02_VIEWPORTS.*${width}`, "s"));
  assert.match(spec, /R02_PUBLIC_ROUTE_EXPECTATIONS/u);
  assert.match(spec, /r02ProjectGuardRoutes/u);
  assert.match(spec, /createControlledMembership/u);
  assert.match(spec, /signInR02Actor\(freePage, actors\.free, "\/personal\/projects"\)/u);
  assert.match(spec, /projectApi\.status\)\.toBe\(403\)/u);
  assert.match(spec, /await signInR02Admin\(page\);[\s\S]*?const personalUser = await seedBrowserPersonalUser\([\s\S]*?const ownerContext = await browser\.newContext\(\);[\s\S]*?await signInR02PersonalUser\(ownerPage, personalUser\);/u);
  assert.ok(spec.includes('await expect(page).toHaveURL(/\\/admin$/u);'));
  assert.match(spec, /AI Project OS 平台管理总览/u);
  assert.match(spec, /toHaveAttribute\("href", "\/admin"\)/u);
  assert.match(spec, /ownerPage\.getByRole\("link", \{ name: "管理工作台", exact: true \}\)\)\.toHaveCount\(0\)/u);
  assert.match(spec, /expectedR02AdminNavigationLinkCount/u);
  assert.match(support, /expectedR02AdminNavigationLinkCount/u);
  assert.match(spec, /expectR02NoAccessibilityViolations/u);
  assert.match(spec, /expectR02SettledRoute/u);
  assert.match(spec, /seedR02DetailFixtures/u);
  assert.match(spec, /source-link-\$\{details\.sourceId\}/u);
  assert.match(spec, /#task-runs/u);
  assert.match(spec, /R02_ACTOR_PASSWORD/u);
  assert.match(support, /R02_PUBLIC_ROUTE_EXPECTATIONS/u);
  assert.match(support, /r02ProjectGuardRoutes/u);
  assert.match(support, /path: "\/admin\/models", heading: "平台模型"/u);
  assert.match(support, /path: "\/admin\/models\/routes", heading: "平台模型"/u);
  assert.match(support, /path: "\/admin\/credits", heading: "平台额度"/u);
  assert.match(support, /path: "\/admin\/operations\/probes", heading: "连接探测预算"/u);
  assert.match(support, /path: "\/admin\/users", heading: "用户运营"/u);
  assert.match(support, /path: "\/admin\/users\/memberships", heading: "会员资格管理"/u);
  assert.match(support, /path: "\/admin\/account", heading: "管理员账户"/u);
  assert.match(support, /terminal:/u);
  assert.match(support, /pendingTexts/u);
  assert.match(support, /R02_PROJECT_PENDING_TEXTS/u);
  assert.match(support, /must leave labelled loading states/u);
  assert.match(spec, /expectR02InViewport/u);
  assert.match(spec, /getByRole\("heading", \{ name: "待处理事项", exact: true \}\)/u);
  assert.doesNotMatch(spec, /scrollIntoViewIfNeeded/u);
  assert.match(support, /must not settle into a soft error/u);
  assert.match(support, /expectedR02AdminNavigationLinkCount/u);
  assert.match(support, /const focusable = drawer\.locator/u);
  assert.match(support, /focusable\.last\(\)/u);
  assert.match(support, /AxeBuilder/u);
  assert.doesNotMatch(spec, /seedR02Viewer/u);
});
