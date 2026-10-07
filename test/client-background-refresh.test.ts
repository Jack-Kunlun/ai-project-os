import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

const backgroundReloadClients = [
  ["src/app/team/team-client.tsx", "reload"],
  ["src/app/projects/projects-client.tsx", "load"],
  ["src/app/projects/[projectId]/assets/project-assets-client.tsx", "reload"],
  ["src/app/projects/[projectId]/automations/project-automations-client.tsx", "reload"],
  ["src/app/projects/[projectId]/control/project-control-client.tsx", "reload"],
  ["src/app/projects/[projectId]/external-sources/project-external-sources-client.tsx", "reload"],
  ["src/app/projects/[projectId]/governance/project-governance-client.tsx", "reload"],
  ["src/app/projects/[projectId]/intelligence/project-intelligence-client.tsx", "reload"],
  ["src/app/projects/[projectId]/memory-quality/project-memory-quality-client.tsx", "reload"],
  ["src/app/projects/[projectId]/memory/project-memory-client.tsx", "reload"],
  ["src/app/projects/[projectId]/world/project-world-client.tsx", "reload"],
] as const;

test("mutation-triggered data reloads keep mounted UI after the initial page load", () => {
  for (const [path, functionName] of backgroundReloadClients) {
    const source = readFileSync(join(root, path), "utf8");
    assert.match(source, /showLoading = false/u, `${path} must default to a background reload`);
    assert.match(source, /if \(showLoading\) setLoading\(true\);/u, `${path} must only show a blocking loader explicitly`);
    assert.match(source, /if \(showLoading\) setLoading\(false\);/u, `${path} must preserve the mounted page after background reloads`);
    assert.match(
      source,
      new RegExp(`${functionName}\\(\\{ showLoading: true \\}\\)`, "u"),
      `${path} must still show loading UI on first entry`,
    );
  }
});

test("project Git page uses bounded manual delegation while remote writes stay frozen", () => {
  const path = "src/app/projects/[projectId]/repositories/project-repositories-client.tsx";
  const source = readFileSync(join(root, path), "utf8");
  assert.match(source, /\/personal\/connections\/git/u, `${path} must link to personal configuration`);
  assert.match(source, /git-repository-delegations/u, `${path} must use the delegated project API`);
  assert.match(source, /manual-sync/u, `${path} must expose the bounded manual read action`);
  assert.match(source, /manualSyncAllowed:\s*true/u);
  assert.match(source, /automationAllowed:\s*false/u);
  assert.match(source, /连接仍由个人持有；手动读取与自动读取分别授权，项目 Owner 和连接所有者需独立确认/u);
  assert.match(source, /自动读取需另外完成双确认/u);
  assert.match(source, /写入、提交和 Pull Request 保持关闭/u);
  assert.match(source, /查看运行历史/u);
  assert.doesNotMatch(source, /api\/settings\/git-connections|api\/projects\/\$\{projectId\}\/git-connections/u);
  assert.doesNotMatch(source, /\/git-(?:push|commit)|\/pull-requests?/u, `${path} must not expose Git write operations`);
});

test("project MCP page gates the read-only action entry without calling tools from the control plane", () => {
  const path = "src/app/projects/[projectId]/tools/project-tools-client.tsx";
  const source = readFileSync(join(root, path), "utf8");
  assert.match(source, /\/personal\/connections\/mcp/u, `${path} must link to personal configuration`);
  assert.match(source, /\/api\/projects\/\$\{projectId\}\/mcp-connection-delegations/u);
  assert.match(source, /\/api\/projects\/\$\{projectId\}\/mcp-tool-grants/u);
  assert.match(source, /控制面开放；动作调用冻结/u, `${path} must distinguish control-plane availability from action freeze`);
  assert.match(source, /仅管理连接委托和只读工具授权/u, `${path} must state the current scope`);
  assert.match(source, /mcpActionsEnabled && <Link href=\{`\/projects\/\$\{projectId\}\/mcp-actions`\}/u, `${path} must gate the action entry`);
  assert.doesNotMatch(source, /\/tools\/call|\/dispatch|result-import/u, `${path} must not call tools or import results from the control plane`);
});

test("profile updates its username locally without refreshing the current route", () => {
  const source = readFileSync(join(root, "src/app/profile/profile-client.tsx"), "utf8");
  const componentStart = source.indexOf("export function ProfileClient");
  const componentEnd = source.indexOf("function UsernameForm");
  assert.ok(componentStart >= 0 && componentEnd > componentStart);
  assert.doesNotMatch(source.slice(componentStart, componentEnd), /router\.refresh\(\)/u);
});

test("memory review reports a local candidate-list update", () => {
  const source = readFileSync(join(root, "src/app/projects/[projectId]/memory/project-memory-client.tsx"), "utf8");
  assert.match(source, /已确认 1 条记忆，候选列表已局部更新。/u);
  assert.match(source, /已驳回 1 条候选，列表已局部更新。/u);
});
