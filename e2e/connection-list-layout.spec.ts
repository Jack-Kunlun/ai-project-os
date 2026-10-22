import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import {
  expectR02NoHorizontalOverflow,
  signInR02Admin,
  signInR02PersonalUser,
  signOutR02User,
} from "./support/r02-admin-navigation";
import type { GitCatalogEntry, GitConnection } from "../src/app/profile/connections/git/git-connections-state";
import type { McpConnection } from "../src/app/profile/connections/mcp/mcp-connections-state";

const FIXTURE_TIMESTAMP = "2026-10-22T00:00:00.000Z";
const GIT_FIXTURE_NAME = "Browser fixture Git";
const MCP_FIXTURE_NAME = "Browser fixture MCP";

// These records are deliberately client-route fixtures with fixed fake IDs.
// Their .invalid addresses are never probed; every API write is aborted below.
const gitConnectionFixture: GitConnection = {
  id: "00000000-0000-4000-8000-0000000000e1",
  name: GIT_FIXTURE_NAME,
  providerKind: "generic",
  transport: "https",
  baseUrl: "https://git-fixture.invalid",
  authKind: "none",
  username: null,
  allowPrivateNetwork: false,
  tlsCaCertificate: null,
  sshKnownHost: null,
  status: "verified",
  recoveryState: "ready",
  ownershipState: "confirmed",
  lastTestedAt: FIXTURE_TIMESTAMP,
  lastErrorCode: null,
  disabledAt: null,
  createdAt: FIXTURE_TIMESTAMP,
  updatedAt: FIXTURE_TIMESTAMP,
  credential: null,
  _count: { repositories: 0 },
};

const mcpConnectionFixture: McpConnection = {
  id: "00000000-0000-4000-8000-0000000000e2",
  name: MCP_FIXTURE_NAME,
  endpointUrl: "https://mcp-fixture.invalid/mcp",
  authKind: "none",
  allowPrivateNetwork: false,
  protocolVersion: "2025-03-26",
  catalogFingerprint: "browser-fixture-catalog",
  status: "verified",
  recoveryState: "ready",
  ownershipState: "confirmed",
  lastDiscoveredAt: FIXTURE_TIMESTAMP,
  lastErrorCode: null,
  disabledAt: null,
  createdAt: FIXTURE_TIMESTAMP,
  updatedAt: FIXTURE_TIMESTAMP,
  credential: null,
  toolDefinitions: [],
};

type AppearanceMode = Readonly<{
  language: "zh-CN" | "en";
  theme: "light" | "dark";
  width: 1440 | 390;
}>;

const APPEARANCE_MODES: readonly AppearanceMode[] = [
  { language: "zh-CN", theme: "light", width: 1440 },
  { language: "en", theme: "dark", width: 390 },
];

type GovernanceFixtureState = {
  previewRequests: Array<Readonly<{ kind: "git" | "mcp"; action: string; reason: string }>>;
  executeRequests: string[];
};

async function installReadOnlyConnectionFixtures(page: Page, gitCatalog: readonly GitCatalogEntry[]): Promise<GovernanceFixtureState> {
  const governanceState: GovernanceFixtureState = { previewRequests: [], executeRequests: [] };

  await page.route("**/*", (route) => {
    const method = route.request().method();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return route.fallback();
    return route.abort();
  });

  // This one safe client-side preview is the only API write allowed through.
  // All other writes, including governance execute, remain blocked.
  await page.route(/\/api\/me\/(?:git|mcp)-connections\/[^/]+\/governance\/(?:preview|execute)$/u, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();

    const url = new URL(request.url());
    const match = url.pathname.match(/^\/api\/me\/(git|mcp)-connections\/([^/]+)\/governance\/(preview|execute)$/u);
    if (!match) return route.abort();
    const [, kind, connectionId, operation] = match as [string, "git" | "mcp", string, "preview" | "execute"];
    if (operation === "execute") {
      governanceState.executeRequests.push(`${kind}:${connectionId}`);
      return route.abort();
    }

    const expectedId = kind === "git" ? gitConnectionFixture.id : mcpConnectionFixture.id;
    const connection = kind === "git" ? gitConnectionFixture : mcpConnectionFixture;
    const body = request.postDataJSON() as { action?: unknown; requestKey?: unknown; reason?: unknown };
    if (
      connectionId !== expectedId
      || body.action !== "disable"
      || typeof body.requestKey !== "string"
      || typeof body.reason !== "string"
    ) return route.abort();

    governanceState.previewRequests.push({ kind, action: body.action, reason: body.reason });
    const impact = kind === "git"
      ? { legacyLinks: [], liveDelegations: [], manualRuns: [], historicalReferences: 0 }
      : { liveDelegations: [], activeToolGrants: [], v2Attestations: 0, nonTerminalActions: 0, reservedDispatches: 0 };
    return route.fulfill({ json: { preview: {
      id: "00000000-0000-4000-8000-0000000000f1",
      connectionId,
      action: "disable",
      connection: { name: connection.name, status: connection.status, configurationVersion: 1, updatedAt: connection.updatedAt },
      scope: "personal",
      owner: { userId: "00000000-0000-4000-8000-0000000000f2", feePayer: "connection_owner" },
      reason: body.reason,
      requestKey: body.requestKey,
      requestFingerprint: "a".repeat(64),
      impactFingerprint: "b".repeat(64),
      impact,
      blockers: [],
      canExecute: true,
      issuedAt: FIXTURE_TIMESTAMP,
      expiresAt: "2026-10-23T00:00:00.000Z",
      consumedAt: null,
      executionStatus: "pending",
    } } });
  });

  await page.route(/\/api\/me\/git-connections(?:\?.*)?$/u, (route) => {
    if (route.request().method() !== "GET") return route.abort();
    return route.fulfill({ json: { connections: [gitConnectionFixture], catalog: gitCatalog } });
  });

  await page.route(/\/api\/me\/mcp-connections(?:\?.*)?$/u, (route) => {
    if (route.request().method() !== "GET") return route.abort();
    return route.fulfill({ json: { connections: [mcpConnectionFixture] } });
  });

  return governanceState;
}

