import "dotenv/config";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { Client } from "pg";
import test from "node:test";
import { getDb } from "../src/lib/db";
import { executeAccountAccess, previewAccountAccess } from "../src/lib/account-access-service";
import {
  ProjectMcpConnectionDelegationServiceError,
  confirmProjectMcpConnectionDelegationOwner,
  confirmProjectMcpConnectionDelegationProject,
  getProjectMcpConnectionDelegation,
  listConnectionOwnerProjectMcpConnectionDelegations,
  listProjectMcpConnectionDelegations,
  proposeProjectMcpConnectionDelegation,
  rejectProjectMcpConnectionDelegation,
  revokeProjectMcpConnectionDelegation,
} from "../src/lib/project-mcp-connection-delegation-service";
import { executeMcpConnectionMutation, previewMcpConnectionMutation } from "../src/lib/mcp/connection-governance";
import { grantProjectMembership, grantWorkspaceMembership, revokeProjectMembership } from "../src/lib/membership-governance";

const shouldRun = process.env.PROJECT_MCP_DELEGATION_POSTGRES_GATE === "1";
const testDatabaseName = "ai_project_os_project_mcp_delegation_test";
const repositoryRoot = process.cwd();
const execFile = promisify(execFileCallback);
const previousMigration = "20260904170000_add_project_git_manual_run_reconciliation";
const projectMcpDelegationMigration = "20260904180000_add_project_mcp_connection_delegations";
const mcpControlPlaneV2Migration = "20260904190000_add_mcp_control_plane_v2";
const projectMcpGrantRetentionMigration = "20260904200000_add_project_mcp_grant_retention_ledger";
const sentinel = createHash("sha256").update("mcp:no-credential:v1").digest("hex");
const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);
const fingerprintC = "c".repeat(64);
const fingerprintD = "d".repeat(64);

