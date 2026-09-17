import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { getDb } from "@/lib/db";
import { grantProjectMembership, grantWorkspaceMembership } from "@/lib/membership-governance";
import { createPasswordRecord } from "@/lib/auth";
import { signInR02Admin } from "./support/r02-admin-navigation";

const ADMIN_PASSWORD = "BrowserGate2026Password!";

test("ADM-008 user operations stay within the safe admin boundary and preserve account lifecycle previews", async ({ page }) => {
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
  const workspaceSlug = `adm008-${suffix}`;
  const projectSlug = `adm008-project-${suffix}`;
  const ownerUsername = `adm008-owner-${suffix}`;
  let ownerId: string | null = null;
  try {
    await db.appUser.create({ data: { id: adminId, username: "browser_admin", role: "admin", ...(await createPasswordRecord(ADMIN_PASSWORD)) } });
    await signInR02Admin(page);
    const owner = await db.appUser.create({ data: { username: ownerUsername, role: "user", ...(await createPasswordRecord("ADM008Owner2026Password!")) }, select: { id: true } });
    ownerId = owner.id;
    await db.appUser.create({ data: { id: userId, username, role: "user", ...(await createPasswordRecord("ADM008User2026Password!")) } });
    await db.$transaction(async (tx) => {
      await tx.workspace.create({ data: { id: workspaceId, name: workspaceName, slug: workspaceSlug, createdById: ownerId! } });
      await tx.project.create({ data: { id: projectId, workspaceId, name: projectName, slug: projectSlug, membershipInheritanceMode: "workspaceInherited" } });
      await grantWorkspaceMembership(tx, { workspaceId, userId: ownerId!, role: "owner", actorId: adminId, reason: "ADM008 browser fixture business owner" });
      await grantWorkspaceMembership(tx, { workspaceId, userId, role: "viewer", actorId: adminId, reason: "ADM008 browser fixture subject viewer" });
      await grantProjectMembership(tx, { projectId, workspaceId, userId, role: "viewer", actorId: adminId, reason: "ADM008 browser fixture direct viewer" });
    });

    await page.goto(`/admin/users/${userId}`);
    await expect(page.getByRole("heading", { name: username, exact: true })).toBeVisible();

    const apiResponses = await page.evaluate(async (id) => {
      const [adminResponse, legacyResponse] = await Promise.all([
        fetch(`/api/admin/users/${id}`, { cache: "no-store" }),
        fetch(`/api/system/account-access/${id}?pageSize=20`, { cache: "no-store" }),
      ]);
      return {
        admin: { status: adminResponse.status, cacheControl: adminResponse.headers.get("cache-control"), body: await adminResponse.text() },
        legacy: { status: legacyResponse.status, cacheControl: legacyResponse.headers.get("cache-control"), body: await legacyResponse.text() },
      };
    }, userId);
    for (const response of [apiResponses.admin, apiResponses.legacy]) {
      expect(response.status).toBe(200);
      expect(response.cacheControl).toContain("no-store");
      for (const secret of [projectName, workspaceName, workspaceSlug, projectSlug, projectId, workspaceId, "有效访问矩阵"]) {
        expect(response.body).not.toContain(secret);
      }
      expect(response.body).not.toContain("passwordHash");
      expect(response.body).not.toContain("tokenHash");
      expect(response.body).not.toContain("disabledReason");
    }
    const pageText = await page.locator("body").innerText();
    for (const leakedValue of [projectName, workspaceName, workspaceSlug, projectSlug, projectId, workspaceId, "有效访问矩阵"]) {
      expect(pageText).not.toContain(leakedValue);
    }

    const accountReason = page.getByLabel("操作原因", { exact: true });
    await accountReason.fill("ADM008 browser disable regression");
    await page.getByRole("button", { name: "预览停用", exact: true }).click();
    const disablePreview = page.getByRole("region", { name: "账号状态变更预览", exact: true });
    await expect(disablePreview).toBeVisible();
    await disablePreview.getByLabel("输入用户名确认", { exact: true }).fill(username);
    await disablePreview.getByRole("button", { name: "确认并执行", exact: true }).click();
    await expect(page.getByText("账号已停用", { exact: true })).toBeVisible();

    await accountReason.fill("ADM008 browser restore regression");
    await page.getByRole("button", { name: "预览恢复", exact: true }).click();
    const restorePreview = page.getByRole("region", { name: "账号状态变更预览", exact: true });
    await expect(restorePreview).toBeVisible();
    await restorePreview.getByLabel("输入用户名确认", { exact: true }).fill(username);
    await restorePreview.getByRole("button", { name: "确认并执行", exact: true }).click();
    await expect(page.getByText("账号已启用", { exact: true })).toBeVisible();
  } finally {
    await page.request.post("/api/auth/logout", {
      headers: { origin: new URL(page.url()).origin },
    }).catch(() => undefined);
    await db.project.delete({ where: { id: projectId } }).catch(() => undefined);
    await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
    // Account and membership previews intentionally retain append-only audit
    // evidence. Temporary identities are demoted and renamed for the shared
    // browser fixture instead of deleting those references.
    await db.appUser.update({
      where: { id: adminId },
      data: { username: `adm008-cleanup-${suffix}`, role: "user" },
    }).catch(() => undefined);
    if (ownerId !== null) {
      await db.appUser.update({
        where: { id: ownerId },
        data: { username: `adm008-owner-cleanup-${suffix}`, role: "user" },
      }).catch(() => undefined);
    }
    await db.$disconnect();
  }
});
