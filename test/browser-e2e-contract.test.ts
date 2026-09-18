import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");

test("browser gate stays isolated and exercises the production server", async () => {
  const [packageJson, config, runner, smoke, automation, webAiConfirmation, systemAudit, gitConnections, failureInbox, r02Spec, r02Support] = await Promise.all([
    read("package.json"),
    read("playwright.config.ts"),
    read("scripts/run-browser-e2e.ts"),
    read("e2e/smoke.spec.ts"),
    read("src/app/projects/[projectId]/automations/project-automations-client.tsx"),
    read("e2e/web-ai-confirmation.spec.ts"),
    read("e2e/system-audit.spec.ts"),
    read("src/app/profile/connections/git/git-connections-client.tsx"),
    read("e2e/system-failure-inbox.spec.ts"),
    read("e2e/z-r02-admin-navigation.spec.ts"),
    read("e2e/support/r02-admin-navigation.ts"),
  ]);
  const manifest = JSON.parse(packageJson) as {
    devDependencies: Record<string, string>;
    scripts: Record<string, string>;
  };

  assert.equal(manifest.scripts["test:browser-e2e"], "tsx scripts/run-browser-e2e.ts");
  assert.equal(manifest.devDependencies["@axe-core/playwright"], "4.13.0");
  assert.match(config, /workers:\s*1/u);
  assert.match(config, /BROWSER_E2E_BASE_URL_REQUIRED/u);
  assert.match(config, /parsed\.hostname !== "127\.0\.0\.1"/u);
  assert.match(runner, /validatePostgresGateAdminUrl/u);
  assert.match(runner, /ai_project_os_browser_e2e_test/u);
  assert.match(runner, /createServer/u);
  assert.match(runner, /hasLoopbackListener/u);
  assert.match(runner, /port: configuredPort \?\? 0/u);
  assert.match(runner, /\["build"\]/u);
  assert.match(runner, /\.next\/standalone\/server\.js/u);
  assert.match(runner, /\.next\/standalone\/\.next\/static/u);
  assert.match(runner, /delete appEnvironment\.DATABASE_PRINCIPAL_ADMIN_URL/u);
  assert.match(runner, /delete appEnvironment\.MIGRATOR_DATABASE_URL/u);
  assert.match(runner, /delete appEnvironment\.DATABASE_PRINCIPAL_LEGACY_BOOTSTRAP_URL/u);
  assert.match(runner, /delete workerEnvironment\.ENTITLEMENT_DATABASE_URL/u);
  assert.match(runner, /DROP DATABASE IF EXISTS/u);
  assert.match(smoke, /content-security-policy/u);
  assert.match(smoke, /worker: \{ status: "up"/u);
  assert.match(smoke, /AxeBuilder/u);
  assert.match(smoke, /wcag22aa/u);
  assert.match(smoke, /expectNoAccessibilityViolations/u);
  assert.match(smoke, /expect\(browserErrors\)\.toEqual\(\[\]\)/u);
  assert.match(smoke, /subjectKind: "backgroundJob"/u);
  assert.match(smoke, /attentionIntent: "requiresAttention"/u);
  assert.match(smoke, /subjectKind: "automationRun"/u);
  assert.match(smoke, /automationFailed/u);
  assert.match(smoke, /automationRunId/u);
  assert.equal(smoke.includes("automations\\\\?run="), true);
  assert.match(smoke, /待处理/u);
  assert.match(smoke, /view=pending/u);
  assert.match(smoke, /返回活动记录/u);
  assert.match(automation, /parseNotificationFilter/u);
  assert.match(automation, /parseNotificationCursor/u);
  assert.match(automation, /parseNotificationFocus/u);
  assert.match(automation, /buildNotificationReturnHref/u);
  assert.match(automation, /返回活动记录/u);
  assert.match(webAiConfirmation, /button\.click\(\);[\s\S]*button\.click\(\);/u);
  assert.match(webAiConfirmation, /prepareRequests\)\.toHaveLength\(1\)/u);
  assert.match(webAiConfirmation, /executeRequests\)\.toHaveLength\(1\)/u);
  assert.match(webAiConfirmation, /consumedAt: null, consumedJobId: null/u);
  assert.doesNotMatch(webAiConfirmation, /route\.(?:fetch|fulfill)/u);
  assert.match(systemAudit, /administrator audit center keeps short labels on one line and separates common from advanced filters/u);
  assert.match(systemAudit, /projectGitManualRun/u);
  assert.match(systemAudit, /projectMcpActionApproval/u);
  assert.match(systemAudit, /projectMcpActionRuntime/u);
  assert.match(systemAudit, /AxeBuilder/u);
  assert.match(systemAudit, /wcag22aa/u);
  assert.match(systemAudit, /getByRole\("combobox", \{ name: "来源", exact: true \}\)/u);
  assert.match(systemAudit, /getByRole\("combobox", \{ name: "动作", exact: true \}\)/u);
  assert.match(systemAudit, /option\[value="projectGitManualRun"\]/u);
  assert.match(systemAudit, /option\[value="runFailed"\]/u);
  assert.match(systemAudit, /expect\(sourceValues\)\.not\.toContain\("aiProviderOwnership"\)/u);
  assert.match(systemAudit, /expect\(actionValues\)\.not\.toContain\("legacyOwnershipConfirmed"\)/u);
  assert.match(systemAudit, /activateAccountEntitlements/u);
  assert.doesNotMatch(systemAudit, /accountEntitlementActivation\.create/u);
  assert.doesNotMatch(systemAudit, /accountEntitlementActivationAudit\.create/u);
  assert.match(systemAudit, /getByText\(fixture\.auditId, \{ exact: true \}\)/u);
  assert.match(systemAudit, /assertForbiddenAuditApis/u);
  assert.match(systemAudit, /page\.route\(detailRoute/u);
  assert.match(gitConnections, /role="status" aria-label="正在加载项目委托安全记录"/u);
  assert.match(gitConnections, /role="status" aria-label="正在加载 Git 连接"/u);
  assert.match(failureInbox, /\/admin\/operations\/failures/u);
  assert.match(failureInbox, /失败与待对账收件箱/u);
  assert.match(failureInbox, /requires_owner_review/u);
  assert.match(failureInbox, /重试\|恢复\|重新执行\|关闭异常\|确认处理/u);
  assert.match(failureInbox, /browser\.newContext/u);
  assert.match(r02Spec, /R02 production pages preserve the trusted admin entry/u);
  assert.match(r02Spec, /test\.setTimeout\(360_000\)/u);
  assert.match(r02Spec, /R02_PUBLIC_ROUTE_EXPECTATIONS/u);
  assert.match(r02Spec, /r02ProjectGuardRoutes/u);
  assert.match(r02Spec, /createControlledMembership/u);
  assert.match(r02Spec, /R02ActorKind/u);
  assert.match(r02Spec, /用户名或密码错误/u);
  assert.doesNotMatch(r02Spec, /goBack\(\)/u);
  assert.match(r02Spec, /AI Project OS 平台管理总览/u);
  assert.match(r02Spec, /toHaveAttribute\("href", "\/admin"\)/u);
  assert.match(r02Spec, /projects\?focus=r02-header/u);
  assert.match(r02Spec, /expectR02NoAccessibilityViolations/u);
  assert.match(r02Spec, /R02_ADMIN_ROUTES/u);
  assert.match(r02Spec, /r02ProjectRoutes/u);
  assert.match(r02Spec, /expectR02MobileDrawer/u);
  assert.match(r02Spec, /expectR02OverviewErrorState/u);
  assert.match(r02Spec, /platform model primary action/u);
  assert.match(r02Spec, /width === 1440 \? 900 : 844/u);
  assert.match(r02Spec, /width: 390, height: 844/u);
  assert.match(r02Spec, /\/admin\/connectors\/git/u);
  assert.match(r02Spec, /未取得/u);
  assert.match(smoke, /initialPendingActions/u);
  assert.match(smoke, /无待办/u);
  assert.doesNotMatch(r02Spec, /route\.(?:fetch|fulfill)/u);
  assert.match(r02Support, /R02_VIEWPORTS/u);
  assert.match(r02Support, /keyboard\.press\("Escape"\)/u);
  assert.match(r02Support, /expectedR02AdminNavigationLinkCount/u);
  assert.match(r02Support, /focusable\.last\(\)/u);
});

