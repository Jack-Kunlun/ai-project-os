import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("个人知识入口由服务端会话保护并接入全局导航", async () => {
  const [page, header] = await Promise.all([
    readFile("src/app/personal/knowledge/page.tsx", "utf8"),
    readFile("src/components/app-header.tsx", "utf8"),
  ]);

  assert.match(page, /requirePageSession\(\)/u);
  assert.match(page, /isSystemAdmin=\{user\.role === "admin"\}/u);
  assert.match(header, /key: "personalKnowledge"/u);
  assert.match(header, /label: "个人工作台"/u);
  assert.match(header, /href: "\/personal"/u);
  assert.match(header, /const isActive = item\.key === active/u);
  assert.match((await readFile("src/components/personal-workspace-nav.tsx", "utf8")), /知识库/u);
  assert.match((await readFile("src/components/personal-workspace-nav.tsx", "utf8")), /配置/u);
});

test("个人知识页面提供纯文本生命周期入口并保持请求无缓存", async () => {
  const source = await readFile("src/app/personal/knowledge/knowledge-client.tsx", "utf8");

  assert.match(source, /\/api\/personal\/knowledge/u);
  assert.match(source, /\/api\/personal\/knowledge\/\$\{encodeURIComponent\(documentId\)\}/u);
  assert.match(source, /\/revisions/u);
  assert.match(source, /\/export/u);
  assert.match(source, /method: isCreate \? "POST" : "PATCH"/u);
  assert.match(source, /method: "DELETE"/u);
  assert.match(source, /method: "POST"/u);
  assert.match(source, /expectedVersion: target!\.version/u);
  assert.match(source, /cache: "no-store"/u);
  assert.match(source, /AbortController/u);
  assert.match(source, /request\.controller\.signal/u);
  assert.match(source, /mutationTokenRef/u);
  assert.match(source, /selectedIdRef\.current/u);
  assert.match(source, /signal\.aborted/u);
  assert.match(source, /useAppConfirmDialog/u);
  assert.match(source, /版本历史/u);
  assert.match(source, /historyNextCursor/u);
  assert.match(source, /limit: String\(PAGE_SIZE\)/u);
  assert.match(source, /params\.set\("cursor", cursorValue\)/u);
  assert.match(source, /revisions\/\$\{revisionVersion\}/u);
  assert.match(source, /revisionContent\?\.documentId === document\.id/u);
  assert.match(source, /加载更多版本/u);
  assert.match(source, /导出 Markdown/u);
  assert.match(source, /无需创建项目/u);
  assert.match(source, /PersonalWorkspaceNav/u);
  assert.match(source, /active="knowledge"/u);
  assert.match(source, /useSearchParams/u);
  assert.match(source, /searchParams\.get\("document"\)/u);
  assert.match(source, /requestedDocumentId/u);
  assert.doesNotMatch(source, /console\.(log|debug|info|error)/u);
});

test("个人知识交互不会把正文写入日志或承诺尚未实现的项目智能能力", async () => {
  const source = await readFile("src/app/personal/knowledge/knowledge-client.tsx", "utf8");

  assert.doesNotMatch(source, /projectId|\/api\/projects/u);
  assert.doesNotMatch(source, /RAG|AI 自动/u);
  assert.match(source, /纯文本 \/ Markdown/u);
  assert.match(source, /保存后会保留版本历史/u);
});

test("个人总览使用真实知识图、容量和关联入口", async () => {
  const [overview, overviewRoute, relationsRoute, relationRoute] = await Promise.all([
    readFile("src/app/personal/personal-overview-client.tsx", "utf8"),
    readFile("src/app/api/personal/knowledge/overview/route.ts", "utf8"),
    readFile("src/app/api/personal/knowledge/relations/route.ts", "utf8"),
    readFile("src/app/api/personal/knowledge/relations/[relationId]/route.ts", "utf8"),
  ]);

  assert.match(overview, /\/api\/personal\/knowledge\/overview/u);
  assert.match(overview, /个人知识网状连接/u);
  assert.match(overview, /limitLabel/u);
  assert.match(overview, /index\.label/u);
  assert.match(overview, /stale/u);
  assert.match(overview, /建立关联/u);
  assert.match(overview, /解除/u);
  assert.match(overviewRoute, /getPersonalKnowledgeOverview/u);
  assert.match(relationsRoute, /createPersonalKnowledgeRelation/u);
  assert.match(relationRoute, /revokePersonalKnowledgeRelation/u);
});
