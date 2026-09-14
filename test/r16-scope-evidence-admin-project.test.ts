import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("ADM-014 persistent configuration cards expose honest scope evidence", async () => {
  const [platform, team, automations, settings] = await Promise.all([
    readFile("src/app/admin/models/platform-grant-offer-policy-client.tsx", "utf8"),
    readFile("src/app/team/team-client.tsx", "utf8"),
    readFile("src/app/projects/[projectId]/automations/project-automations-client.tsx", "utf8"),
    readFile("src/app/settings/settings-client.tsx", "utf8"),
  ]);

  assert.match(platform, /ScopeEvidenceCard/u);
  assert.match(platform, /平台 · 后续已验证新注册/u);
  assert.match(platform, /平台管理员/u);
  assert.match(platform, /平台承担赠送额度/u);
  assert.match(platform, /项目不适用 · 符合条件账户/u);
  assert.match(platform, /activatedAt/u);
  assert.match(platform, /最近生效证据/u);
  assert.match(platform, /尚未取得验证或生效证据/u);

  assert.match(team, /ScopeEvidenceCard/u);
  assert.match(team, /当前工作区登录/u);
  assert.match(team, /自动加入/u);
  assert.match(team, /工作区管理员/u);
  assert.match(team, /项目不适用 · 工作区成员 · 自动加入账户/u);
  assert.match(team, /lastTestedAt/u);
  assert.match(team, /尚未取得验证证据/u);

  assert.match(automations, /ScopeEvidenceCard/u);
  assert.match(automations, /仅当前项目 · \$\{kindLabels\[rule\.kind\]\}/u);
  assert.match(automations, /AI 工作台当次确认后决定/u);
  assert.match(automations, /不产生模型费用/u);
  assert.match(automations, /status === "succeeded"/u);
  assert.match(automations, /尚未取得成功运行证据/u);

  assert.match(settings, /ScopeEvidenceCard/u);
  assert.match(settings, /项目影响需经活动默认路由影响预览核实/u);
  assert.match(settings, /当前有 \$\{provider\._count\.platformDefaultAiRoutes\} 条活动默认路由引用/u);
  assert.match(settings, /尚无活动默认路由引用；暂无项目影响证据/u);
  assert.doesNotMatch(settings, /affectedProjects:\s*provider\._count\.platformDefaultAiRoutes > 0 \? `被/u);
  assert.match(settings, /function probeBudgetEvidence\(budget: ProbeBudgetSummary \| null, loading: boolean\)/u);
  assert.match(settings, /尚未启用预算；暂无探测预算状态证据/u);

  const budgetPanelStart = settings.indexOf("function PlatformProviderProbeBudgetPanel()");
  assert.ok(budgetPanelStart >= 0, "PlatformProviderProbeBudgetPanel must remain identifiable");
  const budgetPanel = settings.slice(budgetPanelStart);
  assert.match(budgetPanel, /ScopeEvidenceCard title="平台探测预算边界"/u);
  assert.match(budgetPanel, /平台 · 供应商连通性探测/u);
  assert.match(budgetPanel, /平台管理员/u);
  assert.match(budgetPanel, /平台探测预算/u);
  assert.match(budgetPanel, /项目不适用 · 仅平台供应商连通性探测/u);
  assert.match(budgetPanel, /probeBudgetEvidence\(budget, loading\)/u);

  for (const source of [platform, team, automations, settings]) {
    const pixelValues = [...source.matchAll(/(?<![\d.])(\d+)px/gu)].map((match) => Number(match[1]));
    assert.deepEqual(pixelValues.filter((value) => value > 3 && value % 2 === 1), [], "odd pixel values over 3 are prohibited");
  }
});
