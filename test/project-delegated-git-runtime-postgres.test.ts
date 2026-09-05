import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { getDb } from "../src/lib/db";
import { grantProjectMembership, grantWorkspaceMembership } from "../src/lib/membership-governance";
import {
  confirmProjectGitRepositoryDelegationOwner,
  confirmProjectGitRepositoryDelegationProject,
  proposeProjectGitRepositoryDelegation,
} from "../src/lib/project-git-repository-delegation-service";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.PROJECT_DELEGATED_GIT_RUNTIME_POSTGRES_GATE === "1" && typeof databaseUrl === "string" && databaseUrl.length > 0;
const seededAdminId = "00000000-0000-4000-8000-000000000010";
const workspaceId = "00000000-0000-4000-8000-000000000001";
const testDatabaseName = "ai_project_os_project_delegated_git_runtime_test";

function assertDisposableGateDatabase(): void {
  if (typeof databaseUrl !== "string" || databaseUrl.length === 0) throw new Error("PROJECT_DELEGATED_GIT_RUNTIME_TEST_DATABASE_URL_REQUIRED");
  const parsed = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase())
    || parsed.port !== '56432'
    || parsed.pathname !== `/${testDatabaseName}`
    || parsed.username !== 'ai_project_os_gate'
    || parsed.password.length === 0
    || parsed.search !== ''
    || parsed.hash !== '') {
    throw new Error('PROJECT_DELEGATED_GIT_RUNTIME_TEST_DATABASE_URL_INVALID');
  }
}

test("manual delegated Git runtime migration installs independent guarded tables", { skip: !enabled }, async () => {
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  assertDisposableGateDatabase();
  await client.connect();
  try {
    const tables = await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'ProjectGitRepositoryManualRun',
          'ProjectGitRepositoryManualRunEntry',
          'ProjectGitRepositoryManualPointer',
          'ProjectGitRepositoryManualRunAudit'
        )
      ORDER BY table_name
    `);
    assert.deepEqual(tables.rows.map((row) => row.table_name), [
      "ProjectGitRepositoryManualPointer",
      "ProjectGitRepositoryManualRun",
      "ProjectGitRepositoryManualRunAudit",
      "ProjectGitRepositoryManualRunEntry",
    ]);

    const indexes = await client.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'ProjectGitRepositoryManualRun_live_delegation_key'
    `);
    assert.equal(indexes.rowCount, 1);

    const triggers = await client.query<{ tgname: string }>(`
      SELECT DISTINCT trigger_name AS tgname
      FROM information_schema.triggers
      WHERE event_object_schema = 'public'
        AND event_object_table = 'ProjectGitRepositoryManualRun'
        AND trigger_name IN ('ProjectGitRepositoryManualRun_live_guard', 'ProjectGitRepositoryManualRun_shape_guard')
      ORDER BY trigger_name
    `);
    assert.deepEqual(triggers.rows.map((row) => row.tgname), [
      "ProjectGitRepositoryManualRun_live_guard",
      "ProjectGitRepositoryManualRun_shape_guard",
    ]);

    const transitionTrigger = await client.query<{ deferrable: boolean; initially_deferred: boolean }>(`
      SELECT t.tgdeferrable AS deferrable, t.tginitdeferred AS initially_deferred
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'ProjectGitRepositoryManualRun'
        AND t.tgname = 'ProjectGitRepositoryManualRun_transition_audit_guard'
    `);
    assert.deepEqual(transitionTrigger.rows, [{ deferrable: true, initially_deferred: true }]);

    const successGuard = await client.query<{ definition: string }>({
      text: `SELECT pg_get_functiondef('project_git_manual_runtime_success_guard'::regproc) AS definition`,
    });
    assert.match(
      successGuard.rows[0]?.definition ?? "",
      /pg_advisory_xact_lock\(hashtextextended\('ai-project-git-repository-delegation-global', 0\)\)/u,
    );

    const legacyFlag = await client.query<{ value: string }>({
      text: `SELECT pg_get_functiondef('project_git_manual_runtime_live_guard'::regproc) AS value`,
    });
    assert.match(legacyFlag.rows[0]?.value ?? "", /manualSyncAllowed/u);
  } finally {
    await client.end();
  }
});

