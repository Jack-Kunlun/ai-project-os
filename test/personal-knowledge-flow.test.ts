import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildProjectMaterialsAddHref,
  copyPersonalKnowledgeBody,
  filterActiveProjects,
} from "../src/lib/personal-project-handoff";

const accessibleProjectId = "1eb3cebd-b9c2-44e0-b235-5b5d25a3b145";
const readOnlyProjectId = "2eb3cebd-b9c2-44e0-b235-5b5d25a3b146";
const archivedProjectId = "3eb3cebd-b9c2-44e0-b235-5b5d25a3b147";

test("保存后打开内容，并在同一处提供阅读、提问、索引和项目下一步", async () => {
  const [client, nextSteps, qa] = await Promise.all([
    readFile("src/app/personal/knowledge/knowledge-client.tsx", "utf8"),
    readFile("src/app/personal/knowledge/personal-knowledge-next-steps.tsx", "utf8"),
    readFile("src/app/personal/knowledge/personal-knowledge-qa-panel.tsx", "utf8"),
  ]);

  assert.match(client, /setLibraryScreen\(isCreate \? "list" : modalReturnScreenRef\.current\)/u);
  assert.match(client, /<PersonalKnowledgeNextSteps[^>]*content=\{document\.content\}/u);
  assert.match(nextSteps, /onOpenSemanticIndex/u);
  assert.match(nextSteps, /<PersonalProjectHandoff content=\{content\}/u);
  assert.match(qa, /href=\{buildPersonalKnowledgeAskHref\(documentId\)\}/u);
  assert.match(qa, /\/ask\?history=1/u);
  assert.doesNotMatch(qa, /\/api\/personal\/knowledge\/\$\{encodeURIComponent\(documentId\)\}\/qa/u);
});

test("项目选择展示可访问的进行中项目并提示保存权限，按需加载且生成纯路径跳转", async () => {
  const handoffSource = await readFile("src/app/personal/knowledge/personal-project-handoff.tsx", "utf8");
  const projects = filterActiveProjects([
    { id: accessibleProjectId, name: "可访问但未返回编辑权限的项目", archivedAt: null },
    { id: readOnlyProjectId, name: "只读项目", archivedAt: null, canEdit: false },
    { id: archivedProjectId, name: "已归档项目", archivedAt: "2026-10-01T00:00:00.000Z" },
  ]);

  assert.deepEqual(projects.map((project) => project.id), [accessibleProjectId]);
  assert.equal(buildProjectMaterialsAddHref(accessibleProjectId), `/projects/${accessibleProjectId}/materials?view=add&kind=manual`);
  assert.match(handoffSource, /function handleOpenChange\(nextOpen: boolean\): void \{[\s\S]*?if \(nextOpen\) \{\s*loadProjects\(\)/u);
  assert.match(handoffSource, /view: "active"/u);
  assert.match(handoffSource, /没有可访问的进行中项目/u);
  assert.match(handoffSource, /这里列出你可访问的进行中项目；保存资料需要编辑权限/u);
  assert.match(handoffSource, /role="alert"/u);
  assert.doesNotMatch(handoffSource, /localStorage|sessionStorage/u);
});

test("剪贴板失败保持失败状态并给出手动复制方式", async () => {
  const handoffSource = await readFile("src/app/personal/knowledge/personal-project-handoff.tsx", "utf8");
  const body = "私有个人知识正文";

  await assert.rejects(copyPersonalKnowledgeBody(body, { writeText: async () => { throw new Error("clipboard denied"); } }), /clipboard denied/u);
  assert.match(handoffSource, /catch \{\s*setCopyState\("fallback"\);\s*\}/u);
  assert.match(handoffSource, /copyState === "copied" \? <p[^>]*role="status">正文已复制/u);
  assert.match(handoffSource, /copyState === "fallback" \? \([\s\S]*?自动复制失败/u);
  assert.match(handoffSource, /aria-label="待手动复制的个人知识正文"/u);
  assert.doesNotMatch(buildProjectMaterialsAddHref(accessibleProjectId), new RegExp(body, "u"));
});
