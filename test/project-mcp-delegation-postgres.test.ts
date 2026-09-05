import "dotenv/config";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import test from "node:test";
import { getDb } from "../src/lib/db";
import { grantProjectMembership, grantWorkspaceMembership, revokeProjectMembership } from "../src/lib/membership-governance";

const shouldRun = process.env.PROJECT_MCP_DELEGATION_POSTGRES_GATE === "1";
const testDatabaseName = "ai_project_os_project_mcp_delegation_test";
const repositoryRoot = process.cwd();
const execFile = promisify(execFileCallback);
const previousMigration = "20260904170000_add_project_git_manual_run_reconciliation";
const projectMcpDelegationMigration = "20260904180000_add_project_mcp_connection_delegations";
const sentinel = createHash("sha256").update("mcp:no-credential:v1").digest("hex");
const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);
const fingerprintC = "c".repeat(64);
const fingerprintD = "d".repeat(64);

async function migrationNamesFromDisk(): Promise<readonly string[]> {
  const entries = await readdir(join(repositoryRoot, "prisma", "migrations"), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function stageMigrations(tempRoot: string, names: readonly string[]): Promise<void> {
  const migrationsRoot = join(tempRoot, "prisma", "migrations");
  await mkdir(migrationsRoot, { recursive: true });
  for (const name of names) {
    await cp(join(repositoryRoot, "prisma", "migrations", name), join(migrationsRoot, name), { recursive: true, force: true });
  }
}

async function deployStagedMigrations(tempRoot: string, databaseUrl: string): Promise<void> {
  await execFile(
    "pnpm",
    ["exec", "prisma", "migrate", "deploy", "--config", join(tempRoot, "prisma.config.ts")],
    {
      cwd: repositoryRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

function assertUpgradeAdminUrl(): string {
  const configuredUrl = process.env.POSTGRES_GATE_ADMIN_URL;
  if (typeof configuredUrl !== "string" || configuredUrl.length === 0) {
    throw new Error("PROJECT_MCP_DELEGATION_UPGRADE_ADMIN_URL_REQUIRED");
  }
  const parsed = new URL(configuredUrl);
  if (!(["postgres:", "postgresql:"].includes(parsed.protocol)
    && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    && parsed.port === "56432"
    && parsed.pathname === "/postgres"
    && parsed.username.length > 0
    && parsed.password.length > 0
    && parsed.search === ""
    && parsed.hash === "")) {
    throw new Error("PROJECT_MCP_DELEGATION_UPGRADE_ADMIN_URL_INVALID");
  }
  return parsed.toString();
}

function upgradeDatabaseName(suffix: string): string {
  const normalized = suffix.replaceAll("-", "");
  if (!/^[0-9a-f]{8,32}$/u.test(normalized)) throw new Error("PROJECT_MCP_DELEGATION_UPGRADE_DATABASE_INVALID");
  return `ai_project_os_mcp_delegation_upgrade_${normalized}_test`;
}

async function prepareStagedMigrationRoot(): Promise<string> {
  const tempRoot = await mkdtemp(join(tmpdir(), "ai-project-os-mcp-delegation-upgrade-migrations-"));
  await mkdir(join(tempRoot, "prisma"), { recursive: true });
  await symlink(join(repositoryRoot, "node_modules"), join(tempRoot, "node_modules"), "dir");
  await cp(join(repositoryRoot, "prisma", "schema.prisma"), join(tempRoot, "prisma", "schema.prisma"));
  await writeFile(join(tempRoot, "prisma.config.ts"), `import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DATABASE_URL") },
});
`, "utf8");
  return tempRoot;
}

type UpgradeCase =
  | "invalid-connection"
  | "invalid-connection-disabled-at"
  | "invalid-connection-missing-credential"
  | "invalid-connection-wrong-credential-kind"
  | "invalid-connection-malformed-credential-fingerprint"
  | "invalid-action"
  | "legacy-active-with-revoked-audit"
  | "compliant";

type UpgradeFixture = {
  client: Client;
  ownerId: string;
  projectId: string;
  connectionId: string | null;
  credentialId: string | null;
  grantId: string | null;
  invalidActionId: string | null;
  terminalActionId: string | null;
};

async function seedUpgradeCase(databaseUrl: string, upgradeCase: UpgradeCase): Promise<UpgradeFixture> {
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  await client.connect();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const ownerId = id();
  const workspaceId = id();
  const projectId = id();
  const invalidConnectionCase = upgradeCase.startsWith("invalid-connection");
  const compliantCase = upgradeCase === "compliant" || upgradeCase === "legacy-active-with-revoked-audit";
  const connectionId = invalidConnectionCase || compliantCase ? id() : null;
  const credentialId = [
    "invalid-connection-missing-credential",
    "invalid-connection-wrong-credential-kind",
    "invalid-connection-malformed-credential-fingerprint",
    "legacy-active-with-revoked-audit",
    "compliant",
  ].includes(upgradeCase) ? id() : null;
  const definitionId = compliantCase ? id() : null;
  const grantId = compliantCase ? id() : null;
  const invalidActionId = upgradeCase === "invalid-action" ? id() : null;
  const terminalActionId = upgradeCase === "invalid-action" ? id() : null;
  const inputFingerprint = fingerprintA;
  const idempotencyKey = fingerprintB;

  try {
    await client.query(
    `INSERT INTO "AppUser" ("id", "username", "role", "updatedAt") VALUES ($1::uuid, $2, 'user', CURRENT_TIMESTAMP)`,
    [ownerId, `mcp_upgrade_owner_${suffix}`],
    );
    await client.query(
    `INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt") VALUES ($1::uuid, $2, $3, $4::uuid, CURRENT_TIMESTAMP)`,
    [workspaceId, `MCP upgrade ${suffix}`, `mcp-upgrade-${suffix}`, ownerId],
    );
    await client.query(
    `INSERT INTO "Project" ("id", "workspaceId", "name", "slug", "updatedAt") VALUES ($1::uuid, $2::uuid, $3, $4, CURRENT_TIMESTAMP)`,
    [projectId, workspaceId, `MCP upgrade project ${suffix}`, `mcp-upgrade-project-${suffix}`],
    );

  if (upgradeCase === "invalid-connection") {
    // This row is accepted by migration 74 but has impossible disabled-state
    // evidence. Migration 75 must reject before any DDL or backfill.
    await client.query(
      `INSERT INTO "McpConnection" ("id", "name", "endpointUrl", "authKind", "allowPrivateNetwork", "resolvedAddressFingerprint", "status", "createdById", "ownerUserId", "ownershipState", "updatedAt") VALUES ($1::uuid, $2, 'https://mcp.example.test/upgrade', 'none', false, $3, 'disabled', $4::uuid, $4::uuid, 'confirmed', CURRENT_TIMESTAMP)`,
      [connectionId, `MCP invalid ${suffix}`, fingerprintB, ownerId],
    );
  }

  if (upgradeCase === "invalid-connection-disabled-at") {
    // The reverse disabled invariant is also accepted by migration 74 but
    // must fail before migration 75 commits any DDL or backfill.
    await client.query(
      `INSERT INTO "McpConnection" ("id", "name", "endpointUrl", "authKind", "allowPrivateNetwork", "resolvedAddressFingerprint", "status", "disabledAt", "createdById", "ownerUserId", "ownershipState", "updatedAt") VALUES ($1::uuid, $2, 'https://mcp.example.test/upgrade', 'none', false, $3, 'verified', CURRENT_TIMESTAMP, $4::uuid, $4::uuid, 'confirmed', CURRENT_TIMESTAMP)`,
      [connectionId, `MCP reverse disabled ${suffix}`, fingerprintB, ownerId],
    );
  }

  if (upgradeCase === "invalid-connection-missing-credential") {
    // Migration 74 permits a bearer connection that points at a missing
    // credential when FK triggers are disabled for the historical fixture.
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(
      `INSERT INTO "McpConnection" ("id", "name", "endpointUrl", "authKind", "credentialId", "allowPrivateNetwork", "resolvedAddressFingerprint", "status", "createdById", "ownerUserId", "ownershipState", "updatedAt") VALUES ($1::uuid, $2, 'https://mcp.example.test/upgrade', 'bearer', $3::uuid, false, $4, 'verified', $5::uuid, $5::uuid, 'confirmed', CURRENT_TIMESTAMP)`,
      [connectionId, `MCP missing credential ${suffix}`, credentialId, fingerprintB, ownerId],
    );
    await client.query("COMMIT");
  }

  if (upgradeCase === "invalid-connection-wrong-credential-kind" || upgradeCase === "invalid-connection-malformed-credential-fingerprint") {
    await client.query(
      `INSERT INTO "ExternalCredential" ("id", "kind", "ciphertext", "nonce", "authTag", "maskedSuffix", "secretFingerprint", "updatedAt") VALUES ($1::uuid, $2::"ExternalCredentialKind", decode('01', 'hex'), decode('02', 'hex'), decode('03', 'hex'), 'gate', $3, CURRENT_TIMESTAMP)`,
      [credentialId, upgradeCase === "invalid-connection-wrong-credential-kind" ? "git" : "mcp", upgradeCase === "invalid-connection-wrong-credential-kind" ? fingerprintA : "malformed-fingerprint"],
    );
    await client.query(
      `INSERT INTO "McpConnection" ("id", "name", "endpointUrl", "authKind", "credentialId", "allowPrivateNetwork", "resolvedAddressFingerprint", "status", "createdById", "ownerUserId", "ownershipState", "updatedAt") VALUES ($1::uuid, $2, 'https://mcp.example.test/upgrade', 'bearer', $3::uuid, false, $4, 'verified', $5::uuid, $5::uuid, 'confirmed', CURRENT_TIMESTAMP)`,
      [connectionId, `MCP invalid credential ${suffix}`, credentialId, fingerprintB, ownerId],
    );
  }

  if (upgradeCase === "invalid-action") {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(
      `INSERT INTO "ProjectAction" ("id", "projectId", "capability", "riskLevel", "status", "input", "inputFingerprint", "policyModeSnapshot", "idempotencyKey", "requestedById", "approvalExpiresAt", "completedAt", "updatedAt") VALUES ($1::uuid, $2::uuid, 'project.mcp.read-tool.invoke', 'high', 'waiting_approval', '{}'::jsonb, $3, 'approval_required', $4, $5::uuid, CURRENT_TIMESTAMP + interval '1 hour', NULL, CURRENT_TIMESTAMP), ($6::uuid, $2::uuid, 'project.mcp.read-tool.invoke', 'high', 'succeeded', '{}'::jsonb, $3, 'approval_required', $7, $5::uuid, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [invalidActionId, projectId, inputFingerprint, idempotencyKey, ownerId, terminalActionId, fingerprintC],
    );
    await client.query("COMMIT");
  }

  if (compliantCase) {
    await client.query(
      `INSERT INTO "ExternalCredential" ("id", "kind", "ciphertext", "nonce", "authTag", "maskedSuffix", "secretFingerprint", "updatedAt") VALUES ($1::uuid, 'mcp', decode('01', 'hex'), decode('02', 'hex'), decode('03', 'hex'), 'gate', $2, CURRENT_TIMESTAMP)`,
      [credentialId, fingerprintA],
    );
    await client.query(
      `INSERT INTO "McpConnection" ("id", "name", "endpointUrl", "authKind", "credentialId", "allowPrivateNetwork", "resolvedAddressFingerprint", "status", "createdById", "ownerUserId", "ownershipState", "updatedAt") VALUES ($1::uuid, $2, 'https://mcp.example.test/upgrade', 'bearer', $3::uuid, false, $4, 'verified', $5::uuid, $5::uuid, 'confirmed', CURRENT_TIMESTAMP)`,
      [connectionId, `MCP compliant ${suffix}`, credentialId, fingerprintB, ownerId],
    );
    await client.query(
      `INSERT INTO "McpToolDefinition" ("id", "connectionId", "name", "inputSchema", "readOnlyEligible", "definitionFingerprint", "discoveredAt") VALUES ($1::uuid, $2::uuid, 'upgrade.lookup', '{}'::jsonb, true, $3, CURRENT_TIMESTAMP)`,
      [definitionId, connectionId, fingerprintD],
    );
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(
      `INSERT INTO "ProjectMcpToolGrant" ("id", "projectId", "connectionId", "toolName", "toolDefinitionId", "status", "managedById", "acknowledgedAt", "updatedAt") VALUES ($1::uuid, $2::uuid, $3::uuid, 'upgrade.lookup', $4::uuid, 'active', $5::uuid, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [grantId, projectId, connectionId, definitionId, ownerId],
    );
    await client.query("COMMIT");

    if (upgradeCase === "legacy-active-with-revoked-audit") {
      // Migration 74 allowed revoke -> refresh, so a legacy active grant can
      // legitimately retain an older revoked audit before migration 75. The
      // fixture uses the isolated replica path to model that historical row
      // shape without manufacturing a current admin attestation.
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await client.query(
        `UPDATE "ProjectMcpToolGrant" SET "status" = 'revoked', "revokedAt" = CURRENT_TIMESTAMP WHERE "id" = $1::uuid`,
        [grantId],
      );
      await client.query(
        `INSERT INTO "ProjectMcpToolGrantAudit" ("id", "projectId", "grantId", "event", "actorId", "definitionFingerprint", "details", "createdAt") VALUES ($1::uuid, $2::uuid, $3::uuid, 'revoked', $4::uuid, $5, '{}'::jsonb, CURRENT_TIMESTAMP - interval '1 second')`,
        [id(), projectId, grantId, ownerId, fingerprintD],
      );
      await client.query(
        `UPDATE "ProjectMcpToolGrant" SET "status" = 'active', "revokedAt" = NULL WHERE "id" = $1::uuid`,
        [grantId],
      );
      await client.query(
        `INSERT INTO "ProjectMcpToolGrantAudit" ("id", "projectId", "grantId", "event", "actorId", "definitionFingerprint", "details", "createdAt") VALUES ($1::uuid, $2::uuid, $3::uuid, 'refreshed', $4::uuid, $5, '{}'::jsonb, CURRENT_TIMESTAMP)`,
        [id(), projectId, grantId, ownerId, fingerprintD],
      );
      await client.query("COMMIT");
    }
  }

    return { client, ownerId, projectId, connectionId, credentialId, grantId, invalidActionId, terminalActionId };
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}

function assertDisposableGateDatabase(): void {
  const configuredUrl = process.env.DATABASE_URL;
  if (typeof configuredUrl !== "string" || configuredUrl.length === 0) throw new Error("PROJECT_MCP_DELEGATION_TEST_DATABASE_URL_REQUIRED");
  const parsed = new URL(configuredUrl);
  if (!(["postgres:", "postgresql:"].includes(parsed.protocol)
    && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    && parsed.port === "56432"
    && parsed.pathname === `/${testDatabaseName}`
    && parsed.username === "ai_project_os_gate"
    && parsed.password.length > 0
    && parsed.search === ""
    && parsed.hash === "")) {
    throw new Error("PROJECT_MCP_DELEGATION_TEST_DATABASE_URL_INVALID");
  }
}

function id(): string {
  return randomUUID();
}

function sqlTimestamp(date: Date): string {
  return date.toISOString();
}

async function insertDelegationAudit(client: Client, delegation: Record<string, unknown>, action: string, reason: string, actorId: string | null, actorMembershipId: string | null, actorMembershipCreatedAt: Date | null): Promise<void> {
  await client.query(
    `INSERT INTO "ProjectMcpConnectionDelegationAudit" (
       "id", "projectId", "mcpConnectionId", "delegationId", "connectionOwnerId", "action",
       "delegationVersion", "statusBefore", "statusAfter", "actorKind", "actorId",
       "actorProjectMembershipId", "actorMembershipCreatedAt", "terminalActorKind", "terminalActorId",
       "terminalActorProjectMembershipId", "terminalActorMembershipCreatedAt", "terminalReason",
       "ownerProjectMembershipId", "ownerMembershipCreatedAt", "projectConfirmedProjectMembershipId",
       "projectConfirmedMembershipCreatedAt", "expiresAt", "connectionConfigurationRevision",
       "resolvedAddressFingerprint", "credentialFingerprint", "delegationFingerprint", "reason", "transitionAt"
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::"ProjectMcpConnectionDelegationAuditAction",
       $7, $8::"ProjectMcpConnectionDelegationStatus", $9::"ProjectMcpConnectionDelegationStatus",
       $10::"ProjectMcpConnectionDelegationActorKind", $11::uuid, $12::uuid, $13::timestamp,
       $14::"ProjectMcpConnectionDelegationActorKind", $15::uuid, $16::uuid, $17::timestamp, $18,
       $19::uuid, $20::timestamp, $21::uuid, $22::timestamp, $23::timestamp, $24,
       $25, $26, $27, $28, $29::timestamp)`,
    [
      id(), delegation.projectId, delegation.mcpConnectionId, delegation.id, delegation.connectionOwnerId,
      action, delegation.version, delegation.statusBefore ?? null, delegation.status, action === "expired" ? "system_expiry" : "user",
      actorId, actorMembershipId, actorMembershipCreatedAt === null ? null : sqlTimestamp(actorMembershipCreatedAt),
      delegation.terminalActorKind ?? null, delegation.terminalActorId ?? null, delegation.terminalActorProjectMembershipId ?? null,
      delegation.terminalActorMembershipCreatedAt ?? null, delegation.terminalReason ?? null, delegation.ownerProjectMembershipId,
      delegation.ownerMembershipCreatedAt, delegation.projectConfirmedProjectMembershipId ?? null,
      delegation.projectConfirmedMembershipCreatedAt ?? null, delegation.expiresAt, delegation.connectionConfigurationRevision,
      delegation.resolvedAddressFingerprint, delegation.credentialFingerprint, delegation.delegationFingerprint, reason,
      delegation.transitionAt ?? delegation.proposedAt,
    ],
  );
}

test("MCP Package A PostgreSQL control plane enforces ownership, epochs, fingerprints and legacy freezes", { skip: !shouldRun ? "PROJECT_MCP_DELEGATION_POSTGRES_GATE=1 is required" : false }, async (context) => {
  assertDisposableGateDatabase();
  const databaseUrl = process.env.DATABASE_URL!;
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  await client.connect();
  context.after(() => client.end());

  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const ownerId = id();
  const projectOwnerId = id();
  const workspaceId = id();
  const projectId = id();
  let ownerMembershipId: string;
  let projectOwnerMembershipId: string;
  const credentialId = id();
  const connectionId = id();
  const noCredentialConnectionId = id();
  const delegationId = id();
  const rejectedDelegationId = id();
  const definitionId = id();
  const grantId = id();
  const actionId = id();
  const createdAt = new Date();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1_000);

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO "AppUser" ("id", "username", "role", "updatedAt") VALUES ($1::uuid, $2, 'user', CURRENT_TIMESTAMP), ($3::uuid, $4, 'user', CURRENT_TIMESTAMP)`,
      [ownerId, `mcp_owner_${suffix}`, projectOwnerId, `mcp_project_owner_${suffix}`],
    );
    await client.query(
      `INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt") VALUES ($1::uuid, $2, $3, $4::uuid, CURRENT_TIMESTAMP)`,
      [workspaceId, `MCP ${suffix}`, `mcp-${suffix}`, ownerId],
    );
    await client.query(
      `INSERT INTO "Project" ("id", "workspaceId", "name", "slug", "updatedAt") VALUES ($1::uuid, $2::uuid, $3, $4, CURRENT_TIMESTAMP)`,
      [projectId, workspaceId, `MCP project ${suffix}`, `mcp-project-${suffix}`],
    );
    await client.query(
      `INSERT INTO "ExternalCredential" ("id", "kind", "ciphertext", "nonce", "authTag", "maskedSuffix", "secretFingerprint", "updatedAt") VALUES ($1::uuid, 'mcp', decode('01', 'hex'), decode('02', 'hex'), decode('03', 'hex'), 'gate', $2, CURRENT_TIMESTAMP)`,
      [credentialId, fingerprintA],
    );
    await client.query(
      `INSERT INTO "McpConnection" ("id", "name", "endpointUrl", "authKind", "credentialId", "allowPrivateNetwork", "resolvedAddressFingerprint", "status", "createdById", "ownerUserId", "ownershipState", "updatedAt") VALUES ($1::uuid, $2, 'https://mcp.example.test/mcp', 'bearer', $3::uuid, false, $4, 'verified', $5::uuid, $5::uuid, 'confirmed', CURRENT_TIMESTAMP)`,
      [connectionId, `MCP ${suffix}`, credentialId, fingerprintB, ownerId],
    );
    await client.query(
      `INSERT INTO "McpConnection" ("id", "name", "endpointUrl", "authKind", "allowPrivateNetwork", "resolvedAddressFingerprint", "status", "createdById", "ownerUserId", "ownershipState", "updatedAt") VALUES ($1::uuid, $2, 'https://mcp.example.test/no-auth', 'none', false, $3, 'configured', $4::uuid, $4::uuid, 'confirmed', CURRENT_TIMESTAMP)`,
      [noCredentialConnectionId, `MCP none ${suffix}`, fingerprintB, ownerId],
    );
    await client.query("COMMIT");

    const db = getDb();
    const memberships = await db.$transaction(async (tx) => {
      await grantWorkspaceMembership(tx, { workspaceId, userId: ownerId, role: "owner", actorId: ownerId, reason: "mcp delegation fixture owner" });
      const owner = await grantProjectMembership(tx, { projectId, workspaceId, userId: ownerId, role: "owner", actorId: ownerId, reason: "mcp delegation fixture owner" });
      const projectOwner = await grantProjectMembership(tx, { projectId, workspaceId, userId: projectOwnerId, role: "owner", actorId: ownerId, reason: "mcp delegation fixture project owner" });
      return { owner, projectOwner };
    });
    ownerMembershipId = memberships.owner.id;
    projectOwnerMembershipId = memberships.projectOwner.id;
    const ownerMembership = { rows: [{ createdAt: memberships.owner.createdAt }] };
    const projectOwnerMembership = { rows: [{ createdAt: memberships.projectOwner.createdAt }] };

    const connection = await client.query<{ credentialFingerprint: string; configurationRevision: number }>(
      `SELECT "credentialFingerprint", "configurationRevision" FROM "McpConnection" WHERE "id" = $1::uuid`, [connectionId],
    );
    assert.deepEqual(connection.rows[0], { credentialFingerprint: fingerprintA, configurationRevision: 1 });
    const noCredential = await client.query<{ credentialFingerprint: string }>(
      `SELECT "credentialFingerprint" FROM "McpConnection" WHERE "id" = $1::uuid`, [noCredentialConnectionId],
    );
    assert.equal(noCredential.rows[0]?.credentialFingerprint, sentinel);

    await client.query(`UPDATE "McpConnection" SET "name" = $2 WHERE "id" = $1::uuid`, [connectionId, `MCP renamed ${suffix}`]);
    assert.equal((await client.query<{ configurationRevision: number }>(`SELECT "configurationRevision" FROM "McpConnection" WHERE "id" = $1::uuid`, [connectionId])).rows[0]?.configurationRevision, 1);
    await client.query(`UPDATE "McpConnection" SET "protocolVersion" = '2026-07-28' WHERE "id" = $1::uuid`, [connectionId]);
    assert.equal((await client.query<{ configurationRevision: number }>(`SELECT "configurationRevision" FROM "McpConnection" WHERE "id" = $1::uuid`, [connectionId])).rows[0]?.configurationRevision, 2);
    await client.query(`UPDATE "McpConnection" SET "status" = 'disabled', "disabledAt" = CURRENT_TIMESTAMP WHERE "id" = $1::uuid`, [connectionId]);
    assert.equal((await client.query<{ configurationRevision: number }>(`SELECT "configurationRevision" FROM "McpConnection" WHERE "id" = $1::uuid`, [connectionId])).rows[0]?.configurationRevision, 3);
    await client.query(`UPDATE "McpConnection" SET "status" = 'verified', "disabledAt" = NULL WHERE "id" = $1::uuid`, [connectionId]);
    assert.equal((await client.query<{ configurationRevision: number }>(`SELECT "configurationRevision" FROM "McpConnection" WHERE "id" = $1::uuid`, [connectionId])).rows[0]?.configurationRevision, 4);
    await client.query(`UPDATE "McpConnection" SET "catalogFingerprint" = $2 WHERE "id" = $1::uuid`, [connectionId, fingerprintD]);
    assert.equal((await client.query<{ configurationRevision: number }>(`SELECT "configurationRevision" FROM "McpConnection" WHERE "id" = $1::uuid`, [connectionId])).rows[0]?.configurationRevision, 4);
    await client.query(`UPDATE "McpConnection" SET "lastErrorCode" = 'MCP_HEALTH_DEGRADED' WHERE "id" = $1::uuid`, [connectionId]);
    assert.equal((await client.query<{ configurationRevision: number }>(`SELECT "configurationRevision" FROM "McpConnection" WHERE "id" = $1::uuid`, [connectionId])).rows[0]?.configurationRevision, 4);
    await client.query(`UPDATE "McpConnection" SET "status" = 'error' WHERE "id" = $1::uuid`, [connectionId]);
    assert.equal((await client.query<{ configurationRevision: number }>(`SELECT "configurationRevision" FROM "McpConnection" WHERE "id" = $1::uuid`, [connectionId])).rows[0]?.configurationRevision, 4);
    await client.query(`UPDATE "McpConnection" SET "status" = 'configured' WHERE "id" = $1::uuid`, [connectionId]);
    assert.equal((await client.query<{ configurationRevision: number }>(`SELECT "configurationRevision" FROM "McpConnection" WHERE "id" = $1::uuid`, [connectionId])).rows[0]?.configurationRevision, 4);
    await client.query(`UPDATE "McpConnection" SET "status" = 'verified', "lastErrorCode" = NULL WHERE "id" = $1::uuid`, [connectionId]);
    assert.equal((await client.query<{ configurationRevision: number }>(`SELECT "configurationRevision" FROM "McpConnection" WHERE "id" = $1::uuid`, [connectionId])).rows[0]?.configurationRevision, 4);
    await assert.rejects(
      () => client.query(`UPDATE "McpConnection" SET "status" = 'disabled', "disabledAt" = NULL WHERE "id" = $1::uuid`, [connectionId]),
      /McpConnection_disabled_state_check/u,
    );
    await assert.rejects(
      () => client.query(`UPDATE "McpConnection" SET "status" = 'verified', "disabledAt" = CURRENT_TIMESTAMP WHERE "id" = $1::uuid`, [connectionId]),
      /McpConnection_disabled_state_check/u,
    );
    const invariantState = await client.query<{ status: string; disabledAt: Date | null; configurationRevision: number }>(
      `SELECT "status", "disabledAt", "configurationRevision" FROM "McpConnection" WHERE "id" = $1::uuid`, [connectionId],
    );
    assert.equal(invariantState.rows[0]?.status, "verified");
    assert.equal(invariantState.rows[0]?.disabledAt, null);
    assert.equal(invariantState.rows[0]?.configurationRevision, 4);

    await assert.rejects(
      () => client.query(`UPDATE "ExternalCredential" SET "secretFingerprint" = $2 WHERE "id" = $1::uuid`, [credentialId, fingerprintB]),
      /MCP_CONNECTION_CREDENTIAL_MIRROR_INVALID/u,
    );
    await assert.rejects(
      () => client.query(`DELETE FROM "ExternalCredential" WHERE "id" = $1::uuid`, [credentialId]),
      /MCP_CONNECTION_CREDENTIAL_MIRROR_INVALID/u,
    );
    await client.query("BEGIN");
    await client.query(`UPDATE "ExternalCredential" SET "secretFingerprint" = $2 WHERE "id" = $1::uuid`, [credentialId, fingerprintC]);
    await client.query(`UPDATE "McpConnection" SET "endpointUrl" = 'https://mcp.example.test/v2' WHERE "id" = $1::uuid`, [connectionId]);
    await client.query("COMMIT");
    const rotated = await client.query<{ credentialFingerprint: string; configurationRevision: number }>(
      `SELECT "credentialFingerprint", "configurationRevision" FROM "McpConnection" WHERE "id" = $1::uuid`, [connectionId],
    );
    assert.deepEqual(rotated.rows[0], { credentialFingerprint: fingerprintC, configurationRevision: 5 });

    const baseDelegation = {
      id: delegationId,
      projectId,
      mcpConnectionId: connectionId,
      connectionOwnerId: ownerId,
      connectionConfigurationRevision: 5,
      resolvedAddressFingerprint: fingerprintB,
      credentialFingerprint: fingerprintC,
      delegationFingerprint: fingerprintD,
      expiresAt,
      ownerProjectMembershipId: ownerMembershipId,
      ownerMembershipCreatedAt: ownerMembership.rows[0]!.createdAt,
      projectConfirmedProjectMembershipId: null,
      projectConfirmedMembershipCreatedAt: null,
      status: "draft",
      version: 1,
      proposedAt: createdAt,
      transitionAt: createdAt,
      terminalActorKind: null,
      terminalActorId: null,
      terminalActorProjectMembershipId: null,
      terminalActorMembershipCreatedAt: null,
      terminalReason: null,
      statusBefore: null,
    } as Record<string, unknown>;
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO "ProjectMcpConnectionDelegation" ("id", "projectId", "mcpConnectionId", "connectionOwnerId", "connectionConfigurationRevision", "resolvedAddressFingerprint", "credentialFingerprint", "delegationFingerprint", "expiresAt", "ownerProjectMembershipId", "ownerMembershipCreatedAt", "proposedById", "updatedAt") VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9::timestamp, $10::uuid, $11::timestamp, $4::uuid, CURRENT_TIMESTAMP)`,
      [delegationId, projectId, connectionId, ownerId, 5, fingerprintB, fingerprintC, fingerprintD, sqlTimestamp(expiresAt), ownerMembershipId, sqlTimestamp(ownerMembership.rows[0]!.createdAt)],
    );
    const draft = (await client.query(`SELECT * FROM "ProjectMcpConnectionDelegation" WHERE "id" = $1::uuid`, [delegationId])).rows[0] as Record<string, unknown>;
    Object.assign(baseDelegation, draft, { statusBefore: null, transitionAt: draft.proposedAt });
    await insertDelegationAudit(client, baseDelegation, "proposed", "owner proposed MCP delegation", ownerId, ownerMembershipId, ownerMembership.rows[0]!.createdAt);
    await client.query("COMMIT");

    await client.query("BEGIN");
    await client.query(`UPDATE "ProjectMcpConnectionDelegation" SET "status" = 'owner_confirmed', "version" = 2, "ownerConfirmedById" = $2::uuid WHERE "id" = $1::uuid`, [delegationId, ownerId]);
    const ownerConfirmed = (await client.query(`SELECT * FROM "ProjectMcpConnectionDelegation" WHERE "id" = $1::uuid`, [delegationId])).rows[0] as Record<string, unknown>;
    Object.assign(ownerConfirmed, { statusBefore: "draft" });
    await insertDelegationAudit(client, ownerConfirmed, "owner_confirmed", "connection owner confirmed", ownerId, ownerMembershipId, ownerMembership.rows[0]!.createdAt);
    await client.query("COMMIT");

    await client.query("BEGIN");
    await client.query(`UPDATE "ProjectMcpConnectionDelegation" SET "status" = 'active', "version" = 3, "projectConfirmedById" = $2::uuid, "projectConfirmedProjectMembershipId" = $3::uuid, "projectConfirmedMembershipCreatedAt" = $4::timestamp WHERE "id" = $1::uuid`, [delegationId, projectOwnerId, projectOwnerMembershipId, sqlTimestamp(projectOwnerMembership.rows[0]!.createdAt)]);
    const active = (await client.query(`SELECT * FROM "ProjectMcpConnectionDelegation" WHERE "id" = $1::uuid`, [delegationId])).rows[0] as Record<string, unknown>;
    Object.assign(active, { statusBefore: "owner_confirmed" });
    await insertDelegationAudit(client, active, "activated", "project owner confirmed MCP delegation", projectOwnerId, projectOwnerMembershipId, projectOwnerMembership.rows[0]!.createdAt);
    await client.query("COMMIT");

    await client.query("BEGIN");
    await client.query(`UPDATE "ProjectMcpConnectionDelegation" SET "status" = 'revoked', "version" = 4, "terminalActorId" = $2::uuid, "terminalActorProjectMembershipId" = $3::uuid, "terminalActorMembershipCreatedAt" = $4::timestamp, "terminalReason" = 'manual safety revoke' WHERE "id" = $1::uuid`, [delegationId, projectOwnerId, projectOwnerMembershipId, sqlTimestamp(projectOwnerMembership.rows[0]!.createdAt)]);
    const revoked = (await client.query(`SELECT * FROM "ProjectMcpConnectionDelegation" WHERE "id" = $1::uuid`, [delegationId])).rows[0] as Record<string, unknown>;
    Object.assign(revoked, { statusBefore: "active" });
    await insertDelegationAudit(client, revoked, "revoked", "manual safety revoke", projectOwnerId, projectOwnerMembershipId, projectOwnerMembership.rows[0]!.createdAt);
    await client.query("COMMIT");
    assert.equal((await client.query(`SELECT COUNT(*)::int AS count FROM "ProjectMcpConnectionDelegationAudit" WHERE "delegationId" = $1::uuid`, [delegationId])).rows[0]?.count, 4);
    await assert.rejects(
      () => client.query(`UPDATE "ProjectMcpConnectionDelegation" SET "status" = 'active', "version" = 5 WHERE "id" = $1::uuid`, [delegationId]),
      /PROJECT_MCP_CONNECTION_DELEGATION_STATE_INVALID/u,
    );
    await assert.rejects(
      () => client.query(`DELETE FROM "ProjectMcpConnectionDelegationAudit" WHERE "delegationId" = $1::uuid`, [delegationId]),
      /PROJECT_MCP_CONNECTION_DELEGATION_AUDIT_IMMUTABLE/u,
    );

    await client.query(`INSERT INTO "McpToolDefinition" ("id", "connectionId", "name", "inputSchema", "readOnlyEligible", "definitionFingerprint", "discoveredAt") VALUES ($1::uuid, $2::uuid, 'project.lookup', '{}'::jsonb, true, $3, CURRENT_TIMESTAMP)`, [definitionId, connectionId, fingerprintD]);
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(`INSERT INTO "ProjectMcpToolGrant" ("id", "projectId", "connectionId", "toolName", "toolDefinitionId", "status", "managedById", "acknowledgedAt", "updatedAt") VALUES ($1::uuid, $2::uuid, $3::uuid, 'project.lookup', $4::uuid, 'active', $5::uuid, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [grantId, projectId, connectionId, definitionId, ownerId]);
    await client.query("COMMIT");
    await assert.rejects(
      () => client.query(`INSERT INTO "ProjectMcpToolGrant" ("id", "projectId", "connectionId", "toolName", "toolDefinitionId", "status", "managedById", "acknowledgedAt", "updatedAt") VALUES ($1::uuid, $2::uuid, $3::uuid, 'project.lookup', $4::uuid, 'active', $5::uuid, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [id(), projectId, connectionId, definitionId, ownerId]),
      /PROJECT_MCP_TOOL_GRANT_INSERT_FROZEN/u,
    );
    await assert.rejects(
      () => client.query(`UPDATE "ProjectMcpToolGrant" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1::uuid`, [grantId]),
      /PROJECT_MCP_TOOL_GRANT_ACTIVE_MUTATION_FORBIDDEN/u,
    );
    await assert.rejects(
      () => client.query(
        `INSERT INTO "ProjectMcpToolGrantAudit" ("id", "projectId", "grantId", "event", "actorId", "definitionFingerprint", "details") VALUES ($1::uuid, $2::uuid, $3::uuid, 'revoked', $4::uuid, $5, '{}'::jsonb)`,
        [id(), projectId, grantId, ownerId, fingerprintD],
      ),
      /PROJECT_MCP_TOOL_GRANT_REVOKE_AUDIT_STATE_INVALID/u,
    );
    await client.query("BEGIN");
    await client.query(`UPDATE "ProjectMcpToolGrant" SET "status" = 'revoked', "revokedAt" = CURRENT_TIMESTAMP WHERE "id" = $1::uuid`, [grantId]);
    await assert.rejects(
      () => client.query("COMMIT"),
      /PROJECT_MCP_TOOL_GRANT_REVOKE_AUDIT_REQUIRED/u,
    );
    await client.query("ROLLBACK").catch(() => undefined);
    assert.equal((await client.query<{ status: string }>(`SELECT "status" FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`, [grantId])).rows[0]?.status, "active");

    await client.query("BEGIN");
    await client.query(`UPDATE "ProjectMcpToolGrant" SET "status" = 'revoked', "managedById" = $2::uuid, "revokedAt" = CURRENT_TIMESTAMP WHERE "id" = $1::uuid`, [grantId, projectOwnerId]);
    await assert.rejects(
      () => client.query(
        `INSERT INTO "ProjectMcpToolGrantAudit" ("id", "projectId", "grantId", "event", "actorId", "definitionFingerprint", "details") VALUES ($1::uuid, $2::uuid, $3::uuid, 'revoked', $4::uuid, $5, '{}'::jsonb)`,
        [id(), projectId, grantId, ownerId, fingerprintD],
      ),
      /PROJECT_MCP_TOOL_GRANT_REVOKE_AUDIT_ACTOR_INVALID/u,
    );
    await client.query("ROLLBACK").catch(() => undefined);

    await client.query("BEGIN");
    await client.query(`UPDATE "ProjectMcpToolGrant" SET "status" = 'revoked', "revokedAt" = CURRENT_TIMESTAMP WHERE "id" = $1::uuid`, [grantId]);
    await assert.rejects(
      () => client.query(
        `INSERT INTO "ProjectMcpToolGrantAudit" ("id", "projectId", "grantId", "event", "actorId", "definitionFingerprint", "details") VALUES ($1::uuid, $2::uuid, $3::uuid, 'revoked', $4::uuid, $5, '{}'::jsonb)`,
        [id(), projectId, grantId, ownerId, fingerprintA],
      ),
      /project MCP tool grant audit must match current grant/u,
    );
    await client.query("ROLLBACK").catch(() => undefined);

    await client.query("BEGIN");
    await client.query(`UPDATE "ProjectMcpToolGrant" SET "status" = 'revoked', "revokedAt" = CURRENT_TIMESTAMP WHERE "id" = $1::uuid`, [grantId]);
    await client.query(
      `INSERT INTO "ProjectMcpToolGrantAudit" ("id", "projectId", "grantId", "event", "actorId", "definitionFingerprint", "details") VALUES ($1::uuid, $2::uuid, $3::uuid, 'revoked', $4::uuid, $5, '{}'::jsonb)`,
      [id(), projectId, grantId, ownerId, fingerprintD],
    );
    await client.query("COMMIT");
    const grantAudit = await client.query<{ transactionId: string | null; actorId: string; definitionFingerprint: string }>(
      `SELECT "transactionId", "actorId", "definitionFingerprint" FROM "ProjectMcpToolGrantAudit" WHERE "projectId" = $1::uuid AND "grantId" = $2::uuid AND "event" = 'revoked'`,
      [projectId, grantId],
    );
    assert.equal(grantAudit.rows.length, 1);
    assert.notEqual(grantAudit.rows[0]?.transactionId, null);
    assert.equal(grantAudit.rows[0]?.actorId, ownerId);
    assert.equal(grantAudit.rows[0]?.definitionFingerprint, fingerprintD);
    await assert.rejects(
      () => client.query(
        `INSERT INTO "ProjectMcpToolGrantAudit" ("id", "projectId", "grantId", "event", "actorId", "definitionFingerprint", "details") VALUES ($1::uuid, $2::uuid, $3::uuid, 'revoked', $4::uuid, $5, '{}'::jsonb)`,
        [id(), projectId, grantId, ownerId, fingerprintD],
      ),
      /PROJECT_MCP_TOOL_GRANT_REVOKE_AUDIT_STATE_INVALID/u,
    );
    await assert.rejects(
      () => client.query(`UPDATE "ProjectMcpToolGrant" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1::uuid`, [grantId]),
      /PROJECT_MCP_TOOL_GRANT_REVOKED_IMMUTABLE/u,
    );
    await assert.rejects(
      () => client.query(`DELETE FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`, [grantId]),
      /PROJECT_MCP_TOOL_GRANT_DELETE_FORBIDDEN/u,
    );
    await assert.rejects(
      () => client.query(`UPDATE "ProjectMcpToolGrant" SET "status" = 'active', "revokedAt" = NULL WHERE "id" = $1::uuid`, [grantId]),
      /PROJECT_MCP_TOOL_GRANT_REVOKED_IMMUTABLE/u,
    );

    await assert.rejects(
      () => client.query(`INSERT INTO "ProjectAction" ("id", "projectId", "capability", "riskLevel", "status", "input", "inputFingerprint", "policyModeSnapshot", "idempotencyKey", "requestedById", "approvalExpiresAt", "updatedAt") VALUES ($1::uuid, $2::uuid, 'project.mcp.read-tool.invoke', 'high', 'waiting_approval', '{}'::jsonb, $3, 'approval_required', $4, $5::uuid, CURRENT_TIMESTAMP + interval '1 hour', CURRENT_TIMESTAMP)`, [actionId, projectId, fingerprintA, fingerprintB, ownerId]),
      /PROJECT_MCP_ACTION_INSERT_FROZEN/u,
    );
    await client.query(`INSERT INTO "ProjectAction" ("id", "projectId", "capability", "riskLevel", "status", "input", "inputFingerprint", "policyModeSnapshot", "idempotencyKey", "requestedById", "approvalExpiresAt", "updatedAt") VALUES ($1::uuid, $2::uuid, 'project.repository.sync', 'low', 'waiting_approval', '{}'::jsonb, $3, 'approval_required', $4, $5::uuid, CURRENT_TIMESTAMP + interval '1 hour', CURRENT_TIMESTAMP)`, [actionId, projectId, fingerprintA, fingerprintB, ownerId]);

    // A live delegation blocks connection deletion. Terminal delegations are
    // allowed to cascade and their scalar audit rows remain after deletion.
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO "ProjectMcpConnectionDelegation" ("id", "projectId", "mcpConnectionId", "connectionOwnerId", "connectionConfigurationRevision", "resolvedAddressFingerprint", "credentialFingerprint", "delegationFingerprint", "expiresAt", "ownerProjectMembershipId", "ownerMembershipCreatedAt", "proposedById", "updatedAt") VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 5, $5, $6, $7, $8::timestamp, $9::uuid, $10::timestamp, $4::uuid, CURRENT_TIMESTAMP)`,
      [rejectedDelegationId, projectId, connectionId, ownerId, fingerprintB, fingerprintC, fingerprintD, sqlTimestamp(expiresAt), ownerMembershipId, sqlTimestamp(ownerMembership.rows[0]!.createdAt)],
    );
    const rejectedDraft = (await client.query(`SELECT * FROM "ProjectMcpConnectionDelegation" WHERE "id" = $1::uuid`, [rejectedDelegationId])).rows[0] as Record<string, unknown>;
    Object.assign(rejectedDraft, { statusBefore: null, transitionAt: rejectedDraft.proposedAt });
    await insertDelegationAudit(client, rejectedDraft, "proposed", "second MCP delegation", ownerId, ownerMembershipId, ownerMembership.rows[0]!.createdAt);
    await client.query("COMMIT");
    await assert.rejects(
      () => client.query(`DELETE FROM "McpConnection" WHERE "id" = $1::uuid`, [connectionId]),
      /MCP_CONNECTION_LIVE_DELEGATION_DELETE_FORBIDDEN/u,
    );
    await client.query("BEGIN");
    await client.query(`UPDATE "ProjectMcpConnectionDelegation" SET "status" = 'rejected', "version" = 2, "terminalActorId" = $2::uuid, "terminalActorProjectMembershipId" = $3::uuid, "terminalActorMembershipCreatedAt" = $4::timestamp, "terminalReason" = 'rejected by owner' WHERE "id" = $1::uuid`, [rejectedDelegationId, ownerId, ownerMembershipId, sqlTimestamp(ownerMembership.rows[0]!.createdAt)]);
    const rejected = (await client.query(`SELECT * FROM "ProjectMcpConnectionDelegation" WHERE "id" = $1::uuid`, [rejectedDelegationId])).rows[0] as Record<string, unknown>;
    Object.assign(rejected, { statusBefore: "draft" });
    await insertDelegationAudit(client, rejected, "rejected", "rejected by owner", ownerId, ownerMembershipId, ownerMembership.rows[0]!.createdAt);
    await client.query("COMMIT");
    await client.query(`DELETE FROM "Project" WHERE "id" = $1::uuid`, [projectId]);
    await client.query(`DELETE FROM "McpConnection" WHERE "id" = $1::uuid`, [connectionId]);
    assert.equal((await client.query(`SELECT COUNT(*)::int AS count FROM "ProjectMcpConnectionDelegationAudit" WHERE "delegationId" IN ($1::uuid, $2::uuid)`, [delegationId, rejectedDelegationId])).rows[0]?.count, 6);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query(`DELETE FROM "Project" WHERE "id" = $1::uuid`, [projectId]).catch(() => undefined);
    await client.query(`DELETE FROM "McpConnection" WHERE "id" IN ($1::uuid, $2::uuid)`, [connectionId, noCredentialConnectionId]).catch(() => undefined);
    await client.query(`DELETE FROM "ExternalCredential" WHERE "id" = $1::uuid`, [credentialId]).catch(() => undefined);
    await client.query(`DELETE FROM "Workspace" WHERE "id" = $1::uuid`, [workspaceId]).catch(() => undefined);
    await client.query(`DELETE FROM "AppUser" WHERE "id" IN ($1::uuid, $2::uuid)`, [ownerId, projectOwnerId]).catch(() => undefined);
  }
});

test(
  "MCP delegation terminal safety survives owner membership revocation",
  { skip: !shouldRun ? "PROJECT_MCP_DELEGATION_POSTGRES_GATE=1 is required" : false },
  async (context) => {
    assertDisposableGateDatabase();
    const databaseUrl = process.env.DATABASE_URL!;
    const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
    await client.connect();
    context.after(() => client.end());

    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const ownerId = id();
    const projectOwnerId = id();
    const workspaceOnlyId = id();
    const workspaceId = id();
    const projectId = id();
    const connectionIds = [id(), id(), id()];
    const delegationIds = [id(), id(), id()];
    let ownerMembershipId = "";
    let projectOwnerMembershipId = "";
    let ownerMembershipCreatedAt: Date;
    let projectOwnerMembershipCreatedAt: Date;

    const insertDraft = async (delegationId: string, connectionId: string): Promise<void> => {
      await client.query("BEGIN");
      try {
        await client.query(
          `INSERT INTO "ProjectMcpConnectionDelegation" (
             "id", "projectId", "mcpConnectionId", "connectionOwnerId", "connectionConfigurationRevision",
             "resolvedAddressFingerprint", "credentialFingerprint", "delegationFingerprint", "expiresAt",
             "ownerProjectMembershipId", "ownerMembershipCreatedAt", "proposedById", "updatedAt"
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5, $6, $7, CURRENT_TIMESTAMP + interval '1 hour', $8::uuid, $9::timestamp, $4::uuid, CURRENT_TIMESTAMP)`,
          [delegationId, projectId, connectionId, ownerId, fingerprintB, sentinel, fingerprintD, ownerMembershipId, sqlTimestamp(ownerMembershipCreatedAt)],
        );
        const draft = (await client.query(`SELECT * FROM "ProjectMcpConnectionDelegation" WHERE "id" = $1::uuid`, [delegationId])).rows[0] as Record<string, unknown>;
        Object.assign(draft, { statusBefore: null, transitionAt: draft.proposedAt });
        await insertDelegationAudit(client, draft, "proposed", "owner proposed emergency delegation fixture", ownerId, ownerMembershipId, ownerMembershipCreatedAt);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    };

    const transition = async (
      delegationId: string,
      previousStatus: string,
      status: string,
      version: number,
      setClause: string,
      setValues: readonly unknown[],
      action: string,
      reason: string,
      actorId: string,
      actorMembershipId: string,
      actorMembershipCreatedAt: Date,
    ): Promise<void> => {
      await client.query("BEGIN");
      try {
        await client.query(
          `UPDATE "ProjectMcpConnectionDelegation"
           SET "status" = $2::"ProjectMcpConnectionDelegationStatus", "version" = $3, ${setClause}
           WHERE "id" = $1::uuid`,
          [delegationId, status, version, ...setValues],
        );
        const row = (await client.query(`SELECT * FROM "ProjectMcpConnectionDelegation" WHERE "id" = $1::uuid`, [delegationId])).rows[0] as Record<string, unknown>;
        Object.assign(row, { statusBefore: previousStatus });
        await insertDelegationAudit(client, row, action, reason, actorId, actorMembershipId, actorMembershipCreatedAt);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    };

    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO "AppUser" ("id", "username", "role", "updatedAt") VALUES
           ($1::uuid, $2, 'user', CURRENT_TIMESTAMP),
           ($3::uuid, $4, 'user', CURRENT_TIMESTAMP),
           ($5::uuid, $6, 'user', CURRENT_TIMESTAMP)`,
        [ownerId, `mcp_terminal_owner_${suffix}`, projectOwnerId, `mcp_terminal_project_owner_${suffix}`, workspaceOnlyId, `mcp_terminal_workspace_only_${suffix}`],
      );
      await client.query(
        `INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt") VALUES ($1::uuid, $2, $3, $4::uuid, CURRENT_TIMESTAMP)`,
        [workspaceId, `MCP terminal ${suffix}`, `mcp-terminal-${suffix}`, ownerId],
      );
      await client.query(
        `INSERT INTO "Project" ("id", "workspaceId", "name", "slug", "updatedAt") VALUES ($1::uuid, $2::uuid, $3, $4, CURRENT_TIMESTAMP)`,
        [projectId, workspaceId, `MCP terminal project ${suffix}`, `mcp-terminal-project-${suffix}`],
      );
      for (const [index, connectionId] of connectionIds.entries()) {
        await client.query(
          `INSERT INTO "McpConnection" (
             "id", "name", "endpointUrl", "authKind", "allowPrivateNetwork", "resolvedAddressFingerprint",
             "status", "createdById", "ownerUserId", "ownershipState", "updatedAt"
           ) VALUES ($1::uuid, $2, $3, 'none', false, $4, 'verified', $5::uuid, $5::uuid, 'confirmed', CURRENT_TIMESTAMP)`,
          [connectionId, `MCP terminal connection ${index} ${suffix}`, `https://mcp.example.test/terminal/${index}`, fingerprintB, ownerId],
        );
      }
      await client.query("COMMIT");

      const db = getDb();
      const memberships = await db.$transaction(async (tx) => {
        await grantWorkspaceMembership(tx, { workspaceId, userId: ownerId, role: "owner", actorId: ownerId, reason: "MCP terminal owner fixture" });
        await grantWorkspaceMembership(tx, { workspaceId, userId: workspaceOnlyId, role: "member", actorId: ownerId, reason: "MCP terminal workspace-only fixture" });
        const owner = await grantProjectMembership(tx, { projectId, workspaceId, userId: ownerId, role: "owner", actorId: ownerId, reason: "MCP terminal owner fixture" });
        const projectOwner = await grantProjectMembership(tx, { projectId, workspaceId, userId: projectOwnerId, role: "owner", actorId: ownerId, reason: "MCP terminal project owner fixture" });
        return { owner, projectOwner };
      });
      ownerMembershipId = memberships.owner.id;
      projectOwnerMembershipId = memberships.projectOwner.id;
      ownerMembershipCreatedAt = memberships.owner.createdAt;
      projectOwnerMembershipCreatedAt = memberships.projectOwner.createdAt;

      // A is taken all the way live before the owner loses project access.
      await insertDraft(delegationIds[0]!, connectionIds[0]!);
      await transition(delegationIds[0]!, "draft", "owner_confirmed", 2, `"ownerConfirmedById" = $4::uuid`, [ownerId], "owner_confirmed", "owner confirmed terminal fixture", ownerId, ownerMembershipId, ownerMembershipCreatedAt);
      await transition(
        delegationIds[0]!,
        "owner_confirmed",
        "active",
        3,
        `"projectConfirmedById" = $4::uuid, "projectConfirmedProjectMembershipId" = $5::uuid, "projectConfirmedMembershipCreatedAt" = $6::timestamp`,
        [projectOwnerId, projectOwnerMembershipId, sqlTimestamp(projectOwnerMembershipCreatedAt)],
        "activated",
        "project owner activated terminal fixture",
        projectOwnerId,
        projectOwnerMembershipId,
        projectOwnerMembershipCreatedAt,
      );

      // B is owner-confirmed and C remains a draft, so both pre-terminal
      // states can exercise their distinct emergency boundaries.
      await insertDraft(delegationIds[1]!, connectionIds[1]!);
      await transition(delegationIds[1]!, "draft", "owner_confirmed", 2, `"ownerConfirmedById" = $4::uuid`, [ownerId], "owner_confirmed", "owner confirmed terminal fixture", ownerId, ownerMembershipId, ownerMembershipCreatedAt);
      await insertDraft(delegationIds[2]!, connectionIds[2]!);

      await db.$transaction(async (tx) => {
        await revokeProjectMembership(tx, projectId, ownerId, workspaceId, { actorId: projectOwnerId, reason: "MCP terminal owner access revoked" });
      });
      const revokedMembership = await client.query<{ accessState: string }>(
        `SELECT "accessState" FROM "ProjectMembership" WHERE "id" = $1::uuid`,
        [ownerMembershipId],
      );
      assert.equal(revokedMembership.rows[0]?.accessState, "revoked");

      // The frozen owner epoch is sufficient for an emergency revoke, even
      // though the owner is no longer a current project member.
      await transition(
        delegationIds[0]!,
        "active",
        "revoked",
        4,
        `"terminalActorId" = $4::uuid, "terminalActorProjectMembershipId" = $5::uuid, "terminalActorMembershipCreatedAt" = $6::timestamp, "terminalReason" = 'owner emergency revoke'`,
        [ownerId, ownerMembershipId, sqlTimestamp(ownerMembershipCreatedAt)],
        "revoked",
        "owner emergency revoke",
        ownerId,
        ownerMembershipId,
        ownerMembershipCreatedAt,
      );

      // A revoked owner cannot confirm a new draft. The deferred live guard
      // must fail the entity write atomically.
      await client.query("BEGIN");
      await client.query(
        `UPDATE "ProjectMcpConnectionDelegation" SET "status" = 'owner_confirmed', "version" = 2, "ownerConfirmedById" = $2::uuid WHERE "id" = $1::uuid`,
        [delegationIds[2], ownerId],
      );
      await assert.rejects(
        () => client.query("COMMIT"),
        /PROJECT_MCP_CONNECTION_DELEGATION_LIVE_OWNER_INVALID/u,
      );
      await client.query("ROLLBACK").catch(() => undefined);

      // An owner-confirmed delegation also cannot activate after that owner
      // epoch is revoked, regardless of a valid project-owner snapshot.
      await client.query("BEGIN");
      await client.query(
        `UPDATE "ProjectMcpConnectionDelegation" SET "status" = 'active', "version" = 3, "projectConfirmedById" = $2::uuid, "projectConfirmedProjectMembershipId" = $3::uuid, "projectConfirmedMembershipCreatedAt" = $4::timestamp WHERE "id" = $1::uuid`,
        [delegationIds[1], projectOwnerId, projectOwnerMembershipId, sqlTimestamp(projectOwnerMembershipCreatedAt)],
      );
      await assert.rejects(
        () => client.query("COMMIT"),
        /PROJECT_MCP_CONNECTION_DELEGATION_LIVE_OWNER_INVALID/u,
      );
      await client.query("ROLLBACK").catch(() => undefined);

      // A workspace-only actor cannot terminate a project delegation. The
      // failed statement must leave C in draft for the frozen owner to reject.
      await assert.rejects(
        () => client.query(
          `UPDATE "ProjectMcpConnectionDelegation" SET "status" = 'rejected', "version" = 2, "terminalActorId" = $2::uuid, "terminalActorProjectMembershipId" = $3::uuid, "terminalActorMembershipCreatedAt" = $4::timestamp, "terminalReason" = 'workspace-only rejection attempt' WHERE "id" = $1::uuid`,
          [delegationIds[2], workspaceOnlyId, ownerMembershipId, sqlTimestamp(ownerMembershipCreatedAt)],
        ),
        /PROJECT_MCP_CONNECTION_DELEGATION_AUDIT_ACTOR_INVALID/u,
      );
      await transition(
        delegationIds[2]!,
        "draft",
        "rejected",
        2,
        `"terminalActorId" = $4::uuid, "terminalActorProjectMembershipId" = $5::uuid, "terminalActorMembershipCreatedAt" = $6::timestamp, "terminalReason" = 'owner emergency rejection'`,
        [ownerId, ownerMembershipId, sqlTimestamp(ownerMembershipCreatedAt)],
        "rejected",
        "owner emergency rejection",
        ownerId,
        ownerMembershipId,
        ownerMembershipCreatedAt,
      );

      // The revoked owner can still reject an owner-confirmed delegation,
      // using exactly the membership epoch frozen on the delegation.
      await transition(
        delegationIds[1]!,
        "owner_confirmed",
        "rejected",
        3,
        `"terminalActorId" = $4::uuid, "terminalActorProjectMembershipId" = $5::uuid, "terminalActorMembershipCreatedAt" = $6::timestamp, "terminalReason" = 'owner emergency rejection'`,
        [ownerId, ownerMembershipId, sqlTimestamp(ownerMembershipCreatedAt)],
        "rejected",
        "owner emergency rejection",
        ownerId,
        ownerMembershipId,
        ownerMembershipCreatedAt,
      );

      const terminalStatuses = await client.query<{ status: string; version: number }>(
        `SELECT "status", "version" FROM "ProjectMcpConnectionDelegation" WHERE "id" IN ($1::uuid, $2::uuid, $3::uuid) ORDER BY "id"`,
        delegationIds,
      );
      assert.deepEqual(terminalStatuses.rows.map((row) => row.status).sort(), ["rejected", "rejected", "revoked"]);
      assert.deepEqual(terminalStatuses.rows.map((row) => row.version).sort((a, b) => a - b), [2, 3, 4]);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query(`DELETE FROM "ProjectMcpConnectionDelegationAudit" WHERE "projectId" = $1::uuid`, [projectId]).catch(() => undefined);
      await client.query(`DELETE FROM "McpConnection" WHERE "id" = ANY($1::uuid[])`, [connectionIds]).catch(() => undefined);
      await client.query(`DELETE FROM "Project" WHERE "id" = $1::uuid`, [projectId]).catch(() => undefined);
      await client.query(`DELETE FROM "Workspace" WHERE "id" = $1::uuid`, [workspaceId]).catch(() => undefined);
      await client.query(`DELETE FROM "AppUser" WHERE "id" = ANY($1::uuid[])`, [[ownerId, projectOwnerId, workspaceOnlyId]]).catch(() => undefined);
    }
  },
);

test(
  "migration 75 fails closed for legacy MCP evidence and preserves compliant 74 data",
  { skip: !shouldRun ? "PROJECT_MCP_DELEGATION_POSTGRES_GATE=1 is required" : false },
  async () => {
    assertDisposableGateDatabase();
    const configuredUrl = process.env.DATABASE_URL;
    if (typeof configuredUrl !== "string" || configuredUrl.length === 0) {
      throw new Error("PROJECT_MCP_DELEGATION_UPGRADE_DATABASE_URL_REQUIRED");
    }
    const targetDatabaseUrl = configuredUrl;
    const migrations = await migrationNamesFromDisk();
    const previousIndex = migrations.indexOf(previousMigration);
    const currentIndex = migrations.indexOf(projectMcpDelegationMigration);
    if (previousIndex < 0 || currentIndex !== previousIndex + 1) {
      throw new Error("PROJECT_MCP_DELEGATION_UPGRADE_MIGRATION_ORDER_INVALID");
    }
    const oldMigrationNames = migrations.slice(0, currentIndex);
    const currentMigrationNames = [projectMcpDelegationMigration];
    const configuredTarget = new URL(configuredUrl);
    const ownerRole = decodeURIComponent(configuredTarget.username);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(ownerRole)) {
      throw new Error("PROJECT_MCP_DELEGATION_UPGRADE_DATABASE_OWNER_INVALID");
    }
    const admin = new Client({ connectionString: assertUpgradeAdminUrl(), connectionTimeoutMillis: 5_000 });
    const tempRoot = await prepareStagedMigrationRoot();

    async function runUpgradeCase(upgradeCase: UpgradeCase): Promise<void> {
      const databaseName = upgradeDatabaseName(randomUUID().slice(0, 12));
      const targetUrl = new URL(targetDatabaseUrl);
      targetUrl.pathname = `/${databaseName}`;
      targetUrl.search = "";
      targetUrl.hash = "";
      let databaseCreated = false;
      let fixture: UpgradeFixture | undefined;
      try {
        await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
        databaseCreated = true;
        // Keep the staged migration directory at the exact 74- or 75-migration
        // boundary for each fresh database. A previous case must not leave the
        // new migration visible during the legacy seed phase.
        await rm(join(tempRoot, "prisma", "migrations"), { recursive: true, force: true });
        await stageMigrations(tempRoot, oldMigrationNames);
        await deployStagedMigrations(tempRoot, targetUrl.toString());
        fixture = await seedUpgradeCase(targetUrl.toString(), upgradeCase);
        let beforeConnectionRows: Array<{ status: string; disabledAt: Date | null; credentialId: string | null }> | undefined;
        let beforeCredentialRows: Array<{ kind: string; secretFingerprint: string }> | undefined;

        if (upgradeCase.startsWith("invalid-connection")) {
          const before = await fixture.client.query<{ status: string; disabledAt: Date | null; credentialId: string | null }>(
            `SELECT "status", "disabledAt", "credentialId" FROM "McpConnection" WHERE "id" = $1::uuid`, [fixture.connectionId],
          );
          beforeConnectionRows = before.rows;
          if (upgradeCase === "invalid-connection") {
            assert.deepEqual(before.rows[0], { status: "disabled", disabledAt: null, credentialId: null });
          } else if (upgradeCase === "invalid-connection-disabled-at") {
            assert.equal(before.rows[0]?.status, "verified");
            assert.notEqual(before.rows[0]?.disabledAt, null);
            assert.equal(before.rows[0]?.credentialId, null);
          } else {
            assert.equal(before.rows[0]?.status, "verified");
            assert.equal(before.rows[0]?.disabledAt, null);
            assert.equal(before.rows[0]?.credentialId, fixture.credentialId);
          }
          if (fixture.credentialId !== null) {
            const credential = await fixture.client.query<{ kind: string; secretFingerprint: string }>(
              `SELECT "kind", "secretFingerprint" FROM "ExternalCredential" WHERE "id" = $1::uuid`, [fixture.credentialId],
            );
            beforeCredentialRows = credential.rows;
            assert.equal(credential.rows.length, upgradeCase === "invalid-connection-missing-credential" ? 0 : 1);
          }
        } else if (upgradeCase === "invalid-action") {
          const before = await fixture.client.query<{ status: string }>(
            `SELECT "status" FROM "ProjectAction" WHERE "id" IN ($1::uuid, $2::uuid) ORDER BY "id"`,
            [fixture.invalidActionId, fixture.terminalActionId],
          );
          assert.deepEqual(before.rows.map((row) => row.status).sort(), ["succeeded", "waiting_approval"]);
        } else {
          const before = await fixture.client.query<{ id: string }>(
            `SELECT "id" FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`, [fixture.grantId],
          );
          assert.deepEqual(before.rows, [{ id: fixture.grantId }]);
        }

        await stageMigrations(tempRoot, currentMigrationNames);
        if (upgradeCase.startsWith("invalid-connection")) {
          await assert.rejects(
            () => deployStagedMigrations(tempRoot, targetUrl.toString()),
            /PMCD_CONNECTION_EVIDENCE_PREFLIGHT_FAILED/u,
          );
        } else if (upgradeCase === "invalid-action") {
          await assert.rejects(
            () => deployStagedMigrations(tempRoot, targetUrl.toString()),
            /PMCD_NONTERMINAL_MCP_ACTION_PREFLIGHT_FAILED/u,
          );
        } else {
          await deployStagedMigrations(tempRoot, targetUrl.toString());
        }

        const completed = await fixture.client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM "_prisma_migrations" WHERE "migration_name" = $1 AND "finished_at" IS NOT NULL`,
          [projectMcpDelegationMigration],
        );
        assert.equal(completed.rows[0]?.count, upgradeCase === "compliant" || upgradeCase === "legacy-active-with-revoked-audit" ? "1" : "0");

        if (upgradeCase !== "compliant" && upgradeCase !== "legacy-active-with-revoked-audit") {
          const schema = await fixture.client.query<{ delegationTable: string | null; fingerprintColumns: string }>(
            `SELECT to_regclass('public."ProjectMcpConnectionDelegation"') AS "delegationTable", (SELECT COUNT(*)::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'McpConnection' AND column_name = 'credentialFingerprint') AS "fingerprintColumns"`,
          );
          assert.equal(schema.rows[0]?.delegationTable, null, "failed preflight must not create delegation table");
          assert.equal(schema.rows[0]?.fingerprintColumns, "0", "failed preflight must not add connection columns");
          const applied = await fixture.client.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL`,
          );
          assert.equal(applied.rows[0]?.count, String(oldMigrationNames.length), "failed preflight must preserve completed migration state");
          if (upgradeCase.startsWith("invalid-connection")) {
            const after = await fixture.client.query<{ status: string; disabledAt: Date | null; credentialId: string | null }>(
              `SELECT "status", "disabledAt", "credentialId" FROM "McpConnection" WHERE "id" = $1::uuid`, [fixture.connectionId],
            );
            assert.deepEqual(after.rows, beforeConnectionRows);
            if (upgradeCase === "invalid-connection") {
              assert.deepEqual(after.rows[0], { status: "disabled", disabledAt: null, credentialId: null });
            } else if (upgradeCase === "invalid-connection-disabled-at") {
              assert.equal(after.rows[0]?.status, "verified");
              assert.notEqual(after.rows[0]?.disabledAt, null);
              assert.equal(after.rows[0]?.credentialId, null);
            } else {
              assert.equal(after.rows[0]?.status, "verified");
              assert.equal(after.rows[0]?.disabledAt, null);
              assert.equal(after.rows[0]?.credentialId, fixture.credentialId);
            }
            if (fixture.credentialId !== null) {
              const credential = await fixture.client.query<{ kind: string; secretFingerprint: string }>(
                `SELECT "kind", "secretFingerprint" FROM "ExternalCredential" WHERE "id" = $1::uuid`, [fixture.credentialId],
              );
              assert.deepEqual(credential.rows, beforeCredentialRows);
              assert.equal(credential.rows.length, upgradeCase === "invalid-connection-missing-credential" ? 0 : 1);
            }
          } else {
            const after = await fixture.client.query<{ status: string }>(
              `SELECT "status" FROM "ProjectAction" WHERE "id" = $1::uuid`, [fixture.terminalActionId],
            );
            assert.equal(after.rows[0]?.status, "succeeded", "terminal MCP action must survive a failed upgrade");
          }
        } else if (upgradeCase === "legacy-active-with-revoked-audit") {
          const historical = await fixture.client.query<{ status: string; event: string; transactionId: string | null }>(
            `SELECT grant_row."status", audit."event", audit."transactionId"
             FROM "ProjectMcpToolGrant" AS grant_row
             JOIN "ProjectMcpToolGrantAudit" AS audit
               ON audit."projectId" = grant_row."projectId" AND audit."grantId" = grant_row."id"
             WHERE grant_row."id" = $1::uuid
             ORDER BY audit."createdAt", audit."id"`,
            [fixture.grantId],
          );
          assert.equal(historical.rows[0]?.status, "active");
          assert.deepEqual(historical.rows.map((row) => row.event), ["revoked", "refreshed"]);
          assert.equal(historical.rows[0]?.transactionId, null);
          assert.equal(historical.rows[1]?.transactionId, null);

          // Two revoked audit rows in one transaction cannot satisfy the
          // exact-one deferred contract; the grant must remain active.
          await fixture.client.query("BEGIN");
          await fixture.client.query(
            `UPDATE "ProjectMcpToolGrant" SET "status" = 'revoked', "revokedAt" = CURRENT_TIMESTAMP WHERE "id" = $1::uuid`,
            [fixture.grantId],
          );
          for (let index = 0; index < 2; index += 1) {
            if (index === 1) {
              await assert.rejects(
                () => fixture!.client.query(
                  `INSERT INTO "ProjectMcpToolGrantAudit" ("id", "projectId", "grantId", "event", "actorId", "definitionFingerprint", "details") VALUES ($1::uuid, $2::uuid, $3::uuid, 'revoked', $4::uuid, $5, '{}'::jsonb)`,
                  [id(), fixture!.projectId, fixture!.grantId, fixture!.ownerId, fingerprintD],
                ),
                /PROJECT_MCP_TOOL_GRANT_REVOKE_AUDIT_DUPLICATE/u,
              );
            } else {
              await fixture.client.query(
                `INSERT INTO "ProjectMcpToolGrantAudit" ("id", "projectId", "grantId", "event", "actorId", "definitionFingerprint", "details") VALUES ($1::uuid, $2::uuid, $3::uuid, 'revoked', $4::uuid, $5, '{}'::jsonb)`,
                [id(), fixture.projectId, fixture.grantId, fixture.ownerId, fingerprintD],
              );
            }
          }
          await fixture.client.query("ROLLBACK").catch(() => undefined);
          assert.equal((await fixture.client.query<{ status: string }>(`SELECT "status" FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`, [fixture.grantId])).rows[0]?.status, "active");

          // A legacy revoked audit must not block a new same-transaction
          // revoke, but the resulting audit receives a fresh DB xid.
          await fixture.client.query("BEGIN");
          await fixture.client.query(
            `UPDATE "ProjectMcpToolGrant" SET "status" = 'revoked', "revokedAt" = CURRENT_TIMESTAMP WHERE "id" = $1::uuid`,
            [fixture.grantId],
          );
          await fixture.client.query(
            `INSERT INTO "ProjectMcpToolGrantAudit" ("id", "projectId", "grantId", "event", "actorId", "definitionFingerprint", "details") VALUES ($1::uuid, $2::uuid, $3::uuid, 'revoked', $4::uuid, $5, '{}'::jsonb)`,
            [id(), fixture.projectId, fixture.grantId, fixture.ownerId, fingerprintD],
          );
          await fixture.client.query("COMMIT");
          const revokedAudits = await fixture.client.query<{ transactionId: string | null }>(
            `SELECT "transactionId" FROM "ProjectMcpToolGrantAudit" WHERE "projectId" = $1::uuid AND "grantId" = $2::uuid AND "event" = 'revoked' ORDER BY "createdAt", "id"`,
            [fixture.projectId, fixture.grantId],
          );
          assert.equal(revokedAudits.rows.length, 2);
          assert.equal(revokedAudits.rows[0]?.transactionId, null);
          assert.notEqual(revokedAudits.rows[1]?.transactionId, null);

          // A later forged audit cannot target an already terminal grant.
          await assert.rejects(
            () => fixture!.client.query(
              `INSERT INTO "ProjectMcpToolGrantAudit" ("id", "projectId", "grantId", "event", "actorId", "definitionFingerprint", "details") VALUES ($1::uuid, $2::uuid, $3::uuid, 'revoked', $4::uuid, $5, '{}'::jsonb)`,
              [id(), fixture!.projectId, fixture!.grantId, fixture!.ownerId, fingerprintD],
            ),
            /PROJECT_MCP_TOOL_GRANT_REVOKE_AUDIT_STATE_INVALID/u,
          );
        } else {
          const upgraded = await fixture.client.query<{ credentialFingerprint: string; configurationRevision: number }>(
            `SELECT "credentialFingerprint", "configurationRevision" FROM "McpConnection" WHERE "id" = $1::uuid`, [fixture.connectionId],
          );
          assert.deepEqual(upgraded.rows[0], { credentialFingerprint: fingerprintA, configurationRevision: 1 });
          const grant = await fixture.client.query<{ delegationId: string | null }>(
            `SELECT "delegationId" FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`, [fixture.grantId],
          );
          assert.equal(grant.rows[0]?.delegationId, null, "legacy grants must remain unbound");
        }
      } finally {
        await fixture?.client.end().catch(() => undefined);
        if (databaseCreated) {
          await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
        }
      }
    }

    try {
      await admin.connect();
      await runUpgradeCase("invalid-connection");
      await runUpgradeCase("invalid-connection-disabled-at");
      await runUpgradeCase("invalid-connection-missing-credential");
      await runUpgradeCase("invalid-connection-wrong-credential-kind");
      await runUpgradeCase("invalid-connection-malformed-credential-fingerprint");
      await runUpgradeCase("invalid-action");
      await runUpgradeCase("legacy-active-with-revoked-audit");
      await runUpgradeCase("compliant");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
      await admin.end().catch(() => undefined);
    }
  },
);
