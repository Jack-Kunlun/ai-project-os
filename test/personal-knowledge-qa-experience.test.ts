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

test("问答面板默认平台模型，个人模型仅作为可选项并在外发前确认", async () => {
  const panel = await readFile("src/app/personal/knowledge/personal-knowledge-qa-panel.tsx", "utf8");
  const providersRoute = await readFile("src/app/api/personal/knowledge/qa-providers/route.ts", "utf8");
  const service = await readFile("src/lib/personal-knowledge-qa-service.ts", "utf8");
  assert.match(panel, /\/api\/personal\/knowledge\/qa-providers/u);
  assert.match(panel, /provider\.isDefault\)\?\.id \?\? null/u);
  assert.match(panel, /高级选项：改用个人模型（可选）/u);
  assert.match(panel, /默认平台模型无需单独配置/u);
  assert.match(panel, /id="personal-qa-provider"/u);
  assert.match(panel, /providerId/u);
  assert.match(panel, /selectedProvider\?\.billingMode === "byok" \? \{ providerId: selectedProvider\.id \} : \{\}/u);
  assert.match(panel, /confirmation\.providerId !== providerId/u);
  assert.match(panel, /invalidateConfirmation/u);
  assert.match(panel, /providerId: confirmation\.providerId/u);
  assert.match(panel, /phase: "prepare"/u);
  assert.match(panel, /确认发送当前页面/u);
  assert.match(panel, /按实际用量扣除平台额度/u);
  assert.match(panel, /调用结果不明时会暂留额度核对/u);
  assert.match(panel, /cache: "no-store"/u);
  assert.match(providersRoute, /requireApiSession/u);
  assert.match(providersRoute, /cache-control.*private, no-store/u);
  assert.match(service, /providerId: UUID_SCHEMA\.optional\(\)/u);
  assert.match(service, /readPersonalKnowledgeQaPlatformProvider/u);
  assert.match(service, /reservePlatformTokens/u);
  assert.match(service, /settlePlatformTokenReservation/u);
  assert.match(service, /holdPlatformTokenReservation/u);
  assert.match(service, /releasePlatformTokenReservation/u);
  assert.doesNotMatch(panel, /projectId|PlatformTokenReservation/u);
  assert.doesNotMatch(panel, /\/api\/me\/ai-providers/u);
});
