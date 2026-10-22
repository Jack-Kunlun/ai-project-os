import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { expectR02NoHorizontalOverflow, signInR02Admin, signInR02PersonalUser, signOutR02User } from "./support/r02-admin-navigation";

test("short reading pages avoid launcher-only scroll while narrow pages retain clearance", async ({ page }) => {
  test.setTimeout(180_000);
  await signInR02Admin(page);
  await signOutR02User(page);
  const user = await seedBrowserPersonalUser(`short-page-${randomUUID().slice(0, 8)}`, "ShortPage2026Password!");
  await signInR02PersonalUser(page, user);

  const response = await page.request.post("/api/projects", {
    headers: { origin: new URL(page.url()).origin },
    data: { name: "Short page scroll acceptance", workspaceId: user.workspaceId },
  });
  expect(response.status()).toBe(201);
  const { project } = await response.json() as { project: { id: string } };

  for (const mode of [
    { language: "zh-CN", theme: "light" },
    { language: "en", theme: "dark" },
  ]) {
    await page.context().addCookies([
      { name: "aipos-language", value: mode.language, url: new URL(page.url()).origin },
      { name: "aipos-theme", value: mode.theme, url: new URL(page.url()).origin },
    ]);
    await page.setViewportSize({ width: 1718, height: 914 });
    await page.goto("/dashboard");
    await expect(page.locator(`[data-page-content] a[href="/projects/${project.id}"]`)).toBeVisible();
    const content = page.locator("[data-page-content]");
    await expect(content).toHaveCount(1);
    await expect(content).not.toHaveAttribute("data-inquiry-scroll-clearance");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)).toBeLessThanOrEqual(1);
    await expectR02NoHorizontalOverflow(page, `${mode.language}/${mode.theme} desktop dashboard`);

    await page.setViewportSize({ width: 390, height: 600 });
    await expect(content).toHaveAttribute("data-inquiry-scroll-clearance", "");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)).toBeGreaterThan(0);
    await expectR02NoHorizontalOverflow(page, `${mode.language}/${mode.theme} narrow dashboard`);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(page.locator(".inquiry-launcher:visible").first()).toBeVisible();
    const overlaps = await page.evaluate(() => {
      const launcher = document.querySelector<HTMLElement>(".inquiry-launcher:not([hidden])")?.getBoundingClientRect();
      const root = document.querySelector<HTMLElement>("[data-page-content]");
      if (!launcher || !root) return ["missing launcher or reading content"];
      return [...root.querySelectorAll<HTMLElement>("a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)")]
        .filter(element => {
          const rect = element.getBoundingClientRect();
          return element.getClientRects().length > 0 && rect.bottom > 0 && rect.top < innerHeight
            && Math.min(rect.right, launcher.right) - Math.max(rect.left, launcher.left) > 1
            && Math.min(rect.bottom, launcher.bottom) - Math.max(rect.top, launcher.top) > 1;
        })
        .map(element => element.textContent?.trim() || element.tagName);
    });
    expect(overlaps, `${mode.language}/${mode.theme} dashboard controls must scroll clear of the launcher`).toEqual([]);

    await page.goto("/projects");
    await expect(page.getByRole("heading", { name: mode.language === "en" ? "My projects" : "我的项目", exact: true })).toBeVisible();
    await page.goto("/dashboard");
    await expect(page.locator(`[data-page-content] a[href="/projects/${project.id}"]`)).toBeVisible();
    await expect(page.locator("[data-page-content]")).toHaveAttribute("data-inquiry-scroll-clearance", "");

    await page.setViewportSize({ width: 1718, height: 1200 });
    await expect(content).not.toHaveAttribute("data-inquiry-scroll-clearance");
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)).toBeLessThanOrEqual(1);
  }
});