test("manual delegated Git runtime keeps staged publication and stale runs auditable", { skip: !enabled }, async () => {
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  assertDisposableGateDatabase();
  await client.connect();
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const connectionOwnerId = randomUUID();
  const projectOwnerId = randomUUID();
  const projectId = randomUUID();
  const connectionId = randomUUID();
  const credentialId = randomUUID();
  const addressFingerprint = "b".repeat(64);
  const credentialFingerprint = "a".repeat(64);
  const now = new Date();

  const insertAudit = async (input: {
    runId: string;
    projectId: string;
    delegationId: string;
    action: string;
    statusBefore: string | null;
    statusAfter: string;
    dispatchState: string;
    actorId: string | null;
    commitSha: string | null;
    manifestFingerprint: string | null;
    reason: string;
    runEvidence: {
      requestedById: string;
      requestedByProjectMembershipId: string;
      requestedByMembershipCreatedAt: Date;
      connectionOwnerId: string;
      ownerProjectMembershipId: string;
      ownerMembershipCreatedAt: Date;
      projectConfirmedById: string;
      projectConfirmedProjectMembershipId: string;
      projectConfirmedMembershipCreatedAt: Date;
      delegationVersion: number;
      delegationFingerprint: string;
      connectionConfigurationVersion: number;
      resolvedAddressFingerprint: string;
      credentialFingerprint: string;
      role: string;
      requiredForProjectSnapshot: boolean;
      codeEnabled: boolean;
      metadataEnabled: boolean;
      manualSyncAllowed: boolean;
      automationAllowed: boolean;
    };
  }): Promise<void> => {
    const evidence = input.runEvidence;
    await client.query(
      `INSERT INTO "ProjectGitRepositoryManualRunAudit" (
        "id", "runId", "projectId", "delegationId", "action", "statusBefore", "statusAfter", "dispatchState", "actorId",
        "requestedById", "requestedByProjectMembershipId", "requestedByMembershipCreatedAt", "connectionOwnerId",
        "ownerProjectMembershipId", "ownerMembershipCreatedAt", "projectConfirmedById", "projectConfirmedProjectMembershipId",
        "projectConfirmedMembershipCreatedAt", "reason", "delegationVersion", "delegationFingerprint",
        "connectionConfigurationVersion", "resolvedAddressFingerprint", "credentialFingerprint", "role",
        "requiredForProjectSnapshot", "codeEnabled", "metadataEnabled", "manualSyncAllowed", "automationAllowed",
        "commitSha", "manifestFingerprint"
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"ProjectGitRepositoryManualRunAuditAction",
        $6::"ProjectGitRepositoryManualRunStatus", $7::"ProjectGitRepositoryManualRunStatus",
        $8::"ProjectGitRepositoryManualRunDispatchState", $9::uuid, $10::uuid, $11::uuid,
        COALESCE((SELECT "requestedByMembershipCreatedAt" FROM "ProjectGitRepositoryManualRun" WHERE "id" = $2::uuid), $12::timestamp(3)),
        $13::uuid, $14::uuid,
        COALESCE((SELECT "ownerMembershipCreatedAt" FROM "ProjectGitRepositoryManualRun" WHERE "id" = $2::uuid), $15::timestamp(3)),
        $16::uuid, $17::uuid,
        COALESCE((SELECT "projectConfirmedMembershipCreatedAt" FROM "ProjectGitRepositoryManualRun" WHERE "id" = $2::uuid), $18::timestamp(3)), $19,
        $20, $21, $22, $23, $24, $25::"ProjectRepositoryRole", $26, $27, $28, $29, $30, $31, $32
      )`,
      [
        randomUUID(),
        input.runId,
        input.projectId,
        input.delegationId,
        input.action,
        input.statusBefore,
        input.statusAfter,
        input.dispatchState,
        input.actorId,
        evidence.requestedById,
        evidence.requestedByProjectMembershipId,
        evidence.requestedByMembershipCreatedAt,
        evidence.connectionOwnerId,
        evidence.ownerProjectMembershipId,
        evidence.ownerMembershipCreatedAt,
        evidence.projectConfirmedById,
        evidence.projectConfirmedProjectMembershipId,
        evidence.projectConfirmedMembershipCreatedAt,
        input.reason,
        evidence.delegationVersion,
        evidence.delegationFingerprint,
        evidence.connectionConfigurationVersion,
        evidence.resolvedAddressFingerprint,
        evidence.credentialFingerprint,
        evidence.role,
        evidence.requiredForProjectSnapshot,
        evidence.codeEnabled,
        evidence.metadataEnabled,
        evidence.manualSyncAllowed,
        evidence.automationAllowed,
        input.commitSha,
        input.manifestFingerprint,
      ],
    );
  };

  try {
    await db.appUser.createMany({
      data: [
        { id: connectionOwnerId, username: `manual_runtime_owner_${suffix}`, role: "user" },
        { id: projectOwnerId, username: `manual_runtime_project_owner_${suffix}`, role: "user" },
      ],
    });
    await db.project.create({ data: { id: projectId, workspaceId, name: `Manual runtime ${suffix}`, slug: `manual-runtime-${suffix}` } });
    await db.$transaction(async (tx) => {
      await grantWorkspaceMembership(tx, { workspaceId, userId: connectionOwnerId, role: "member", actorId: seededAdminId, reason: "manual_runtime_gate_owner" });
      await grantWorkspaceMembership(tx, { workspaceId, userId: projectOwnerId, role: "member", actorId: seededAdminId, reason: "manual_runtime_gate_project_owner" });
      await grantProjectMembership(tx, { projectId, workspaceId, userId: connectionOwnerId, role: "editor", actorId: seededAdminId, reason: "manual_runtime_gate_connection_owner" });
      await grantProjectMembership(tx, { projectId, workspaceId, userId: projectOwnerId, role: "owner", actorId: seededAdminId, reason: "manual_runtime_gate_project_owner" });
    });
    const ownerMembership = await db.projectMembership.findFirstOrThrow({ where: { projectId, userId: connectionOwnerId }, select: { id: true, createdAt: true } });
    const projectOwnerMembership = await db.projectMembership.findFirstOrThrow({ where: { projectId, userId: projectOwnerId }, select: { id: true, createdAt: true } });
    await db.externalCredential.create({ data: { id: credentialId, kind: "git", ciphertext: Buffer.from([1]), nonce: Buffer.from([2]), authTag: Buffer.from([3]), maskedSuffix: "gate", secretFingerprint: credentialFingerprint } });
    await db.gitConnection.create({
      data: {
        id: connectionId,
        name: `Manual runtime Git ${suffix}`,
        providerKind: "github",
        transport: "https",
        baseUrl: "https://github.com",
        authKind: "token",
        status: "verified",
        ownershipState: "confirmed",
        resolvedAddressFingerprint: addressFingerprint,
        createdById: connectionOwnerId,
        ownerUserId: connectionOwnerId,
        credentialId,
      },
    });
    const draft = await proposeProjectGitRepositoryDelegation(projectId, {
      gitConnectionId: connectionId,
      repositoryPath: "org/manual-runtime",
      trackedRef: "main",
      includeRoots: ["."],
      softExcludePatterns: [],
      role: "primary",
      expiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
    }, { id: connectionOwnerId, role: "user" }, db);
    const ownerConfirmed = await confirmProjectGitRepositoryDelegationOwner(projectId, draft.id, {
      expectedVersion: draft.version,
      acknowledgeReadOnlyCredentialUse: true,
    }, { id: connectionOwnerId, role: "user" }, db);
    const active = await confirmProjectGitRepositoryDelegationProject(projectId, draft.id, {
      expectedVersion: ownerConfirmed.version,
      acknowledgeRepositoryScope: true,
      acknowledgeDataEgress: true,
    }, { id: projectOwnerId, role: "user" }, db);
    const delegation = await db.projectGitRepositoryDelegation.findUniqueOrThrow({ where: { id: active.id } });
    const runEvidence = {
      requestedById: connectionOwnerId,
      requestedByProjectMembershipId: ownerMembership.id,
      requestedByMembershipCreatedAt: ownerMembership.createdAt,
      connectionOwnerId,
      ownerProjectMembershipId: ownerMembership.id,
      ownerMembershipCreatedAt: delegation.ownerMembershipCreatedAt,
      projectConfirmedById: projectOwnerId,
      projectConfirmedProjectMembershipId: projectOwnerMembership.id,
      projectConfirmedMembershipCreatedAt: delegation.projectConfirmedMembershipCreatedAt!,
      delegationVersion: delegation.version,
      delegationFingerprint: delegation.delegationFingerprint,
      connectionConfigurationVersion: delegation.connectionConfigurationVersion,
      resolvedAddressFingerprint: delegation.resolvedAddressFingerprint,
      credentialFingerprint: delegation.credentialFingerprint,
      role: delegation.role,
      requiredForProjectSnapshot: delegation.requiredForProjectSnapshot,
      codeEnabled: delegation.codeEnabled,
      metadataEnabled: delegation.metadataEnabled,
      manualSyncAllowed: delegation.manualSyncAllowed,
      automationAllowed: delegation.automationAllowed,
    };
    const createRun = async (runId: string, key: string, startedAt: Date | null | "database-current" | "database-stale"): Promise<void> => {
      await client.query("BEGIN");
      try {
        await client.query(`SELECT set_config('ai.project_git_manual_runtime_audit', '1', true)`);
        await client.query(
          `INSERT INTO "ProjectGitRepositoryManualRun" (
            "id", "projectId", "delegationId", "requestedById", "requestedByProjectMembershipId", "requestedByMembershipCreatedAt",
            "clientRequestKey", "delegationVersion", "delegationFingerprint", "connectionOwnerId", "ownerProjectMembershipId",
            "ownerMembershipCreatedAt", "projectConfirmedById", "projectConfirmedProjectMembershipId", "projectConfirmedMembershipCreatedAt",
            "connectionConfigurationVersion", "resolvedAddressFingerprint", "credentialFingerprint", "repositoryPath", "trackedRef",
            "includeRoots", "softExcludePatterns", "role", "requiredForProjectSnapshot", "codeEnabled", "metadataEnabled",
            "manualSyncAllowed", "automationAllowed"
          ) VALUES (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
            COALESCE((SELECT "createdAt" FROM "ProjectMembership" WHERE "id" = $5::uuid), $6::timestamp(3)),
            $7::uuid, $8, $9, $10::uuid, $11::uuid,
            COALESCE((SELECT "ownerMembershipCreatedAt" FROM "ProjectGitRepositoryDelegation" WHERE "id" = $3::uuid), $12::timestamp(3)),
            $13::uuid, $14::uuid,
            COALESCE((SELECT "projectConfirmedMembershipCreatedAt" FROM "ProjectGitRepositoryDelegation" WHERE "id" = $3::uuid), $15::timestamp(3)),
            $16, $17, $18, $19, $20,
            $21::jsonb, $22::jsonb, $23::"ProjectRepositoryRole", $24, $25, $26, $27, $28
          )`,
          [
            runId,
            projectId,
            delegation.id,
            runEvidence.requestedById,
            runEvidence.requestedByProjectMembershipId,
            runEvidence.requestedByMembershipCreatedAt,
            key,
            runEvidence.delegationVersion,
            runEvidence.delegationFingerprint,
            runEvidence.connectionOwnerId,
            runEvidence.ownerProjectMembershipId,
            runEvidence.ownerMembershipCreatedAt,
            runEvidence.projectConfirmedById,
            runEvidence.projectConfirmedProjectMembershipId,
            runEvidence.projectConfirmedMembershipCreatedAt,
            runEvidence.connectionConfigurationVersion,
            runEvidence.resolvedAddressFingerprint,
            runEvidence.credentialFingerprint,
            delegation.repositoryPath,
            delegation.trackedRef,
            JSON.stringify(delegation.includeRoots),
            JSON.stringify(delegation.softExcludePatterns),
            runEvidence.role,
            runEvidence.requiredForProjectSnapshot,
            runEvidence.codeEnabled,
            runEvidence.metadataEnabled,
            runEvidence.manualSyncAllowed,
            runEvidence.automationAllowed,
          ],
        );
        await insertAudit({ runId, projectId, delegationId: delegation.id, action: "requested", statusBefore: null, statusAfter: "queued", dispatchState: "pending", actorId: connectionOwnerId, commitSha: null, manifestFingerprint: null, reason: "manual_runtime_gate_requested", runEvidence });
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      if (startedAt === null) return;
      await client.query("BEGIN");
      try {
        await client.query(`SELECT set_config('ai.project_git_manual_runtime_audit', '1', true)`);
        if (startedAt === "database-stale" || startedAt === "database-current") {
          const timestampExpression = startedAt === "database-stale" ? "clock_timestamp() - interval '10 minutes'" : "clock_timestamp()";
          await client.query(`UPDATE "ProjectGitRepositoryManualRun" SET "status" = 'running', "stage" = 'fetching', "dispatchState" = 'dispatched', "startedAt" = ${timestampExpression} WHERE "id" = $1::uuid`, [runId]);
        } else {
          await client.query(`UPDATE "ProjectGitRepositoryManualRun" SET "status" = 'running', "stage" = 'fetching', "dispatchState" = 'dispatched', "startedAt" = $2::timestamptz(3) WHERE "id" = $1::uuid`, [runId, startedAt]);
        }
        await insertAudit({ runId, projectId, delegationId: delegation.id, action: "admitted", statusBefore: "queued", statusAfter: "running", dispatchState: "dispatched", actorId: connectionOwnerId, commitSha: null, manifestFingerprint: null, reason: "manual_runtime_gate_admitted", runEvidence });
        await insertAudit({ runId, projectId, delegationId: delegation.id, action: "dispatched", statusBefore: "queued", statusAfter: "running", dispatchState: "dispatched", actorId: connectionOwnerId, commitSha: null, manifestFingerprint: null, reason: "manual_runtime_gate_dispatched", runEvidence });
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    };

    const runId = randomUUID();
    const clientRequestKey = randomUUID();
    await createRun(runId, clientRequestKey, new Date());
    await client.query("UPDATE \"ProjectGitRepositoryManualRun\" SET \"stage\" = 'validating' WHERE \"id\" = $1::uuid", [runId]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("UPDATE \"ProjectGitRepositoryManualRun\" SET \"stage\" = 'publishing' WHERE \"id\" = $1::uuid", [runId]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    const sourceId = randomUUID();
    const contentText = "# manual runtime";
    const contentBytes = Buffer.byteLength(contentText, "utf8");
    const contentHash = createHash("sha256").update(contentText, "utf8").digest("hex");
    await db.projectSource.create({
      data: {
        id: sourceId,
        projectId,
        kind: "git",
        originScope: "project",
        projectRepositoryLinkId: null,
        sourceIdentity: randomUUID(),
        revisionKey: randomUUID(),
        externalRef: null,
        contentText,
        contentHash,
        capturedAt: new Date(),
      },
    });
    let sourceHashError: unknown;
    try {
      await client.query(
        `INSERT INTO "ProjectGitRepositoryManualRunEntry" (
          "id", "projectId", "runId", "delegationId", "delegationVersion", "delegationFingerprint", "projectSourceId",
          "ordinal", "normalizedPath", "blobOid", "contentHash", "contentBytes", "lineCount"
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::uuid, 1, 'MISMATCH.md', 'd', $8, $9, 1)`,
        [randomUUID(), projectId, runId, delegation.id, delegation.version, delegation.delegationFingerprint, sourceId, "0".repeat(64), contentBytes],
      );
    } catch (error) {
      sourceHashError = error;
    }
    assert.match(String(sourceHashError), /PROJECT_GIT_MANUAL_SOURCE_INVALID/u);
    await client.query(
      `INSERT INTO "ProjectGitRepositoryManualRunEntry" (
        "id", "projectId", "runId", "delegationId", "delegationVersion", "delegationFingerprint", "projectSourceId",
        "ordinal", "normalizedPath", "blobOid", "contentHash", "contentBytes", "lineCount"
        ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::uuid, 0, 'README.md', 'd', $8, $9, 1)`,
      [randomUUID(), projectId, runId, delegation.id, delegation.version, delegation.delegationFingerprint, sourceId, contentHash, contentBytes],
    );
    const commitSha = "e".repeat(40);
    const manifestResult = await client.query<{ manifest: string }>(`SELECT "project_git_manual_runtime_manifest"($1::uuid) AS manifest`, [runId]);
    const manifest = manifestResult.rows[0]!.manifest;
    await client.query("BEGIN");
    try {
      await client.query(`SELECT set_config('ai.project_git_manual_runtime_audit', '1', true)`);
      await client.query(`UPDATE "ProjectGitRepositoryManualRun" SET "status" = 'succeeded', "stage" = 'terminal', "dispatchState" = 'acknowledged', "frozenCommitSha" = $2, "manifestFingerprint" = $3, "fileCount" = 1, "decodedTextBytes" = $4::integer, "result" = jsonb_build_object('fileCount', 1, 'decodedTextBytes', $4::integer), "completedAt" = clock_timestamp() WHERE "id" = $1::uuid`, [runId, commitSha, manifest, contentBytes]);
      await client.query(
        `INSERT INTO "ProjectGitRepositoryManualPointer" ("projectId", "delegationId", "runId", "delegationVersion", "delegationFingerprint", "frozenCommitSha", "manifestFingerprint", "publishedAt") VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, (SELECT "completedAt" FROM "ProjectGitRepositoryManualRun" WHERE "id" = $3::uuid))`,
        [projectId, delegation.id, runId, delegation.version, delegation.delegationFingerprint, commitSha, manifest],
      );
      await insertAudit({ runId, projectId, delegationId: delegation.id, action: "succeeded", statusBefore: "running", statusAfter: "succeeded", dispatchState: "acknowledged", actorId: connectionOwnerId, commitSha, manifestFingerprint: manifest, reason: "manual_runtime_gate_published", runEvidence });
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    const sourceCountBeforeDelete = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM "ProjectSource" WHERE "projectId" = $1::uuid AND "id" = $2::uuid`, [projectId, sourceId]);
    let sourceDeleteError: unknown;
    try {
      await client.query(`DELETE FROM "ProjectSource" WHERE "projectId" = $1::uuid AND "id" = $2::uuid`, [projectId, sourceId]);
    } catch (error) {
      sourceDeleteError = error;
    }
    assert.match(String(sourceDeleteError), /23503|ProjectGitRepositoryManualRunEntry_source_fkey/u);
    const sourceCountAfterDelete = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM "ProjectSource" WHERE "projectId" = $1::uuid AND "id" = $2::uuid`, [projectId, sourceId]);
    assert.equal(sourceCountAfterDelete.rows[0]?.count, sourceCountBeforeDelete.rows[0]?.count);
    let pointerTimeError: unknown;
    try {
      await client.query(`UPDATE "ProjectGitRepositoryManualPointer" SET "publishedAt" = '2000-01-01T00:00:00Z' WHERE "projectId" = $1::uuid AND "delegationId" = $2::uuid`, [projectId, delegation.id]);
    } catch (error) {
      pointerTimeError = error;
    }
    assert.match(String(pointerTimeError), /PROJECT_GIT_MANUAL_POINTER_TIME_INVALID/u);
    let entryUpdateError: unknown;
    try {
      await client.query(`UPDATE "ProjectGitRepositoryManualRunEntry" SET "contentBytes" = 18 WHERE "runId" = $1::uuid`, [runId]);
    } catch (error) {
      entryUpdateError = error;
    }
    assert.match(String(entryUpdateError), /PROJECT_GIT_MANUAL_RUN_ENTRY_ADMISSION_INVALID/u);
    let entryDeleteError: unknown;
    try {
      await client.query(`DELETE FROM "ProjectGitRepositoryManualRunEntry" WHERE "runId" = $1::uuid`, [runId]);
    } catch (error) {
      entryDeleteError = error;
    }
    assert.match(String(entryDeleteError), /PROJECT_GIT_MANUAL_RUN_ENTRY_DELETE_FORBIDDEN/u);
    let pointerDeleteError: unknown;
    try {
      await client.query(`DELETE FROM "ProjectGitRepositoryManualPointer" WHERE "projectId" = $1::uuid AND "delegationId" = $2::uuid`, [projectId, delegation.id]);
    } catch (error) {
      pointerDeleteError = error;
    }
    assert.match(String(pointerDeleteError), /PROJECT_GIT_MANUAL_POINTER_DELETE_FORBIDDEN/u);
    let runDeleteError: unknown;
    try {
      await client.query(`DELETE FROM "ProjectGitRepositoryManualRun" WHERE "id" = $1::uuid`, [runId]);
    } catch (error) {
      runDeleteError = error;
    }
    assert.match(String(runDeleteError), /PROJECT_GIT_MANUAL_RUN_DELETE_FORBIDDEN/u);
    const published = await client.query<{ entries: string; audits: string; pointers: string }>(
      `SELECT
        (SELECT count(*)::text FROM "ProjectGitRepositoryManualRunEntry" WHERE "runId" = $1::uuid) AS entries,
        (SELECT count(*)::text FROM "ProjectGitRepositoryManualRunAudit" WHERE "runId" = $1::uuid) AS audits,
        (SELECT count(*)::text FROM "ProjectGitRepositoryManualPointer" WHERE "runId" = $1::uuid) AS pointers`,
      [runId],
    );
    assert.deepEqual(published.rows[0], { entries: "1", audits: "4", pointers: "1" });

    const staleRunId = randomUUID();
    const staleKey = randomUUID();
    await createRun(staleRunId, staleKey, "database-stale");
    await client.query("BEGIN");
    let auditSkipError: unknown;
    try {
      await client.query(`UPDATE "ProjectGitRepositoryManualRun" SET "status" = 'failed', "stage" = 'terminal', "dispatchState" = 'acknowledged', "failureCode" = 'MANUAL_RUNTIME_TEST', "completedAt" = clock_timestamp() WHERE "id" = $1::uuid`, [staleRunId]);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    } catch (error) {
      auditSkipError = error;
    } finally {
      await client.query("ROLLBACK");
    }
    assert.match(String(auditSkipError), /PROJECT_GIT_MANUAL_RUN_TRANSITION_AUDIT_REQUIRED/u);

    const staleTiming = await client.query<{ startedAt: Date; now: Date; stale: boolean }>(
      `SELECT "startedAt", clock_timestamp() AS now, ("startedAt" IS NULL OR "startedAt" <= clock_timestamp() - (300000 * interval '1 millisecond')) AS stale FROM "ProjectGitRepositoryManualRun" WHERE "id" = $1::uuid`,
      [staleRunId],
    );
    assert.equal(staleTiming.rowCount, 1);
    assert.equal(staleTiming.rows[0]!.stale, true);

    const { runProjectDelegatedGitManualSync } = await import("../src/lib/project-delegated-git-runtime-service");
    const stale = await runProjectDelegatedGitManualSync({
      projectId,
      delegationId: delegation.id,
      request: { clientRequestKey: staleKey },
      actor: { id: connectionOwnerId, role: "user" },
    }, db);
    assert.equal(stale.status, "unknown");
    assert.equal(stale.failureCode, "PROJECT_GIT_MANUAL_RUN_STALE");
    const replay = await runProjectDelegatedGitManualSync({
      projectId,
      delegationId: delegation.id,
      request: { clientRequestKey: staleKey },
      actor: { id: connectionOwnerId, role: "user" },
    }, db);
    assert.equal(replay.status, "unknown");
    assert.equal(await db.projectGitRepositoryManualRunAudit.count({ where: { runId: staleRunId, action: "unknown" } }), 1);
    await assert.rejects(
      () => runProjectDelegatedGitManualSync({
        projectId,
        delegationId: delegation.id,
        request: { clientRequestKey: staleKey },
        actor: { id: projectOwnerId, role: "user" },
      }, db),
      (error: unknown) => error instanceof Error && error.message === "PROJECT_GIT_MANUAL_FORBIDDEN",
    );
    assert.equal(await db.projectGitRepositoryManualRunAudit.count({ where: { runId: staleRunId, action: "unknown" } }), 1);

    const guardRunId = randomUUID();
    await createRun(guardRunId, randomUUID(), "database-current");
    await client.query(`UPDATE "ProjectGitRepositoryManualRun" SET "stage" = 'validating' WHERE "id" = $1::uuid`, [guardRunId]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query(`UPDATE "ProjectGitRepositoryManualRun" SET "stage" = 'publishing' WHERE "id" = $1::uuid`, [guardRunId]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    const guardSourceId = randomUUID();
    const guardContent = "guarded publication";
    const guardHash = createHash("sha256").update(guardContent, "utf8").digest("hex");
    await db.projectSource.create({
      data: {
        id: guardSourceId,
        projectId,
        kind: "git",
        originScope: "project",
        projectRepositoryLinkId: null,
        sourceIdentity: randomUUID(),
        revisionKey: randomUUID(),
        externalRef: null,
        contentText: guardContent,
        contentHash: guardHash,
        capturedAt: new Date(),
      },
    });
    const guardBytes = Buffer.byteLength(guardContent, "utf8");
    await client.query(
      `INSERT INTO "ProjectGitRepositoryManualRunEntry" (
        "id", "projectId", "runId", "delegationId", "delegationVersion", "delegationFingerprint", "projectSourceId",
        "ordinal", "normalizedPath", "blobOid", "contentHash", "contentBytes", "lineCount"
      ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::uuid, 0, 'GUARD.md', 'd', $8, $9, 1)`,
      [randomUUID(), projectId, guardRunId, delegation.id, delegation.version, delegation.delegationFingerprint, guardSourceId, guardHash, guardBytes],
    );
    const guardCommit = "c".repeat(40);
    const guardManifestResult = await client.query<{ manifest: string }>(`SELECT "project_git_manual_runtime_manifest"($1::uuid) AS manifest`, [guardRunId]);
    const guardManifest = guardManifestResult.rows[0]!.manifest;
    let missingPointerError: unknown;
    await client.query("BEGIN");
    try {
      await client.query(`SELECT set_config('ai.project_git_manual_runtime_audit', '1', true)`);
      await client.query(`UPDATE "ProjectGitRepositoryManualRun" SET "status" = 'succeeded', "stage" = 'terminal', "dispatchState" = 'acknowledged', "frozenCommitSha" = $2, "manifestFingerprint" = $3, "fileCount" = 1, "decodedTextBytes" = $4::integer, "result" = jsonb_build_object('fileCount', 1, 'decodedTextBytes', $4::integer), "completedAt" = clock_timestamp() WHERE "id" = $1::uuid`, [guardRunId, guardCommit, guardManifest, guardBytes]);
      await insertAudit({ runId: guardRunId, projectId, delegationId: delegation.id, action: "succeeded", statusBefore: "running", statusAfter: "succeeded", dispatchState: "acknowledged", actorId: connectionOwnerId, commitSha: guardCommit, manifestFingerprint: guardManifest, reason: "manual_runtime_gate_missing_pointer", runEvidence });
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    } catch (error) {
      missingPointerError = error;
    } finally {
      await client.query("ROLLBACK");
    }
    assert.match(String(missingPointerError), /PROJECT_GIT_MANUAL_SUCCESS_POINTER_INVALID/u);
    await client.query("BEGIN");
    try {
      await client.query(`SELECT set_config('ai.project_git_manual_runtime_audit', '1', true)`);
      await client.query(`UPDATE "ProjectGitRepositoryManualRun" SET "status" = 'failed', "stage" = 'terminal', "dispatchState" = 'acknowledged', "failureCode" = 'MANUAL_RUNTIME_GUARD_CLEANUP', "completedAt" = clock_timestamp() WHERE "id" = $1::uuid`, [guardRunId]);
      await insertAudit({ runId: guardRunId, projectId, delegationId: delegation.id, action: "failed", statusBefore: "running", statusAfter: "failed", dispatchState: "acknowledged", actorId: connectionOwnerId, commitSha: null, manifestFingerprint: null, reason: "manual_runtime_gate_guard_cleanup", runEvidence });
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    const busyRunId = randomUUID();
    await createRun(busyRunId, randomUUID(), "database-current");
    let liveConflict: unknown;
    try {
      await createRun(randomUUID(), randomUUID(), "database-current");
    } catch (error) {
      liveConflict = error;
    }
    assert.match(String(liveConflict), /ProjectGitRepositoryManualRun_live_delegation_key/u);

    const { updateProjectLifecycle } = await import("../src/lib/project-lifecycle");
    const beforeLiveArchive = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { updatedAt: true } });
    await assert.rejects(
      () => updateProjectLifecycle({
        projectId,
        actor: { id: projectOwnerId, role: "user" },
        action: "archive",
        expectedUpdatedAt: beforeLiveArchive.updatedAt,
      }, db),
      (error: unknown) => error instanceof Error && error.message === "PROJECT_HAS_UNRESOLVED_JOBS",
    );
    await client.query("BEGIN");
    try {
      await client.query(`SELECT set_config('ai.project_git_manual_runtime_audit', '1', true)`);
      await client.query(`UPDATE "ProjectGitRepositoryManualRun" SET "status" = 'unknown', "stage" = 'terminal', "dispatchState" = 'dispatched', "failureCode" = 'MANUAL_RUNTIME_TERMINATED', "completedAt" = clock_timestamp() WHERE "id" = $1::uuid`, [busyRunId]);
      await insertAudit({ runId: busyRunId, projectId, delegationId: delegation.id, action: "unknown", statusBefore: "running", statusAfter: "unknown", dispatchState: "dispatched", actorId: null, commitSha: null, manifestFingerprint: null, reason: "manual_runtime_gate_terminated", runEvidence });
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    const beforeTerminalArchive = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { updatedAt: true } });
    const archivedAfterTerminal = await updateProjectLifecycle({
      projectId,
      actor: { id: projectOwnerId, role: "user" },
      action: "archive",
      expectedUpdatedAt: beforeTerminalArchive.updatedAt,
    }, db);
    assert.ok(archivedAfterTerminal.project.archivedAt instanceof Date);

    const delegationAuditCount = await db.projectGitRepositoryDelegationAudit.count({ where: { delegationId: delegation.id } });
    await client.query(`DELETE FROM "Project" WHERE "id" = $1::uuid`, [projectId]);
    const cascaded = await client.query<{ runs: string; entries: string; pointers: string; sources: string }>(
      `SELECT
        (SELECT count(*)::text FROM "ProjectGitRepositoryManualRun" WHERE "projectId" = $1::uuid) AS runs,
        (SELECT count(*)::text FROM "ProjectGitRepositoryManualRunEntry" WHERE "projectId" = $1::uuid) AS entries,
        (SELECT count(*)::text FROM "ProjectGitRepositoryManualPointer" WHERE "projectId" = $1::uuid) AS pointers,
        (SELECT count(*)::text FROM "ProjectSource" WHERE "projectId" = $1::uuid) AS sources`,
      [projectId],
    );
    assert.deepEqual(cascaded.rows[0], { runs: "0", entries: "0", pointers: "0", sources: "0" });
    assert.equal(await db.projectGitRepositoryDelegationAudit.count({ where: { delegationId: delegation.id } }), delegationAuditCount);
  } finally {
    await client.end();
  }
});
