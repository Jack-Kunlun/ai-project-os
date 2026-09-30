import "dotenv/config";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma } from "@prisma/client";
import { PrismaClient } from "@prisma/client";
import { Client } from "pg";
import { getDb } from "../src/lib/db";
import { executeAccountAccess, previewAccountAccess } from "../src/lib/account-access-service";
import { grantProjectMembership, grantWorkspaceMembership, revokeProjectMembership } from "../src/lib/membership-governance";
import { deleteArchivedProject, updateProjectLifecycle } from "../src/lib/project-lifecycle";
import {
  confirmProjectGitRepositoryDelegationOwner,
  confirmProjectGitRepositoryDelegationProject,
  rejectProjectGitRepositoryDelegation,
  revokeProjectGitRepositoryDelegation,
  getProjectGitRepositoryDelegationLiveEligibility,
  listConnectionOwnerProjectGitRepositoryDelegations,
  listProjectGitRepositoryDelegations,
  proposeProjectGitRepositoryDelegation,
} from "../src/lib/project-git-repository-delegation-service";
import {
  activateProjectGitAutomationGrantProjectOwner,
  confirmProjectGitAutomationGrantConnectionOwner,
  getProjectGitAutomationGrant,
  listConnectionOwnerProjectGitAutomationGrants,
  proposeProjectGitAutomationGrant,
  revokeProjectGitAutomationGrant,
} from "../src/lib/project-git-automation-grant-service";
import { disableGitConnection, executeGitConnectionMutation, previewGitConnectionMutation, updateGitConnection } from "../src/lib/git";
import { createPostgresWorkspaceFixture } from "./postgres-workspace-fixture";
import { createGitConnectionFixture } from "./personal-connection-probe-fixture";

const shouldRun = process.env.PROJECT_GIT_REPOSITORY_DELEGATION_POSTGRES_GATE === "1";
const testDatabaseName = "ai_project_os_project_git_repository_delegation_test";
const repositoryRoot = process.cwd();
const execFile = promisify(execFileCallback);
const projectGitDelegationMigration = "20260904150000_add_project_git_repository_delegations";
const projectGitRuntimeMigration = "20260904160000_add_project_git_manual_runtime";
const projectGitReconciliationMigration = "20260904170000_add_project_git_manual_run_reconciliation";
const projectGitPublicationHeadMigration = "20260929060000_add_git_shared_publication_head";
const seededAdminId = "00000000-0000-4000-8000-000000000010";

function deterministicGitUuid(input: string): string {
  const bytes = Buffer.from(createHash("sha256").update(input, "utf8").digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertDisposableGateDatabase(): void {
  const configuredUrl = process.env.DATABASE_URL;
  if (typeof configuredUrl !== "string" || configuredUrl.length === 0) throw new Error("PROJECT_GIT_REPOSITORY_DELEGATION_TEST_DATABASE_URL_REQUIRED");
  const parsed = new URL(configuredUrl);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== `/${testDatabaseName}`
    || parsed.username !== "ai_project_os_gate"
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== "") {
    throw new Error("PROJECT_GIT_REPOSITORY_DELEGATION_TEST_DATABASE_URL_INVALID");
  }
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
    await cp(join(repositoryRoot, "prisma", "migrations", name), join(migrationsRoot, name), { recursive: true });
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
    throw new Error("PROJECT_GIT_REPOSITORY_DELEGATION_UPGRADE_ADMIN_URL_REQUIRED");
  }
  const parsed = new URL(configuredUrl);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== "/postgres"
    || parsed.username.length === 0
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== "") {
    throw new Error("PROJECT_GIT_REPOSITORY_DELEGATION_UPGRADE_ADMIN_URL_INVALID");
  }
  return parsed.toString();
}

function upgradeDatabaseName(suffix: string): string {
  const normalized = suffix.replaceAll("-", "");
  if (!/^[0-9a-f]{8,32}$/u.test(normalized)) throw new Error("PROJECT_GIT_REPOSITORY_DELEGATION_UPGRADE_DATABASE_INVALID");
  return `ai_project_os_git_delegation_upgrade_${normalized}_test`;
}

