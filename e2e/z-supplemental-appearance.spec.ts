import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { englishUiMessages } from "../src/lib/ui-dictionary-source";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { expectR02NoAccessibilityViolations, expectR02NoHorizontalOverflow, r02ProjectRoutes, signInR02Admin, signInR02PersonalUser, signOutR02User } from "./support/r02-admin-navigation";

const appearances = [
  { language: "zh-CN", theme: "light" }, { language: "zh-CN", theme: "dark" },
  { language: "en", theme: "light" }, { language: "en", theme: "dark" },
] as const;
const publicRoutes = ["/login", "/register", "/recover", "/help", "/privacy", "/terms", "/contact"];
const primaryProjectSections = new Set(["", "/plan", "/materials", "/intelligence", "/automations", "/governance"]);

async function checkFields(page: Page) {
  const cramped = await page.locator("main input:not([type=hidden]):not([type=checkbox]):not([type=radio]), main textarea, main select").evaluateAll(elements => elements.filter(element => element.getClientRects().length > 0).map(element => {
    const style = getComputedStyle(element);
    // Compound controls own their border and padding on the surrounding shell.
    // An unbordered select inside that shell must not be treated as a second box.
    return { label: element.getAttribute("aria-label") ?? element.getAttribute("placeholder"), bordered: parseFloat(style.borderLeftWidth) > 0 || parseFloat(style.borderRightWidth) > 0, left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight) };
  }).filter(inset => inset.bordered && (inset.left < 12 || inset.right < 12)));
  expect(cramped, "form text must have at least12px of horizontal breathing room").toEqual([]);
}

async function checkEnglishProjectUi(page: Page) {
  // These isolated projects contain only English names and no source content.
  // Preserve user-owned workspace names in the shared shell when checking UI copy.
  const untranslated = await page.locator("main").evaluate(main => {
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    const found: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      const text = node.textContent?.trim() ?? "";
      if (!parent || !/\p{Script=Han}/u.test(text) || parent.closest("[data-user-shell-root], [hidden], [aria-hidden=true], script, style, code")) continue;
      if (parent.getClientRects().length && getComputedStyle(parent).visibility !== "hidden") found.push(text);
    }
    return [...new Set(found)];
  });
  expect(untranslated, "English UI copy in empty English project fixtures").toEqual([]);
}

