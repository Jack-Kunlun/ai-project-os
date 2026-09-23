import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { getDb } from "@/lib/db";
import { seedBrowserPersonalUser, type BrowserPersonalUser } from "./support/browser-fixtures";

const BROWSER_ADMIN_PASSWORD = "BrowserGate2026Password!";

async function signInBrowserPersonalUser(page: Page): Promise<BrowserPersonalUser> {
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/(?:setup|login|admin)$/u);
  const landingPath = new URL(page.url()).pathname;
  if (landingPath === "/setup") {
    await page.getByLabel("用户名", { exact: true }).fill("browser_admin");
    await page.getByLabel("密码", { exact: true }).fill(BROWSER_ADMIN_PASSWORD);
    await page.getByLabel("再次输入密码", { exact: true }).fill(BROWSER_ADMIN_PASSWORD);
    await page.getByRole("button", { name: "创建管理员并进入" }).click();
  } else if (landingPath === "/login") {
    await page.getByLabel("用户名", { exact: true }).fill("browser_admin");
    await page.getByLabel("密码", { exact: true }).fill(BROWSER_ADMIN_PASSWORD);
    await page.getByRole("button", { name: "登 录", exact: true }).click();
  }
  await expect(page).toHaveURL(/\/admin$/u);
  const personalUser = await seedBrowserPersonalUser(`browser-confirmation-${randomUUID().replaceAll("-", "").slice(0, 12)}`, "BrowserPersonal2026Password!");
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/u);
  await page.getByLabel("用户名", { exact: true }).fill(personalUser.username);
  await page.getByLabel("密码", { exact: true }).fill(personalUser.password);
  await page.getByRole("button", { name: "登 录", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/u);
  return personalUser;
}

async function createProject(page: Page, name: string): Promise<string> {
  await page.goto("/projects");
  await page.getByRole("button", { name: "＋ 新建项目" }).click();
  await page.getByLabel("项目名称", { exact: true }).fill(name);
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  const projectCard = page.locator("article").filter({ has: page.getByRole("heading", { name, exact: true }) });
  const projectHref = await projectCard.getByRole("link", { name: "进入项目", exact: true }).getAttribute("href");
  expect(projectHref).toMatch(/^\/projects\/[0-9a-f-]+$/u);
  return projectHref!.slice("/projects/".length);
}

async function addSource(page: Page, projectId: string, contentText: string): Promise<void> {
  const response = await page.evaluate(async ({ projectId, contentText }) => {
    return fetch(`/api/projects/${projectId}/sources`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentText }),
    }).then(async (result) => ({ status: result.status, body: await result.json() as unknown }));
  }, { projectId, contentText });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
}

