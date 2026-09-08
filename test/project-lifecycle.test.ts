import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { updateProjectLifecycleSchema } from "../src/lib/validation";

test("project lifecycle input is optimistic and strict", () => {
  const timestamp = "2026-08-29T08:00:00.000Z";
  assert.deepEqual(updateProjectLifecycleSchema.parse({ action: "archive", expectedUpdatedAt: timestamp }), {
    action: "archive",
    expectedUpdatedAt: timestamp,
  });
  assert.deepEqual(updateProjectLifecycleSchema.parse({ action: "restore", expectedUpdatedAt: timestamp }), {
    action: "restore",
    expectedUpdatedAt: timestamp,
  });
  assert.equal(updateProjectLifecycleSchema.safeParse({ action: "archive" }).success, false);
  assert.equal(updateProjectLifecycleSchema.safeParse({ action: "archive", expectedUpdatedAt: timestamp, force: true }).success, false);
});

test("lifecycle and export audit tables are constrained and immutable", async () => {
  const migration = await readFile("prisma/migrations/20260829150000_add_project_lifecycle_and_export_audits/migration.sql", "utf8");
  const deletionMigration = await readFile("prisma/migrations/20260901010000_add_safe_project_deletion/migration.sql", "utf8");
  const jobGuard = await readFile("prisma/migrations/20260829151000_guard_archived_project_jobs/migration.sql", "utf8");
  assert.match(migration, /ProjectLifecycleRevision_immutable_guard/u);
  assert.match(migration, /project lifecycle revision must match current project state/u);
  assert.match(migration, /ProjectDataExportAudit_immutable_guard/u);
  assert.match(migration, /byteCount" > 0/u);
  assert.doesNotMatch(migration, /credential|ciphertext|nonce|authTag|providerRequestId/u);
  assert.match(jobGuard, /BackgroundJob_archived_project_guard/u);
  assert.match(jobGuard, /'queued', 'waitingConsent', 'running'/u);
  assert.match(deletionMigration, /ProjectDeletionReceipt_state_check/u);
  assert.match(deletionMigration, /ProjectDeletionReceipt_guard/u);
  assert.match(deletionMigration, /project deletion receipts are immutable/u);
  assert.doesNotMatch(deletionMigration, /projectName|contentText|storageKey/u);
});

test("project lifecycle blocks live delegated Git manual runs", async () => {
  const source = await readFile("src/lib/project-lifecycle.ts", "utf8");
  assert.match(source, /projectGitRepositoryManualRun\.count/u);
  assert.match(source, /status:\s*\{\s*in:\s*\["queued",\s*"running"\]/u);
  assert.match(source, /PROJECT_HAS_UNRESOLVED_JOBS/u);
});

test("project deletion keeps V2 MCP grant lifecycle evidence durable", async () => {
  const [schema, migration, lifecycle, apiErrors] = await Promise.all([
    readFile("prisma/schema.prisma", "utf8"),
    readFile("prisma/migrations/20260904200000_add_project_mcp_grant_retention_ledger/migration.sql", "utf8"),
    readFile("src/lib/project-lifecycle.ts", "utf8"),
    readFile("src/lib/api-errors.ts", "utf8"),
  ]);
  const ledgerModel = schema.slice(schema.indexOf("model ProjectMcpToolGrantLedger {"), schema.indexOf("model ProjectMcpAction {"));
  const actionLedgerModel = schema.slice(schema.indexOf("model ProjectMcpActionLedger {"), schema.indexOf("// Project MCP access"));
  assert.match(schema, /creationTransactionId\s+BigInt\?/u);
  assert.match(schema, /enum ProjectMcpToolGrantLedgerEvent/u);
  assert.doesNotMatch(ledgerModel, /@relation|REFERENCES/u);
  assert.doesNotMatch(actionLedgerModel, /@relation|REFERENCES/u);
  assert.match(migration, /PROJECT_MCP_GRANT_LEDGER_UPGRADE_PREFLIGHT_FAILED/u);
  assert.match(migration, /ProjectMcpToolGrantLedger_shape_check/u);
  assert.match(migration, /ProjectMcpToolGrantLedger_grantId_grantVersion_key/u);
  assert.match(migration, /project_mcp_tool_grant_create_evidence_guard/u);
  assert.match(migration, /project_mcp_tool_grant_v2_retention_complete/u);
  assert.match(migration, /Project_mcp_grant_project_delete_guard/u);
  assert.match(migration, /PROJECT_MCP_GRANT_RETENTION_REQUIRED/u);
  assert.match(migration, /PROJECT_MCP_TOOL_GRANT_LEDGER_IMMUTABLE/u);
  assert.match(migration, /NEW\."creationTransactionId" := txid_current\(\)/u);
  assert.doesNotMatch(migration, /pg_advisory_xact_lock/u);
  assert.equal((lifecycle.match(/assertProjectMcpGrantRetentionReady\(tx, admission\.project\.id\)/gu) ?? []).length, 3);
  assert.match(lifecycle, /project_mcp_tool_grant_v2_retention_complete/u);
  assert.match(apiErrors, /PROJECT_MCP_GRANT_RETENTION_REQUIRED: \{ status: 409/u);
});

test("delegated Git runtime keeps connection infrastructure out of project projections", async () => {
  const source = await readFile("src/lib/project-delegated-git-runtime-service.ts", "utf8");
  const migration = await readFile("prisma/migrations/20260904160000_add_project_git_manual_runtime/migration.sql", "utf8");
  const projection = source.slice(source.indexOf("function publicRun"), source.indexOf("type AdmissionConnection"));
  assert.doesNotMatch(projection, /baseUrl|username|tlsCaCertificate|sshKnownHost|externalRef/u);
  assert.match(source, /externalRef: null/u);
  const admitRun = source.slice(source.indexOf("async function admitRun"), source.indexOf("async function loadFreshConnection"));
  assert.match(admitRun, /replayExistingRunInTransaction/u);
  assert.doesNotMatch(admitRun, /if \(existing !== null\) return \{ run: existing, claimed: false \}/u);
  assert.match(admitRun, /isPrismaCode\(error, "P2002"\)[\s\S]*replayExistingRun/u);
  const successGuard = migration.slice(
    migration.indexOf('CREATE OR REPLACE FUNCTION "project_git_manual_runtime_success_guard"'),
    migration.indexOf('CREATE CONSTRAINT TRIGGER "ProjectGitRepositoryManualRun_success_guard"'),
  );
  assert.match(successGuard, /pg_advisory_xact_lock\(hashtextextended\('ai-project-git-repository-delegation-global', 0\)\)/u);
});

test("all project mutation routes reject archived projects except bounded lifecycle and export", async () => {
  const root = "src/app/api/projects/[projectId]";
  const entries = await readdir(root, { recursive: true });
  const exempt = new Set([
    "src/app/api/projects/[projectId]/route.ts",
    "src/app/api/projects/[projectId]/lifecycle/route.ts",
    "src/app/api/projects/[projectId]/export/route.ts",
  ]);
  const frozenLegacyRoutes = new Set([
    "src/app/api/projects/[projectId]/repositories/route.ts",
    "src/app/api/projects/[projectId]/repositories/[linkId]/route.ts",
  ]);
  const frozenMcpGrantRoutes = new Set([
    "src/app/api/projects/[projectId]/mcp-tool-grants/[grantId]/route.ts",
  ]);
  const frozenMcpActionRoutes = new Set([
    "src/app/api/projects/[projectId]/mcp-actions/route.ts",
    "src/app/api/projects/[projectId]/mcp-actions/[actionId]/route.ts",
    "src/app/api/projects/[projectId]/mcp-actions/[actionId]/decision/route.ts",
    "src/app/api/projects/[projectId]/mcp-actions/[actionId]/cancel/route.ts",
    "src/app/api/projects/[projectId]/mcp-actions/[actionId]/dispatch/route.ts",
  ]);
  const archivedTerminalCleanupRoutes = new Set([
    "src/app/api/projects/[projectId]/mcp-connection-delegations/[delegationId]/rejection/route.ts",
    "src/app/api/projects/[projectId]/mcp-connection-delegations/[delegationId]/revocation/route.ts",
    "src/app/api/projects/[projectId]/mcp-tool-grants/[grantId]/revocation/route.ts",
  ]);
  const serviceLifecycleGuarded = new Set([
    "src/app/api/projects/[projectId]/items/route.ts",
    "src/app/api/projects/[projectId]/items/[itemId]/route.ts",
    "src/app/api/projects/[projectId]/sources/route.ts",
    "src/app/api/projects/[projectId]/sources/[sourceId]/route.ts",
    "src/app/api/projects/[projectId]/snapshots/route.ts",
    "src/app/api/projects/[projectId]/mcp-tool-grants/route.ts",
    "src/app/api/projects/[projectId]/memory/extract/route.ts",
    "src/app/api/projects/[projectId]/memory/search/route.ts",
    "src/app/api/projects/[projectId]/memory/index/route.ts",
    "src/app/api/projects/[projectId]/memory/answers/route.ts",
    "src/app/api/projects/[projectId]/intelligence/brief/route.ts",
    "src/app/api/projects/[projectId]/intelligence/agent/route.ts",
    "src/app/api/projects/[projectId]/assets/[assetId]/recognize/route.ts",
    "src/app/api/projects/[projectId]/repositories/scan/route.ts",
    "src/app/api/projects/[projectId]/repositories/materials/route.ts",
    "src/app/api/projects/[projectId]/repositories/sync/route.ts",
    "src/app/api/projects/[projectId]/jobs/[jobId]/route.ts",
    "src/app/api/projects/[projectId]/memory/candidates/[candidateId]/route.ts",
    "src/app/api/projects/[projectId]/ai-memory/candidates/[candidateId]/route.ts",
    "src/app/api/projects/[projectId]/git-repositories/route.ts",
    "src/app/api/projects/[projectId]/git-repositories/[linkId]/route.ts",
    "src/app/api/projects/[projectId]/git-repositories/[linkId]/sync/route.ts",
    "src/app/api/projects/[projectId]/ai-provider-delegations/route.ts",
    "src/app/api/projects/[projectId]/ai-provider-delegations/[delegationId]/owner-confirmation/route.ts",
    "src/app/api/projects/[projectId]/ai-provider-delegations/[delegationId]/project-confirmation/route.ts",
    "src/app/api/projects/[projectId]/ai-provider-delegations/[delegationId]/rejection/route.ts",
    "src/app/api/projects/[projectId]/ai-provider-delegations/[delegationId]/revocation/route.ts",
    "src/app/api/projects/[projectId]/mcp-connection-delegations/[delegationId]/owner-confirmation/route.ts",
    "src/app/api/projects/[projectId]/mcp-connection-delegations/[delegationId]/project-confirmation/route.ts",
    "src/app/api/projects/[projectId]/git-repository-delegations/route.ts",
    "src/app/api/projects/[projectId]/git-repository-delegations/[delegationId]/owner-confirmation/route.ts",
    "src/app/api/projects/[projectId]/git-repository-delegations/[delegationId]/project-confirmation/route.ts",
    "src/app/api/projects/[projectId]/git-repository-delegations/[delegationId]/rejection/route.ts",
    "src/app/api/projects/[projectId]/git-repository-delegations/[delegationId]/revocation/route.ts",
    "src/app/api/projects/[projectId]/git-repository-delegations/[delegationId]/manual-sync/route.ts",
    "src/app/api/projects/[projectId]/git-repository-delegations/[delegationId]/manual-runs/[runId]/reconciliation/route.ts",
    "src/app/api/projects/[projectId]/ai-effective-route-selections/[operation]/route.ts",
    "src/app/api/projects/[projectId]/ai-routes/route.ts",
    "src/app/api/projects/[projectId]/automations/route.ts",
    "src/app/api/projects/[projectId]/automations/[ruleId]/route.ts",
    "src/app/api/projects/[projectId]/automations/[ruleId]/run/route.ts",
  ]);
  for (const entry of entries.filter((value) => value.endsWith("route.ts"))) {
    const path = `${root}/${entry}`;
    if (exempt.has(path)) continue;
    const source = await readFile(path, "utf8");
    if (frozenLegacyRoutes.has(path)) {
      assert.match(
        source,
        /GITHUB_WEB_PROJECT_CONNECT_FROZEN/u,
        `${path} must fail closed before legacy project access`,
      );
      assert.doesNotMatch(
        source,
        /assertProjectActive|readJsonBody/u,
        `${path} must not read legacy project state or body`,
      );
      continue;
    }
    if (frozenMcpGrantRoutes.has(path)) {
      assert.doesNotMatch(source, /assertProjectActive/u, `${path} must remain frozen before project lifecycle lookup`);
      assert.match(source, /MCP_LEGACY_PROJECT_RUNTIME_FROZEN/u, `${path} must return the fixed legacy freeze error`);
      assert.doesNotMatch(source, /readJsonBody|revokeProjectMcpToolGrant/u, `${path} must not parse or invoke legacy mutation`);
      continue;
    }
    if (frozenMcpActionRoutes.has(path)) {
      assert.match(source, /projectMcpActionApiUnavailable/u, `${path} must return the fixed product gate`);
      assert.doesNotMatch(source, /requireApiSession|readJsonBody|project-mcp-action-service|project-mcp-action-dispatch-service/u, `${path} must not enter the unopened control plane`);
      continue;
    }
    if (archivedTerminalCleanupRoutes.has(path)) {
      assert.doesNotMatch(source, /assertProjectActive/u, `${path} must remain an archived terminal cleanup route`);
      assert.match(source, /assertSameOrigin\(request\)/u, `${path} must enforce same-origin writes`);
      assert.match(source, /requireApiSession\(request\)/u, `${path} must authenticate the actor`);
      if (path.endsWith("/mcp-tool-grants/[grantId]/revocation/route.ts")) {
        assert.match(source, /revokeProjectMcpToolGrantV2/u, `${path} must call the V2 grant revocation service`);
      } else if (path.endsWith("/rejection/route.ts")) {
        assert.match(source, /rejectProjectMcpConnectionDelegation/u, `${path} must call the rejection service`);
      } else {
        assert.match(source, /revokeProjectMcpConnectionDelegation/u, `${path} must call the revocation service`);
      }
      continue;
    }
    if (!/export async function (POST|PUT|PATCH|DELETE)/u.test(source)) continue;
    if (serviceLifecycleGuarded.has(path)) {
      assert.doesNotMatch(source, /assertProjectActive/u, `${path} delegates lifecycle checks`);
      assert.match(source, /(?:requestedBy|actor):\s*(?:user|sessionUser)|,\s*(?:user|actor)\s*(?:,|\))/u, `${path} passes the session actor`);
      continue;
    }
    assert.match(source, /assertProjectActive/u, `${path} must reject archived project mutations`);
  }

  const lifecycleRoute = await readFile("src/app/api/projects/[projectId]/lifecycle/route.ts", "utf8");
  assert.match(lifecycleRoute, /assertSameOrigin\(request\)/u);
  assert.match(lifecycleRoute, /requireApiSession\(request\)/u);
  assert.match(lifecycleRoute, /expectedUpdatedAt/u);

  const projectRoute = await readFile("src/app/api/projects/[projectId]/route.ts", "utf8");
  assert.match(projectRoute, /export async function DELETE/u);
  assert.match(projectRoute, /deleteArchivedProject/u);
  assert.match(projectRoute, /confirmationName/u);
  assert.match(projectRoute, /expectedUpdatedAt/u);
  assert.match(projectRoute, /withWebAiProjectAccessTransaction/u);
});

test("active workspace reads exclude archived projects while the project list exposes an explicit view", async () => {
  const dashboard = await readFile("src/app/api/dashboard/route.ts", "utf8");
  const projects = await readFile("src/app/api/projects/route.ts", "utf8");
  assert.match(dashboard, /const projectWhere = \{ AND: \[accessibleProjectWhere\(user\), \{ archivedAt: null \}\] \}/u);
  assert.ok((dashboard.match(/project: \{ is: projectWhere \}/gu) ?? []).length >= 2);
  assert.match(projects, /z\.enum\(\["active", "archived"\]\)/u);
  assert.match(projects, /counts: \{ active: activeCount, archived: archivedCount \}/u);
});
