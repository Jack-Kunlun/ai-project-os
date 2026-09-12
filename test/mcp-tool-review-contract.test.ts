import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mapApiError } from "../src/lib/api-errors";
import { McpCapabilityError, normalizeMcpToolReviewEvidenceNote } from "../src/lib/mcp";

function mcpCode(error: unknown): string {
  return error instanceof McpCapabilityError ? error.code : "unexpected";
}

test("MCP review evidence notes normalize Unicode and reject secret-bearing content", () => {
  assert.equal(normalizeMcpToolReviewEvidenceNote("  工具声明只读，未发现破坏性动作。  "), "工具声明只读,未发现破坏性动作。");
  assert.throws(() => normalizeMcpToolReviewEvidenceNote("see https://remote.example.invalid"), (error: unknown) => mcpCode(error) === "MCP_TOOL_REVIEW_NOTE_UNSAFE");
  assert.throws(() => normalizeMcpToolReviewEvidenceNote("Bearer abcdefghijklmnopqrstuvwxyz"), (error: unknown) => mcpCode(error) === "MCP_TOOL_REVIEW_NOTE_UNSAFE");
  assert.throws(() => normalizeMcpToolReviewEvidenceNote("a".repeat(241)), (error: unknown) => mcpCode(error) === "MCP_TOOL_REVIEW_NOTE_UNSAFE");
  assert.throws(() => normalizeMcpToolReviewEvidenceNote("review\nnext"), (error: unknown) => mcpCode(error) === "MCP_TOOL_REVIEW_NOTE_UNSAFE");
});

test("MCP review API and audit projection never expose the stored note body", async () => {
  const [route, audit, service, grantService, migration] = await Promise.all([
    readFile("src/app/api/system/mcp-tool-reviews/route.ts", "utf8"),
    readFile("src/lib/system-audit.ts", "utf8"),
    readFile("src/lib/mcp-tool-review-service.ts", "utf8"),
    readFile("src/lib/project-mcp-tool-grant-service.ts", "utf8"),
    readFile("prisma/migrations/20260912030000_add_connection_governance/migration.sql", "utf8"),
  ]);
  assert.match(route, /cache-control.*no-store/u);
  assert.match(route, /assertSameOrigin/u);
  assert.match(service, /evidenceNote: false/u);
  assert.match(service, /noteFingerprint/u);
  assert.match(service, /MCP_TOOL_REVIEW_ATTESTATION_CONFLICT/u);
  assert.match(service, /activeHasApprovedReview/u);
  assert.match(grantService, /review_required/u);
  assert.match(grantService, /delegation_expired/u);
  assert.match(grantService, /connection_evidence_drift/u);
  assert.match(migration, /project_mcp_tool_grant_review_guard/u);
  assert.match(migration, /mcp_tool_attestation_review_eligible/u);
  assert.doesNotMatch(audit, /evidenceNote:/u);
  const mapped = mapApiError(new McpCapabilityError("MCP_TOOL_REVIEW_CANDIDATE_STALE"));
  assert.equal(mapped.status, 409);
  assert.equal(mapped.body.error.code, "MCP_TOOL_REVIEW_CANDIDATE_STALE");
});
