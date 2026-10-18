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

test("个人知识问答统一跳转到智能问答并保留 owner-scoped 后端保护", async () => {
  const panel = await readFile("src/app/personal/knowledge/personal-knowledge-qa-panel.tsx", "utf8");
  const providersRoute = await readFile("src/app/api/personal/knowledge/qa-providers/route.ts", "utf8");
  const service = await readFile("src/lib/personal-knowledge-qa-service.ts", "utf8");
  assert.match(panel, /scope: "personal"/u);
  assert.match(panel, /focusDocumentId: documentId/u);
  assert.match(panel, /return `\/ask\?\$\{query\.toString\(\)\}`/u);
  assert.match(panel, /return "\/ask\?history=1"/u);
  assert.match(panel, /href=\{buildPersonalKnowledgeAskHref\(documentId\)\}/u);
  assert.doesNotMatch(panel, /\/api\/personal\/knowledge\/qa-providers/u);
  assert.match(providersRoute, /requireApiSession/u);
  assert.match(providersRoute, /cache-control.*private, no-store/u);
  assert.match(service, /providerId: UUID_SCHEMA\.optional\(\)/u);
  assert.match(service, /readPersonalKnowledgeQaPlatformProvider/u);
  assert.match(service, /reservePlatformTokens/u);
  assert.match(service, /settlePlatformTokenReservation/u);
  assert.match(service, /holdPlatformTokenReservation/u);
  assert.match(service, /releasePlatformTokenReservation/u);
  assert.doesNotMatch(panel, /projectId|PlatformTokenReservation/u);
});
