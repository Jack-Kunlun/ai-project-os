import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("个人工作区提供受保护的总览和资源配置汇总", async () => {
  const [root, overview, configuration, nav, header, profile] = await Promise.all([
    readFile("src/app/personal/page.tsx", "utf8"),
    readFile("src/app/personal/personal-overview-client.tsx", "utf8"),
    readFile("src/app/personal/configuration/page.tsx", "utf8"),
    readFile("src/components/personal-workspace-nav.tsx", "utf8"),
    readFile("src/components/app-header.tsx", "utf8"),
    readFile("src/app/profile/profile-client.tsx", "utf8"),
  ]);

  assert.match(root, /requirePageSession\(\)/u);
  assert.match(root, /PersonalOverviewClient/u);
  assert.match(root, /PersonalWorkspaceNav active="overview"/u);
  assert.doesNotMatch(root, /redirect\(/u);
  assert.match(overview, /\/api\/projects\?view=active&page=1&pageSize=8/u);
  assert.match(overview, /\/api\/personal\/knowledge\?limit=1/u);
  assert.match(overview, /\/api\/me\/ai-providers/u);
  assert.match(overview, /\/api\/me\/git-connections/u);
  assert.match(overview, /\/api\/me\/mcp-connections/u);
  assert.match(overview, /\/api\/me\/git-delegations/u);
  assert.match(overview, /\/api\/me\/mcp-delegations/u);
  assert.match(overview, /Promise\.allSettled/u);
  assert.match(overview, /部分统计暂不可用/u);
  assert.match(overview, /以项目当前有效配置为准/u);
  assert.match(overview, /Git 已关联项目/u);
  assert.match(overview, /MCP 已关联项目/u);
  assert.match(overview, /href=\{`\/projects\/\$\{project\.id\}\/configuration`\}/u);
  assert.match(configuration, /PersonalWorkspaceNav active="configuration"/u);
  assert.match(configuration, /href="\/personal\/models"/u);
  assert.match(configuration, /href="\/personal\/connections\/git"/u);
  assert.match(configuration, /href="\/personal\/connections\/mcp"/u);
  assert.match(configuration, /不会自动成为任何项目的默认配置/u);
  assert.match(nav, /个人工作区导航/u);
  assert.match(nav, /href: "\/personal"/u);
  assert.match(nav, /href: "\/personal\/knowledge"/u);
  assert.match(nav, /href: "\/personal\/configuration"/u);
  assert.match(header, /label: "个人工作区", href: "\/personal"/u);
  assert.doesNotMatch(profile, /href="\/profile\/models"/u);
  assert.doesNotMatch(profile, /<h2[^>]*>我的模型<\/h2>/u);
  assert.doesNotMatch(profile, /我的连接|\/profile\/connections/u);
});
