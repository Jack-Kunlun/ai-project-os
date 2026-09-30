import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { getDb } from "../src/lib/db";
import { grantProjectMembership, grantWorkspaceMembership } from "../src/lib/membership-governance";
import {
  confirmProjectGitRepositoryDelegationOwner,
  confirmProjectGitRepositoryDelegationProject,
  proposeProjectGitRepositoryDelegation,
} from "../src/lib/project-git-repository-delegation-service";
import {
  activateProjectGitAutomationGrantProjectOwner,
  confirmProjectGitAutomationGrantConnectionOwner,
  proposeProjectGitAutomationGrant,
  revokeProjectGitAutomationGrant,
} from "../src/lib/project-git-automation-grant-service";
import { createGitConnectionFixture } from "./personal-connection-probe-fixture";
import { createPostgresWorkspaceFixture } from "./postgres-workspace-fixture";

const shouldRun = process.env.PROJECT_GIT_AUTOMATION_READ_CONTEXT_POSTGRES_GATE === "1";
const databaseName = "ai_project_os_project_git_automation_read_context_test";
const seededAdminId = "00000000-0000-4000-8000-000000000010";
const workerRole = "ai_project_os_git_automation_worker";

type WorkerConnection = Readonly<{
  connectionId: string;
  credentialId: string;
  credentialCiphertext: Buffer;
  credentialNonce: Buffer;
  credentialAuthTag: Buffer;
  credentialFingerprint: string;
  projectId: string;
  baseDelegationId: string;
  grantId: string;
  connectionOwnerActor: { id: string; role: "user"; accountAccessVersion: number };
}>;

function requireDatabaseUrl(environmentName: string, roleName: string): string {
  const raw = process.env[environmentName];
  if (typeof raw !== "string" || raw.length === 0) throw new Error(`${environmentName}_REQUIRED`);
  const parsed = new URL(raw);
  if (!(["postgres:", "postgresql:"].includes(parsed.protocol)
    && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    && parsed.port === "56432"
    && parsed.pathname === `/${databaseName}`
    && decodeURIComponent(parsed.username) === roleName
    && parsed.password.length > 0
    && parsed.search === ""
    && parsed.hash === "")) {
    throw new Error(`${environmentName}_INVALID`);
  }
  return parsed.toString();
}

