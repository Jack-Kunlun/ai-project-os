import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { getDb, getGitAutomationWorkerDb } from "../src/lib/db";
import { grantProjectMembership, grantWorkspaceMembership } from "../src/lib/membership-governance";
import { deleteArchivedProject, updateProjectLifecycle } from "../src/lib/project-lifecycle";
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
import {
  claimNextProjectGitAutomationRun,
  finalizeProjectGitAutomationRunResult,
  heartbeatProjectGitAutomationRun,
  markProjectGitAutomationRunDispatched,
} from "../src/lib/project-git-automation-run-service";
import { createGitConnectionFixture } from "./personal-connection-probe-fixture";
import { createPostgresWorkspaceFixture } from "./postgres-workspace-fixture";

const shouldRun = process.env.PROJECT_GIT_AUTOMATION_RUN_LEDGER_POSTGRES_GATE === "1";
const databaseName = "ai_project_os_project_git_automation_run_ledger_test";
const seededAdminId = "00000000-0000-4000-8000-000000000010";

function assertDisposableGateDatabase(): void {
  const configuredUrl = process.env.DATABASE_URL;
  const configuredAdminUrl = process.env.DATABASE_PRINCIPAL_ADMIN_URL;
  if (typeof configuredUrl !== "string" || configuredUrl.length === 0) {
    throw new Error("PROJECT_GIT_AUTOMATION_RUN_LEDGER_TEST_DATABASE_URL_REQUIRED");
  }
  const parsed = new URL(configuredUrl);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== `/${databaseName}`
    || parsed.username !== "ai_project_os_runtime"
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== "") {
    throw new Error("PROJECT_GIT_AUTOMATION_RUN_LEDGER_TEST_DATABASE_URL_INVALID");
  }
  if (typeof configuredAdminUrl !== "string" || configuredAdminUrl.length === 0) {
    throw new Error("PROJECT_GIT_AUTOMATION_RUN_LEDGER_ADMIN_URL_REQUIRED");
  }
  const admin = new URL(configuredAdminUrl);
  if (!["postgres:", "postgresql:"].includes(admin.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(admin.hostname.toLowerCase())
    || admin.port !== "56432"
    || admin.pathname !== `/${databaseName}`
    || admin.username !== "ai_project_os_cluster_admin"
    || admin.password.length === 0
    || admin.search !== ""
    || admin.hash !== "") {
    throw new Error("PROJECT_GIT_AUTOMATION_RUN_LEDGER_ADMIN_URL_INVALID");
  }
}

async function withGateAdminFixture<T>(operation: (client: Client) => Promise<T>): Promise<T> {
  const connectionString = process.env.DATABASE_PRINCIPAL_ADMIN_URL;
  if (typeof connectionString !== "string") throw new Error("PROJECT_GIT_AUTOMATION_RUN_LEDGER_ADMIN_URL_REQUIRED");
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await client.query("BEGIN");
    // Only the disposable gate fixture bypasses immutability triggers to move
    // timestamps forward for deterministic lease/schedule expiry coverage.
    await client.query("SET LOCAL session_replication_role = 'replica'");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

async function assertRuntimeMutationDenied(
  db: PrismaClient,
  label: string,
  statement: string,
): Promise<void> {
  let actualError: unknown;
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(statement);
      // Roll back even if an unexpected grant lets the statement execute.
      throw new Error("PROJECT_GIT_AUTOMATION_RUNTIME_DML_UNEXPECTEDLY_ALLOWED");
    });
  } catch (error) {
    actualError = error;
  }
  const message = actualError instanceof Error
    ? `${actualError.message} ${JSON.stringify((actualError as Error & { meta?: unknown }).meta ?? {})}`
    : String(actualError);
  assert.match(message, /permission denied|42501/iu, `${label} must fail through PostgreSQL privilege checks`);
}

async function assertLedgerRuntimeDmlDenied(db: ReturnType<typeof getDb>, grantId: string): Promise<void> {
  for (const { table, updateColumn } of [
    { table: "ProjectGitRepositoryAutomationScheduleCursor", updateColumn: "nextRunAt" },
    { table: "ProjectGitRepositoryAutomationRun", updateColumn: "updatedAt" },
    { table: "ProjectGitRepositoryAutomationRunAudit", updateColumn: "reason" },
  ]) {
    await assertRuntimeMutationDenied(db, `${table} INSERT`, `INSERT INTO public."${table}" DEFAULT VALUES`);
    await assertRuntimeMutationDenied(db, `${table} UPDATE`, `UPDATE public."${table}" SET "${updateColumn}" = "${updateColumn}" WHERE FALSE`);
    await assertRuntimeMutationDenied(db, `${table} DELETE`, `DELETE FROM public."${table}" WHERE FALSE`);
    await assertRuntimeMutationDenied(db, `${table} TRUNCATE`, `TRUNCATE TABLE public."${table}"`);
  }
  await assertRuntimeMutationDenied(
    db,
    "audit forgery INSERT",
    `INSERT INTO public."ProjectGitRepositoryAutomationRunAudit" (
       "id", "grantId", "projectId", "action", "cursorVersion", "cursorStatusAfter",
       "nextRunAt", "grantVersion", "grantFingerprint"
     ) VALUES (
       '${randomUUID()}'::uuid, '${grantId}'::uuid, '${randomUUID()}'::uuid, 'schedule_initialized', 1,
       'active', (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3), 1, repeat('a', 64)
     )`,
  );
}

async function assertWorkerMutationDenied(
  db: PrismaClient,
  label: string,
  statement: string,
): Promise<void> {
  let actualError: unknown;
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(statement);
      throw new Error("PROJECT_GIT_AUTOMATION_WORKER_DML_UNEXPECTEDLY_ALLOWED");
    });
  } catch (error) {
    actualError = error;
  }
  const message = actualError instanceof Error
    ? `${actualError.message} ${JSON.stringify((actualError as Error & { meta?: unknown }).meta ?? {})}`
    : String(actualError);
  assert.match(message, /permission denied|42501/iu, `${label} must fail through PostgreSQL privilege checks`);
}

function createInspectionDb(): PrismaClient {
  const connectionString = process.env.DATABASE_PRINCIPAL_ADMIN_URL;
  if (typeof connectionString !== "string" || connectionString.length === 0) {
    throw new Error("PROJECT_GIT_AUTOMATION_RUN_LEDGER_ADMIN_URL_REQUIRED");
  }
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

async function assertRoleCannotExecuteFunction(connectionString: string | undefined, label: string): Promise<void> {
  if (typeof connectionString !== "string" || connectionString.length === 0) {
    throw new Error(`${label}_DATABASE_URL_REQUIRED`);
  }
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await assert.rejects(
      () => client.query('SELECT public."project_git_automation_claim_due"(NULL::uuid, NULL::varchar)'),
      (error: unknown) => error instanceof Error
        && /permission denied|42501/iu.test(`${error.message} ${(error as Error & { code?: string }).code ?? ""}`),
      `${label} must not execute the Git automation claim function`,
    );
  } finally {
    await client.end();
  }
}