test("CI uses pinned least-privilege actions and runs all bounded gates", async () => {
  const workflow = await read(".github/workflows/ci.yml");

  assert.match(workflow, /permissions:\n  contents: read/u);
  assert.match(workflow, /actions\/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd/u);
  assert.match(workflow, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/u);
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u);
  assert.match(workflow, /pnpm install --frozen-lockfile/u);
  assert.match(workflow, /pnpm test:coverage/u);
  assert.match(workflow, /pnpm test:postgres-gates/u);
  assert.match(workflow, /playwright install --with-deps chromium/u);
  assert.match(workflow, /pnpm test:browser-e2e/u);
  assert.doesNotMatch(workflow, /secrets\./u);
});

test("coverage gate measures all source TypeScript with explicit ratchet thresholds", async () => {
  const packageJson = JSON.parse(await read("package.json")) as {
    scripts: Record<string, string>;
  };
  const command = packageJson.scripts["test:coverage"];

  assert.match(command, /--experimental-test-coverage/u);
  assert.match(command, /--test-coverage-lines=60/u);
  assert.match(command, /--test-coverage-branches=78/u);
  assert.match(command, /--test-coverage-functions=67/u);
  assert.match(command, /--test-coverage-include=src\/\*\*\/\*\.ts/u);
  assert.match(command, /--test-coverage-include=src\/\*\*\/\*\.tsx/u);
});
