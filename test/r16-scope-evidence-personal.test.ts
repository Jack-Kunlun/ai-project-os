import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("personal connection cards expose a permission-safe scope evidence contract", async () => {
  const [models, git, mcp] = await Promise.all([
    readFile("src/app/profile/models/personal-models-client.tsx", "utf8"),
    readFile("src/app/profile/connections/git/git-connections-client.tsx", "utf8"),
    readFile("src/app/profile/connections/mcp/mcp-connections-client.tsx", "utf8"),
  ]);

  for (const source of [models, git, mcp]) {
    assert.match(source, /import \{ ScopeEvidenceCard \} from "@\/components\/scope-evidence-card"/u);
    assert.match(source, /scope: "个人连接"/u);
    assert.match(source, /owner: "当前账户"/u);
    assert.match(source, /尚未取得项目委托证据/u);
    assert.doesNotMatch(source, /affectedProjects: [^\n]*project(?:Id|\.name)/u);
  }

  assert.match(models, /title="个人模型连接边界"/u);
  assert.match(models, /payer: "个人连接所有者承担费用"/u);
  assert.match(models, /provider\.lastTestedAt/u);

  assert.match(git, /title="个人 Git 连接边界"/u);
  assert.match(git, /payer: "不适用（Git 连接不产生平台模型费用）"/u);
  assert.match(git, /connection\.lastTestedAt/u);
  assert.match(git, /不以仓库数量代替项目影响/u);
  assert.doesNotMatch(git, /已关联仓库/u);

  assert.match(mcp, /title="个人 MCP 连接边界"/u);
  assert.match(mcp, /第三方费用由连接所有者承担或按其与服务商约定/u);
  assert.match(mcp, /connection\.lastDiscoveredAt/u);
  assert.match(mcp, /不是调用成功/u);
});

test("personal scope evidence does not expose project identifiers or fabricated aggregates", async () => {
  const [models, git, mcp] = await Promise.all([
    readFile("src/app/profile/models/personal-models-client.tsx", "utf8"),
    readFile("src/app/profile/connections/git/git-connections-client.tsx", "utf8"),
    readFile("src/app/profile/connections/mcp/mcp-connections-client.tsx", "utf8"),
  ]);
  const scopeCardPattern = /<ScopeEvidenceCard[\s\S]*?\/>/gu;

  for (const source of [models, git, mcp]) {
    const cards = source.match(scopeCardPattern) ?? [];
    assert.equal(cards.length, 1);
    assert.doesNotMatch(cards[0]!, /projectId|project\.name|affectedProjectCount|repositories\}/u);
  }
});