async function withReplicatedAdmin<T>(admin: Client, operation: (client: Client) => Promise<T>): Promise<T> {
  await admin.query("BEGIN");
  try {
    await admin.query("SET LOCAL session_replication_role = 'replica'");
    const result = await operation(admin);
    await admin.query("COMMIT");
    return result;
  } catch (error) {
    await admin.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function createActiveGrant(): Promise<WorkerConnection> {
  const db = getDb();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const { workspaceId, ownerId: projectOwnerId } = await createPostgresWorkspaceFixture(db);
  const connectionOwnerId = randomUUID();
  const projectId = randomUUID();
  const connectionId = randomUUID();
  const credentialId = randomUUID();
  const credentialSecret = "synthetic-git-private-key-for-postgres-gate";
  const credentialFingerprint = createHash("sha256").update(credentialSecret, "utf8").digest("hex");
  const addressFingerprint = "b".repeat(64);
  const connectionOwnerActor = { id: connectionOwnerId, role: "user" as const, accountAccessVersion: 1 };
  const projectOwnerActor = { id: projectOwnerId, role: "user" as const, accountAccessVersion: 1 };
  const credentialCiphertext = Buffer.alloc(128, 0x5a);
  const credentialNonce = Buffer.from("00112233445566778899aabb", "hex");
  const credentialAuthTag = Buffer.from("00112233445566778899aabbccddeeff", "hex");

  await db.appUser.create({
    data: { id: connectionOwnerId, username: `read_context_owner_${suffix}`, role: "user" },
  });
  await db.project.create({
    data: { id: projectId, workspaceId, name: `Git read context ${suffix}`, slug: `git-read-context-${suffix}` },
  });
  await db.$transaction(async (tx) => {
    await grantWorkspaceMembership(tx, {
      workspaceId,
      userId: connectionOwnerId,
      role: "member",
      actorId: seededAdminId,
      reason: "git_automation_context_connection_owner",
    });
    await grantProjectMembership(tx, {
      projectId,
      workspaceId,
      userId: connectionOwnerId,
      role: "editor",
      actorId: seededAdminId,
      reason: "git_automation_context_connection_owner",
    });
    await grantProjectMembership(tx, {
      projectId,
      workspaceId,
      userId: projectOwnerId,
      role: "owner",
      actorId: seededAdminId,
      reason: "git_automation_context_project_owner",
    });
  });
  await db.externalCredential.create({
    data: {
      id: credentialId,
      kind: "git",
      ciphertext: credentialCiphertext,
      nonce: credentialNonce,
      authTag: credentialAuthTag,
      maskedSuffix: "ssh-key",
      secretFingerprint: credentialFingerprint,
    },
  });
  await createGitConnectionFixture({
    id: connectionId,
    name: `Git context SSH ${suffix}`,
    providerKind: "generic",
    transport: "ssh",
    baseUrl: "ssh://git@github.com",
    authKind: "sshKey",
    username: "git",
    sshKnownHost: "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest-fixture",
    status: "verified",
    ownershipState: "confirmed",
    resolvedAddressFingerprint: addressFingerprint,
    createdById: connectionOwnerId,
    ownerUserId: connectionOwnerId,
    ownerAccountAccessVersion: 1,
    credentialId,
  }, db);

  const delegation = await proposeProjectGitRepositoryDelegation(projectId, {
    gitConnectionId: connectionId,
    repositoryPath: "org/read-context",
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
  const grant = await proposeProjectGitAutomationGrant(projectId, {
    baseDelegationId: activeDelegation.id,
    runIntervalMinutes: 60,
    expiresAt: activeDelegation.expiresAt,
  }, connectionOwnerActor, db);
  const ownerConfirmedGrant = await confirmProjectGitAutomationGrantConnectionOwner(projectId, grant.id, {
    expectedVersion: grant.version,
    acknowledgeReadOnlyScheduledAccess: true,
  }, connectionOwnerActor, db);
  await activateProjectGitAutomationGrantProjectOwner(projectId, grant.id, {
    expectedVersion: ownerConfirmedGrant.version,
    acknowledgeExactRepositoryScope: true,
    acknowledgeReadOnlyDataEgress: true,
  }, projectOwnerActor, db);

  return Object.freeze({
    connectionId,
    credentialId,
    credentialCiphertext,
    credentialNonce,
    credentialAuthTag,
    credentialFingerprint,
    projectId,
    baseDelegationId: activeDelegation.id,
    grantId: grant.id,
    connectionOwnerActor,
  });
}

async function seedBaseline(admin: Client, fixture: WorkerConnection): Promise<{ frozenCommitSha: string; versionId: string }> {
  const snapshot = await admin.query<{
    delegationVersion: number;
    delegationFingerprint: string;
    repositoryPath: string;
    trackedRef: string;
  }>(`
    SELECT "version" AS "delegationVersion", "delegationFingerprint", "repositoryPath", "trackedRef"
      FROM public."ProjectGitRepositoryDelegation"
     WHERE "id" = $1::uuid AND "projectId" = $2::uuid
  `, [fixture.baseDelegationId, fixture.projectId]);
  const delegation = snapshot.rows[0];
  assert.ok(delegation);
  const versionId = randomUUID();
  const frozenCommitSha = "c".repeat(40);
  const publishedAt = new Date();
  await withReplicatedAdmin(admin, async (client) => {
    await client.query(`
      INSERT INTO public."ProjectGitRepositoryPublicationVersion" (
        "id", "projectId", "delegationId", "runKind", "runId", "previousPublicationVersionId", "previousGeneration",
        "delegationVersion", "delegationFingerprint", "repositoryPath", "trackedRef", "frozenCommitSha",
        "manifestFingerprint", "fileCount", "decodedTextBytes", "publishedAt"
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, 'manual', $4::uuid, NULL, 0,
        $5, $6, $7, $8, $9, repeat('e', 64), 1, 0, $10::timestamptz(3)
      )
    `, [versionId, fixture.projectId, fixture.baseDelegationId, randomUUID(), delegation.delegationVersion,
      delegation.delegationFingerprint, delegation.repositoryPath, delegation.trackedRef, frozenCommitSha, publishedAt]);
    await client.query(`
      INSERT INTO public."ProjectGitRepositoryPublicationHead" (
        "projectId", "delegationId", "currentPublicationVersionId", "generation", "publishedAt"
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, 1, $4::timestamptz(3))
    `, [fixture.projectId, fixture.baseDelegationId, versionId, publishedAt]);
  });
  return { frozenCommitSha, versionId };
}

async function makeGrantDue(admin: Client, grantId: string): Promise<void> {
  await withReplicatedAdmin(admin, async (client) => {
    await client.query(`
      UPDATE public."ProjectGitRepositoryAutomationGrant"
         SET "activatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '61 minutes'
       WHERE "id" = $1::uuid
    `, [grantId]);
    await client.query(`
      UPDATE public."ProjectGitRepositoryAutomationScheduleCursor"
         SET "nextRunAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '1 minute'
       WHERE "grantId" = $1::uuid AND "status" = 'active'
    `, [grantId]);
  });
}

async function beginWorkerTransaction(worker: Client, isolation: "SERIALIZABLE" | "READ COMMITTED" = "SERIALIZABLE"): Promise<void> {
  await worker.query(`BEGIN ISOLATION LEVEL ${isolation}`);
}

async function claimAndDispatch(worker: Client, fixture: WorkerConnection): Promise<{ id: string; workerId: string; leaseToken: string }> {
  await beginWorkerTransaction(worker);
  try {
    const claimResult = await worker.query<{ result: { id: string; workerId: string; leaseToken: string } | null }>(
      'SELECT public."project_git_automation_claim_due"($1::uuid, $2::varchar) AS result',
      [fixture.grantId, "context-shape-worker"],
    );
    await worker.query("COMMIT");
    const claim = claimResult.rows[0]?.result;
    assert.ok(claim);

    await beginWorkerTransaction(worker);
    try {
      const dispatchResult = await worker.query<{ result: { accepted: boolean; status: string } }>(
        'SELECT public."project_git_automation_mutate_lease"($1::uuid, $2::varchar, $3::uuid, $4::varchar) AS result',
        [claim.id, claim.workerId, claim.leaseToken, "dispatch"],
      );
      assert.equal(dispatchResult.rows[0]?.result.accepted, true);
      assert.equal(dispatchResult.rows[0]?.result.status, "dispatched");
      await worker.query("COMMIT");
    } catch (error) {
      await worker.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    return claim;
  } catch (error) {
    await worker.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function readContext(
  worker: Client,
  runId: string,
  workerId: string,
  leaseToken: string,
  isolation: "SERIALIZABLE" | "READ COMMITTED" = "SERIALIZABLE",
): Promise<Record<string, unknown> | null> {
  await beginWorkerTransaction(worker, isolation);
  try {
    const result = await worker.query<{ context: Record<string, unknown> | null }>(
      'SELECT public."project_git_automation_read_context"($1::uuid, $2::varchar, $3::uuid) AS context',
      [runId, workerId, leaseToken],
    );
    await worker.query("COMMIT");
    return result.rows[0]?.context ?? null;
  } catch (error) {
    await worker.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

test("lease-bound Git context returns only the SSH connection, sealed key and matching shared head", {
  skip: !shouldRun ? "PROJECT_GIT_AUTOMATION_READ_CONTEXT_POSTGRES_GATE=1 is required" : false,
  timeout: 120_000,
}, async () => {
  requireDatabaseUrl("DATABASE_URL", "ai_project_os_runtime");
  const adminUrl = requireDatabaseUrl("DATABASE_PRINCIPAL_ADMIN_URL", "ai_project_os_cluster_admin");
  const workerUrl = requireDatabaseUrl("GIT_AUTOMATION_DATABASE_URL", workerRole);
  const db = getDb();
  const admin = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 5_000 });
  const worker = new Client({ connectionString: workerUrl, connectionTimeoutMillis: 5_000 });
  await admin.connect();
  await worker.connect();
  try {
    const fixture = await createActiveGrant();
    const baseline = await seedBaseline(admin, fixture);
    await makeGrantDue(admin, fixture.grantId);
    const claim = await claimAndDispatch(worker, fixture);

    const context = await readContext(worker, claim.id, claim.workerId, claim.leaseToken);
    assert.ok(context);
    assert.deepEqual(Object.keys(context).sort(), ["baseline", "connection", "credential"]);
    assert.deepEqual(context.connection, {
      id: fixture.connectionId,
      providerKind: "generic",
      transport: "ssh",
      baseUrl: "ssh://git@github.com",
      authKind: "sshKey",
      username: "git",
      allowPrivateNetwork: false,
      tlsCaCertificate: null,
      sshKnownHost: "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest-fixture",
      resolvedAddressFingerprint: "b".repeat(64),
      credentialId: fixture.credentialId,
    });
    assert.deepEqual(context.credential, {
      kind: "git",
      ciphertext: fixture.credentialCiphertext.toString("base64"),
      nonce: fixture.credentialNonce.toString("base64"),
      authTag: fixture.credentialAuthTag.toString("base64"),
      keyVersion: 1,
      secretFingerprint: fixture.credentialFingerprint,
    });
    assert.deepEqual(context.baseline, { frozenCommitSha: baseline.frozenCommitSha });
    for (const value of [
      (context.credential as Record<string, unknown>).ciphertext,
      (context.credential as Record<string, unknown>).nonce,
      (context.credential as Record<string, unknown>).authTag,
    ]) assert.equal(typeof value === "string" && /[\r\n]/u.test(value), false, "base64 credential values are single-line");

    await withReplicatedAdmin(admin, async (client) => {
      await client.query(`
        UPDATE public."ProjectGitRepositoryPublicationVersion"
           SET "publishedAt" = "publishedAt" + interval '1 second'
         WHERE "id" = $1::uuid
      `, [baseline.versionId]);
    });
    assert.equal(await readContext(worker, claim.id, claim.workerId, claim.leaseToken), null, "a baseline version outside the current head timestamp returns no context");
    await withReplicatedAdmin(admin, async (client) => {
      await client.query(`
        UPDATE public."ProjectGitRepositoryPublicationVersion"
           SET "publishedAt" = "publishedAt" - interval '1 second'
         WHERE "id" = $1::uuid
      `, [baseline.versionId]);
    });

    for (const relation of [
      "GitConnection",
      "ProjectGitRepositoryDelegation",
      "ExternalCredential",
      "ProjectSource",
      "ProjectGitRepositoryPublicationVersion",
      "ProjectGitRepositoryPublicationEntry",
      "ProjectGitRepositoryPublicationHead",
    ]) {
      await assert.rejects(
        () => worker.query(`SELECT * FROM public."${relation}" LIMIT 0`),
        (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === "42501",
        `${workerRole} must not directly read ${relation}`,
      );
    }

    assert.equal(await readContext(worker, claim.id, claim.workerId, randomUUID()), null, "a different lease token returns no context");
    assert.equal(await readContext(worker, claim.id, "another-worker", claim.leaseToken), null, "a different worker id returns no context");
    assert.equal(await readContext(worker, randomUUID(), claim.workerId, claim.leaseToken), null, "a different run id returns no context");

    await assert.rejects(
      () => readContext(worker, claim.id, claim.workerId, claim.leaseToken, "READ COMMITTED"),
      (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === "25001",
      "the function requires a serializable transaction",
    );

    await admin.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await assert.rejects(
      () => admin.query(
        'SELECT public."project_git_automation_read_context"($1::uuid, $2::varchar, $3::uuid)',
        [claim.id, claim.workerId, claim.leaseToken],
      ),
      (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === "42501",
      "a non-worker session cannot read the context",
    );
    await admin.query("ROLLBACK");

    const savedHead = await admin.query<{ generation: number }>(`
      SELECT "generation" FROM public."ProjectGitRepositoryPublicationHead"
       WHERE "projectId" = $1::uuid AND "delegationId" = $2::uuid
    `, [fixture.projectId, fixture.baseDelegationId]);
    assert.equal(savedHead.rows[0]?.generation, 1);
    await withReplicatedAdmin(admin, async (client) => {
      await client.query(`
        UPDATE public."ProjectGitRepositoryPublicationHead" SET "generation" = 2
         WHERE "projectId" = $1::uuid AND "delegationId" = $2::uuid
      `, [fixture.projectId, fixture.baseDelegationId]);
    });
    assert.equal(await readContext(worker, claim.id, claim.workerId, claim.leaseToken), null, "a stale shared-head generation returns no context");
    await withReplicatedAdmin(admin, async (client) => {
      await client.query(`
        UPDATE public."ProjectGitRepositoryPublicationHead" SET "generation" = 1
         WHERE "projectId" = $1::uuid AND "delegationId" = $2::uuid
      `, [fixture.projectId, fixture.baseDelegationId]);
    });

    await withReplicatedAdmin(admin, async (client) => {
      await client.query(`
        UPDATE public."ProjectGitRepositoryAutomationRun"
           SET "scheduledFor" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '10 minutes',
               "claimedAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '10 minutes',
               "dispatchedAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '9 minutes',
               "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '1 minute'
         WHERE "id" = $1::uuid
      `, [claim.id]);
    });
    assert.equal(await readContext(worker, claim.id, claim.workerId, claim.leaseToken), null, "an expired dispatched lease returns no context");
    await withReplicatedAdmin(admin, async (client) => {
      await client.query(`
        UPDATE public."ProjectGitRepositoryAutomationRun"
           SET "scheduledFor" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '3 minutes',
               "claimedAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '2 minutes',
               "dispatchedAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '1 minute',
               "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) + interval '1 minute'
         WHERE "id" = $1::uuid
      `, [claim.id]);
    });

    const grant = await db.projectGitRepositoryAutomationGrant.findUniqueOrThrow({ where: { id: fixture.grantId } });
    await revokeProjectGitAutomationGrant(fixture.projectId, fixture.grantId, {
      expectedVersion: grant.version,
      reason: "read context gate revocation",
    }, fixture.connectionOwnerActor, db);
    assert.equal(await readContext(worker, claim.id, claim.workerId, claim.leaseToken), null, "a revoked grant returns no context");
  } finally {
    await worker.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
  }
});
