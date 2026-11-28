import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { seedBrowserPersonalUser } from "./support/browser-fixtures";
import { signInR02Admin, signOutR02User, signInR02PersonalUser, expectR02NoAccessibilityViolations, expectR02NoHorizontalOverflow } from "./support/r02-admin-navigation";
import type { Conversation, InquiryRecovery } from "../src/lib/inquiry-session";

for (const surface of ["page", "floating"] as const) {
  test(`Ask ${surface} restores after reload, stops and explicitly continues; quota notification never blocks a new conversation`, async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize(surface === "page" ? { width: 1440, height: 900 } : { width: 390, height: 844 });
    await signInR02Admin(page); await signOutR02User(page);
    await signInR02PersonalUser(page, await seedBrowserPersonalUser(`recover-${randomUUID().slice(0, 8)}`, "RecoveryBrowser2026Password!"));
    // Exercise the real route guards before installing browser-only model fixtures.
    const origin = new URL(page.url()).origin, missingRequest = `${origin}/api/ask/requests/${randomUUID()}`;
    const missing = await page.request.get(missingRequest);
    expect(missing.status()).toBe(404); expect(missing.headers()["cache-control"]).toContain("no-store");
    expect((await page.request.post(missingRequest, { headers: { origin: "https://untrusted.invalid" }, data: { action: "stop" } })).status()).toBe(403);
    expect((await page.request.post(missingRequest, { headers: { origin }, data: { action: "resume" } })).status()).toBe(400);
    expect((await page.request.post(missingRequest, { headers: { origin }, data: { action: "stop" } })).status()).toBe(404);
    const anonymous = await page.context().browser()!.newContext();
    try { expect((await anonymous.request.get(missingRequest)).status()).toBe(401); }
    finally { await anonymous.close(); }
    const model = { providerName: "Recovery fixture", modelId: "isolated-recovery-model", quotaMultiplierBps: 10_000, maxOutputTokens: 2048 };
    const requests = new Map<string, InquiryRecovery>(), replies = new Map<string, ServerResponse>(), conversations = new Map<string, Conversation>();
    let currentId = "", executeCount = 0, stopCount = 0, quota = false, expectNewConversation = false;
    let statusGate: { id: string; wait: Promise<void> } | undefined, releaseStatus: (() => void) | undefined, statusReadStarted = false;
    const server = createServer((request, reply) => {
      const headers = { "access-control-allow-origin": new URL(page.url()).origin, "access-control-allow-credentials": "true" };
      if (request.method === "OPTIONS") { reply.writeHead(204, { ...headers, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type,accept" }); reply.end(); return; }
      reply.writeHead(200, { ...headers, "content-type": "application/x-ndjson", "cache-control": "no-store" }); reply.flushHeaders();
      replies.set(request.url!.slice(1), reply);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("FIXTURE_PORT_MISSING");
    const emit = (id: string, event: unknown) => replies.get(id)!.write(`${JSON.stringify(event)}\n`);
    const finish = (id: string, answer: string) => {
      const request = requests.get(id)!, conversation = conversations.get(request.conversationId)!;
      const turnId = randomUUID();
      conversation.turns.push({ id: turnId, sequence: conversation.turns.length + 1, scope: "all", contextName: request.contextName, question: request.question, answer, modelId: model.modelId, providerName: model.providerName, createdAt: new Date().toISOString(), citations: [] });
      conversation.lastTurnId = turnId; conversation.currentRequestId = null; request.status = "succeeded"; request.answer = answer;
      emit(id, { type: "complete", conversation }); replies.get(id)!.end();
    };
    try {
      await page.route("**/api/ask/sources*", route => route.fulfill({ json: { sources: [], model } }));
      await page.route("**/api/ask/conversations?*", route => route.fulfill({ json: { conversations: [...conversations.values()].map(item => ({ ...item, turnCount: item.turns.length })), pagination: { page: 1, totalPages: 1, total: conversations.size } } }));
      await page.route(/\/api\/ask\/conversations\/[^/?]+$/, route => route.fulfill({ json: { conversation: conversations.get(new URL(route.request().url()).pathname.split("/").at(-1)!) } }));
      await page.route("**/api/ask/requests/*", async route => {
        const id = new URL(route.request().url()).pathname.split("/").at(-1)!, request = requests.get(id)!;
        if (route.request().method() === "POST") { expect(route.request().postDataJSON()).toEqual({ action: "stop" }); stopCount++; request.status = "stopped"; request.canResume = true; request.errorCode = "UNIFIED_QUESTION_STOPPED"; replies.get(id)?.end(); }
        const snapshot = { request: structuredClone(request), conversation: structuredClone(conversations.get(request.conversationId)) };
        if (route.request().method() === "GET" && statusGate?.id === id) { statusReadStarted = true; await statusGate.wait; }
        return route.fulfill({ json: snapshot });
      });
      await page.route("**/api/ask/turns", route => {
        const body = route.request().postDataJSON();
        if (body.phase === "prepare") {
          if (expectNewConversation) { expect(body.conversationId).toBeUndefined(); expectNewConversation = false; }
          const previous = body.resumeFromConfirmationId ? requests.get(body.resumeFromConfirmationId)! : undefined;
          if (previous) { expect(previous.status).toBe("stopped"); expect(body.question).toBe(previous.question); }
          const id = randomUUID(), conversationId = body.conversationId ?? randomUUID(); currentId = id;
          if (!conversations.has(conversationId)) conversations.set(conversationId, { id: conversationId, title: body.question, turns: [], lastTurnId: null });
          const request: InquiryRecovery = { id, conversationId, status: "running", question: body.question, answer: previous?.answer ?? "", scope: "all", contextName: "全量可访问内容", errorCode: null, canResume: false };
          requests.set(id, request); conversations.get(conversationId)!.currentRequestId = id;
          return route.fulfill({ json: { confirmation: { confirmationId: id, conversationId, ...model, billing: { mode: "platform", ...model }, sources: [], contextName: request.contextName, expectedLastTurnId: body.expectedLastTurnId, resumeAnswer: previous?.answer } } });
        }
        executeCount++;
        if (quota) {
          Object.assign(requests.get(body.challengeId)!, { status: "failed", errorCode: "AI_PLATFORM_TOKEN_EXHAUSTED" });
          return route.fulfill({ status: 429, json: { error: { code: "AI_PLATFORM_TOKEN_EXHAUSTED", message: "untrusted upstream text" } } });
        }
        return route.continue({ url: `http://127.0.0.1:${address.port}/${body.challengeId}` });
      });
      await page.goto(surface === "page" ? "/ask" : "/dashboard");
      const open = async () => { if (surface === "floating") await page.locator(".inquiry-launcher").click(); };
      await open();
      const view = surface === "page" ? page.locator("[data-ask-page]") : page.getByRole("dialog", { name: "智能问答悬浮窗", exact: true });
      await expect(view).toContainText(model.modelId);
      const input = view.getByRole("textbox", { name: "输入问题", exact: true });
      await input.fill("需要可以恢复的回答"); await view.getByRole("button", { name: "发送", exact: true }).click();
      await expect.poll(() => replies.has(currentId)).toBe(true);
      const firstId = currentId, partial = "已经保存的部分回答。";
      await expect(view.getByRole("button", { name: "停止生成", exact: true })).toHaveCount(0);
      await expect(view.locator("[data-inquiry-preview]")).toContainText("正在准备资料…");
      emit(firstId, { type: "started" });
      await expect(view.getByRole("button", { name: "停止生成", exact: true })).toBeEnabled();
      requests.get(firstId)!.answer = partial; emit(firstId, { type: "delta", text: partial });
      await expect(view.locator("[data-inquiry-preview]")).toContainText("已经保存");
      await page.reload(); await open();
      await expect(view.locator("[data-inquiry-preview]")).toContainText(partial);
      expect(executeCount).toBe(1);
      await view.getByRole("button", { name: "停止生成", exact: true }).click();
      await expect(view.locator("[data-inquiry-recovery]")).toContainText(partial);
      await expect(view.getByRole("button", { name: "继续回答", exact: true })).toBeEnabled();
      expect(stopCount).toBe(1); expect(executeCount).toBe(1);
      await view.getByRole("button", { name: "关闭提示", exact: true }).click();
      await expectR02NoAccessibilityViolations(page, `${surface} stopped`);
      await view.getByRole("button", { name: "继续回答", exact: true }).click();
      await expect.poll(() => executeCount).toBe(2); await expect.poll(() => replies.has(currentId)).toBe(true);
      expect(currentId).not.toBe(firstId);
      emit(currentId, { type: "delta", text: "接着完成后续内容。" }); finish(currentId, `${partial}接着完成后续内容。`);
      await expect(view.locator("[data-inquiry-preview]")).toHaveCount(0);
      await expect(view.getByRole("article", { name: "第 1 轮", exact: true })).toContainText(`${partial}接着完成后续内容。`);
      const before = await view.locator('[aria-label="会话内容"]').boundingBox();
      quota = true; await input.fill("测试额度不足"); await view.getByRole("button", { name: "发送", exact: true }).click();
      await expect(view.getByRole("alert")).toContainText("平台额度不足");
      await expect(view.getByRole("link", { name: "查看额度与账单", exact: true })).toHaveAttribute("href", "/credits");
      await expect(input).toBeEnabled();
      const after = await view.locator('[aria-label="会话内容"]').boundingBox();
      expect(Math.abs(after!.height - before!.height)).toBeLessThan(3);
      await expectR02NoHorizontalOverflow(page, `${surface} quota notification`);
      await expectR02NoAccessibilityViolations(page, `${surface} quota notification`);
      await page.screenshot({ path: info.outputPath(`${surface}-quota-notification.png`), fullPage: true });
      await view.getByRole("button", { name: "关闭提示", exact: true }).click();
      statusGate = { id: currentId, wait: new Promise<void>(resolve => { releaseStatus = resolve; }) };
      await view.locator("[data-inquiry-recovery]").getByRole("button", { name: "核对生成状态", exact: true }).click();
      await expect.poll(() => statusReadStarted).toBe(true);
      await expect(view.getByRole("button", { name: "新建会话", exact: true })).toBeEnabled();
      await view.getByRole("button", { name: "新建会话", exact: true }).click();
      await expect(view.locator("[data-inquiry-recovery]")).toHaveCount(0);
      quota = false; expectNewConversation = true;
      if (surface === "page") await expect(page).toHaveURL(/\/ask$/u);
      await expect(view.getByRole("article", { name: "第 1 轮", exact: true })).toHaveCount(0);
      await input.fill("新会话仍可使用"); await view.getByRole("button", { name: "发送", exact: true }).click();
      await expect.poll(() => replies.has(currentId)).toBe(true); releaseStatus!(); statusGate = undefined;
      finish(currentId, "新会话正常完成。");
      await expect(view.getByRole("article", { name: "第 1 轮", exact: true })).toContainText("新会话正常完成。");
    } finally { releaseStatus?.(); for (const reply of replies.values()) reply.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}
