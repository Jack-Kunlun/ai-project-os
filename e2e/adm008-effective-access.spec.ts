import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { getDb } from "@/lib/db";
import { grantProjectMembership, grantWorkspaceMembership } from "@/lib/membership-governance";
import { createPasswordRecord } from "@/lib/auth";
import { signInR02Admin } from "./support/r02-admin-navigation";

const ADMIN_PASSWORD = "BrowserGate2026Password!";

test("ADM-008 account cards lazy-load a safe effective access matrix", async ({ page }) => {
  test.setTimeout(120_000);
  const db = getDb();
  const adminId = randomUUID();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const username = `adm008-user-${suffix}`;
  const projectName = `ADM008 project ${suffix}`;
  const workspaceName = `ADM008 workspace ${suffix}`;
  try {
    await db.appUser.create({ data: { id: adminId, username: "browser_admin", role: "admin", ...(await createPasswordRecord(ADMIN_PASSWORD)) } });
    await signInR02Admin(page);
    await db.appUser.create({ data: { id: userId, username, role: "user", ...(await createPasswordRecord("ADM008User2026Password!")) } });
    await db.$transaction(async (tx) => {
      await tx.workspace.create({ data: { id: workspaceId, name: workspaceName, slug: `adm008-${suffix}`, createdById: adminId } });
      await tx.project.create({ data: { id: projectId, workspaceId, name: projectName, slug: `adm008-project-${suffix}`, membershipInheritanceMode: "workspaceInherited" } });
      await grantWorkspaceMembership(tx, { workspaceId, userId: adminId, role: "owner", actorId: adminId, reason: "ADM008 browser fixture backup owner" });
      await grantWorkspaceMembership(tx, { workspaceId, userId, role: "owner", actorId: adminId, reason: "ADM008 browser fixture subject owner" });
      await grantProjectMembership(tx, { projectId, workspaceId, userId, role: "viewer", actorId: adminId, reason: "ADM008 browser fixture direct viewer" });
    });

    await page.goto("/system/account-access");
    const card = page.locator("article").filter({ hasText: `@${username}` });
    await expect(card).toHaveCount(1);
    await expect(card.getByRole("button", { name: "查看有效访问矩阵", exact: true })).toBeVisible();

    const before = await page.evaluate(async (id) => {
      const response = await fetch(`/api/system/account-access/${id}?pageSize=20`, { cache: "no-store" });
      return { status: response.status, cacheControl: response.headers.get("cache-control"), body: await response.text() };
    }, userId);
    expect(before.status).toBe(200);
    expect(before.cacheControl).toContain("no-store");
    expect(before.body).toContain(projectName);
    expect(before.body).not.toContain("passwordHash");
    expect(before.body).not.toContain("tokenHash");
    expect(before.body).not.toContain("disabledReason");

    await card.getByRole("button", { name: "查看有效访问矩阵", exact: true }).click();
    const matrix = card.getByRole("region", { name: "有效访问矩阵", exact: true });
    await expect(matrix).toBeVisible();
    await expect(matrix.getByText("有效访问矩阵", { exact: true })).toBeVisible();
    await expect(matrix.getByText(projectName, { exact: true })).toBeVisible();
    await expect(matrix.getByText("Owner", { exact: true }).first()).toBeVisible();
    await expect(matrix.getByText("直接授权 + 工作区继承", { exact: true })).toBeVisible();
    await expect(matrix.getByText("只读审计视图", { exact: true })).toBeVisible();

    await card.locator("textarea").fill("ADM008 browser disable regression");
    await card.getByRole("button", { name: "停用账号", exact: true }).click();
    const preview = card.getByRole("region", { name: "账号状态变更预览", exact: true });
    await expect(preview).toBeVisible();
    await preview.getByLabel("输入用户名确认").fill(username);
    await preview.getByRole("button", { name: "确认停用", exact: true }).click();
    await expect(matrix).toHaveCount(0);

    const refreshedCard = page.locator("article").filter({ hasText: `@${username}` });
    await expect(refreshedCard.getByText("已停用", { exact: true })).toBeVisible();
    await refreshedCard.getByRole("button", { name: "查看有效访问矩阵", exact: true }).click();
    const disabledMatrix = refreshedCard.getByRole("region", { name: "有效访问矩阵", exact: true });
    await expect(disabledMatrix).toBeVisible();
    await expect(disabledMatrix.getByText("当前无效", { exact: true })).toBeVisible();
    await expect(disabledMatrix.getByText("无", { exact: true }).first()).toBeVisible();
  } finally {
    await page.request.post("/api/auth/logout", {
      headers: { origin: new URL(page.url()).origin },
    }).catch(() => undefined);
    await db.project.delete({ where: { id: projectId } }).catch(() => undefined);
    await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    // The mutation preview and account-access audit intentionally retain
    // append-only evidence that references this fixture user.  This runner
    // recreates and drops its disposable database around the complete suite.
    // AppSession rows are append-only by design.  Demote and rename the
    // temporary bootstrap account so the shared first-run smoke spec still
    // observes an uninitialized database without bypassing that invariant.
    await db.appUser.update({
      where: { id: adminId },
      data: { username: `adm008-cleanup-${suffix}`, role: "user" },
    }).catch(() => undefined);
    await db.$disconnect();
  }
});
