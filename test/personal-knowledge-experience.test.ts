import {createElement} from "react";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "./render-with-appearance";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PersonalKnowledgeEditor, validateKnowledgeDraft } from "../src/app/personal/knowledge/personal-knowledge-editor";

test("个人知识入口保留服务端会话保护并使用全局用户壳", async () => {
  const [page, header, personalNav] = await Promise.all([
    readFile("src/app/personal/knowledge/page.tsx", "utf8"),
    readFile("src/components/app-header.tsx", "utf8"),
    readFile("src/components/personal-workspace-nav.tsx", "utf8"),
  ]);

  assert.match(page, /requirePageSession\(\)/u);
  assert.match(page, /isSystemAdmin=\{user\.role === "admin"\}/u);
  assert.match(header, /<UserShell username=\{username\} isSystemAdmin=\{isSystemAdmin\}\/>/u);
  assert.match(personalNav, /export function PersonalWorkspaceNav/u);
  assert.match(personalNav, /return null/u);
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
  assert.match(source, /<h1><UiText text="我的知识" \/><\/h1>/u);
  assert.match(source, /PersonalWorkspaceNav/u);
  assert.match(source, /active="knowledge"/u);
  assert.match(source, /useSearchParams/u);
  assert.match(source, /searchParams\.get\("document"\)/u);
  assert.match(source, /requestedDocumentId/u);
  assert.doesNotMatch(source, /console\.(log|debug|info|error)/u);
  const saveDraft = source.slice(source.indexOf("async function saveDraft"), source.indexOf("async function deleteDocument"));
  assert.ok(saveDraft.indexOf("validateKnowledgeDraft(draft)") < saveDraft.indexOf("fetch(endpoint"));
});

