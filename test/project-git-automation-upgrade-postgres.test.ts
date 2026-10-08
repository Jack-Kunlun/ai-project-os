import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Client } from "pg";
import { grantProjectMembership, grantWorkspaceMembership } from "../src/lib/membership-governance";
import {
  confirmProjectGitRepositoryDelegationOwner,
  confirmProjectGitRepositoryDelegationProject,
  proposeProjectGitRepositoryDelegation,
} from "../src/lib/project-git-repository-delegation-service";
import { seedPersonalConnectionProbeCreateContextPg } from "./personal-connection-probe-fixture";

const shouldRun = process.env.PROJECT_GIT_AUTOMATION_UPGRADE_POSTGRES_GATE === "1";
const databaseName = "ai_project_os_project_git_automation_upgrade_test";
const targetMigration = "20260930010000_add_git_automation_read_context";
const run = promisify(execFileCallback);

type LegacyRunFixture = Readonly<{
  id: string;
  grantId: string;
  projectId: string;
  status: "pending" | "dispatched" | "failed" | "unknown";
}>;

function requireDisposableDatabase(): string {
  const raw = process.env.DATABASE_URL;
  if (typeof raw !== "string") throw new Error("PROJECT_GIT_AUTOMATION_UPGRADE_DATABASE_URL_REQUIRED");
  const parsed = new URL(raw);
  if (!(["postgres:", "postgresql:"].includes(parsed.protocol)
    && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    && parsed.port === "56432"
    && parsed.pathname === `/${databaseName}`
    && parsed.username === "ai_project_os_gate"
    && parsed.password.length > 0
    && parsed.search === ""
    && parsed.hash === "")) throw new Error("PROJECT_GIT_AUTOMATION_UPGRADE_DATABASE_URL_INVALID");
  return parsed.toString();
}