async function assertRoleCannotUpdateLedger(connectionString: string | undefined, label: string): Promise<void> {
  if (typeof connectionString !== "string" || connectionString.length === 0) {
    throw new Error(`${label}_DATABASE_URL_REQUIRED`);
  }
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await assert.rejects(
      () => client.query(`UPDATE public."ProjectGitRepositoryAutomationRun" SET "status" = "status" WHERE FALSE`),
      (error: unknown) => error instanceof Error
        && /permission denied|42501/iu.test(`${error.message} ${(error as Error & { code?: string }).code ?? ""}`),
      `${label} must not write the Git automation ledger directly`,
    );
  } finally {
    await client.end();
  }
}

type ActiveGrantFixture = Readonly<{
  projectId: string;
  connectionOwnerId: string;
  connectionOwnerActor: { id: string; role: "user"; accountAccessVersion: number };
  projectOwnerActor: { id: string; role: "user"; accountAccessVersion: number };
  baseDelegationId: string;
  grantId: string;
}>;

async function createActiveGrant(): Promise<ActiveGrantFixture> {
  const db = getDb();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const { workspaceId, ownerId: projectOwnerId } = await createPostgresWorkspaceFixture(db);
  const connectionOwnerId = randomUUID();
  const projectId = randomUUID();
  const connectionId = randomUUID();
  const credentialId = randomUUID();
  const connectionFingerprint = "a".repeat(64);
  const addressFingerprint = "b".repeat(64);
  const connectionOwnerActor = { id: connectionOwnerId, role: "user" as const, accountAccessVersion: 1 };
  const projectOwnerActor = { id: projectOwnerId, role: "user" as const, accountAccessVersion: 1 };

  await db.appUser.create({
    data: { id: connectionOwnerId, username: `automation_owner_${suffix}`, role: "user" },
  });
  await db.project.create({
    data: { id: projectId, workspaceId, name: `Automation ledger ${suffix}`, slug: `automation-ledger-${suffix}` },
  });
  await db.$transaction(async (tx) => {
    await grantWorkspaceMembership(tx, {
      workspaceId,
      userId: connectionOwnerId,
      role: "member",
      actorId: seededAdminId,
      reason: "git_automation_run_ledger_connection_owner",
    });
    await grantProjectMembership(tx, {
      projectId,
      workspaceId,
      userId: connectionOwnerId,
      role: "editor",
      actorId: seededAdminId,
      reason: "git_automation_run_ledger_connection_owner",
    });
    await grantProjectMembership(tx, {
      projectId,
      workspaceId,
      userId: projectOwnerId,
      role: "owner",
      actorId: seededAdminId,
      reason: "git_automation_run_ledger_project_owner",
    });
  });
  await db.externalCredential.create({
    data: {
      id: credentialId,
      kind: "git",
      ciphertext: Buffer.from([1]),
      nonce: Buffer.from([2]),
      authTag: Buffer.from([3]),
      maskedSuffix: "ledger",
      secretFingerprint: connectionFingerprint,
    },
  });
  await createGitConnectionFixture({
    id: connectionId,
    name: `Automation ledger Git ${suffix}`,
    providerKind: "github",
    transport: "https",
    baseUrl: "https://github.com",
    authKind: "token",
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
    repositoryPath: "org/automation-ledger",
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
    projectId,
    connectionOwnerId,
    connectionOwnerActor,
    projectOwnerActor,
    baseDelegationId: activeDelegation.id,
    grantId: grant.id,
  });
}

async function makeGrantDue(grantId: string): Promise<Date> {
  const db = getDb();
  await withGateAdminFixture(async (client) => {
    // The isolated gate backdates only the activation timestamp so it can test
    // scheduling without waiting an hour; production transitions are unchanged.
    await client.query(`
      UPDATE "ProjectGitRepositoryAutomationGrant"
         SET "activatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '61 minutes'
       WHERE "id" = $1::uuid
    `, [grantId]);
  });
  const grant = await db.projectGitRepositoryAutomationGrant.findUniqueOrThrow({
    where: { id: grantId },
    select: { activatedAt: true, runIntervalMinutes: true },
  });
  assert.ok(grant.activatedAt);
  return new Date(grant.activatedAt.getTime() + grant.runIntervalMinutes * 60_000);
}

async function makeCursorDue(grantId: string): Promise<void> {
  await withGateAdminFixture(async (client) => {
    await client.query(`
      UPDATE "ProjectGitRepositoryAutomationScheduleCursor"
         SET "nextRunAt" = (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) - interval '1 minute'
       WHERE "grantId" = $1::uuid AND "status" = 'active'
    `, [grantId]);
  });
}

async function claimAndDispatch(grantId: string, workerId: string) {
  const db = getGitAutomationWorkerDb();
  await makeCursorDue(grantId);
  const claim = await claimNextProjectGitAutomationRun(workerId, db);
  assert.ok(claim, `expected a due claim for ${grantId}`);
  assert.equal(claim.grantId, grantId);
  const dispatched = await markProjectGitAutomationRunDispatched(claim.id, claim.workerId, claim.leaseToken, db);
  assert.equal(dispatched?.accepted, true);
  assert.equal(dispatched?.status, "dispatched");
  return claim;
}

async function readExpectedPublicationCursor(db: PrismaClient, runId: string) {
  return db.projectGitRepositoryAutomationRun.findUniqueOrThrow({
    where: { id: runId },
    select: { expectedPublicationVersionId: true, expectedPublicationGeneration: true },
  });
}

