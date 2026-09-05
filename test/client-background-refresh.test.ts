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
  assert.match(source, /\/profile\/connections\/git/u, `${path} must link to personal configuration`);
  assert.match(source, /git-repository-delegations/u, `${path} must use the delegated project API`);
  assert.match(source, /manual-sync/u, `${path} must expose the bounded manual read action`);
  assert.match(source, /manualSyncAllowed:\s*true/u);
  assert.match(source, /automationAllowed:\s*false/u);
  assert.match(source, /自动化、写入\/提交和旧 PAT 路径保持关闭；目标 Git 服务是否可用，以连接测试和单次读取结果为准/u);
  assert.doesNotMatch(source, /api\/settings\/git-connections|api\/projects\/\$\{projectId\}\/git-connections/u);
  assert.doesNotMatch(source, /\/git-(?:push|commit)|\/pull-requests?/u, `${path} must not expose Git write operations`);
});

test("frozen project MCP page links to personal configuration without remote mutations", () => {
  const path = "src/app/projects/[projectId]/tools/project-tools-client.tsx";
  const source = readFileSync(join(root, path), "utf8");
  assert.match(source, /\/profile\/connections\/mcp/u, `${path} must link to personal configuration`);
  assert.match(source, /未开放/u, `${path} must describe the frozen capability`);
  assert.doesNotMatch(source, /fetch\(|method:\s*"(?:POST|PATCH|DELETE)"/u, `${path} must not trigger frozen remote mutations`);
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