test("personal Git and MCP connection lists match the prototype across desktop and narrow appearances", async ({ page }) => {
  test.setTimeout(180_000);

  await signInR02Admin(page);
  await signOutR02User(page);
  const user = await seedBrowserPersonalUser(
    `connection-list-${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    "ConnectionList2026Password!",
  );
  await signInR02PersonalUser(page, user);

  // Read the real catalog first, then only replace the client list projection.
  const catalogResponse = await page.request.get("/api/me/git-connections");
  expect(catalogResponse.ok()).toBe(true);
  const { catalog } = await catalogResponse.json() as { catalog: GitCatalogEntry[] };
  expect(catalog.length).toBeGreaterThan(0);
  const governanceFixture = await installReadOnlyConnectionFixtures(page, catalog);

  for (const mode of APPEARANCE_MODES) {
    const english = mode.language === "en";
    const labels = {
      add: english ? "Add Git service" : "添加 Git 服务",
      closeDialog: english ? "Close dialog" : "关闭窗口",
      editName: english ? "Edit name" : "编辑名称",
      editNameDialog: english ? "Edit connection name" : "编辑连接名称",
      connectionName: english ? "Connection name" : "连接名称",
      manage: english ? "Security management" : "安全管理",
      askLauncher: english ? "Ask AI" : "智能问答",
      askDialog: english ? "Floating Ask AI" : "智能问答悬浮窗",
      askTextbox: english ? "Your question" : "输入问题",
      gitHeading: english ? "Git authorization" : "Git 授权管理",
      mcpHeading: english ? "My MCP connections" : "我的 MCP 连接",
    };

    await page.context().addCookies([
      { name: "aipos-language", value: mode.language, url: new URL(page.url()).origin, sameSite: "Lax" },
      { name: "aipos-theme", value: mode.theme, url: new URL(page.url()).origin, sameSite: "Lax" },
    ]);
    await page.setViewportSize({ width: mode.width, height: 900 });

    for (const connection of [
      { kind: "git", name: GIT_FIXTURE_NAME, heading: labels.gitHeading, path: "/personal/connections/git", addLabel: labels.add },
      { kind: "mcp", name: MCP_FIXTURE_NAME, heading: labels.mcpHeading, path: "/personal/connections/mcp", addLabel: english ? "Add MCP service" : "添加 MCP 服务" },
    ] as const) {
      await page.goto(connection.path);
      await expect(page.locator("html")).toHaveAttribute("lang", mode.language);
      await expect(page.locator("html")).toHaveAttribute("data-theme", mode.theme);
      await expect(page.getByRole("heading", { name: connection.heading, exact: true })).toBeVisible();

      const pageHeader = page.locator("[data-page-content] > section").first();
      const addButton = pageHeader.getByRole("button", { name: connection.addLabel, exact: true });
      await expect(addButton).toBeVisible();
      await expect(addButton).toBeEnabled();
      await expect(addButton).toHaveCSS("min-height", mode.width <= 700 ? "44px" : "40px");
      if (mode.width > 700) {
        const headingBounds = await page.getByRole("heading", { name: connection.heading, exact: true }).boundingBox();
        const actionBounds = await addButton.boundingBox();
        expect(Math.abs(actionBounds!.y + actionBounds!.height / 2 - headingBounds!.y - headingBounds!.height / 2), "header action aligns with the title instead of a wrapped description").toBeLessThanOrEqual(6);
      }

      const search = page.locator('[data-page-content] input[type="search"]');
      const status = page.locator("[data-page-content] select");
      const connectionHeading = page.getByRole("heading", { name: connection.name, exact: true });
      await expect(connectionHeading).toBeVisible();
      await expect(status).toHaveValue("all");
      await search.fill(connection.name);
      await expect(connectionHeading).toBeVisible();
      await search.fill("no matching browser fixture");
      await expect(connectionHeading).toHaveCount(0);
      await search.clear();

      await status.selectOption("disabled");
      await expect(connectionHeading).toHaveCount(0);
      await status.selectOption("verified");
      await expect(connectionHeading).toBeVisible();
      await expect(page.locator("[data-page-content] option:checked")).toHaveText(
        connection.kind === "mcp" ? english ? "Discovered" : "已发现" : english ? "Verified" : "已验证",
      );

      await expectR02NoHorizontalOverflow(page, `${connection.kind}-${mode.width}-${mode.language}-${mode.theme}`);

      const manageButton = page.getByRole("button", { name: labels.manage, exact: true });
      await manageButton.click();
      const drawer = page.locator("dialog[open]").filter({ has: page.getByRole("button", { name: labels.editName, exact: true }) });
      await expect(drawer).toBeVisible();
      const editButton = drawer.getByRole("button", { name: labels.editName, exact: true });
      await editButton.click();

      const editor = page.getByRole("dialog", { name: labels.editNameDialog, exact: true });
      await expect(editor).toBeVisible();
      const nameInput = editor.getByRole("textbox", { name: labels.connectionName, exact: true });
      await expect(nameInput).toBeVisible();
      const editorIsTopmostAtInput = await nameInput.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
        return hit === element || (hit !== null && element.contains(hit));
      });
      expect(editorIsTopmostAtInput, "the nested editor input must not be covered by its native drawer").toBe(true);

      const safeDraft = `Safe draft ${connection.kind}`;
      await nameInput.fill(safeDraft);
      const footer = editor.locator("[data-inquiry-footer]");
      const askLauncher = footer.getByRole("button", { name: labels.askLauncher, exact: true });
      await expect(askLauncher).toBeVisible();
      await askLauncher.click();
      const ask = page.getByRole("dialog", { name: labels.askDialog, exact: true });
      await expect(ask).toBeVisible();
      await ask.getByRole("textbox", { name: labels.askTextbox, exact: true }).press("Escape");
      await expect(ask).toBeHidden();
      await expect(editor).toBeVisible();
      await expect(nameInput).toHaveValue(safeDraft);
      await expect(askLauncher).toBeFocused();

      await page.keyboard.press("Escape");
      await expect(editor).toBeHidden();
      await expect(drawer).toBeVisible();
      await drawer.getByRole("button", { name: labels.closeDialog, exact: true }).click();
      await expect(drawer).toBeHidden();
      await expect(manageButton).toBeFocused();

      if (mode.language === "zh-CN" && connection.kind === "git") {
        await manageButton.click();
        await expect(drawer).toBeVisible();
        const governance = drawer.locator("section[aria-labelledby^='governance-title-']");
        await expect(governance.getByRole("heading", { name: "高风险变更安全预览", exact: true })).toBeVisible();
        const reason = "Keep this disable preview for Escape regression";
        const reasonInput = governance.getByRole("textbox", { name: "变更原因", exact: true });
        await reasonInput.fill(reason);
        await governance.getByRole("button", { name: "生成停用连接预览", exact: true }).click();

        const preview = governance.locator('[aria-live="polite"]');
        await expect(preview).toBeVisible();
        await expect(preview.getByText("可在确认后执行", { exact: true })).toBeVisible();
        expect(governanceFixture.previewRequests).toEqual([{ kind: "git", action: "disable", reason }]);

        // A pending opener can lose focus before a confirmation is mounted.
        // Force that case and exercise the native :modal host fallback.
        await governance.getByRole("button", { name: "继续停用连接", exact: true }).evaluate(button => {
          if (!(button instanceof HTMLButtonElement)) throw new Error("expected governance button");
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          if (document.activeElement?.closest("dialog[open]")) throw new Error("native fallback setup did not release focus");
          button.click();
        });
        const confirmation = page.getByRole("dialog", { name: "确认停用这条连接？", exact: true });
        await expect(confirmation).toBeVisible();
        expect(await confirmation.evaluate(element => element.closest("dialog[open]") !== null)).toBe(true);
        await expect(confirmation.getByRole("button", { name: "关闭窗口", exact: true })).toBeFocused();
        await page.keyboard.press("Escape");

        await expect(confirmation).toBeHidden();
        await expect(drawer).toBeVisible();
        await expect(governance).toBeVisible();
        await expect(reasonInput).toHaveValue(reason);
        await expect(governance.getByRole("button", { name: "继续停用连接", exact: true })).toBeFocused();
        await expect(preview).toBeVisible();
        await expect(preview.getByText("可在确认后执行", { exact: true })).toBeVisible();
        expect(governanceFixture.executeRequests).toEqual([]);

        await drawer.getByRole("button", { name: labels.closeDialog, exact: true }).click();
        await expect(drawer).toBeHidden();
        await expect(manageButton).toBeFocused();
      }
    }
  }
});
