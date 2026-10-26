import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { englishUiMessages } from "@/lib/ui-dictionary-source";
import type { GitCatalogEntry } from "../src/app/profile/connections/git/git-connections-state";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { expectR02NoHorizontalOverflow, signInR02Admin, signInR02PersonalUser, signOutR02User } from "./support/r02-admin-navigation";

type AppearanceMode = Readonly<{
  language: "zh-CN" | "en";
  theme: "light" | "dark";
  width: 1440 | 390;
  height: 900 | 844;
}>;

const APPEARANCE_MODES: readonly AppearanceMode[] = [
  { language: "zh-CN", theme: "light", width: 1440, height: 900 },
  { language: "en", theme: "dark", width: 390, height: 844 },
];

const FIXTURE_NOW = "2026-10-26T00:00:00.000Z";
const FIXTURE_CONNECTION_ID = "00000000-0000-4000-8000-0000000000e1";
const FIXTURE_DELEGATION_ID = "00000000-0000-4000-8000-0000000000e2";
const FIXTURE_GIT_CATALOG: readonly GitCatalogEntry[] = [
  { kind: "github", label: "GitHub", defaultHttpsUrl: "https://github.com", defaultSshUrl: "git@github.com" },
];

type ProjectDelegationFixture = Readonly<{
  id: string;
  projectId: string;
  connection: Readonly<{ id: string; name: string; providerKind: string; transport: string }>;
  connectionOwner: Readonly<{ displayName: string }> | null;
  scope: Readonly<{
    repositoryPath: string;
    trackedRef: string;
    includeRoots: readonly string[];
    softExcludePatterns: readonly string[];
    role: string;
    requiredForProjectSnapshot: boolean;
    codeEnabled: boolean;
    metadataEnabled: boolean;
    manualSyncAllowed: boolean;
    automationAllowed: boolean;
  }>;
  status: string;
  version: number;
  expiresAt: string;
  proposedAt: string;
  ownerConfirmedAt: string | null;
  projectConfirmedAt: string | null;
  activatedAt: string | null;
  rejectedAt: string | null;
  revokedAt: string | null;
  expiredAt: string | null;
  ownerConfirmedBy: Readonly<{ displayName: string }> | null;
  projectConfirmedBy: Readonly<{ displayName: string }> | null;
  terminalReason: string | null;
  capabilities: Readonly<{
    canOwnerConfirm: boolean;
    canProjectConfirm: boolean;
    canReject: boolean;
    canRevoke: boolean;
    canManualSync: boolean;
  }>;
}>;

function text(mode: AppearanceMode, source: string): string {
  return mode.language === "en" ? englishUiMessages[source] ?? source : source;
}

async function createProject(page: Page, workspaceId: string, suffix: string): Promise<string> {
  const response = await page.request.post("/api/projects", {
    headers: { origin: new URL(page.url()).origin },
    data: { name: `System dialog regression ${suffix}`, workspaceId },
  });
  expect(response.status()).toBe(201);
  const payload = await response.json() as { project?: { id?: string } };
  expect(payload.project?.id).toMatch(/^[0-9a-f-]{36}$/iu);
  return payload.project!.id!;
}

async function setAppearance(page: Page, mode: AppearanceMode): Promise<void> {
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([
    { name: "aipos-language", value: mode.language, url: origin, sameSite: "Lax" },
    { name: "aipos-theme", value: mode.theme, url: origin, sameSite: "Lax" },
  ]);
  await page.setViewportSize({ width: mode.width, height: mode.height });
}

async function blockApiWrites(page: Page): Promise<string[]> {
  const attemptedWrites: string[] = [];
  await page.route("**/api/**", (route) => {
    const method = route.request().method();
    if (["GET", "HEAD", "OPTIONS"].includes(method)) return route.fallback();
    attemptedWrites.push(`${method} ${new URL(route.request().url()).pathname}`);
    return route.abort();
  });
  return attemptedWrites;
}

