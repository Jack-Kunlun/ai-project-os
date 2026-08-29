import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ActionResultIntakeError,
  actionResultIntakeRequestFingerprint,
  canonicalProjectActionResultSource,
} from "../src/lib/action-result-intake";

const actionId = "00000000-0000-4000-8000-000000000301";
const inputFingerprint = "a".repeat(64);
const resultFingerprint = "b".repeat(64);

function result(structuredContent: unknown = { z: 2, a: 1 }) {
  return {
    connectionId: "00000000-0000-4000-8000-000000000302",
    toolName: "project.search",
    definitionFingerprint: "c".repeat(64),
    text: "two matches",
    structuredContent,
    hasStructuredContent: true,
    omittedContentCount: 0,
    resultFingerprint,
  };
}

test("MCP 动作结果规范化后固定动作、工具与结果指纹", () => {
  const first = canonicalProjectActionResultSource({
    actionId,
    inputFingerprint,
    completedAt: new Date("2026-08-30T01:02:03.000Z"),
    result: result({ z: 2, a: 1 }),
  });
  const second = canonicalProjectActionResultSource({
    actionId,
    inputFingerprint,
    completedAt: new Date("2026-08-30T01:02:03.000Z"),
    result: result({ a: 1, z: 2 }),
  });
  assert.equal(first.contentText, second.contentText);
  assert.equal(first.contentFingerprint, second.contentFingerprint);
  assert.equal(first.resultFingerprint, resultFingerprint);
  assert.match(first.contentText, /ai-project-os\/mcp-action-result\/v1/u);
  assert.match(first.contentText, new RegExp(actionId, "u"));
  assert.match(first.contentFingerprint, /^[0-9a-f]{64}$/u);
});

test("动作结果纳入拒绝无效或超过资料上限的响应", () => {
  assert.throws(
    () => canonicalProjectActionResultSource({ actionId, inputFingerprint, completedAt: new Date(), result: { unsafe: true } }),
    (error) => error instanceof ActionResultIntakeError && error.code === "ACTION_RESULT_INTAKE_INVALID_INPUT",
  );
  assert.throws(
    () => canonicalProjectActionResultSource({ actionId, inputFingerprint, completedAt: new Date(), result: result("x".repeat(100_001)) }),
    (error) => error instanceof ActionResultIntakeError && error.code === "ACTION_RESULT_INTAKE_TOO_LARGE",
  );
});

test("纳入请求指纹绑定项目、动作、输入与结果", () => {
  const base = { projectId: "00000000-0000-4000-8000-000000000303", actionId, inputFingerprint, resultFingerprint };
  const fingerprint = actionResultIntakeRequestFingerprint(base);
  assert.match(fingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(fingerprint, actionResultIntakeRequestFingerprint(base));
  assert.notEqual(fingerprint, actionResultIntakeRequestFingerprint({ ...base, resultFingerprint: "d".repeat(64) }));
});

test("数据库迁移只允许成功 MCP 结果生成不可变项目资料", async () => {
  const migration = await readFile("prisma/migrations/20260830010000_add_action_result_intake/migration.sql", "utf8");
  assert.match(migration, /ALTER TYPE "ProjectSourceKind" ADD VALUE 'mcp'/u);
  assert.match(migration, /only the current successful MCP action result can be imported/u);
  assert.match(migration, /project action result imports are append-only/u);
  assert.match(migration, /sourceIdentity/u);
  assert.match(migration, /resultFingerprint/u);
});

test("结果导入 API 同时执行会话、同源、生命周期与服务层校验", async () => {
  const route = await readFile("src/app/api/projects/[projectId]/actions/[actionId]/result-import/route.ts", "utf8");
  assert.match(route, /assertSameOrigin\(request\)/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /assertProjectActive\(projectId\)/u);
  assert.match(route, /importProjectActionResult/u);
});
