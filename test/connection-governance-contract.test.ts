import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isGitConnectionMutationAction } from "@/lib/git/connection-governance";
import { isMcpConnectionMutationAction } from "@/lib/mcp/connection-governance";

const schema = readFileSync("prisma/schema.prisma", "utf8");
const migration = readFileSync("prisma/migrations/20260912030000_add_connection_governance/migration.sql", "utf8");
const gitGovernance = readFileSync("src/lib/git/connection-governance.ts", "utf8");
const mcpGovernance = readFileSync("src/lib/mcp/connection-governance.ts", "utf8");
const gitService = readFileSync("src/lib/git/service.ts", "utf8");
const mcpErrors = readFileSync("src/lib/mcp/errors.ts", "utf8");
const gitLegacyRoute = readFileSync("src/app/api/me/git-connections/[connectionId]/route.ts", "utf8");
const gitTestRoute = readFileSync("src/app/api/me/git-connections/[connectionId]/test/route.ts", "utf8");
const mcpLegacyRoute = readFileSync("src/app/api/me/mcp-connections/[connectionId]/route.ts", "utf8");
const mcpDiscoverRoute = readFileSync("src/app/api/me/mcp-connections/[connectionId]/discover/route.ts", "utf8");
const gitPreviewRoute = readFileSync("src/app/api/me/git-connections/[connectionId]/governance/preview/route.ts", "utf8");
const gitExecuteRoute = readFileSync("src/app/api/me/git-connections/[connectionId]/governance/execute/route.ts", "utf8");
const mcpPreviewRoute = readFileSync("src/app/api/me/mcp-connections/[connectionId]/governance/preview/route.ts", "utf8");
const mcpExecuteRoute = readFileSync("src/app/api/me/mcp-connections/[connectionId]/governance/execute/route.ts", "utf8");
const reviewService = readFileSync("src/lib/mcp-tool-review-service.ts", "utf8");
const reviewRoute = readFileSync("src/app/api/system/mcp-tool-reviews/route.ts", "utf8");
const mcpState = readFileSync("src/app/profile/connections/mcp/mcp-connections-state.ts", "utf8");
const principalCatalog = readFileSync("src/lib/database-principal-catalog.ts", "utf8");
const auditCatalog = readFileSync("src/lib/system-audit-catalog.ts", "utf8");
const audit = readFileSync("src/lib/system-audit.ts", "utf8");

test("connection governance action guards reject untested direct configuration edits", () => {
  for (const guard of [isGitConnectionMutationAction, isMcpConnectionMutationAction]) {
    assert.equal(guard("rotateCredential"), true);
    assert.equal(guard("editConfiguration"), false);
    assert.equal(guard({ action: "retest" }), false);
  }
  assert.equal(isGitConnectionMutationAction("retest"), true);
  assert.equal(isMcpConnectionMutationAction("rediscover"), true);
});

test("Git and MCP connection mutations have separate typed preview and audit models", () => {
  for (const action of ["GitConnectionMutationAction", "McpConnectionMutationAction", "ConnectionMutationExecutionStatus"]) {
    assert.match(schema, new RegExp(`enum ${action}\\b`, "u"));
  }
  for (const model of ["GitConnectionMutationPreview", "GitConnectionMutationAudit", "McpConnectionMutationPreview", "McpConnectionMutationAudit"]) {
    assert.match(schema, new RegExp(`model ${model}\\b`, "u"));
  }
  assert.match(schema, /candidateSecretFingerprint\s+String\?/u);
  assert.match(schema, /impactSnapshot\s+Json/u);
  assert.match(schema, /@@unique\(\[actorId, requestKey\]\)/u);
  for (const model of ["McpToolReview", "McpToolReviewAudit"]) {
    assert.match(schema, new RegExp(`model ${model}\\b`, "u"));
    assert.match(migration, new RegExp(`CREATE TABLE "${model}"`, "u"));
  }
  assert.match(schema, /McpToolReviewConclusion/u);
  assert.match(schema, /connectionOwnerAccountAccessVersion/u);
});