async function installProjectProposalFixtures(page: Page, projectId: string): Promise<string[]> {
  const attemptedWrites = await blockApiWrites(page);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const delegation: ProjectDelegationFixture = {
    id: FIXTURE_DELEGATION_ID,
    projectId,
    connection: { id: FIXTURE_CONNECTION_ID, name: "Browser fixture Git", providerKind: "github", transport: "https" },
    connectionOwner: { displayName: "Browser connection owner" },
    scope: {
      repositoryPath: "example/system-dialog-fixture",
      trackedRef: "main",
      includeRoots: ["src"],
      softExcludePatterns: [".git"],
      role: "primary",
      requiredForProjectSnapshot: true,
      codeEnabled: true,
      metadataEnabled: true,
      manualSyncAllowed: true,
      automationAllowed: false,
    },
    status: "active",
    version: 1,
    expiresAt,
    proposedAt: FIXTURE_NOW,
    ownerConfirmedAt: FIXTURE_NOW,
    projectConfirmedAt: FIXTURE_NOW,
    activatedAt: FIXTURE_NOW,
    rejectedAt: null,
    revokedAt: null,
    expiredAt: null,
    ownerConfirmedBy: { displayName: "Browser connection owner" },
    projectConfirmedBy: { displayName: "Browser project owner" },
    terminalReason: null,
    capabilities: {
      canOwnerConfirm: false,
      canProjectConfirm: false,
      canReject: false,
      canRevoke: false,
      canManualSync: false,
    },
  };
  const connection = {
    id: FIXTURE_CONNECTION_ID,
    name: "Browser fixture Git",
    providerKind: "github",
    transport: "https",
    status: "verified",
    ownershipState: "confirmed",
  };
  const endpoint = (name: string) => new RegExp(`/api/projects/${projectId}/${name}(?:\\?.*)?$`, "u");

  // These typed GET projections expose only the controls needed to inspect the
  // two proposal dialogs. No Git read, credential, or mutation is involved.
  await page.route(endpoint("git-repository-delegations"), (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: {
      capabilities: { canPropose: true },
      connections: [connection],
      delegations: [delegation],
    } });
  });
  await page.route(endpoint("git-automation-grants"), (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: { grants: [] } });
  });
  return attemptedWrites;
}

async function installConnectionAndSourceFixtures(page: Page, projectId: string): Promise<string[]> {
  const attemptedWrites = await blockApiWrites(page);
  const endpoint = (path: string) => new RegExp(`${path}(?:\\?.*)?$`, "u");

  await page.route(endpoint("/api/me/git-connections"), (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: { connections: [], catalog: FIXTURE_GIT_CATALOG } });
  });
  await page.route(endpoint("/api/me/git-delegations"), (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: { delegations: [] } });
  });
  await page.route(endpoint("/api/me/mcp-connections"), (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: { connections: [] } });
  });
  await page.route(endpoint("/api/me/mcp-delegations"), (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: { delegations: [] } });
  });
  await page.route(endpoint(`/api/projects/${projectId}/web-sources`), (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: {
      sources: [],
      pagination: { page: 1, pageSize: 10, total: 0, totalPages: 1 },
      canManageCredentials: true,
      canReview: true,
      browserEnabled: false,
    } });
  });

  return attemptedWrites;
}

async function expectSingleDialog(page: Page, title: string): Promise<Locator> {
  const matchingDialogs = page.getByRole("dialog", { name: title, exact: true });
  await expect(matchingDialogs).toHaveCount(1);
  const dialog = matchingDialogs.first();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: title, exact: true })).toHaveCount(1);
  return dialog;
}

