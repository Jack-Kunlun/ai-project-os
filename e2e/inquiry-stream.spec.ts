import { writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { signInR02Admin, signOutR02User, signInR02PersonalUser, expectR02NoAccessibilityViolations, expectR02NoHorizontalOverflow } from "./support/r02-admin-navigation";

for (const [surface, reducedMotion] of [["page", false], ["floating", false], ["floating", true]] as const) {
  test(`Ask ${surface}${reducedMotion ? " reduced motion" : ""} renders real HTTP chunks early, respects reading position and clears incomplete output`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize(surface === "page" ? { width: 1440, height: 900 } : { width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
    await signInR02Admin(page);
    await signOutR02User(page);
    const user = await seedBrowserPersonalUser(`stream-${randomUUID().slice(0, 8)}`, "StreamBrowser2026Password!");
    await signInR02PersonalUser(page, user);
    const conversationId = randomUUID(), turnId = randomUUID();
    const model = { providerName: "Stream fixture", modelId: "isolated-stream-model", quotaMultiplierBps: 10_000, maxOutputTokens: 2048 };
    let response: ServerResponse | undefined;
    const server = createServer((request, reply) => {
      if (request.method === "OPTIONS") {
        reply.writeHead(204, { "access-control-allow-origin": new URL(page.url()).origin, "access-control-allow-credentials": "true", "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type,accept" });
        reply.end(); return;
      }
      response = reply;
      reply.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "access-control-allow-origin": new URL(page.url()).origin, "access-control-allow-credentials": "true" });
      reply.flushHeaders();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("STREAM_FIXTURE_PORT_MISSING");
    const activeResponse = () => { if (!response) throw new Error("STREAM_FIXTURE_NOT_CONNECTED"); return response; };
    const emit = (event: unknown) => activeResponse().write(`${JSON.stringify(event)}\n`);
    let conversation: unknown = null;
    try {
      await page.route("**/api/ask/sources*", route => route.fulfill({ json: { sources: [], model } }));
      await page.route("**/api/ask/conversations?*", route => route.fulfill({ json: { conversations: [], pagination: { page: 1, totalPages: 1, total: 0 } } }));
      await page.route(`**/api/ask/conversations/${conversationId}`, route => route.fulfill({ json: { conversation } }));
      await page.route("**/api/ask/turns", async route => {
        const body = route.request().postDataJSON();
        if (body.phase === "prepare") return route.fulfill({ json: { confirmation: {
          confirmationId: randomUUID(), conversationId, expiresAt: new Date(Date.now() + 60_000).toISOString(),
          ...model, billing: { mode: "platform", ...model, estimatedTokens: 100, estimatedRawTokens: 100, estimatedChargedTokens: 100 },
          contextTurnCount: 0, contextName: "全量可访问内容", sources: [], question: body.question, expectedLastTurnId: body.expectedLastTurnId,
        } } });
        expect(route.request().headers().accept).toContain("application/x-ndjson");
        return route.continue({ url: `http://127.0.0.1:${address.port}/reply` });
      });
      await page.goto(surface === "page" ? "/ask" : "/dashboard");
      if (surface === "floating") await page.locator(".inquiry-launcher").click();
      const view = surface === "page" ? page.locator("[data-ask-page]") : page.getByRole("dialog", { name: "智能问答悬浮窗", exact: true });
      await expect(view).toContainText("isolated-stream-model");
      await view.getByRole("textbox", { name: "输入问题", exact: true }).fill("请解释资料中的验收约定");
      await view.getByRole("button", { name: "发送", exact: true }).click();
      await expect.poll(() => Boolean(response)).toBe(true);
      const preview = view.locator("[data-inquiry-preview]");
      const answerText = preview.locator('[aria-live="off"]');
      await answerText.evaluate(element => {
        const samples: Array<{ text: string; time: number }> = [];
        Object.assign(window, { inquiryRevealSamples: samples });
        new MutationObserver(() => samples.push({ text: element.textContent || "", time: performance.now() }))
          .observe(element, { childList: true, characterData: true, subtree: true });
      });
      const firstText = "这是首先到达的文字，回答会随着生成逐字显示，阅读节奏自然连贯。";
      emit({ type: "delta", text: firstText });
      if (!reducedMotion) {
        await expect.poll(async () => (await answerText.textContent())?.length || 0, { intervals: [16] }).toBeGreaterThan(0);
        await page.screenshot({ path: testInfo.outputPath(`${surface}-revealing.png`), fullPage: true });
      }
      await expect(answerText).toHaveText(reducedMotion ? firstText : firstText.slice(0, -1));
      const samples = await page.evaluate(() => (window as typeof window & { inquiryRevealSamples: Array<{ text: string; time: number }> }).inquiryRevealSamples);
      const prefixes = samples.filter(sample => sample.text.length > 0 && sample.text.length < firstText.length);
      if (reducedMotion) expect(prefixes).toHaveLength(0);
      else {
        expect(prefixes.length).toBeGreaterThan(3);
        for (const sample of prefixes) expect(firstText.startsWith(sample.text)).toBe(true);
        expect(samples.at(-1)!.time - samples[0].time).toBeGreaterThan(100);
      }
      const samplesPath = testInfo.outputPath(`${surface}-reveal-samples.json`);
      await writeFile(samplesPath, JSON.stringify(samples, null, 2));
      await testInfo.attach("character-reveal-samples", { path: samplesPath, contentType: "application/json" });
      await expect(preview).toContainText("正在生成回答…");
      await expect(view.getByRole("button", { name: "正在处理…", exact: true })).toBeDisabled();
      expect(activeResponse().writableEnded).toBe(false);
      const longText = "\n已核对来源与验收条件，正在逐步输出。".repeat(45);
      if (surface === "floating") await view.getByRole("button", { name: "收起问答", exact: true }).click();
      emit({ type: "delta", text: longText });
      if (surface === "floating") {
        await expect(page.locator('#global-inquiry-panel [data-inquiry-preview] [aria-live="off"]')).toHaveText(reducedMotion ? firstText + longText : (firstText + longText).slice(0, -1));
        await page.locator(".inquiry-launcher").click();
        // Reopening uses the current shared cursor, with no replay from the start.
        expect(await answerText.textContent()).toBe(reducedMotion ? firstText + longText : (firstText + longText).slice(0, -1));
      }
      await expect(preview).toContainText(longText.trim().slice(0, -1));
      const rounds = view.locator('[aria-label="会话内容"]');
      await expect.poll(() => rounds.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(65);
      await rounds.focus();
      await expect(rounds).toBeFocused();
      await rounds.press("Home");
      await expect.poll(() => rounds.evaluate(element => element.scrollTop)).toBeLessThan(5);
      await expect(view.getByRole("button", { name: "查看最新回答", exact: false })).toBeVisible();
      if (surface === "floating") await view.getByRole("button", { name: "收起问答", exact: true }).click();
      emit({ type: "delta", text: "\n向上阅读时仍有新内容到达。" });
      if (surface === "floating") {
        await expect(page.locator('#global-inquiry-panel [data-inquiry-preview]')).toContainText("向上阅读时仍有新内容到达");
        await page.locator(".inquiry-launcher").click();
      }
      await expect(preview).toContainText("向上阅读时仍有新内容到达");
      expect(await rounds.evaluate(element => element.scrollTop)).toBeLessThan(5);
      await view.getByRole("button", { name: "查看最新回答", exact: false }).click();
      if (reducedMotion) {
        expect(await preview.locator('[aria-live="off"]').evaluate(element => getComputedStyle(element, "::after").animationName)).toBe("none");
      }
      await expectR02NoHorizontalOverflow(page, `Ask ${surface} streaming`);
      await expectR02NoAccessibilityViolations(page, `Ask ${surface} streaming`);
      const geometry = await preview.evaluate(element => {
        const answer = element.querySelector('[aria-live="off"]')!.getBoundingClientRect();
        const status = element.querySelector('[role="status"]')!.getBoundingClientRect();
        return { statusGap: status.top - answer.bottom, answerWidth: answer.width, viewport: innerWidth };
      });
      expect(geometry.statusGap).toBeGreaterThanOrEqual(9);
      expect(geometry.statusGap).toBeLessThanOrEqual(11);
      await testInfo.attach(`${surface}-stream-geometry`, { body: JSON.stringify(geometry), contentType: "application/json" });
      await page.screenshot({ path: testInfo.outputPath(`${surface}-streaming.png`), fullPage: true });
      const tail = "\n完成前的最后一段也会自然显示，不会突然整块跳出来。";
      const answer = `${firstText}${longText}\n向上阅读时仍有新内容到达。${tail}`;
      conversation = { id: conversationId, title: "流式验收", lastTurnId: turnId, turns: [{
        id: turnId, sequence: 1, scope: "all", contextName: "全量可访问内容", question: "请解释资料中的验收约定", answer,
        providerName: model.providerName, modelId: model.modelId, createdAt: new Date().toISOString(), citations: [],
      }] };
      const completionSampleStart = await page.evaluate(() => (window as typeof window & { inquiryRevealSamples: unknown[] }).inquiryRevealSamples.length);
      emit({ type: "delta", text: tail });
      emit({ type: "complete", conversation }); activeResponse().end();
      await expect(preview).toHaveCount(0);
      if (!reducedMotion) {
        const completing = await page.evaluate(start => (window as typeof window & { inquiryRevealSamples: Array<{ text: string; time: number }> }).inquiryRevealSamples.slice(start), completionSampleStart);
        expect(completing.filter(sample => sample.text.length > answer.length - tail.length && sample.text.length < answer.length).length).toBeGreaterThan(1);
      }
      await expect(view.getByRole("article", { name: "第 1 轮", exact: true })).toContainText(answer);
      await expect(view.getByRole("textbox", { name: "输入问题", exact: true })).toHaveValue("");
      // Failure has a real partial body but no terminal complete event.
      response = undefined;
      await view.getByRole("textbox", { name: "输入问题", exact: true }).fill("请继续核对异常场景");
      await view.getByRole("button", { name: "发送", exact: true }).click();
      await expect.poll(() => Boolean(response)).toBe(true);
      emit({ type: "delta", text: "这段未完成内容不能被保存为成功回答。" });
      await expect(preview).toContainText("这段未完成内容");
      activeResponse().end();
      await expect(preview).toHaveCount(0);
      await expect(view.getByRole("alert")).toContainText("连接中断");
      await expect(view.getByRole("textbox", { name: "输入问题", exact: true })).toHaveValue("请继续核对异常场景");
      await expect(view.getByRole("article")).toHaveCount(1);
    } finally {
      response?.end();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
