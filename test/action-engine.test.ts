import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ActionEngineError,
  canonicalProjectActionInput,
  isProjectActionTransitionAllowed,
  projectActionCapabilityCatalog,
  projectActionInputFingerprint,
} from "../src/lib/action-engine";

function actionError(operation: () => unknown): string | null {
  try { operation(); return null; }
  catch (error) { return error instanceof ActionEngineError ? error.code : "unexpected"; }
}

test("动作能力注册表仅开放内置能力与受控 MCP 只读调用", () => {
  const catalog = projectActionCapabilityCatalog();
  assert.deepEqual(catalog.map((entry) => entry.id), [
    "project.repository.sync",
    "project.web-source.sync",
    "project.memory-quality.scan",
    "project.mcp.read-tool.invoke",
  ]);
  assert.deepEqual(catalog.map((entry) => entry.defaultPolicy), ["approvalRequired", "approvalRequired", "automatic", "approvalRequired"]);
  assert.ok(catalog.every((entry) => entry.effect === "local" || entry.effect === "external-read"));
  assert.equal(catalog.find((entry) => entry.id === "project.mcp.read-tool.invoke")?.riskLevel, "high");
  assert.equal(new Set(catalog.map((entry) => entry.id)).size, catalog.length);
});

test("动作输入严格、规范且指纹绑定项目与能力", () => {
  const projectA = "00000000-0000-4000-8000-000000000101";
  const projectB = "00000000-0000-4000-8000-000000000102";
  assert.deepEqual(canonicalProjectActionInput("project.memory-quality.scan", undefined), {});
  assert.equal(actionError(() => canonicalProjectActionInput("project.memory-quality.scan", { extra: true })), "ACTION_INVALID_INPUT");
  assert.equal(actionError(() => canonicalProjectActionInput("shell.execute", {})), "ACTION_INVALID_INPUT");
  const first = projectActionInputFingerprint(projectA, "project.memory-quality.scan", {});
  assert.match(first, /^[0-9a-f]{64}$/u);
  assert.equal(first, projectActionInputFingerprint(projectA, "project.memory-quality.scan", {}));
  assert.notEqual(first, projectActionInputFingerprint(projectB, "project.memory-quality.scan", {}));
  assert.notEqual(first, projectActionInputFingerprint(projectA, "project.repository.sync", {}));
  const mcpSnapshot = {
    grantId: "00000000-0000-4000-8000-000000000201",
    connectionId: "00000000-0000-4000-8000-000000000202",
    toolName: "project.search",
    toolDefinitionId: "00000000-0000-4000-8000-000000000203",
    attestationId: "00000000-0000-4000-8000-000000000204",
    toolDefinitionFingerprint: "a".repeat(64),
    networkFingerprint: "b".repeat(64),
    credentialFingerprint: "c".repeat(64),
    arguments: { query: "release" },
  };
  assert.deepEqual(canonicalProjectActionInput("project.mcp.read-tool.invoke", mcpSnapshot), mcpSnapshot);
  const mcpFingerprint = projectActionInputFingerprint(projectA, "project.mcp.read-tool.invoke", mcpSnapshot);
  assert.notEqual(mcpFingerprint, first);
  assert.notEqual(
    mcpFingerprint,
    projectActionInputFingerprint(projectA, "project.mcp.read-tool.invoke", {
      ...mcpSnapshot,
      attestationId: "00000000-0000-4000-8000-000000000205",
    }),
  );
});

test("动作状态机只允许审批、队列和一次执行收口", () => {
  assert.equal(isProjectActionTransitionAllowed("waitingApproval", "queued"), true);
  assert.equal(isProjectActionTransitionAllowed("waitingApproval", "rejected"), true);
  assert.equal(isProjectActionTransitionAllowed("queued", "running"), true);
  assert.equal(isProjectActionTransitionAllowed("running", "succeeded"), true);
  assert.equal(isProjectActionTransitionAllowed("running", "queued"), false);
  assert.equal(isProjectActionTransitionAllowed("failed", "queued"), false);
  assert.equal(isProjectActionTransitionAllowed("succeeded", "running"), false);
});

test("Action Engine 迁移在数据库层固定能力、状态和不可变审计", async () => {
  const migration = await readFile("prisma/migrations/20260829220000_add_project_action_engine/migration.sql", "utf8");
  assert.match(migration, /ProjectAction_capability_check/u);
  assert.match(migration, /ProjectAction_state_check/u);
  assert.match(migration, /project_action_state_guard/u);
  assert.match(migration, /project_action_approval_guard/u);
  assert.match(migration, /project_action_audit_guard/u);
  assert.match(migration, /project_action_policy_revision_guard/u);
  assert.match(migration, /approval_required/u);
  assert.match(migration, /archived project action cannot start/u);
  assert.doesNotMatch(migration, /shell\.execute|code\.write|pull-request\.create|deploy/u);
});

test("Action Worker 与 API 权限入口保持失败关闭", async () => {
  const worker = await readFile("scripts/automation-worker.ts", "utf8");
  const access = await readFile("src/lib/access-control.ts", "utf8");
  const service = await readFile("src/lib/action-engine.ts", "utf8");
  assert.match(worker, /runProjectActionWorkerCycle/u);
  assert.match(access, /action-policies/u);
  assert.equal(access.includes("actions\\/[0-9a-f-]+\\/decision"), true);
  assert.doesNotMatch(service, /child_process|execSync|spawn\(|shell\.execute|code\.write|deploy\.execute/u);
  assert.match(service, /FOR UPDATE SKIP LOCKED/u);
  assert.match(service, /ACTION_LEASE_EXPIRED/u);
  assert.match(service, /ACTION_IDEMPOTENCY_CONFLICT/u);
  assert.match(service, /tryCreateActionNotification/u);
  assert.equal(service.match(/31010001/gu)?.length, 2);
});
