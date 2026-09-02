import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("project overview and materials use separate routes with a compact navigation", async () => {
  const [page, overview, materialsPage, materials, header] = await Promise.all([
    readFile("src/app/projects/[projectId]/page.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/project-overview-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/materials/page.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/project-client.tsx", "utf8"),
    readFile("src/components/app-header.tsx", "utf8"),
  ]);

  assert.match(page, /ProjectOverviewClient/u);
  assert.match(materialsPage, /ProjectDetailClient/u);
  assert.match(header, /href=\{`\/projects\/\$\{projectId\}\/materials`\}/u);
  assert.doesNotMatch(header, /href=\{`\/projects\/\$\{projectId\}#project-materials`\}/u);
  assert.match(header, /href=\{`\/projects\/\$\{projectId\}\/governance`\}/u);
  assert.match(header, />\s*项目概览\s*</u);
  assert.match(header, />\s*项目自动化\s*</u);
  assert.match(header, />\s*项目管理\s*</u);
  assert.match(header, /managementSections/u);
  assert.doesNotMatch(header, /<details|<summary|projectGroups/u);
  assert.doesNotMatch(header, /key: "governance",\s*label: "治理"/u);

  assert.match(overview, /Project overview/u);
  assert.match(overview, /项目关键指标/u);
  assert.match(overview, /推荐下一步/u);
  assert.match(overview, /项目当前状态/u);
  assert.doesNotMatch(overview, /ProjectMaterialIntake/u);

  assert.match(materials, /projectSection="materials"/u);
  assert.match(materials, /ProjectMaterialIntake/u);
  assert.match(materials, /ProjectMaterialReviewQueue/u);
  assert.doesNotMatch(materials, /SnapshotPanel|AiCapabilityGuide|PlaceholderCard/u);
  assert.doesNotMatch(materials, /返回项目概览|打开 AI 工作台/u);
});

test("project material operations return to their immediate parent", async () => {
  const [parentLink, assets, externalSources, repositories] = await Promise.all([
    readFile("src/components/project-parent-link.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/assets/project-assets-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/external-sources/project-external-sources-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/repositories/project-repositories-client.tsx", "utf8"),
  ]);

  assert.match(parentLink, /href=\{`\/projects\/\$\{projectId\}\/materials`\}/u);
  assert.match(parentLink, /返回项目资料/u);
  assert.match(assets, /ProjectMaterialsParentLink/u);
  assert.match(externalSources, /ProjectMaterialsParentLink/u);
  assert.match(repositories, /ProjectMaterialsParentLink/u);
});

test("AI workbench spacing and project management keep AI usage visible", async () => {
  const [intelligence, governance] = await Promise.all([
    readFile("src/app/projects/[projectId]/intelligence/project-intelligence-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/governance/project-governance-client.tsx", "utf8"),
  ]);

  assert.match(intelligence, /className="space-y-7"/u);
  assert.doesNotMatch(intelligence, /id="project-brief" className="mt-8/u);
  assert.doesNotMatch(intelligence, /id="agent-investigation" className="mt-8/u);
  assert.match(governance, /AI 用量与计费/u);
  assert.match(governance, /id="ai-usage"/u);
  assert.match(governance, /当前 AI 路由/u);
  assert.match(governance, /读取账户余额/u);
  assert.doesNotMatch(governance, /<summary[^>]*>[^<]*模型用量/u);
  assert.match(governance, /<details id="task-runs" open/u);
  assert.match(governance, /<details id="route-history" open/u);
  assert.doesNotMatch(governance, /待审核候选/u);
});