async function seedSyntheticManualPublication(input: Readonly<{
  projectId: string;
  delegationId: string;
  previousVersionId: string;
  previousGeneration: number;
  previousSourceCount: number;
  commitSha: string;
  body: string;
}>): Promise<Readonly<{ versionId: string; sourceId: string; manifestFingerprint: string }>> {
  const versionId = randomUUID();
  const sourceId = randomUUID();
  const runId = randomUUID();
  const publishedAt = new Date();
  const path = "README.md";
  const blobOid = "d".repeat(40);
  const sourceIdentity = randomUUID();
  const revisionKey = randomUUID();
  let contentText = "";
  let contentHash = "";
  let contentBytes = 0;
  let lineCount = 0;
  let manifestFingerprint = "";

  await withGateAdminFixture(async (client) => {
    const delegation = await client.query<{
      delegationVersion: number;
      delegationFingerprint: string;
      repositoryPath: string;
      trackedRef: string;
    }>(`
      SELECT "version" AS "delegationVersion", "delegationFingerprint", "repositoryPath", "trackedRef"
        FROM "ProjectGitRepositoryDelegation"
       WHERE "id" = $1::uuid AND "projectId" = $2::uuid
    `, [input.delegationId, input.projectId]);
    const snapshot = delegation.rows[0];
    assert.ok(snapshot);
    contentText = `Repository: ${snapshot.repositoryPath}\nRevision: ${input.commitSha}\nPath: ${path}\n\n${input.body}`;
    contentHash = createHash("sha256").update(contentText, "utf8").digest("hex");
    contentBytes = Buffer.byteLength(contentText, "utf8");
    lineCount = contentText.split("\n").length;

    await client.query(`
      INSERT INTO "ProjectSource" (
        "id", "projectId", "kind", "originScope", "projectRepositoryLinkId", "sourceIdentity", "revisionKey",
        "externalRef", "contentText", "contentHash", "capturedAt"
      ) VALUES ($1::uuid, $2::uuid, 'git', 'project', NULL, $3::uuid, $4::uuid, NULL, $5, $6, $7::timestamptz(3))
    `, [sourceId, input.projectId, sourceIdentity, revisionKey, contentText, contentHash, publishedAt]);
    await client.query(`
      INSERT INTO "ProjectGitRepositoryPublicationVersion" (
        "id", "projectId", "delegationId", "runKind", "runId", "previousPublicationVersionId", "previousGeneration",
        "delegationVersion", "delegationFingerprint", "repositoryPath", "trackedRef", "frozenCommitSha",
        "manifestFingerprint", "fileCount", "decodedTextBytes", "publishedAt"
      ) SELECT $1::uuid, delegation."projectId", delegation."id", 'manual', $2::uuid, $3::uuid, $4,
               delegation."version", delegation."delegationFingerprint", delegation."repositoryPath", delegation."trackedRef",
               $5, repeat('f', 64), 1, $6, $7::timestamptz(3)
          FROM "ProjectGitRepositoryDelegation" delegation
         WHERE delegation."id" = $8::uuid AND delegation."projectId" = $9::uuid
    `, [versionId, runId, input.previousVersionId, input.previousGeneration, input.commitSha, contentBytes, publishedAt, input.delegationId, input.projectId]);
    await client.query(`
      INSERT INTO "ProjectGitRepositoryPublicationEntry" (
        "id", "projectId", "delegationId", "publicationVersionId", "projectSourceId", "ordinal",
        "normalizedPath", "blobOid", "contentHash", "contentBytes", "lineCount"
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 0, $6, $7, $8, $9, $10)
    `, [randomUUID(), input.projectId, input.delegationId, versionId, sourceId, path, blobOid, contentHash, contentBytes, lineCount]);
    const manifest = await client.query<{ manifest: string }>(`
      SELECT public."project_git_repository_publication_manifest"($1::uuid) AS "manifest"
    `, [versionId]);
    manifestFingerprint = manifest.rows[0]?.manifest ?? "";
    assert.match(manifestFingerprint, /^[0-9a-f]{64}$/u);
    await client.query(`
      UPDATE "ProjectGitRepositoryPublicationVersion" SET "manifestFingerprint" = $2 WHERE "id" = $1::uuid
    `, [versionId, manifestFingerprint]);
    const retired = await client.query(`
      UPDATE "ProjectSource" source_row SET "retiredAt" = $3::timestamptz(3)
        FROM "ProjectGitRepositoryPublicationEntry" entry
       WHERE entry."projectId" = $1::uuid AND entry."delegationId" = $2::uuid
         AND entry."publicationVersionId" = $4::uuid
         AND source_row."projectId" = entry."projectId" AND source_row."id" = entry."projectSourceId"
         AND source_row."retiredAt" IS NULL
    `, [input.projectId, input.delegationId, publishedAt, input.previousVersionId]);
    assert.equal(retired.rowCount, input.previousSourceCount, "synthetic manual head transition must retire every previous source");
    const advanced = await client.query(`
      UPDATE "ProjectGitRepositoryPublicationHead"
         SET "currentPublicationVersionId" = $3::uuid, "generation" = "generation" + 1, "publishedAt" = $4::timestamptz(3)
       WHERE "projectId" = $1::uuid AND "delegationId" = $2::uuid
         AND "currentPublicationVersionId" = $5::uuid AND "generation" = $6
    `, [input.projectId, input.delegationId, versionId, publishedAt, input.previousVersionId, input.previousGeneration]);
    assert.equal(advanced.rowCount, 1, "synthetic manual head transition must use the expected cursor");
  });

  return Object.freeze({ versionId, sourceId, manifestFingerprint });
}

async function assertDatabaseRejectsAutomationFiles(
  db: PrismaClient,
  claim: NonNullable<Awaited<ReturnType<typeof claimNextProjectGitAutomationRun>>>,
  files: readonly Readonly<{ path: string; blobOid: string; body: string }>[],
): Promise<void> {
  await assert.rejects(
    () => db.$transaction(async (tx) => tx.$queryRaw(Prisma.sql`
      SELECT public."project_git_automation_finalize_result"(
        ${claim.id}::uuid, ${claim.workerId}::varchar, ${claim.leaseToken}::uuid,
        ${"3".repeat(40)}::varchar, ${"changed"}::varchar, ${JSON.stringify(files)}::jsonb
      )
    `), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }),
    (error: unknown) => error instanceof Error
      && /PROJECT_GIT_AUTOMATION_FILE_(?:CONTENT|SHAPE)_INVALID|PROJECT_GIT_AUTOMATION_SOURCE_CONTENT_TOO_LARGE/u.test(
        `${error.message} ${JSON.stringify((error as Error & { meta?: unknown }).meta ?? {})}`,
      ),
  );
}

async function expirePendingLease(runId: string): Promise<void> {
  await withGateAdminFixture(async (client) => {
    await client.query(`
      UPDATE "ProjectGitRepositoryAutomationRun"
         SET "leaseExpiresAt" = "claimedAt" + interval '1 millisecond'
       WHERE "id" = $1::uuid
    `, [runId]);
  });
}

async function expireGrantAfterProposal(grantId: string): Promise<void> {
  await withGateAdminFixture(async (client) => {
    await client.query(`
      UPDATE "ProjectGitRepositoryAutomationGrant"
         SET "expiresAt" = "proposedAt" + interval '1 millisecond'
       WHERE "id" = $1::uuid
    `, [grantId]);
  });
}

async function driftBaseDelegation(baseDelegationId: string): Promise<void> {
  await withGateAdminFixture(async (client) => {
    await client.query(`
      UPDATE "ProjectGitRepositoryDelegation"
         SET "delegationFingerprint" = $1
       WHERE "id" = $2::uuid
    `, ["e".repeat(64), baseDelegationId]);
  });
}

