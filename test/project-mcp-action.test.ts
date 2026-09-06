import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mapApiError } from "../src/lib/api-errors";
import { ProjectMcpActionServiceError } from "../src/lib/project-mcp-action-service";

test("project MCP action routes expose an isolated no-store owner control plane", async () => {
  const [collection, detail, decision, cancel, service, migration] = await Promise.all([
    readFile("src/app/api/projects/[projectId]/mcp-actions/route.ts", "utf8"),
    readFile("src/app/api/projects/[projectId]/mcp-actions/[actionId]/route.ts", "utf8"),
    readFile("src/app/api/projects/[projectId]/mcp-actions/[actionId]/decision/route.ts", "utf8"),
    readFile("src/app/api/projects/[projectId]/mcp-actions/[actionId]/cancel/route.ts", "utf8"),
    readFile("src/lib/project-mcp-action-service.ts", "utf8"),
    readFile("prisma/migrations/20260904210000_add_project_mcp_action_approval_control_plane/migration.sql", "utf8"),
  ]);
  assert.match(collection, /listProjectMcpActions/u);
  assert.match(collection, /proposeProjectMcpAction/u);
  assert.match(collection, /assertSameOrigin\(request\)/u);
  assert.match(collection, /cache-control.*no-store/u);
  assert.match(detail, /getProjectMcpAction/u);
  assert.match(decision, /decideProjectMcpAction/u);
  assert.match(cancel, /cancelProjectMcpAction/u);
  assert.match(service, /current direct project Owner|ownerAdmission|role: "owner"/u);
  assert.match(service, /TransactionIsolationLevel\.Serializable/u);
  assert.match(service, /32020002/u);
  assert.match(service, /32020007/u);
  assert.match(service, /canonicalMcpToolArguments/u);
  assert.match(service, /acknowledgeSingleUse: z\.literal\(true\)/u);
  assert.match(service, /expectedActionRevision: HASH/u);
  assert.match(service, /actionRevisionFromFingerprint/u);
  assert.match(service, /32010000/u);
  assert.match(service, /32010002/u);
  assert.match(service, /32010003/u);
  assert.doesNotMatch(service, /fetch\(|http:|https:|McpClient|credential-vault|worker|executeMcpActionSnapshot|buildMcpActionSnapshot/u);
  assert.doesNotMatch(service, /endpointUrl|ciphertext|nonce|authTag|readCredentialSecret/u);
  const projection = service.slice(service.indexOf("function projectAction"), service.indexOf("async function loadAction"));
  assert.match(projection, /actionRevision/u);
  assert.doesNotMatch(projection, /actionFingerprint\s*:/u);
  assert.doesNotMatch(projection, /canonicalArgumentsHash|connectionId|credential|ledger|audit|transactionId|membership/u);
  assert.match(migration, /ProjectMcpActionLedger/u);
  assert.match(migration, /ProjectMcpActionDecision_evidence_guard/u);
  assert.match(migration, /project_mcp_action_source_tuple_valid/u);
  assert.match(migration, /project_mcp_action_snapshot_fingerprint/u);
  assert.match(migration, /PROJECT_MCP_ACTION_EVIDENCE_REQUIRED/u);
  assert.match(migration, /PROJECT_MCP_ACTION_RELATED_EVIDENCE_REQUIRED/u);
  assert.match(migration, /PROJECT_MCP_ACTION_PENDING_ARCHIVE_FORBIDDEN/u);
  assert.match(migration, /INTERVAL '15 minutes'/u);
  const fingerprintFunction = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION "project_mcp_action_snapshot_fingerprint"'), migration.indexOf('CREATE OR REPLACE FUNCTION "project_mcp_action_source_tuple_valid"'));
  assert.doesNotMatch(fingerprintFunction, /lastActor/u);
  assert.match(fingerprintFunction, /project_mcp_action_timestamp_token/u);
  assert.match(migration, /"status" = 'cancelled' AND "stateVersion" = 2/u);
  assert.match(migration, /NEW\."approvedAt" := OLD\."approvedAt"/u);
  assert.match(migration, /NEW\."transitionAt" := action_row\."transitionAt"/u);
  assert.doesNotMatch(migration, /ProjectMcpActionDecision_action_fkey/u);
});

test("project MCP action errors have stable API mappings", () => {
  const mapped = mapApiError(new ProjectMcpActionServiceError("PROJECT_MCP_ACTION_STALE"));
  assert.equal(mapped.status, 409);
  assert.equal(mapped.body.error.code, "PROJECT_MCP_ACTION_STALE");
});
