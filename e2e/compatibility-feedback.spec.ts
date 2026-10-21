import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { expectR02NoHorizontalOverflow, signInR02Admin, signInR02PersonalUser, signOutR02User } from "./support/r02-admin-navigation";

test("credits and invitation compatibility screens localize failures without echoing API prose", async ({ page }) => {
  await signInR02Admin(page);
  const user = await seedBrowserPersonalUser(`feedback-${randomUUID().slice(0, 8)}`, "Feedback2026Password!");
  await signOutR02User(page);
  await signInR02PersonalUser(page, user);
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([
    { name: "aipos-language", value: "en", url: origin },
    { name: "aipos-theme", value: "dark", url: origin },
  ]);
  await page.route("**/api/credits?*", route => route.fulfill({ status: 403, json: { error: { code: "ACCESS_FORBIDDEN", message: "内部错误 secret=private-value" } } }));
  await page.route("**/api/workspace-invitations/accept", route => route.fulfill({ status: 400, json: { error: { code: "WORKSPACE_INVITATION_EXPIRED", message: "邀请已过期 secret=private-value" } } }));
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/credits");
    await expect(page.locator("main").getByRole("alert").first()).toContainText("ACCESS_FORBIDDEN");
    await expect.poll(() => page.locator("main").getByRole("alert").first().innerText()).not.toMatch(/\p{Script=Han}|private-value/u);
    await expectR02NoHorizontalOverflow(page, `credits error en-dark-${width}`);
    await page.goto(`/accept-invitation?token=${"a".repeat(40)}`);
    await page.getByRole("button", { name: "Accept invitation", exact: true }).click();
    await expect(page.locator("main").getByRole("alert")).toBeVisible();
    await expect.poll(() => page.locator("main").getByRole("alert").innerText()).not.toMatch(/\p{Script=Han}|private-value/u);
    await expectR02NoHorizontalOverflow(page, `invitation error en-dark-${width}`);
  }
  await page.unrouteAll({ behavior: "wait" });
});
