import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { getEntitlementDb } from "@/lib/db";
import { englishUiMessages } from "@/lib/ui-dictionary-source";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { expectR02NoHorizontalOverflow, signInR02Admin, signInR02PersonalUser, signOutR02User } from "./support/r02-admin-navigation";

async function fixture(page: Page) {
  await signInR02Admin(page);
  const suffix = randomUUID().slice(0, 8);
  const user = await seedBrowserPersonalUser(`feedback-layout-${suffix}`, "FeedbackLayout2026Password!");
  const workspaceName = `Feedback workspace with a complete readable name ${suffix}`;
  await getEntitlementDb().workspace.update({ where: { id: user.workspaceId }, data: { name: workspaceName } });
  await signOutR02User(page);
  await signInR02PersonalUser(page, user);
  const response = await page.request.post("/api/projects", {
    headers: { origin: new URL(page.url()).origin },
    data: { name: `Feedback layout ${suffix}`, workspaceId: user.workspaceId },
  });
  expect(response.status()).toBe(201);
  const { project } = await response.json() as { project: { id: string; name: string } };
  return { project, workspaceName };
}

for (const language of ["zh-CN", "en"] as const) {
  test(`approved overview rows and sticky sections remain usable in ${language}`, async ({ page }) => {
    test.setTimeout(120_000);
    const { project, workspaceName } = await fixture(page);
    const origin = new URL(page.url()).origin;
    await page.context().addCookies([
      { name: "aipos-language", value: language, url: origin },
      { name: "aipos-theme", value: language === "en" ? "dark" : "light", url: origin },
    ]);
    const t = (text: string) => language === "en" ? englishUiMessages[text] ?? text : text;

    await page.goto("/projects?create=1");
    const createDialog = page.getByRole("dialog", { name: t("新建项目"), exact: true });
    await expect(createDialog).toBeVisible();
    await expect(page).toHaveURL(/\/personal\/projects(?:\?create=1)?$/u);
    await createDialog.getByRole("button", { name: t("取消"), exact: true }).click();

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/projects/${project.id}`);
    await expect(page.locator('[data-overview-card="facts"]')).toBeVisible({ timeout: 15_000 });
    const cards = await page.locator("[data-overview-card]").evaluateAll(elements => Object.fromEntries(elements.map(element => {
      const rect = element.getBoundingClientRect();
      return [element.getAttribute("data-overview-card"), { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }];
    })));
    for (const [left, right] of [["objective", "activity"], ["next", "continue"]]) {
      expect(Math.abs(cards[left].top - cards[right].top)).toBeLessThanOrEqual(1);
      expect(Math.abs(cards[left].bottom - cards[right].bottom)).toBeLessThanOrEqual(1);
    }
    expect(Math.abs(cards.facts.left - cards.objective.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(cards.facts.right - cards.activity.right)).toBeLessThanOrEqual(1);

    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      for (const path of [`/projects/${project.id}/governance`, `/projects/${project.id}/materials`, `/projects/${project.id}/intelligence`, "/personal/knowledge"]) {
        await page.goto(path);
        const tabs = page.locator("[data-sticky-page-tabs]").first();
        await expect(tabs).toBeVisible();
        // Empty fixtures must not gain product filler just to test scrolling.
        await page.addStyleTag({ content: "[data-page-content] { min-height: 2000px !important; }" });
        await page.mouse.wheel(0, 1100);
        await expect.poll(() => tabs.evaluate(element => {
          const header = document.querySelector("[data-user-shell-root] > header");
          return header ? Math.abs(element.getBoundingClientRect().top - header.getBoundingClientRect().bottom) : 9999;
        }), { message: `${path} must stick below the fixed header at ${width}px` }).toBeLessThanOrEqual(1);
        await expectR02NoHorizontalOverflow(page, `${path} ${language} ${width}px`);
      }

      await page.goto("/dashboard");
      if (width === 390) await page.getByRole("button", { name: t("打开导航"), exact: true }).click();
      const picker = page.getByRole("combobox", { name: t("切换工作空间"), exact: true });
      await expect(picker).toContainText(workspaceName);
      await picker.click();
      await expect(page.getByRole("listbox")).toBeVisible();
      await picker.press("Escape");
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await expect(picker).toBeFocused();
      await expectR02NoHorizontalOverflow(page, `workspace picker ${language} ${width}px`);
    }
  });
}
