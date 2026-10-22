import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { getDb } from "@/lib/db";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { signInR02PersonalUser } from "./support/r02-admin-navigation";

test("one-click read-all persists for every notification page", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const user = await seedBrowserPersonalUser(`browser-read-all-${suffix}`, "BrowserReadAll2026Password!");
  const db = getDb();
  const notificationCount = 25;
  await db.notification.createMany({
    data: Array.from({ length: notificationCount }, (_, index) => ({
      userId: user.id,
      subjectKind: "legacy" as const,
      attentionIntent: "informational" as const,
      kind: "system" as const,
      severity: "info" as const,
      title: `批量已读验收 ${suffix} ${String(index + 1).padStart(2, "0")}`,
      body: `隔离浏览器验收通知 ${index + 1}`,
      actionHref: null,
      dedupeKey: createHash("sha256").update(`prototype-read-all:${user.id}:${index}`).digest("hex"),
      createdAt: new Date(Date.now() - index * 1_000),
      readAt: null,
    })),
  });

  await signInR02PersonalUser(page, user);
  await page.goto("/notifications");
  await expect(page.getByRole("heading", { name: "通知中心", exact: true })).toBeVisible();
  await expect(page.locator("article")).toHaveCount(20);
  await expect(page.getByRole("button", { name: "加载更早记录", exact: true })).toBeVisible();

  const readAllResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/notifications/read-all" && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "全部标记为已读", exact: true }).click();
  expect((await readAllResponse).status()).toBe(200);
  await expect(page.getByText("0 条未读", { exact: true })).toBeVisible();
  await expect(page.locator("article")).toHaveCount(20);
  const unreadAfterBulkAction = await db.notification.count({ where: { userId: user.id, readAt: null } });
  expect(unreadAfterBulkAction).toBe(0);

  await page.getByRole("button", { name: "加载更早记录", exact: true }).click();
  await expect(page.locator("article")).toHaveCount(notificationCount);
  await expect(page.getByText("0 条未读", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("0 条未读", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "未读", exact: true }).click();
  await expect(page.getByText("当前没有未读通知。", { exact: false })).toBeVisible();

  const dimensions = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
});
