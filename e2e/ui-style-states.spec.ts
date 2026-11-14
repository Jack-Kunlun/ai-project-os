import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, test, type Locator, type Route } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import routeCatalog from "./support/prototype-route-catalog.json";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { seedUiConsistencyDetailFixtures } from "./support/ui-consistency-fixtures";
import { expectR02NoHorizontalOverflow, signInR02Admin, signInR02PersonalUser } from "./support/r02-admin-navigation";
import { expectDialogStyleContract, expectUiStyleContract } from "./support/ui-style-contract";
import { settleVisualState } from "./support/settle-visual-state";

const modes = [
  { id: "en-light-desktop", language: "en", theme: "light", width: 1440 },
  { id: "zh-dark-mobile", language: "zh-CN", theme: "dark", width: 390 },
] as const;
type Entry = { route: string; mode: string; state: string; requests?: string[]; text?: string; screenshot?: string };

test("all application pages retain the new style during loading, failed reads and operation dialogs", async ({ browser }, testInfo) => {
  test.setTimeout(720_000);
  const adminContext = await browser.newContext();
  const userContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const user = await userContext.newPage();
  const entries: Entry[] = [];
  const errors: string[] = [];
  try {
    await signInR02Admin(admin);
    const account = await seedBrowserPersonalUser(`ui-states-${randomUUID().slice(0, 12)}`, "UiStates2026Password!");
    await signInR02PersonalUser(user, account);
    const response = await user.request.post("/api/projects", {
      headers: { origin: new URL(user.url()).origin },
      data: { name: "UI acceptance long project name · 页面与异常状态统一检查", workspaceId: account.workspaceId },
    });
    expect(response.status()).toBe(201);
    const project = (await response.json()).project as { id: string };
    const details = await seedUiConsistencyDetailFixtures(project.id, account.id);
    const ids: Record<string, string> = { projectId: project.id, userId: account.id, workspaceId: account.workspaceId, ...details };
    const routes = Object.entries(routeCatalog).filter(([, config]) => !("kind" in config) && "group" in config && config.group !== "public");
    for (const mode of modes) {
      for (const page of [admin, user]) {
        await page.setViewportSize({ width: mode.width, height: 900 });
        await page.context().addCookies([
          { name: "aipos-language", value: mode.language, url: new URL(page.url()).origin },
          { name: "aipos-theme", value: mode.theme, url: new URL(page.url()).origin },
        ]);
      }
      for (const [pattern] of routes) {
        const page = pattern.startsWith("/admin") || pattern.startsWith("/system") ? admin : user;
        const path = pattern.replace(/\[([^\]]+)\]/gu, (_, key: string) => ids[key]);
        const key = `${mode.id}/${pattern.replaceAll(/[^a-zA-Z0-9_-]/gu, "_")}`;
        const save = async (state: string, surface?: Locator) => {
          await settleVisualState(page);
          await expectR02NoHorizontalOverflow(page, `${path} ${state} ${mode.id}`);
          await expectUiStyleContract(page, `${path} ${state} ${mode.id}`);
          if (pattern === '/ask' && state === 'failed-read') {
            const rail = page.getByRole('complementary', { name: /最近会话|Recent conversations/u });
            const alert = rail.getByRole('alert');
            await expect(alert).toBeVisible();
            const containment = await alert.evaluate(element => {
              const scroll = element.parentElement!;
              const rail = element.closest('aside')!;
              return { overflow: getComputedStyle(scroll).overflowY, inside: scroll.getBoundingClientRect().bottom <= rail.getBoundingClientRect().bottom + 1 };
            });
            expect(containment.overflow).toBe('auto');
            expect(containment.inside, 'history errors stay in the scrollable history region').toBe(true);
          }
          const screenshot = `states/${key}-${state}.png`;
          if (surface) await surface.screenshot({ path: testInfo.outputPath(screenshot), animations: "disabled" });
          else await page.screenshot({ path: testInfo.outputPath(screenshot), animations: "disabled" });
          entries.push({ route: pattern, mode: mode.id, state, screenshot });
        };
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const requests: string[] = [];
        const fault = async (route: Route) => {
          if (route.request().method() !== "GET") return route.fallback();
          requests.push(new URL(route.request().url()).pathname);
          await gate;
          await route.fulfill({ status: 503, json: { error: { code: "UI_ACCEPTANCE_UNAVAILABLE", message: "服务暂时不可用，请稍后重试。" } } }).catch(() => {});
        };
        try {
          await page.route("**/api/**", fault);
          const loaded = await page.goto(path, { waitUntil: "domcontentloaded" });
          expect(loaded?.status(), `${pattern}: feature-enabled route`).toBeLessThan(400);
          await page.waitForTimeout(350);
          if (requests.length) await save("loading");
          release();
          await page.waitForLoadState("networkidle");
          if (requests.length) {
            await save("failed-read");
            entries.push({ route: pattern, mode: mode.id, state: "fault-evidence", requests: [...new Set(requests)], text: (await page.locator("main").innerText()).slice(0, 14000) });
          } else {
            entries.push({ route: pattern, mode: mode.id, state: "no-client-read-on-entry" });
          }
        } catch (cause) {
          errors.push(`${pattern}@${mode.id}: ${String(cause)}`);
        } finally {
          release();
          await page.unroute("**/api/**", fault);
        }
        // Real page, real read fixtures. Only opening and cancelling operations;
        // no submit/test-provider/sync/grant actions or external calls are made.
        try {
          await page.goto(path, { waitUntil: "networkidle" });
          if (pattern === "/projects/[projectId]/tools") {
            const selector = `a[href="/projects/${project.id}/mcp-actions"]`;
            await expect(page.locator(selector), "enabled MCP actions entry must be visible").toBeVisible();
            const accessibility = await new AxeBuilder({ page }).include(selector).withRules(["color-contrast"]).analyze();
            expect(accessibility.violations, "MCP link must stay readable on the neutral header").toEqual([]);
            if (mode.theme === "light") {
              const link = page.locator(selector);
              const original = await link.getAttribute("style");
              try {
                await link.evaluate((element) => { element.style.color = "rgb(254, 243, 199)"; element.style.backgroundColor = "white"; });
                await settleVisualState(page);
                const legacy = await new AxeBuilder({ page }).include(selector).withRules(["color-contrast"]).analyze();
                expect(legacy.violations.some((violation) => violation.id === "color-contrast"), "negative control must catch pale legacy text on a white header").toBe(true);
              } finally {
                await link.evaluate((element, value) => value === null ? element.removeAttribute("style") : element.setAttribute("style", value), original);
              }
              entries.push({ route: pattern, mode: mode.id, state: "rejected-legacy-low-contrast" });
            }
            await save("enabled-mcp-entry");
          }
          const triggers = page.locator("[data-operation-trigger]:visible:not(:disabled)");
          const count = await triggers.count();
          for (let index = 0; index < count; index += 1) {
            const trigger = triggers.nth(index);
            const label = (await trigger.innerText()).trim();
            await trigger.click();
            const dialog = page.getByRole("dialog").last();
            await expect(dialog).toBeVisible();
            await settleVisualState(page);
            if (pattern === "/admin/account" || pattern === "/admin/operations/probes") {
              for (const action of await dialog.locator('[data-operation-footer] button[type="submit"]').all()) {
                await expect(action, `${pattern}: portaled submit needs explicit shared primary styling`).toHaveClass(/\bapp-button-primary\b/u);
              }
            }
            await expectDialogStyleContract(dialog, `${pattern}: ${label}`);
            if (pattern === '/profile' && index === 0) {
              for (const input of await dialog.locator('input').all()) {
                expect((await input.boundingBox())?.height, 'profile fields must not stretch with adjacent copy').toBeLessThanOrEqual(48);
              }
            }
            if (pattern === '/projects/[projectId]/actions' && index === 0) {
              const actions = dialog.locator('article button');
              await expect(actions).toHaveCount(3);
              await expect(dialog.locator('[data-operation-footer] button').filter({ hasText: /创建并|Create and/u })).toHaveCount(0);
            }
            if (pattern === "/admin/account" && index === 0 && mode.theme === "light") {
              const primary = dialog.locator('[data-operation-footer] button[type="submit"]').first();
              const original = await primary.getAttribute("style");
              try {
                await primary.evaluate((element) => { element.style.backgroundColor = "rgb(2, 6, 23)"; });
                await settleVisualState(page);
                await expect(expectUiStyleContract(page, "legacy admin footer negative control")).rejects.toThrow();
              } finally {
                await primary.evaluate((element, value) => value === null ? element.removeAttribute("style") : element.setAttribute("style", value), original);
              }
              entries.push({ route: pattern, mode: mode.id, state: "rejected-legacy-footer-color" });
            }
            await save(`dialog-${index}`, dialog);
            entries.push({ route: pattern, mode: mode.id, state: "dialog-label", text: label });
            await page.keyboard.press("Escape");
            await expect(dialog).toBeHidden();
          }
        } catch (cause) {
          errors.push(`${pattern}@${mode.id} operation: ${String(cause)}`);
          await page.keyboard.press("Escape");
        }
      }
    }
    expect(errors, "all applicable page and operation states must preserve geometry").toEqual([]);
  } finally {
    await writeFile(testInfo.outputPath("ui-style-states.json"), JSON.stringify({ modes, entries, errors }, null, 2));
    await adminContext.close();
    await userContext.close();
  }
});
