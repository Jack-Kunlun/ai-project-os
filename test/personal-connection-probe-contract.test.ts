import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PersonalConnectionProbeError,
  consumePersonalConnectionProbe,
  probeFailureCode,
  runPersonalConnectionProbe,
} from "../src/lib/personal-connection-probe-service";

const ACTOR = { id: "11111111-1111-4111-8111-111111111111", accountAccessVersion: 1 };
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";

function probeInput(overrides: Record<string, unknown> = {}) {
  return {
    kind: "git" as const,
    action: "create" as const,
    connectionId: null,
    clientRequestKey: "33333333-3333-4333-8333-333333333333",
    configuration: { repositoryUrl: "https://example.invalid/repo.git" },
    secret: null,
    ...overrides,
  };
}

function codeOf(error: unknown): string {
  return error instanceof PersonalConnectionProbeError ? error.code : "unexpected";
}

class NoDispatchProbeDb {
  transactions = 0;
  rawQueries = 0;

  async $transaction(): Promise<never> {
    this.transactions += 1;
    throw new Error("database transaction should not start");
  }

  async $executeRaw(): Promise<never> {
    this.rawQueries += 1;
    throw new Error("database mutation should not start");
  }
}

test("invalid personal probe request keys fail before database or external dispatch", async () => {
  const db = new NoDispatchProbeDb();
  let dispatches = 0;
  await assert.rejects(
    () => runPersonalConnectionProbe(
      probeInput({ clientRequestKey: "not-a-uuid" }),
      ACTOR,
      async () => {
        dispatches += 1;
        return { addressFingerprint: null };
      },
      db as never,
    ),
    (error: unknown) => codeOf(error) === "PERSONAL_CONNECTION_PROBE_INVALID_INPUT",
  );
  assert.equal(db.transactions, 0);
  assert.equal(db.rawQueries, 0);
  assert.equal(dispatches, 0);
});

test("invalid probe consumption input fails before transaction and maps safe failure codes", async () => {
  const db = new NoDispatchProbeDb();
  await assert.rejects(
    () => consumePersonalConnectionProbe(
      probeInput({ clientRequestKey: "invalid-key" }),
      ACTOR,
      CONNECTION_ID,
      db as never,
    ),
    (error: unknown) => codeOf(error) === "PERSONAL_CONNECTION_PROBE_INVALID_INPUT",
  );
  assert.equal(db.transactions, 0);
  assert.equal(db.rawQueries, 0);
  assert.equal(probeFailureCode(new PersonalConnectionProbeError("PERSONAL_CONNECTION_PROBE_EXPIRED")), "PERSONAL_CONNECTION_PROBE_EXPIRED");
  assert.equal(probeFailureCode(Object.assign(new Error("provider"), { code: "PROVIDER_UNAVAILABLE" })), "PROVIDER_UNAVAILABLE");
  assert.equal(probeFailureCode(new Error("unclassified")), "PERSONAL_CONNECTION_PROBE_FAILED");
});