test(
  "Git automation run ledger claims once, fences live grants, and keeps audit append-only",
  { skip: !shouldRun ? "PROJECT_GIT_AUTOMATION_RUN_LEDGER_POSTGRES_GATE=1 is required" : false },
  async () => {
    assertDisposableGateDatabase();
    const db = getDb();
    const workerDb = getGitAutomationWorkerDb();
    const inspectionDb = createInspectionDb();
    try {
      await assertRoleCannotExecuteFunction(process.env.DATABASE_URL, "RUNTIME");
      await assertRoleCannotExecuteFunction(process.env.ENTITLEMENT_DATABASE_URL, "ENTITLEMENT_WRITER");
      await assertRoleCannotUpdateLedger(process.env.ENTITLEMENT_DATABASE_URL, "ENTITLEMENT_WRITER");
      await assert.rejects(
        () => db.$queryRawUnsafe('SELECT public."project_git_automation_guard_project_delete"()'),
        /permission denied|42501/iu,
        "Web runtime can only reach the privileged project-deletion fence through its table trigger",
      );
      await assert.rejects(
        () => db.$queryRawUnsafe('SELECT "leaseToken" FROM public."ProjectGitRepositoryAutomationRun" LIMIT 0'),
        /permission denied|42501/iu,
        "Web runtime cannot read a Git automation lease token",
      );
      await assert.rejects(
        () => workerDb.$queryRawUnsafe('SELECT "leaseToken" FROM public."ProjectGitRepositoryAutomationRun" LIMIT 0'),
        /permission denied|42501/iu,
        "Git automation worker cannot read lease tokens outside the controlled claim function",
      );
      await assertWorkerMutationDenied(
        workerDb,
        "Run UPDATE",
        'UPDATE public."ProjectGitRepositoryAutomationRun" SET "status" = "status" WHERE FALSE',
      );
      await assert.rejects(
        () => claimNextProjectGitAutomationRun("runtime-service-call", db),
        /PROJECT_GIT_AUTOMATION_WORKER_DATABASE_REQUIRED/u,
        "the run service refuses to use the Web runtime client",
      );
      const competingGrant = await createActiveGrant();
      await assert.rejects(
        () => db.$queryRawUnsafe('SELECT public."project_git_automation_grant_invalidate"(NULL::uuid, NULL::uuid, NULL::uuid, \'direct_call\'::varchar)'),
        /PROJECT_GIT_AUTOMATION_INVALIDATION_REQUIRES_TRIGGER/u,
      );
      assert.equal((await db.projectGitRepositoryAutomationGrant.findUniqueOrThrow({ where: { id: competingGrant.grantId } })).status, "active");
      const expectedScheduledFor = await makeGrantDue(competingGrant.grantId);
      const [first, second] = await Promise.all([
        claimNextProjectGitAutomationRun("ledger-worker-a", workerDb),
        claimNextProjectGitAutomationRun("ledger-worker-b", workerDb),
      ]);
      const winningClaims = [first, second].filter((claim) => claim !== null);
      assert.equal(winningClaims.length, 1, "two workers must produce only one claim for the due interval");
      const claim = winningClaims[0];
      assert.ok(claim);
      assert.equal(claim.grantId, competingGrant.grantId);
      assert.equal(claim.scheduledFor, expectedScheduledFor.toISOString());
      assert.deepEqual(claim.scope, {
        repositoryPath: "org/automation-ledger",
        trackedRef: "main",
        includeRoots: ["."],
        softExcludePatterns: ["tmp/**"],
      });

      const [cursor, run, ledgerAudit] = await Promise.all([
        inspectionDb.projectGitRepositoryAutomationScheduleCursor.findUniqueOrThrow({ where: { grantId: competingGrant.grantId } }),
        inspectionDb.projectGitRepositoryAutomationRun.findUniqueOrThrow({ where: { id: claim.id } }),
        inspectionDb.projectGitRepositoryAutomationRunAudit.findMany({ where: { grantId: competingGrant.grantId }, orderBy: { createdAt: "asc" } }),
      ]);
      assert.equal(cursor.lastScheduledFor?.toISOString(), expectedScheduledFor.toISOString());
      assert.ok(cursor.nextRunAt.getTime() > Date.now() + 59 * 60_000);
      assert.equal(run.status, "pending");
      assert.equal(run.grantVersion, claim.grantVersion);
      assert.equal(run.baseDelegationId, competingGrant.baseDelegationId);
      assert.equal(ledgerAudit.filter((entry) => entry.action === "scheduleInitialized").length, 1);
      assert.equal(ledgerAudit.filter((entry) => entry.action === "scheduleAdvanced").length, 1);
      assert.equal(ledgerAudit.filter((entry) => entry.action === "runClaimed").length, 1);
      assert.equal(await db.projectGitRepositoryManualRun.count({ where: { projectId: competingGrant.projectId } }), 0);
      assert.equal(await db.projectGitRepositoryManualPointer.count({ where: { projectId: competingGrant.projectId } }), 0);
      await assertLedgerRuntimeDmlDenied(db, competingGrant.grantId);
      assert.equal(await claimNextProjectGitAutomationRun("same-interval-replay-worker", workerDb), null);
      assert.equal(await inspectionDb.projectGitRepositoryAutomationRun.count({ where: { grantId: competingGrant.grantId } }), 1);

      const rejectedHeartbeat = await heartbeatProjectGitAutomationRun(claim.id, "wrong-worker", claim.leaseToken, workerDb);
      assert.deepEqual(rejectedHeartbeat, { accepted: false, status: "pending" });
      const acceptedHeartbeat = await heartbeatProjectGitAutomationRun(claim.id, claim.workerId, claim.leaseToken, workerDb);
      assert.equal(acceptedHeartbeat?.accepted, true);
      assert.ok(acceptedHeartbeat?.leaseExpiresAt);
      assert.ok(new Date(acceptedHeartbeat.leaseExpiresAt).getTime() > new Date(claim.leaseExpiresAt).getTime());
      const dispatched = await markProjectGitAutomationRunDispatched(claim.id, claim.workerId, claim.leaseToken, workerDb);
      assert.equal(dispatched?.accepted, true);
      assert.equal(dispatched?.status, "dispatched");
      const duplicateDispatch = await markProjectGitAutomationRunDispatched(claim.id, claim.workerId, claim.leaseToken, workerDb);
      assert.deepEqual(duplicateDispatch, { accepted: false, status: "dispatched" });
      const dispatchedRow = await inspectionDb.projectGitRepositoryAutomationRun.findUniqueOrThrow({ where: { id: claim.id } });
      assert.equal(dispatchedRow.completedAt, null);
      assert.equal(dispatchedRow.status, "dispatched", "dispatched is not a successful publication result");

      await assertRuntimeMutationDenied(
        db,
        "audit UPDATE",
        `UPDATE public."ProjectGitRepositoryAutomationRunAudit"
             SET "reason" = 'forged'
           WHERE "grantId" = '${competingGrant.grantId}'::uuid`,
      );
      await assertRuntimeMutationDenied(
        db,
        "audit DELETE",
        `DELETE FROM public."ProjectGitRepositoryAutomationRunAudit"
           WHERE "grantId" = '${competingGrant.grantId}'::uuid`,
      );
      const pendingGrant = await createActiveGrant();
      await makeGrantDue(pendingGrant.grantId);
      const pendingClaim = await claimNextProjectGitAutomationRun("pending-expiry-worker", workerDb);
      assert.ok(pendingClaim);
      assert.equal(pendingClaim.grantId, pendingGrant.grantId);
      await expirePendingLease(pendingClaim.id);
      await claimNextProjectGitAutomationRun("pending-expiry-reaper", workerDb);
      const failedPending = await inspectionDb.projectGitRepositoryAutomationRun.findUniqueOrThrow({ where: { id: pendingClaim.id } });
      assert.equal(failedPending.status, "failed");
      assert.equal(failedPending.safeErrorCode, "LEASE_EXPIRED_BEFORE_DISPATCH");
      assert.equal(failedPending.dispatchedAt, null);

      const dispatchedGrant = await createActiveGrant();
      await makeGrantDue(dispatchedGrant.grantId);
      const dispatchedClaim = await claimNextProjectGitAutomationRun("dispatched-expiry-worker", workerDb);
      assert.ok(dispatchedClaim);
      assert.equal(dispatchedClaim.grantId, dispatchedGrant.grantId);
      assert.equal((await markProjectGitAutomationRunDispatched(dispatchedClaim.id, dispatchedClaim.workerId, dispatchedClaim.leaseToken, workerDb))?.accepted, true);
      await expirePendingLease(dispatchedClaim.id);
      await claimNextProjectGitAutomationRun("dispatched-expiry-reaper", workerDb);
      const unknownDispatched = await inspectionDb.projectGitRepositoryAutomationRun.findUniqueOrThrow({ where: { id: dispatchedClaim.id } });
      assert.equal(unknownDispatched.status, "unknown");
      assert.equal(unknownDispatched.safeErrorCode, "LEASE_EXPIRED_AFTER_DISPATCH");
      assert.ok(unknownDispatched.dispatchedAt);
      const unknownCursor = await inspectionDb.projectGitRepositoryAutomationScheduleCursor.findUniqueOrThrow({ where: { grantId: dispatchedGrant.grantId } });
      assert.equal(unknownCursor.status, "paused");
      assert.equal(unknownCursor.pauseReason, "run_outcome_unknown");
      assert.equal(await inspectionDb.projectGitRepositoryAutomationRun.count({ where: { grantId: dispatchedGrant.grantId } }), 1, "expired dispatched work must not be replayed");

      const revokedGrant = await createActiveGrant();
      await makeGrantDue(revokedGrant.grantId);
      const revokedClaim = await claimNextProjectGitAutomationRun("revoked-grant-worker", workerDb);
      assert.ok(revokedClaim);
      assert.equal(revokedClaim.grantId, revokedGrant.grantId);
      const grant = await db.projectGitRepositoryAutomationGrant.findUniqueOrThrow({ where: { id: revokedGrant.grantId } });
      await revokeProjectGitAutomationGrant(revokedGrant.projectId, revokedGrant.grantId, {
        expectedVersion: grant.version,
        reason: "automation ledger gate revocation",
      }, revokedGrant.connectionOwnerActor, db);
      const rejectedDispatch = await markProjectGitAutomationRunDispatched(revokedClaim.id, revokedClaim.workerId, revokedClaim.leaseToken, workerDb);
      assert.deepEqual(rejectedDispatch, { accepted: false, status: "failed" });
      const rejectedRevokedResult = await finalizeProjectGitAutomationRunResult({
        runId: revokedClaim.id,
        workerId: revokedClaim.workerId,
        leaseToken: revokedClaim.leaseToken,
        commitSha: "a".repeat(40),
        outcome: "changed",
        files: [{ path: "README.md", blobOid: "b".repeat(40), body: "revoked" }],
      }, workerDb);
      assert.equal(rejectedRevokedResult.accepted, false, "revocation must reject automatic publication finalization");
      assert.equal(await db.projectGitRepositoryPublicationVersion.count({ where: { projectId: revokedGrant.projectId, delegationId: revokedGrant.baseDelegationId } }), 0);
      const revokedCursor = await inspectionDb.projectGitRepositoryAutomationScheduleCursor.findUniqueOrThrow({ where: { grantId: revokedGrant.grantId } });
      assert.equal(revokedCursor.status, "paused");
      assert.equal(revokedCursor.pauseReason, "grant_revoked");
      assert.equal(await inspectionDb.projectGitRepositoryAutomationRun.count({ where: { grantId: revokedGrant.grantId } }), 1, "revocation must not admit another interval");

      const revokedDispatchedGrant = await createActiveGrant();
      await makeGrantDue(revokedDispatchedGrant.grantId);
      const revokedDispatchedClaim = await claimAndDispatch(revokedDispatchedGrant.grantId, "revoked-dispatched-worker");
      const revokedDispatchedSnapshot = await db.projectGitRepositoryAutomationGrant.findUniqueOrThrow({ where: { id: revokedDispatchedGrant.grantId } });
      await revokeProjectGitAutomationGrant(revokedDispatchedGrant.projectId, revokedDispatchedGrant.grantId, {
        expectedVersion: revokedDispatchedSnapshot.version,
        reason: "automation ledger dispatched revocation gate",
      }, revokedDispatchedGrant.connectionOwnerActor, db);
      const revokedDispatchedRun = await inspectionDb.projectGitRepositoryAutomationRun.findUniqueOrThrow({ where: { id: revokedDispatchedClaim.id } });
      assert.equal(revokedDispatchedRun.status, "unknown", "revocation after dispatch must not make an uncertain run replayable");
      assert.equal(revokedDispatchedRun.safeErrorCode, "GRANT_INELIGIBLE_AFTER_DISPATCH");
      const rejectedRevokedDispatchedResult = await finalizeProjectGitAutomationRunResult({
        runId: revokedDispatchedClaim.id,
        workerId: revokedDispatchedClaim.workerId,
        leaseToken: revokedDispatchedClaim.leaseToken,
        commitSha: "c".repeat(40),
        outcome: "changed",
        files: [{ path: "README.md", blobOid: "d".repeat(40), body: "revoked after dispatch" }],
      }, workerDb);
      assert.equal(rejectedRevokedDispatchedResult.accepted, false, "a revoked dispatched run cannot publish");
      assert.equal(rejectedRevokedDispatchedResult.status, "unknown");
      assert.equal(await db.projectGitRepositoryPublicationVersion.count({
        where: { projectId: revokedDispatchedGrant.projectId, delegationId: revokedDispatchedGrant.baseDelegationId },
      }), 0);
      const revokedDispatchedCursor = await inspectionDb.projectGitRepositoryAutomationScheduleCursor.findUniqueOrThrow({
        where: { grantId: revokedDispatchedGrant.grantId },
      });
      assert.equal(revokedDispatchedCursor.status, "paused");
      assert.equal(revokedDispatchedCursor.pauseReason, "grant_revoked");

      const revokeRaceGrant = await createActiveGrant();
      await makeGrantDue(revokeRaceGrant.grantId);
      const revokeRaceSnapshot = await db.projectGitRepositoryAutomationGrant.findUniqueOrThrow({ where: { id: revokeRaceGrant.grantId } });
      const [revokeRaceClaim] = await Promise.all([
        claimNextProjectGitAutomationRun("claim-revoke-race-worker", workerDb),
        revokeProjectGitAutomationGrant(revokeRaceGrant.projectId, revokeRaceGrant.grantId, {
          expectedVersion: revokeRaceSnapshot.version,
          reason: "automation ledger concurrent revocation gate",
        }, revokeRaceGrant.connectionOwnerActor, db),
      ]);
      assert.equal((await db.projectGitRepositoryAutomationGrant.findUniqueOrThrow({ where: { id: revokeRaceGrant.grantId } })).status, "revoked");
      const revokeRaceCursor = await inspectionDb.projectGitRepositoryAutomationScheduleCursor.findUniqueOrThrow({ where: { grantId: revokeRaceGrant.grantId } });
      assert.equal(revokeRaceCursor.status, "paused");
      assert.ok(["grant_revoked", "grant_not_active"].includes(revokeRaceCursor.pauseReason ?? ""));
      const revokeRaceRuns = await inspectionDb.projectGitRepositoryAutomationRun.findMany({ where: { grantId: revokeRaceGrant.grantId } });
      assert.ok(revokeRaceRuns.length <= 1);
      assert.ok(revokeRaceRuns.every((entry) => entry.status === "failed"));
      assert.equal(revokeRaceClaim?.grantId ?? null, revokeRaceRuns.length === 0 ? null : revokeRaceGrant.grantId);
      assert.equal(await claimNextProjectGitAutomationRun("claim-revoke-race-replay-worker", workerDb), null);

      const expiredGrant = await createActiveGrant();
      await expireGrantAfterProposal(expiredGrant.grantId);
      assert.equal(await claimNextProjectGitAutomationRun("expired-grant-worker", workerDb), null);
      assert.equal(await inspectionDb.projectGitRepositoryAutomationRun.count({ where: { grantId: expiredGrant.grantId } }), 0);
      const expiredCursor = await inspectionDb.projectGitRepositoryAutomationScheduleCursor.findUniqueOrThrow({ where: { grantId: expiredGrant.grantId } });
      assert.equal(expiredCursor.status, "paused");
      assert.equal(expiredCursor.pauseReason, "grant_expired");

      const driftedGrant = await createActiveGrant();
      await makeGrantDue(driftedGrant.grantId);
      await driftBaseDelegation(driftedGrant.baseDelegationId);
      assert.equal(await claimNextProjectGitAutomationRun("drifted-grant-worker", workerDb), null);
      assert.equal(await inspectionDb.projectGitRepositoryAutomationRun.count({ where: { grantId: driftedGrant.grantId } }), 0);
      const driftedCursor = await inspectionDb.projectGitRepositoryAutomationScheduleCursor.findUniqueOrThrow({ where: { grantId: driftedGrant.grantId } });
      assert.equal(driftedCursor.status, "paused");
      assert.equal(driftedCursor.pauseReason, "base_delegation_drift");

      const archivedGrant = await createActiveGrant();
      await makeGrantDue(archivedGrant.grantId);
      const archivedPendingClaim = await claimNextProjectGitAutomationRun("archive-cursor-init", workerDb);
      assert.ok(archivedPendingClaim);
      assert.equal(archivedPendingClaim.grantId, archivedGrant.grantId);
      await assert.rejects(
        () => db.$executeRawUnsafe('DELETE FROM public."Project" WHERE "id" = $1::uuid', archivedGrant.projectId),
        /PROJECT_GIT_AUTOMATION_PROJECT_DELETE_BLOCKED/u,
      );
      const projectBeforeArchive = await db.project.findUniqueOrThrow({ where: { id: archivedGrant.projectId }, select: { updatedAt: true } });
      await updateProjectLifecycle({
        projectId: archivedGrant.projectId,
        actor: archivedGrant.projectOwnerActor,
        action: "archive",
        expectedUpdatedAt: projectBeforeArchive.updatedAt,
      }, db);
      const archivedCursor = await inspectionDb.projectGitRepositoryAutomationScheduleCursor.findUniqueOrThrow({ where: { grantId: archivedGrant.grantId } });
      assert.equal(archivedCursor.status, "paused");
      assert.equal(archivedCursor.pauseReason, "project_archived");
      const archivedRun = await inspectionDb.projectGitRepositoryAutomationRun.findUniqueOrThrow({ where: { id: archivedPendingClaim.id } });
      assert.equal(archivedRun.status, "failed");
      assert.equal(archivedRun.safeErrorCode, "GRANT_INELIGIBLE_BEFORE_DISPATCH");
      assert.equal(await inspectionDb.projectGitRepositoryAutomationRun.count({ where: { grantId: archivedGrant.grantId } }), 1);
      assert.equal(await claimNextProjectGitAutomationRun("archived-grant-worker", workerDb), null);
      const auditCountBeforeDeletion = await inspectionDb.projectGitRepositoryAutomationRunAudit.count({ where: { grantId: archivedGrant.grantId } });
      const archivedProjectForDeletion = await db.project.findUniqueOrThrow({
        where: { id: archivedGrant.projectId },
        select: { name: true, updatedAt: true },
      });
      const deletionReceipt = await deleteArchivedProject({
        projectId: archivedGrant.projectId,
        actor: archivedGrant.projectOwnerActor,
        confirmationName: archivedProjectForDeletion.name,
        expectedUpdatedAt: archivedProjectForDeletion.updatedAt,
      }, db);
      assert.equal(deletionReceipt.projectId, archivedGrant.projectId);
      assert.equal(await db.project.count({ where: { id: archivedGrant.projectId } }), 0);
      assert.equal(await db.projectGitRepositoryAutomationGrant.count({ where: { id: archivedGrant.grantId } }), 0);
      assert.equal((await inspectionDb.projectGitRepositoryAutomationScheduleCursor.findUniqueOrThrow({ where: { grantId: archivedGrant.grantId } })).status, "paused");
      assert.equal((await inspectionDb.projectGitRepositoryAutomationRun.findUniqueOrThrow({ where: { id: archivedPendingClaim.id } })).status, "failed");
      assert.equal(await inspectionDb.projectGitRepositoryAutomationRunAudit.count({ where: { grantId: archivedGrant.grantId } }), auditCountBeforeDeletion);

      const archiveRaceGrant = await createActiveGrant();
      await makeGrantDue(archiveRaceGrant.grantId);
      const archiveRaceProject = await db.project.findUniqueOrThrow({ where: { id: archiveRaceGrant.projectId }, select: { updatedAt: true } });
      const [archiveRaceClaim] = await Promise.all([
        claimNextProjectGitAutomationRun("claim-archive-race-worker", workerDb),
        updateProjectLifecycle({
          projectId: archiveRaceGrant.projectId,
          actor: archiveRaceGrant.projectOwnerActor,
          action: "archive",
          expectedUpdatedAt: archiveRaceProject.updatedAt,
        }, db),
      ]);
      assert.ok((await db.project.findUniqueOrThrow({ where: { id: archiveRaceGrant.projectId } })).archivedAt);
      assert.equal((await db.projectGitRepositoryAutomationGrant.findUniqueOrThrow({ where: { id: archiveRaceGrant.grantId } })).status, "invalidated");
      const archiveRaceCursor = await inspectionDb.projectGitRepositoryAutomationScheduleCursor.findUniqueOrThrow({ where: { grantId: archiveRaceGrant.grantId } });
      assert.equal(archiveRaceCursor.status, "paused");
      assert.ok(["project_archived", "grant_not_active"].includes(archiveRaceCursor.pauseReason ?? ""));
      const archiveRaceRuns = await inspectionDb.projectGitRepositoryAutomationRun.findMany({ where: { grantId: archiveRaceGrant.grantId } });
      assert.ok(archiveRaceRuns.length <= 1);
      assert.ok(archiveRaceRuns.every((entry) => entry.status === "failed"));
      assert.equal(archiveRaceClaim?.grantId ?? null, archiveRaceRuns.length === 0 ? null : archiveRaceGrant.grantId);
      assert.equal(await claimNextProjectGitAutomationRun("claim-archive-race-replay-worker", workerDb), null);
    } finally {
      await db.$disconnect();
      await workerDb.$disconnect();
      await inspectionDb.$disconnect();
    }
  },
);

