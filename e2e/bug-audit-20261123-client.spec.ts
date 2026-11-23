import { expect, test, type Page, type Route } from "@playwright/test";
import { signInR02Admin } from "./support/r02-admin-navigation";

const TARGET_USER_ID = "83000000-0000-4000-8000-000000000004";

type Deferred = { promise: Promise<void>; resolve: () => void };
type RequestHold = { requested: Deferred; release: Deferred; completed: Deferred };

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function requestHold(): RequestHold {
  return { requested: deferred(), release: deferred(), completed: deferred() };
}

async function fulfillJson(route: Route, payload: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
}

function usersPayload(username: string) {
  return {
    items: [{
      user: { id: `user-${username}`, username, displayName: null, state: "enabled", closedAt: null, disabledAt: null, accountAccessVersion: 1 },
      membership: { state: "none", expiresAt: null, version: 0 },
      credits: { grantCount: 0, activeGrantCount: 0, availableTokens: 0, reservedTokens: 0, difference: "missing" },
    }],
    page: 1,
    pageSize: 20,
    hasNextPage: false,
  };
}

function creditsPayload(username: string) {
  return {
    grants: [],
    users: [{ id: TARGET_USER_ID, username, displayName: null, disabled: false, grantCount: 0, activeGrantCount: 0, availableTokens: 0, reservedTokens: 0, difference: "missing" }],
    grantsHasNextPage: false,
    usersHasNextPage: false,
  };
}

async function fulfillHeldRoute(route: Route, hold: RequestHold, payload: unknown, status = 200): Promise<void> {
  hold.requested.resolve();
  await hold.release.promise;
  try {
    await fulfillJson(route, payload, status);
  } catch {
    // The component may have aborted this response after a newer query began.
  } finally {
    hold.completed.resolve();
  }
}