async function seedPlatformEmbeddingRoute(adminUsername: string, ownerUsername: string): Promise<{
  providerId: string;
  credentialId: string;
  routeId: string;
  grantId: string | null;
}> {
  const db = getDb();
  const admin = await db.appUser.findUniqueOrThrow({ where: { username: adminUsername }, select: { id: true, role: true } });
  const owner = await db.appUser.findUniqueOrThrow({ where: { username: ownerUsername }, select: { id: true, role: true } });
  if (admin.role !== "admin" || owner.role !== "user") throw new Error("BROWSER_CONFIRMATION_IDENTITY_BOUNDARY_INVALID");
  const providerId = randomUUID();
  const credentialId = randomUUID();
  const now = new Date();
  await db.externalCredential.create({
    data: {
      id: credentialId,
      kind: "aiProvider",
      ciphertext: Buffer.from([1]),
      nonce: Buffer.from([2]),
      authTag: Buffer.from([3]),
      maskedSuffix: "gate",
      secretFingerprint: "b".repeat(64),
    },
  });
  await db.aiProviderConnection.create({
    data: {
      id: providerId,
      name: `Browser confirmation provider ${providerId.slice(0, 8)}`,
      kind: "glm",
      scope: "platform",
      ownerUserId: null,
      protocol: "chatCompletions",
      baseUrl: "https://example.invalid/browser-confirmation",
      credentialId,
      defaultGenerationModelId: "glm-4-flash",
      defaultEmbeddingModelId: "embedding-3",
      embeddingDimensions: 1024,
      status: "verified",
      lastTestedAt: now,
    },
  });
  const activeRoute = await db.platformDefaultAiRoute.findFirst({
    where: { operation: "embedding", status: "active" },
    orderBy: [{ version: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (activeRoute !== null) {
    await db.platformDefaultAiRoute.update({ where: { id: activeRoute.id }, data: { status: "retired", updatedById: admin.id } });
  }
  const latestRoute = await db.platformDefaultAiRoute.findFirst({ where: { operation: "embedding" }, orderBy: { version: "desc" }, select: { version: true } });
  const route = await db.platformDefaultAiRoute.create({
    data: {
      operation: "embedding",
      version: (latestRoute?.version ?? 0) + 1,
      status: "active",
      providerConnectionId: providerId,
      modelId: "embedding-3",
      embeddingDimensions: 1024,
      maxOutputTokens: null,
      quotaMultiplierBps: 10_000,
      validatedProviderConfigurationVersion: 1,
      validatedAt: now,
      createdById: admin.id,
      updatedById: admin.id,
    },
    select: { id: true },
  });
  const ownerGrant = await db.platformTokenGrant.findFirst({ where: { userId: owner.id, kind: "signup" }, select: { id: true } });
  if (ownerGrant === null) throw new Error("BROWSER_CONFIRMATION_OWNER_SIGNUP_GRANT_UNAVAILABLE");
  return { providerId, credentialId, routeId: route.id, grantId: null };
}

async function cleanupPlatformEmbeddingFixture(projectId: string, fixture: Awaited<ReturnType<typeof seedPlatformEmbeddingRoute>>): Promise<void> {
  const db = getDb();
  await db.project.delete({ where: { id: projectId } });
  await db.platformDefaultAiRouteAudit.deleteMany({ where: { routeId: fixture.routeId } });
  await db.platformDefaultAiRoute.delete({ where: { id: fixture.routeId } });
  await db.aiProviderConnection.delete({ where: { id: fixture.providerId } });
  await db.externalCredential.delete({ where: { id: fixture.credentialId } });
  if (fixture.grantId !== null) {
    await db.platformTokenLedgerEntry.deleteMany({ where: { grantId: fixture.grantId } });
    await db.platformTokenGrant.delete({ where: { id: fixture.grantId } });
  }
}

test("memory confirmation prepare and execute are single-flight and stale input fails closed", async ({ page }) => {
  const personalUser = await signInBrowserPersonalUser(page);
  const projectId = await createProject(page, `Browser confirmation ${randomUUID().slice(0, 8)}`);
  const fixture = await seedPlatformEmbeddingRoute("browser_admin", personalUser.username);
  try {
    await addSource(page, projectId, `Browser confirmation source ${randomUUID()}`);
    await page.goto(`/projects/${projectId}/memory`);
    const indexPanel = page.locator("section").filter({ has: page.getByRole("heading", { name: "项目语义索引", exact: true }) });
    await expect(indexPanel).toBeVisible();
    const prepareRequests: string[] = [];
    const executeRequests: string[] = [];
    const endpoint = `/api/projects/${projectId}/memory/index`;
    page.on("request", (request) => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== endpoint) return;
      const phase = (JSON.parse(request.postData() ?? "{}") as { phase?: string }).phase;
      if (phase === "prepare") prepareRequests.push(phase);
      if (phase === "execute") executeRequests.push(phase);
    });

    const prepareButton = indexPanel.getByRole("button", { name: "读取本次外发摘要", exact: true });
    await expect(prepareButton).toBeEnabled();
    await prepareButton.evaluate((element) => {
      const button = element as HTMLButtonElement;
      button.click();
      button.click();
    });
    await expect(indexPanel.getByText("本次外发摘要", { exact: true })).toBeVisible();
    expect(prepareRequests).toHaveLength(1);

    const db = getDb();
    const beforeCounts = {
      jobs: await db.backgroundJob.count({ where: { projectId, kind: "memoryIndex" } }),
      grants: await db.webAiGrant.count({ where: { projectId } }),
      providerCalls: await db.providerCallAudit.count(),
    };
    const secondSource = `Browser confirmation stale source ${randomUUID()}`;
    await addSource(page, projectId, secondSource);

    const executeButton = indexPanel.getByRole("button", { name: "建立语义索引", exact: true });
    await expect(executeButton).toBeVisible();
    await executeButton.evaluate((element) => {
      const button = element as HTMLButtonElement;
      button.click();
      button.click();
    });
    await expect(indexPanel).toContainText("重新读取外发摘要");
    expect(executeRequests).toHaveLength(1);

    expect(await db.backgroundJob.count({ where: { projectId, kind: "memoryIndex" } })).toBe(beforeCounts.jobs);
    expect(await db.webAiGrant.count({ where: { projectId } })).toBe(beforeCounts.grants);
    expect(await db.providerCallAudit.count()).toBe(beforeCounts.providerCalls);
    const challenges = await db.webAiConfirmationChallenge.findMany({ where: { projectId }, select: { consumedAt: true, consumedJobId: true } });
    expect(challenges).toHaveLength(1);
    expect(challenges[0]).toMatchObject({ consumedAt: null, consumedJobId: null });
  } finally {
    await cleanupPlatformEmbeddingFixture(projectId, fixture);
  }
});