function timeZoneDatabase(timeZone: string): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === "") throw new Error("PROJECT_MCP_DELEGATION_TEST_DATABASE_URL_REQUIRED");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString, options: `-c TimeZone=${timeZone}` }) });
}

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
       "resolvedAddressFingerprint", "credentialFingerprint", "connectionOwnerAccountAccessVersion", "delegationFingerprint", "reason", "transitionAt"
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::"ProjectMcpConnectionDelegationAuditAction",
       $7, $8::"ProjectMcpConnectionDelegationStatus", $9::"ProjectMcpConnectionDelegationStatus",
       $10::"ProjectMcpConnectionDelegationActorKind", $11::uuid, $12::uuid, $13::timestamp,
       $14::"ProjectMcpConnectionDelegationActorKind", $15::uuid, $16::uuid, $17::timestamp, $18,
       $19::uuid, $20::timestamp, $21::uuid, $22::timestamp, $23::timestamp, $24,
       $25, $26, $27, $28, $29, $30::timestamp)`,
    [
      id(), delegation.projectId, delegation.mcpConnectionId, delegation.id, delegation.connectionOwnerId,
      action, delegation.version, delegation.statusBefore ?? null, delegation.status, action === "expired" ? "system_expiry" : "user",
      actorId, actorMembershipId, actorMembershipCreatedAt === null ? null : sqlTimestamp(actorMembershipCreatedAt),
      delegation.terminalActorKind ?? null, delegation.terminalActorId ?? null, delegation.terminalActorProjectMembershipId ?? null,
      delegation.terminalActorMembershipCreatedAt ?? null, delegation.terminalReason ?? null, delegation.ownerProjectMembershipId,
      delegation.ownerMembershipCreatedAt, delegation.projectConfirmedProjectMembershipId ?? null,
      delegation.projectConfirmedMembershipCreatedAt ?? null, delegation.expiresAt, delegation.connectionConfigurationRevision,
      delegation.resolvedAddressFingerprint, delegation.credentialFingerprint, delegation.connectionOwnerAccountAccessVersion ?? null, delegation.delegationFingerprint, reason,
      delegation.transitionAt ?? delegation.proposedAt,
    ],
  );
}

async function assertDelegationServiceError(action: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) => error instanceof ProjectMcpConnectionDelegationServiceError && error.code === code,
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
      `INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt") VALUES ($1::uuid, $2, $3, NULL, CURRENT_TIMESTAMP)`,
      [workspaceId, `MCP ${suffix}`, `mcp-${suffix}`],
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
      `INSERT INTO "McpConnection" ("id", "name", "endpointUrl", "authKind", "credentialId", "allowPrivateNetwork", "resolvedAddressFingerprint", "status", "createdById", "ownerUserId", "ownerAccountAccessVersion", "ownershipState", "updatedAt") VALUES ($1::uuid, $2, 'https://mcp.example.test/mcp', 'bearer', $3::uuid, false, $4, 'verified', $5::uuid, $5::uuid, 1, 'confirmed', CURRENT_TIMESTAMP)`,
      [connectionId, `MCP ${suffix}`, credentialId, fingerprintB, ownerId],
    );
    await client.query(
      `INSERT INTO "McpConnection" ("id", "name", "endpointUrl", "authKind", "allowPrivateNetwork", "resolvedAddressFingerprint", "status", "createdById", "ownerUserId", "ownerAccountAccessVersion", "ownershipState", "updatedAt") VALUES ($1::uuid, $2, 'https://mcp.example.test/no-auth', 'none', false, $3, 'configured', $4::uuid, $4::uuid, 1, 'confirmed', CURRENT_TIMESTAMP)`,
      [noCredentialConnectionId, `MCP none ${suffix}`, fingerprintB, ownerId],
    );
    await client.query("COMMIT");

    const db = getDb();
    const memberships = await db.$transaction(async (tx) => {
      await tx.workspace.update({ where: { id: workspaceId }, data: { createdById: ownerId } });
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
    const directSecurityGuard = /mcp connection security fields require governance context/u;
    await assert.rejects(
      () => client.query(`UPDATE "McpConnection" SET "protocolVersion" = '2026-07-28' WHERE "id" = $1::uuid`, [connectionId]),
      directSecurityGuard,
    );
    await assert.rejects(
      () => client.query(`UPDATE "McpConnection" SET "status" = 'disabled', "disabledAt" = CURRENT_TIMESTAMP WHERE "id" = $1::uuid`, [connectionId]),
      directSecurityGuard,
    );
    await client.query(`UPDATE "McpConnection" SET "status" = 'verified', "disabledAt" = NULL WHERE "id" = $1::uuid`, [connectionId]);
    assert.equal((await client.query<{ configurationRevision: number }>(`SELECT "configurationRevision" FROM "McpConnection" WHERE "id" = $1::uuid`, [connectionId])).rows[0]?.configurationRevision, 1);
    await assert.rejects(
      () => client.query(`UPDATE "McpConnection" SET "catalogFingerprint" = $2 WHERE "id" = $1::uuid`, [connectionId, fingerprintD]),
      directSecurityGuard,
    );
    await assert.rejects(
      () => client.query(`UPDATE "McpConnection" SET "lastErrorCode" = 'MCP_HEALTH_DEGRADED' WHERE "id" = $1::uuid`, [connectionId]),
      directSecurityGuard,
    );
    await assert.rejects(
      () => client.query(`UPDATE "McpConnection" SET "status" = 'error' WHERE "id" = $1::uuid`, [connectionId]),
      directSecurityGuard,
    );
    await assert.rejects(
      () => client.query(`UPDATE "McpConnection" SET "status" = 'configured' WHERE "id" = $1::uuid`, [connectionId]),
      directSecurityGuard,
    );
    await client.query(`UPDATE "McpConnection" SET "status" = 'verified', "lastErrorCode" = NULL WHERE "id" = $1::uuid`, [connectionId]);
    assert.equal((await client.query<{ configurationRevision: number }>(`SELECT "configurationRevision" FROM "McpConnection" WHERE "id" = $1::uuid`, [connectionId])).rows[0]?.configurationRevision, 1);
    await assert.rejects(
      () => client.query(`UPDATE "McpConnection" SET "status" = 'disabled', "disabledAt" = NULL WHERE "id" = $1::uuid`, [connectionId]),
      directSecurityGuard,
    );
    await assert.rejects(
      () => client.query(`UPDATE "McpConnection" SET "status" = 'verified', "disabledAt" = CURRENT_TIMESTAMP WHERE "id" = $1::uuid`, [connectionId]),
      directSecurityGuard,
    );
    const invariantState = await client.query<{ status: string; disabledAt: Date | null; configurationRevision: number }>(
      `SELECT "status", "disabledAt", "configurationRevision" FROM "McpConnection" WHERE "id" = $1::uuid`, [connectionId],
    );
    assert.equal(invariantState.rows[0]?.status, "verified");
    assert.equal(invariantState.rows[0]?.disabledAt, null);
    assert.equal(invariantState.rows[0]?.configurationRevision, 1);

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
    await assert.rejects(
      () => client.query("SET CONSTRAINTS ALL IMMEDIATE"),
      /MCP_CONNECTION_CREDENTIAL_MIRROR_INVALID/u,
    );
    await client.query("ROLLBACK").catch(() => undefined);
    await assert.rejects(
      () => client.query(`UPDATE "McpConnection" SET "endpointUrl" = 'https://mcp.example.test/v2' WHERE "id" = $1::uuid`, [connectionId]),
      directSecurityGuard,
    );
    const rotated = await client.query<{ credentialFingerprint: string; configurationRevision: number }>(
      `SELECT "credentialFingerprint", "configurationRevision" FROM "McpConnection" WHERE "id" = $1::uuid`, [connectionId],
    );
    assert.deepEqual(rotated.rows[0], { credentialFingerprint: fingerprintA, configurationRevision: 1 });

    const baseDelegation = {
      id: delegationId,
      projectId,
      mcpConnectionId: connectionId,
      connectionOwnerId: ownerId,
      connectionConfigurationRevision: 1,
      resolvedAddressFingerprint: fingerprintB,
      credentialFingerprint: fingerprintA,
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
      `INSERT INTO "ProjectMcpConnectionDelegation" ("id", "projectId", "mcpConnectionId", "connectionOwnerId", "connectionOwnerAccountAccessVersion", "connectionConfigurationRevision", "resolvedAddressFingerprint", "credentialFingerprint", "delegationFingerprint", "expiresAt", "ownerProjectMembershipId", "ownerMembershipCreatedAt", "proposedById", "updatedAt") VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5, $6, $7, $8, $9::timestamp, $10::uuid, $11::timestamp, $4::uuid, CURRENT_TIMESTAMP)`,
      [delegationId, projectId, connectionId, ownerId, 1, fingerprintB, fingerprintA, fingerprintD, sqlTimestamp(expiresAt), ownerMembershipId, sqlTimestamp(ownerMembership.rows[0]!.createdAt)],
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

    // A direct connection delete is always blocked. The governed path below
    // is the only path allowed to consume the terminal connection after its
    // project-scoped rows have been removed.
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO "ProjectMcpConnectionDelegation" ("id", "projectId", "mcpConnectionId", "connectionOwnerId", "connectionOwnerAccountAccessVersion", "connectionConfigurationRevision", "resolvedAddressFingerprint", "credentialFingerprint", "delegationFingerprint", "expiresAt", "ownerProjectMembershipId", "ownerMembershipCreatedAt", "proposedById", "updatedAt") VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 1, $5, $6, $7, $8::timestamp, $9::uuid, $10::timestamp, $4::uuid, CURRENT_TIMESTAMP)`,
      [rejectedDelegationId, projectId, connectionId, ownerId, fingerprintB, fingerprintA, fingerprintD, sqlTimestamp(expiresAt), ownerMembershipId, sqlTimestamp(ownerMembership.rows[0]!.createdAt)],
    );
    const rejectedDraft = (await client.query(`SELECT * FROM "ProjectMcpConnectionDelegation" WHERE "id" = $1::uuid`, [rejectedDelegationId])).rows[0] as Record<string, unknown>;
    Object.assign(rejectedDraft, { statusBefore: null, transitionAt: rejectedDraft.proposedAt });
    await insertDelegationAudit(client, rejectedDraft, "proposed", "second MCP delegation", ownerId, ownerMembershipId, ownerMembership.rows[0]!.createdAt);
    await client.query("COMMIT");
    await assert.rejects(
      () => client.query(`DELETE FROM "McpConnection" WHERE "id" = $1::uuid`, [connectionId]),
      /mcp connection delete requires governance context/u,
    );
    await client.query("BEGIN");
    await client.query(`UPDATE "ProjectMcpConnectionDelegation" SET "status" = 'rejected', "version" = 2, "terminalActorId" = $2::uuid, "terminalActorProjectMembershipId" = $3::uuid, "terminalActorMembershipCreatedAt" = $4::timestamp, "terminalReason" = 'rejected by owner' WHERE "id" = $1::uuid`, [rejectedDelegationId, ownerId, ownerMembershipId, sqlTimestamp(ownerMembership.rows[0]!.createdAt)]);
    const rejected = (await client.query(`SELECT * FROM "ProjectMcpConnectionDelegation" WHERE "id" = $1::uuid`, [rejectedDelegationId])).rows[0] as Record<string, unknown>;
    Object.assign(rejected, { statusBefore: "draft" });
    await insertDelegationAudit(client, rejected, "rejected", "rejected by owner", ownerId, ownerMembershipId, ownerMembership.rows[0]!.createdAt);
    await client.query("COMMIT");
    await client.query(`DELETE FROM "Project" WHERE "id" = $1::uuid`, [projectId]);
    const ownerGovernanceActor = { id: ownerId, accountAccessVersion: 1 };
    const beforeDisable = await db.mcpConnection.findUniqueOrThrow({ where: { id: connectionId }, select: { name: true, updatedAt: true } });
    const disablePreview = await previewMcpConnectionMutation(
      connectionId,
      { action: "disable", requestKey: `mcp-package-a-disable-${suffix}`, reason: "MCP Package A governed cleanup", expectedUpdatedAt: beforeDisable.updatedAt.toISOString() },
      ownerGovernanceActor,
      db,
    );
    assert.equal(disablePreview.canExecute, true);
    const disableResult = await executeMcpConnectionMutation(
      connectionId,
      { previewId: disablePreview.id, requestKey: disablePreview.requestKey, requestFingerprint: disablePreview.requestFingerprint, impactFingerprint: disablePreview.impactFingerprint, expectedUpdatedAt: disablePreview.connection.updatedAt },
      ownerGovernanceActor,
      db,
    );
    assert.equal(disableResult.status, "completed");
    const disabledConnection = await db.mcpConnection.findUniqueOrThrow({ where: { id: connectionId }, select: { name: true, updatedAt: true } });
    const deletePreview = await previewMcpConnectionMutation(
      connectionId,
      { action: "delete", requestKey: `mcp-package-a-delete-${suffix}`, reason: "MCP Package A governed cleanup", expectedUpdatedAt: disabledConnection.updatedAt.toISOString(), confirmationName: disabledConnection.name },
      ownerGovernanceActor,
      db,
    );
    assert.equal(deletePreview.canExecute, true);
    const deleteResult = await executeMcpConnectionMutation(
      connectionId,
      { previewId: deletePreview.id, requestKey: deletePreview.requestKey, requestFingerprint: deletePreview.requestFingerprint, impactFingerprint: deletePreview.impactFingerprint, expectedUpdatedAt: deletePreview.connection.updatedAt, confirmationName: disabledConnection.name },
      ownerGovernanceActor,
      db,
    );
    assert.equal(deleteResult.status, "completed");
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
  "MCP Package C1 PostgreSQL control plane enforces V2 attestation and durable grant revocation",
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
    const verifierId = id();
    const revokerId = id();
    const regularUserId = id();
    const workspaceId = id();
    const projectId = id();
    const attestationConnectionId = id();
    const grantConnectionId = id();
    const attestationDefinitionId = id();
    const grantDefinitionId = id();
    const secondGrantDefinitionId = id();
    const missingAuditDefinitionId = id();
    const attestationId = id();
    const grantAttestationId = id();
    const secondGrantAttestationId = id();
    const missingAuditAttestationId = id();
    const replacementAttestationId = id();
    const delegationId = id();
    const grantId = id();
    const healthyGrantId = id();
    const duplicateActiveGrantId = id();
    const replacementGrantId = id();
    const missingAuditGrantId = id();
    const nullVersionGrantId = id();
    const nullVersionAttestationId = id();
    const now = new Date();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1_000);
    let ownerMembership: { id: string; createdAt: Date } | null = null;
    let projectOwnerMembership: { id: string; createdAt: Date } | null = null;

    const insertAttestationRow = async (input: {
      attestationId: string;
      connectionId: string;
      definitionId: string;
      toolName: string;
      verifiedById: string;
      connectionConfigurationRevision?: number;
      definitionFingerprint?: string;
      conclusion?: string;
      riskLevel?: string;
      evidenceNote?: string;
      note?: string | null;
      evidence?: string;
    }): Promise<void> => {
      await client.query(
        `INSERT INTO "McpToolAttestation" (
           "id", "controlPlaneVersion", "status", "version", "connectionId", "toolDefinitionId", "toolName",
           "definitionFingerprint", "networkFingerprint", "credentialFingerprint", "conclusion", "riskLevel",
           "evidenceNote", "note", "connectionConfigurationRevision", "connectionOwnerAccountAccessVersion", "verifiedById", "evidence", "attestedAt", "createdAt"
         ) VALUES ($1::uuid, 2, 'active', 1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::uuid, $15::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          input.attestationId,
          input.connectionId,
          input.definitionId,
          input.toolName,
          input.definitionFingerprint ?? fingerprintD,
          fingerprintB,
          sentinel,
          input.conclusion ?? "read_only_verified",
          input.riskLevel ?? "medium",
          input.evidenceNote ?? "manual_read_only_review",
          input.note ?? null,
          input.connectionConfigurationRevision ?? 1,
          1,
          input.verifiedById,
          input.evidence ?? "{}",
        ],
      );
    };

    const insertAttestationAudit = async (input: {
      attestationId: string;
      connectionId: string;
      definitionId: string;
      event: "attested" | "revoked";
      actorId: string;
      version: number;
      statusBefore: "active" | null;
      statusAfter: "active" | "revoked";
      connectionConfigurationRevision: number;
      definitionFingerprint?: string;
    }): Promise<void> => {
      await client.query(
        `INSERT INTO "McpToolAttestationAudit" (
           "id", "attestationId", "connectionId", "toolDefinitionId", "event", "actorId", "controlPlaneVersion",
           "attestationVersion", "statusBefore", "statusAfter", "connectionConfigurationRevision", "connectionOwnerAccountAccessVersion",
           "definitionFingerprint", "networkFingerprint", "credentialFingerprint", "details", "createdAt"
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"McpToolAttestationAuditEvent", $6::uuid, 2,
           $7, $8::"McpToolAttestationStatus", $9::"McpToolAttestationStatus", $10, $11,
           $12, $13, $14, '{}'::jsonb, CURRENT_TIMESTAMP)`,
        [
          id(),
          input.attestationId,
          input.connectionId,
          input.definitionId,
          input.event,
          input.actorId,
          input.version,
          input.statusBefore,
          input.statusAfter,
          input.connectionConfigurationRevision,
          1,
          input.definitionFingerprint ?? fingerprintD,
          fingerprintB,
          sentinel,
        ],
      );
    };

    const createAttestation = async (input: {
      attestationId: string;
      connectionId: string;
      definitionId: string;
      toolName: string;
      verifiedById: string;
      definitionFingerprint?: string;
    }): Promise<void> => {
      await client.query("BEGIN");
      try {
        await insertAttestationRow(input);
        await insertAttestationAudit({
          attestationId: input.attestationId,
          connectionId: input.connectionId,
          definitionId: input.definitionId,
          event: "attested",
          actorId: input.verifiedById,
          version: 1,
          statusBefore: null,
          statusAfter: "active",
          connectionConfigurationRevision: 1,
          definitionFingerprint: input.definitionFingerprint,
        });
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
           ($5::uuid, $6, 'admin', CURRENT_TIMESTAMP),
           ($7::uuid, $8, 'admin', CURRENT_TIMESTAMP),
           ($9::uuid, $10, 'user', CURRENT_TIMESTAMP)`,
        [
          ownerId, `mcp_c1_owner_${suffix}`,
          projectOwnerId, `mcp_c1_project_owner_${suffix}`,
          verifierId, `mcp_c1_verifier_${suffix}`,
          revokerId, `mcp_c1_revoker_${suffix}`,
          regularUserId, `mcp_c1_user_${suffix}`,
        ],
      );
      await client.query(
        `INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt") VALUES ($1::uuid, $2, $3, NULL, CURRENT_TIMESTAMP)`,
        [workspaceId, `MCP C1 ${suffix}`, `mcp-c1-${suffix}`],
      );
      await client.query(
        `INSERT INTO "Project" ("id", "workspaceId", "name", "slug", "updatedAt") VALUES ($1::uuid, $2::uuid, $3, $4, CURRENT_TIMESTAMP)`,
        [projectId, workspaceId, `MCP C1 project ${suffix}`, `mcp-c1-project-${suffix}`],
      );
      await client.query("COMMIT");

      const db = getDb();
      const memberships = await db.$transaction(async (tx) => {
        await tx.workspace.update({ where: { id: workspaceId }, data: { createdById: ownerId } });
        await grantWorkspaceMembership(tx, { workspaceId, userId: ownerId, role: "owner", actorId: ownerId, reason: "MCP C1 owner fixture" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: ownerId, role: "owner", actorId: ownerId, reason: "MCP C1 owner fixture" });
        const projectOwner = await grantProjectMembership(tx, { projectId, workspaceId, userId: projectOwnerId, role: "owner", actorId: ownerId, reason: "MCP C1 project owner fixture" });
        return { owner: await tx.projectMembership.findFirstOrThrow({ where: { projectId, userId: ownerId, accessState: "confirmed" }, select: { id: true, createdAt: true } }), projectOwner };
      });
      ownerMembership = memberships.owner;
      projectOwnerMembership = memberships.projectOwner;

      for (const [connectionId, name] of [[attestationConnectionId, "attestation"], [grantConnectionId, "grant"]] as const) {
        await client.query(
          `INSERT INTO "McpConnection" (
             "id", "name", "endpointUrl", "authKind", "allowPrivateNetwork", "resolvedAddressFingerprint",
             "status", "createdById", "ownerUserId", "ownerAccountAccessVersion", "ownershipState", "updatedAt"
           ) VALUES ($1::uuid, $2, $3, 'none', false, $4, 'verified', $5::uuid, $5::uuid, 1, 'confirmed', CURRENT_TIMESTAMP)`,
          [connectionId, `MCP C1 ${name} ${suffix}`, `https://mcp.example.test/c1/${name}/${suffix}`, fingerprintB, ownerId],
        );
      }
      await client.query(
        `INSERT INTO "McpToolDefinition" ("id", "connectionId", "name", "inputSchema", "readOnlyEligible", "definitionFingerprint", "discoveredAt") VALUES
           ($1::uuid, $2::uuid, 'control.lookup', '{}'::jsonb, true, $3, CURRENT_TIMESTAMP),
           ($4::uuid, $5::uuid, 'project.lookup', '{}'::jsonb, true, $3, CURRENT_TIMESTAMP),
           ($6::uuid, $5::uuid, 'project.lookup.two', '{}'::jsonb, true, $7, CURRENT_TIMESTAMP),
           ($8::uuid, $5::uuid, 'project.lookup.three', '{}'::jsonb, true, $9, CURRENT_TIMESTAMP)`,
        [attestationDefinitionId, attestationConnectionId, fingerprintD, grantDefinitionId, grantConnectionId, secondGrantDefinitionId, fingerprintA, missingAuditDefinitionId, fingerprintC],
      );

      await createAttestation({ attestationId, connectionId: attestationConnectionId, definitionId: attestationDefinitionId, toolName: "control.lookup", verifiedById: verifierId });
      await createAttestation({ attestationId: grantAttestationId, connectionId: grantConnectionId, definitionId: grantDefinitionId, toolName: "project.lookup", verifiedById: verifierId, definitionFingerprint: fingerprintD });
      await createAttestation({ attestationId: secondGrantAttestationId, connectionId: grantConnectionId, definitionId: secondGrantDefinitionId, toolName: "project.lookup.two", verifiedById: verifierId, definitionFingerprint: fingerprintA });

      await client.query("BEGIN");
      await assert.rejects(
        () => insertAttestationRow({ attestationId: id(), connectionId: attestationConnectionId, definitionId: attestationDefinitionId, toolName: "control.lookup", verifiedById: regularUserId }),
        /MCP_TOOL_ATTESTATION_TUPLE_INVALID/u,
      );
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await assert.rejects(
        () => insertAttestationRow({ attestationId: id(), connectionId: attestationConnectionId, definitionId: attestationDefinitionId, toolName: "control.lookup", verifiedById: verifierId, connectionConfigurationRevision: 2 }),
        /MCP_TOOL_ATTESTATION_TUPLE_INVALID/u,
      );
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await assert.rejects(
        () => insertAttestationRow({ attestationId: id(), connectionId: attestationConnectionId, definitionId: attestationDefinitionId, toolName: "control.lookup", verifiedById: verifierId, evidence: '{"authorization":"Bearer token"}' }),
        /MCP_TOOL_ATTESTATION_TUPLE_INVALID/u,
      );
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await assert.rejects(
        () => insertAttestationRow({ attestationId: id(), connectionId: attestationConnectionId, definitionId: attestationDefinitionId, toolName: "control.lookup", verifiedById: verifierId, note: "Bearer token" }),
        /MCP_TOOL_ATTESTATION_TUPLE_INVALID/u,
      );
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await assert.rejects(
        () => insertAttestationRow({ attestationId: id(), connectionId: attestationConnectionId, definitionId: attestationDefinitionId, toolName: "control.lookup", verifiedById: verifierId, evidenceNote: "ciphertext" }),
        /MCP_TOOL_ATTESTATION_TUPLE_INVALID/u,
      );
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await assert.rejects(
        () => insertAttestationRow({ attestationId: id(), connectionId: attestationConnectionId, definitionId: attestationDefinitionId, toolName: "control.lookup", verifiedById: verifierId, riskLevel: "critical" }),
        /MCP_TOOL_ATTESTATION_TUPLE_INVALID/u,
      );
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await assert.rejects(
        () => insertAttestationRow({ attestationId: id(), connectionId: attestationConnectionId, definitionId: attestationDefinitionId, toolName: "control.lookup", verifiedById: verifierId }),
        /McpToolAttestation_v2_active_tuple_key/u,
      );
      await client.query("ROLLBACK");

      await client.query("BEGIN");
      await insertAttestationRow({ attestationId: id(), connectionId: grantConnectionId, definitionId: missingAuditDefinitionId, toolName: "project.lookup.three", verifiedById: revokerId, definitionFingerprint: fingerprintC });
      await assert.rejects(
        () => client.query("COMMIT"),
        /MCP_TOOL_ATTESTATION_AUDIT_REQUIRED/u,
      );
      await client.query("ROLLBACK").catch(() => undefined);
      await createAttestation({ attestationId: missingAuditAttestationId, connectionId: grantConnectionId, definitionId: missingAuditDefinitionId, toolName: "project.lookup.three", verifiedById: verifierId, definitionFingerprint: fingerprintC });

      await client.query("BEGIN");
      await assert.rejects(
        () => insertAttestationAudit({
          attestationId: grantAttestationId,
          connectionId: grantConnectionId,
          definitionId: grantDefinitionId,
          event: "attested",
          actorId: regularUserId,
          version: 1,
          statusBefore: null,
          statusAfter: "active",
          connectionConfigurationRevision: 1,
          definitionFingerprint: fingerprintD,
        }),
        /MCP_TOOL_ATTESTATION_AUDIT_SNAPSHOT_INVALID/u,
      );
      await client.query("ROLLBACK").catch(() => undefined);

      await client.query("BEGIN");
      await assert.rejects(
        () => insertAttestationAudit({
          attestationId: grantAttestationId,
          connectionId: grantConnectionId,
          definitionId: grantDefinitionId,
          event: "attested",
          actorId: verifierId,
          version: 1,
          statusBefore: null,
          statusAfter: "active",
          connectionConfigurationRevision: 1,
          definitionFingerprint: fingerprintD,
        }),
        /MCP_TOOL_ATTESTATION_AUDIT_DUPLICATE/u,
      );
      await client.query("ROLLBACK").catch(() => undefined);

      await client.query("BEGIN");
      await client.query(
        `UPDATE "McpToolAttestation" SET "status" = 'revoked', "version" = 2, "revokedById" = $2::uuid WHERE "id" = $1::uuid`,
        [attestationId, revokerId],
      );
      await insertAttestationAudit({
        attestationId,
        connectionId: attestationConnectionId,
        definitionId: attestationDefinitionId,
        event: "revoked",
        actorId: revokerId,
        version: 2,
        statusBefore: "active",
        statusAfter: "revoked",
        connectionConfigurationRevision: 1,
      });
      await client.query("COMMIT");
      await createAttestation({ attestationId: replacementAttestationId, connectionId: attestationConnectionId, definitionId: attestationDefinitionId, toolName: "control.lookup", verifiedById: verifierId });

      await client.query("BEGIN");
      await client.query(
        `UPDATE "McpToolAttestation" SET "status" = 'revoked', "version" = 2, "revokedById" = $2::uuid WHERE "id" = $1::uuid`,
        [grantAttestationId, revokerId],
      );
      await insertAttestationAudit({
        attestationId: grantAttestationId,
        connectionId: grantConnectionId,
        definitionId: grantDefinitionId,
        event: "revoked",
        actorId: revokerId,
        version: 2,
        statusBefore: "active",
        statusAfter: "revoked",
        connectionConfigurationRevision: 1,
        definitionFingerprint: fingerprintD,
      });
      await client.query("COMMIT");

      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await client.query(
        `INSERT INTO "ProjectMcpConnectionDelegation" (
           "id", "projectId", "mcpConnectionId", "connectionOwnerId", "connectionOwnerAccountAccessVersion", "connectionConfigurationRevision",
           "resolvedAddressFingerprint", "credentialFingerprint", "delegationFingerprint", "expiresAt", "version", "status",
           "ownerProjectMembershipId", "ownerMembershipCreatedAt", "projectConfirmedProjectMembershipId", "projectConfirmedMembershipCreatedAt",
           "proposedById", "proposedAt", "ownerConfirmedById", "ownerConfirmedAt", "projectConfirmedById", "projectConfirmedAt", "activatedAt", "createdAt", "updatedAt"
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 1, $5, $6, $7, $8::timestamp, 3, 'active',
           $9::uuid, $10::timestamp, $11::uuid, $12::timestamp, $4::uuid, $13::timestamp, $4::uuid, $13::timestamp,
           $14::uuid, $15::timestamp, $15::timestamp, $13::timestamp, $13::timestamp)`,
        [delegationId, projectId, grantConnectionId, ownerId, fingerprintB, sentinel, fingerprintC, sqlTimestamp(expiresAt), ownerMembership.id, sqlTimestamp(ownerMembership.createdAt), projectOwnerMembership.id, sqlTimestamp(projectOwnerMembership.createdAt), sqlTimestamp(now), projectOwnerId, sqlTimestamp(now)],
      );
      for (const [grantIdValue, attestationValue, definitionValue, toolName, definitionFingerprint] of [
        [grantId, grantAttestationId, grantDefinitionId, "project.lookup", fingerprintD],
        [missingAuditGrantId, missingAuditAttestationId, missingAuditDefinitionId, "project.lookup.three", fingerprintC],
        [healthyGrantId, secondGrantAttestationId, secondGrantDefinitionId, "project.lookup.two", fingerprintA],
      ] as const) {
        await client.query(
          `INSERT INTO "ProjectMcpToolGrant" (
             "id", "projectId", "connectionId", "delegationId", "controlPlaneVersion", "grantVersion", "toolName",
             "toolDefinitionId", "attestationId", "definitionFingerprint", "networkFingerprint", "credentialFingerprint",
             "delegationVersion", "delegationFingerprint", "connectionConfigurationRevision", "connectionOwnerAccountAccessVersion", "grantorProjectMembershipId",
             "grantorMembershipCreatedAt", "status", "managedById", "acknowledgedAt", "creationTransactionId", "createdAt", "updatedAt"
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 2, 1, $5, $6::uuid, $7::uuid, $8, $9, $10,
             3, $11, 1, 1, $12::uuid, $13::timestamp, 'active', $14::uuid, CURRENT_TIMESTAMP, txid_current(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [grantIdValue, projectId, grantConnectionId, delegationId, toolName, definitionValue, attestationValue, definitionFingerprint, fingerprintB, sentinel, fingerprintC, ownerMembership.id, sqlTimestamp(ownerMembership.createdAt), ownerId],
        );
        await client.query(
          `INSERT INTO "ProjectMcpToolGrantAudit" (
             "id", "projectId", "grantId", "event", "actorId", "controlPlaneVersion", "grantVersion", "statusBefore", "statusAfter",
           "delegationVersion", "delegationFingerprint", "connectionConfigurationRevision", "grantorProjectMembershipId", "grantorMembershipCreatedAt",
           "connectionOwnerAccountAccessVersion", "definitionFingerprint", "details", "transactionId"
         ) SELECT $2::uuid, "projectId", "id", 'granted', "managedById", 2, 1, NULL, 'active', "delegationVersion", "delegationFingerprint",
             "connectionConfigurationRevision", "grantorProjectMembershipId", "grantorMembershipCreatedAt", "connectionOwnerAccountAccessVersion",
             "definitionFingerprint", '{}'::jsonb, "creationTransactionId"
           FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`,
          [grantIdValue, id()],
        );
        await client.query(
          `INSERT INTO "ProjectMcpToolGrantLedger" (
             "id", "projectId", "grantId", "connectionId", "delegationId", "toolDefinitionId", "attestationId", "connectionOwnerId", "connectionOwnerAccountAccessVersion", "toolName",
             "controlPlaneVersion", "grantVersion", "event", "statusBefore", "statusAfter", "actorId", "actorProjectMembershipId",
             "actorMembershipCreatedAt", "delegationVersion", "delegationFingerprint", "connectionConfigurationRevision",
             "grantorProjectMembershipId", "grantorMembershipCreatedAt", "definitionFingerprint", "networkFingerprint",
             "credentialFingerprint", "acknowledgedAt", "transactionId"
           ) SELECT $2::uuid, "projectId", "id", "connectionId", "delegationId", "toolDefinitionId", "attestationId", $3::uuid, "connectionOwnerAccountAccessVersion", "toolName",
             2, 1, 'granted', NULL, 'active', "managedById", "grantorProjectMembershipId", "grantorMembershipCreatedAt", "delegationVersion",
             "delegationFingerprint", "connectionConfigurationRevision", "grantorProjectMembershipId", "grantorMembershipCreatedAt", "definitionFingerprint",
             "networkFingerprint", "credentialFingerprint", "acknowledgedAt", "creationTransactionId"
           FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`,
          [grantIdValue, id(), ownerId],
        );
      }
      await client.query("COMMIT");

      const healthyTuple = await client.query<{ valid: boolean }>(
        `SELECT "project_mcp_tool_grant_v2_tuple_valid"("ProjectMcpToolGrant") AS valid
         FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`,
        [healthyGrantId],
      );
      assert.equal(healthyTuple.rows[0]?.valid, true);

      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await assert.rejects(
        () => client.query(
          `INSERT INTO "ProjectMcpToolGrant" (
             "id", "projectId", "connectionId", "delegationId", "controlPlaneVersion", "grantVersion", "toolName",
             "toolDefinitionId", "attestationId", "definitionFingerprint", "networkFingerprint", "credentialFingerprint",
             "delegationVersion", "delegationFingerprint", "connectionConfigurationRevision", "grantorProjectMembershipId",
             "grantorMembershipCreatedAt", "status", "managedById", "acknowledgedAt", "createdAt", "updatedAt"
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 2, NULL, 'project.lookup.null-version', $5::uuid, $6::uuid, $7, $8, $9,
             3, $10, 1, $11::uuid, $12::timestamp, 'active', $13::uuid, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [nullVersionGrantId, projectId, grantConnectionId, delegationId, secondGrantDefinitionId, secondGrantAttestationId, fingerprintA, fingerprintB, sentinel, fingerprintC, ownerMembership!.id, sqlTimestamp(ownerMembership!.createdAt), ownerId],
        ),
        /ProjectMcpToolGrant_v2_creation_transaction_check/u,
      );
      await client.query("ROLLBACK").catch(() => undefined);
      assert.equal((await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`, [nullVersionGrantId])).rows[0]?.count, 0);

      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await assert.rejects(
        () => client.query(
          `INSERT INTO "McpToolAttestation" (
             "id", "controlPlaneVersion", "status", "version", "connectionId", "toolDefinitionId", "toolName",
             "definitionFingerprint", "networkFingerprint", "credentialFingerprint", "conclusion", "riskLevel",
             "evidenceNote", "connectionConfigurationRevision", "verifiedById", "evidence", "attestedAt", "createdAt"
           ) VALUES ($1::uuid, 2, 'active', NULL, $2::uuid, $3::uuid, 'project.lookup.two', $4, $5, $6,
             'read_only_verified', 'medium', 'manual_read_only_review', 1, $7::uuid, '{}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [nullVersionAttestationId, grantConnectionId, secondGrantDefinitionId, fingerprintC, fingerprintB, sentinel, verifierId],
        ),
        /McpToolAttestation_v2_shape_check/u,
      );
      await client.query("ROLLBACK").catch(() => undefined);
      assert.equal((await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM "McpToolAttestation" WHERE "id" = $1::uuid`, [nullVersionAttestationId])).rows[0]?.count, 0);

      const [revoker, verifier] = await Promise.all([
        db.appUser.findUniqueOrThrow({ where: { id: revokerId }, select: { accountAccessVersion: true } }),
        db.appUser.findUniqueOrThrow({ where: { id: verifierId }, select: { accountAccessVersion: true, username: true } }),
      ]);
      const verifierDisablePreview = await previewAccountAccess({
        adminUserId: revokerId,
        adminAccountAccessVersion: revoker.accountAccessVersion,
        userId: verifierId,
        action: "disable",
        reason: "MCP C1 verifier access revoked",
        expectedVersion: verifier.accountAccessVersion,
      }, db);
      assert.equal(verifierDisablePreview.canExecute, true);
      await executeAccountAccess({
        adminUserId: revokerId,
        adminAccountAccessVersion: revoker.accountAccessVersion,
        userId: verifierId,
        action: "disable",
        reason: "MCP C1 verifier access revoked",
        expectedVersion: verifierDisablePreview.current.accountAccessVersion,
        expectedImpactFingerprint: verifierDisablePreview.impactFingerprint,
        requestKey: `mcp-c1-verifier-disable-${suffix}`,
        requestFingerprint: verifierDisablePreview.requestFingerprint,
        previewId: verifierDisablePreview.previewId,
        previewIssuedAt: verifierDisablePreview.previewIssuedAt,
        previewExpiresAt: verifierDisablePreview.previewExpiresAt,
        confirmation: true,
        confirmationUsername: verifier.username,
      }, db);
      const attestationConnection = await db.mcpConnection.findUniqueOrThrow({ where: { id: attestationConnectionId }, select: { updatedAt: true } });
      const ownerGovernanceActor = { id: ownerId, accountAccessVersion: 1 };
      const disablePreview = await previewMcpConnectionMutation(
        attestationConnectionId,
        { action: "disable", requestKey: `mcp-c1-disable-${suffix}`, reason: "MCP C1 governed attestation lifecycle", expectedUpdatedAt: attestationConnection.updatedAt.toISOString() },
        ownerGovernanceActor,
        db,
      );
      assert.equal(disablePreview.canExecute, true);
      const disableResult = await executeMcpConnectionMutation(
        attestationConnectionId,
        { previewId: disablePreview.id, requestKey: disablePreview.requestKey, requestFingerprint: disablePreview.requestFingerprint, impactFingerprint: disablePreview.impactFingerprint, expectedUpdatedAt: disablePreview.connection.updatedAt },
        ownerGovernanceActor,
        db,
      );
      assert.equal(disableResult.status, "completed");
      await client.query(`UPDATE "McpToolDefinition" SET "current" = false, "supersededAt" = CURRENT_TIMESTAMP WHERE "id" = $1::uuid`, [attestationDefinitionId]);
      await client.query("BEGIN");
      await client.query(
        `UPDATE "McpToolAttestation" SET "status" = 'revoked', "version" = 2, "revokedById" = $2::uuid WHERE "id" = $1::uuid`,
        [replacementAttestationId, revokerId],
      );
      await insertAttestationAudit({
        attestationId: replacementAttestationId,
        connectionId: attestationConnectionId,
        definitionId: attestationDefinitionId,
        event: "revoked",
        actorId: revokerId,
        version: 2,
        statusBefore: "active",
        statusAfter: "revoked",
        connectionConfigurationRevision: 1,
      });
      await client.query("COMMIT");
      const revokedAttestation = await client.query<{ status: string; version: number; revocationTransactionId: string | null }>(
        `SELECT "status", "version", "revocationTransactionId" FROM "McpToolAttestation" WHERE "id" = $1::uuid`, [replacementAttestationId],
      );
      assert.equal(revokedAttestation.rows[0]?.status, "revoked");
      assert.equal(revokedAttestation.rows[0]?.version, 2);
      assert.match(revokedAttestation.rows[0]?.revocationTransactionId ?? "", /^\d+$/u);
      await client.query("BEGIN");
      await assert.rejects(
        () => insertAttestationAudit({
          attestationId: replacementAttestationId,
          connectionId: attestationConnectionId,
          definitionId: attestationDefinitionId,
          event: "revoked",
          actorId: revokerId,
          version: 2,
          statusBefore: "active",
          statusAfter: "revoked",
          connectionConfigurationRevision: 1,
        }),
        /MCP_TOOL_ATTESTATION_AUDIT_STATE_INVALID/u,
      );
      await client.query("ROLLBACK").catch(() => undefined);

      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await assert.rejects(
        () => client.query(
          `INSERT INTO "ProjectMcpToolGrant" (
             "id", "projectId", "connectionId", "delegationId", "controlPlaneVersion", "grantVersion", "toolName",
             "toolDefinitionId", "attestationId", "definitionFingerprint", "networkFingerprint", "credentialFingerprint",
             "delegationVersion", "delegationFingerprint", "connectionConfigurationRevision", "grantorProjectMembershipId",
             "grantorMembershipCreatedAt", "status", "managedById", "acknowledgedAt", "creationTransactionId", "createdAt", "updatedAt"
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 2, 1, 'project.lookup', $5::uuid, $6::uuid, $7, $8, $9, 3, $10, 1, $11::uuid, $12::timestamp, 'active', $13::uuid, CURRENT_TIMESTAMP, txid_current(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [duplicateActiveGrantId, projectId, grantConnectionId, delegationId, grantDefinitionId, grantAttestationId, fingerprintD, fingerprintB, sentinel, fingerprintC, ownerMembership!.id, sqlTimestamp(ownerMembership!.createdAt), ownerId],
        ),
        /ProjectMcpToolGrant_active_project_connection_tool_key/u,
      );
      await client.query("ROLLBACK").catch(() => undefined);

      await assert.rejects(
        () => client.query(
          `INSERT INTO "ProjectMcpToolGrant" (
             "id", "projectId", "connectionId", "toolName", "toolDefinitionId", "status", "managedById", "acknowledgedAt", "updatedAt"
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'legacy.lookup', $4::uuid, 'active', $5::uuid, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [id(), projectId, grantConnectionId, grantDefinitionId, ownerId],
        ),
        /PROJECT_MCP_TOOL_GRANT_INSERT_FROZEN/u,
      );

      await client.query("BEGIN");
      await assert.rejects(
        () => client.query(
          `UPDATE "ProjectMcpToolGrant" SET "status" = 'revoked', "grantVersion" = 2, "revokedById" = $2::uuid, "revokerProjectMembershipId" = $3::uuid, "revokerMembershipCreatedAt" = $4::timestamp WHERE "id" = $1::uuid`,
          [grantId, regularUserId, projectOwnerMembership!.id, sqlTimestamp(projectOwnerMembership!.createdAt)],
        ),
        /PROJECT_MCP_TOOL_GRANT_V2_REVOKER_INVALID/u,
      );
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query("BEGIN");
      await assert.rejects(
        () => client.query(
          `UPDATE "ProjectMcpToolGrant" SET "status" = 'revoked', "grantVersion" = 2, "revokedById" = $2::uuid, "revokerProjectMembershipId" = $3::uuid, "revokerMembershipCreatedAt" = $4::timestamp WHERE "id" = $1::uuid`,
          [grantId, projectOwnerId, projectOwnerMembership!.id, sqlTimestamp(new Date(0))],
        ),
        /PROJECT_MCP_TOOL_GRANT_V2_REVOKER_INVALID/u,
      );
      await client.query("ROLLBACK").catch(() => undefined);
      const activeBeforeDrift = await client.query<{ status: string; revokedById: string | null; revocationTransactionId: string | null }>(
        `SELECT "status", "revokedById", "revocationTransactionId" FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`, [grantId],
      );
      assert.equal(activeBeforeDrift.rows[0]?.status, "active");
      assert.equal(activeBeforeDrift.rows[0]?.revokedById, null);
      assert.equal(activeBeforeDrift.rows[0]?.revocationTransactionId, null);

      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await client.query(
        `UPDATE "ProjectMcpConnectionDelegation" SET "status" = 'revoked', "version" = 4, "delegationFingerprint" = $2, "connectionConfigurationRevision" = 2 WHERE "id" = $1::uuid`,
        [delegationId, fingerprintA],
      );
      await client.query(
        `UPDATE "McpConnection" SET "status" = 'disabled', "disabledAt" = CURRENT_TIMESTAMP, "configurationRevision" = 2, "resolvedAddressFingerprint" = $2 WHERE "id" = $1::uuid`,
        [grantConnectionId, fingerprintA],
      );
      await client.query(`UPDATE "McpToolDefinition" SET "current" = false, "supersededAt" = CURRENT_TIMESTAMP WHERE "id" = $1::uuid`, [grantDefinitionId]);
      await client.query(`UPDATE "ProjectMembership" SET "accessState" = 'revoked' WHERE "id" = $1::uuid`, [ownerMembership.id]);
      await client.query("COMMIT");

      const driftedTuple = await client.query<{ valid: boolean }>(
        `SELECT "project_mcp_tool_grant_v2_tuple_valid"("ProjectMcpToolGrant") AS valid
         FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`,
        [healthyGrantId],
      );
      assert.equal(driftedTuple.rows[0]?.valid, false);

      await client.query("BEGIN");
      await client.query(
        `UPDATE "ProjectMcpToolGrant" SET "status" = 'revoked', "grantVersion" = 2, "revokedById" = $2::uuid, "revokerProjectMembershipId" = $3::uuid, "revokerMembershipCreatedAt" = $4::timestamp WHERE "id" = $1::uuid`,
        [grantId, projectOwnerId, projectOwnerMembership.id, sqlTimestamp(projectOwnerMembership.createdAt)],
      );
      await client.query(
        `INSERT INTO "ProjectMcpToolGrantAudit" (
           "id", "projectId", "grantId", "event", "actorId", "controlPlaneVersion", "grantVersion", "statusBefore", "statusAfter",
           "delegationVersion", "delegationFingerprint", "connectionConfigurationRevision", "connectionOwnerAccountAccessVersion", "grantorProjectMembershipId", "grantorMembershipCreatedAt",
           "revokerProjectMembershipId", "revokerMembershipCreatedAt", "definitionFingerprint", "details"
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'revoked', $4::uuid, 2, 2, 'active', 'revoked', 3, $5, 1, 1, $6::uuid, $7::timestamp, $8::uuid, $9::timestamp, $10, '{}'::jsonb)`,
        [id(), projectId, grantId, projectOwnerId, fingerprintC, ownerMembership.id, sqlTimestamp(ownerMembership.createdAt), projectOwnerMembership.id, sqlTimestamp(projectOwnerMembership.createdAt), fingerprintD],
      );
      await client.query(
        `INSERT INTO "ProjectMcpToolGrantLedger" (
           "id", "projectId", "grantId", "connectionId", "delegationId", "toolDefinitionId", "attestationId", "toolName",
           "controlPlaneVersion", "grantVersion", "event", "statusBefore", "statusAfter", "actorId", "actorProjectMembershipId",
           "actorMembershipCreatedAt", "delegationVersion", "delegationFingerprint", "connectionConfigurationRevision",
           "grantorProjectMembershipId", "grantorMembershipCreatedAt", "revokerProjectMembershipId", "revokerMembershipCreatedAt", "connectionOwnerId", "connectionOwnerAccountAccessVersion",
           "definitionFingerprint", "networkFingerprint", "credentialFingerprint", "acknowledgedAt"
         ) SELECT $2::uuid, "projectId", "id", "connectionId", "delegationId", "toolDefinitionId", "attestationId", "toolName",
           2, 2, 'revoked', 'active', 'revoked', "revokedById", "revokerProjectMembershipId", "revokerMembershipCreatedAt", "delegationVersion",
           "delegationFingerprint", "connectionConfigurationRevision", "grantorProjectMembershipId", "grantorMembershipCreatedAt", "revokerProjectMembershipId",
           "revokerMembershipCreatedAt", $3::uuid, "connectionOwnerAccountAccessVersion", "definitionFingerprint", "networkFingerprint", "credentialFingerprint", "acknowledgedAt"
         FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`,
        [grantId, id(), ownerId],
      );
      await client.query("COMMIT");
      const durableGrant = await client.query<{ status: string; grantVersion: number; managedById: string; revokedById: string | null; revocationTransactionId: string | null }>(
        `SELECT "status", "grantVersion", "managedById", "revokedById", "revocationTransactionId" FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`, [grantId],
      );
      assert.equal(durableGrant.rows[0]?.status, "revoked");
      assert.equal(durableGrant.rows[0]?.grantVersion, 2);
      assert.equal(durableGrant.rows[0]?.managedById, ownerId);
      assert.equal(durableGrant.rows[0]?.revokedById, projectOwnerId);
      assert.match(durableGrant.rows[0]?.revocationTransactionId ?? "", /^\d+$/u);

      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await client.query(
          `INSERT INTO "ProjectMcpToolGrant" (
             "id", "projectId", "connectionId", "delegationId", "controlPlaneVersion", "grantVersion", "toolName",
             "toolDefinitionId", "attestationId", "definitionFingerprint", "networkFingerprint", "credentialFingerprint",
             "delegationVersion", "delegationFingerprint", "connectionConfigurationRevision", "grantorProjectMembershipId",
             "grantorMembershipCreatedAt", "status", "managedById", "acknowledgedAt", "creationTransactionId", "createdAt", "updatedAt"
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 2, 1, 'project.lookup', $5::uuid, $6::uuid, $7, $8, $9, 3, $10, 1, $11::uuid, $12::timestamp, 'active', $13::uuid, CURRENT_TIMESTAMP, txid_current(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [replacementGrantId, projectId, grantConnectionId, delegationId, grantDefinitionId, grantAttestationId, fingerprintD, fingerprintB, sentinel, fingerprintC, ownerMembership!.id, sqlTimestamp(ownerMembership!.createdAt), ownerId],
      );
      await client.query("COMMIT");
      const grantRows = await client.query<{ id: string; status: string }>(
        `SELECT "id", "status" FROM "ProjectMcpToolGrant" WHERE "projectId" = $1::uuid AND "connectionId" = $2::uuid AND "toolName" = 'project.lookup' ORDER BY "createdAt", "id"`,
        [projectId, grantConnectionId],
      );
      assert.deepEqual(grantRows.rows.map((row) => row.status).sort(), ["active", "revoked"]);
      assert.equal((await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM "ProjectMcpToolGrantAudit" WHERE "grantId" = $1::uuid`, [grantId])).rows[0]?.count, 2);

      await assert.rejects(
        () => client.query(`UPDATE "ProjectMcpToolGrant" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1::uuid`, [grantId]),
        /PROJECT_MCP_TOOL_GRANT_REVOKED_IMMUTABLE/u,
      );

      await client.query("BEGIN");
      await client.query(
        `UPDATE "ProjectMcpToolGrant" SET "status" = 'revoked', "grantVersion" = 2, "revokedById" = $2::uuid, "revokerProjectMembershipId" = $3::uuid, "revokerMembershipCreatedAt" = $4::timestamp WHERE "id" = $1::uuid`,
        [missingAuditGrantId, projectOwnerId, projectOwnerMembership.id, sqlTimestamp(projectOwnerMembership.createdAt)],
      );
      await assert.rejects(() => client.query("COMMIT"), /PROJECT_MCP_TOOL_GRANT_REVOKE_AUDIT_REQUIRED/u);
      await client.query("ROLLBACK").catch(() => undefined);
      assert.equal((await client.query<{ status: string; revocationTransactionId: string | null }>(`SELECT "status", "revocationTransactionId" FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`, [missingAuditGrantId])).rows[0]?.status, "active");
      assert.equal((await client.query<{ revocationTransactionId: string | null }>(`SELECT "revocationTransactionId" FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`, [missingAuditGrantId])).rows[0]?.revocationTransactionId, null);

      const disabledAttestationConnection = await db.mcpConnection.findUniqueOrThrow({ where: { id: attestationConnectionId }, select: { name: true, updatedAt: true } });
      const deletePreview = await previewMcpConnectionMutation(
        attestationConnectionId,
        { action: "delete", requestKey: `mcp-c1-delete-${suffix}`, reason: "MCP C1 permanent attestation retention", expectedUpdatedAt: disabledAttestationConnection.updatedAt.toISOString(), confirmationName: disabledAttestationConnection.name },
        ownerGovernanceActor,
        db,
      );
      assert.equal(deletePreview.canExecute, false);
      assert.ok(deletePreview.blockers.includes("permanent_v2_attestation"));
      assert.equal((await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM "McpToolAttestationAudit" WHERE "attestationId" = $1::uuid`, [replacementAttestationId])).rows[0]?.count, 2);
      assert.equal((await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM "McpToolAttestation" WHERE "id" = $1::uuid`, [replacementAttestationId])).rows[0]?.count, 1);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query("BEGIN").catch(() => undefined);
      await client.query("SET LOCAL session_replication_role = 'replica'").catch(() => undefined);
      await client.query(`DELETE FROM "ProjectMcpToolGrantLedger" WHERE "grantId" = ANY($1::uuid[])`, [[grantId, healthyGrantId, replacementGrantId, missingAuditGrantId, nullVersionGrantId]]).catch(() => undefined);
      await client.query(`DELETE FROM "McpToolAttestationAudit" WHERE "attestationId" = ANY($1::uuid[])`, [[attestationId, replacementAttestationId, grantAttestationId, secondGrantAttestationId, missingAuditAttestationId, nullVersionAttestationId]]).catch(() => undefined);
      await client.query(`DELETE FROM "McpToolAttestation" WHERE "id" = ANY($1::uuid[])`, [[attestationId, replacementAttestationId, grantAttestationId, secondGrantAttestationId, missingAuditAttestationId, nullVersionAttestationId]]).catch(() => undefined);
      await client.query(`DELETE FROM "ProjectMcpToolGrantAudit" WHERE "grantId" = ANY($1::uuid[])`, [[grantId, healthyGrantId, replacementGrantId, missingAuditGrantId, nullVersionGrantId]]).catch(() => undefined);
      await client.query(`DELETE FROM "ProjectMcpToolGrant" WHERE "id" = ANY($1::uuid[])`, [[grantId, healthyGrantId, replacementGrantId, missingAuditGrantId, nullVersionGrantId]]).catch(() => undefined);
      await client.query(`DELETE FROM "ProjectMcpConnectionDelegation" WHERE "id" = $1::uuid`, [delegationId]).catch(() => undefined);
      await client.query(`DELETE FROM "Project" WHERE "id" = $1::uuid`, [projectId]).catch(() => undefined);
      await client.query(`DELETE FROM "McpToolDefinition" WHERE "id" = ANY($1::uuid[])`, [[attestationDefinitionId, grantDefinitionId, secondGrantDefinitionId, missingAuditDefinitionId]]).catch(() => undefined);
      await client.query(`DELETE FROM "McpConnection" WHERE "id" = ANY($1::uuid[])`, [[attestationConnectionId, grantConnectionId]]).catch(() => undefined);
      await client.query(`DELETE FROM "Workspace" WHERE "id" = $1::uuid`, [workspaceId]).catch(() => undefined);
      await client.query(`DELETE FROM "AppUser" WHERE "id" = ANY($1::uuid[])`, [[ownerId, projectOwnerId, verifierId, revokerId, regularUserId]]).catch(() => undefined);
      await client.query("COMMIT").catch(() => undefined);
    }
  },
);

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
             "id", "projectId", "mcpConnectionId", "connectionOwnerId", "connectionOwnerAccountAccessVersion", "connectionConfigurationRevision",
             "resolvedAddressFingerprint", "credentialFingerprint", "delegationFingerprint", "expiresAt",
             "ownerProjectMembershipId", "ownerMembershipCreatedAt", "proposedById", "updatedAt"
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 1, $5, $6, $7, CURRENT_TIMESTAMP + interval '1 hour', $8::uuid, $9::timestamp, $4::uuid, CURRENT_TIMESTAMP)`,
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
        `INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt") VALUES ($1::uuid, $2, $3, NULL, CURRENT_TIMESTAMP)`,
        [workspaceId, `MCP terminal ${suffix}`, `mcp-terminal-${suffix}`],
      );
      await client.query(
        `INSERT INTO "Project" ("id", "workspaceId", "name", "slug", "updatedAt") VALUES ($1::uuid, $2::uuid, $3, $4, CURRENT_TIMESTAMP)`,
        [projectId, workspaceId, `MCP terminal project ${suffix}`, `mcp-terminal-project-${suffix}`],
      );
      for (const [index, connectionId] of connectionIds.entries()) {
        await client.query(
          `INSERT INTO "McpConnection" (
             "id", "name", "endpointUrl", "authKind", "allowPrivateNetwork", "resolvedAddressFingerprint",
             "status", "createdById", "ownerUserId", "ownerAccountAccessVersion", "ownershipState", "updatedAt"
           ) VALUES ($1::uuid, $2, $3, 'none', false, $4, 'verified', $5::uuid, $5::uuid, 1, 'confirmed', CURRENT_TIMESTAMP)`,
          [connectionId, `MCP terminal connection ${index} ${suffix}`, `https://mcp.example.test/terminal/${index}`, fingerprintB, ownerId],
        );
      }
      await client.query("COMMIT");

      const db = getDb();
      const memberships = await db.$transaction(async (tx) => {
        await tx.workspace.update({ where: { id: workspaceId }, data: { createdById: ownerId } });
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
  "MCP Package B PostgreSQL service enforces lifecycle admission, frozen epochs, expiry and connection deletion",
  { skip: !shouldRun ? "PROJECT_MCP_DELEGATION_POSTGRES_GATE=1 is required" : false },
  async (context) => {
    assertDisposableGateDatabase();
    const databaseUrl = process.env.DATABASE_URL!;
    const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
    await client.connect();
    context.after(() => client.end());

    const db = getDb();
    const positiveTimeZoneDb = timeZoneDatabase("Asia/Shanghai");
    const negativeTimeZoneDb = timeZoneDatabase("America/Los_Angeles");
    context.after(async () => {
      await positiveTimeZoneDb.$disconnect();
      await negativeTimeZoneDb.$disconnect();
    });
    const positiveTimeZone = await positiveTimeZoneDb.$queryRaw<Array<{ timeZone: string }>>(Prisma.sql`SELECT current_setting('TimeZone') AS "timeZone"`);
    const negativeTimeZone = await negativeTimeZoneDb.$queryRaw<Array<{ timeZone: string }>>(Prisma.sql`SELECT current_setting('TimeZone') AS "timeZone"`);
    assert.equal(positiveTimeZone[0]?.timeZone, "Asia/Shanghai");
    assert.equal(negativeTimeZone[0]?.timeZone, "America/Los_Angeles");
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const ownerId = id();
    const projectOwnerId = id();
    const viewerId = id();
    const workspaceAdminId = id();
    const foreignOwnerId = id();
    const workspaceId = id();
    const projectId = id();
    const ownerConnectionId = id();
    const ownerConnectionTwoId = id();
    const ownerCredentialId = id();
    const ownerConnectionTwoCredentialId = id();
    const dueConnectionId = id();
    const deleteGuardConnectionId = id();
    const foreignConnectionId = id();
    const adminConnectionId = id();
    let ownerMembership: { id: string; createdAt: Date } | null = null;
    const ownerActor = { id: ownerId, role: "user" as const, accountAccessVersion: 1 };
    const projectOwnerActor = { id: projectOwnerId, role: "user" as const, accountAccessVersion: 1 };
    const viewerActor = { id: viewerId, role: "user" as const, accountAccessVersion: 1 };
    const workspaceAdminActor = { id: workspaceAdminId, role: "admin" as const, accountAccessVersion: 1 };
    const foreignOwnerActor = { id: foreignOwnerId, role: "user" as const, accountAccessVersion: 1 };
    type DelegationViewLike = Readonly<{
      id: string;
      recordStatus: string;
      version: number;
      connection: { id: string; name: string } | null;
      effectiveEligibility: { reason: string | null };
      terminalReason: string | null;
      capabilities: { canReject: boolean; canRevoke: boolean };
    }>;
    const view = (value: unknown): DelegationViewLike => value as DelegationViewLike;

    const futureExpiry = (): string => new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const proposalInput = (mcpConnectionId: string) => ({ mcpConnectionId, expiresAt: futureExpiry() });

    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO "AppUser" ("id", "username", "role", "updatedAt") VALUES
           ($1::uuid, $2, 'user', CURRENT_TIMESTAMP),
           ($3::uuid, $4, 'user', CURRENT_TIMESTAMP),
           ($5::uuid, $6, 'user', CURRENT_TIMESTAMP),
           ($7::uuid, $8, 'admin', CURRENT_TIMESTAMP),
           ($9::uuid, $10, 'user', CURRENT_TIMESTAMP)`,
        [
          ownerId, `mcp_b_owner_${suffix}`,
          projectOwnerId, `mcp_b_project_owner_${suffix}`,
          viewerId, `mcp_b_viewer_${suffix}`,
          workspaceAdminId, `mcp_b_workspace_admin_${suffix}`,
          foreignOwnerId, `mcp_b_foreign_owner_${suffix}`,
        ],
      );
      await client.query(
        `INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt") VALUES ($1::uuid, $2, $3, NULL, CURRENT_TIMESTAMP)`,
        [workspaceId, `MCP Package B ${suffix}`, `mcp-package-b-${suffix}`],
      );
      await client.query(
        `INSERT INTO "Project" ("id", "workspaceId", "membershipInheritanceMode", "name", "slug", "updatedAt") VALUES ($1::uuid, $2::uuid, 'workspace_inherited', $3, $4, CURRENT_TIMESTAMP)`,
        [projectId, workspaceId, `MCP Package B project ${suffix}`, `mcp-package-b-project-${suffix}`],
      );
      await client.query(
        `INSERT INTO "ExternalCredential" ("id", "kind", "ciphertext", "nonce", "authTag", "maskedSuffix", "secretFingerprint", "updatedAt") VALUES
           ($1::uuid, 'mcp', decode('01', 'hex'), decode('02', 'hex'), decode('03', 'hex'), 'gate', $3, CURRENT_TIMESTAMP),
           ($2::uuid, 'mcp', decode('04', 'hex'), decode('05', 'hex'), decode('06', 'hex'), 'gate', $3, CURRENT_TIMESTAMP)`,
        [ownerCredentialId, ownerConnectionTwoCredentialId, fingerprintA],
      );
      for (const [connectionId, name, owner, authKind, credentialId] of [
        [ownerConnectionId, "same-name", ownerId, "bearer", ownerCredentialId],
        [ownerConnectionTwoId, `owner-second-${suffix}`, ownerId, "bearer", ownerConnectionTwoCredentialId],
        [dueConnectionId, `due-${suffix}`, ownerId, "none", null],
        [deleteGuardConnectionId, `delete-guard-${suffix}`, ownerId, "none", null],
        [foreignConnectionId, "same-name", foreignOwnerId, "none", null],
        [adminConnectionId, `admin-${suffix}`, workspaceAdminId, "none", null],
      ] as const) {
        await client.query(
          `INSERT INTO "McpConnection" (
             "id", "name", "endpointUrl", "authKind", "credentialId", "allowPrivateNetwork", "resolvedAddressFingerprint",
             "status", "createdById", "ownerUserId", "ownerAccountAccessVersion", "ownershipState", "updatedAt"
           ) VALUES ($1::uuid, $2, $3, $4::"McpAuthKind", $5::uuid, false, $6, 'verified', $7::uuid, $7::uuid, 1, 'confirmed', CURRENT_TIMESTAMP)`,
          [connectionId, name, `https://mcp.example.test/package-b/${connectionId}`, authKind, credentialId, fingerprintB, owner],
        );
      }
      await client.query("COMMIT");

      const memberships = await db.$transaction(async (tx) => {
        await tx.workspace.update({ where: { id: workspaceId }, data: { createdById: ownerId } });
        await grantWorkspaceMembership(tx, { workspaceId, userId: ownerId, role: "owner", actorId: ownerId, reason: "MCP Package B owner fixture" });
        await grantWorkspaceMembership(tx, { workspaceId, userId: projectOwnerId, role: "owner", actorId: ownerId, reason: "MCP Package B project owner fixture" });
        await grantWorkspaceMembership(tx, { workspaceId, userId: viewerId, role: "member", actorId: ownerId, reason: "MCP Package B viewer fixture" });
        await grantWorkspaceMembership(tx, { workspaceId, userId: workspaceAdminId, role: "admin", actorId: ownerId, reason: "MCP Package B workspace admin fixture" });
        const owner = await grantProjectMembership(tx, { projectId, workspaceId, userId: ownerId, role: "owner", actorId: ownerId, reason: "MCP Package B owner fixture" });
        const projectOwner = await grantProjectMembership(tx, { projectId, workspaceId, userId: projectOwnerId, role: "owner", actorId: ownerId, reason: "MCP Package B project owner fixture" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: viewerId, role: "viewer", actorId: ownerId, reason: "MCP Package B viewer fixture" });
        return { owner, projectOwner };
      });
      ownerMembership = memberships.owner;

      const ownerListing = await listProjectMcpConnectionDelegations(projectId, ownerActor, db);
      assert.ok(ownerListing.connections.some((connection) => connection.id === ownerConnectionId));
      assert.ok(!ownerListing.connections.some((connection) => connection.id === foreignConnectionId));
      assert.ok(!ownerListing.connections.some((connection) => connection.id === adminConnectionId));

      await assertDelegationServiceError(
        () => proposeProjectMcpConnectionDelegation(projectId, proposalInput(foreignConnectionId), ownerActor, db),
        "PROJECT_MCP_CONNECTION_DELEGATION_CONNECTION_NOT_FOUND",
      );
      await assertDelegationServiceError(
        () => proposeProjectMcpConnectionDelegation(projectId, proposalInput(adminConnectionId), workspaceAdminActor, db),
        "PROJECT_MCP_CONNECTION_DELEGATION_MEMBERSHIP_REQUIRED",
      );

      const proposed = view(await proposeProjectMcpConnectionDelegation(projectId, proposalInput(ownerConnectionId), ownerActor, positiveTimeZoneDb));
      assert.equal(proposed.recordStatus, "draft");
      assert.equal(proposed.version, 1);
      assert.equal(proposed.connection?.id, ownerConnectionId);

      const ownerConfirmed = view(await confirmProjectMcpConnectionDelegationOwner(
        projectId,
        proposed.id,
        { expectedVersion: 1, acknowledgeCredentialUse: true },
        ownerActor,
        db,
      ));
      assert.equal(ownerConfirmed.recordStatus, "ownerConfirmed");
      assert.equal(ownerConfirmed.version, 2);
      const auditCountAfterOwnerConfirm = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM "ProjectMcpConnectionDelegationAudit" WHERE "delegationId" = $1::uuid`,
        [proposed.id],
      );
      const ownerReplay = view(await confirmProjectMcpConnectionDelegationOwner(
        projectId,
        proposed.id,
        { expectedVersion: 1, acknowledgeCredentialUse: true },
        ownerActor,
        db,
      ));
      assert.equal(ownerReplay.version, 2);
      const auditCountAfterOwnerReplay = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM "ProjectMcpConnectionDelegationAudit" WHERE "delegationId" = $1::uuid`,
        [proposed.id],
      );
      assert.equal(auditCountAfterOwnerReplay.rows[0]?.count, auditCountAfterOwnerConfirm.rows[0]?.count);

      await assertDelegationServiceError(
        () => confirmProjectMcpConnectionDelegationProject(
          projectId,
          proposed.id,
          { expectedVersion: 1, acknowledgeProjectScope: true, acknowledgeDataEgress: true },
          projectOwnerActor,
          db,
        ),
        "PROJECT_MCP_CONNECTION_DELEGATION_VERSION_CONFLICT",
      );
      const activated = view(await confirmProjectMcpConnectionDelegationProject(
        projectId,
        proposed.id,
        { expectedVersion: 2, acknowledgeProjectScope: true, acknowledgeDataEgress: true },
        projectOwnerActor,
        db,
      ));
      assert.equal(activated.recordStatus, "active");
      assert.equal(activated.version, 3);
      const projectReplay = view(await confirmProjectMcpConnectionDelegationProject(
        projectId,
        proposed.id,
        { expectedVersion: 2, acknowledgeProjectScope: true, acknowledgeDataEgress: true },
        projectOwnerActor,
        db,
      ));
      assert.equal(projectReplay.version, 3);
      const activeAuditCount = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM "ProjectMcpConnectionDelegationAudit" WHERE "delegationId" = $1::uuid`,
        [proposed.id],
      );
      assert.equal(activeAuditCount.rows[0]?.count, 3);

      const projectView = await getProjectMcpConnectionDelegation(projectId, proposed.id, projectOwnerActor, db);
      assert.equal(projectView.connection, null);
      assert.equal(projectView.effectiveEligibility.reason, null);
      assert.equal("endpointUrl" in projectView, false);
      assert.equal("credentialFingerprint" in projectView, false);
      const ownerConnection = await db.mcpConnection.findUniqueOrThrow({ where: { id: ownerConnectionId }, select: { updatedAt: true } });
      const driftSecret = `mcp-package-b-drift-${suffix}`;
      const driftPreview = await previewMcpConnectionMutation(
        ownerConnectionId,
        { action: "rotateCredential", requestKey: `mcpb-drift-${suffix}`, reason: "MCP Package B governed configuration drift", expectedUpdatedAt: ownerConnection.updatedAt.toISOString(), secret: driftSecret },
        ownerActor,
        db,
      );
      assert.equal(driftPreview.canExecute, true);
      const driftResult = await executeMcpConnectionMutation(
        ownerConnectionId,
        { previewId: driftPreview.id, requestKey: driftPreview.requestKey, requestFingerprint: driftPreview.requestFingerprint, impactFingerprint: driftPreview.impactFingerprint, expectedUpdatedAt: driftPreview.connection.updatedAt, secret: driftSecret },
        ownerActor,
        db,
      );
      assert.equal(driftResult.status, "completed");
      const driftedView = await getProjectMcpConnectionDelegation(projectId, proposed.id, projectOwnerActor, db);
      assert.equal(driftedView.effectiveEligibility.reason, "CONNECTION_EVIDENCE_DRIFT");

      const secondDraft = view(await proposeProjectMcpConnectionDelegation(projectId, proposalInput(ownerConnectionTwoId), ownerActor, db));
      assert.equal(secondDraft.recordStatus, "draft");
      const ownerConnectionTwo = await db.mcpConnection.findUniqueOrThrow({ where: { id: ownerConnectionTwoId }, select: { updatedAt: true } });
      const blockedDisablePreview = await previewMcpConnectionMutation(
        ownerConnectionTwoId,
        { action: "disable", requestKey: `mcpb-block-${suffix}`, reason: "MCP Package B live delegation safety check", expectedUpdatedAt: ownerConnectionTwo.updatedAt.toISOString() },
        ownerActor,
        db,
      );
      assert.equal(blockedDisablePreview.canExecute, false);
      assert.ok(blockedDisablePreview.blockers.includes("live_delegation"));
      await assert.rejects(
        () => client.query(`UPDATE "McpConnection" SET "status" = 'disabled', "disabledAt" = CURRENT_TIMESTAMP WHERE "id" = $1::uuid`, [ownerConnectionTwoId]),
        /mcp connection security fields require governance context/u,
      );
      const unavailableSecret = `mcp-package-b-unavailable-${suffix}`;
      const unavailablePreview = await previewMcpConnectionMutation(
        ownerConnectionTwoId,
        { action: "rotateCredential", requestKey: `mcpb-rotate-${suffix}`, reason: "MCP Package B controlled eligibility check", expectedUpdatedAt: ownerConnectionTwo.updatedAt.toISOString(), secret: unavailableSecret },
        ownerActor,
        db,
      );
      assert.equal(unavailablePreview.canExecute, true);
      const unavailableResult = await executeMcpConnectionMutation(
        ownerConnectionTwoId,
        { previewId: unavailablePreview.id, requestKey: unavailablePreview.requestKey, requestFingerprint: unavailablePreview.requestFingerprint, impactFingerprint: unavailablePreview.impactFingerprint, expectedUpdatedAt: unavailablePreview.connection.updatedAt, secret: unavailableSecret },
        ownerActor,
        db,
      );
      assert.equal(unavailableResult.status, "completed");
      await assertDelegationServiceError(
        () => confirmProjectMcpConnectionDelegationOwner(
          projectId,
          secondDraft.id,
          { expectedVersion: 1, acknowledgeCredentialUse: true },
          ownerActor,
          db,
        ),
        "PROJECT_MCP_CONNECTION_DELEGATION_CONNECTION_UNAVAILABLE",
      );
      const oldOwnerMembership = ownerMembership;
      await db.$transaction(async (tx) => {
        await revokeProjectMembership(tx, projectId, ownerId, workspaceId, { actorId: projectOwnerId, reason: "MCP Package B owner epoch revoked" });
      });
      const readdedMembership = await db.$transaction(async (tx) => grantProjectMembership(
        tx,
        { projectId, workspaceId, userId: ownerId, role: "editor", actorId: projectOwnerId, reason: "MCP Package B owner re-added as editor" },
      ));
      assert.notEqual(readdedMembership.id, oldOwnerMembership?.id);

      await assertDelegationServiceError(
        () => confirmProjectMcpConnectionDelegationOwner(
          projectId,
          secondDraft.id,
          { expectedVersion: 1, acknowledgeCredentialUse: true },
          ownerActor,
          db,
        ),
        "PROJECT_MCP_CONNECTION_DELEGATION_MEMBERSHIP_REQUIRED",
      );

      const projectOwnerTerminalDraft = view(await proposeProjectMcpConnectionDelegation(projectId, proposalInput(dueConnectionId), ownerActor, db));
      assert.equal(projectOwnerTerminalDraft.recordStatus, "draft");
      const projectOwnerTerminalConfirmed = view(await confirmProjectMcpConnectionDelegationOwner(
        projectId,
        projectOwnerTerminalDraft.id,
        { expectedVersion: 1, acknowledgeCredentialUse: true },
        ownerActor,
        db,
      ));
      assert.equal(projectOwnerTerminalConfirmed.recordStatus, "ownerConfirmed");
      assert.equal(projectOwnerTerminalConfirmed.version, 2);

      await client.query(`UPDATE "Project" SET "archivedAt" = CURRENT_TIMESTAMP WHERE "id" = $1::uuid`, [projectId]);
      const archivedOwnerListing = await listConnectionOwnerProjectMcpConnectionDelegations(ownerActor, db);
      const archivedDraft = archivedOwnerListing.find((delegation) => delegation.id === secondDraft.id);
      assert.ok(archivedDraft);
      assert.equal(archivedDraft.capabilities.canReject, true);
      const archivedProjectOwnerDraft = await getProjectMcpConnectionDelegation(projectId, secondDraft.id, projectOwnerActor, db);
      assert.equal(archivedProjectOwnerDraft.capabilities.canReject, true);
      const archivedProjectOwnerActive = await getProjectMcpConnectionDelegation(projectId, proposed.id, projectOwnerActor, db);
      assert.equal(archivedProjectOwnerActive.capabilities.canRevoke, true);

      const archivedTerminalIds = [secondDraft.id, projectOwnerTerminalDraft.id, proposed.id];
      const archivedStateBeforeTerminal = await client.query<{ id: string; status: string; version: number }>(
        `SELECT "id", "status", "version" FROM "ProjectMcpConnectionDelegation" WHERE "id" = ANY($1::uuid[]) ORDER BY "id"`,
        [archivedTerminalIds],
      );
      const archivedAuditBeforeTerminal = await client.query<{ delegationId: string; count: number }>(
        `SELECT "delegationId", COUNT(*)::int AS count FROM "ProjectMcpConnectionDelegationAudit" WHERE "delegationId" = ANY($1::uuid[]) GROUP BY "delegationId" ORDER BY "delegationId"`,
        [archivedTerminalIds],
      );
      await assertDelegationServiceError(
        () => proposeProjectMcpConnectionDelegation(projectId, proposalInput(ownerConnectionTwoId), ownerActor, db),
        "PROJECT_MCP_CONNECTION_DELEGATION_PROJECT_ARCHIVED",
      );
      await assertDelegationServiceError(
        () => confirmProjectMcpConnectionDelegationOwner(
          projectId,
          secondDraft.id,
          { expectedVersion: 1, acknowledgeCredentialUse: true },
          ownerActor,
          db,
        ),
        "PROJECT_MCP_CONNECTION_DELEGATION_PROJECT_ARCHIVED",
      );
      await assertDelegationServiceError(
        () => confirmProjectMcpConnectionDelegationProject(
          projectId,
          proposed.id,
          { expectedVersion: 3, acknowledgeProjectScope: true, acknowledgeDataEgress: true },
          projectOwnerActor,
          db,
        ),
        "PROJECT_MCP_CONNECTION_DELEGATION_PROJECT_ARCHIVED",
      );
      const archivedStateAfterPreTerminal = await client.query<{ id: string; status: string; version: number }>(
        `SELECT "id", "status", "version" FROM "ProjectMcpConnectionDelegation" WHERE "id" = ANY($1::uuid[]) ORDER BY "id"`,
        [archivedTerminalIds],
      );
      const archivedAuditAfterPreTerminal = await client.query<{ delegationId: string; count: number }>(
        `SELECT "delegationId", COUNT(*)::int AS count FROM "ProjectMcpConnectionDelegationAudit" WHERE "delegationId" = ANY($1::uuid[]) GROUP BY "delegationId" ORDER BY "delegationId"`,
        [archivedTerminalIds],
      );
      assert.deepEqual(archivedStateAfterPreTerminal.rows, archivedStateBeforeTerminal.rows);
      assert.deepEqual(archivedAuditAfterPreTerminal.rows, archivedAuditBeforeTerminal.rows);

      const projectOwnerDraftRejection = view(await rejectProjectMcpConnectionDelegation(
        projectId,
        secondDraft.id,
        { expectedVersion: 1, reason: "project owner archived rejection" },
        projectOwnerActor,
        db,
      ));
      assert.equal(projectOwnerDraftRejection.recordStatus, "rejected");
      assert.equal(projectOwnerDraftRejection.version, 2);
      const projectOwnerConfirmedRejection = view(await rejectProjectMcpConnectionDelegation(
        projectId,
        projectOwnerTerminalDraft.id,
        { expectedVersion: 2, reason: "project owner archived owner-confirmed rejection" },
        projectOwnerActor,
        db,
      ));
      assert.equal(projectOwnerConfirmedRejection.recordStatus, "rejected");
      assert.equal(projectOwnerConfirmedRejection.version, 3);
      const projectOwnerActiveRevoke = view(await revokeProjectMcpConnectionDelegation(
        projectId,
        proposed.id,
        { expectedVersion: 3, reason: "project owner archived revoke" },
        projectOwnerActor,
        db,
      ));
      assert.equal(projectOwnerActiveRevoke.recordStatus, "revoked");
      assert.equal(projectOwnerActiveRevoke.version, 4);
      const terminalAuditCounts = await client.query<{ delegationId: string; count: number }>(
        `SELECT "delegationId", COUNT(*)::int AS count FROM "ProjectMcpConnectionDelegationAudit" WHERE "delegationId" = ANY($1::uuid[]) AND "action" IN ('rejected', 'revoked') GROUP BY "delegationId" ORDER BY "delegationId"`,
        [archivedTerminalIds],
      );
      assert.deepEqual(terminalAuditCounts.rows.map((row) => row.count), [1, 1, 1]);

      await client.query(`UPDATE "Project" SET "archivedAt" = NULL WHERE "id" = $1::uuid`, [projectId]);
      // A real due row cannot be produced through the public proposal schema
      // (it intentionally enforces a ten-minute minimum). Seed only this
      // isolated historical fixture with replication-role bypass, preserving
      // the normal expiry/authorization guards for the service mutation.
      const dueDraftId = id();
      const dueProposedAt = new Date(Date.now() - 2 * 60 * 1_000);
      const dueExpiresAt = new Date(Date.now() - 60 * 1_000);
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await client.query(
        `INSERT INTO "ProjectMcpConnectionDelegation" (
           "id", "projectId", "mcpConnectionId", "connectionOwnerId", "connectionOwnerAccountAccessVersion", "connectionConfigurationRevision",
           "resolvedAddressFingerprint", "credentialFingerprint", "delegationFingerprint", "expiresAt", "version", "status",
           "ownerProjectMembershipId", "ownerMembershipCreatedAt", "proposedById", "proposedAt", "createdAt", "updatedAt"
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, (SELECT "ownerAccountAccessVersion" FROM "McpConnection" WHERE "id" = $3::uuid), 1, $5, $6, $7, $8::timestamp, 1, 'draft', $9::uuid, $10::timestamp, $4::uuid, $11::timestamp, $11::timestamp, $11::timestamp)`,
        [dueDraftId, projectId, dueConnectionId, ownerId, fingerprintB, sentinel, fingerprintD, dueExpiresAt.toISOString(), readdedMembership.id, readdedMembership.createdAt.toISOString(), dueProposedAt.toISOString()],
      );
      const seededDueDraft = (await client.query(`SELECT * FROM "ProjectMcpConnectionDelegation" WHERE "id" = $1::uuid`, [dueDraftId])).rows[0] as Record<string, unknown>;
      Object.assign(seededDueDraft, { statusBefore: null, transitionAt: dueProposedAt });
      await insertDelegationAudit(client, seededDueDraft, "proposed", "proposal_created", ownerId, readdedMembership.id, readdedMembership.createdAt);
      await client.query("COMMIT");
      const dueDraft = view({ id: dueDraftId, recordStatus: "draft", version: 1, connection: null, effectiveEligibility: { reason: "EXPIRED" }, capabilities: { canReject: true } });
      await db.$transaction(async (tx) => {
        await revokeProjectMembership(tx, projectId, ownerId, workspaceId, { actorId: projectOwnerId, reason: "MCP Package B due epoch revoked" });
      });

      const dueOwnerListing = await listConnectionOwnerProjectMcpConnectionDelegations(ownerActor, negativeTimeZoneDb);
      const dueProjection = dueOwnerListing.find((delegation) => delegation.id === dueDraft.id);
      assert.ok(dueProjection);
      assert.equal(dueProjection.recordStatus, "draft");
      assert.equal(dueProjection.effectiveEligibility.reason, "EXPIRED");
      assert.equal(dueProjection.capabilities.canReject, true);
      const dueBeforeUnauthorized = await client.query<{ status: string; version: number }>(
        `SELECT "status", "version" FROM "ProjectMcpConnectionDelegation" WHERE "id" = $1::uuid`,
        [dueDraft.id],
      );
      const dueAuditBeforeUnauthorized = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM "ProjectMcpConnectionDelegationAudit" WHERE "delegationId" = $1::uuid`,
        [dueDraft.id],
      );
      await assertDelegationServiceError(
        () => rejectProjectMcpConnectionDelegation(
          projectId,
          dueDraft.id,
          { expectedVersion: 1, reason: "unauthorized expiry probe" },
          foreignOwnerActor,
          db,
        ),
        "PROJECT_MCP_CONNECTION_DELEGATION_FORBIDDEN",
      );
      await assertDelegationServiceError(
        () => rejectProjectMcpConnectionDelegation(
          projectId,
          id(),
          { expectedVersion: 1, reason: "unauthorized missing-row probe" },
          foreignOwnerActor,
          db,
        ),
        "PROJECT_MCP_CONNECTION_DELEGATION_FORBIDDEN",
      );
      await assertDelegationServiceError(
        () => rejectProjectMcpConnectionDelegation(
          projectId,
          dueDraft.id,
          { expectedVersion: 1, reason: "viewer expiry probe" },
          viewerActor,
          db,
        ),
        "PROJECT_MCP_CONNECTION_DELEGATION_PROJECT_OWNER_REQUIRED",
      );
      const dueAfterUnauthorized = await client.query<{ status: string; version: number }>(
        `SELECT "status", "version" FROM "ProjectMcpConnectionDelegation" WHERE "id" = $1::uuid`,
        [dueDraft.id],
      );
      const dueAuditAfterUnauthorized = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM "ProjectMcpConnectionDelegationAudit" WHERE "delegationId" = $1::uuid`,
        [dueDraft.id],
      );
      assert.deepEqual(dueAfterUnauthorized.rows, dueBeforeUnauthorized.rows);
      assert.deepEqual(dueAuditAfterUnauthorized.rows, dueAuditBeforeUnauthorized.rows);

      await assertDelegationServiceError(
        () => rejectProjectMcpConnectionDelegation(
          projectId,
          dueDraft.id,
          { expectedVersion: 1, reason: "authorized expiry" },
          ownerActor,
          negativeTimeZoneDb,
        ),
        "PROJECT_MCP_CONNECTION_DELEGATION_EXPIRED",
      );
      const expiredState = await client.query<{ status: string; version: number }>(
        `SELECT "status", "version" FROM "ProjectMcpConnectionDelegation" WHERE "id" = $1::uuid`,
        [dueDraft.id],
      );
      assert.deepEqual(expiredState.rows[0], { status: "expired", version: 2 });
      const expiredAudit = await client.query<{ action: string; actorKind: string; reason: string }>(
        `SELECT "action", "actorKind", "reason" FROM "ProjectMcpConnectionDelegationAudit" WHERE "delegationId" = $1::uuid ORDER BY "delegationVersion"`,
        [dueDraft.id],
      );
      assert.deepEqual(expiredAudit.rows.map((row) => [row.action, row.actorKind, row.reason]), [
        ["proposed", "user", "proposal_created"],
        ["expired", "system_expiry", "system_expiry"],
      ]);

      const postExpiryMembership = await db.$transaction(async (tx) => grantProjectMembership(
        tx,
        { projectId, workspaceId, userId: ownerId, role: "owner", actorId: projectOwnerId, reason: "MCP Package B expiry recovery" },
      ));
      assert.notEqual(postExpiryMembership.id, readdedMembership.id);
      const replacement = view(await proposeProjectMcpConnectionDelegation(projectId, proposalInput(dueConnectionId), ownerActor, db));
      assert.equal(replacement.recordStatus, "draft");
      const dueConnectionBeforeDelete = await db.mcpConnection.findUniqueOrThrow({ where: { id: dueConnectionId }, select: { name: true, status: true, updatedAt: true } });
      const dueDeletePreview = await previewMcpConnectionMutation(
        dueConnectionId,
        { action: "delete", requestKey: `mcpb-due-del-${suffix}`, reason: "MCP Package B retain delegation history", expectedUpdatedAt: dueConnectionBeforeDelete.updatedAt.toISOString(), confirmationName: dueConnectionBeforeDelete.name },
        ownerActor,
        db,
      );
      assert.equal(dueDeletePreview.canExecute, false);
      assert.ok(dueDeletePreview.blockers.includes("connection_must_be_disabled"));
      assert.ok(dueDeletePreview.blockers.includes("live_delegation"));
      assert.equal(dueConnectionBeforeDelete.status, "verified");
      assert.equal(await db.mcpConnection.count({ where: { id: dueConnectionId } }), 1);

      const deleteGuardDraft = view(await proposeProjectMcpConnectionDelegation(projectId, proposalInput(deleteGuardConnectionId), ownerActor, db));
      const deleteGuardConnection = await db.mcpConnection.findUniqueOrThrow({ where: { id: deleteGuardConnectionId }, select: { name: true, status: true, updatedAt: true } });
      const deleteGuardDisablePreview = await previewMcpConnectionMutation(
        deleteGuardConnectionId,
        { action: "disable", requestKey: `mcpb-dg-off-${suffix}`, reason: "MCP Package B live delegation retention", expectedUpdatedAt: deleteGuardConnection.updatedAt.toISOString() },
        ownerActor,
        db,
      );
      assert.equal(deleteGuardDisablePreview.canExecute, false);
      assert.ok(deleteGuardDisablePreview.blockers.includes("live_delegation"));
      const deleteGuardPreview = await previewMcpConnectionMutation(
        deleteGuardConnectionId,
        { action: "delete", requestKey: `mcpb-dg-del-${suffix}`, reason: "MCP Package B live delegation retention", expectedUpdatedAt: deleteGuardConnection.updatedAt.toISOString(), confirmationName: deleteGuardConnection.name },
        ownerActor,
        db,
      );
      assert.equal(deleteGuardPreview.canExecute, false);
      assert.ok(deleteGuardPreview.blockers.includes("connection_must_be_disabled"));
      assert.ok(deleteGuardPreview.blockers.includes("live_delegation"));
      await rejectProjectMcpConnectionDelegation(
        projectId,
        deleteGuardDraft.id,
        { expectedVersion: 1, reason: "close delete guard draft" },
        ownerActor,
        db,
      );
      const retainedDeleteGuardPreview = await previewMcpConnectionMutation(
        deleteGuardConnectionId,
        { action: "delete", requestKey: `mcpb-dg-hist-${suffix}`, reason: "MCP Package B retain terminal delegation history", expectedUpdatedAt: deleteGuardConnection.updatedAt.toISOString(), confirmationName: deleteGuardConnection.name },
        ownerActor,
        db,
      );
      assert.equal(retainedDeleteGuardPreview.canExecute, false);
      assert.ok(retainedDeleteGuardPreview.blockers.includes("connection_must_be_disabled"));
      assert.equal(await db.mcpConnection.count({ where: { id: deleteGuardConnectionId } }), 1);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query(`DELETE FROM "ProjectMcpConnectionDelegationAudit" WHERE "projectId" = $1::uuid`, [projectId]).catch(() => undefined);
      await client.query(`DELETE FROM "Project" WHERE "id" = $1::uuid`, [projectId]).catch(() => undefined);
      await client.query(`DELETE FROM "McpConnection" WHERE "id" = ANY($1::uuid[])`, [[ownerConnectionId, ownerConnectionTwoId, dueConnectionId, deleteGuardConnectionId, foreignConnectionId, adminConnectionId]]).catch(() => undefined);
      await client.query(`DELETE FROM "ExternalCredential" WHERE "id" = ANY($1::uuid[])`, [[ownerCredentialId, ownerConnectionTwoCredentialId]]).catch(() => undefined);
      await client.query(`DELETE FROM "Workspace" WHERE "id" = $1::uuid`, [workspaceId]).catch(() => undefined);
      await client.query(`DELETE FROM "AppUser" WHERE "id" = ANY($1::uuid[])`, [[ownerId, projectOwnerId, viewerId, workspaceAdminId, foreignOwnerId]]).catch(() => undefined);
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

test(
  "migration 77 upgrades a clean V2 database and rejects preexisting grants before DDL",
  { skip: !shouldRun ? "PROJECT_MCP_DELEGATION_POSTGRES_GATE=1 is required" : false },
  async () => {
    assertDisposableGateDatabase();
    const configuredUrl = process.env.DATABASE_URL;
    if (typeof configuredUrl !== "string" || configuredUrl.length === 0) {
      throw new Error("PROJECT_MCP_GRANT_RETENTION_UPGRADE_DATABASE_URL_REQUIRED");
    }
    const baseDatabaseUrl = configuredUrl;
    const migrations = await migrationNamesFromDisk();
    const delegationIndex = migrations.indexOf(projectMcpDelegationMigration);
    const retentionIndex = migrations.indexOf(projectMcpGrantRetentionMigration);
    if (delegationIndex < 0 || migrations[delegationIndex + 1] !== mcpControlPlaneV2Migration || retentionIndex !== delegationIndex + 2) {
      throw new Error("PROJECT_MCP_GRANT_RETENTION_UPGRADE_MIGRATION_ORDER_INVALID");
    }
    const beforeRetentionMigrations = migrations.slice(0, retentionIndex);
    const configuredTarget = new URL(configuredUrl);
    const ownerRole = decodeURIComponent(configuredTarget.username);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(ownerRole)) {
      throw new Error("PROJECT_MCP_GRANT_RETENTION_UPGRADE_DATABASE_OWNER_INVALID");
    }
    const admin = new Client({ connectionString: assertUpgradeAdminUrl(), connectionTimeoutMillis: 5_000 });
    const tempRoot = await prepareStagedMigrationRoot();

    async function retentionObjects(client: Client) {
      const result = await client.query<{
        creationColumnCount: number;
        creationConstraintCount: number;
        ledgerTable: string | null;
        ledgerTypeCount: number;
        retentionFunctionCount: number;
        ledgerIndexCount: number;
        auditIndexCount: number;
        ledgerTriggerCount: number;
        projectDeleteTriggerCount: number;
      }>(`
        SELECT
          (SELECT COUNT(*)::int FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ProjectMcpToolGrant' AND column_name = 'creationTransactionId') AS "creationColumnCount",
          (SELECT COUNT(*)::int FROM pg_constraint WHERE conname = 'ProjectMcpToolGrant_v2_creation_transaction_check') AS "creationConstraintCount",
          to_regclass('public."ProjectMcpToolGrantLedger"') AS "ledgerTable",
          (SELECT COUNT(*)::int FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname = 'ProjectMcpToolGrantLedgerEvent') AS "ledgerTypeCount",
          (SELECT COUNT(*)::int FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'project_mcp_tool_grant_v2_retention_complete') AS "retentionFunctionCount",
          (SELECT COUNT(*)::int FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = 'public' AND relation.relname = 'ProjectMcpToolGrantLedger_grantId_grantVersion_key') AS "ledgerIndexCount",
          (SELECT COUNT(*)::int FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = 'public' AND relation.relname = 'ProjectMcpToolGrantAudit_v2_event_key') AS "auditIndexCount",
          (SELECT COUNT(*)::int FROM pg_trigger AS trigger_row JOIN pg_class AS relation ON relation.oid = trigger_row.tgrelid JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = 'public' AND relation.relname = 'ProjectMcpToolGrantLedger' AND trigger_row.tgname = 'ProjectMcpToolGrantLedger_guard') AS "ledgerTriggerCount",
          (SELECT COUNT(*)::int FROM pg_trigger AS trigger_row JOIN pg_class AS relation ON relation.oid = trigger_row.tgrelid JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = 'public' AND relation.relname = 'Project' AND trigger_row.tgname = 'Project_mcp_grant_project_delete_guard') AS "projectDeleteTriggerCount"
      `);
      return result.rows[0]!;
    }

    async function seedPreexistingV2Grant(client: Client): Promise<{ grantId: string; projectId: string }> {
      const ownerId = id();
      const workspaceId = id();
      const projectId = id();
      const grantId = id();
      const connectionId = id();
      const delegationId = id();
      const definitionId = id();
      const attestationId = id();
      const membershipId = id();
      const membershipCreatedAt = new Date("2026-09-01T00:00:00.000Z");
      await client.query("BEGIN");
      try {
        // This is an intentionally broken pre-77 historical fixture.  Replica
        // mode is used only to model a V2 row that existed before the ledger
        // migration; it is never used for a current positive path.
        await client.query("SET LOCAL session_replication_role = 'replica'");
        await client.query(
          `INSERT INTO "AppUser" ("id", "username", "role", "updatedAt") VALUES ($1::uuid, $2, 'user', CURRENT_TIMESTAMP)`,
          [ownerId, `mcp_retention_upgrade_${grantId.slice(0, 8)}`],
        );
        await client.query(
          `INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt") VALUES ($1::uuid, $2, $3, $4::uuid, CURRENT_TIMESTAMP)`,
          [workspaceId, `MCP retention upgrade ${grantId.slice(0, 8)}`, `mcp-retention-upgrade-${grantId.slice(0, 8)}`, ownerId],
        );
        await client.query(
          `INSERT INTO "Project" ("id", "workspaceId", "name", "slug", "updatedAt") VALUES ($1::uuid, $2::uuid, $3, $4, CURRENT_TIMESTAMP)`,
          [projectId, workspaceId, `MCP retention upgrade ${grantId.slice(0, 8)}`, `mcp-retention-upgrade-project-${grantId.slice(0, 8)}`],
        );
        await client.query(
          `INSERT INTO "ProjectMcpToolGrant" (
             "id", "projectId", "connectionId", "delegationId", "controlPlaneVersion", "grantVersion", "toolName",
             "toolDefinitionId", "attestationId", "definitionFingerprint", "networkFingerprint", "credentialFingerprint",
             "delegationVersion", "delegationFingerprint", "connectionConfigurationRevision", "grantorProjectMembershipId",
             "grantorMembershipCreatedAt", "status", "managedById", "acknowledgedAt", "updatedAt"
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 2, 1, 'upgrade.lookup', $5::uuid, $6::uuid, $7, $8, $9,
             1, $10, 1, $11::uuid, $12::timestamp, 'active', $13::uuid, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [grantId, projectId, connectionId, delegationId, definitionId, attestationId, fingerprintA, fingerprintB, fingerprintC, fingerprintD, membershipId, membershipCreatedAt, ownerId],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
      return { grantId, projectId };
    }

    async function runUpgradeCase(seedGrant: boolean): Promise<void> {
      const databaseName = upgradeDatabaseName(randomUUID().slice(0, 12));
      const targetUrl = new URL(baseDatabaseUrl);
      targetUrl.pathname = `/${databaseName}`;
      targetUrl.search = "";
      targetUrl.hash = "";
      let databaseCreated = false;
      let client: Client | undefined;
      let seededGrantId: string | undefined;
      try {
        await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
        databaseCreated = true;
        await rm(join(tempRoot, "prisma", "migrations"), { recursive: true, force: true });
        await stageMigrations(tempRoot, beforeRetentionMigrations);
        await deployStagedMigrations(tempRoot, targetUrl.toString());
        client = new Client({ connectionString: targetUrl.toString(), connectionTimeoutMillis: 5_000 });
        await client.connect();
        const priorMigration = await client.query<{ finishedAt: Date | null }>(
          `SELECT "finished_at" AS "finishedAt" FROM "_prisma_migrations" WHERE "migration_name" = $1`,
          [mcpControlPlaneV2Migration],
        );
        assert.ok(priorMigration.rows[0]?.finishedAt);
        if (seedGrant) {
          const seeded = await seedPreexistingV2Grant(client);
          seededGrantId = seeded.grantId;
          const beforeGrant = await client.query<{ id: string; controlPlaneVersion: number }>(
            `SELECT "id", "controlPlaneVersion" FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`, [seeded.grantId],
          );
          assert.deepEqual(beforeGrant.rows, [{ id: seeded.grantId, controlPlaneVersion: 2 }]);
        }

        await stageMigrations(tempRoot, [projectMcpGrantRetentionMigration]);
        if (seedGrant) {
          const preexistingGrantId = seededGrantId;
          assert.ok(preexistingGrantId);
          await assert.rejects(
            () => deployStagedMigrations(tempRoot, targetUrl.toString()),
            /PROJECT_MCP_GRANT_LEDGER_UPGRADE_PREFLIGHT_FAILED/u,
          );
          const failedMigration = await client.query<{ finishedAt: Date | null; rolledBackAt: Date | null }>(
            `SELECT "finished_at" AS "finishedAt", "rolled_back_at" AS "rolledBackAt" FROM "_prisma_migrations" WHERE "migration_name" = $1`,
            [projectMcpGrantRetentionMigration],
          );
          assert.ok(failedMigration.rows.length === 0 || failedMigration.rows[0]?.finishedAt === null);
          const objects = await retentionObjects(client);
          assert.equal(objects.creationColumnCount, 0);
          assert.equal(objects.creationConstraintCount, 0);
          assert.equal(objects.ledgerTable, null);
          assert.equal(objects.ledgerTypeCount, 0);
          assert.equal(objects.retentionFunctionCount, 0);
          assert.equal(objects.ledgerIndexCount, 0);
          assert.equal(objects.auditIndexCount, 0);
          assert.equal(objects.ledgerTriggerCount, 0);
          assert.equal(objects.projectDeleteTriggerCount, 0);
          const afterGrant = await client.query<{ id: string; controlPlaneVersion: number }>(
            `SELECT "id", "controlPlaneVersion" FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`, [preexistingGrantId],
          );
          assert.deepEqual(afterGrant.rows, [{ id: preexistingGrantId, controlPlaneVersion: 2 }]);
        } else {
          await deployStagedMigrations(tempRoot, targetUrl.toString());
          const completedMigration = await client.query<{ finishedAt: Date | null; rolledBackAt: Date | null }>(
            `SELECT "finished_at" AS "finishedAt", "rolled_back_at" AS "rolledBackAt" FROM "_prisma_migrations" WHERE "migration_name" = $1`,
            [projectMcpGrantRetentionMigration],
          );
          assert.ok(completedMigration.rows[0]?.finishedAt);
          assert.equal(completedMigration.rows[0]?.rolledBackAt, null);
          const objects = await retentionObjects(client);
          assert.equal(objects.creationColumnCount, 1);
          assert.equal(objects.creationConstraintCount, 1);
          assert.notEqual(objects.ledgerTable, null);
          assert.equal(objects.ledgerTypeCount, 1);
          assert.equal(objects.retentionFunctionCount, 1);
          assert.equal(objects.ledgerIndexCount, 1);
          assert.equal(objects.auditIndexCount, 1);
          assert.equal(objects.ledgerTriggerCount, 1);
          assert.equal(objects.projectDeleteTriggerCount, 1);
        }
      } finally {
        await client?.end().catch(() => undefined);
        if (databaseCreated) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      }
    }

    try {
      await admin.connect();
      await runUpgradeCase(false);
      await runUpgradeCase(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
      await admin.end().catch(() => undefined);
    }
  },
);
