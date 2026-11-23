import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { signInR02Admin, signInR02PersonalUser, signOutR02User } from "./support/r02-admin-navigation";

test("notification polling updates the first page and preserves the history being read", async ({ page }) => {
  await signInR02Admin(page);
  const user = await seedBrowserPersonalUser(`notification-${randomUUID().slice(0, 8)}`, "BrowserNotification2026!");
  await signOutR02User(page);
  await signInR02PersonalUser(page, user);

  const rows = Array.from({ length: 21 }, (_, index) => ({
    id: randomUUID(), kind: "system", severity: "info", body: "", title: `通知 ${index + 1}`,
    createdAt: "2026-11-01T00:00:00Z", readAt: null, actionHref: null, actionState: "none", destination: null,
  }));
  let firstPageReads = 0;
  await page.route("**/api/notifications?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("limit") !== "20") return route.continue();
    const history = params.has("cursor");
    if (!history) firstPageReads++;
    const notifications = history ? rows.slice(20) : rows.slice(0, 20).map((row, index) =>
      index === 0 ? { ...row, title: `${params.get("filter")} · ${firstPageReads}` } : row);
    await route.fulfill({ json: { notifications, nextCursor: history ? null : "older", unreadCount: 0, pendingCount: 0 } });
  });
  await page.clock.install();
  await page.goto("/notifications");
  const articles = page.locator("article[id^=notification-]");
  await expect(articles).toHaveCount(20);
  const all = page.getByRole("navigation", { name: "活动筛选" }).getByRole("button", { name: "全部", exact: true });
  await all.click();
  await expect(articles).toHaveCount(20);
  await page.clock.fastForward(15_000);
  await expect(page.getByRole("heading", { name: "all · 2", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "加载更早记录" }).click();
  await expect(articles).toHaveCount(21);
  await page.clock.fastForward(30_000);
  await expect(page.getByRole("heading", { name: "通知 21", exact: true })).toBeVisible();
  expect(firstPageReads).toBe(2);
  await all.click();
  await expect(articles).toHaveCount(21);
  await page.getByRole("button", { name: "未读", exact: true }).click();
  await expect(page.getByRole("heading", { name: "unread · 3", exact: true })).toBeVisible();
  await page.clock.fastForward(15_000);
  await expect(page.getByRole("heading", { name: "unread · 4", exact: true })).toBeVisible();
});