test(
  "automatic Git results atomically advance the shared head, retire cross-run sources, and reject stale or duplicate finalization",
  { skip: !shouldRun ? "PROJECT_GIT_AUTOMATION_RUN_LEDGER_POSTGRES_GATE=1 is required" : false },
  async () => {
    assertDisposableGateDatabase();
    const db = getDb();
    const workerDb = getGitAutomationWorkerDb();
    const inspectionDb = createInspectionDb();
    try {
      const fixture = await createActiveGrant();
      await makeGrantDue(fixture.grantId);
      const firstClaim = await claimNextProjectGitAutomationRun("shared-head-auto-first", workerDb);
      assert.ok(firstClaim);
      assert.equal(firstClaim.grantId, fixture.grantId);
      assert.deepEqual(await readExpectedPublicationCursor(inspectionDb, firstClaim.id), {
        expectedPublicationVersionId: null,
        expectedPublicationGeneration: 0,
      });
      assert.equal((await markProjectGitAutomationRunDispatched(firstClaim.id, firstClaim.workerId, firstClaim.leaseToken, workerDb))?.accepted, true);
      const firstCommit = "1".repeat(40);
      const firstResult = await finalizeProjectGitAutomationRunResult({
        runId: firstClaim.id,
        workerId: firstClaim.workerId,
        leaseToken: firstClaim.leaseToken,
        commitSha: firstCommit,
        outcome: "changed",
        files: [
          { path: "README.md", blobOid: "a".repeat(40), body: "automatic first version" },
          { path: "docs/guide.md", blobOid: "b".repeat(40), body: "automatic first guide" },
        ],
      }, workerDb);
      assert.equal(firstResult.accepted, true);
      assert.equal(firstResult.status, "succeeded");
      assert.equal(firstResult.publicationGeneration, 1);
      assert.ok(firstResult.publicationVersionId);
      const firstVersion = await db.projectGitRepositoryPublicationVersion.findUniqueOrThrow({ where: { id: firstResult.publicationVersionId } });
      assert.equal(firstVersion.runKind, "automatic");
      const firstEntries = await db.projectGitRepositoryPublicationEntry.findMany({
        where: { projectId: fixture.projectId, delegationId: fixture.baseDelegationId, publicationVersionId: firstVersion.id },
        include: { projectSource: { select: { contentText: true, retiredAt: true, sourceIdentity: true, revisionKey: true } } },
      });
      assert.equal(firstEntries.length, 2);
      assert.deepEqual(firstEntries.map((entry) => entry.projectSource.contentText).sort(), [
        `Repository: org/automation-ledger\nRevision: ${firstCommit}\nPath: README.md\n\nautomatic first version`,
        `Repository: org/automation-ledger\nRevision: ${firstCommit}\nPath: docs/guide.md\n\nautomatic first guide`,
      ].sort());
      assert.ok(firstEntries.every((entry) => entry.projectSource.retiredAt === null));
      const firstAudit = await inspectionDb.projectGitRepositoryAutomationRunAudit.findFirstOrThrow({ where: { runId: firstClaim.id, action: "runSucceeded" } });
      assert.equal(firstAudit.publicationVersionId, firstVersion.id);
      assert.equal(firstAudit.publicationGeneration, 1);
      assert.equal(firstAudit.expectedPublicationGeneration, 0);
      assert.equal(firstAudit.observedCommitSha?.trimEnd(), firstCommit);

      const staleClaim = await claimAndDispatch(fixture.grantId, "shared-head-auto-stale");
      assert.deepEqual(await readExpectedPublicationCursor(inspectionDb, staleClaim.id), {
        expectedPublicationVersionId: firstVersion.id,
        expectedPublicationGeneration: 1,
      });
      await assertDatabaseRejectsAutomationFiles(workerDb, staleClaim, [
        { path: "tmp/blocked.md", blobOid: "b".repeat(40), body: "excluded by delegation scope" },
      ]);
      await assertDatabaseRejectsAutomationFiles(workerDb, staleClaim, [
        { path: "README.md", blobOid: "b".repeat(40), body: "one" },
        { path: "README.md", blobOid: "c".repeat(40), body: "duplicate" },
      ]);
      await assertDatabaseRejectsAutomationFiles(workerDb, staleClaim, [
        { path: "README.md", blobOid: "B".repeat(40), body: "noncanonical oid" },
      ]);
      await assertDatabaseRejectsAutomationFiles(workerDb, staleClaim, [
        { path: "README.md", blobOid: "b".repeat(40), body: "bare\rcarriage return" },
      ]);
      await assertDatabaseRejectsAutomationFiles(workerDb, staleClaim, [
        { path: "README.md", blobOid: "b".repeat(40), body: "x".repeat(96 * 1024 + 1) },
      ]);
      const manualCommit = "2".repeat(40);
      const manualBridge = await seedSyntheticManualPublication({
        projectId: fixture.projectId,
        delegationId: fixture.baseDelegationId,
        previousVersionId: firstVersion.id,
        previousGeneration: 1,
        previousSourceCount: firstEntries.length,
        commitSha: manualCommit,
        body: "synthetic manual publication",
      });
      const firstRetiredAfterManual = await db.projectSource.findMany({ where: {
        projectId: fixture.projectId,
        id: { in: firstEntries.map((entry) => entry.projectSourceId) },
      }, select: { retiredAt: true } });
      assert.equal(firstRetiredAfterManual.length, firstEntries.length);
      assert.ok(firstRetiredAfterManual.every((source) => source.retiredAt), "manual publication must retire every prior automatic source");
      const staleResult = await finalizeProjectGitAutomationRunResult({
        runId: staleClaim.id,
        workerId: staleClaim.workerId,
        leaseToken: staleClaim.leaseToken,
        commitSha: "3".repeat(40),
        outcome: "changed",
        files: [{ path: "README.md", blobOid: "c".repeat(40), body: "stale auto result" }],
      }, workerDb);
      assert.deepEqual(staleResult, { accepted: false, status: "failed", reason: "PUBLICATION_HEAD_STALE" });
      const staleRun = await inspectionDb.projectGitRepositoryAutomationRun.findUniqueOrThrow({ where: { id: staleClaim.id } });
      assert.equal(staleRun.safeErrorCode, "PUBLICATION_HEAD_STALE");
      assert.equal(await db.projectGitRepositoryPublicationVersion.count({ where: { projectId: fixture.projectId, delegationId: fixture.baseDelegationId } }), 2,
        "a stale automatic run must not create a publication version");
      const manualHead = await db.projectGitRepositoryPublicationHead.findUniqueOrThrow({ where: {
        projectId_delegationId: { projectId: fixture.projectId, delegationId: fixture.baseDelegationId },
      } });
      assert.equal(manualHead.currentPublicationVersionId, manualBridge.versionId);
      assert.equal(manualHead.generation, 2);

      const thirdClaim = await claimAndDispatch(fixture.grantId, "shared-head-auto-after-manual");
      assert.deepEqual(await readExpectedPublicationCursor(inspectionDb, thirdClaim.id), {
        expectedPublicationVersionId: manualBridge.versionId,
        expectedPublicationGeneration: 2,
      });
      const thirdCommit = "3".repeat(40);
      const thirdResult = await finalizeProjectGitAutomationRunResult({
        runId: thirdClaim.id,
        workerId: thirdClaim.workerId,
        leaseToken: thirdClaim.leaseToken,
        commitSha: thirdCommit,
        outcome: "changed",
        files: [{ path: "README.md", blobOid: "e".repeat(40), body: "automatic after manual" }],
      }, workerDb);
      assert.equal(thirdResult.accepted, true);
      assert.equal(thirdResult.publicationGeneration, 3);
      const manualSourceAfterAutomatic = await db.projectSource.findUniqueOrThrow({ where: { projectId_id: {
        projectId: fixture.projectId,
        id: manualBridge.sourceId,
      } }, select: { retiredAt: true } });
      assert.ok(manualSourceAfterAutomatic.retiredAt, "automatic publication must retire every source from the prior manual head");
      const thirdEntries = await db.projectGitRepositoryPublicationEntry.findMany({
        where: { projectId: fixture.projectId, delegationId: fixture.baseDelegationId, publicationVersionId: thirdResult.publicationVersionId },
        include: { projectSource: { select: { contentText: true, retiredAt: true } } },
      });
      assert.equal(thirdEntries.length, 1);
      assert.equal(thirdEntries[0]?.projectSource.contentText,
        `Repository: org/automation-ledger\nRevision: ${thirdCommit}\nPath: README.md\n\nautomatic after manual`);
      assert.equal(thirdEntries[0]?.projectSource.retiredAt, null);

      const concurrentClaim = await claimAndDispatch(fixture.grantId, "shared-head-auto-concurrent");
      const concurrentInput = {
        runId: concurrentClaim.id,
        workerId: concurrentClaim.workerId,
        leaseToken: concurrentClaim.leaseToken,
        commitSha: "4".repeat(40),
        outcome: "changed" as const,
        files: [{ path: "README.md", blobOid: "f".repeat(40), body: "concurrent auto result" }],
      };
      const concurrentResults = await Promise.all([
        finalizeProjectGitAutomationRunResult(concurrentInput, workerDb),
        finalizeProjectGitAutomationRunResult(concurrentInput, workerDb),
      ]);
      assert.equal(concurrentResults.filter((result) => result.accepted).length, 1,
        "competing finalizers for one lease may publish only once");
      assert.equal(await db.projectGitRepositoryPublicationVersion.count({ where: { projectId: fixture.projectId, delegationId: fixture.baseDelegationId } }), 4);
      const concurrentHead = await db.projectGitRepositoryPublicationHead.findUniqueOrThrow({ where: {
        projectId_delegationId: { projectId: fixture.projectId, delegationId: fixture.baseDelegationId },
      } });
      assert.equal(concurrentHead.generation, 4);

      const unchangedClaim = await claimAndDispatch(fixture.grantId, "shared-head-auto-unchanged");
      assert.equal((await readExpectedPublicationCursor(inspectionDb, unchangedClaim.id)).expectedPublicationGeneration, 4);
      const unchangedSourcesBefore = await db.projectGitRepositoryPublicationEntry.findMany({
        where: { projectId: fixture.projectId, delegationId: fixture.baseDelegationId, publicationVersionId: concurrentHead.currentPublicationVersionId },
        select: { projectSourceId: true },
      });
      const unchanged = await finalizeProjectGitAutomationRunResult({
        runId: unchangedClaim.id,
        workerId: unchangedClaim.workerId,
        leaseToken: unchangedClaim.leaseToken,
        commitSha: "4".repeat(40),
        outcome: "unchanged",
        files: [],
      }, workerDb);
      assert.equal(unchanged.accepted, true);
      assert.equal(unchanged.status, "unchanged");
      assert.equal(unchanged.publicationVersionId, concurrentHead.currentPublicationVersionId);
      assert.equal(unchanged.publicationGeneration, concurrentHead.generation);
      assert.equal(await db.projectGitRepositoryPublicationVersion.count({ where: { projectId: fixture.projectId, delegationId: fixture.baseDelegationId } }), 4,
        "unchanged runs must not create versions");
      const headAfterUnchanged = await db.projectGitRepositoryPublicationHead.findUniqueOrThrow({ where: {
        projectId_delegationId: { projectId: fixture.projectId, delegationId: fixture.baseDelegationId },
      } });
      assert.equal(headAfterUnchanged.currentPublicationVersionId, concurrentHead.currentPublicationVersionId);
      assert.equal(headAfterUnchanged.generation, concurrentHead.generation);
      const unchangedSourcesAfter = await db.projectGitRepositoryPublicationEntry.findMany({
        where: { projectId: fixture.projectId, delegationId: fixture.baseDelegationId, publicationVersionId: concurrentHead.currentPublicationVersionId },
        select: { projectSourceId: true },
      });
      assert.deepEqual(unchangedSourcesAfter, unchangedSourcesBefore);
      const unchangedAudit = await inspectionDb.projectGitRepositoryAutomationRunAudit.findFirstOrThrow({ where: { runId: unchangedClaim.id, action: "runUnchanged" } });
      assert.equal(unchangedAudit.publicationVersionId, concurrentHead.currentPublicationVersionId);
      assert.equal(unchangedAudit.publicationGeneration, concurrentHead.generation);

      const returnClaim = await claimAndDispatch(fixture.grantId, "shared-head-auto-return");
      const returned = await finalizeProjectGitAutomationRunResult({
        runId: returnClaim.id,
        workerId: returnClaim.workerId,
        leaseToken: returnClaim.leaseToken,
        commitSha: firstCommit,
        outcome: "changed",
        files: [
          { path: "README.md", blobOid: "a".repeat(40), body: "automatic first version" },
          { path: "docs/guide.md", blobOid: "b".repeat(40), body: "automatic first guide" },
        ],
      }, workerDb);
      assert.equal(returned.accepted, true, "A→B→A must publish when the current head is B");
      assert.equal(returned.publicationGeneration, 5);
      assert.notEqual(returned.publicationVersionId, firstVersion.id);
      const returnEntries = await db.projectGitRepositoryPublicationEntry.findMany({
        where: { projectId: fixture.projectId, delegationId: fixture.baseDelegationId, publicationVersionId: returned.publicationVersionId },
        select: { projectSourceId: true },
      });
      assert.deepEqual(
        returnEntries.map((entry) => entry.projectSourceId).sort(),
        firstEntries.map((entry) => entry.projectSourceId).sort(),
        "returning to A reactivates its existing source rows",
      );
      const reactivatedSources = await db.projectSource.findMany({
        where: { projectId: fixture.projectId, id: { in: returnEntries.map((entry) => entry.projectSourceId) } },
        select: { retiredAt: true },
      });
      assert.ok(reactivatedSources.every((source) => source.retiredAt === null));
      const supersededSource = await db.projectSource.findUniqueOrThrow({
        where: { projectId_id: { projectId: fixture.projectId, id: unchangedSourcesAfter[0]!.projectSourceId } },
        select: { retiredAt: true },
      });
      assert.ok(supersededSource.retiredAt, "the superseded B source must be retired");
    } finally {
      await db.$disconnect();
      await workerDb.$disconnect();
      await inspectionDb.$disconnect();
    }
  },
);