async function prepareStagedMigrationRoot(): Promise<string> {
  const tempRoot = await mkdtemp(join(tmpdir(), "ai-project-os-git-delegation-upgrade-migrations-"));
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

async function seedUpgradeDelegation(databaseUrl: string, invalid: boolean): Promise<{ database: PrismaClient; delegationId: string; flags: { manualSyncAllowed: boolean; automationAllowed: boolean } }> {
  const database = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  // This fixture is intentionally written against the pre-epoch schema.  A
  // client generated from the current schema would emit account epoch
  // columns that do not exist until the later forward migration.
  const legacyClient = new Client({ connectionString: databaseUrl });
  const adminId = randomUUID();
  const ownerId = randomUUID();
  const seededWorkspaceId = randomUUID();
  const projectId = randomUUID();
  const connectionId = randomUUID();
  const credentialId = randomUUID();
  const delegationId = randomUUID();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const flags = invalid
    ? { manualSyncAllowed: false, automationAllowed: true }
    : { manualSyncAllowed: true, automationAllowed: false };

  try {
    await legacyClient.connect();
    await legacyClient.query(`
      INSERT INTO "AppUser" (
        "id", "username", "passwordHash", "passwordSalt", "role", "createdAt", "updatedAt"
      ) VALUES
        ($1::uuid, $2, NULL, NULL, 'admin'::"AppUserRole", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($3::uuid, $4, NULL, NULL, 'user'::"AppUserRole", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [adminId, `upgrade_admin_${suffix}`, ownerId, `upgrade_owner_${suffix}`]);
    await legacyClient.query(`
      INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "createdAt", "updatedAt")
      VALUES ($1::uuid, $2, $3, $4::uuid, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [seededWorkspaceId, `Upgrade workspace ${suffix}`, `upgrade-${suffix}`, adminId]);
    await legacyClient.query(`
      INSERT INTO "Project" (
        "id", "workspaceId", "membershipInheritanceMode", "name", "slug", "description", "archivedAt", "createdAt", "updatedAt"
      ) VALUES (
        $1::uuid, $2::uuid, 'project_only'::"ProjectMembershipInheritanceMode", $3, $4, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `, [projectId, seededWorkspaceId, `Upgrade project ${suffix}`, `upgrade-project-${suffix}`]);
    const project = { id: projectId };
    let ownerMembershipId: string;
    await database.$transaction(async (tx) => {
      await grantWorkspaceMembership(tx, {
        workspaceId: seededWorkspaceId,
        userId: adminId,
        role: "owner",
        actorId: adminId,
        reason: "project git delegation upgrade fixture admin",
      });
      await grantWorkspaceMembership(tx, {
        workspaceId: seededWorkspaceId,
        userId: ownerId,
        role: "member",
        actorId: adminId,
        reason: "project git delegation upgrade fixture owner",
      });
      const membership = await grantProjectMembership(tx, {
        projectId: project.id,
        workspaceId: seededWorkspaceId,
        userId: ownerId,
        role: "editor",
        actorId: adminId,
        reason: "project git delegation upgrade fixture owner",
      });
      ownerMembershipId = membership.id;
    });
    await legacyClient.query(`
      INSERT INTO "ExternalCredential" (
        "id", "kind", "ciphertext", "nonce", "authTag", "maskedSuffix", "secretFingerprint", "createdAt", "updatedAt"
      ) VALUES ($1::uuid, 'git'::"ExternalCredentialKind", decode('01', 'hex'), decode('02', 'hex'), decode('03', 'hex'), 'gate', $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [credentialId, "c".repeat(64)]);
    await legacyClient.query(`
      INSERT INTO "GitConnection" (
        "id", "name", "providerKind", "transport", "baseUrl", "authKind", "credentialId",
        "resolvedAddressFingerprint", "status", "createdById", "ownerUserId", "ownershipState", "createdAt", "updatedAt"
      ) VALUES (
        $1::uuid, $2, 'github'::"GitProviderKind", 'https'::"GitTransport", 'https://github.com',
        'token'::"GitAuthKind", $3::uuid, $4, 'verified'::"GitConnectionStatus", $5::uuid, $5::uuid,
        'confirmed'::"ResourceOwnershipState", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `, [connectionId, `Upgrade Git ${suffix}`, credentialId, "b".repeat(64), ownerId]);
    await legacyClient.query("BEGIN");
    try {
      await legacyClient.query(`
        INSERT INTO "ProjectGitRepositoryDelegation" (
          "id", "projectId", "gitConnectionId", "connectionOwnerId", "repositoryPath", "trackedRef",
          "includeRoots", "softExcludePatterns", "role", "requiredForProjectSnapshot", "codeEnabled",
          "metadataEnabled", "manualSyncAllowed", "automationAllowed", "expiresAt",
          "connectionConfigurationVersion", "resolvedAddressFingerprint", "credentialFingerprint",
          "delegationFingerprint", "version", "status", "ownerProjectMembershipId",
          "ownerMembershipCreatedAt", "proposedById"
        ) SELECT
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'org/upgrade-repository', 'main',
          $5::jsonb, $6::jsonb, 'primary'::"ProjectRepositoryRole", true, true,
          true, $7, $8, CURRENT_TIMESTAMP + INTERVAL '1 hour', 1, $9, $10, $11, 1,
          'draft'::"ProjectGitRepositoryDelegationStatus", $12::uuid, membership."createdAt", $4::uuid
        FROM "ProjectMembership" membership
        WHERE membership."id" = $12::uuid
      `, [
        delegationId,
        project.id,
        connectionId,
        ownerId,
        JSON.stringify(["."]),
        JSON.stringify([]),
        flags.manualSyncAllowed,
        flags.automationAllowed,
        "b".repeat(64),
        "c".repeat(64),
        "d".repeat(64),
        ownerMembershipId!,
      ]);
      await legacyClient.query(`
        INSERT INTO "ProjectGitRepositoryDelegationAudit" (
          "id", "projectId", "gitConnectionId", "delegationId", "connectionOwnerId",
          "action", "delegationVersion", "statusBefore", "statusAfter", "actorKind", "actorId",
          "actorProjectMembershipId", "actorMembershipCreatedAt", "ownerProjectMembershipId",
          "ownerMembershipCreatedAt", "repositoryPath", "trackedRef", "includeRoots",
          "softExcludePatterns", "role", "requiredForProjectSnapshot", "codeEnabled", "metadataEnabled",
          "manualSyncAllowed", "automationAllowed", "expiresAt", "connectionConfigurationVersion",
          "resolvedAddressFingerprint", "credentialFingerprint", "delegationFingerprint", "reason", "transitionAt"
        )
          SELECT $1::uuid, delegation."projectId", delegation."gitConnectionId", delegation."id", delegation."connectionOwnerId",
            'proposed'::"ProjectGitRepositoryDelegationAuditAction", delegation."version", NULL,
            delegation."status", 'user'::"ProjectGitRepositoryDelegationActorKind", delegation."connectionOwnerId",
            delegation."ownerProjectMembershipId", delegation."ownerMembershipCreatedAt", delegation."ownerProjectMembershipId",
            delegation."ownerMembershipCreatedAt", delegation."repositoryPath", delegation."trackedRef", delegation."includeRoots",
            delegation."softExcludePatterns", delegation."role", delegation."requiredForProjectSnapshot", delegation."codeEnabled",
            delegation."metadataEnabled", delegation."manualSyncAllowed", delegation."automationAllowed", delegation."expiresAt",
            delegation."connectionConfigurationVersion", delegation."resolvedAddressFingerprint", delegation."credentialFingerprint",
            delegation."delegationFingerprint", 'legacy upgrade fixture proposal', delegation."proposedAt"
          FROM "ProjectGitRepositoryDelegation" delegation
         WHERE delegation."id" = $2::uuid
      `, [randomUUID(), delegationId]);
      await legacyClient.query("COMMIT");
    } catch (error) {
      await legacyClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    await legacyClient.end();
    return { database, delegationId, flags };
  } catch (error) {
    await legacyClient.end().catch(() => undefined);
    await database.$disconnect().catch(() => undefined);
    throw error;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name} ${error.message}` : String(error);
}

async function waitForDelegationFenceWait(db: ReturnType<typeof getDb>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await db.$queryRaw<Array<{ waiting: number }>>(Prisma.sql`
      SELECT count(*)::integer AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query LIKE '%ai-project-git-repository-delegation-global%'
    `);
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("GIT_CONNECTION_DELEGATION_FENCE_WAIT_NOT_OBSERVED");
}

async function setAccountAccessState(
  db: ReturnType<typeof getDb>,
  input: Readonly<{
    adminUserId: string;
    userId: string;
    action: "disable" | "restore";
    reason: string;
    requestKey: string;
  }>,
) {
  const [admin, target] = await Promise.all([
    db.appUser.findUniqueOrThrow({
      where: { id: input.adminUserId },
      select: { accountAccessVersion: true },
    }),
    db.appUser.findUniqueOrThrow({
      where: { id: input.userId },
      select: { accountAccessVersion: true },
    }),
  ]);
  const preview = await previewAccountAccess({
    adminUserId: input.adminUserId,
    adminAccountAccessVersion: admin.accountAccessVersion,
    userId: input.userId,
    action: input.action,
    reason: input.reason,
    expectedVersion: target.accountAccessVersion,
  }, db);
  assert.equal(preview.canExecute, true);
  return executeAccountAccess({
    adminUserId: input.adminUserId,
    adminAccountAccessVersion: admin.accountAccessVersion,
    userId: preview.user.id,
    action: preview.action,
    reason: input.reason,
    expectedVersion: preview.current.accountAccessVersion,
    expectedImpactFingerprint: preview.impactFingerprint,
    requestKey: input.requestKey,
    requestFingerprint: preview.requestFingerprint,
    previewId: preview.previewId,
    previewIssuedAt: preview.previewIssuedAt,
    previewExpiresAt: preview.previewExpiresAt,
    confirmation: true,
    confirmationUsername: preview.user.username,
  }, db);
}

async function insertCurrentDelegationAudit(
  tx: Prisma.TransactionClient,
  input: {
    delegationId: string;
    action: "activated" | "rejected";
    statusBefore: "owner_confirmed" | "draft";
    actorId: string;
    actorMembershipId: string;
    actorMembershipCreatedAt: Date;
    reason: string;
    terminalActorProjectMembershipId?: string;
    terminalActorMembershipCreatedAt?: Date;
  },
): Promise<void> {
  const terminalActorProjectMembershipId = input.terminalActorProjectMembershipId === undefined
    ? Prisma.sql`delegation."terminalActorProjectMembershipId"`
    : Prisma.sql`${input.terminalActorProjectMembershipId}::uuid`;
  const terminalActorMembershipCreatedAt = input.terminalActorMembershipCreatedAt === undefined
    ? Prisma.sql`delegation."terminalActorMembershipCreatedAt"`
    : Prisma.sql`${input.terminalActorMembershipCreatedAt}::timestamp(3)`;
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "ProjectGitRepositoryDelegationAudit" (
      "id", "projectId", "gitConnectionId", "delegationId", "connectionOwnerId", "connectionOwnerAccountAccessVersion",
      "action", "delegationVersion", "statusBefore", "statusAfter", "actorKind",
      "actorId", "actorProjectMembershipId", "actorMembershipCreatedAt",
      "terminalActorKind", "terminalActorId", "terminalActorProjectMembershipId",
      "terminalActorMembershipCreatedAt", "terminalReason", "ownerProjectMembershipId",
      "ownerMembershipCreatedAt", "projectConfirmedProjectMembershipId",
      "projectConfirmedMembershipCreatedAt", "repositoryPath", "trackedRef", "includeRoots",
      "softExcludePatterns", "role", "requiredForProjectSnapshot", "codeEnabled",
      "metadataEnabled", "manualSyncAllowed", "automationAllowed", "expiresAt",
      "connectionConfigurationVersion", "resolvedAddressFingerprint", "credentialFingerprint",
      "delegationFingerprint", "reason", "transitionAt"
    )
    SELECT ${randomUUID()}::uuid, delegation."projectId", delegation."gitConnectionId", delegation."id", delegation."connectionOwnerId", delegation."connectionOwnerAccountAccessVersion",
      ${input.action}::"ProjectGitRepositoryDelegationAuditAction", delegation."version",
      ${input.statusBefore}::"ProjectGitRepositoryDelegationStatus", delegation."status",
      'user'::"ProjectGitRepositoryDelegationActorKind", ${input.actorId}::uuid,
      ${input.actorMembershipId}::uuid, ${input.actorMembershipCreatedAt}::timestamp(3),
      delegation."terminalActorKind", delegation."terminalActorId", ${terminalActorProjectMembershipId},
      ${terminalActorMembershipCreatedAt}, delegation."terminalReason", delegation."ownerProjectMembershipId",
      delegation."ownerMembershipCreatedAt", delegation."projectConfirmedProjectMembershipId",
      delegation."projectConfirmedMembershipCreatedAt", delegation."repositoryPath", delegation."trackedRef",
      delegation."includeRoots", delegation."softExcludePatterns", delegation."role",
      delegation."requiredForProjectSnapshot", delegation."codeEnabled", delegation."metadataEnabled",
      delegation."manualSyncAllowed", delegation."automationAllowed", delegation."expiresAt",
      delegation."connectionConfigurationVersion", delegation."resolvedAddressFingerprint",
      delegation."credentialFingerprint", delegation."delegationFingerprint", ${input.reason},
      CASE ${input.action}::"ProjectGitRepositoryDelegationAuditAction"
        WHEN 'activated' THEN delegation."activatedAt"
        WHEN 'rejected' THEN delegation."rejectedAt"
      END
    FROM "ProjectGitRepositoryDelegation" delegation
    WHERE delegation."id" = ${input.delegationId}::uuid
  `);
}

test(
  "Git repository delegation enforces owner scope, independent confirmations, safe projection, and drift invalidation",
  { skip: !shouldRun ? "PROJECT_GIT_REPOSITORY_DELEGATION_POSTGRES_GATE=1 is required" : false },
  async () => {
    assertDisposableGateDatabase();
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const connectionOwnerId = randomUUID();
    const projectOwnerId = randomUUID();
    const parityConnectionOwnerId = randomUUID();
    const viewerId = randomUUID();
    const projectId = randomUUID();
    const connectionId = randomUUID();
    const foreignConnectionId = randomUUID();
    const parityConnectionId = randomUUID();
    const credentialId = randomUUID();
    const foreignCredentialId = randomUUID();
    const parityCredentialId = randomUUID();
    const now = new Date();
    const connectionFingerprint = "a".repeat(64);
    const addressFingerprint = "b".repeat(64);
    let connectionOwnerAccountAccessVersion = 1;
    let parityConnectionOwnerAccountAccessVersion = 1;
    const connectionOwnerActor = () => ({
      id: connectionOwnerId,
      role: "user" as const,
      accountAccessVersion: connectionOwnerAccountAccessVersion,
    });
    const parityConnectionOwnerActor = () => ({
      id: parityConnectionOwnerId,
      role: "user" as const,
      accountAccessVersion: parityConnectionOwnerAccountAccessVersion,
    });
    const projectOwnerActor = { id: projectOwnerId, role: "user" as const, accountAccessVersion: 1 };
    const viewerActor = { id: viewerId, role: "user" as const, accountAccessVersion: 1 };
    const { workspaceId } = await createPostgresWorkspaceFixture(db);

    await db.appUser.createMany({
      data: [
        { id: connectionOwnerId, username: `git_delegation_owner_${suffix}`, role: "user" },
        { id: projectOwnerId, username: `git_delegation_project_owner_${suffix}`, role: "user" },
        { id: parityConnectionOwnerId, username: `git_delegation_parity_owner_${suffix}`, role: "user" },
        { id: viewerId, username: `git_delegation_viewer_${suffix}`, role: "user" },
      ],
    });
    const project = await db.project.create({ data: { id: projectId, workspaceId, name: `Git delegation ${suffix}`, slug: `git-delegation-${suffix}` } });
    await db.$transaction(async (tx) => {
      await grantWorkspaceMembership(tx, { workspaceId, userId: connectionOwnerId, role: "member", actorId: seededAdminId, reason: "git_delegation_gate_owner" });
      await grantWorkspaceMembership(tx, { workspaceId, userId: projectOwnerId, role: "member", actorId: seededAdminId, reason: "git_delegation_gate_project_owner" });
      await grantWorkspaceMembership(tx, { workspaceId, userId: parityConnectionOwnerId, role: "member", actorId: seededAdminId, reason: "git_delegation_gate_parity_owner" });
      await grantWorkspaceMembership(tx, { workspaceId, userId: viewerId, role: "member", actorId: seededAdminId, reason: "git_delegation_gate_viewer" });
      await grantProjectMembership(tx, { projectId: project.id, workspaceId, userId: connectionOwnerId, role: "editor", actorId: seededAdminId, reason: "git_delegation_gate_owner" });
      await grantProjectMembership(tx, { projectId: project.id, workspaceId, userId: projectOwnerId, role: "owner", actorId: seededAdminId, reason: "git_delegation_gate_project_owner" });
      await grantProjectMembership(tx, { projectId: project.id, workspaceId, userId: parityConnectionOwnerId, role: "editor", actorId: seededAdminId, reason: "git_delegation_gate_parity_owner" });
      await grantProjectMembership(tx, { projectId: project.id, workspaceId, userId: viewerId, role: "viewer", actorId: seededAdminId, reason: "git_delegation_gate_viewer" });
    });
    const [connectionOwnerMembership, projectOwnerMembership, viewerMembership] = await Promise.all([
      db.projectMembership.findFirstOrThrow({
        where: { projectId: project.id, userId: connectionOwnerId, role: "editor", accessState: "confirmed" },
        select: { id: true, createdAt: true },
      }),
      db.projectMembership.findFirstOrThrow({
        where: { projectId: project.id, userId: projectOwnerId, role: "owner", accessState: "confirmed" },
        select: { id: true, createdAt: true },
      }),
      db.projectMembership.findFirstOrThrow({
        where: { projectId: project.id, userId: viewerId, role: "viewer", accessState: "confirmed" },
        select: { id: true, createdAt: true },
      }),
    ]);
    await db.externalCredential.createMany({
      data: [
        { id: credentialId, kind: "git", ciphertext: Buffer.from([1]), nonce: Buffer.from([2]), authTag: Buffer.from([3]), maskedSuffix: "gate", secretFingerprint: connectionFingerprint },
        { id: foreignCredentialId, kind: "git", ciphertext: Buffer.from([4]), nonce: Buffer.from([5]), authTag: Buffer.from([6]), maskedSuffix: "foreign", secretFingerprint: "c".repeat(64) },
        { id: parityCredentialId, kind: "git", ciphertext: Buffer.from([7]), nonce: Buffer.from([8]), authTag: Buffer.from([9]), maskedSuffix: "parity", secretFingerprint: "d".repeat(64) },
      ],
    });
    const common = {
      providerKind: "github" as const,
      transport: "https" as const,
      baseUrl: "https://github.com",
      authKind: "token" as const,
      status: "verified" as const,
      ownershipState: "confirmed" as const,
      resolvedAddressFingerprint: addressFingerprint,
      createdById: connectionOwnerId,
      ownerUserId: connectionOwnerId,
      credentialId,
      ownerAccountAccessVersion: 1,
    };
    await createGitConnectionFixture({ ...common, id: connectionId, name: `Own Git ${suffix}` }, db);
    await createGitConnectionFixture({ ...common, id: foreignConnectionId, name: `Foreign Git ${suffix}`, ownerUserId: projectOwnerId, createdById: projectOwnerId, credentialId: foreignCredentialId }, db);
    await createGitConnectionFixture({ ...common, id: parityConnectionId, name: `Parity Git ${suffix}`, ownerUserId: parityConnectionOwnerId, createdById: parityConnectionOwnerId, credentialId: parityCredentialId }, db);

    await assert.rejects(
      () => proposeProjectGitRepositoryDelegation(projectId, {
        gitConnectionId: foreignConnectionId,
        repositoryPath: "org/repo",
        trackedRef: "main",
        includeRoots: ["."],
        softExcludePatterns: [],
        role: "primary",
        expiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
      }, connectionOwnerActor(), db),
      (error: unknown) => errorText(error).includes("CONNECTION_NOT_FOUND"),
    );

    const draft = await proposeProjectGitRepositoryDelegation(projectId, {
      gitConnectionId: connectionId,
      repositoryPath: "org/repo",
      trackedRef: "main",
      includeRoots: ["."],
      softExcludePatterns: ["docs/generated/**"],
      role: "primary",
      expiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
    }, connectionOwnerActor(), db);
    assert.equal(draft.status, "draft");
    assert.equal(draft.scope.manualSyncAllowed, true);
    assert.equal(draft.scope.automationAllowed, false);
    assert.doesNotMatch(JSON.stringify(draft), /github\.com|credential|Fingerprint|username|maskedSuffix|tlsCaCertificate|sshKnownHost/u);
    await assert.rejects(
      () => db.$executeRaw(Prisma.sql`
        INSERT INTO "ProjectGitRepositoryDelegation" (
          "id", "projectId", "gitConnectionId", "connectionOwnerId", "connectionOwnerAccountAccessVersion", "repositoryPath", "trackedRef",
          "includeRoots", "softExcludePatterns", "role", "requiredForProjectSnapshot", "codeEnabled",
          "metadataEnabled", "manualSyncAllowed", "automationAllowed", "expiresAt",
          "connectionConfigurationVersion", "resolvedAddressFingerprint", "credentialFingerprint",
          "delegationFingerprint", "version", "status", "ownerProjectMembershipId",
          "ownerMembershipCreatedAt", "proposedById"
        )
          SELECT gen_random_uuid(), "projectId", "gitConnectionId", "connectionOwnerId", "connectionOwnerAccountAccessVersion", 'org/manual-read-only-check',
          "trackedRef", "includeRoots", "softExcludePatterns", "role", "requiredForProjectSnapshot", "codeEnabled",
          "metadataEnabled", true, true, "expiresAt", "connectionConfigurationVersion",
          "resolvedAddressFingerprint", "credentialFingerprint", "delegationFingerprint", 1, 'draft',
          "ownerProjectMembershipId", "ownerMembershipCreatedAt", "proposedById"
        FROM "ProjectGitRepositoryDelegation"
        WHERE "id" = ${draft.id}::uuid
      `),
      /PGRD_manual_read_only_check/u,
    );
    await assert.rejects(
      () => db.$executeRaw(Prisma.sql`
        INSERT INTO "ProjectGitRepositoryDelegation" (
          "id", "projectId", "gitConnectionId", "connectionOwnerId", "connectionOwnerAccountAccessVersion", "repositoryPath", "trackedRef",
          "includeRoots", "softExcludePatterns", "role", "requiredForProjectSnapshot", "codeEnabled",
          "metadataEnabled", "manualSyncAllowed", "automationAllowed", "expiresAt",
          "connectionConfigurationVersion", "resolvedAddressFingerprint", "credentialFingerprint",
          "delegationFingerprint", "version", "status", "ownerProjectMembershipId",
          "ownerMembershipCreatedAt", "proposedById"
        )
          SELECT gen_random_uuid(), "projectId", "gitConnectionId", "connectionOwnerId", "connectionOwnerAccountAccessVersion", 'org/manual-read-only-check-2',
          "trackedRef", "includeRoots", "softExcludePatterns", "role", "requiredForProjectSnapshot", "codeEnabled",
          "metadataEnabled", false, false, "expiresAt", "connectionConfigurationVersion",
          "resolvedAddressFingerprint", "credentialFingerprint", "delegationFingerprint", 1, 'draft',
          "ownerProjectMembershipId", "ownerMembershipCreatedAt", "proposedById"
        FROM "ProjectGitRepositoryDelegation"
        WHERE "id" = ${draft.id}::uuid
      `),
      /PGRD_manual_read_only_check/u,
    );

    const ownerConfirmed = await confirmProjectGitRepositoryDelegationOwner(projectId, draft.id, {
      expectedVersion: draft.version,
      acknowledgeReadOnlyCredentialUse: true,
    }, connectionOwnerActor(), db);
    assert.equal(ownerConfirmed.status, "ownerConfirmed");
    const active = await confirmProjectGitRepositoryDelegationProject(projectId, draft.id, {
      expectedVersion: ownerConfirmed.version,
      acknowledgeRepositoryScope: true,
      acknowledgeDataEgress: true,
    }, projectOwnerActor, db);
    assert.equal(active.status, "active");

    const baseForAutomation = await db.projectGitRepositoryDelegation.findUniqueOrThrow({
      where: { id: draft.id },
      select: { expiresAt: true, repositoryPath: true, trackedRef: true, includeRoots: true, softExcludePatterns: true },
    });
    await assert.rejects(
      () => proposeProjectGitAutomationGrant(projectId, {
        baseDelegationId: draft.id,
        runIntervalMinutes: 59,
        expiresAt: baseForAutomation.expiresAt.toISOString(),
      }, connectionOwnerActor(), db),
      (error: unknown) => errorText(error).includes("PROJECT_GIT_AUTOMATION_GRANT_INVALID_INPUT"),
    );
    await assert.rejects(
      () => proposeProjectGitAutomationGrant(projectId, {
        baseDelegationId: draft.id,
        runIntervalMinutes: 60,
        expiresAt: new Date(baseForAutomation.expiresAt.getTime() + 1_000).toISOString(),
      }, connectionOwnerActor(), db),
      (error: unknown) => errorText(error).includes("PROJECT_GIT_AUTOMATION_GRANT_INVALID_INPUT"),
    );
    assert.equal(await db.projectGitRepositoryAutomationGrant.count({ where: { baseDelegationId: draft.id } }), 0);

    const automationDraft = await proposeProjectGitAutomationGrant(projectId, {
      baseDelegationId: draft.id,
      runIntervalMinutes: 60,
      expiresAt: baseForAutomation.expiresAt.toISOString(),
    }, connectionOwnerActor(), db);
    assert.equal(automationDraft.status, "draft");
    assert.deepEqual(automationDraft.scope, {
      repositoryPath: baseForAutomation.repositoryPath,
      trackedRef: baseForAutomation.trackedRef,
      includeRoots: baseForAutomation.includeRoots,
      softExcludePatterns: baseForAutomation.softExcludePatterns,
    });
    assert.equal(automationDraft.schedule.runIntervalMinutes, 60);
    assert.equal(automationDraft.capabilities.canConfirmConnectionOwner, true);
    assert.equal(automationDraft.capabilities.canActivateProjectOwner, false);
    await assert.rejects(
      () => activateProjectGitAutomationGrantProjectOwner(projectId, automationDraft.id, {
        expectedVersion: automationDraft.version,
        acknowledgeExactRepositoryScope: true,
        acknowledgeReadOnlyDataEgress: true,
      }, projectOwnerActor, db),
      (error: unknown) => errorText(error).includes("PROJECT_GIT_AUTOMATION_GRANT_STATE_CONFLICT"),
    );
    await assert.rejects(
      () => db.$executeRaw(Prisma.sql`
        UPDATE "ProjectGitRepositoryAutomationGrant"
        SET "version" = "version" + 1,
            "status" = 'active'
        WHERE "id" = ${automationDraft.id}::uuid
      `),
      /PROJECT_GIT_AUTOMATION_GRANT_STATE_INVALID/u,
    );
    await assert.rejects(
      () => db.$executeRaw(Prisma.sql`
        UPDATE "ProjectGitRepositoryAutomationGrant"
        SET "version" = "version" + 1,
            "repositoryPath" = 'org/widened-scope'
        WHERE "id" = ${automationDraft.id}::uuid
      `),
      /PROJECT_GIT_AUTOMATION_GRANT_IMMUTABLE/u,
    );
    const automationOwnerConfirmed = await confirmProjectGitAutomationGrantConnectionOwner(projectId, automationDraft.id, {
      expectedVersion: automationDraft.version,
      acknowledgeReadOnlyScheduledAccess: true,
    }, connectionOwnerActor(), db);
    assert.equal(automationOwnerConfirmed.status, "ownerConfirmed");
    assert.ok("capabilities" in automationOwnerConfirmed);
    assert.equal(automationOwnerConfirmed.capabilities.canActivateProjectOwner, false);
    const projectOwnerActivationView = await getProjectGitAutomationGrant(projectId, automationDraft.id, projectOwnerActor, db);
    assert.equal(projectOwnerActivationView.capabilities.canActivateProjectOwner, true);
    const activeAutomationGrant = await activateProjectGitAutomationGrantProjectOwner(projectId, automationDraft.id, {
      expectedVersion: automationOwnerConfirmed.version,
      acknowledgeExactRepositoryScope: true,
      acknowledgeReadOnlyDataEgress: true,
    }, projectOwnerActor, db);
    assert.equal(activeAutomationGrant.status, "active");
    assert.ok("readiness" in activeAutomationGrant);
    assert.equal(activeAutomationGrant.readiness.eligible, true);
    assert.equal(await db.projectGitRepositoryAutomationGrantAudit.count({ where: { grantId: automationDraft.id } }), 3);
    await assert.rejects(
      () => db.$executeRaw(Prisma.sql`
        UPDATE "ProjectGitRepositoryAutomationGrantAudit"
        SET "reason" = 'forged audit'
        WHERE "grantId" = ${automationDraft.id}::uuid
      `),
      /PROJECT_GIT_AUTOMATION_GRANT_AUDIT_IMMUTABLE/u,
    );
    const governedBeforeGrantRevoke = await db.gitConnection.findUniqueOrThrow({ where: { id: connectionId } });
    const blockedByAutomationGrant = await previewGitConnectionMutation(connectionId, {
      action: "disable",
      requestKey: `git-delegation-grant-block-${suffix}`,
      reason: "live automation grant requires explicit revocation before connection disable",
      expectedUpdatedAt: governedBeforeGrantRevoke.updatedAt.toISOString(),
    }, connectionOwnerActor(), db);
    assert.equal(blockedByAutomationGrant.canExecute, false);
    assert.equal(blockedByAutomationGrant.blockers.includes("live_automation_grant"), true);
    await assert.rejects(
      () => disableGitConnection(connectionId, connectionOwnerActor(), db),
      (error: unknown) => errorText(error).includes("GIT_CONNECTION_IN_USE"),
    );
    const revokedAutomationGrant = await revokeProjectGitAutomationGrant(projectId, automationDraft.id, {
      expectedVersion: activeAutomationGrant.version,
      reason: "cancel control-plane acceptance gate grant",
    }, connectionOwnerActor(), db);
    assert.equal(revokedAutomationGrant.status, "revoked");
    assert.ok("capabilities" in revokedAutomationGrant);
    assert.equal(revokedAutomationGrant.capabilities.canRevoke, false);
    assert.equal(await db.projectGitRepositoryAutomationGrantAudit.count({ where: { grantId: automationDraft.id } }), 4);
    assert.equal((await getProjectGitAutomationGrant(projectId, automationDraft.id, projectOwnerActor, db)).status, "revoked");
    assert.equal((await getProjectGitAutomationGrant(projectId, automationDraft.id, viewerActor, db)).terminalReason, null);

    const draftToRevoke = await proposeProjectGitAutomationGrant(projectId, {
      baseDelegationId: draft.id,
      runIntervalMinutes: 60,
      expiresAt: baseForAutomation.expiresAt.toISOString(),
    }, connectionOwnerActor(), db);
    assert.equal((await revokeProjectGitAutomationGrant(projectId, draftToRevoke.id, {
      expectedVersion: draftToRevoke.version,
      reason: "cancel unconfirmed automatic access",
    }, connectionOwnerActor(), db)).status, "revoked");

    const ownerConfirmedToRevoke = await proposeProjectGitAutomationGrant(projectId, {
      baseDelegationId: draft.id,
      runIntervalMinutes: 60,
      expiresAt: baseForAutomation.expiresAt.toISOString(),
    }, connectionOwnerActor(), db);
    const confirmedToRevoke = await confirmProjectGitAutomationGrantConnectionOwner(projectId, ownerConfirmedToRevoke.id, {
      expectedVersion: ownerConfirmedToRevoke.version,
      acknowledgeReadOnlyScheduledAccess: true,
    }, connectionOwnerActor(), db);
    assert.equal((await revokeProjectGitAutomationGrant(projectId, ownerConfirmedToRevoke.id, {
      expectedVersion: confirmedToRevoke.version,
      reason: "cancel before project owner activation",
    }, projectOwnerActor, db)).status, "revoked");
    const afterEarlyGrantRevocations = await previewGitConnectionMutation(connectionId, {
      action: "disable",
      requestKey: `git-delegation-grant-released-${suffix}`,
      reason: "verify all automatic grants are terminal",
      expectedUpdatedAt: governedBeforeGrantRevoke.updatedAt.toISOString(),
    }, connectionOwnerActor(), db);
    assert.equal(afterEarlyGrantRevocations.blockers.includes("live_automation_grant"), false);

    const racingDraft = await proposeProjectGitAutomationGrant(projectId, {
      baseDelegationId: draft.id,
      runIntervalMinutes: 60,
      expiresAt: baseForAutomation.expiresAt.toISOString(),
    }, connectionOwnerActor(), db);
    const racingConfirmed = await confirmProjectGitAutomationGrantConnectionOwner(projectId, racingDraft.id, {
      expectedVersion: racingDraft.version,
      acknowledgeReadOnlyScheduledAccess: true,
    }, connectionOwnerActor(), db);
    const racingResults = await Promise.allSettled([
      activateProjectGitAutomationGrantProjectOwner(projectId, racingDraft.id, {
        expectedVersion: racingConfirmed.version,
        acknowledgeExactRepositoryScope: true,
        acknowledgeReadOnlyDataEgress: true,
      }, projectOwnerActor, db),
      revokeProjectGitAutomationGrant(projectId, racingDraft.id, {
        expectedVersion: racingConfirmed.version,
        reason: "race project activation against connection owner withdrawal",
      }, connectionOwnerActor(), db),
    ]);
    assert.equal(racingResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(racingResults.filter((result) => result.status === "rejected").length, 1);
    const racingFinal = await db.projectGitRepositoryAutomationGrant.findUniqueOrThrow({ where: { id: racingDraft.id } });
    assert.ok(racingFinal.status === "active" || racingFinal.status === "revoked");
    assert.equal(racingFinal.version, racingConfirmed.version + 1);
    assert.equal(await db.projectGitRepositoryAutomationGrantAudit.count({ where: { grantId: racingDraft.id } }), 3);
    if (racingFinal.status === "active") {
      await revokeProjectGitAutomationGrant(projectId, racingDraft.id, {
        expectedVersion: racingFinal.version,
        reason: "clean up concurrent activation gate",
      }, connectionOwnerActor(), db);
    }

    const connectionBeforeLockOrderCheck = await db.gitConnection.findUniqueOrThrow({ where: { id: connectionId } });
    let releaseFence!: () => void;
    let fenceAcquired!: () => void;
    const releaseFencePromise = new Promise<void>((resolve) => { releaseFence = resolve; });
    const fenceAcquiredPromise = new Promise<void>((resolve) => { fenceAcquired = resolve; });
    const fenceHolder = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('ai-project-git-repository-delegation-global', 0))`;
      fenceAcquired();
      await releaseFencePromise;
    });
    await fenceAcquiredPromise;
    const blockedConnectionUpdate = updateGitConnection(connectionId, {
      name: connectionBeforeLockOrderCheck.name,
      expectedUpdatedAt: connectionBeforeLockOrderCheck.updatedAt.toISOString(),
    }, connectionOwnerActor(), db);
    let lockOrderFailure: unknown;
    try {
      await waitForDelegationFenceWait(db);
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "GitConnection" WHERE "id" = ${connectionId}::uuid FOR UPDATE NOWAIT`;
      });
    } catch (error) {
      lockOrderFailure = error;
    } finally {
      releaseFence();
      await fenceHolder;
    }
    await blockedConnectionUpdate;
    if (lockOrderFailure !== undefined) throw lockOrderFailure;

    const viewerProjection = await listProjectGitRepositoryDelegations(projectId, viewerActor, db);
    assert.equal(viewerProjection.delegations.length, 1);
    assert.equal(viewerProjection.delegations[0]?.connection, null);
    assert.equal(viewerProjection.delegations[0]?.connectionOwner?.displayName, "项目成员");
    assert.doesNotMatch(JSON.stringify(viewerProjection), /git_delegation_(?:owner|project_owner|viewer)_/u);
    assert.equal(viewerProjection.delegations[0]?.capabilities.canProjectConfirm, false);
    assert.equal(viewerProjection.delegations[0]?.capabilities.canManualSync, false);
    const connectionOwnerProjection = await listProjectGitRepositoryDelegations(projectId, connectionOwnerActor(), db);
    assert.equal(connectionOwnerProjection.delegations[0]?.connection?.name, `Own Git ${suffix}`);
    const ownerSafetyBeforeMembershipDrift = await listConnectionOwnerProjectGitRepositoryDelegations(connectionOwnerActor(), db);
    assert.equal(ownerSafetyBeforeMembershipDrift.some((item) => item.id === draft.id && item.capabilities.canRevoke), true);
    assert.deepEqual(await listConnectionOwnerProjectGitRepositoryDelegations(projectOwnerActor, db), []);
    await assert.rejects(
      () => revokeProjectGitRepositoryDelegation(projectId, draft.id, {
        expectedVersion: active.version,
        reason: "viewer must not revoke",
      }, viewerActor, db),
      /PROJECT_GIT_REPOSITORY_DELEGATION_FORBIDDEN/u,
    );
    await assert.rejects(
      () => revokeProjectGitRepositoryDelegation(projectId, randomUUID(), {
        expectedVersion: 1,
        reason: "viewer must not learn delegation existence",
      }, viewerActor, db),
      /PROJECT_GIT_REPOSITORY_DELEGATION_FORBIDDEN/u,
    );

    const forgedDraft = await proposeProjectGitRepositoryDelegation(projectId, {
      gitConnectionId: connectionId,
      repositoryPath: "org/forged-terminal",
      trackedRef: "main",
      includeRoots: ["."],
      softExcludePatterns: [],
      role: "library",
      expiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
    }, connectionOwnerActor(), db);
    await assert.rejects(
      () => db.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "ProjectGitRepositoryDelegation"
          SET "version" = 2,
              "status" = 'owner_confirmed',
              "ownerConfirmedById" = ${connectionOwnerId}::uuid
          WHERE "id" = ${forgedDraft.id}::uuid
        `);
        await tx.$executeRaw(Prisma.sql`
          UPDATE "ProjectGitRepositoryDelegation"
          SET "version" = 3,
              "status" = 'active',
              "projectConfirmedById" = ${projectOwnerId}::uuid,
              "projectConfirmedProjectMembershipId" = ${projectOwnerMembership.id}::uuid,
              "projectConfirmedMembershipCreatedAt" = ${projectOwnerMembership.createdAt}::timestamp(3)
          WHERE "id" = ${forgedDraft.id}::uuid
        `);
        await insertCurrentDelegationAudit(tx, {
          delegationId: forgedDraft.id,
          action: "activated",
          statusBefore: "owner_confirmed",
          actorId: projectOwnerId,
          actorMembershipId: projectOwnerMembership.id,
          actorMembershipCreatedAt: projectOwnerMembership.createdAt,
          reason: "forged final-only audit",
        });
      }),
      /PROJECT_GIT_REPOSITORY_DELEGATION_AUDIT_INVALID/u,
    );
    await assert.rejects(
      () => db.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "ProjectGitRepositoryDelegation"
          SET "version" = 2,
              "status" = 'rejected',
              "terminalActorId" = ${connectionOwnerId}::uuid,
              "terminalActorProjectMembershipId" = ${connectionOwnerMembership.id}::uuid,
              "terminalActorMembershipCreatedAt" = ${connectionOwnerMembership.createdAt}::timestamp(3),
              "terminalReason" = 'terminal membership snapshot tamper'
          WHERE "id" = ${forgedDraft.id}::uuid
        `);
        await insertCurrentDelegationAudit(tx, {
          delegationId: forgedDraft.id,
          action: "rejected",
          statusBefore: "draft",
          actorId: connectionOwnerId,
          actorMembershipId: connectionOwnerMembership.id,
          actorMembershipCreatedAt: connectionOwnerMembership.createdAt,
          terminalActorProjectMembershipId: viewerMembership.id,
          terminalActorMembershipCreatedAt: viewerMembership.createdAt,
          reason: "terminal membership snapshot tamper",
        });
      }),
      /PROJECT_GIT_REPOSITORY_DELEGATION_AUDIT_INVALID/u,
    );
    await assert.rejects(
      () => db.$executeRaw(Prisma.sql`
        UPDATE "ProjectGitRepositoryDelegation"
        SET "version" = "version" + 1,
            "status" = 'rejected',
            "terminalActorId" = ${viewerId}::uuid,
            "terminalActorProjectMembershipId" = ${viewerMembership.id}::uuid,
            "terminalActorMembershipCreatedAt" = ${viewerMembership.createdAt},
            "terminalReason" = 'forged terminal actor'
        WHERE "id" = ${forgedDraft.id}::uuid
      `),
      /PROJECT_GIT_REPOSITORY_DELEGATION_AUDIT_ACTOR_INVALID/u,
    );
    await assert.rejects(
      () => db.$executeRaw(Prisma.sql`
        INSERT INTO "ProjectGitRepositoryDelegationAudit" (
          "id", "projectId", "gitConnectionId", "delegationId", "connectionOwnerId", "connectionOwnerAccountAccessVersion",
          "action", "delegationVersion", "statusBefore", "statusAfter", "actorKind",
          "actorId", "actorProjectMembershipId", "actorMembershipCreatedAt",
          "terminalActorKind", "terminalActorId", "terminalActorProjectMembershipId",
          "terminalActorMembershipCreatedAt", "terminalReason", "ownerProjectMembershipId",
          "ownerMembershipCreatedAt", "projectConfirmedProjectMembershipId",
          "projectConfirmedMembershipCreatedAt", "repositoryPath", "trackedRef", "includeRoots",
          "softExcludePatterns", "role", "requiredForProjectSnapshot", "codeEnabled",
          "metadataEnabled", "manualSyncAllowed", "automationAllowed", "expiresAt",
          "connectionConfigurationVersion", "resolvedAddressFingerprint", "credentialFingerprint",
          "delegationFingerprint", "reason", "transitionAt"
        )
        SELECT ${randomUUID()}::uuid, "projectId", "gitConnectionId", "delegationId", "connectionOwnerId", "connectionOwnerAccountAccessVersion",
          'proposed'::"ProjectGitRepositoryDelegationAuditAction", "delegationVersion", "statusBefore", "statusAfter",
          'user'::"ProjectGitRepositoryDelegationActorKind", ${viewerId}::uuid, ${viewerMembership.id}::uuid,
          ${viewerMembership.createdAt}, "terminalActorKind", "terminalActorId", "terminalActorProjectMembershipId",
          "terminalActorMembershipCreatedAt", "terminalReason", "ownerProjectMembershipId", "ownerMembershipCreatedAt",
          "projectConfirmedProjectMembershipId", "projectConfirmedMembershipCreatedAt", "repositoryPath", "trackedRef",
          "includeRoots", "softExcludePatterns", "role", "requiredForProjectSnapshot", "codeEnabled", "metadataEnabled",
          "manualSyncAllowed", "automationAllowed", "expiresAt", "connectionConfigurationVersion",
          "resolvedAddressFingerprint", "credentialFingerprint", "delegationFingerprint", 'forged audit', "transitionAt"
        FROM "ProjectGitRepositoryDelegationAudit"
        WHERE "delegationId" = ${forgedDraft.id}::uuid
          AND "action" = 'proposed'::"ProjectGitRepositoryDelegationAuditAction"
      `),
      /PROJECT_GIT_REPOSITORY_DELEGATION_AUDIT_ACTOR_INVALID/u,
    );

    const parityDraft = await proposeProjectGitRepositoryDelegation(projectId, {
      gitConnectionId: parityConnectionId,
      repositoryPath: "org/capability-parity",
      trackedRef: "main",
      includeRoots: ["."],
      softExcludePatterns: [],
      role: "library",
      expiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
    }, parityConnectionOwnerActor(), db);
    const parityOwnerConfirmed = await confirmProjectGitRepositoryDelegationOwner(projectId, parityDraft.id, {
      expectedVersion: parityDraft.version,
      acknowledgeReadOnlyCredentialUse: true,
    }, parityConnectionOwnerActor(), db);
    const parityBeforeDrift = await listProjectGitRepositoryDelegations(projectId, projectOwnerActor, db);
    assert.equal(parityBeforeDrift.delegations.find((item) => item.id === parityDraft.id)?.capabilities.canProjectConfirm, true);
    const parityOwnerSafetyBeforeDrift = await listConnectionOwnerProjectGitRepositoryDelegations(parityConnectionOwnerActor(), db);
    assert.equal(parityOwnerSafetyBeforeDrift.some((item) => item.id === parityDraft.id && item.capabilities.canReject), true);
    const parityDisabledOwner = await setAccountAccessState(db, {
      adminUserId: seededAdminId,
      userId: parityConnectionOwnerId,
      action: "disable",
      reason: "capability parity disabled owner",
      requestKey: `git-delegation-parity-disable-${suffix}`,
    });
    assert.equal(parityDisabledOwner.state, "disabled");
    await assert.rejects(
      () => listConnectionOwnerProjectGitRepositoryDelegations(parityConnectionOwnerActor(), db),
      /PROJECT_GIT_REPOSITORY_DELEGATION_FORBIDDEN/u,
    );
    const parityAfterOwnerDisabled = await listProjectGitRepositoryDelegations(projectId, projectOwnerActor, db);
    assert.equal(parityAfterOwnerDisabled.delegations.find((item) => item.id === parityDraft.id)?.capabilities.canProjectConfirm, false);
    const parityRestoredOwner = await setAccountAccessState(db, {
      adminUserId: seededAdminId,
      userId: parityConnectionOwnerId,
      action: "restore",
      reason: "capability parity owner restored",
      requestKey: `git-delegation-parity-restore-${suffix}`,
    });
    assert.equal(parityRestoredOwner.state, "enabled");
    parityConnectionOwnerAccountAccessVersion = parityRestoredOwner.accountAccessVersion;
    const parityOwnerSafetyAfterRestore = await listConnectionOwnerProjectGitRepositoryDelegations(parityConnectionOwnerActor(), db);
    assert.deepEqual(parityOwnerSafetyAfterRestore, []);
    assert.equal((await getProjectGitRepositoryDelegationLiveEligibility(projectId, parityDraft.id, db)).eligible, false);
    await db.$transaction(async (tx) => {
      await revokeProjectMembership(tx, projectId, parityConnectionOwnerId, workspaceId, { actorId: seededAdminId, reason: "git_delegation_gate_capability_owner_epoch" });
      await grantProjectMembership(tx, { projectId, workspaceId, userId: parityConnectionOwnerId, role: "editor", actorId: seededAdminId, reason: "git_delegation_gate_capability_owner_epoch_readd" });
    });
    const parityAfterOwnerDrift = await listProjectGitRepositoryDelegations(projectId, projectOwnerActor, db);
    assert.equal(parityAfterOwnerDrift.delegations.find((item) => item.id === parityDraft.id)?.capabilities.canProjectConfirm, false);
    const parityRejected = await rejectProjectGitRepositoryDelegation(projectId, parityDraft.id, { expectedVersion: parityOwnerConfirmed.version, reason: "capability parity owner epoch drift" }, parityConnectionOwnerActor(), db);
    assert.equal(parityRejected.status, "rejected");

    const archiveCredentialId = randomUUID();
    const archiveConnectionId = randomUUID();
    const archiveConnectionFingerprint = "e".repeat(64);
    await db.externalCredential.create({
      data: {
        id: archiveCredentialId,
        kind: "git",
        ciphertext: Buffer.from([10]),
        nonce: Buffer.from([11]),
        authTag: Buffer.from([12]),
        maskedSuffix: "archive-gate",
        secretFingerprint: archiveConnectionFingerprint,
      },
    });
    await createGitConnectionFixture({
      ...common,
      id: archiveConnectionId,
      name: `Archive Git ${suffix}`,
      createdById: projectOwnerId,
      ownerUserId: projectOwnerId,
      credentialId: archiveCredentialId,
    }, db);
    const archiveBaseDraft = await proposeProjectGitRepositoryDelegation(projectId, {
      gitConnectionId: archiveConnectionId,
      repositoryPath: "org/archive-scope",
      trackedRef: "main",
      includeRoots: ["docs"],
      softExcludePatterns: ["docs/private/**"],
      role: "library",
      expiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
    }, projectOwnerActor, db);
    const archiveBaseOwnerConfirmed = await confirmProjectGitRepositoryDelegationOwner(projectId, archiveBaseDraft.id, {
      expectedVersion: archiveBaseDraft.version,
      acknowledgeReadOnlyCredentialUse: true,
    }, projectOwnerActor, db);
    const archiveBaseActive = await confirmProjectGitRepositoryDelegationProject(projectId, archiveBaseDraft.id, {
      expectedVersion: archiveBaseOwnerConfirmed.version,
      acknowledgeRepositoryScope: true,
      acknowledgeDataEgress: true,
    }, projectOwnerActor, db);
    const archiveAutomationDraft = await proposeProjectGitAutomationGrant(projectId, {
      baseDelegationId: archiveBaseActive.id,
      runIntervalMinutes: 60,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
    }, projectOwnerActor, db);
    const archiveAutomationOwnerConfirmed = await confirmProjectGitAutomationGrantConnectionOwner(projectId, archiveAutomationDraft.id, {
      expectedVersion: archiveAutomationDraft.version,
      acknowledgeReadOnlyScheduledAccess: true,
    }, projectOwnerActor, db);
    const archiveAutomationActive = await activateProjectGitAutomationGrantProjectOwner(projectId, archiveAutomationDraft.id, {
      expectedVersion: archiveAutomationOwnerConfirmed.version,
      acknowledgeExactRepositoryScope: true,
      acknowledgeReadOnlyDataEgress: true,
    }, projectOwnerActor, db);
    assert.equal(archiveAutomationActive.status, "active");

    const connectionBeforeCredentialRotation = await db.gitConnection.findUniqueOrThrow({ where: { id: connectionId } });
    const rotationSecret = `rotated-git-secret-${suffix}`;
    const rotationPreview = await previewGitConnectionMutation(connectionId, {
      action: "rotateCredential",
      requestKey: `git-delegation-rotate-${suffix}`,
      reason: "governed credential rotation invalidates delegation evidence",
      expectedUpdatedAt: connectionBeforeCredentialRotation.updatedAt.toISOString(),
      secret: rotationSecret,
    }, connectionOwnerActor(), db);
    assert.equal(rotationPreview.canExecute, true);
    const rotationResult = await executeGitConnectionMutation(connectionId, {
      previewId: rotationPreview.id,
      requestKey: rotationPreview.requestKey,
      requestFingerprint: rotationPreview.requestFingerprint,
      impactFingerprint: rotationPreview.impactFingerprint,
      expectedUpdatedAt: rotationPreview.connection.updatedAt,
      secret: rotationSecret,
    }, connectionOwnerActor(), db);
    assert.equal(rotationResult.status, "completed");
    const rotatedConnection = await db.gitConnection.findUniqueOrThrow({ where: { id: connectionId } });
    assert.equal(rotatedConnection.status, "configured");
    assert.equal(rotatedConnection.configurationVersion, connectionBeforeCredentialRotation.configurationVersion + 1);
    assert.equal(rotatedConnection.resolvedAddressFingerprint, null);
    const rotatedEligibility = await getProjectGitRepositoryDelegationLiveEligibility(projectId, draft.id, db);
    assert.equal(rotatedEligibility.eligible, false);
    assert.equal(rotatedEligibility.reason, "CONNECTION_DRIFT");

    const disablePreview = await previewGitConnectionMutation(connectionId, {
      action: "disable",
      requestKey: `git-delegation-disable-${suffix}`,
      reason: "governed disable retains delegation evidence for review",
      expectedUpdatedAt: rotatedConnection.updatedAt.toISOString(),
    }, connectionOwnerActor(), db);
    assert.equal(disablePreview.canExecute, true);
    const disableResult = await executeGitConnectionMutation(connectionId, {
      previewId: disablePreview.id,
      requestKey: disablePreview.requestKey,
      requestFingerprint: disablePreview.requestFingerprint,
      impactFingerprint: disablePreview.impactFingerprint,
      expectedUpdatedAt: disablePreview.connection.updatedAt,
    }, connectionOwnerActor(), db);
    assert.equal(disableResult.status, "completed");
    const disabledConnection = await db.gitConnection.findUniqueOrThrow({ where: { id: connectionId } });

    const blockedDeletePreview = await previewGitConnectionMutation(connectionId, {
      action: "delete",
      requestKey: `git-delegation-delete-blocked-${suffix}`,
      reason: "deletion remains blocked while historical delegation evidence is retained",
      expectedUpdatedAt: disabledConnection.updatedAt.toISOString(),
      confirmationName: `Own Git ${suffix}`,
    }, connectionOwnerActor(), db);
    assert.equal(blockedDeletePreview.canExecute, false);
    assert.equal(blockedDeletePreview.blockers.includes("live_delegation"), true);
    assert.equal(
      blockedDeletePreview.blockers.includes("historical_reference") || blockedDeletePreview.blockers.includes("live_delegation"),
      true,
    );
    await assert.rejects(
      () => executeGitConnectionMutation(connectionId, {
        previewId: blockedDeletePreview.id,
        requestKey: blockedDeletePreview.requestKey,
        requestFingerprint: blockedDeletePreview.requestFingerprint,
        impactFingerprint: blockedDeletePreview.impactFingerprint,
        expectedUpdatedAt: blockedDeletePreview.connection.updatedAt,
        confirmationName: `Own Git ${suffix}`,
      }, connectionOwnerActor(), db),
      (error: unknown) => errorText(error).includes("GIT_CONNECTION_IN_USE"),
    );
    const disabledOwner = await setAccountAccessState(db, {
      adminUserId: seededAdminId,
      userId: connectionOwnerId,
      action: "disable",
      reason: "delegation safety list gate",
      requestKey: `git-delegation-owner-disable-${suffix}`,
    });
    assert.equal(disabledOwner.state, "disabled");
    await assert.rejects(
      () => listConnectionOwnerProjectGitRepositoryDelegations(connectionOwnerActor(), db),
      /PROJECT_GIT_REPOSITORY_DELEGATION_FORBIDDEN/u,
    );
    const restoredOwner = await setAccountAccessState(db, {
      adminUserId: seededAdminId,
      userId: connectionOwnerId,
      action: "restore",
      reason: "delegation safety list gate restored",
      requestKey: `git-delegation-owner-restore-${suffix}`,
    });
    assert.equal(restoredOwner.state, "enabled");
    connectionOwnerAccountAccessVersion = restoredOwner.accountAccessVersion;
    assert.deepEqual(await listConnectionOwnerProjectGitRepositoryDelegations(connectionOwnerActor(), db), []);
    const drifted = await getProjectGitRepositoryDelegationLiveEligibility(projectId, draft.id, db);
    assert.equal(drifted.eligible, false);
    assert.equal(drifted.reason, "CONNECTION_DRIFT");
    const disabledProjection = await listProjectGitRepositoryDelegations(projectId, projectOwnerActor, db);
    assert.equal(disabledProjection.delegations.find((item) => item.id === draft.id)?.capabilities.canManualSync, false);

    await db.$transaction(async (tx) => {
      await revokeProjectMembership(tx, projectId, connectionOwnerId, workspaceId, {
        actorId: seededAdminId,
        reason: "git_delegation_gate_owner_membership_drift",
      });
      await grantProjectMembership(tx, {
        projectId,
        workspaceId,
        userId: connectionOwnerId,
        role: "editor",
        actorId: seededAdminId,
        reason: "git_delegation_gate_owner_membership_replacement",
      });
    });

    const ownerSafetyAfterMembershipDrift = await listConnectionOwnerProjectGitRepositoryDelegations(connectionOwnerActor(), db);
    assert.equal(ownerSafetyAfterMembershipDrift.some((item) => item.id === draft.id && item.project.archivedAt === null && item.capabilities.canRevoke), false);

    const rejected = await rejectProjectGitRepositoryDelegation(projectId, forgedDraft.id, {
      expectedVersion: forgedDraft.version,
      reason: "connection owner rejected after membership replacement",
    }, connectionOwnerActor(), db);
    assert.equal(rejected.status, "rejected");

    const currentProject = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { updatedAt: true } });
    await updateProjectLifecycle({
      projectId,
      actor: projectOwnerActor,
      action: "archive",
      expectedUpdatedAt: currentProject.updatedAt,
    }, db);

    const grantAfterProjectArchive = await db.projectGitRepositoryAutomationGrant.findUniqueOrThrow({
      where: { id: archiveAutomationDraft.id },
      select: { status: true, version: true, terminalReason: true },
    });
    assert.equal(grantAfterProjectArchive.status, "invalidated");
    assert.equal(grantAfterProjectArchive.version, archiveAutomationActive.version + 1);
    assert.equal(grantAfterProjectArchive.terminalReason, "project_archived");
    const grantArchiveAudit = await db.projectGitRepositoryAutomationGrantAudit.findFirstOrThrow({
      where: { grantId: archiveAutomationDraft.id, grantVersion: grantAfterProjectArchive.version },
      select: { action: true, actorKind: true, actorId: true, reason: true },
    });
    assert.deepEqual(grantArchiveAudit, {
      action: "invalidated",
      actorKind: "system",
      actorId: null,
      reason: "project_archived",
    });

    const ownerSafetyAfterArchive = await listConnectionOwnerProjectGitRepositoryDelegations(connectionOwnerActor(), db);
    assert.equal(ownerSafetyAfterArchive.some((item) => item.id === draft.id && item.project.archivedAt !== null && item.capabilities.canRevoke), false);

    const revoked = await revokeProjectGitRepositoryDelegation(projectId, draft.id, {
      expectedVersion: active.version,
      reason: "connection owner revoked after membership replacement and archive",
    }, connectionOwnerActor(), db);
    assert.equal(revoked.status, "revoked");
    const revokedAudit = await db.projectGitRepositoryDelegationAudit.findFirstOrThrow({ where: { delegationId: draft.id, action: "revoked" }, orderBy: [{ delegationVersion: "desc" }], select: { actorProjectMembershipId: true, actorMembershipCreatedAt: true } });
    assert.equal(revokedAudit.actorProjectMembershipId, connectionOwnerMembership.id);
    assert.equal(revokedAudit.actorMembershipCreatedAt?.getTime(), connectionOwnerMembership.createdAt.getTime());
    await assert.rejects(
      () => db.$executeRaw(Prisma.sql`UPDATE "ProjectGitRepositoryDelegation" SET "version" = "version" + 2 WHERE "id" = ${draft.id}::uuid`),
      /PROJECT_GIT_REPOSITORY_DELEGATION_VERSION_INVALID/u,
    );

    const auditCount = await db.projectGitRepositoryDelegationAudit.count({ where: { delegationId: draft.id } });
    const forgedAudit = await db.projectGitRepositoryDelegationAudit.findFirst({
      where: { delegationId: forgedDraft.id },
      orderBy: [{ delegationVersion: "desc" }, { createdAt: "desc" }],
      select: { action: true },
    });
    assert.equal(forgedAudit?.action, "rejected");
    const activeAuditCount = await db.projectGitRepositoryDelegationAudit.count({ where: { delegationId: draft.id } });
    const retainedConnection = await db.gitConnection.findUniqueOrThrow({ where: { id: connectionId }, select: { status: true } });
    assert.equal(retainedConnection.status, "disabled");
    assert.equal(await db.projectGitRepositoryDelegation.count({ where: { gitConnectionId: connectionId } }) > 0, true);
    assert.equal(await db.gitConnection.count({ where: { id: connectionId } }), 1);
    assert.equal(await db.externalCredential.count({ where: { id: credentialId } }), 1);
    assert.equal(await db.projectGitRepositoryDelegationAudit.count({ where: { delegationId: draft.id } }), auditCount);
    assert.equal(await db.projectGitRepositoryDelegationAudit.count({ where: { delegationId: draft.id } }), activeAuditCount);
    assert.equal(await db.projectGitRepositoryDelegationAudit.count({ where: { delegationId: forgedDraft.id } }), 2);

    const archivedProjectForDeletion = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true, updatedAt: true } });
    const deletedWithInvalidatedGrant = await deleteArchivedProject({
      projectId,
      actor: projectOwnerActor,
      confirmationName: archivedProjectForDeletion.name,
      expectedUpdatedAt: archivedProjectForDeletion.updatedAt,
    }, db);
    assert.equal(deletedWithInvalidatedGrant.projectId, projectId);
    assert.equal(await db.projectGitRepositoryAutomationGrant.count({ where: { id: archiveAutomationDraft.id } }), 0);
    assert.equal(await db.projectGitRepositoryAutomationGrantAudit.count({ where: { grantId: archiveAutomationDraft.id } }), 4);

  },
);

test(
  "Git automation grant connection owner can discover and revoke after project membership loss",
  { skip: !shouldRun ? "PROJECT_GIT_REPOSITORY_DELEGATION_POSTGRES_GATE=1 is required" : false },
  async () => {
    assertDisposableGateDatabase();
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const connectionOwnerId = randomUUID();
    const projectOwnerId = randomUUID();
    const projectId = randomUUID();
    const connectionId = randomUUID();
    const credentialId = randomUUID();
    const { workspaceId } = await createPostgresWorkspaceFixture(db);
    const connectionOwnerActor = { id: connectionOwnerId, role: "user" as const, accountAccessVersion: 1 };
    const projectOwnerActor = { id: projectOwnerId, role: "user" as const, accountAccessVersion: 1 };
    await db.appUser.createMany({ data: [
      { id: connectionOwnerId, username: `git_grant_departed_owner_${suffix}`, role: "user" },
      { id: projectOwnerId, username: `git_grant_project_owner_${suffix}`, role: "user" },
    ] });
    await db.project.create({ data: { id: projectId, workspaceId, name: `Grant withdrawal ${suffix}`, slug: `grant-withdrawal-${suffix}` } });
    await db.$transaction(async (tx) => {
      await grantWorkspaceMembership(tx, { workspaceId, userId: connectionOwnerId, role: "member", actorId: seededAdminId, reason: "grant_withdrawal_fixture" });
      await grantWorkspaceMembership(tx, { workspaceId, userId: projectOwnerId, role: "member", actorId: seededAdminId, reason: "grant_withdrawal_fixture" });
      await grantProjectMembership(tx, { projectId, workspaceId, userId: connectionOwnerId, role: "editor", actorId: seededAdminId, reason: "grant_withdrawal_fixture" });
      await grantProjectMembership(tx, { projectId, workspaceId, userId: projectOwnerId, role: "owner", actorId: seededAdminId, reason: "grant_withdrawal_fixture" });
    });
    await db.externalCredential.create({ data: {
      id: credentialId, kind: "git", ciphertext: Buffer.from([1]), nonce: Buffer.from([2]), authTag: Buffer.from([3]),
      maskedSuffix: "gate", secretFingerprint: "e".repeat(64),
    } });
    await createGitConnectionFixture({
      id: connectionId, name: `Withdrawal Git ${suffix}`, providerKind: "github", transport: "https",
      baseUrl: "https://github.com", authKind: "token", status: "verified", ownershipState: "confirmed",
      resolvedAddressFingerprint: "f".repeat(64), createdById: connectionOwnerId, ownerUserId: connectionOwnerId,
      credentialId, ownerAccountAccessVersion: 1,
    }, db);
    const baseDraft = await proposeProjectGitRepositoryDelegation(projectId, {
      gitConnectionId: connectionId, repositoryPath: "org/withdrawal", trackedRef: "main", includeRoots: ["."],
      softExcludePatterns: [], role: "primary", expiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    }, connectionOwnerActor, db);
    const baseOwnerConfirmed = await confirmProjectGitRepositoryDelegationOwner(projectId, baseDraft.id, {
      expectedVersion: baseDraft.version, acknowledgeReadOnlyCredentialUse: true,
    }, connectionOwnerActor, db);
    await confirmProjectGitRepositoryDelegationProject(projectId, baseDraft.id, {
      expectedVersion: baseOwnerConfirmed.version, acknowledgeRepositoryScope: true, acknowledgeDataEgress: true,
    }, projectOwnerActor, db);
    const base = await db.projectGitRepositoryDelegation.findUniqueOrThrow({ where: { id: baseDraft.id }, select: { expiresAt: true } });
    const grantDraft = await proposeProjectGitAutomationGrant(projectId, {
      baseDelegationId: baseDraft.id, runIntervalMinutes: 60, expiresAt: base.expiresAt.toISOString(),
    }, connectionOwnerActor, db);
    const ownerConfirmed = await confirmProjectGitAutomationGrantConnectionOwner(projectId, grantDraft.id, {
      expectedVersion: grantDraft.version, acknowledgeReadOnlyScheduledAccess: true,
    }, connectionOwnerActor, db);
    const active = await activateProjectGitAutomationGrantProjectOwner(projectId, grantDraft.id, {
      expectedVersion: ownerConfirmed.version, acknowledgeExactRepositoryScope: true, acknowledgeReadOnlyDataEgress: true,
    }, projectOwnerActor, db);
    await db.$transaction(async (tx) => {
      await revokeProjectMembership(tx, projectId, connectionOwnerId, workspaceId, {
        actorId: projectOwnerId, reason: "grant_withdrawal_owner_left_project",
      });
    });
    const safetyList = await listConnectionOwnerProjectGitAutomationGrants(connectionOwnerActor, db);
    assert.deepEqual(safetyList.map((grant) => grant.id), [grantDraft.id]);
    assert.equal(safetyList[0]?.version, active.version);
    assert.deepEqual(Object.keys(safetyList[0]!).sort(), ["expiresAt", "gitConnectionId", "id", "projectId", "status", "version"]);
    const revoked = await revokeProjectGitAutomationGrant(projectId, grantDraft.id, {
      expectedVersion: safetyList[0]!.version, reason: "connection owner withdraws consent after leaving project",
    }, connectionOwnerActor, db);
    assert.equal(revoked.status, "revoked");
    assert.deepEqual(Object.keys(revoked).sort(), ["expiresAt", "gitConnectionId", "id", "projectId", "status", "version"]);
    assert.equal(await db.projectGitRepositoryAutomationGrantAudit.count({ where: { grantId: grantDraft.id } }), 4);
    const retainedAudit = await db.projectGitRepositoryAutomationGrantAudit.findFirstOrThrow({
      where: { grantId: grantDraft.id, action: "revoked" },
      select: { actorId: true, actorProjectMembershipId: true },
    });
    assert.deepEqual(retainedAudit, { actorId: connectionOwnerId, actorProjectMembershipId: null });
    assert.deepEqual(await listConnectionOwnerProjectGitAutomationGrants(connectionOwnerActor, db), []);
    const connection = await db.gitConnection.findUniqueOrThrow({ where: { id: connectionId }, select: { updatedAt: true } });
    const preview = await previewGitConnectionMutation(connectionId, {
      action: "disable", requestKey: `git-grant-owner-withdrawal-${suffix}`,
      reason: "verify automatic grant no longer blocks connection governance",
      expectedUpdatedAt: connection.updatedAt.toISOString(),
    }, connectionOwnerActor, db);
    assert.equal(preview.blockers.includes("live_automation_grant"), false);
    const currentProject = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true, updatedAt: true } });
    const archived = await updateProjectLifecycle({
      projectId, actor: projectOwnerActor, action: "archive", expectedUpdatedAt: currentProject.updatedAt,
    }, db);
    const deleted = await deleteArchivedProject({
      projectId, actor: projectOwnerActor, confirmationName: currentProject.name, expectedUpdatedAt: archived.project.updatedAt,
    }, db);
    assert.equal(deleted.projectId, projectId);
    assert.equal(await db.projectGitRepositoryAutomationGrant.count({ where: { id: grantDraft.id } }), 0);
    assert.equal(await db.projectGitRepositoryAutomationGrantAudit.count({ where: { grantId: grantDraft.id } }), 4);
  },
);

test(
  "migration 74 fails closed for legacy non-manual delegations and preserves compliant 73 data",
  { skip: !shouldRun ? "PROJECT_GIT_REPOSITORY_DELEGATION_POSTGRES_GATE=1 is required" : false },
  async () => {
    assertDisposableGateDatabase();
    const configuredUrl = process.env.DATABASE_URL;
    if (typeof configuredUrl !== "string" || configuredUrl.length === 0) {
      throw new Error("PROJECT_GIT_REPOSITORY_DELEGATION_UPGRADE_DATABASE_URL_REQUIRED");
    }
    const targetDatabaseUrl = configuredUrl;
    const migrations = await migrationNamesFromDisk();
    const runtimeIndex = migrations.indexOf(projectGitRuntimeMigration);
    const reconciliationIndex = migrations.indexOf(projectGitReconciliationMigration);
    if (runtimeIndex < 0 || reconciliationIndex !== runtimeIndex + 1 || migrations.indexOf(projectGitDelegationMigration) < 0) {
      throw new Error("PROJECT_GIT_REPOSITORY_DELEGATION_UPGRADE_MIGRATION_ORDER_INVALID");
    }
    const configuredTarget = new URL(configuredUrl);
    const ownerRole = decodeURIComponent(configuredTarget.username);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(ownerRole)) {
      throw new Error("PROJECT_GIT_REPOSITORY_DELEGATION_UPGRADE_DATABASE_OWNER_INVALID");
    }
    const admin = new Client({ connectionString: assertUpgradeAdminUrl(), connectionTimeoutMillis: 5_000 });
    const tempRoot = await prepareStagedMigrationRoot();
    const oldMigrationNames = migrations.slice(0, runtimeIndex + 1);
    const currentMigrationNames = [projectGitReconciliationMigration];

    async function runUpgradeCase(invalid: boolean): Promise<void> {
      const databaseName = upgradeDatabaseName(randomUUID().slice(0, 12));
      const targetUrl = new URL(targetDatabaseUrl);
      targetUrl.pathname = `/${databaseName}`;
      targetUrl.search = "";
      targetUrl.hash = "";
      let databaseCreated = false;
      let fixture: Awaited<ReturnType<typeof seedUpgradeDelegation>> | undefined;
      try {
        await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
        databaseCreated = true;
        // A prior case may have staged the reconciliation migration before its
        // preflight failed.  Reset the temporary directory so the legacy seed
        // is always performed against the exact pre-74 migration boundary;
        // otherwise Prisma could apply migration 74 before the fixture rows
        // are inserted.
        await rm(join(tempRoot, "prisma", "migrations"), { recursive: true, force: true });
        await stageMigrations(tempRoot, oldMigrationNames);
        await deployStagedMigrations(tempRoot, targetUrl.toString());
        fixture = await seedUpgradeDelegation(targetUrl.toString(), invalid);
        const before = await fixture.database.$queryRaw<Array<{ id: string; manualSyncAllowed: boolean; automationAllowed: boolean }>>(Prisma.sql`
          SELECT "id", "manualSyncAllowed", "automationAllowed"
          FROM "ProjectGitRepositoryDelegation"
          WHERE "id" = ${fixture.delegationId}::uuid
        `);
        assert.deepEqual(before, [{ id: fixture.delegationId, ...fixture.flags }]);

        await stageMigrations(tempRoot, currentMigrationNames);
        if (invalid) {
          await assert.rejects(
            () => deployStagedMigrations(tempRoot, targetUrl.toString()),
            /PGRD_MANUAL_READ_ONLY_PREFLIGHT_FAILED/u,
          );
        } else {
          await deployStagedMigrations(tempRoot, targetUrl.toString());
        }

        const after = await fixture.database.$queryRaw<Array<{ id: string; manualSyncAllowed: boolean; automationAllowed: boolean }>>(Prisma.sql`
          SELECT "id", "manualSyncAllowed", "automationAllowed"
          FROM "ProjectGitRepositoryDelegation"
          WHERE "id" = ${fixture.delegationId}::uuid
        `);
        assert.deepEqual(after, before, invalid ? "failed preflight must not rewrite legacy rows" : "compliant upgrade must preserve row");
        const applied = await fixture.database.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT COUNT(*)::bigint AS count
          FROM "_prisma_migrations"
          WHERE "migration_name" = ${projectGitReconciliationMigration}
            AND "finished_at" IS NOT NULL
        `);
        assert.equal(applied[0]?.count, BigInt(invalid ? 0 : 1));
      } finally {
        await fixture?.database.$disconnect().catch(() => undefined);
        if (databaseCreated) {
          await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
        }
      }
    }

    try {
      await admin.connect();
      await runUpgradeCase(true);
      await runUpgradeCase(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
      await admin.end().catch(() => undefined);
    }
  },
);

