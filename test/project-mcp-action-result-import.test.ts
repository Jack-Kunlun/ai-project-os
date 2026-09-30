import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalProjectMcpActionResultSource,
  ProjectMcpActionResultImportError,
  projectMcpActionExternalRef,
} from "../src/lib/project-mcp-action-result-import-service";
import { sanitizeMcpToolResult } from "../src/lib/mcp/schema";
import { actionRevisionFromFingerprint } from "../src/lib/project-mcp-action-service";

const projectId = "11111111-1111-4111-8111-111111111111";
const actionId = "22222222-2222-4222-8222-222222222222";
const actionFingerprint = "a".repeat(64);
const inputFingerprint = "b".repeat(64);

function sourceInput(resultPayload = sanitizeMcpToolResult({
  text: "safe lookup",
  structuredContent: { ok: true },
  omittedContentCount: 0,
}).payload) {
  const result = sanitizeMcpToolResult(resultPayload as {
    text: string | null;
    structuredContent: unknown;
    omittedContentCount: number;
  });
  return {
    projectId,
    actionId,
    actionFingerprint,
    actionInputFingerprint: inputFingerprint,
    stateVersion: 4,
    toolName: "project.lookup",
    completedAt: new Date("2026-09-26T06:30:45.123Z"),
    resultFingerprint: result.resultFingerprint,
    resultPayload,
    resultBytes: result.resultBytes,
    resultNodes: result.resultNodes,
    resultDepth: result.resultDepth,
  };
}

test("canonical MCP action result source keeps bounded immutable lineage without arguments", () => {
  const source = canonicalProjectMcpActionResultSource(sourceInput());
  const content = JSON.parse(source.contentText) as Record<string, unknown>;
  assert.equal(source.contentFingerprint.length, 64);
  assert.equal(source.actionRevision, actionRevisionFromFingerprint(actionFingerprint));
  assert.equal(source.actionInputFingerprint, inputFingerprint);
  assert.equal(source.resultFingerprint, sourceInput().resultFingerprint);
  assert.equal(projectMcpActionExternalRef(projectId, actionId), `https://ai-project-os.invalid/projects/${projectId}/mcp-actions/${actionId}`);
  assert.deepEqual(content, {
    schemaVersion: "ai-project-os/project-mcp-action-result/v1",
    action: {
      id: actionId,
      revision: source.actionRevision,
      fingerprint: actionFingerprint,
      stateVersion: 4,
      completedAt: "2026-09-26T06:30:45.123Z",
    },
    input: { fingerprint: inputFingerprint },
    tool: { name: "project.lookup" },
    result: {
      fingerprint: source.resultFingerprint,
      payload: { text: "safe lookup", structuredContent: { ok: true }, omittedContentCount: 0 },
    },
  });
  assert.doesNotMatch(source.contentText, /arguments|secret|credential|Authorization/iu);
});

test("canonical MCP action result source fails closed on unsanitized or malformed evidence", () => {
  const sanitized = sanitizeMcpToolResult({
    text: null,
    structuredContent: { access_token: "persisted-secret-marker" },
    omittedContentCount: 0,
  });
  const storedBeforeSanitization = {
    text: null,
    structuredContent: { access_token: "persisted-secret-marker" },
    omittedContentCount: 0,
  };
  assert.ok(sanitized.omittedContentCount > 0);
  assert.throws(
    () => canonicalProjectMcpActionResultSource(sourceInput(storedBeforeSanitization)),
    (error: unknown) => error instanceof ProjectMcpActionResultImportError && error.code === "PROJECT_MCP_ACTION_RESULT_IMPORT_RESULT_INVALID",
  );
  assert.throws(
    () => canonicalProjectMcpActionResultSource({ ...sourceInput(), stateVersion: 3 }),
    (error: unknown) => error instanceof ProjectMcpActionResultImportError && error.code === "PROJECT_MCP_ACTION_RESULT_IMPORT_RESULT_INVALID",
  );
  assert.throws(
    () => canonicalProjectMcpActionResultSource({ ...sourceInput(), resultBytes: 262_145 }),
    (error: unknown) => error instanceof ProjectMcpActionResultImportError && error.code === "PROJECT_MCP_ACTION_RESULT_IMPORT_RESULT_INVALID",
  );
  assert.throws(
    () => canonicalProjectMcpActionResultSource({ ...sourceInput(), toolName: "bad tool name" }),
    (error: unknown) => error instanceof ProjectMcpActionResultImportError && error.code === "PROJECT_MCP_ACTION_RESULT_IMPORT_RESULT_INVALID",
  );
});