for (const appearance of appearances) {
  test(`supplemental auth, public and project pages ${appearance.language}/${appearance.theme}`, async ({ page }) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    const findings: string[] = [];
    page.on("pageerror", error => errors.push(`${new URL(page.url()).pathname}: ${error.message}`));
    await signInR02Admin(page);
    await signOutR02User(page);
    await page.locator(".appearance-controls-trigger").click();
    const controls = page.locator(".appearance-controls-popover");
    await controls.getByRole("combobox").nth(0).selectOption(appearance.language);
    await expect(page.locator("html")).toHaveAttribute("lang", appearance.language);
    await expect(controls.getByRole("status")).toHaveCount(0);
    await controls.getByRole("combobox").nth(1).selectOption(appearance.theme);
    await page.keyboard.press("Escape");
    await mkdir("test-results/supplemental-appearance", { recursive: true });
    for (const path of publicRoutes) {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("lang", appearance.language);
      await expect(page.locator("html")).toHaveAttribute("data-theme", appearance.theme);
      await expect(page.locator("main h1").first()).toBeVisible();
      for (const width of [1680, 390]) {
        await page.setViewportSize({ width, height: 960 });
        await page.screenshot({ path: `test-results/supplemental-appearance/${appearance.language}-${appearance.theme}-${path.slice(1)}-${width}.png`, fullPage: true });
        try {
          await expectR02NoHorizontalOverflow(page, `${path} ${appearance.language}/${appearance.theme} ${width}`);
          await checkFields(page);
          if (appearance.language === "en") expect(await page.locator("main h1").first().innerText()).not.toMatch(/\p{Script=Han}/u);
          await expectR02NoAccessibilityViolations(page, `${path} ${appearance.language}/${appearance.theme} ${width}`);
        } catch (error) { findings.push(`${path} ${width}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }

    await page.setViewportSize({ width: 1680, height: 960 });
    const user = await seedBrowserPersonalUser(`supplemental-${randomUUID().slice(0, 8)}`, "Appearance2026Password!");
    // The sign-in helper uses Chinese labels; preserve the same theme while
    // selecting the expected language through the real control first.
    await page.goto("/login");
    if (appearance.language === "en") {
      await page.locator(".appearance-controls-trigger").click();
      await page.locator(".appearance-controls-popover").getByRole("combobox").nth(0).selectOption("zh-CN");
      await page.keyboard.press("Escape");
    }
    await signInR02PersonalUser(page, user);
    await page.locator(".appearance-controls-trigger").click();
    await page.locator(".appearance-controls-popover").getByRole("combobox").nth(0).selectOption(appearance.language);
    await expect(page.locator("html")).toHaveAttribute("lang", appearance.language);
    await expect(page.locator(".appearance-controls-popover").getByRole("status")).toHaveCount(0);
    await page.keyboard.press("Escape");
    const projectName = `Supplemental ${appearance.language} ${appearance.theme}`;
    const response = await page.request.post("/api/projects", { headers: { origin: new URL(page.url()).origin }, data: { name: projectName } });
    expect(response.status()).toBe(201);
    const project = (await response.json()).project as { id: string; name: string };
    const tr = (text: string) => appearance.language === "en" ? englishUiMessages[text] ?? text : text;
    const routes = r02ProjectRoutes(project.id, projectName).filter(route => !primaryProjectSections.has(route.path.slice(`/projects/${project.id}`.length)));
    routes.push({ path: `/projects/${project.id}/configuration`, heading: "项目配置", terminal: { kind: "heading", name: "项目配置" } });
    routes.push({ path: `/projects/${project.id}/members`, heading: "成员权限", terminal: { kind: "heading", name: "成员权限" } });
    for (const route of routes) {
      await page.goto(route.path);
      await expect(page.locator("main h1").first()).toBeVisible();
      const terminalKey = appearance.language === "en" && !englishUiMessages[route.terminal.name]
        ? Object.keys(englishUiMessages).find(key => key.startsWith(route.terminal.name)) ?? route.terminal.name
        : route.terminal.name;
      const terminal = route.terminal.kind === "heading" ? page.getByRole("heading", { name: tr(terminalKey), exact: true }).first() : page.getByText(tr(terminalKey), { exact: route.terminal.exact ?? true }).last();
      await expect(terminal, `${route.path} data ready`).toBeVisible({ timeout: 15_000 });
      for (const pending of route.pendingTexts ?? ["读取中…"]) {
        await expect(page.getByText(tr(pending), { exact: true }), `${route.path} completes ${pending}`).toHaveCount(0, { timeout: 15_000 });
      }
      await expect(page.locator("main .animate-pulse")).toHaveCount(0, { timeout: 15_000 });
      await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toHaveCount(0);
      for (const width of [1680, 390]) {
        await page.setViewportSize({ width, height: 960 });
        await page.screenshot({ path: `test-results/supplemental-appearance/${appearance.language}-${appearance.theme}-project-${route.path.split("/").at(-1)}-${width}.png`, fullPage: true });
        try {
          await expectR02NoHorizontalOverflow(page, `${route.path} ${appearance.language}/${appearance.theme} ${width}`);
          await checkFields(page);
          if (appearance.language === "en") expect(await page.locator("main h1").first().innerText()).not.toMatch(/\p{Script=Han}/u);
          await expectR02NoAccessibilityViolations(page, `${route.path} ${appearance.language}/${appearance.theme} ${width}`);
          if (appearance.language === "en") await checkEnglishProjectUi(page);
        } catch (error) { findings.push(`${route.path} ${width}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    expect(errors).toEqual([]);
    expect(findings, "all independent surfaces are checked before reporting their findings").toEqual([]);
  });
}
