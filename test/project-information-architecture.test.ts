import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("project overview and materials use separate routes with a compact navigation", async () => {
  const [page, overview, materialsPage, materials, header, dashboard, world, governance] = await Promise.all([
    readFile("src/app/projects/[projectId]/page.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/project-overview-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/materials/page.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/project-client.tsx", "utf8"),
    readFile("src/components/app-header.tsx", "utf8"),
    readFile("src/app/dashboard/dashboard-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/world/project-world-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/governance/project-governance-client.tsx", "utf8"),
  ]);

  assert.match(page, /ProjectOverviewClient/u);
  assert.match(materialsPage, /ProjectDetailClient/u);
  assert.match(header, /href=\{`\/projects\/\$\{projectId\}\/materials`\}/u);
  assert.doesNotMatch(header, /href=\{`\/projects\/\$\{projectId\}#project-materials`\}/u);
  assert.match(header, /href=\{`\/projects\/\$\{projectId\}\/governance`\}/u);
  assert.match(header, />\s*项目概览\s*</u);
  assert.match(header, />\s*项目计划\s*</u);
  assert.match(header, />\s*项目资料\s*</u);
  assert.match(header, />\s*AI 工作台\s*</u);
  assert.match(header, />\s*项目自动化\s*</u);
  assert.match(header, />\s*项目管理\s*</u);
  const orderedTabs = ["项目概览", "项目计划", "项目资料", "AI 工作台", "项目自动化", "项目管理"];
  const tabPositions = orderedTabs.map((label) => header.indexOf(label));
  assert.ok(tabPositions.every((position) => position >= 0));
  assert.deepEqual([...tabPositions].sort((left, right) => left - right), tabPositions);
  assert.match(header, /const overviewSections[^\n]*\["overview"\]/u);
  assert.match(header, /const managementSections[^\n]*\["world", "tools", "actions", "governance"\]/u);
  assert.match(header, /projectSection === "plan"/u);
  assert.match(header, /managementSections/u);
  assert.doesNotMatch(header, /<details|<summary|projectGroups/u);
  assert.doesNotMatch(header, /key: "governance",\s*label: "治理"/u);

  assert.match(overview, /Project overview/u);
  assert.match(overview, /项目关键指标/u);
  assert.match(overview, /推荐下一步/u);
  assert.match(overview, /项目当前状态/u);
  assert.match(overview, /\/api\/projects\/\$\{projectId\}\/world/u);
  assert.match(overview, /id="current-state"/u);
  assert.doesNotMatch(overview, /项目工作区/u);
  assert.match(overview, /高级状态治理/u);
  assert.doesNotMatch(overview, /ProjectMaterialIntake/u);

  assert.match(dashboard, /\/projects\/\$\{entry\.project\.id\}#current-state/u);
  assert.doesNotMatch(dashboard, /href=\{`\/projects\/\$\{entry\.project\.id\}\/world`\}/u);
  assert.match(world, /Advanced state governance/u);
  assert.match(world, /返回项目管理/u);
  assert.match(governance, />状态治理</u);
  assert.match(governance, /\/world/u);

  assert.match(materials, /projectSection="materials"/u);
  assert.match(materials, /ProjectMaterialIntake/u);
  assert.match(materials, /ProjectMaterialReviewQueue/u);
  assert.match(materials, /materials\/sources/u);
  assert.doesNotMatch(materials, /<details|查看原文/u);
  assert.doesNotMatch(materials, /SnapshotPanel|AiCapabilityGuide|PlaceholderCard/u);
  assert.doesNotMatch(materials, /返回项目概览|打开 AI 工作台/u);
});

test("platform provider form keeps GLM embedding-only defaults optional", async () => {
  const settings = await readFile("src/app/settings/settings-client.tsx", "utf8");

  assert.match(settings, /const \[generationModelId, setGenerationModelId\] = useState\("deepseek-v4-flash"\)/u);
  assert.match(settings, /setGenerationModelId\(nextKind === "glm" \? "" : next\.generationModelSuggestions\[0\] \?\? ""\)/u);
  assert.match(settings, /setVisionModelId\(nextKind === "glm" \? "" : next\.visionModelSuggestions\[0\] \?\? ""\)/u);
  assert.match(settings, /generationModelId: generationModelId \|\| null/u);
  assert.match(settings, /visionModelId: definition\?\.supportsVision && visionModelId \? visionModelId : null/u);
  assert.match(settings, /label="图片识别模型（可选）"/u);
  assert.match(settings, /label="生成模型（可选）"/u);
  assert.doesNotMatch(settings, /label="图片识别模型（可选）"><input[^>]*required/u);
  assert.doesNotMatch(settings, /label="生成模型（可选）"><input[^>]*required/u);
  assert.match(settings, /defaultGenerationModelId \?\? "未配置"/u);
  assert.match(settings, /check\.generation !== null/u);
  assert.match(settings, /check\.embeddingDimensions !== null/u);
  assert.match(settings, /check\.vision !== null/u);
  assert.match(settings, /生成连接通过/u);
  assert.match(settings, /向量连接通过/u);
  assert.match(settings, /图片识别连接通过/u);
  assert.doesNotMatch(settings, /setMessage\(payload\.check\.(generation|vision)/u);
});

test("grounded extraction uses bounded scrolling and explicit batch operations", async () => {
  const memory = await readFile("src/app/projects/[projectId]/memory/project-memory-client.tsx", "utf8");

  assert.match(memory, /MAX_BATCH_SELECTION = 10/u);
  assert.match(memory, /选中前 10 条/u);
  assert.match(memory, /反选/u);
  assert.match(memory, /批量确认/u);
  assert.match(memory, /批量驳回/u);
  assert.match(memory, /lg:h-\[620px\]/u);
  assert.match(memory, /aria-label="可选项目资料"/u);
  assert.match(memory, /aria-label="待审核候选列表"/u);
  assert.match(memory, /overflow-y-auto/u);
  assert.match(memory, /expectedItemUpdatedAt: candidate\.projectItem\.updatedAt/u);
  assert.match(memory, /for \(const candidate of batch\)/u);
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

test("project source lists stay compact while detail and notification opens keep server boundaries", async () => {
  const [sourceListRoute, sourceDetailRoute, sourceDetailPage, materials, notifications, bell, automation, openRoute, transport] = await Promise.all([
    readFile("src/app/api/projects/[projectId]/sources/route.ts", "utf8"),
    readFile("src/app/api/projects/[projectId]/sources/[sourceId]/route.ts", "utf8"),
    readFile("src/app/projects/[projectId]/materials/sources/[sourceId]/source-detail-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/project-client.tsx", "utf8"),
    readFile("src/app/notifications/notifications-client.tsx", "utf8"),
    readFile("src/components/notification-bell.tsx", "utf8"),
    readFile("src/lib/automation.ts", "utf8"),
    readFile("src/app/api/notifications/[notificationId]/open/route.ts", "utf8"),
    readFile("src/lib/ai-providers/transport.ts", "utf8"),
  ]);

  assert.match(sourceListRoute, /toSourceSummary/u);
  assert.match(sourceListRoute, /preview/u);
  assert.match(sourceDetailRoute, /contentText: true/u);
  assert.match(sourceDetailPage, /ProjectMaterialsParentLink/u);
  assert.match(sourceDetailPage, /api\/projects\/\$\{projectId\}\/sources\/\$\{sourceId\}/u);
  assert.match(materials, /editingItemId === item\.id/u);
  assert.match(materials, /scrollIntoView/u);
  assert.match(materials, /放弃当前未保存内容/u);
  assert.doesNotMatch(notifications, /标为已读|标为未读/u);
  assert.match(notifications, /\/open/u);
  assert.match(notifications, /dispatchEvent\(new CustomEvent\("ai-project-os:notifications-changed"\)/u);
  assert.match(bell, /notifications-changed/u);
  assert.match(automation, /where: \{ userId, readAt: null \}/u);
  assert.match(automation, /COALESCE/u);
  assert.match(openRoute, /export async function POST/u);
  assert.match(openRoute, /assertSameOrigin\(request\)/u);
  assert.match(transport, /input\.connection\.kind === "glm"/u);
  assert.match(transport, /dimensions: input\.expectedDimensions/u);
});