test("通用记忆列表筛选使用严格布尔参数并沿用 owner-scoped GET", async () => {
  const [client, route] = await Promise.all([
    readFile("src/app/personal/knowledge/knowledge-client.tsx", "utf8"),
    readFile("src/app/api/personal/knowledge/route.ts", "utf8"),
  ]);

  assert.match(client, /knowledgeFilter === "memory"\) params\.set\("isDefaultMemory", "true"\)/u);
  assert.match(client, /setKnowledgeFilter\(nextFilter\);[\s\S]*setCursor\(null\);[\s\S]*setCursorStack\(\[\]\)/u);
  assert.match(route, /isDefaultMemory: z\.enum\(\["true", "false"\]\)\.transform\(\(value\) => value === "true"\)\.optional\(\)/u);
  assert.match(route, /\.strict\(\)/u);
  assert.match(route, /listPersonalKnowledgeDocuments\(actor,[\s\S]*isDefaultMemory: query\.isDefaultMemory/u);
  assert.match(route, /searchPersonalKnowledgeDocuments\(actor,[\s\S]*isDefaultMemory: query\.isDefaultMemory/u);
});

test("URL 指定内容的导航先确认草稿，取消时恢复已确认的 URL", async () => {
  const source = await readFile("src/app/personal/knowledge/knowledge-client.tsx", "utf8");
  const transitionStart = source.indexOf("reconcileDocumentQueryRef.current = async");
  const transitionEnd = source.indexOf("const loadDocuments = useCallback", transitionStart);
  const transition = source.slice(transitionStart, transitionEnd);
  const confirmationIndex = transition.indexOf("if (saving || importing || !await confirmDiscardDraft())");
  const cancelReturnIndex = transition.indexOf("return false", confirmationIndex);
  const invalidationIndex = transition.indexOf("invalidateListRequest()");
  const selectionChangeIndex = transition.indexOf("setAcceptedDocumentId(nextDocumentId)");
  const loaderStart = source.indexOf("const loadDocuments = useCallback");
  const loaderEnd = source.indexOf("const loadDocument = useCallback", loaderStart);
  const loader = source.slice(loaderStart, loaderEnd);

  assert.ok(transitionStart >= 0);
  assert.ok(confirmationIndex >= 0 && confirmationIndex < selectionChangeIndex);
  assert.ok(cancelReturnIndex > confirmationIndex && cancelReturnIndex < invalidationIndex);
  assert.match(transition.slice(confirmationIndex), /restoreAcceptedDocumentQuery\(\)/u);
  assert.match(transition, /router\.replace\(/u);
  assert.match(transition, /requestedDocumentIdRef\.current/u);
  assert.match(transition, /detailHistoryEntryRef\.current = false/u);
  assert.match(source, /detailHistoryEntryRef\.current = true;[\s\S]*router\.push\(/u);
  assert.match(source, /requestedDocumentId === acceptedDocumentIdRef\.current \|\| queryNavigationPendingRef\.current/u);
  assert.match(loader, /const nextSelectedId = preferredDocumentId/u);
  assert.doesNotMatch(loader, /requestedDocumentId(?!Ref)/u);
});

test("新建与编辑使用抽屉且不让旧列表响应覆盖草稿", async () => {
  const source = await readFile("src/app/personal/knowledge/knowledge-client.tsx", "utf8");
  const modalStart = source.indexOf("function openKnowledgeModal");
  const modalEnd = source.indexOf("async function requestCloseKnowledgeModal", modalStart);
  const openModal = source.slice(modalStart, modalEnd);
  const createStart = source.indexOf("function startCreate");
  const createEnd = source.indexOf("function startEdit", createStart);
  const create = source.slice(createStart, createEnd);
  const editStart = source.indexOf("function startEdit");
  const editEnd = source.indexOf("async function importFile", editStart);
  const edit = source.slice(editStart, editEnd);

  assert.match(openModal, /invalidateListRequest\(\);\s*setListLoading\(false\);\s*setKnowledgeModal\(next\);/u);
  assert.ok(create.indexOf('openKnowledgeModal("editor")') < create.indexOf("setDraft(emptyDraft)"));
  assert.ok(edit.indexOf('openKnowledgeModal("editor")') < edit.indexOf("setDraft({ title: documentToEdit.title"));
  assert.match(source, /data-variant=\{knowledgeModal === "editor" \? mode : knowledgeModal \?\? undefined\}/u);
  assert.match(source, /if \(knowledgeModalRef\.current !== null\) return;/u);
  assert.match(source, /onEdit=\{\(\) => startEdit\(document\)\}/u);
});

test("知识列表保留两个栏目并独立导航图谱，新增用弹窗，编辑和导入用抽屉", async () => {
  const source = await readFile("src/app/personal/knowledge/knowledge-client.tsx", "utf8");

  assert.match(source, /<UiText text="全部知识" \/>/u);
  assert.match(source, /<UiText text="通用记忆" \/>/u);
  assert.doesNotMatch(source, /href="\/personal\/knowledge\/graph"/u);
  assert.match(source, /aria-label=\{t\(knowledgeFilter === "memory" \? "通用记忆列表" : "全部知识列表"\)\}/u);
  assert.match(source, /params\.set\("isDefaultMemory", "true"\)/u);
  assert.match(source, /openSearchTool\("semantic"\)/u);
  const graph = await readFile("src/app/personal/knowledge/graph/personal-knowledge-graph-client.tsx", "utf8");
  assert.doesNotMatch(graph, /aria-label=\{t\("我的知识栏目"\)\}/u);
  assert.match(source, /<dialog[\s\S]*?aria-labelledby="knowledge-modal-title"/u);
  assert.match(source, /dialogElement\.showModal\(\)/u);
  assert.match(source, /onCancel=\{\(event\) => \{ event\.preventDefault\(\); void requestCloseKnowledgeModal\(\); \}\}/u);
  assert.match(source, /function confirmWithKnowledgeModal/u);
  assert.match(source, /confirmWithKnowledgeModal\(\{[\s\S]*确认发送/u);
  assert.match(source, /onKeyDown=\{\(event: KeyboardEvent<HTMLDialogElement>\)/u);
  assert.match(source, /event\.shiftKey && \(outsideDialog \|\| active === event\.currentTarget \|\| active === first\)[\s\S]*last\.focus\(\)/u);
  assert.match(source, /!event\.shiftKey && \(outsideDialog \|\| active === event\.currentTarget \|\| active === last\)[\s\S]*first\.focus\(\)/u);
  assert.match(source, /onClick=\{\(event: MouseEvent<HTMLDialogElement>\)/u);
});

test("2000 字个人通用记忆限制在小屏表单中可见且阻止超限保存", () => {
  const overLimitDraft = { title: "测试", content: "甲".repeat(2_001), isDefaultMemory: true };
  const unmarkedDraft = { ...overLimitDraft, isDefaultMemory: false };
  const shortenedDraft = { ...overLimitDraft, content: "甲".repeat(2_000) };
  const render = (draft: typeof overLimitDraft, error: string | null = null) => renderToStaticMarkup(createElement(PersonalKnowledgeEditor,{
    mode: "create",
    draft,
    saving: false,
    error,
    onDraftChange: () => undefined,
    onCancel: () => undefined,
    onSubmit: () => undefined,
  }));

  assert.equal(validateKnowledgeDraft(overLimitDraft), "个人通用记忆每条最多 2,000 字符，请缩短正文或取消标记。");
  assert.equal(validateKnowledgeDraft(unmarkedDraft), null);
  assert.equal(validateKnowledgeDraft(shortenedDraft), null);

  const overLimitMarkup = render(overLimitDraft, validateKnowledgeDraft(overLimitDraft));
  assert.match(overLimitMarkup, /2,001 \/ 2,000 字符/u);
  assert.match(overLimitMarkup, /请缩短正文或取消标记/u);
  assert.match(overLimitMarkup, /aria-invalid="true"/u);
  const saveButton = overLimitMarkup.match(/<button type="submit"[^>]*>创建知识<\/button>/u)?.[0];
  assert.ok(saveButton);
  assert.doesNotMatch(saveButton, /\sdisabled(?:="")?(?:\s|>)/u);
  assert.match(overLimitMarkup, /knowledge-editor-actions/u);
  assert.match(render(unmarkedDraft), /标记为个人通用记忆后，每条最多 2,000 字符/u);
  assert.match(render(shortenedDraft), /2,000 \/ 2,000 字符/u);
});

test("个人知识交互仅将显式标记的通用记忆用于项目 AI", async () => {
  const [source, editor] = await Promise.all([
    readFile("src/app/personal/knowledge/knowledge-client.tsx", "utf8"),
    readFile("src/app/personal/knowledge/personal-knowledge-editor.tsx", "utf8"),
  ]);

  assert.doesNotMatch(source, /projectId|\/api\/projects/u);
  assert.match(editor, /作为个人通用记忆/u);
  assert.match(source, /项目 AI 可自动参考/u);
  assert.match(editor, /纯文本 \/ Markdown/u);
  assert.match(editor, /保存后会保留版本历史/u);
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