function createGateDb(url: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

async function createActiveGrant(db: PrismaClient, admin: Client): Promise<Readonly<{
  projectId: string;
  connectionOwnerId: string;
  baseDelegationId: string;
  grantId: string;
}>> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const workspaceId = randomUUID();
  const projectOwnerId = randomUUID();
  const connectionOwnerId = randomUUID();
  const projectId = randomUUID();
  const connectionId = randomUUID();
  const credentialId = randomUUID();
  const connectionFingerprint = "a".repeat(64);
  const addressFingerprint = "a".repeat(64);
  const connectionOwnerActor = { id: connectionOwnerId, role: "user" as const, accountAccessVersion: 1 };
  const projectOwnerActor = { id: projectOwnerId, role: "user" as const, accountAccessVersion: 1 };

  // Prisma also supplies defaults for newly added non-null columns on INSERT.
  // Freeze identities to schema 131 instead of relying on today's client model.
  await admin.query(`
    INSERT INTO public."AppUser" ("id", "username", "role", "updatedAt")
    VALUES ($1::uuid, $2, 'user', CURRENT_TIMESTAMP), ($3::uuid, $4, 'user', CURRENT_TIMESTAMP)
  `, [projectOwnerId, `automation_upgrade_project_owner_${suffix}`, connectionOwnerId, `automation_upgrade_owner_${suffix}`]);
  await db.$transaction(async (tx) => {
    await tx.workspace.create({ select: { id: true }, data: {
      id: workspaceId, name: `Automation upgrade workspace ${suffix}`,
      slug: `automation-upgrade-workspace-${suffix}`, createdById: projectOwnerId,
    } });
    await grantWorkspaceMembership(tx, {
      workspaceId, userId: projectOwnerId, role: "owner", actorId: projectOwnerId,
      reason: "git_automation_upgrade_project_owner",
    });
  });
  await db.project.create({
    data: { id: projectId, workspaceId, name: `Automation upgrade ${suffix}`, slug: `automation-upgrade-${suffix}` },
  });
  await db.$transaction(async (tx) => {
    await grantWorkspaceMembership(tx, {
      workspaceId, userId: connectionOwnerId, role: "member", actorId: projectOwnerId,
      reason: "git_automation_upgrade_connection_owner",
    });
    await grantProjectMembership(tx, {
      projectId, workspaceId, userId: connectionOwnerId, role: "editor", actorId: projectOwnerId,
      reason: "git_automation_upgrade_connection_owner",
    });
    await grantProjectMembership(tx, {
      projectId, workspaceId, userId: projectOwnerId, role: "owner", actorId: projectOwnerId,
      reason: "git_automation_upgrade_project_owner",
    });
  });
  await db.externalCredential.create({
    data: {
      id: credentialId, kind: "git", ciphertext: Buffer.from([1]), nonce: Buffer.from([2]), authTag: Buffer.from([3]),
      maskedSuffix: "upgrade", secretFingerprint: connectionFingerprint,
    },
  });
  // Schema 131 predates verifiedAddresses. Keep this historical fixture on its
  // original columns while retaining the consumed-probe connection guard.
  await admin.query("BEGIN");
  try {
    await seedPersonalConnectionProbeCreateContextPg(admin, {
      kind: "git", actorId: connectionOwnerId, connectionId,
    });
    await admin.query(`
      INSERT INTO public."GitConnection" (
        "id", "name", "providerKind", "transport", "baseUrl", "authKind", "status",
        "ownershipState", "resolvedAddressFingerprint", "createdById", "ownerUserId",
        "ownerAccountAccessVersion", "credentialId", "updatedAt"
      ) VALUES ($1::uuid, $2, 'github', 'https', 'https://github.com', 'token', 'verified',
        'confirmed', $3, $4::uuid, $4::uuid, 1, $5::uuid, CURRENT_TIMESTAMP)
    `, [connectionId, `Automation upgrade Git ${suffix}`, addressFingerprint, connectionOwnerId, credentialId]);
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK").catch(() => undefined);
    throw error;
  }

  const delegation = await proposeProjectGitRepositoryDelegation(projectId, {
    gitConnectionId: connectionId,
    repositoryPath: "org/automation-upgrade",
    trackedRef: "main",
    includeRoots: ["."],
    softExcludePatterns: ["tmp/**"],
    role: "primary",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
  }, connectionOwnerActor, db);
  const ownerConfirmedDelegation = await confirmProjectGitRepositoryDelegationOwner(projectId, delegation.id, {
    expectedVersion: delegation.version,
    acknowledgeReadOnlyCredentialUse: true,
  }, connectionOwnerActor, db);
  const activeDelegation = await confirmProjectGitRepositoryDelegationProject(projectId, delegation.id, {
    expectedVersion: ownerConfirmedDelegation.version,
    acknowledgeRepositoryScope: true,
    acknowledgeDataEgress: true,
  }, projectOwnerActor, db);
  // This gate deliberately runs on schema 131. Current grant APIs write the
  // 133-only per-material consent columns, so seed the historical active row
  // directly in this disposable superuser database instead of calling them.
  const grantId = randomUUID();
  const activatedAt = new Date(Date.now() - 61 * 60_000);
  await admin.query("BEGIN");
  try {
    await admin.query("SET LOCAL session_replication_role = 'replica'");
    const inserted = await admin.query(`
      INSERT INTO public."ProjectGitRepositoryAutomationGrant" (
        "id", "projectId", "gitConnectionId", "baseDelegationId", "connectionOwnerId",
        "connectionOwnerAccountAccessVersion", "baseDelegationVersion", "baseDelegationFingerprint",
        "repositoryPath", "trackedRef", "includeRoots", "softExcludePatterns", "runIntervalMinutes",
        "expiresAt", "grantFingerprint", "version", "status", "proposedById",
        "proposedProjectMembershipId", "proposedMembershipCreatedAt", "proposedAt",
        "ownerConfirmedById", "ownerConfirmedProjectMembershipId", "ownerConfirmedMembershipCreatedAt", "ownerConfirmedAt",
        "projectActivatedById", "projectActivatedMembershipId", "projectActivatedMembershipCreatedAt", "activatedAt",
        "createdAt", "updatedAt"
      )
      SELECT $1::uuid, delegation."projectId", delegation."gitConnectionId", delegation."id",
        delegation."connectionOwnerId", delegation."connectionOwnerAccountAccessVersion", delegation."version",
        delegation."delegationFingerprint", delegation."repositoryPath", delegation."trackedRef",
        delegation."includeRoots", delegation."softExcludePatterns", 60, delegation."expiresAt",
        repeat('f', 64), 3, 'active'::"ProjectGitRepositoryAutomationGrantStatus",
        delegation."connectionOwnerId", owner_membership."id", owner_membership."createdAt", ($4::timestamptz AT TIME ZONE 'UTC')::timestamp(3) - interval '1 minute',
        delegation."connectionOwnerId", owner_membership."id", owner_membership."createdAt", ($4::timestamptz AT TIME ZONE 'UTC')::timestamp(3) - interval '30 seconds',
        $3::uuid, project_owner_membership."id", project_owner_membership."createdAt", ($4::timestamptz AT TIME ZONE 'UTC')::timestamp(3),
        ($4::timestamptz AT TIME ZONE 'UTC')::timestamp(3) - interval '1 minute', ($4::timestamptz AT TIME ZONE 'UTC')::timestamp(3)
      FROM public."ProjectGitRepositoryDelegation" delegation
      JOIN public."ProjectMembership" owner_membership
        ON owner_membership."projectId" = delegation."projectId"
       AND owner_membership."userId" = delegation."connectionOwnerId"
       AND owner_membership."accessState" = 'confirmed'
      JOIN public."ProjectMembership" project_owner_membership
        ON project_owner_membership."projectId" = delegation."projectId"
       AND project_owner_membership."userId" = $3::uuid
       AND project_owner_membership."role" = 'owner'
       AND project_owner_membership."accessState" = 'confirmed'
      WHERE delegation."id" = $2::uuid
    `, [grantId, activeDelegation.id, projectOwnerId, activatedAt]);
    assert.equal(inserted.rowCount, 1, "one historical active grant was seeded");
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  return Object.freeze({ projectId, connectionOwnerId, baseDelegationId: activeDelegation.id, grantId });
}

async function seedLegacyLedgerHistory(client: Client): Promise<readonly LegacyRunFixture[]> {
  const fixtures = (["pending", "dispatched", "failed", "unknown"] as const).map((status) => ({
    id: randomUUID(), grantId: randomUUID(), projectId: randomUUID(), status,
  }));
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL session_replication_role = 'replica'");
    for (const [index, fixture] of fixtures.entries()) {
      const claimedAt = new Date(Date.now() - (30 - index) * 60_000);
      const scheduledFor = new Date(claimedAt.getTime() - 60 * 60_000);
      const expiresAt = new Date(claimedAt.getTime() + 24 * 60 * 60_000);
      const dispatchedAt = fixture.status === "dispatched" || fixture.status === "unknown"
        ? new Date(claimedAt.getTime() + 1_000)
        : null;
      const completedAt = fixture.status === "failed" || fixture.status === "unknown"
        ? new Date(claimedAt.getTime() + 2_000)
        : null;
      const safeErrorCode = fixture.status === "failed"
        ? "LEASE_EXPIRED_BEFORE_DISPATCH"
        : fixture.status === "unknown" ? "LEASE_EXPIRED_AFTER_DISPATCH" : null;
      const leaseExpiresAt = fixture.status === "failed" || fixture.status === "unknown"
        ? null
        : new Date(claimedAt.getTime() + 90_000);
      const version = fixture.status === "pending" ? 1
        : fixture.status === "unknown" ? 3 : 2;

      await client.query(`
        INSERT INTO public."ProjectGitRepositoryAutomationRun" (
          "id", "grantId", "projectId", "workspaceId", "gitConnectionId", "baseDelegationId", "connectionOwnerId",
          "grantVersion", "grantFingerprint", "baseDelegationVersion", "baseDelegationFingerprint", "repositoryPath",
          "trackedRef", "includeRoots", "softExcludePatterns", "runIntervalMinutes", "expiresAt", "scheduledFor",
          "status", "version", "leaseWorkerId", "leaseToken", "leaseExpiresAt", "lastHeartbeatAt", "claimedAt",
          "dispatchedAt", "completedAt", "safeErrorCode", "createdAt", "updatedAt"
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid,
          1, repeat('a', 64), 1, repeat('b', 64), 'org/legacy-upgrade', 'main', '["."]'::jsonb, '["tmp/**"]'::jsonb,
          60, $8::timestamp(3), $9::timestamp(3), $10::"ProjectGitRepositoryAutomationRunStatus", $11,
          'upgrade-fixture-worker', $12::uuid, $13::timestamp(3), NULL, $14::timestamp(3),
          $15::timestamp(3), $16::timestamp(3), $17, $14::timestamp(3), $14::timestamp(3)
        )`, [
        fixture.id, fixture.grantId, fixture.projectId, randomUUID(), randomUUID(), randomUUID(), randomUUID(),
        expiresAt, scheduledFor, fixture.status, version, randomUUID(), leaseExpiresAt, claimedAt,
        dispatchedAt, completedAt, safeErrorCode,
      ]);

      const auditAction = fixture.status === "pending" ? "run_claimed"
        : fixture.status === "dispatched" ? "run_dispatched"
          : fixture.status === "failed" ? "run_lease_expired_before_dispatch" : "run_lease_expired_after_dispatch";
      const statusBefore = fixture.status === "pending" ? null
        : fixture.status === "failed" ? "pending"
          : fixture.status === "unknown" ? "dispatched" : "pending";
      await client.query(`
        INSERT INTO public."ProjectGitRepositoryAutomationRunAudit" (
          "id", "grantId", "projectId", "runId", "action", "runVersion", "runStatusBefore", "runStatusAfter",
          "scheduledFor", "workerId", "leaseExpiresAt", "grantVersion", "grantFingerprint", "reason"
        ) VALUES (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"ProjectGitRepositoryAutomationRunAuditAction",
          $6, $7::"ProjectGitRepositoryAutomationRunStatus", $8::"ProjectGitRepositoryAutomationRunStatus",
          $9::timestamp(3), 'upgrade-fixture-worker', $10::timestamp(3), 1, repeat('a', 64), $11
        )`, [
        randomUUID(), fixture.grantId, fixture.projectId, fixture.id, auditAction, version, statusBefore,
        fixture.status, scheduledFor, leaseExpiresAt, safeErrorCode,
      ]);
    }
    await client.query("COMMIT");
    return Object.freeze(fixtures);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function seedLegacyPublication(client: Client): Promise<Readonly<{ projectId: string; delegationId: string }>> {
  const projectId = randomUUID();
  const delegationId = randomUUID();
  const sourceId = randomUUID();
  const versionId = randomUUID();
  const runId = randomUUID();
  const sourceIdentity = randomUUID();
  const revisionKey = randomUUID();
  const commitSha = "c".repeat(40);
  const path = "README.md";
  const publishedAt = new Date();
  const contentText = `Repository: org/legacy-upgrade\nRevision: ${commitSha}\nPath: ${path}\n\nlegacy publication survives migration`;
  const contentHash = createHash("sha256").update(contentText, "utf8").digest("hex");
  const contentBytes = Buffer.byteLength(contentText, "utf8");
  const lineCount = contentText.split("\n").length;

  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(`
      INSERT INTO public."ProjectSource" (
        "id", "projectId", "kind", "originScope", "projectRepositoryLinkId", "sourceIdentity", "revisionKey",
        "externalRef", "contentText", "contentHash", "capturedAt", "ingestedAt", "retiredAt"
      ) VALUES ($1::uuid, $2::uuid, 'git', 'project', NULL, $3::uuid, $4::uuid, NULL, $5, $6, $7::timestamp(3), $7::timestamp(3), NULL)
    `, [sourceId, projectId, sourceIdentity, revisionKey, contentText, contentHash, publishedAt]);
    await client.query(`
      INSERT INTO public."ProjectGitRepositoryPublicationVersion" (
        "id", "projectId", "delegationId", "runKind", "runId", "previousPublicationVersionId", "previousGeneration",
        "delegationVersion", "delegationFingerprint", "repositoryPath", "trackedRef", "frozenCommitSha",
        "manifestFingerprint", "fileCount", "decodedTextBytes", "publishedAt"
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'manual', $4::uuid, NULL, 0, 1, repeat('a', 64),
        'org/legacy-upgrade', 'main', $5, repeat('d', 64), 1, $6, $7::timestamptz(3))
    `, [versionId, projectId, delegationId, runId, commitSha, contentBytes, publishedAt]);
    await client.query(`
      INSERT INTO public."ProjectGitRepositoryPublicationEntry" (
        "id", "projectId", "delegationId", "publicationVersionId", "projectSourceId", "ordinal",
        "normalizedPath", "blobOid", "contentHash", "contentBytes", "lineCount", "createdAt"
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 0, $6, $7, $8, $9, $10, $11::timestamptz(3))
    `, [randomUUID(), projectId, delegationId, versionId, sourceId, path, "e".repeat(40), contentHash, contentBytes, lineCount, publishedAt]);
    await client.query(`
      INSERT INTO public."ProjectGitRepositoryPublicationHead" (
        "projectId", "delegationId", "currentPublicationVersionId", "generation", "publishedAt"
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, 1, $4::timestamptz(3))
    `, [projectId, delegationId, versionId, publishedAt]);
    await client.query("COMMIT");
    return Object.freeze({ projectId, delegationId });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

const legacyRunColumns = `
  "id", "grantId", "projectId", "workspaceId", "gitConnectionId", "baseDelegationId", "connectionOwnerId",
  "grantVersion", "grantFingerprint", "baseDelegationVersion", "baseDelegationFingerprint", "repositoryPath",
  "trackedRef", "includeRoots", "softExcludePatterns", "runIntervalMinutes", "expiresAt", "scheduledFor",
  "status", "version", "leaseWorkerId", "leaseToken", "leaseExpiresAt", "lastHeartbeatAt", "claimedAt",
  "dispatchedAt", "completedAt", "safeErrorCode", "createdAt", "updatedAt"
`;
const legacyAuditColumns = `
  "id", "grantId", "projectId", "runId", "action", "cursorVersion", "cursorStatusAfter", "nextRunAt",
  "lastScheduledFor", "runVersion", "runStatusBefore", "runStatusAfter", "scheduledFor", "workerId",
  "leaseExpiresAt", "grantVersion", "grantFingerprint", "reason", "transactionId", "createdAt"
`;

async function readLegacyState(client: Client, fixtures: readonly LegacyRunFixture[], publication: { projectId: string; delegationId: string }) {
  const runIds = fixtures.map((fixture) => fixture.id);
  const [runs, audits, versions, entries, heads, sources] = await Promise.all([
    client.query(`SELECT ${legacyRunColumns} FROM public."ProjectGitRepositoryAutomationRun" WHERE "id" = ANY($1::uuid[]) ORDER BY "id"`, [runIds]),
    client.query(`SELECT ${legacyAuditColumns} FROM public."ProjectGitRepositoryAutomationRunAudit" WHERE "runId" = ANY($1::uuid[]) ORDER BY "runId"`, [runIds]),
    client.query(`SELECT * FROM public."ProjectGitRepositoryPublicationVersion" WHERE "projectId" = $1::uuid AND "delegationId" = $2::uuid`, [publication.projectId, publication.delegationId]),
    client.query(`SELECT * FROM public."ProjectGitRepositoryPublicationEntry" WHERE "projectId" = $1::uuid AND "delegationId" = $2::uuid`, [publication.projectId, publication.delegationId]),
    client.query(`SELECT * FROM public."ProjectGitRepositoryPublicationHead" WHERE "projectId" = $1::uuid AND "delegationId" = $2::uuid`, [publication.projectId, publication.delegationId]),
    client.query(`SELECT source_row.* FROM public."ProjectSource" source_row JOIN public."ProjectGitRepositoryPublicationEntry" entry
                    ON entry."projectId" = source_row."projectId" AND entry."projectSourceId" = source_row."id"
                   WHERE entry."projectId" = $1::uuid AND entry."delegationId" = $2::uuid`, [publication.projectId, publication.delegationId]),
  ]);
  return Object.freeze({
    runs: runs.rows,
    audits: audits.rows,
    versions: versions.rows,
    entries: entries.rows,
    heads: heads.rows,
    sources: sources.rows,
  });
}

async function serializableJson<T extends Record<string, unknown>>(
  client: Client,
  sql: string,
  parameters: readonly unknown[],
): Promise<T> {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    const result = await client.query<{ value: T }>(sql, [...parameters]);
    await client.query("COMMIT");
    const value = result.rows[0]?.value;
    if (value === undefined || value === null) throw new Error("PROJECT_GIT_AUTOMATION_UPGRADE_RESULT_MISSING");
    return typeof value === "string" ? JSON.parse(value) as T : value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function claimRun(client: Client, grantId: string, workerId: string): Promise<Record<string, unknown>> {
  return serializableJson(client,
    'SELECT public."project_git_automation_claim_due"($1::uuid, $2::varchar) AS value', [grantId, workerId]);
}

async function mutateLease(client: Client, claim: Record<string, unknown>, action: "dispatch"): Promise<Record<string, unknown>> {
  return serializableJson(client,
    'SELECT public."project_git_automation_mutate_lease"($1::uuid, $2::varchar, $3::uuid, $4::varchar) AS value',
    [claim.id, claim.workerId, claim.leaseToken, action]);
}

async function finalize(client: Client, claim: Record<string, unknown>, commitSha: string, outcome: "changed" | "unchanged", files: readonly unknown[]): Promise<Record<string, unknown>> {
  return serializableJson(client,
    'SELECT public."project_git_automation_finalize_result"($1::uuid, $2::varchar, $3::uuid, $4::varchar, $5::varchar, $6::jsonb) AS value',
    [claim.id, claim.workerId, claim.leaseToken, commitSha, outcome, JSON.stringify(files)]);
}

test("131 to 132 preserves historical automation and shared publication state, then permits fenced publication", {
  skip: !shouldRun ? "PROJECT_GIT_AUTOMATION_UPGRADE_POSTGRES_GATE=1 is required" : false,
}, async () => {
  const url = requireDisposableDatabase();
  const admin = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  const db = createGateDb(url);
  const root = await mkdtemp(join(tmpdir(), "ai-project-os-git-automation-upgrade-"));
  const migrationsRoot = join(root, "migrations");
  const config = join(root, "prisma.config.ts");
  const migrationNames = (await readdir(join(process.cwd(), "prisma", "migrations"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const targetIndex = migrationNames.indexOf(targetMigration);
  assert.ok(targetIndex > 0, "target migration follows the Git publication head and automation publication migrations");
  const deploy = async () => run("pnpm", ["exec", "prisma", "migrate", "deploy", "--config", config], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });

  try {
    await mkdir(migrationsRoot, { recursive: true });
    await writeFile(config, `import { defineConfig } from "prisma/config";\nexport default defineConfig({ schema: ${JSON.stringify(join(process.cwd(), "prisma", "schema.prisma"))}, migrations: { path: ${JSON.stringify(migrationsRoot)} }, datasource: { url: process.env.DATABASE_URL } });\n`);
    for (const name of migrationNames.slice(0, targetIndex)) {
      await cp(join(process.cwd(), "prisma", "migrations", name), join(migrationsRoot, name), { recursive: true });
    }
    await deploy();
    await admin.connect();
    const sessionRole = await admin.query<{ is_superuser: boolean }>(`
      SELECT role_row.rolsuper AS is_superuser
        FROM pg_catalog.pg_roles role_row
       WHERE role_row.rolname = current_user
    `);
    assert.equal(sessionRole.rows[0]?.is_superuser, true, "the disposable gate role must be able to seed pre-migration history safely");

    const liveGrant = await createActiveGrant(db, admin);
    const preClaimEligibility = await admin.query<{ reason: string | null; due_at: Date; database_now: Date }>(`
      SELECT public."project_git_automation_grant_eligibility"(grant_row."id", grant_row."projectId", (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)) AS reason,
             grant_row."activatedAt" + grant_row."runIntervalMinutes" * interval '1 minute' AS due_at,
             (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS database_now
        FROM public."ProjectGitRepositoryAutomationGrant" grant_row WHERE grant_row."id" = $1::uuid
    `, [liveGrant.grantId]);
    assert.equal(preClaimEligibility.rowCount, 1);
    assert.equal(preClaimEligibility.rows[0]?.reason, null, "historical active grant is eligible before claiming");
    assert.ok(preClaimEligibility.rows[0]!.due_at <= preClaimEligibility.rows[0]!.database_now,
      `historical active grant is due before claiming: due=${preClaimEligibility.rows[0]!.due_at.toISOString()} now=${preClaimEligibility.rows[0]!.database_now.toISOString()}`);
    const preUpgradeClaim = await claimRun(admin, liveGrant.grantId, "upgrade-preserved-pending");
    assert.equal(preUpgradeClaim.grantId, liveGrant.grantId);

    const legacyRuns = await seedLegacyLedgerHistory(admin);
    const legacyPublication = await seedLegacyPublication(admin);
    const before = await readLegacyState(admin, legacyRuns, legacyPublication);
    const preMigrationPendingAudit = await admin.query(`SELECT ${legacyAuditColumns}
      FROM public."ProjectGitRepositoryAutomationRunAudit" WHERE "runId" = $1::uuid ORDER BY "createdAt"`, [preUpgradeClaim.id]);
    assert.equal(preMigrationPendingAudit.rowCount, 1);

    await cp(join(process.cwd(), "prisma", "migrations", targetMigration), join(migrationsRoot, targetMigration), { recursive: true });
    await deploy();

    const after = await readLegacyState(admin, legacyRuns, legacyPublication);
    assert.deepEqual(after, before, "131 run, audit, ProjectSource, and shared publication rows remain unchanged");
    const legacyAuditMetadata = await admin.query(`
      SELECT "expectedPublicationVersionId", "expectedPublicationGeneration", "publicationVersionId",
             "publicationGeneration", "observedCommitSha", "manifestFingerprint", "fileCount", "decodedTextBytes"
        FROM public."ProjectGitRepositoryAutomationRunAudit"
       WHERE "runId" = ANY($1::uuid[]) ORDER BY "runId"
    `, [legacyRuns.map((fixture) => fixture.id)]);
    assert.equal(legacyAuditMetadata.rowCount, 4);
    assert.ok(legacyAuditMetadata.rows.every((row) => Object.values(row).every((value) => value === null)),
      "historical pre-publication audit events retain NULL publication metadata under the explicit legacy check branch");

    const pendingAuditAfterUpgrade = await admin.query(`SELECT ${legacyAuditColumns},
        "expectedPublicationVersionId", "expectedPublicationGeneration", "publicationVersionId", "publicationGeneration"
      FROM public."ProjectGitRepositoryAutomationRunAudit" WHERE "runId" = $1::uuid ORDER BY "createdAt"`, [preUpgradeClaim.id]);
    assert.deepEqual(pendingAuditAfterUpgrade.rows[0] && Object.fromEntries(
      Object.keys(preMigrationPendingAudit.rows[0] as Record<string, unknown>).map((key) => [key, (pendingAuditAfterUpgrade.rows[0] as Record<string, unknown>)[key]]),
    ), preMigrationPendingAudit.rows[0], "the pre-upgrade claim audit row is immutable and retains its old fields");
    assert.equal(pendingAuditAfterUpgrade.rows[0]?.expectedPublicationGeneration, 0,
      "the 131 claim audit records the empty expected head as generation zero before migration 132");

    const dispatch = await mutateLease(admin, preUpgradeClaim, "dispatch");
    assert.equal(dispatch.accepted, true);
    assert.equal(dispatch.status, "dispatched");
    const firstFiles = [{ path: "README.md", blobOid: "f".repeat(40), body: "migration publication\n" }];
    const changed = await finalize(admin, preUpgradeClaim, "9".repeat(40), "changed", firstFiles);
    assert.equal(changed.accepted, true);
    assert.equal(changed.status, "succeeded");
    assert.equal(changed.publicationGeneration, 1);

    const postUpgradeAudit = await admin.query(`SELECT "action", "runStatusAfter", "expectedPublicationGeneration",
        "publicationGeneration", "publicationVersionId"
      FROM public."ProjectGitRepositoryAutomationRunAudit" WHERE "runId" = $1::uuid ORDER BY "createdAt"`, [preUpgradeClaim.id]);
    assert.deepEqual(postUpgradeAudit.rows.map((row) => row.expectedPublicationGeneration), [0, 0, 0],
      "the 131 claim and post-132 dispatch/succeeded audit events all retain generation zero");
    assert.equal(postUpgradeAudit.rows[2]?.runStatusAfter, "succeeded");
    assert.equal(postUpgradeAudit.rows[2]?.publicationGeneration, 1);

    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = 'replica'");
      await admin.query(`UPDATE public."ProjectGitRepositoryAutomationScheduleCursor"
                            SET "nextRunAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '1 minute'
                          WHERE "grantId" = $1::uuid AND "status" = 'active'`, [liveGrant.grantId]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    const nextClaim = await claimRun(admin, liveGrant.grantId, "upgrade-unchanged-worker");
    assert.equal(nextClaim.grantId, liveGrant.grantId);
    assert.equal((await mutateLease(admin, nextClaim, "dispatch")).accepted, true);
    const unchanged = await finalize(admin, nextClaim, "9".repeat(40), "unchanged", []);
    assert.equal(unchanged.accepted, true);
    assert.equal(unchanged.status, "unchanged");
    assert.equal(unchanged.publicationGeneration, 1);
    assert.equal(unchanged.publicationVersionId, changed.publicationVersionId);

    const head = await admin.query(`SELECT "currentPublicationVersionId", "generation"
      FROM public."ProjectGitRepositoryPublicationHead"
      WHERE "projectId" = $1::uuid AND "delegationId" = $2::uuid`, [liveGrant.projectId, liveGrant.baseDelegationId]);
    assert.deepEqual(head.rows, [{ currentPublicationVersionId: changed.publicationVersionId, generation: 1 }]);
    const newEvents = await admin.query(`SELECT "action", "expectedPublicationGeneration", "publicationGeneration"
      FROM public."ProjectGitRepositoryAutomationRunAudit" WHERE "runId" = $1::uuid ORDER BY "createdAt"`, [nextClaim.id]);
    assert.ok(newEvents.rowCount && newEvents.rows.every((row) => row.expectedPublicationGeneration === 1));
    assert.equal(newEvents.rows.at(-1)?.action, "run_unchanged");
  } finally {
    await admin.end().catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
