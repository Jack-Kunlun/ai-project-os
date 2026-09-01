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
  ["src/app/projects/[projectId]/repositories/project-repositories-client.tsx", "reload"],
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