async function expectUnframedFullWidthRoot(dialog: Locator, bodySelector: string, label: string): Promise<Locator> {
  const body = dialog.locator(bodySelector);
  const root = body.locator(":scope > *").first();
  await expect(root).toBeVisible();
  const metrics = await body.evaluate((bodyElement) => {
    const rootElement = bodyElement.firstElementChild;
    if (!(rootElement instanceof HTMLElement)) throw new Error("DIALOG_CONTENT_ROOT_MISSING");
    const bodyStyle = getComputedStyle(bodyElement);
    const rootStyle = getComputedStyle(rootElement);
    const bodyRect = bodyElement.getBoundingClientRect();
    const rootRect = rootElement.getBoundingClientRect();
    const paddingLeft = Number.parseFloat(bodyStyle.paddingLeft);
    const paddingRight = Number.parseFloat(bodyStyle.paddingRight);
    const borderLeft = Number.parseFloat(bodyStyle.borderLeftWidth);
    const availableWidth = bodyElement.clientWidth - paddingLeft - paddingRight;
    return {
      availableWidth,
      expectedLeft: bodyRect.left + borderLeft + paddingLeft,
      expectedRight: bodyRect.left + borderLeft + paddingLeft + availableWidth,
      rootLeft: rootRect.left,
      rootRight: rootRect.right,
      rootWidth: rootRect.width,
      borderWidths: [rootStyle.borderTopWidth, rootStyle.borderRightWidth, rootStyle.borderBottomWidth, rootStyle.borderLeftWidth].map(Number.parseFloat),
      background: rootStyle.backgroundColor,
      radius: rootStyle.borderRadius,
      shadow: rootStyle.boxShadow,
      padding: [rootStyle.paddingTop, rootStyle.paddingRight, rootStyle.paddingBottom, rootStyle.paddingLeft],
    };
  });

  expect(Math.abs(metrics.rootWidth - metrics.availableWidth), `${label} content root must use the dialog body width`).toBeLessThanOrEqual(2);
  expect(Math.abs(metrics.rootLeft - metrics.expectedLeft), `${label} root must align with the dialog body inset`).toBeLessThanOrEqual(2);
  expect(Math.abs(metrics.rootRight - metrics.expectedRight), `${label} root must not leave an inner max-width gap`).toBeLessThanOrEqual(2);
  expect(metrics.borderWidths.every((width) => width === 0), `${label} root must not repeat a decorative border`).toBe(true);
  expect(metrics.background === "rgba(0, 0, 0, 0)" || metrics.background === "transparent", `${label} root must not repeat a tinted card surface`).toBe(true);
  expect(Number.parseFloat(metrics.radius), `${label} root must not repeat a card radius`).toBe(0);
  expect(metrics.shadow).toBe("none");
  expect(metrics.padding.every((padding) => Number.parseFloat(padding) === 0), `${label} root must not duplicate body padding`).toBe(true);
  return body;
}

async function expectStandardActions(buttons: readonly Locator[], label: string): Promise<void> {
  for (const button of buttons) {
    await expect(button).toBeVisible();
    const geometry = await button.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { minHeight: Number.parseFloat(getComputedStyle(element).minHeight), height: rect.height };
    });
    expect(geometry.minHeight, `${label} action must keep the shared minimum height`).toBeGreaterThanOrEqual(40);
    expect(geometry.height, `${label} action must remain usable`).toBeGreaterThanOrEqual(40);
  }
}

async function assertOperationDialog(
  page: Page,
  dialog: Locator,
  rootLabel: string,
  actionButtons: readonly Locator[],
  mode: AppearanceMode,
): Promise<void> {
  const body = await expectUnframedFullWidthRoot(dialog, "[data-operation-content]", rootLabel);
  if (mode.width === 1440 && await body.locator(":scope > form").count() > 0) {
    await expect(dialog).toHaveCSS("max-width", "720px");
    expect(await dialog.evaluate(element => element.getBoundingClientRect().width), `${rootLabel} must use the compact form width`).toBeLessThanOrEqual(721);
  }
  await expect(body).toHaveCSS("overflow-y", "auto");
  await expectStandardActions(actionButtons, rootLabel);
  for (const button of actionButtons) {
    expect(await button.evaluate((element) => element.closest("[data-operation-content]")?.contains(element) ?? false), `${rootLabel} actions must stay inside the scrollable operation body`).toBe(true);
  }
  await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  for (const button of actionButtons) await expect(button).toBeInViewport();
  await expectR02NoHorizontalOverflow(page, `${rootLabel} ${mode.width}px`);
}

async function assertConnectionDialog(
  page: Page,
  dialog: Locator,
  rootLabel: string,
  actionButtons: readonly Locator[],
  mode: AppearanceMode,
): Promise<void> {
  const body = await expectUnframedFullWidthRoot(dialog, "[data-dialog-body]", rootLabel);
  const footer = dialog.locator("[data-dialog-footer]");
  await expect(body).toHaveCSS("overflow-y", "auto");
  await expect(footer).toBeVisible();
  await expectStandardActions(actionButtons, rootLabel);
  for (const button of actionButtons) {
    expect(await button.evaluate((element) => element.closest("[data-dialog-footer]")?.contains(element) ?? false), `${rootLabel} actions must remain in the fixed dialog footer`).toBe(true);
  }
  const footerClearance = await dialog.evaluate((dialogElement) => {
    const bodyElement = dialogElement.querySelector<HTMLElement>("[data-dialog-body]");
    const footerElement = dialogElement.querySelector<HTMLElement>("[data-dialog-footer]");
    if (!bodyElement || !footerElement) throw new Error("CONNECTION_DIALOG_BODY_OR_FOOTER_MISSING");
    const bodyRect = bodyElement.getBoundingClientRect();
    const footerRect = footerElement.getBoundingClientRect();
    const dialogRect = dialogElement.getBoundingClientRect();
    return { bodyBottom: bodyRect.bottom, footerTop: footerRect.top, footerBottom: footerRect.bottom, dialogBottom: dialogRect.bottom };
  });
  expect(footerClearance.footerTop).toBeGreaterThanOrEqual(footerClearance.bodyBottom - 1);
  expect(footerClearance.dialogBottom - footerClearance.footerBottom).toBeLessThanOrEqual(1);
  await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  for (const button of actionButtons) await expect(button).toBeInViewport();
  await expectR02NoHorizontalOverflow(page, `${rootLabel} ${mode.width}px`);
}

