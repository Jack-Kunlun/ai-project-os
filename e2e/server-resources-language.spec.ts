import { expect, test } from "@playwright/test";
import { expectR02NoHorizontalOverflow, signInR02Admin } from "./support/r02-admin-navigation";

test("resource monitoring localizes safe failures in English dark mode without exposing server errors", async ({ page }) => {
  await signInR02Admin(page);
  const origin = new URL(page.url()).origin;
  await page.context().addCookies([
    { name: "aipos-language", value: "en", url: origin },
    { name: "aipos-theme", value: "dark", url: origin },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  let code = "AUTH_REQUIRED";
  await page.route("**/api/system/operations/resources", (route) => route.fulfill({
    status: code === "AUTH_REQUIRED" ? 401 : code === "ACCESS_FORBIDDEN" ? 403 : 500,
    json: { error: { code, message: "不应显示的内部服务器异常" } },
  }));
  await page.goto("/admin/operations/backups");
  const panel = page.locator('section[aria-labelledby="server-resources-title"]');
  const alert = panel.getByRole("alert");
  for (const errorCode of ["AUTH_REQUIRED", "ACCESS_FORBIDDEN", "UNRECOGNIZED_INTERNAL_ERROR"]) {
    if (errorCode !== code) {
      code = errorCode;
      await panel.getByRole("button", { name: "Refresh", exact: true }).click();
    }
    await expect(alert).toBeVisible();
    if (errorCode !== "UNRECOGNIZED_INTERNAL_ERROR") await expect(alert).toContainText(errorCode);
    else await expect(alert).toContainText("Failed to read server resources");
    await expect.poll(() => panel.innerText()).not.toMatch(/\p{Script=Han}/u);
    await expect(alert).not.toContainText("不应显示的内部服务器异常");
    await expectR02NoHorizontalOverflow(page, `resources safe failure ${errorCode}`);
  }
});