test(
  "migration 130 rejects inconsistent history, backfills a valid manual publication, and keeps unchanged runs on the shared head",
  { skip: !shouldRun ? "PROJECT_GIT_REPOSITORY_DELEGATION_POSTGRES_GATE=1 is required" : false },
  async () => {
    assertDisposableGateDatabase();
    const targetDatabaseUrl = process.env.DATABASE_URL;
    if (typeof targetDatabaseUrl !== "string" || targetDatabaseUrl.length === 0) {
      throw new Error("PROJECT_GIT_PUBLICATION_UPGRADE_DATABASE_URL_REQUIRED");
    }
    const migrations = await migrationNamesFromDisk();
    const publicationIndex = migrations.indexOf(projectGitPublicationHeadMigration);
    if (publicationIndex < 0) {
      throw new Error("PROJECT_GIT_PUBLICATION_UPGRADE_MIGRATION_ORDER_INVALID");
    }
    const configuredTarget = new URL(targetDatabaseUrl);
    const ownerRole = decodeURIComponent(configuredTarget.username);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(ownerRole)) {
      throw new Error("PROJECT_GIT_PUBLICATION_UPGRADE_DATABASE_OWNER_INVALID");
    }
    const admin = new Client({ connectionString: assertUpgradeAdminUrl(), connectionTimeoutMillis: 5_000 });
    const tempRoot = await prepareStagedMigrationRoot();
    const databaseName = upgradeDatabaseName(randomUUID().slice(0, 12));
    const isolatedUrl = new URL(targetDatabaseUrl);
    isolatedUrl.pathname = `/${databaseName}`;
    isolatedUrl.search = "";
    isolatedUrl.hash = "";
    const isolatedAdminUrl = new URL(assertUpgradeAdminUrl());
    isolatedAdminUrl.pathname = `/${databaseName}`;
    const database = new PrismaClient({ adapter: new PrismaPg({ connectionString: isolatedUrl.toString() }) });
    const seedClient = new Client({ connectionString: isolatedAdminUrl.toString(), connectionTimeoutMillis: 5_000 });
    let databaseCreated = false;

    const insertRunAudit = async (input: Readonly<{
      runId: string;
      action: string;
      statusBefore: string | null;
      statusAfter: string;
      dispatchState: string;
      actorId: string | null;
      commitSha: string | null;
      manifestFingerprint: string | null;
      reason: string;
    }>): Promise<void> => {
      await seedClient.query(
        `INSERT INTO "ProjectGitRepositoryManualRunAudit" (
          "id", "runId", "projectId", "delegationId", "action", "statusBefore", "statusAfter", "dispatchState", "actorId",
          "requestedById", "requestedByAccountAccessVersion", "requestedByProjectMembershipId", "requestedByMembershipCreatedAt",
          "connectionOwnerId", "connectionOwnerAccountAccessVersion", "ownerProjectMembershipId", "ownerMembershipCreatedAt",
          "projectConfirmedById", "projectConfirmedProjectMembershipId", "projectConfirmedMembershipCreatedAt",
          "reason", "delegationVersion", "delegationFingerprint", "connectionConfigurationVersion", "resolvedAddressFingerprint",
          "credentialFingerprint", "role", "requiredForProjectSnapshot", "codeEnabled", "metadataEnabled", "manualSyncAllowed",
          "automationAllowed", "commitSha", "manifestFingerprint", "transitionAt", "createdAt"
        )
        SELECT $1::uuid, run."id", run."projectId", run."delegationId", $3::"ProjectGitRepositoryManualRunAuditAction",
          $4::"ProjectGitRepositoryManualRunStatus", $5::"ProjectGitRepositoryManualRunStatus",
          $6::"ProjectGitRepositoryManualRunDispatchState", $7::uuid, run."requestedById", run."requestedByAccountAccessVersion",
          run."requestedByProjectMembershipId", run."requestedByMembershipCreatedAt", run."connectionOwnerId",
          run."connectionOwnerAccountAccessVersion", run."ownerProjectMembershipId", run."ownerMembershipCreatedAt",
          run."projectConfirmedById", run."projectConfirmedProjectMembershipId", run."projectConfirmedMembershipCreatedAt",
          $8, run."delegationVersion", run."delegationFingerprint", run."connectionConfigurationVersion",
          run."resolvedAddressFingerprint", run."credentialFingerprint", run."role", run."requiredForProjectSnapshot",
          run."codeEnabled", run."metadataEnabled", run."manualSyncAllowed", run."automationAllowed", $9, $10,
          COALESCE(run."completedAt", statement_timestamp()), COALESCE(run."completedAt", statement_timestamp())
        FROM "ProjectGitRepositoryManualRun" run WHERE run."id" = $2::uuid`,
        [
          randomUUID(), input.runId, input.action, input.statusBefore, input.statusAfter, input.dispatchState,
          input.actorId, input.reason, input.commitSha, input.manifestFingerprint,
        ],
      );
    };

    try {
      await admin.connect();
      await admin.query(`CREATE DATABASE "${databaseName}" OWNER "${ownerRole}"`);
      databaseCreated = true;
      await stageMigrations(tempRoot, migrations.slice(0, publicationIndex));
      await deployStagedMigrations(tempRoot, isolatedUrl.toString());

      const { workspaceId, ownerId } = await createPostgresWorkspaceFixture(database);
      const projectId = randomUUID();
      await database.project.create({
        data: { id: projectId, workspaceId, name: "G1c publication backfill", slug: `g1c-backfill-${randomUUID().slice(0, 8)}` },
      });
      await database.$transaction(async (tx) => grantProjectMembership(tx, {
        projectId,
        workspaceId,
        userId: ownerId,
        role: "owner",
        actorId: ownerId,
        reason: "g1c_publication_backfill_fixture",
      }));
      const membership = await database.projectMembership.findFirstOrThrow({
        where: { projectId, userId: ownerId },
        select: { id: true, createdAt: true },
      });

      const connectionId = randomUUID();
      const credentialId = randomUUID();
      const delegationId = randomUUID();
      const delegationFingerprint = "d".repeat(64);
      const addressFingerprint = "b".repeat(64);
      const credentialFingerprint = "c".repeat(64);
      const repositoryPath = "org/publication-backfill";
      const trackedRef = "main";
      const commitSha = "f".repeat(40);
      const runId = randomUUID();
      const clientRequestKey = randomUUID();
      const sourceId = randomUUID();
      const normalizedPath = "README.md";
      const blobOid = "e".repeat(40);
      const publishedAt = new Date();
      const expiresAt = new Date(publishedAt.getTime() + 60 * 60 * 1_000);
      const sourceText = `Repository: ${repositoryPath}\nRevision: ${commitSha}\nPath: ${normalizedPath}\n\nlegacy publication body\n`;
      const contentHash = createHash("sha256").update(sourceText, "utf8").digest("hex");
      const sourceIdentity = deterministicGitUuid(
        `git-delegated-source:${delegationId}:1:${delegationFingerprint}:${normalizedPath}`,
      );
      const revisionKey = deterministicGitUuid(
        `git-delegated-revision:${delegationId}:1:${delegationFingerprint}:${commitSha}:${normalizedPath}:${contentHash}`,
      );
      const contentBytes = Buffer.byteLength(sourceText, "utf8");
      const lineCount = sourceText.split("\n").length;

      await seedClient.connect();
      await seedClient.query("BEGIN");
      try {
        await seedClient.query("SET LOCAL session_replication_role = replica");
        await seedClient.query(
          `INSERT INTO "ExternalCredential" (
             "id", "kind", "ciphertext", "nonce", "authTag", "maskedSuffix", "secretFingerprint", "createdAt", "updatedAt"
           ) VALUES ($1::uuid, 'git'::"ExternalCredentialKind", decode(repeat('01', 32), 'hex'),
             decode(repeat('02', 12), 'hex'), decode(repeat('03', 16), 'hex'), 'gate', $2, $3, $3)`,
          [credentialId, credentialFingerprint, publishedAt],
        );
        await seedClient.query(
          `INSERT INTO "GitConnection" (
             "id", "name", "providerKind", "transport", "baseUrl", "authKind", "credentialId", "allowPrivateNetwork",
             "resolvedAddressFingerprint", "status", "configurationVersion", "createdById", "ownerUserId",
             "ownerAccountAccessVersion", "ownershipState", "createdAt", "updatedAt"
           ) VALUES ($1::uuid, 'G1c backfill Git', 'github'::"GitProviderKind", 'https'::"GitTransport", 'https://127.0.0.1',
             'token'::"GitAuthKind", $2::uuid, true, $3, 'verified'::"GitConnectionStatus", 1, $4::uuid, $4::uuid,
             1, 'confirmed'::"ResourceOwnershipState", $5, $5)`,
          [connectionId, credentialId, addressFingerprint, ownerId, publishedAt],
        );
        await seedClient.query(
          `INSERT INTO "ProjectGitRepositoryDelegation" (
             "id", "projectId", "gitConnectionId", "connectionOwnerId", "connectionOwnerAccountAccessVersion",
             "repositoryPath", "trackedRef", "includeRoots", "softExcludePatterns", "role", "requiredForProjectSnapshot",
             "codeEnabled", "metadataEnabled", "manualSyncAllowed", "automationAllowed", "expiresAt",
             "connectionConfigurationVersion", "resolvedAddressFingerprint", "credentialFingerprint", "delegationFingerprint",
             "version", "status", "ownerProjectMembershipId", "ownerMembershipCreatedAt", "projectConfirmedProjectMembershipId",
             "projectConfirmedMembershipCreatedAt", "proposedById", "proposedAt", "ownerConfirmedById", "ownerConfirmedAt",
             "projectConfirmedById", "projectConfirmedAt", "activatedAt", "createdAt", "updatedAt"
           ) SELECT $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5, $6, '["."]'::jsonb, '[]'::jsonb,
             'primary'::"ProjectRepositoryRole", true, true, true, true, false, $7, 1, $8, $9, $10, 1,
             'active'::"ProjectGitRepositoryDelegationStatus", membership."id", membership."createdAt",
             membership."id", membership."createdAt", $4::uuid, $12, $4::uuid, $12, $4::uuid, $12, $12, $12, $12
           FROM "ProjectMembership" membership WHERE membership."id" = $11::uuid`,
          [
            delegationId, projectId, connectionId, ownerId, repositoryPath, trackedRef, expiresAt,
            addressFingerprint, credentialFingerprint, delegationFingerprint, membership.id, publishedAt,
          ],
        );
        await seedClient.query(
          `INSERT INTO "ProjectSource" (
             "id", "projectId", "kind", "originScope", "projectRepositoryLinkId", "sourceIdentity", "revisionKey",
             "externalRef", "contentText", "contentHash", "capturedAt", "retiredAt"
           ) VALUES ($1::uuid, $2::uuid, 'git'::"ProjectSourceKind", 'project'::"ContentOriginScope", NULL,
             $3::uuid, $4::uuid, NULL, $5, $6, $7, NULL)`,
          [sourceId, projectId, sourceIdentity, revisionKey, sourceText, contentHash, publishedAt],
        );
        await seedClient.query(
          `INSERT INTO "ProjectGitRepositoryManualRun" (
             "id", "projectId", "delegationId", "requestedById", "requestedByAccountAccessVersion",
             "requestedByProjectMembershipId", "requestedByMembershipCreatedAt", "clientRequestKey", "status", "stage",
             "dispatchState", "delegationVersion", "delegationFingerprint", "connectionOwnerId",
             "connectionOwnerAccountAccessVersion", "ownerProjectMembershipId", "ownerMembershipCreatedAt",
             "projectConfirmedById", "projectConfirmedProjectMembershipId", "projectConfirmedMembershipCreatedAt",
             "connectionConfigurationVersion", "resolvedAddressFingerprint", "credentialFingerprint", "repositoryPath",
             "trackedRef", "includeRoots", "softExcludePatterns", "role", "requiredForProjectSnapshot", "codeEnabled",
             "metadataEnabled", "manualSyncAllowed", "automationAllowed", "frozenCommitSha", "manifestFingerprint",
             "fileCount", "decodedTextBytes", "result", "createdAt", "startedAt", "completedAt"
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5::uuid, $6::timestamp(3), $7::uuid,
             'succeeded'::"ProjectGitRepositoryManualRunStatus", 'terminal'::"ProjectGitRepositoryManualRunStage",
             'acknowledged'::"ProjectGitRepositoryManualRunDispatchState", 1, $8, $4::uuid, 1, $5::uuid, $6::timestamp(3),
             $4::uuid, $5::uuid, $6::timestamp(3), 1, $9, $10, $11, $12, '["."]'::jsonb, '[]'::jsonb,
             'primary'::"ProjectRepositoryRole", true, true, true, true, false, $13, repeat('0', 64), 1, $14::integer,
             jsonb_build_object('fileCount', 1, 'decodedTextBytes', $14::integer), $15, $15, $15
           )`,
          [
            runId, projectId, delegationId, ownerId, membership.id, membership.createdAt, clientRequestKey,
            delegationFingerprint, addressFingerprint, credentialFingerprint, repositoryPath, trackedRef,
            commitSha, contentBytes, publishedAt,
          ],
        );
        await seedClient.query(
          `INSERT INTO "ProjectGitRepositoryManualRunEntry" (
             "id", "projectId", "runId", "delegationId", "delegationVersion", "delegationFingerprint", "projectSourceId",
             "ordinal", "normalizedPath", "blobOid", "contentHash", "contentBytes", "lineCount", "createdAt"
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5, $6::uuid, 0, $7, $8, $9, $10, $11, $12)`,
          [randomUUID(), projectId, runId, delegationId, delegationFingerprint, sourceId, normalizedPath, blobOid, contentHash, contentBytes, lineCount, publishedAt],
        );
        const manifestResult = await seedClient.query<{ manifest: string }>(
          `SELECT "project_git_manual_runtime_manifest"($1::uuid) AS manifest`,
          [runId],
        );
        const manifestFingerprint = manifestResult.rows[0]?.manifest;
        if (manifestFingerprint === undefined) throw new Error("PROJECT_GIT_PUBLICATION_BACKFILL_FIXTURE_MANIFEST_MISSING");
        await seedClient.query(
          `UPDATE "ProjectGitRepositoryManualRun" SET "manifestFingerprint" = $2 WHERE "id" = $1::uuid`,
          [runId, manifestFingerprint],
        );
        await seedClient.query(
          `INSERT INTO "ProjectGitRepositoryManualPointer" (
             "projectId", "delegationId", "runId", "delegationVersion", "delegationFingerprint",
             "frozenCommitSha", "manifestFingerprint", "publishedAt", "updatedAt"
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, 1, $4, $5, $6, $7, $7)`,
          [projectId, delegationId, runId, delegationFingerprint, commitSha, manifestFingerprint, publishedAt],
        );
        await seedClient.query(
          `INSERT INTO "ProjectGitRepositoryManualRunAudit" (
             "id", "runId", "projectId", "delegationId", "action", "statusBefore", "statusAfter", "dispatchState", "actorId",
             "requestedById", "requestedByAccountAccessVersion", "requestedByProjectMembershipId", "requestedByMembershipCreatedAt",
             "connectionOwnerId", "connectionOwnerAccountAccessVersion", "ownerProjectMembershipId", "ownerMembershipCreatedAt",
             "projectConfirmedById", "projectConfirmedProjectMembershipId", "projectConfirmedMembershipCreatedAt", "reason",
             "delegationVersion", "delegationFingerprint", "connectionConfigurationVersion", "resolvedAddressFingerprint",
             "credentialFingerprint", "role", "requiredForProjectSnapshot", "codeEnabled", "metadataEnabled", "manualSyncAllowed",
             "automationAllowed", "commitSha", "manifestFingerprint", "transitionAt", "createdAt"
           ) SELECT $1::uuid, run."id", run."projectId", run."delegationId", 'succeeded'::"ProjectGitRepositoryManualRunAuditAction",
             'running'::"ProjectGitRepositoryManualRunStatus", 'succeeded'::"ProjectGitRepositoryManualRunStatus",
             'acknowledged'::"ProjectGitRepositoryManualRunDispatchState", run."requestedById", run."requestedById",
             run."requestedByAccountAccessVersion", run."requestedByProjectMembershipId", run."requestedByMembershipCreatedAt",
             run."connectionOwnerId", run."connectionOwnerAccountAccessVersion", run."ownerProjectMembershipId",
             run."ownerMembershipCreatedAt", run."projectConfirmedById", run."projectConfirmedProjectMembershipId",
             run."projectConfirmedMembershipCreatedAt", 'g1c_legacy_pointer_fixture', run."delegationVersion",
             run."delegationFingerprint", run."connectionConfigurationVersion", run."resolvedAddressFingerprint",
             run."credentialFingerprint", run."role", run."requiredForProjectSnapshot", run."codeEnabled", run."metadataEnabled",
             run."manualSyncAllowed", run."automationAllowed", run."frozenCommitSha", run."manifestFingerprint", $2, $2
           FROM "ProjectGitRepositoryManualRun" run WHERE run."id" = $3::uuid`,
          [randomUUID(), publishedAt, runId],
        );
        await seedClient.query("COMMIT");
      } catch (error) {
        await seedClient.query("ROLLBACK");
        throw error;
      }

      await stageMigrations(tempRoot, [projectGitPublicationHeadMigration]);
      await seedClient.query("BEGIN");
      try {
        await seedClient.query("SET LOCAL session_replication_role = replica");
        await seedClient.query(
          `UPDATE "ProjectGitRepositoryManualPointer" SET "manifestFingerprint" = $2 WHERE "runId" = $1::uuid`,
          [runId, "a".repeat(64)],
        );
        await seedClient.query("COMMIT");
      } catch (error) {
        await seedClient.query("ROLLBACK");
        throw error;
      }
      await assert.rejects(
        () => deployStagedMigrations(tempRoot, isolatedUrl.toString()),
        /PROJECT_GIT_PUBLICATION_BACKFILL_INCONSISTENT_MANUAL_POINTER/u,
      );
      const rejectedMigration = await seedClient.query<{ finished: string; publicationHead: string | null }>(
        `SELECT count(*) FILTER (WHERE "finished_at" IS NOT NULL)::text AS finished,
                to_regclass('public."ProjectGitRepositoryPublicationHead"')::text AS "publicationHead"
           FROM "_prisma_migrations" WHERE "migration_name" = $1`,
        [projectGitPublicationHeadMigration],
      );
      assert.deepEqual(rejectedMigration.rows, [{ finished: "0", publicationHead: null }]);
      await seedClient.query("BEGIN");
      try {
        await seedClient.query("SET LOCAL session_replication_role = replica");
        await seedClient.query(
          `UPDATE "ProjectGitRepositoryManualPointer" pointer_row
              SET "manifestFingerprint" = run_row."manifestFingerprint"
             FROM "ProjectGitRepositoryManualRun" run_row
            WHERE pointer_row."runId" = run_row."id" AND pointer_row."runId" = $1::uuid`,
          [runId],
        );
        await seedClient.query("COMMIT");
      } catch (error) {
        await seedClient.query("ROLLBACK");
        throw error;
      }
      await execFile(
        "pnpm",
        ["exec", "prisma", "migrate", "resolve", "--rolled-back", projectGitPublicationHeadMigration,
          "--config", join(tempRoot, "prisma.config.ts")],
        { cwd: repositoryRoot, env: { ...process.env, DATABASE_URL: isolatedUrl.toString() }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      );
      await deployStagedMigrations(tempRoot, isolatedUrl.toString());
      const backfilled = await seedClient.query<{
        currentPublicationVersionId: string;
        generation: number;
        versionRunId: string;
        runKind: string;
        previousPublicationVersionId: string | null;
        previousGeneration: number;
        entryCount: string;
        manifestFingerprint: string;
      }>(
        `SELECT head."currentPublicationVersionId"::text AS "currentPublicationVersionId", head."generation",
           version_row."runId"::text AS "versionRunId", version_row."runKind"::text AS "runKind",
           version_row."previousPublicationVersionId"::text AS "previousPublicationVersionId", version_row."previousGeneration",
           (SELECT count(*)::text FROM "ProjectGitRepositoryPublicationEntry" entry
             WHERE entry."publicationVersionId" = version_row."id") AS "entryCount",
           version_row."manifestFingerprint"
         FROM "ProjectGitRepositoryPublicationHead" head
         JOIN "ProjectGitRepositoryPublicationVersion" version_row
           ON version_row."id" = head."currentPublicationVersionId"
        WHERE head."projectId" = $1::uuid AND head."delegationId" = $2::uuid`,
        [projectId, delegationId],
      );
      assert.deepEqual(backfilled.rows, [{
        currentPublicationVersionId: backfilled.rows[0]?.currentPublicationVersionId,
        generation: 1,
        versionRunId: runId,
        runKind: "manual",
        previousPublicationVersionId: null,
        previousGeneration: 0,
        entryCount: "1",
        manifestFingerprint: backfilled.rows[0]?.manifestFingerprint,
      }]);
      const publicationVersionId = backfilled.rows[0]?.currentPublicationVersionId;
      const manifestFingerprint = backfilled.rows[0]?.manifestFingerprint;
      if (publicationVersionId === undefined || manifestFingerprint === undefined) {
        throw new Error("PROJECT_GIT_PUBLICATION_BACKFILL_RESULT_MISSING");
      }

      const unchangedRunId = randomUUID();
      await seedClient.query("BEGIN");
      try {
        await seedClient.query(`SELECT set_config('ai.project_git_manual_runtime_audit', '1', true)`);
        await seedClient.query(
          `INSERT INTO "ProjectGitRepositoryManualRun" (
             "id", "projectId", "delegationId", "requestedById", "requestedByAccountAccessVersion",
             "requestedByProjectMembershipId", "requestedByMembershipCreatedAt", "clientRequestKey",
             "delegationVersion", "delegationFingerprint", "connectionOwnerId", "connectionOwnerAccountAccessVersion",
             "ownerProjectMembershipId", "ownerMembershipCreatedAt", "projectConfirmedById",
             "projectConfirmedProjectMembershipId", "projectConfirmedMembershipCreatedAt", "connectionConfigurationVersion",
             "resolvedAddressFingerprint", "credentialFingerprint", "repositoryPath", "trackedRef", "includeRoots",
             "softExcludePatterns", "role", "requiredForProjectSnapshot", "codeEnabled", "metadataEnabled", "manualSyncAllowed",
             "automationAllowed", "baselineRunId", "baselineFrozenCommitSha", "baselineManifestFingerprint", "baselinePublishedAt",
             "expectedPublicationVersionId", "expectedPublicationGeneration"
           ) SELECT $1::uuid, delegation."projectId", delegation."id", delegation."connectionOwnerId", 1,
             membership."id", membership."createdAt", $2::uuid, delegation."version", delegation."delegationFingerprint",
             delegation."connectionOwnerId", 1, delegation."ownerProjectMembershipId", delegation."ownerMembershipCreatedAt",
             delegation."projectConfirmedById", delegation."projectConfirmedProjectMembershipId",
             delegation."projectConfirmedMembershipCreatedAt", delegation."connectionConfigurationVersion",
             delegation."resolvedAddressFingerprint", delegation."credentialFingerprint", delegation."repositoryPath",
             delegation."trackedRef", delegation."includeRoots", delegation."softExcludePatterns", delegation."role",
             delegation."requiredForProjectSnapshot", delegation."codeEnabled", delegation."metadataEnabled",
             delegation."manualSyncAllowed", delegation."automationAllowed", pointer."runId", pointer."frozenCommitSha",
             pointer."manifestFingerprint", pointer."publishedAt", head."currentPublicationVersionId", head."generation"
           FROM "ProjectGitRepositoryDelegation" delegation
           JOIN "ProjectMembership" membership ON membership."id" = delegation."ownerProjectMembershipId"
           JOIN "ProjectGitRepositoryManualPointer" pointer
             ON pointer."projectId" = delegation."projectId" AND pointer."delegationId" = delegation."id"
           JOIN "ProjectGitRepositoryPublicationHead" head
             ON head."projectId" = delegation."projectId" AND head."delegationId" = delegation."id"
          WHERE delegation."id" = $3::uuid`,
          [unchangedRunId, randomUUID(), delegationId],
        );
        await insertRunAudit({
          runId: unchangedRunId,
          action: "requested",
          statusBefore: null,
          statusAfter: "queued",
          dispatchState: "pending",
          actorId: ownerId,
          commitSha: null,
          manifestFingerprint: null,
          reason: "g1c_backfill_unchanged_requested",
        });
        await seedClient.query("SET CONSTRAINTS ALL IMMEDIATE");
        await seedClient.query("COMMIT");
      } catch (error) {
        await seedClient.query("ROLLBACK");
        throw error;
      }

      await seedClient.query("BEGIN");
      try {
        await seedClient.query(`SELECT set_config('ai.project_git_manual_runtime_audit', '1', true)`);
        await seedClient.query(
          `UPDATE "ProjectGitRepositoryManualRun"
              SET "status" = 'running', "stage" = 'admitted', "dispatchState" = 'pending', "startedAt" = clock_timestamp()
            WHERE "id" = $1::uuid`,
          [unchangedRunId],
        );
        await insertRunAudit({
          runId: unchangedRunId, action: "admitted", statusBefore: "queued", statusAfter: "running", dispatchState: "pending",
          actorId: ownerId, commitSha: null, manifestFingerprint: null, reason: "g1c_backfill_unchanged_admitted",
        });
        await seedClient.query("SET CONSTRAINTS ALL IMMEDIATE");
        await seedClient.query("COMMIT");
      } catch (error) {
        await seedClient.query("ROLLBACK");
        throw error;
      }

      await seedClient.query("BEGIN");
      try {
        await seedClient.query(`SELECT set_config('ai.project_git_manual_runtime_audit', '1', true)`);
        await seedClient.query(
          `UPDATE "ProjectGitRepositoryManualRun" SET "stage" = 'fetching', "dispatchState" = 'dispatched'
            WHERE "id" = $1::uuid`,
          [unchangedRunId],
        );
        await insertRunAudit({
          runId: unchangedRunId, action: "dispatched", statusBefore: "running", statusAfter: "running", dispatchState: "dispatched",
          actorId: ownerId, commitSha: null, manifestFingerprint: null, reason: "g1c_backfill_unchanged_dispatched",
        });
        await seedClient.query("SET CONSTRAINTS ALL IMMEDIATE");
        await seedClient.query("COMMIT");
      } catch (error) {
        await seedClient.query("ROLLBACK");
        throw error;
      }

      await seedClient.query(`UPDATE "ProjectGitRepositoryManualRun" SET "stage" = 'validating' WHERE "id" = $1::uuid`, [unchangedRunId]);
      await seedClient.query("SET CONSTRAINTS ALL IMMEDIATE");
      await seedClient.query(`UPDATE "ProjectGitRepositoryManualRun" SET "stage" = 'publishing' WHERE "id" = $1::uuid`, [unchangedRunId]);
      await seedClient.query("SET CONSTRAINTS ALL IMMEDIATE");
      await seedClient.query("BEGIN");
      try {
        await seedClient.query(`SELECT set_config('ai.project_git_manual_runtime_audit', '1', true)`);
        await seedClient.query(
          `UPDATE "ProjectGitRepositoryManualRun"
              SET "status" = 'unchanged', "stage" = 'terminal', "dispatchState" = 'acknowledged',
                  "frozenCommitSha" = $2, "manifestFingerprint" = $3, "fileCount" = 0, "decodedTextBytes" = 0,
                  "result" = jsonb_build_object('outcome', 'unchanged'), "completedAt" = clock_timestamp()
            WHERE "id" = $1::uuid`,
          [unchangedRunId, commitSha, manifestFingerprint],
        );
        await insertRunAudit({
          runId: unchangedRunId,
          action: "unchanged",
          statusBefore: "running",
          statusAfter: "unchanged",
          dispatchState: "acknowledged",
          actorId: ownerId,
          commitSha,
          manifestFingerprint,
          reason: "manual_sync_remote_head_unchanged",
        });
        await seedClient.query("SET CONSTRAINTS ALL IMMEDIATE");
        await seedClient.query("COMMIT");
      } catch (error) {
        await seedClient.query("ROLLBACK");
        throw error;
      }

      const finalHead = await seedClient.query<{ currentPublicationVersionId: string; generation: number; unchangedStatus: string }>(
        `SELECT head."currentPublicationVersionId"::text AS "currentPublicationVersionId", head."generation",
           run."status"::text AS "unchangedStatus"
         FROM "ProjectGitRepositoryPublicationHead" head
         JOIN "ProjectGitRepositoryManualRun" run ON run."id" = $3::uuid
        WHERE head."projectId" = $1::uuid AND head."delegationId" = $2::uuid`,
        [projectId, delegationId, unchangedRunId],
      );
      assert.deepEqual(finalHead.rows, [{ currentPublicationVersionId: publicationVersionId, generation: 1, unchangedStatus: "unchanged" }]);
    } finally {
      await database.$disconnect().catch(() => undefined);
      await seedClient.end().catch(() => undefined);
      if (databaseCreated) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await rm(tempRoot, { recursive: true, force: true });
      await admin.end().catch(() => undefined);
    }
  },
);
