import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { getEntitlementDb } from "@/lib/db";
import { appendWorkspaceMembershipAudit } from "@/lib/membership-governance";
import { createWorkspaceInvitation } from "@/lib/workspaces";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { signInR02Admin, signInR02PersonalUser } from "./support/r02-admin-navigation";

const TEAM_OWNER_PASSWORD = "TeamAdminBugOwner2026!";

async function seedTeamOwner(prefix: string) {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const owner = await seedBrowserPersonalUser(`${prefix}-${suffix}`, TEAM_OWNER_PASSWORD);
  const workspaceId = randomUUID();
  const db = getEntitlementDb();
  await db.$transaction(async (tx) => {
    await tx.workspace.create({
      data: { id: workspaceId, name: `Browser ${prefix} ${suffix}`, slug: `browser-${prefix}-${suffix}`, createdById: owner.id },
    });
    const membership = await tx.workspaceMembership.create({
      data: { id: randomUUID(), workspaceId, userId: owner.id, role: "owner", accessState: "confirmed" },
    });
    await appendWorkspaceMembershipAudit(tx, membership, {
      action: "confirmed", previousState: null, actorId: owner.id, reason: `browser_${prefix}_owner_fixture_created`,
    });
  });
  const row = await db.appUser.findUniqueOrThrow({ where: { id: owner.id }, select: { accountAccessVersion: true } });
  return { db, owner, workspaceId, actor: { id: owner.id, role: "user" as const, accountAccessVersion: row.accountAccessVersion } };
}