async function attachDialogScreenshot(testInfo: TestInfo, name: string, dialog: Locator): Promise<void> {
  await testInfo.attach(name, { body: await dialog.screenshot({ animations: "disabled" }), contentType: "image/png" });
}

test("manual and automatic repository proposal dialogs fit and retain drafts in both appearance modes", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await signInR02Admin(page);
  await signOutR02User(page);
  const user = await seedBrowserPersonalUser(`system-dialog-repo-${randomUUID().slice(0, 8)}`, "SystemDialogRepo2026Password!");
  await signInR02PersonalUser(page, user);
  const projectId = await createProject(page, user.workspaceId, randomUUID().slice(0, 8));
  const attemptedWrites = await installProjectProposalFixtures(page, projectId);

  for (const mode of APPEARANCE_MODES) {
    await setAppearance(page, mode);
    await page.goto(`/projects/${projectId}/repositories`);
    await expect(page.locator("html")).toHaveAttribute("lang", mode.language);
    await expect(page.locator("html")).toHaveAttribute("data-theme", mode.theme);

    const manualTitle = text(mode, "提交仓库范围提案");
    await page.getByRole("button", { name: manualTitle, exact: true }).click();
    const manualDialog = await expectSingleDialog(page, manualTitle);
    const manualCancel = manualDialog.getByRole("button", { name: text(mode, "取消"), exact: true });
    const manualSubmit = manualDialog.getByRole("button", { name: manualTitle, exact: true });
    const repositoryPath = manualDialog.getByRole("textbox", { name: text(mode, "仓库路径"), exact: true });
    const trackedRef = manualDialog.getByRole("textbox", { name: text(mode, "分支"), exact: true });
    await repositoryPath.fill("browser-fixture/proposal-draft");
    await trackedRef.fill("dialog-regression");
    await assertOperationDialog(page, manualDialog, "manual repository proposal", [manualCancel, manualSubmit], mode);
    await attachDialogScreenshot(testInfo, `repository-manual-${mode.width}-${mode.language}-${mode.theme}`, manualDialog);
    await manualCancel.click();
    await expect(manualDialog).toBeHidden();
    await page.getByRole("button", { name: manualTitle, exact: true }).click();
    const reopenedManual = await expectSingleDialog(page, manualTitle);
    await expect(reopenedManual.getByRole("textbox", { name: text(mode, "仓库路径"), exact: true })).toHaveValue("browser-fixture/proposal-draft");
    await expect(reopenedManual.getByRole("textbox", { name: text(mode, "分支"), exact: true })).toHaveValue("dialog-regression");
    await reopenedManual.locator("[data-operation-header] [data-dialog-close]").click();

    const automaticTitle = text(mode, "提交自动读取授权提案");
    const automaticTrigger = page.getByRole("button", { name: text(mode, "创建自动读取授权"), exact: true });
    await expect(automaticTrigger).toBeVisible();
    await automaticTrigger.click();
    const automaticDialog = await expectSingleDialog(page, automaticTitle);
    const automaticCancel = automaticDialog.getByRole("button", { name: text(mode, "取消"), exact: true });
    const automaticSubmit = automaticDialog.getByRole("button", { name: text(mode, "提交授权提案"), exact: true });
    const interval = automaticDialog.locator('input[type="number"]');
    const firstMaterial = automaticDialog.locator('input[type="checkbox"]').first();
    await interval.fill("120");
    await firstMaterial.check();
    await assertOperationDialog(page, automaticDialog, "automatic-read proposal", [automaticCancel, automaticSubmit], mode);
    await attachDialogScreenshot(testInfo, `repository-automatic-${mode.width}-${mode.language}-${mode.theme}`, automaticDialog);
    await automaticCancel.click();
    await expect(automaticDialog).toBeHidden();
    await automaticTrigger.click();
    const reopenedAutomatic = await expectSingleDialog(page, automaticTitle);
    await expect(reopenedAutomatic.locator('input[type="number"]')).toHaveValue("120");
    await expect(reopenedAutomatic.locator('input[type="checkbox"]').first()).toBeChecked();
    await reopenedAutomatic.locator("[data-operation-header] [data-dialog-close]").click();
    await expectR02NoHorizontalOverflow(page, `repository proposal page ${mode.width}px`);
  }

  expect(attemptedWrites, "opening, editing, closing, and reopening proposal drafts must not submit them").toEqual([]);
});