async function verifyListRace(page: Page, kind: "users" | "credits"): Promise<void> {
  const endpoint = kind === "users" ? "/api/admin/users" : "/api/admin/credits/grants";
  const oldInitial = requestHold();
  const oldSearchError = requestHold();
  const latestSearch = requestHold();
  let initialUsed = false;

  if (kind === "credits") {
    await page.route("**/api/admin/credits/policies", (route) => fulfillJson(route, { policies: [] }));
  }
  await page.route(`${endpoint}?*`, async (route) => {
    const search = new URL(route.request().url()).searchParams.get("search") ?? "";
    if (search === "" && !initialUsed) {
      initialUsed = true;
      await fulfillHeldRoute(route, oldInitial, kind === "users" ? usersPayload("old-default-user") : creditsPayload("old-default-user"));
      return;
    }
    if (search === "alice") {
      await fulfillJson(route, kind === "users" ? usersPayload("alice") : creditsPayload("alice"));
      return;
    }
    if (search === "bob") {
      await fulfillHeldRoute(route, oldSearchError, { error: { message: "stale request error" } }, 500);
      return;
    }
    if (search === "carol") {
      await fulfillHeldRoute(route, latestSearch, kind === "users" ? usersPayload("carol") : creditsPayload("carol"));
      return;
    }
    await fulfillJson(route, kind === "users" ? usersPayload(search || "default-user") : creditsPayload(search || "default-user"));
  });

  await page.goto(kind === "users" ? "/admin/users" : "/admin/credits");
  await oldInitial.requested.promise;
  const search = page.getByRole("textbox", { name: kind === "users" ? "搜索普通用户" : "搜索用户" });
  await search.fill("alice");
  await expect.poll(() => page.locator(`${kind === "users" ? "section[aria-labelledby='admin-users-list-title']" : "section[aria-labelledby='platform-credit-governance-title']"}`).getByText("alice", { exact: true }).count()).toBeGreaterThan(0);

  oldInitial.release.resolve();
  await oldInitial.completed.promise;
  const panel = page.locator(kind === "users" ? "section[aria-labelledby='admin-users-list-title']" : "section[aria-labelledby='platform-credit-governance-title']");
  await expect(panel.getByText("alice", { exact: true })).toBeVisible();
  await expect(panel.getByText("old-default-user", { exact: true })).toHaveCount(0);

  await search.fill("bob");
  await oldSearchError.requested.promise;
  await search.fill("carol");
  await latestSearch.requested.promise;
  oldSearchError.release.resolve();
  await oldSearchError.completed.promise;
  if (kind === "users") {
    await expect(page.locator("section[aria-labelledby='admin-users-list-title']").getByText("读取中…", { exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  } else {
    await expect(panel.locator(":scope > div").first().getByText("读取中…", { exact: true })).toBeVisible();
    await expect(panel.getByRole("status")).toHaveCount(0);
  }

  latestSearch.release.resolve();
  await latestSearch.completed.promise;
  await expect(panel.getByText("carol", { exact: true })).toBeVisible();
  await expect(panel.getByText("stale request error", { exact: true })).toHaveCount(0);
  if (kind === "users") {
    await expect(panel.getByText("读取中…", { exact: true })).toHaveCount(0);
  } else {
    await expect(panel.locator(":scope > div").first().getByText("读取中…", { exact: true })).toHaveCount(0);
  }
}

async function installCreditPreviewRoutes(page: Page, captured: { expiresAt: string }[]): Promise<void> {
  await page.route("**/api/admin/credits/policies", (route) => fulfillJson(route, { policies: [] }));
  await page.route("**/api/admin/credits/grants?*", (route) => fulfillJson(route, creditsPayload("fixture-user")));
  await page.route("**/api/admin/credits/grants/preview", async (route) => {
    captured.push(route.request().postDataJSON() as { expiresAt: string });
    await fulfillJson(route, { error: { message: "隔离预览已捕获" } }, 422);
  });
}

async function verifyCreditExpiry(page: Page, scenario: {
  timezoneId: string;
  defaultField: string;
  defaultIso: string;
  manualIso: string;
}, captured: { expiresAt: string }[]): Promise<void> {
  const capturedFrom = captured.length;
  await page.clock.install({ time: new Date("2026-11-23T02:00:00.000Z") });
  await installCreditPreviewRoutes(page, captured);
  await page.goto("/admin/credits");
  await page.getByRole("button", { name: "额度操作", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const expiry = dialog.getByLabel("到期时间");
  await expect(dialog.getByRole("combobox", { name: "补发目标" })).toHaveValue(TARGET_USER_ID);
  await expect(expiry).toHaveValue(scenario.defaultField);
  await dialog.getByLabel("原因（必填）").fill("隔离预览");

  await dialog.getByRole("button", { name: "预览补发", exact: true }).click();
  await expect.poll(() => captured.length).toBe(capturedFrom + 1);
  expect(captured[capturedFrom]!.expiresAt).toBe(scenario.defaultIso);
  expect((Date.parse(captured[capturedFrom]!.expiresAt) - Date.parse("2026-11-23T02:00:00.000Z")) / 3_600_000).toBe(720);

  await expiry.fill("2026-12-24T11:45");
  await dialog.getByRole("button", { name: "预览补发", exact: true }).click();
  await expect.poll(() => captured.length).toBe(capturedFrom + 2);
  expect(captured[capturedFrom + 1]!.expiresAt).toBe(scenario.manualIso);
  await expect(expiry).toHaveValue("2026-12-24T11:45");
  await expect(page.getByText("隔离预览已捕获", { exact: true })).toBeVisible();
}

test("admin user list keeps current search after old success and error responses", async ({ page }) => {
  await signInR02Admin(page);
  await verifyListRace(page, "users");
});

test("platform credit user list keeps current search after old success and error responses", async ({ page }) => {
  await signInR02Admin(page);
  await verifyListRace(page, "credits");
});

test("platform credit default and manual expiry preserve local time in Shanghai, UTC, and Los Angeles", async ({ browser, page }) => {
  await signInR02Admin(page);
  const storageState = await page.context().storageState();
  const baseURL = new URL(page.url()).origin;
  const cases = [
    { timezoneId: "Asia/Shanghai", defaultField: "2026-12-23T10:00", defaultIso: "2026-12-23T02:00:00.000Z", manualIso: "2026-12-24T03:45:00.000Z" },
    { timezoneId: "UTC", defaultField: "2026-12-23T02:00", defaultIso: "2026-12-23T02:00:00.000Z", manualIso: "2026-12-24T11:45:00.000Z" },
    { timezoneId: "America/Los_Angeles", defaultField: "2026-12-22T18:00", defaultIso: "2026-12-23T02:00:00.000Z", manualIso: "2026-12-24T19:45:00.000Z" },
  ] as const;
  const captured: { expiresAt: string }[] = [];

  for (const [index, scenario] of cases.entries()) {
    if (index === 0) {
      await verifyCreditExpiry(page, scenario, captured);
      continue;
    }
    const context = await browser.newContext({ baseURL, locale: "zh-CN", timezoneId: scenario.timezoneId, storageState });
    const zonedPage = await context.newPage();
    try {
      await verifyCreditExpiry(zonedPage, scenario, captured);
    } finally {
      await context.close();
    }
  }
});