test("T-052: page through 102 active invitations and reach the original revoke preview", async ({ page }) => {
  test.setTimeout(180_000);
  const fixture = await seedTeamOwner("team-invitation-pagination");
  const createdEmails: string[] = [];
  for (let index = 1; index <= 100; index += 1) {
    const email = `invite-${index}-${randomUUID().slice(0, 8)}@example.test`;
    createdEmails.push(email);
    await createWorkspaceInvitation(fixture.workspaceId, { email, workspaceRole: "member", requestKey: randomUUID() }, fixture.actor, fixture.db);
  }
  const firstPageOldest = await fixture.db.workspaceInvitation.findMany({
    where: { workspaceId: fixture.workspaceId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 2,
    select: { id: true, email: true, revokedAt: true, acceptedAt: true, expiresAt: true },
  });
  expect(firstPageOldest).toHaveLength(2);
  await signInR02PersonalUser(page, fixture.owner);
  let invitationStatus: number | null = null;
  let invitationCount: number | null = null;
  await page.route(`**/api/workspaces/${fixture.workspaceId}/invitations*`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    invitationStatus = response.status();
    const payload = await response.json() as { invitations: unknown[]; nextCursor: string | null };
    invitationCount = payload.invitations.length;
    return route.fulfill({ response, json: payload });
  });
  await page.goto(`/team/${fixture.workspaceId}?view=invitations`);
  await expect(page.getByRole("heading", { name: "邀请记录", exact: true })).toBeVisible();
  await expect.poll(() => invitationStatus, { timeout: 30_000 }).toBe(200);
  await expect.poll(() => invitationCount, { timeout: 30_000 }).toBe(100);
  await expect(page.getByRole("button", { name: "撤销", exact: true })).toHaveCount(100, { timeout: 30_000 });
  for (const invitation of firstPageOldest) await expect(page.getByText(invitation.email!, { exact: true })).toBeVisible();

  // Reproduce the 101st and 102nd additions through the same governed service used by the local API.
  for (const index of [101, 102]) {
    const email = `invite-${index}-${randomUUID().slice(0, 8)}@example.test`;
    createdEmails.push(email);
    await createWorkspaceInvitation(fixture.workspaceId, { email, workspaceRole: "member", requestKey: randomUUID() }, fixture.actor, fixture.db);
  }
  await page.reload();
  await expect(page.getByRole("button", { name: "撤销", exact: true })).toHaveCount(100, { timeout: 30_000 });
  for (const invitation of firstPageOldest) await expect(page.getByText(invitation.email!, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "下一页", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByText(/邀请记录第\s*2页/u)).toBeVisible();

  for (const invitation of firstPageOldest) {
    await expect(page.getByText(invitation.email!, { exact: true })).toBeVisible();
    expect(invitation.acceptedAt).toBeNull();
    expect(invitation.revokedAt).toBeNull();
    expect(invitation.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const card = page.getByText(invitation.email!, { exact: true }).locator("xpath=ancestor::div[contains(@class, 'rounded-panel')][1]");
    await expect(card.getByRole("button", { name: "撤销", exact: true })).toBeVisible();
  }

  const firstInvitationCard = page.getByText(firstPageOldest[0]!.email!, { exact: true }).locator("xpath=ancestor::div[contains(@class, 'rounded-panel')][1]");
  await firstInvitationCard.getByRole("button", { name: "撤销", exact: true }).click();
  const revokeDialog = page.getByRole("dialog");
  await expect(revokeDialog.getByText(`撤销发给 ${firstPageOldest[0]!.email} 的邀请`, { exact: true })).toBeVisible();
  await expect(revokeDialog.getByLabel("撤销原因（必填）", { exact: true })).toBeVisible();
  await expect(revokeDialog.getByRole("button", { name: "确认撤销邀请", exact: true })).toBeVisible();
  await revokeDialog.getByRole("button", { name: "取消", exact: true }).click();
  const stillActive = await fixture.db.workspaceInvitation.findMany({
    where: { id: { in: firstPageOldest.map((item) => item.id) }, workspaceId: fixture.workspaceId },
    select: { revokedAt: true },
  });
  expect(stillActive.every((invitation) => invitation.revokedAt === null)).toBe(true);
  expect(createdEmails).toHaveLength(102);
});

test("T-052: a late older-page response cannot replace the first page refreshed after creating an invitation", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = await seedTeamOwner("team-invitation-stale-page");
  for (let index = 1; index <= 101; index += 1) {
    await createWorkspaceInvitation(fixture.workspaceId, {
      email: `stale-page-${index}-${randomUUID().slice(0, 8)}@example.test`,
      workspaceRole: "member",
      requestKey: randomUUID(),
    }, fixture.actor, fixture.db);
  }
  const oldestInvitation = await fixture.db.workspaceInvitation.findFirstOrThrow({
    where: { workspaceId: fixture.workspaceId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { email: true },
  });
  await signInR02PersonalUser(page, fixture.owner);

  let releaseOlderPage!: () => void;
  let markOlderPageStarted!: () => void;
  let markOlderPageFulfilled!: () => void;
  const olderPageGate = new Promise<void>((resolve) => { releaseOlderPage = resolve; });
  const olderPageStarted = new Promise<void>((resolve) => { markOlderPageStarted = resolve; });
  const olderPageFulfilled = new Promise<void>((resolve) => { markOlderPageFulfilled = resolve; });
  let olderPageRequestCount = 0;
  let firstPageRefreshCount = 0;
  let olderPageWasRequested = false;
  await page.route(`**/api/workspaces/${fixture.workspaceId}/invitations*`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (cursor !== null) {
      olderPageWasRequested = true;
      olderPageRequestCount += 1;
    } else if (olderPageWasRequested) {
      firstPageRefreshCount += 1;
    }
    const response = await route.fetch();
    const payload = await response.json() as { invitations: unknown[]; nextCursor: string | null };
    const status = response.status();
    if (cursor !== null && olderPageRequestCount === 1) {
      markOlderPageStarted();
      await olderPageGate;
    }
    await route.fulfill({ status, contentType: "application/json", json: payload });
    if (cursor !== null && olderPageRequestCount === 1) markOlderPageFulfilled();
  });

  try {
    await page.goto(`/team/${fixture.workspaceId}?view=invitations`);
    await expect(page.getByRole("button", { name: "下一页", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "下一页", exact: true }).evaluate((button) => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await olderPageStarted;
    expect(olderPageRequestCount).toBe(1);

    const newEmail = `fresh-page-${randomUUID().slice(0, 8)}@example.test`;
    await page.getByRole("button", { name: "创建邀请", exact: true }).click();
    const createDialog = page.getByRole("dialog");
    await createDialog.getByLabel("邮箱（必填）", { exact: true }).fill(newEmail);
    await createDialog.getByRole("button", { name: "生成 7 天邀请", exact: true }).click();
    await expect(createDialog.getByText("邀请链接只在本次创建后显示，请立即复制并安全发送。", { exact: true })).toBeVisible();
    await expect.poll(() => firstPageRefreshCount, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(page.getByText(newEmail, { exact: true })).toBeVisible();
    await expect(page.getByText(/邀请记录第\s*1页/u)).toBeVisible();

    const olderPageResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === `/api/workspaces/${fixture.workspaceId}/invitations` && url.searchParams.has("cursor");
    });
    releaseOlderPage();
    await olderPageResponse;
    await olderPageFulfilled;
    expect(olderPageRequestCount).toBe(1);
    await expect(page.getByText(newEmail, { exact: true })).toBeVisible();
    await expect(page.getByText(oldestInvitation.email!, { exact: true })).toHaveCount(0);
    await expect(page.getByText(/邀请记录第\s*1页/u)).toBeVisible();
    await expect(page.getByRole("button", { name: "下一页", exact: true })).toBeEnabled();
  } finally {
    releaseOlderPage();
  }
});

test("T-055: an activity 503 leaves independent team overview and permission projections usable", async ({ page }) => {
  const fixture = await seedTeamOwner("team-projection-recovery");
  await signInR02PersonalUser(page, fixture.owner);
  const origin = new URL(page.url()).origin;
  const projectName = `Independent projection ${randomUUID().slice(0, 8)}`;
  const projectResponse = await page.context().request.post(new URL("/api/projects", origin).toString(), {
    headers: { origin },
    data: { name: projectName, description: "T-055 isolated browser project.", workspaceId: fixture.workspaceId },
  });
  expect(projectResponse.status(), await projectResponse.text()).toBe(201);

  const statuses = new Map<string, number>();
  await page.route(`**/api/teams/${fixture.workspaceId}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/activity")) {
      statuses.set(path, 503);
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "CONTROLLED_FAILURE", message: "Activity read failed" } }) });
    }
    const response = await route.fetch();
    statuses.set(path, response.status());
    return route.fulfill({ response });
  });

  await page.goto(`/team/${fixture.workspaceId}`);
  await expect(page.getByRole("link", { name: projectName, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "团队项目", exact: true })).toBeVisible();
  await expect(page.getByText("团队活动加载失败", { exact: true })).toBeVisible();
  await expect.poll(() => statuses.get(`/api/teams/${fixture.workspaceId}/overview`), { timeout: 30_000 }).toBe(200);
  await expect.poll(() => statuses.get(`/api/teams/${fixture.workspaceId}/permissions`), { timeout: 30_000 }).toBe(200);
  await expect.poll(() => statuses.get(`/api/teams/${fixture.workspaceId}/activity`), { timeout: 30_000 }).toBe(503);

  await page.getByRole("button", { name: "我的权限", exact: true }).click();
  await expect(page.getByRole("heading", { name: "我的项目权限", exact: true })).toBeVisible();
  await expect(page.getByText(projectName, { exact: true })).toBeVisible();
  await expect(page.getByText("团队活动加载失败", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "活动记录", exact: true }).click();
  const activityError = page.locator("div.app-feedback-error[role='alert']");
  await expect(activityError).toBeVisible();
  await expect(activityError.getByText("团队活动加载失败", { exact: true })).toBeVisible();
  await expect(activityError.getByRole("button", { name: "重试", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "团队总览", exact: true }).click();
  await expect(page.getByRole("link", { name: projectName, exact: true })).toBeVisible();
});

test("T-061: a delayed manual backup response cannot replace the 30-second poll result", async ({ page }) => {
  await signInR02Admin(page);
  const origin = new URL(page.url()).origin;
  const templateResponse = await page.request.get(new URL("/api/system/operations/backups", origin).toString());
  expect(templateResponse.status()).toBe(200);
  const snapshotTemplate = await templateResponse.json() as { sourceStatus: "ready" | "not_configured" | "invalid"; recoveryDrillSourceStatus: "ready" | "not_configured" | "invalid" } & Record<string, unknown>;
  await page.clock.install({ time: new Date("2026-11-23T03:00:00.000Z") });
  let requestCount = 0;
  let releaseOldRequest!: () => void;
  let markOldRequestStarted!: () => void;
  const oldRequestGate = new Promise<void>((resolve) => { releaseOldRequest = resolve; });
  const oldRequestStarted = new Promise<void>((resolve) => { markOldRequestStarted = resolve; });
  await page.route("**/api/system/operations/backups", async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      markOldRequestStarted();
      await oldRequestGate;
      return route.fulfill({ status: 200, contentType: "application/json", json: { ...snapshotTemplate, sourceStatus: "invalid", recoveryDrillSourceStatus: "invalid" } });
    }
    return route.fulfill({ status: 200, contentType: "application/json", json: { ...snapshotTemplate, sourceStatus: "not_configured", recoveryDrillSourceStatus: "not_configured" } });
  });

  try {
    await page.goto("/admin/operations/backups");
    await expect(page.getByRole("heading", { name: "生产备份与 COS 同步", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "刷新状态", exact: true }).click();
    await oldRequestStarted;
    await page.clock.fastForward(30_000);
    await expect(page.getByText("应用尚未挂载服务器的脱敏备份状态目录。完成生产安装与下一次部署后，这里会开始显示记录。", { exact: true })).toBeVisible();
    releaseOldRequest();
    await expect(page.getByText("服务器状态文件未通过格式或安全校验，原始内容不会展示。", { exact: true })).toHaveCount(0);
    expect(requestCount).toBeGreaterThanOrEqual(2);
  } finally {
    releaseOldRequest();
  }
});

test("T-062: SMS test phone accepts country-code and spaced clipboard formats without sending", async ({ page }) => {
  await signInR02Admin(page);
  const writes: string[] = [];
  page.on("request", (request) => { if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(`${request.method()} ${new URL(request.url()).pathname}`); });
  await page.goto("/admin/sms");
  await expect(page.getByRole("heading", { name: "短信服务", exact: true })).toBeVisible();
  const openButton = page.getByRole("button", { name: /新增供应商|编辑或更换供应商/u });
  await expect(openButton).toBeEnabled();
  await openButton.click();
  const phone = page.getByLabel("测试手机号（中国大陆 +86）", { exact: true });
  for (const value of ["+86 138 0013 8000", "0086 138 0013 8000", "13800138000"]) {
    await phone.fill(value);
    await expect(phone).toHaveValue("13800138000");
  }
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "关闭配置弹窗", exact: true }).click();
});

test("T-063: a same-frame double next click creates one history transition", async ({ page }) => {
  await signInR02Admin(page);
  const entry = (entryId: string, reason: string) => ({
    entryId, source: "workerBackgroundJob" as const, lifecycle: "observed_failure" as const,
    occurredAt: "2026-11-23T03:00:00.000Z", safeErrorCode: "CONTROLLED_TEST_FAILURE",
    responsibility: "系统管理员" as const, reason, nextStep: "复核测试记录", destination: null,
  });
  await page.route("**/api/admin/operations/failures?**", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    const payload = {
      entries: cursor === null ? [entry("page-one", "第一页 controlled sample")] : [entry("page-two", "第二页 controlled sample")],
      nextCursor: cursor === null ? "test-page-two" : null,
      observedAt: "2026-11-23T03:00:00.000Z",
      window: { days: 7, from: "2026-11-16T00:00:00.000Z", to: "2026-11-23T00:00:00.000Z" },
      pageSize: 20,
      partialSources: [],
    };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
  });
  await page.goto("/admin/operations/failures");
  await expect(page.getByText("第一页 controlled sample", { exact: true })).toBeVisible();
  const next = page.getByRole("button", { name: "下一页", exact: true });
  await next.evaluate((button) => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect(page.getByText("第二页 controlled sample", { exact: true })).toBeVisible();
  const previous = page.getByRole("button", { name: "上一页", exact: true });
  await previous.click();
  await expect(page.getByText("第一页 controlled sample", { exact: true })).toBeVisible();
  await expect(previous).toBeDisabled();
});

test("T-064: admin membership, user credit and provider lists suppress false empty states on 503", async ({ page }) => {
  await signInR02Admin(page);
  const origin = new URL(page.url()).origin;
  const cases = [
    {
      route: "/admin/users/memberships",
      api: "/api/system/memberships?search=",
      matcher: "**/api/system/memberships?*",
      empty: "没有匹配的用户。",
    },
    {
      route: "/admin/credits",
      api: "/api/admin/credits/grants?grantPage=1&grantPageSize=10&userPage=1&userPageSize=10",
      matcher: "**/api/admin/credits/grants?*",
      empty: "暂无平台额度记录。",
    },
    {
      route: "/admin/models",
      api: "/api/settings/providers",
      matcher: "**/api/settings/providers",
      empty: "尚未配置供应商。",
    },
  ] as const;

  for (const fixture of cases) {
    const baseline = await page.request.get(new URL(fixture.api, origin).toString());
    expect(baseline.status(), `${fixture.api} baseline`).toBe(200);
    const payload = await baseline.json() as { items?: unknown[]; users?: unknown[]; providers?: unknown[] };
    if (fixture.route.endsWith("memberships")) expect(Array.isArray(payload.items)).toBe(true);
    if (fixture.route.endsWith("credits")) expect(Array.isArray(payload.users)).toBe(true);
    if (fixture.route.endsWith("models")) expect(Array.isArray(payload.providers)).toBe(true);

    let failures = 0;
    await page.route(fixture.matcher, async (route) => {
      failures += 1;
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "CONTROLLED_READ_FAILURE", message: "Controlled list read failure" } }) });
    });
    await page.goto(fixture.route);
    const listError = page.locator("div.app-feedback-error[role='alert']");
    await expect(listError).toBeVisible();
    await expect(page.getByText(fixture.empty, { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "重试读取", exact: true }).click();
    await expect.poll(() => failures).toBe(2);
    await expect(listError).toBeVisible();
    await expect(page.getByText(fixture.empty, { exact: true })).toHaveCount(0);
    await page.unroute(fixture.matcher);
  }
});
