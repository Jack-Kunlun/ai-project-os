import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { englishUiMessages } from "@/lib/ui-dictionary-source";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { expectR02NoHorizontalOverflow, signInR02Admin, signInR02PersonalUser, signOutR02User } from "./support/r02-admin-navigation";

test("personal knowledge index localizes its initial status and safe errors on English dark screens", async ({ page }) => {
  await signInR02Admin(page);
  const user = await seedBrowserPersonalUser(`knowledge-language-${randomUUID().slice(0, 8)}`, "Knowledge2026Password!");
  await signOutR02User(page);
  await signInR02PersonalUser(page, user);
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([
    { name: "aipos-language", value: "en", url: origin },
    { name: "aipos-theme", value: "dark", url: origin },
  ]);
  const tr = (key: string) => englishUiMessages[key] ?? key;
  let failOverview = false;
  await page.route("**/api/personal/knowledge/semantic-index", async (route) => {
    if (!failOverview) return route.continue();
    await route.fulfill({ status: 503, json: { error: { code: "UNKNOWN_INTERNAL_ERROR", message: "内部异常 secret=private-value" } } });
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    failOverview = false;
    await page.goto("/personal/knowledge");
    await page.getByRole("button", { name: tr("智能检索与索引"), exact: true }).click();
    await page.getByRole("button", { name: tr("索引管理"), exact: true }).click();
    const panel = page.locator('section[aria-labelledby="personal-semantic-index-title"]');
    await expect(panel.getByText("Not built / unavailable", { exact: true })).toBeVisible();
    await expect.poll(() => panel.innerText()).not.toMatch(/\p{Script=Han}/u);
    await expectR02NoHorizontalOverflow(page, `knowledge index en-dark-${width}`);
    failOverview = true;
    await page.getByRole("button", { name: tr("个人语义搜索"), exact: true }).click();
    await page.getByRole("button", { name: tr("索引管理"), exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText(/unavailable|needs attention/iu);
    await expect(panel).not.toContainText("private-value");
    await expect.poll(() => panel.innerText()).not.toMatch(/\p{Script=Han}/u);
    await expectR02NoHorizontalOverflow(page, `knowledge index failure en-dark-${width}`);
  }
  await page.unrouteAll({ behavior: "wait" });
});
