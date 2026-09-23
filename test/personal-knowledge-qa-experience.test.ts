import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("个人页面问答路由要求同源会话并分离准备与执行阶段", async () => {
  const route = await readFile("src/app/api/personal/knowledge/[documentId]/qa/route.ts", "utf8");
  assert.match(route, /assertSameOrigin\(request\)/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /preparePersonalKnowledgeQa/u);
  assert.match(route, /executePersonalKnowledgeQa/u);
  assert.match(route, /cache-control/u);
  assert.doesNotMatch(route, /projectId/u);
});

test("问答面板先选择已验证个人生成模型，再展示 BYOK 发送确认摘要", async () => {
  const panel = await readFile("src/app/personal/knowledge/personal-knowledge-qa-panel.tsx", "utf8");
  assert.match(panel, /\/api\/me\/ai-providers/u);
  assert.match(panel, /status === "verified"/u);
  assert.match(panel, /defaultGenerationModelId !== null/u);
  assert.match(panel, /id="personal-qa-provider"/u);
  assert.match(panel, /providerId/u);
  assert.match(panel, /confirmation\.providerId !== providerId/u);
  assert.match(panel, /invalidateConfirmation/u);
  assert.match(panel, /providerId: confirmation\.providerId/u);
  assert.match(panel, /phase: "prepare"/u);
  assert.match(panel, /确认发送当前页面/u);
  assert.match(panel, /不扣平台额度/u);
  assert.match(panel, /cache: "no-store"/u);
  assert.doesNotMatch(panel, /projectId|PlatformTokenReservation/u);
});
