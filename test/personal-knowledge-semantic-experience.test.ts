import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("个人语义索引与搜索路由要求同源会话和受限 JSON body", async () => {
  const [indexRoute, searchRoute] = await Promise.all([
    readFile("src/app/api/personal/knowledge/semantic-index/route.ts", "utf8"),
    readFile("src/app/api/personal/knowledge/semantic-search/route.ts", "utf8"),
  ]);
  for (const route of [indexRoute, searchRoute]) {
    assert.match(route, /assertSameOrigin\(request\)/u);
    assert.match(route, /requireApiSession\(request\)/u);
    assert.match(route, /readJsonBody\(request\)/u);
    assert.match(route, /cache-control/u);
    assert.doesNotMatch(route, /projectId/u);
  }
});

test("语义搜索先选择平台或个人向量模型，再展示范围与计费确认摘要", async () => {
  const panel = await readFile("src/app/personal/knowledge/personal-semantic-search-panel.tsx", "utf8");
  const providers = await readFile("src/app/personal/knowledge/use-semantic-providers.ts", "utf8");
  assert.match(providers, /\/api\/personal\/knowledge\/semantic-providers/u);
  assert.match(providers, /status === "verified"/u);
  assert.match(providers, /controller\.abort\(\)/u);
  assert.doesNotMatch(providers, /let pending|const pending/u);
  assert.match(providers, /defaultEmbeddingModelId !== null/u);
  assert.match(panel, /useSemanticProviders/u);
  assert.match(panel, /estimatedCredits/u);
  assert.match(panel, /平台默认/u);
  assert.match(panel, /embeddingDimensions/u);
  assert.match(panel, /phase: "prepare"/u);
  assert.match(panel, /确认发送语义搜索请求/u);
  assert.match(panel, /documentId/u);
  assert.match(panel, /revisionId/u);
  assert.match(panel, /不扣平台额度/u);
  assert.match(panel, /cache: "no-store"/u);
  assert.doesNotMatch(panel, /PlatformTokenReservation/u);
});

test("个人语义索引面板提供建立与重建入口，并先展示完整范围确认", async () => {
  const panel = await readFile("src/app/personal/knowledge/personal-semantic-index-panel.tsx", "utf8");
  assert.match(panel, /\/api\/personal\/knowledge\/semantic-index/u);
  assert.match(panel, /建立语义索引/u);
  assert.match(panel, /重建语义索引/u);
  assert.match(panel, /phase: "prepare"/u);
  assert.match(panel, /phase: "execute"/u);
  assert.match(panel, /确认建立个人语义索引/u);
  assert.match(panel, /totalChunks/u);
  assert.match(panel, /revisionId/u);
  assert.match(panel, /不扣平台额度/u);
});
