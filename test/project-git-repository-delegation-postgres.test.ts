import "dotenv/config";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
import { executeGitConnectionMutation, previewGitConnectionMutation, updateGitConnection } from "../src/lib/git";
import { updateProjectLifecycle } from "../src/lib/project-lifecycle";
import { createPostgresWorkspaceFixture } from "./postgres-workspace-fixture";
import { createGitConnectionFixture } from "./personal-connection-probe-fixture";

const shouldRun = process.env.PROJECT_GIT_REPOSITORY_DELEGATION_POSTGRES_GATE === "1";
const testDatabaseName = "ai_project_os_project_git_repository_delegation_test";
const repositoryRoot = process.cwd();
const execFile = promisify(execFileCallback);
const projectGitDelegationMigration = "20260904150000_add_project_git_repository_delegations";
const projectGitRuntimeMigration = "20260904160000_add_project_git_manual_runtime";
const projectGitReconciliationMigration = "20260904170000_add_project_git_manual_run_reconciliation";
const seededAdminId = "00000000-0000-4000-8000-000000000010";

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