test("connection governance is serializable, clock-bound, CAS-protected and append-only", () => {
  for (const source of [gitGovernance, mcpGovernance]) {
    assert.match(source, /TransactionIsolationLevel\.Serializable/u);
    assert.match(source, /lockActorAccess\(tx, actor\.id\)/u);
    assert.match(source, /lockConnection\(tx, connectionId\)/u);
    assert.match(source, /clock_timestamp\(\)/u);
    assert.match(source, /expiresAt\.getTime\(\)/u);
    assert.match(source, /candidateSecretFingerprint/u);
    assert.match(source, /impactFingerprint/u);
    assert.match(source, /consumedAt/u);
  }
  assert.match(gitGovernance, /setConfig\(tx, "app\.git_connection_governance_context", "1"\)/u);
  assert.match(mcpGovernance, /setConfig\(tx, "app\.mcp_connection_governance_context", "1"\)/u);
  assert.match(gitGovernance, /external_io_planned_not_dispatched/u);
  assert.match(mcpGovernance, /external_io_planned_not_dispatched/u);
  assert.match(migration, /SET search_path = pg_catalog, public/u);
  assert.match(migration, /connection mutation audit is append-only/u);
  assert.match(migration, /mutation preview can only be consumed once/u);
  assert.match(migration, /REVOKE ALL ON TABLE/u);
  assert.match(migration, /REVOKE ALL ON FUNCTION "git_connection_governance_security_guard"/u);
  assert.match(migration, /REVOKE ALL ON FUNCTION "mcp_connection_governance_security_guard"/u);
  assert.match(migration, /OLD\."endpointUrl" IS DISTINCT FROM NEW\."endpointUrl"/u);
  assert.match(migration, /OLD\."baseUrl" IS DISTINCT FROM NEW\."baseUrl"/u);
  const mcpRotation = mcpGovernance.slice(mcpGovernance.indexOf('action === "rotateCredential"'), mcpGovernance.indexOf('} else if (action === "disable")'));
  assert.doesNotMatch(mcpRotation, /configurationRevision:\s*\{\s*increment/u);
  assert.match(gitGovernance, /connectionAfter\?\.configurationVersion/u);
  assert.match(mcpGovernance, /connectionAfter\?\.configurationRevision/u);
  assert.match(migration, /app\.git_connection_governance_action/u);
  assert.match(migration, /rotate_credential/u);
});

test("legacy high-risk connection entry points fail closed and strict governance routes are wired", () => {
  assert.match(gitLegacyRoute, /GIT_CONNECTION_GOVERNANCE_REQUIRED/u);
  assert.match(gitTestRoute, /GIT_CONNECTION_GOVERNANCE_REQUIRED/u);
  assert.match(mcpLegacyRoute, /MCP_CONNECTION_GOVERNANCE_REQUIRED/u);
  assert.match(mcpDiscoverRoute, /MCP_CONNECTION_GOVERNANCE_REQUIRED/u);
  assert.match(gitLegacyRoute, /renameSchema\.parse\(await readJsonBody\(request\)\)/u);
  assert.match(gitLegacyRoute, /updateGitConnection/u);
  assert.doesNotMatch(gitLegacyRoute, /deleteGitConnection/u);
  assert.doesNotMatch(gitTestRoute, /testGitConnection/u);
  assert.match(mcpLegacyRoute, /renameSchema\.parse\(await readJsonBody\(request\)\)/u);
  assert.match(mcpLegacyRoute, /updateMcpConnection/u);
  assert.doesNotMatch(mcpLegacyRoute, /deleteMcpConnection/u);
  assert.doesNotMatch(mcpDiscoverRoute, /discoverMcpConnectionTools/u);
  for (const route of [gitPreviewRoute, gitExecuteRoute, mcpPreviewRoute, mcpExecuteRoute]) {
    assert.match(route, /assertSameOrigin/u);
    assert.match(route, /requireApiSession/u);
    assert.match(route, /readJsonBody/u);
    assert.match(route, /no-store/u);
  }
  assert.match(gitService, /GIT_CONNECTION_GOVERNANCE_REQUIRED/u);
  assert.match(mcpErrors, /MCP_CONNECTION_GOVERNANCE_REQUIRED/u);
});

test("connection governance relations and audit sources are explicit and safe", () => {
  assert.match(principalCatalog, /"GitConnectionMutationPreview", "GitConnectionMutationAudit"/u);
  assert.match(principalCatalog, /"McpConnectionMutationPreview", "McpConnectionMutationAudit"/u);
  assert.match(principalCatalog, /RUNTIME_ONLY_CONTROL_PLANE_RELATIONS[\s\S]*GitConnectionMutationPreview/u);
  assert.match(auditCatalog, /gitConnectionMutation/u);
  assert.match(auditCatalog, /mcpConnectionMutation/u);
  assert.match(audit, /GitConnectionMutationAudit/u);
  assert.match(audit, /McpConnectionMutationAudit/u);
  assert.doesNotMatch(audit, /evidenceNote\s*:/u);
});

test("MCP review is an immutable, redacted V2 control-plane boundary", () => {
  assert.match(reviewService, /reviewInputSchema[\s\S]*\.strict\(\)/u);
  assert.match(reviewService, /normalize\("NFKC"\)/u);
  assert.match(reviewService, /MCP_TOOL_REVIEW_NOTE_UNSAFE/u);
  assert.match(reviewService, /MCP_TOOL_REVIEW_CANDIDATE_STALE/u);
  assert.match(reviewService, /MCP_TOOL_REVIEW_IDEMPOTENCY_CONFLICT/u);
  assert.match(reviewService, /TransactionIsolationLevel\.Serializable/u);
  assert.match(reviewService, /lockActorAccess\(tx, actorId\)/u);
  assert.match(reviewService, /32010000/u);
  assert.match(reviewService, /32010003/u);
  assert.match(reviewService, /set_config\(/u);
  assert.match(reviewService, /mcpToolAttestation\.create/u);
  assert.match(reviewService, /mcpToolAttestationAudit\.create/u);
  assert.match(reviewService, /mcpToolReviewAudit\.create/u);
  assert.match(reviewService, /evidenceNotePresent: true/u);
  const reviewProjection = reviewService.slice(
    reviewService.indexOf("function projectReview"),
    reviewService.indexOf("function sameRequest"),
  );
  assert.doesNotMatch(reviewProjection, /evidenceNote\s*:/u);
  assert.match(reviewRoute, /assertSameOrigin/u);
  assert.match(reviewRoute, /requireApiSession/u);
  assert.match(reviewRoute, /createMcpToolReview/u);
  assert.match(reviewRoute, /listMcpToolReviewHistory/u);
  assert.match(migration, /MCP_TOOL_REVIEW_IMMUTABLE/u);
  assert.match(migration, /MCP_TOOL_REVIEW_CONTEXT_INVALID/u);
  assert.match(migration, /MCP_TOOL_REVIEW_AUDIT_REQUIRED/u);
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/u);
  assert.match(migration, /McpToolReview_evidence_note_check/u);
  assert.match(migration, /McpToolReviewAudit_presence_check/u);
  assert.match(migration, /JOIN "AppUser" AS owner_user[\s\S]*owner_user\."accountAccessVersion" = NEW\."connectionOwnerAccountAccessVersion"/u);
  assert.match(migration, /REVOKE ALL ON TABLE "McpToolReview", "McpToolReviewAudit"/u);
  assert.match(principalCatalog, /"McpToolReview", "McpToolReviewAudit"/u);
  assert.match(principalCatalog, /mcp_tool_review_guard/u);
  assert.match(audit, /mcpToolReviewProjection/u);
  assert.doesNotMatch(audit, /evidenceNote,/u);
  assert.match(mcpState, /attestation\?\.effective === true/u);
});