test("shared Git, MCP, team invitation, and external-source dialogs use their body and footer space", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await signInR02Admin(page);
  await signOutR02User(page);
  const user = await seedBrowserPersonalUser(`system-dialog-shared-${randomUUID().slice(0, 8)}`, "SystemDialogShared2026Password!");
  await signInR02PersonalUser(page, user);
  const projectId = await createProject(page, user.workspaceId, randomUUID().slice(0, 8));
  const attemptedWrites = await installConnectionAndSourceFixtures(page, projectId);

  for (const mode of APPEARANCE_MODES) {
    await setAppearance(page, mode);
    for (const connection of [
      { path: "/personal/connections/git", title: "添加 Git 服务", trigger: "添加 Git 服务" },
      { path: "/personal/connections/mcp", title: "添加 MCP 服务", trigger: "添加 MCP 服务" },
    ] as const) {
      await page.goto(connection.path);
      const title = text(mode, connection.title);
      await page.getByRole("button", { name: text(mode, connection.trigger), exact: true }).click();
      const dialog = await expectSingleDialog(page, title);
      const testConnection = dialog.getByRole("button", { name: text(mode, "测试连接"), exact: true });
      await assertConnectionDialog(page, dialog, `${connection.path} create`, [testConnection], mode);
      await attachDialogScreenshot(testInfo, `${connection.path.includes("/git") ? "git" : "mcp"}-connection-${mode.width}-${mode.language}-${mode.theme}`, dialog);
      await dialog.locator("[data-dialog-header] [data-dialog-close]").click();
      await expect(dialog).toBeHidden();
    }
  }

  const desktopMode = APPEARANCE_MODES[0]!;
  await setAppearance(page, desktopMode);
  await page.goto(`/team/${user.workspaceId}?view=invitations`);
  const invitationTrigger = page.getByRole("button", { name: text(desktopMode, "创建邀请"), exact: true });
  await invitationTrigger.click();
  const invitationTitle = text(desktopMode, "创建邀请链接");
  const invitationDialog = await expectSingleDialog(page, invitationTitle);
  await assertOperationDialog(
    page,
    invitationDialog,
    "team invitation",
    [
      invitationDialog.getByRole("button", { name: text(desktopMode, "取消"), exact: true }),
      invitationDialog.getByRole("button", { name: text(desktopMode, "生成 7 天邀请"), exact: true }),
    ],
    desktopMode,
  );
  await attachDialogScreenshot(testInfo, "team-invitation-1440-zh-CN-light", invitationDialog);
  await invitationDialog.getByRole("button", { name: text(desktopMode, "取消"), exact: true }).click();
  await expect(invitationDialog).toBeHidden();

  await page.goto(`/projects/${projectId}/external-sources`);
  const webSourceTrigger = page.getByRole("button", { name: text(desktopMode, "添加公开网页"), exact: true });
  await webSourceTrigger.click();
  const webSourceTitle = text(desktopMode, "添加网页来源");
  const webSourceDialog = await expectSingleDialog(page, webSourceTitle);
  await assertOperationDialog(
    page,
    webSourceDialog,
    "external web-source form",
    [
      webSourceDialog.getByRole("button", { name: text(desktopMode, "取消"), exact: true }),
      webSourceDialog.getByRole("button", { name: text(desktopMode, "添加并抓取"), exact: true }),
    ],
    desktopMode,
  );
  await attachDialogScreenshot(testInfo, "external-web-source-1440-zh-CN-light", webSourceDialog);
  await webSourceDialog.getByRole("button", { name: text(desktopMode, "取消"), exact: true }).click();
  await expect(webSourceDialog).toBeHidden();

  expect(attemptedWrites, "opening shared forms must not submit credentials, invitations, or external-source actions").toEqual([]);
});