test("personal Git/MCP probes bind an owner proof and keep the database guard fail closed", async () => {
  const [schema, migration, guardMigration, createGuardMigration, probeService, gitService, mcpService, gitGovernance, mcpGovernance, gitClient, mcpClient] = await Promise.all([
    readFile("prisma/schema.prisma", "utf8"),
    readFile("prisma/migrations/20260922020000_add_personal_connection_probes/migration.sql", "utf8"),
    readFile("prisma/migrations/20260922040000_bind_personal_probe_guard_table_context/migration.sql", "utf8"),
    readFile("prisma/migrations/20260922041000_bind_personal_probe_create_table_context/migration.sql", "utf8"),
    readFile("src/lib/personal-connection-probe-service.ts", "utf8"),
    readFile("src/lib/git/service.ts", "utf8"),
    readFile("src/lib/mcp/service.ts", "utf8"),
    readFile("src/lib/git/connection-governance.ts", "utf8"),
    readFile("src/lib/mcp/connection-governance.ts", "utf8"),
    readFile("src/app/profile/connections/git/git-connections-client.tsx", "utf8"),
    readFile("src/app/profile/connections/mcp/mcp-connections-client.tsx", "utf8"),
  ]);

  assert.match(schema, /model PersonalConnectionProbeAttempt \{/u);
  assert.match(schema, /PersonalConnectionProbeAction/u);
  assert.match(migration, /CREATE UNIQUE INDEX "PersonalConnectionProbeAttempt_actorId_clientRequestKeyHash_key"/u);
  assert.match(migration, /personal_connection_probe_create_guard/u);
  assert.match(migration, /personal_connection_probe_update_guard/u);
  assert.match(migration, /tested connection update requires consumed probe/u);
  assert.match(migration, /REVOKE ALL ON FUNCTION "personal_connection_probe_update_guard"/u);
  assert.match(guardMigration, /app\.personal_connection_probe_table/u);
  assert.match(guardMigration, /TG_TABLE_NAME/u);
  assert.match(guardMigration, /git_connection_governance_action/u);
  assert.match(guardMigration, /mcp_connection_governance_action/u);
  assert.match(guardMigration, /personal_connection_probe_actor_id[\s\S]*NEW\."ownerUserId"/u);
  assert.match(guardMigration, /personal_connection_probe_connection_id[\s\S]*NEW\."id"/u);
  assert.match(createGuardMigration, /personal_connection_probe_create_guard/u);
  assert.match(createGuardMigration, /expected_kind[\s\S]*TG_TABLE_NAME/u);
  assert.match(createGuardMigration, /personal_connection_probe_actor_id[\s\S]*NEW\."ownerUserId"/u);
  assert.match(createGuardMigration, /personal_connection_probe_connection_id[\s\S]*NEW\."id"/u);
  assert.doesNotMatch(migration, /ciphertext|nonce|authTag|known_hosts|response body/iu);

  assert.match(probeService, /personal-connection-probe:secret:v1/u);
  assert.match(probeService, /createHmac\("sha256", key\)/u);
  assert.doesNotMatch(probeService, /hash\(secret\)/u);
  assert.match(probeService, /consumedConnectionId === consumedConnectionId/u);
  assert.match(probeService, /PERSONAL_CONNECTION_PROBE_CONFIGURATION_CONFLICT/u);
  assert.match(probeService, /consumedAt: null, consumedConnectionId: null/u);
  assert.match(probeService, /input\.action === "update"/u);
  assert.match(probeService, /credential-version:v1/u);
  assert.match(probeService, /app\.personal_connection_probe_table/u);
  assert.match(probeService, /acceptPersonalConnectionProbeDispatchBoundary/u);
  assert.match(probeService, /lockActorAccess\(tx, input\.actor\.id\)/u);
  assert.match(probeService, /assertAccountAccessForActor\(tx, input\.actor\)/u);

  const gitProbe = gitService.slice(gitService.indexOf("export async function probeGitConnectionUpdate"), gitService.indexOf("export async function createGitConnection"));
  assert.match(gitProbe, /action: "update"/u);
  assert.match(gitProbe, /probeRepository\(connection, repositoryPath, trackedRef/u);
  assert.match(gitService.slice(gitService.indexOf("export async function probeGitConnectionDraft"), gitService.indexOf("export async function probeGitConnectionUpdate")), /onDispatchBoundary: \(\) => acceptPersonalConnectionProbeDispatchBoundary/u);
  assert.match(gitService, /\["ls-remote", "--exit-code"/u);

  const mcpProbe = mcpService.slice(mcpService.indexOf("export async function probeMcpConnectionUpdate"), mcpService.indexOf("export async function createMcpConnection"));
  assert.match(mcpProbe, /initializeMcpSession/u);
  assert.match(mcpProbe, /discoverMcpTools/u);
  assert.doesNotMatch(mcpProbe, /callMcpTool/u);
  const mcpDraft = mcpService.slice(mcpService.indexOf("export async function probeMcpConnectionDraft"), mcpService.indexOf("export async function probeMcpConnectionUpdate"));
  assert.match(mcpDraft, /const onDispatchBoundary = \(\) => acceptPersonalConnectionProbeDispatchBoundary/u);
  assert.match(mcpDraft, /dependencies\.initializeSession \?\? initializeMcpSession/u);
  assert.match(mcpDraft, /dependencies\.discoverTools \?\? discoverMcpTools/u);
  assert.match(mcpDraft, /onDispatchBoundary/u);
  assert.match(gitGovernance, /applyGitConnectionProbeUpdate/u);
  assert.match(mcpGovernance, /applyMcpConnectionProbeUpdate/u);
  assert.match(gitClient, /const createInput = buildDraftInput\(testedProbe\.createRequestKey\)/u);
  assert.match(mcpClient, /const createInput = buildDraftInput\(testedProbe\.createRequestKey\)/u);
  assert.match(gitClient, /JSON\.stringify\(\{ \.\.\.createInput, clientRequestKey: undefined/u);
  assert.match(mcpClient, /JSON\.stringify\(\{ \.\.\.createInput, clientRequestKey: undefined/u);
  assert.match(gitClient, /async function testConnection/u);
  assert.match(gitClient, /async function saveConnection/u);
  assert.match(mcpClient, /async function testConnection/u);
  assert.match(mcpClient, /async function saveConnection/u);
  assert.match(gitClient, /HelpTooltip label="Git 连接流程"/u);
  assert.match(mcpClient, /HelpTooltip label="MCP 连接流程"/u);
});
