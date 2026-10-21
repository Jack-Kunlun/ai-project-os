import { expect, test } from "@playwright/test";
import { expectR02NoHorizontalOverflow } from "./support/r02-admin-navigation";

// Runs before the authenticated specs initialize their disposable database.
test("first-run setup supports Chinese light and English dark before an administrator exists", async ({ page }) => {
  const origin = new URL(test.info().project.use.baseURL!).origin;
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  for (const language of ["zh-CN", "en"] as const) {
    const theme = language === "en" ? "dark" : "light";
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.context().addCookies([
        { name: "aipos-language", value: language, url: origin },
        { name: "aipos-theme", value: theme, url: origin },
      ]);
      const response = await page.goto("/setup");
      expect(response?.status()).toBe(200);
      await expect(page).toHaveURL(`${origin}/setup`);
      await expect(page.locator("html")).toHaveAttribute("data-language", language);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByRole("heading", { name: language === "en" ? "Initialize AI Project OS" : "初始化 AI Project OS", exact: true })).toBeVisible();
      await expectR02NoHorizontalOverflow(page, `first-run ${language}/${theme}/${width}`);
      if (language === "en") expect(await page.locator("body").innerText()).not.toMatch(/\p{Script=Han}/u);
      await page.screenshot({ path: `test-results/first-run/${language}-${theme}-${width}.png`, fullPage: true });
    }
  }

  await page.getByLabel("Username", { exact: true }).fill("bootstrap_check");
  await page.getByLabel("Password", { exact: true }).fill("SetupCheck2026");
  await page.getByLabel("Enter your password again", { exact: true }).fill("Different2026");
  const create = page.getByRole("button", { name: "Create administrator and continue", exact: true });
  await create.click();
  await expect(page.locator("form").getByRole("alert")).toHaveText("The passwords do not match");
  await page.getByLabel("Enter your password again", { exact: true }).fill("SetupCheck2026");
  // Exercise the translated server-error path without creating an account.
  await page.route("**/api/setup", (route) => route.fulfill({ status: 503, json: { error: { message: "初始化失败" } } }));
  await create.click();
  await expect(page.locator("form").getByRole("alert")).toHaveText("Initialization failed");
  await expect(page.getByLabel("Username", { exact: true })).toHaveValue("bootstrap_check");
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("SetupCheck2026");
  await page.reload();
  await expect(page).toHaveURL(`${origin}/setup`);
  expect(pageErrors).toEqual([]);
});
