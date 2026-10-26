import { randomUUID } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
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
  return { project, workspaceName, workspaceId: user.workspaceId };
}

async function expectBottomInset(panel: Locator, lastContent: Locator, label: string) {
  await expect(lastContent).toBeVisible();
  const [outer, inner] = await Promise.all([
    panel.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { bottom: rect.bottom, border: Number.parseFloat(getComputedStyle(element).borderBottomWidth) };
    }),
    lastContent.evaluate(element => element.getBoundingClientRect().bottom),
  ]);
  const gap = outer.bottom - outer.border - inner;
  expect(gap, `${label} must retain its bottom inset`).toBeGreaterThanOrEqual(12);
  expect(gap, `${label} must not duplicate the list's bottom spacing`).toBeLessThanOrEqual(22);
}

test("expanded project detail panels retain bottom insets for empty and populated content", async ({ page }) => {
  test.setTimeout(180_000);
  const { project, workspaceId } = await fixture(page);
  const origin = new URL(page.url()).origin;
  const second = await page.request.post("/api/projects", {
    headers: { origin }, data: { name: "Narrow panel spacing", workspaceId },
  });
  expect(second.status()).toBe(201);
  const narrow = await second.json() as { project: { id: string } };

  for (const mode of [
    { projectId: project.id, width: 1440, language: "zh-CN", theme: "light" },
    { projectId: narrow.project.id, width: 390, language: "en", theme: "dark" },
  ]) {
    await page.context().addCookies([
      { name: "aipos-language", value: mode.language, url: origin },
      { name: "aipos-theme", value: mode.theme, url: origin },
    ]);
    await page.setViewportSize({ width: mode.width, height: 900 });
    const t = (text: string) => mode.language === "en" ? englishUiMessages[text] ?? text : text;

    for (const populated of [false, true]) {
      if (populated) {
        const created = await page.request.post(`/api/projects/${mode.projectId}/plan`, {
          headers: { origin }, data: { operation: "createObjective", title: "Panel spacing objective" },
        });
        expect(created.status()).toBe(201);
      }
      await page.goto(`/projects/${mode.projectId}/plan`);
      const panels = page.locator('details[class*="collapsibleSection"]');
      await expect(panels).toHaveCount(4);
      for (let index = 0; index < 4; index += 1) {
        const panel = panels.nth(index);
        const summary = panel.locator(":scope > summary");
        const closedHeight = await panel.evaluate(element => element.getBoundingClientRect().height);
        await summary.click();
        await expect(panel).toHaveAttribute("open", "");
        const lastContent = index === 2 ? panel.locator("#impact-signals")
          : index === 1 ? panel.locator(":scope > a")
            : panel.locator(":scope > div > :last-child");
        await expectBottomInset(panel, lastContent, `plan panel ${index}, ${mode.width}px, populated=${populated}`);
        await expectR02NoHorizontalOverflow(page, `expanded plan panel ${index} ${mode.width}px`);
        if (index === 2 && populated) {
          const screenshot = await panel.screenshot({ path: `evidence/panel-bottom-20261026/plan-${mode.width}.png` });
          await test.info().attach(`plan-bottom-${mode.width}`, { body: screenshot, contentType: "image/png" });
        }
        await summary.click();
        await expect(panel).not.toHaveAttribute("open");
        expect(await panel.evaluate(element => element.getBoundingClientRect().height)).toBeCloseTo(closedHeight, 0);
      }
    }

    await page.goto(`/projects/${mode.projectId}`);
    const governance = page.locator("#attention-details");
    await expect(governance).toBeVisible();
    const summary = governance.locator(":scope > summary");
    const closedHeight = await governance.evaluate(element => element.getBoundingClientRect().height);
    await summary.click();
    await expect(governance.getByText(t("当前筛选条件下没有项目任务。"), { exact: true })).toBeVisible();
    await expectBottomInset(governance, governance.locator("#task-runs"), `overview governance ${mode.width}px`);
    await expectR02NoHorizontalOverflow(page, `expanded overview governance ${mode.width}px`);
    const screenshot = await governance.screenshot({ path: `evidence/panel-bottom-20261026/overview-${mode.width}.png` });
    await test.info().attach(`overview-bottom-${mode.width}`, { body: screenshot, contentType: "image/png" });
    await summary.click();
    expect(await governance.evaluate(element => element.getBoundingClientRect().height)).toBeCloseTo(closedHeight, 0);
    await expectR02NoHorizontalOverflow(page, `project detail panels ${mode.width}px`);
  }
});

for (const language of ["zh-CN", "en"] as const) {
  test(`approved overview rows and sticky sections remain usable in ${language}`, async ({ page }) => {
    test.setTimeout(120_000);
    const { project, workspaceName, workspaceId } = await fixture(page);
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
      await expect.poll(() => page.locator("#user-shell-navigation").evaluate(element => Math.round(element.getBoundingClientRect().x))).toBe(0);
      const picker = page.getByRole("combobox", { name: t("切换工作空间"), exact: true });
      const projectPicker = page.getByRole("combobox", { name: t("切换当前项目"), exact: true });
      await expect(picker).toHaveValue(workspaceId, { timeout: 15_000 });
      await expect(picker.locator("option:checked")).toHaveText(workspaceName);
      await expect(picker).toHaveAttribute("title", workspaceName);
      await expect(projectPicker).toHaveValue(project.id, { timeout: 15_000 });
      const navigation = page.getByRole("navigation", { name: t("全局入口"), exact: true });
      for (const control of [picker, projectPicker]) {
        await control.scrollIntoViewIfNeeded();
        const before = await navigation.boundingBox();
        expect(before).not.toBeNull();
        await control.click();
        const expanded = await navigation.boundingBox();
        expect(expanded).toEqual(before);
        await page.keyboard.press("Escape");
        await expect(control).toBeFocused();
        expect(await navigation.boundingBox()).toEqual(before);
      }
      const shapes = await Promise.all([picker, projectPicker].map(control => control.evaluate(element => {
        const parent = element.parentElement!;
        const style = getComputedStyle(parent);
        return { height: parent.getBoundingClientRect().height, border: style.border, radius: style.borderRadius, fontSize: getComputedStyle(element).fontSize };
      })));
      expect(shapes[0]).toEqual(shapes[1]);
      const accessibility = await new AxeBuilder({ page }).include("#user-shell-navigation").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(accessibility.violations).toEqual([]);
      await expectR02NoHorizontalOverflow(page, `workspace picker ${language} ${width}px`);
      await page.screenshot({ path: `evidence/sidebar-select-20261026/sidebar-${language}-${width}.png` });
    }
  });
}
