import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { getDb } from "../src/lib/db";
import { grantProjectMembership, grantWorkspaceMembership, revokeProjectMembership } from "../src/lib/membership-governance";
import {
  confirmProjectGitRepositoryDelegationOwner,
  confirmProjectGitRepositoryDelegationProject,
  proposeProjectGitRepositoryDelegation,
} from "../src/lib/project-git-repository-delegation-service";
import { createPostgresWorkspaceFixture } from "./postgres-workspace-fixture";
import { createGitConnectionFixture } from "./personal-connection-probe-fixture";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.PROJECT_DELEGATED_GIT_RUNTIME_POSTGRES_GATE === "1" && typeof databaseUrl === "string" && databaseUrl.length > 0;
const seededAdminId = "00000000-0000-4000-8000-000000000010";
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
          'ProjectGitRepositoryManualRunAudit',
          'ProjectGitRepositoryManualRunReconciliation'
        )
      ORDER BY table_name
    `);
    assert.deepEqual(tables.rows.map((row) => row.table_name), [
      "ProjectGitRepositoryManualPointer",
      "ProjectGitRepositoryManualRun",
      "ProjectGitRepositoryManualRunAudit",
      "ProjectGitRepositoryManualRunEntry",
      "ProjectGitRepositoryManualRunReconciliation",
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

    const legacyRunGuard = await client.query<{ value: string }>({
      text: `SELECT pg_get_functiondef('personal_git_manual_run_epoch_guard'::regproc) AS value`,
    });
    assert.match(legacyRunGuard.rows[0]?.value ?? "", /personal_git_manual_run_legacy_chain_valid/u);
    assert.match(legacyRunGuard.rows[0]?.value ?? "", /NEW\."requestedByAccountAccessVersion"/u);
    assert.match(legacyRunGuard.rows[0]?.value ?? "", /NEW\."dispatchState" = 'acknowledged'/u);
    assert.match(legacyRunGuard.rows[0]?.value ?? "", /OLD\."stage" IN \('fetching', 'validating', 'publishing'\)/u);

    const legacyAuditGuard = await client.query<{ value: string }>({
      text: `SELECT pg_get_functiondef('personal_git_manual_run_audit_epoch_guard'::regproc) AS value`,
    });
    assert.match(legacyAuditGuard.rows[0]?.value ?? "", /NEW\."actorId" IS NULL/u);
    assert.match(legacyAuditGuard.rows[0]?.value ?? "", /PROJECT_GIT_MANUAL_LEGACY_EPOCH_INVALIDATED/u);

    const transitionGuard = await client.query<{ value: string }>({
      text: `SELECT pg_get_functiondef('project_git_manual_runtime_transition_audit_guard'::regproc) AS value`,
    });
    assert.match(transitionGuard.rows[0]?.value ?? "", /OLD\."status" = 'queued' AND NEW\."status" = 'failed'/u);
    assert.match(transitionGuard.rows[0]?.value ?? "", /PROJECT_GIT_MANUAL_FINAL_FENCE_PRE_DISPATCH_REQUIRED/u);
    assert.match(transitionGuard.rows[0]?.value ?? "", /OLD\."stage" <> 'admitted'/u);

    const auditGuard = await client.query<{ value: string }>({
      text: `SELECT pg_get_functiondef('project_git_manual_runtime_audit_guard'::regproc) AS value`,
    });
    assert.match(auditGuard.rows[0]?.value ?? "", /PROJECT_GIT_MANUAL_FINAL_ADMISSION_REJECTED/u);
    assert.match(auditGuard.rows[0]?.value ?? "", /PROJECT_GIT_MANUAL_FINAL_FENCE_EVIDENCE_STILL_VALID/u);
    assert.match(auditGuard.rows[0]?.value ?? "", /PROJECT_GIT_MANUAL_FINAL_FENCE_AUDIT_INVALID/u);

    const finalFenceIndex = await client.query<{ value: string }>({
      text: `SELECT indexdef AS value FROM pg_indexes WHERE indexname = 'ProjectGitRepositoryManualRunAudit_system_final_fence_key'`,
    });
    assert.equal(finalFenceIndex.rowCount, 1);
    assert.match(finalFenceIndex.rows[0]?.value ?? "", /manual_sync_final_admission_rejected/u);
  } finally {
    await client.end();
  }
});

test("manual delegated Git runtime keeps staged publication and stale runs auditable", { skip: !enabled }, async () => {
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  assertDisposableGateDatabase();
  await client.connect();
  const db = getDb();
  const { workspaceId } = await createPostgresWorkspaceFixture(db);
  const suffix = randomUUID().slice(0, 8);
  const connectionOwnerId = randomUUID();
  const projectOwnerId = randomUUID();
  const requesterId = randomUUID();
  const finalFenceRequesterId = randomUUID();
  const viewerId = randomUUID();
  const revokedActorId = randomUUID();
  const projectId = randomUUID();
  const connectionId = randomUUID();
  const credentialId = randomUUID();
  const addressFingerprint = "b".repeat(64);
  const credentialFingerprint = "a".repeat(64);
  const now = new Date();
  const connectionOwnerActor = { id: connectionOwnerId, role: "user" as const, accountAccessVersion: 1 };
  const projectOwnerActor = { id: projectOwnerId, role: "user" as const, accountAccessVersion: 1 };
  const requesterActor = { id: requesterId, role: "user" as const, accountAccessVersion: 1 };
  const viewerActor = { id: viewerId, role: "user" as const, accountAccessVersion: 1 };
  const revokedActor = { id: revokedActorId, role: "admin" as const, accountAccessVersion: 1 };

  const insertAudit = async (input: {
    runId: string;
    action: string;
    statusBefore: string | null;
    statusAfter: string;
    dispatchState: string;
    actorId: string | null;
    commitSha: string | null;
    manifestFingerprint: string | null;
    reason: string;
  }): Promise<void> => {
    await client.query(
      `INSERT INTO "ProjectGitRepositoryManualRunAudit" (
        "id", "runId", "projectId", "delegationId", "action", "statusBefore", "statusAfter", "dispatchState", "actorId",
        "requestedById", "requestedByProjectMembershipId", "requestedByMembershipCreatedAt", "connectionOwnerId", "connectionOwnerAccountAccessVersion",
        "ownerProjectMembershipId", "ownerMembershipCreatedAt", "projectConfirmedById", "projectConfirmedProjectMembershipId",
        "projectConfirmedMembershipCreatedAt", "reason", "delegationVersion", "delegationFingerprint",
        "connectionConfigurationVersion", "resolvedAddressFingerprint", "credentialFingerprint", "role",
        "requiredForProjectSnapshot", "codeEnabled", "metadataEnabled", "manualSyncAllowed", "automationAllowed",
        "commitSha", "manifestFingerprint", "requestedByAccountAccessVersion", "transitionAt", "createdAt"
      )
      SELECT
        $1::uuid,
        run."id",
        run."projectId",
        run."delegationId",
        $3::"ProjectGitRepositoryManualRunAuditAction",
        $4::"ProjectGitRepositoryManualRunStatus",
        $5::"ProjectGitRepositoryManualRunStatus",
        $6::"ProjectGitRepositoryManualRunDispatchState",
        $7::uuid,
        run."requestedById",
        run."requestedByProjectMembershipId",
        run."requestedByMembershipCreatedAt",
        run."connectionOwnerId",
        run."connectionOwnerAccountAccessVersion",
        run."ownerProjectMembershipId",
        run."ownerMembershipCreatedAt",
        run."projectConfirmedById",
        run."projectConfirmedProjectMembershipId",
        run."projectConfirmedMembershipCreatedAt",
        $8,
        run."delegationVersion",
        run."delegationFingerprint",
        run."connectionConfigurationVersion",
        run."resolvedAddressFingerprint",
        run."credentialFingerprint",
        run."role",
        run."requiredForProjectSnapshot",
        run."codeEnabled",
        run."metadataEnabled",
        run."manualSyncAllowed",
        run."automationAllowed",
        $9,
        $10,
        run."requestedByAccountAccessVersion",
        COALESCE(run."completedAt", statement_timestamp()),
        COALESCE(run."completedAt", statement_timestamp())
      FROM "ProjectGitRepositoryManualRun" run
      WHERE run."id" = $2::uuid`,
      [
        randomUUID(),
        input.runId,
        input.action,
        input.statusBefore,
        input.statusAfter,
        input.dispatchState,
        input.actorId,
        input.reason,
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
        { id: requesterId, username: `manual_runtime_requester_${suffix}`, role: "user" },
        { id: finalFenceRequesterId, username: `manual_runtime_final_fence_${suffix}`, role: "user" },
        { id: viewerId, username: `manual_runtime_viewer_${suffix}`, role: "user" },
        { id: revokedActorId, username: `manual_runtime_revoked_${suffix}`, role: "user" },
      ],
    });
    await db.project.create({ data: { id: projectId, workspaceId, name: `Manual runtime ${suffix}`, slug: `manual-runtime-${suffix}` } });
    await db.$transaction(async (tx) => {
      await grantWorkspaceMembership(tx, { workspaceId, userId: connectionOwnerId, role: "member", actorId: seededAdminId, reason: "manual_runtime_gate_owner" });
      await grantWorkspaceMembership(tx, { workspaceId, userId: projectOwnerId, role: "member", actorId: seededAdminId, reason: "manual_runtime_gate_project_owner" });
      await grantWorkspaceMembership(tx, { workspaceId, userId: requesterId, role: "member", actorId: seededAdminId, reason: "manual_runtime_gate_requester" });
      await grantWorkspaceMembership(tx, { workspaceId, userId: finalFenceRequesterId, role: "member", actorId: seededAdminId, reason: "manual_runtime_gate_final_fence_requester" });
      await grantWorkspaceMembership(tx, { workspaceId, userId: viewerId, role: "member", actorId: seededAdminId, reason: "manual_runtime_gate_viewer" });
      await grantWorkspaceMembership(tx, { workspaceId, userId: revokedActorId, role: "admin", actorId: seededAdminId, reason: "manual_runtime_gate_revoked_actor" });
      await grantProjectMembership(tx, { projectId, workspaceId, userId: connectionOwnerId, role: "editor", actorId: seededAdminId, reason: "manual_runtime_gate_connection_owner" });
      await grantProjectMembership(tx, { projectId, workspaceId, userId: projectOwnerId, role: "owner", actorId: seededAdminId, reason: "manual_runtime_gate_project_owner" });
      await grantProjectMembership(tx, { projectId, workspaceId, userId: requesterId, role: "editor", actorId: seededAdminId, reason: "manual_runtime_gate_requester" });
      await grantProjectMembership(tx, { projectId, workspaceId, userId: finalFenceRequesterId, role: "editor", actorId: seededAdminId, reason: "manual_runtime_gate_final_fence_requester" });
      await grantProjectMembership(tx, { projectId, workspaceId, userId: viewerId, role: "viewer", actorId: seededAdminId, reason: "manual_runtime_gate_viewer" });
      await grantProjectMembership(tx, { projectId, workspaceId, userId: revokedActorId, role: "viewer", actorId: seededAdminId, reason: "manual_runtime_gate_revoked_actor" });
    });
    const ownerMembership = await db.projectMembership.findFirstOrThrow({ where: { projectId, userId: connectionOwnerId }, select: { id: true, createdAt: true } });
    const projectOwnerMembership = await db.projectMembership.findFirstOrThrow({ where: { projectId, userId: projectOwnerId }, select: { id: true, createdAt: true } });
    const requesterMembership = await db.projectMembership.findFirstOrThrow({ where: { projectId, userId: requesterId }, select: { id: true, createdAt: true } });
    const finalFenceRequesterMembership = await db.projectMembership.findFirstOrThrow({ where: { projectId, userId: finalFenceRequesterId }, select: { id: true, createdAt: true } });
    await db.externalCredential.create({ data: { id: credentialId, kind: "git", ciphertext: Buffer.from([1]), nonce: Buffer.from([2]), authTag: Buffer.from([3]), maskedSuffix: "gate", secretFingerprint: credentialFingerprint } });
    await createGitConnectionFixture({
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
      ownerAccountAccessVersion: 1,
      credentialId,
    }, db);
    const draft = await proposeProjectGitRepositoryDelegation(projectId, {
      gitConnectionId: connectionId,
      repositoryPath: "org/manual-runtime",
      trackedRef: "main",
      includeRoots: ["."],
      softExcludePatterns: [],
      role: "primary",
      expiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
    }, connectionOwnerActor, db);
    const ownerConfirmed = await confirmProjectGitRepositoryDelegationOwner(projectId, draft.id, {
      expectedVersion: draft.version,
      acknowledgeReadOnlyCredentialUse: true,
    }, connectionOwnerActor, db);
    const active = await confirmProjectGitRepositoryDelegationProject(projectId, draft.id, {
      expectedVersion: ownerConfirmed.version,
      acknowledgeRepositoryScope: true,
      acknowledgeDataEgress: true,
    }, projectOwnerActor, db);
    const delegation = await db.projectGitRepositoryDelegation.findUniqueOrThrow({ where: { id: active.id } });
    const runEvidence = {
      requestedById: connectionOwnerId,
      requestedByAccountAccessVersion: 1,
      requestedByProjectMembershipId: ownerMembership.id,
      requestedByMembershipCreatedAt: ownerMembership.createdAt,
      connectionOwnerId,
      connectionOwnerAccountAccessVersion: delegation.connectionOwnerAccountAccessVersion!,
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
    const defaultRequester = {
      id: runEvidence.requestedById,
      accountAccessVersion: runEvidence.requestedByAccountAccessVersion,
      membershipId: runEvidence.requestedByProjectMembershipId,
      membershipCreatedAt: runEvidence.requestedByMembershipCreatedAt,
    };
    const requesterEvidence = {
      id: requesterId,
      accountAccessVersion: requesterActor.accountAccessVersion,
      membershipId: requesterMembership.id,
      membershipCreatedAt: requesterMembership.createdAt,
    };
    const finalFenceRequesterEvidence = {
      id: finalFenceRequesterId,
      accountAccessVersion: 1,
      membershipId: finalFenceRequesterMembership.id,
      membershipCreatedAt: finalFenceRequesterMembership.createdAt,
    };
    const createRun = async (
      runId: string,
      key: string,
      startedAt: Date | null | "database-current" | "database-stale",
      requester = defaultRequester,
      dispatch = true,
    ): Promise<void> => {
      await client.query("BEGIN");
      try {
        await client.query(`SELECT set_config('ai.project_git_manual_runtime_audit', '1', true)`);
        await client.query(
          `INSERT INTO "ProjectGitRepositoryManualRun" (
            "id", "projectId", "delegationId", "requestedById", "requestedByProjectMembershipId", "requestedByMembershipCreatedAt",
            "clientRequestKey", "delegationVersion", "delegationFingerprint", "connectionOwnerId", "connectionOwnerAccountAccessVersion", "ownerProjectMembershipId",
            "ownerMembershipCreatedAt", "projectConfirmedById", "projectConfirmedProjectMembershipId", "projectConfirmedMembershipCreatedAt",
            "connectionConfigurationVersion", "resolvedAddressFingerprint", "credentialFingerprint", "repositoryPath", "trackedRef",
            "includeRoots", "softExcludePatterns", "role", "requiredForProjectSnapshot", "codeEnabled", "metadataEnabled",
            "manualSyncAllowed", "automationAllowed", "requestedByAccountAccessVersion"
          ) VALUES (
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
            COALESCE((SELECT "createdAt" FROM "ProjectMembership" WHERE "id" = $5::uuid), $6::timestamp(3)),
            $7::uuid, $8, $9, $10::uuid, $11, $12::uuid,
            COALESCE((SELECT "ownerMembershipCreatedAt" FROM "ProjectGitRepositoryDelegation" WHERE "id" = $3::uuid), $13::timestamp(3)),
            $14::uuid, $15::uuid,
            COALESCE((SELECT "projectConfirmedMembershipCreatedAt" FROM "ProjectGitRepositoryDelegation" WHERE "id" = $3::uuid), $16::timestamp(3)),
            $17, $18, $19, $20, $21,
            $22::jsonb, $23::jsonb, $24::"ProjectRepositoryRole", $25, $26, $27, $28, $29, $30
          )`,
          [
            runId,
            projectId,
            delegation.id,
            requester.id,
            requester.membershipId,
            requester.membershipCreatedAt,
            key,
            runEvidence.delegationVersion,
            runEvidence.delegationFingerprint,
            runEvidence.connectionOwnerId,
            runEvidence.connectionOwnerAccountAccessVersion,
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
            requester.accountAccessVersion,
          ],
        );
        await insertAudit({ runId, action: "requested", statusBefore: null, statusAfter: "queued", dispatchState: "pending", actorId: requester.id, commitSha: null, manifestFingerprint: null, reason: "manual_runtime_gate_requested" });
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
          await client.query(`UPDATE "ProjectGitRepositoryManualRun" SET "status" = 'running', "stage" = 'admitted', "dispatchState" = 'pending', "startedAt" = ${timestampExpression} WHERE "id" = $1::uuid`, [runId]);
        } else {
          await client.query(`UPDATE "ProjectGitRepositoryManualRun" SET "status" = 'running', "stage" = 'admitted', "dispatchState" = 'pending', "startedAt" = $2::timestamptz(3) WHERE "id" = $1::uuid`, [runId, startedAt]);
        }
        await insertAudit({ runId, action: "admitted", statusBefore: "queued", statusAfter: "running", dispatchState: "pending", actorId: requester.id, commitSha: null, manifestFingerprint: null, reason: "manual_runtime_gate_admitted" });
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      if (!dispatch) return;
      await client.query("BEGIN");
      try {
        await client.query(`SELECT set_config('ai.project_git_manual_runtime_audit', '1', true)`);
        await client.query(`UPDATE "ProjectGitRepositoryManualRun" SET "stage" = 'fetching', "dispatchState" = 'dispatched' WHERE "id" = $1::uuid`, [runId]);
        await insertAudit({ runId, action: "dispatched", statusBefore: "running", statusAfter: "running", dispatchState: "dispatched", actorId: requester.id, commitSha: null, manifestFingerprint: null, reason: "manual_runtime_gate_dispatched" });
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    };

    const { executeAccountAccess, previewAccountAccess } = await import("../src/lib/account-access-service");
    const seededAdmin = await db.appUser.findUniqueOrThrow({ where: { id: seededAdminId }, select: { accountAccessVersion: true } });
    const finalFenceRunId = randomUUID();
    await createRun(finalFenceRunId, randomUUID(), "database-current", finalFenceRequesterEvidence, false);
    const finalFenceDisablePreview = await previewAccountAccess({
      adminUserId: seededAdminId,
      adminAccountAccessVersion: seededAdmin.accountAccessVersion,
      userId: finalFenceRequesterId,
      action: "disable",
      reason: "manual runtime final fence rejection",
      expectedVersion: 1,
    }, db);
    await executeAccountAccess({
      adminUserId: seededAdminId,
      adminAccountAccessVersion: seededAdmin.accountAccessVersion,
      userId: finalFenceRequesterId,
      action: "disable",
      reason: "manual runtime final fence rejection",
      expectedVersion: finalFenceDisablePreview.current.accountAccessVersion,
      expectedImpactFingerprint: finalFenceDisablePreview.impactFingerprint,
      requestKey: `manual fence disable ${suffix}`,
      requestFingerprint: finalFenceDisablePreview.requestFingerprint,
      previewId: finalFenceDisablePreview.previewId,
      previewIssuedAt: finalFenceDisablePreview.previewIssuedAt,
      previewExpiresAt: finalFenceDisablePreview.previewExpiresAt,
      confirmation: true,
      confirmationUsername: `manual_runtime_final_fence_${suffix}`,
    }, db);
    await client.query("BEGIN");
    try {
      await client.query(`SELECT set_config('ai.project_git_manual_runtime_audit', '1', true)`);
      await client.query(
        `UPDATE "ProjectGitRepositoryManualRun"
            SET "status" = 'failed', "stage" = 'terminal', "dispatchState" = 'acknowledged',
                "failureCode" = 'PROJECT_GIT_MANUAL_FINAL_ADMISSION_REJECTED', "completedAt" = clock_timestamp()
          WHERE "id" = $1::uuid`,
        [finalFenceRunId],
      );
      await insertAudit({
        runId: finalFenceRunId,
        action: "failed",
        statusBefore: "running",
        statusAfter: "failed",
        dispatchState: "acknowledged",
        actorId: null,
        commitSha: null,
        manifestFingerprint: null,
        reason: "manual_sync_final_admission_rejected",
      });
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    assert.deepEqual(
      await db.projectGitRepositoryManualRunAudit.findMany({
        where: { runId: finalFenceRunId, action: "failed" },
        select: { actorId: true, reason: true },
      }),
      [{ actorId: null, reason: "manual_sync_final_admission_rejected" }],
    );
    await client.query("BEGIN");
    let finalFenceReplayError: unknown;
    try {
      await client.query(`SELECT set_config('ai.project_git_manual_runtime_audit', '1', true)`);
      await insertAudit({
        runId: finalFenceRunId,
        action: "failed",
        statusBefore: "running",
        statusAfter: "failed",
        dispatchState: "acknowledged",
        actorId: null,
        commitSha: null,
        manifestFingerprint: null,
        reason: "manual_sync_final_admission_rejected",
      });
    } catch (error) {
      finalFenceReplayError = error;
    } finally {
      await client.query("ROLLBACK");
    }
    assert.match(String(finalFenceReplayError), /ProjectGitRepositoryManualRunAudit_system_final_fence_key/u);

    const malformedFinalFenceRunId = randomUUID();
    await createRun(malformedFinalFenceRunId, randomUUID(), "database-current", defaultRequester, false);
    await client.query("BEGIN");
    let malformedFinalFenceError: unknown;
    try {
      await client.query(`SELECT set_config('ai.project_git_manual_runtime_audit', '1', true)`);
      await client.query(
        `UPDATE "ProjectGitRepositoryManualRun"
            SET "status" = 'failed', "stage" = 'terminal', "dispatchState" = 'acknowledged',
                "failureCode" = 'PROJECT_GIT_MANUAL_FINAL_ADMISSION_REJECTED', "completedAt" = clock_timestamp()
          WHERE "id" = $1::uuid`,
        [malformedFinalFenceRunId],
      );
      await insertAudit({
        runId: malformedFinalFenceRunId,
        action: "failed",
        statusBefore: "queued",
        statusAfter: "failed",
        dispatchState: "acknowledged",
        actorId: null,
        commitSha: null,
        manifestFingerprint: null,
        reason: "manual_sync_final_admission_rejected",
      });
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    } catch (error) {
      malformedFinalFenceError = error;
    } finally {
      await client.query("ROLLBACK");
    }
    assert.match(String(malformedFinalFenceError), /PROJECT_GIT_MANUAL_FINAL_FENCE_EVIDENCE_STILL_VALID/u);
    await client.query("BEGIN");
    try {
      await client.query(`SELECT set_config('ai.project_git_manual_runtime_audit', '1', true)`);
      await client.query(
        `UPDATE "ProjectGitRepositoryManualRun"
            SET "status" = 'failed', "stage" = 'terminal', "dispatchState" = 'acknowledged',
                "failureCode" = 'MANUAL_RUNTIME_MALFORMED_FENCE_CLEANUP', "completedAt" = clock_timestamp()
          WHERE "id" = $1::uuid`,
        [malformedFinalFenceRunId],
      );
      await insertAudit({
        runId: malformedFinalFenceRunId,
        action: "failed",
        statusBefore: "running",
        statusAfter: "failed",
        dispatchState: "acknowledged",
        actorId: connectionOwnerId,
        commitSha: null,
        manifestFingerprint: null,
        reason: "manual_runtime_malformed_fence_cleanup",
      });
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    const dispatchedForgeryRunId = randomUUID();
    await createRun(dispatchedForgeryRunId, randomUUID(), "database-current", defaultRequester, true);
    await client.query("BEGIN");
    let dispatchedForgeryError: unknown;
    try {
      await client.query(`SELECT set_config('ai.project_git_manual_runtime_audit', '1', true)`);
      await client.query(`UPDATE "Project" SET "archivedAt" = clock_timestamp() WHERE "id" = $1::uuid`, [projectId]);
      await client.query(
        `UPDATE "ProjectGitRepositoryManualRun"
            SET "status" = 'failed', "stage" = 'terminal', "dispatchState" = 'acknowledged',
                "failureCode" = 'PROJECT_GIT_MANUAL_FINAL_ADMISSION_REJECTED', "completedAt" = clock_timestamp()
          WHERE "id" = $1::uuid`,
        [dispatchedForgeryRunId],
      );
      await insertAudit({
        runId: dispatchedForgeryRunId,
        action: "failed",
        statusBefore: "running",
        statusAfter: "failed",
        dispatchState: "acknowledged",
        actorId: null,
        commitSha: null,
        manifestFingerprint: null,
        reason: "manual_sync_final_admission_rejected",
      });
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    } catch (error) {
      dispatchedForgeryError = error;
    } finally {
      await client.query("ROLLBACK");
    }
    assert.match(String(dispatchedForgeryError), /PROJECT_GIT_MANUAL_FINAL_FENCE_PRE_DISPATCH_REQUIRED/u);
    await client.query("BEGIN");
    try {
      await client.query(`SELECT set_config('ai.project_git_manual_runtime_audit', '1', true)`);
      await client.query(
        `UPDATE "ProjectGitRepositoryManualRun"
            SET "status" = 'failed', "stage" = 'terminal', "dispatchState" = 'acknowledged',
                "failureCode" = 'MANUAL_RUNTIME_DISPATCHED_FORGERY_CLEANUP', "completedAt" = clock_timestamp()
          WHERE "id" = $1::uuid`,
        [dispatchedForgeryRunId],
      );
      await insertAudit({
        runId: dispatchedForgeryRunId,
        action: "failed",
        statusBefore: "running",
        statusAfter: "failed",
        dispatchState: "acknowledged",
        actorId: defaultRequester.id,
        commitSha: null,
        manifestFingerprint: null,
        reason: "manual_runtime_dispatched_forgery_cleanup",
      });
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

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
      await insertAudit({ runId, action: "succeeded", statusBefore: "running", statusAfter: "succeeded", dispatchState: "acknowledged", actorId: connectionOwnerId, commitSha, manifestFingerprint: manifest, reason: "manual_runtime_gate_published" });
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

    const { acknowledgeProjectDelegatedGitManualRun, getProjectDelegatedGitManualRunDetail, listProjectDelegatedGitManualRuns, runProjectDelegatedGitManualSync } = await import("../src/lib/project-delegated-git-runtime-service");
    const ownerHistory = await listProjectDelegatedGitManualRuns(projectId, delegation.id, { limit: 20 }, connectionOwnerActor, db);
    assert.equal(ownerHistory.capabilities.canAcknowledge, true);
    assert.equal(ownerHistory.runs[0]?.id, staleRunId);
    const firstPage = await listProjectDelegatedGitManualRuns(projectId, delegation.id, { limit: 1 }, connectionOwnerActor, db);
    assert.equal(firstPage.runs[0]?.id, staleRunId);
    assert.ok(firstPage.nextCursor !== null);
    const secondPage = await listProjectDelegatedGitManualRuns(projectId, delegation.id, { limit: 1, cursor: firstPage.nextCursor! }, connectionOwnerActor, db);
    assert.equal(secondPage.runs[0]?.id, runId);
    assert.notEqual(firstPage.runs[0]?.id, secondPage.runs[0]?.id);
    const ownerDetail = await getProjectDelegatedGitManualRunDetail(projectId, delegation.id, runId, connectionOwnerActor, db);
    assert.equal(ownerDetail.capabilities.canAcknowledge, true);
    assert.equal(ownerDetail.entries[0]?.projectSourceId, sourceId);
    const viewerHistory = await listProjectDelegatedGitManualRuns(projectId, delegation.id, { limit: 20 }, viewerActor, db);
    assert.equal(viewerHistory.capabilities.canAcknowledge, false);
    const viewerDetail = await getProjectDelegatedGitManualRunDetail(projectId, delegation.id, runId, viewerActor, db);
    assert.equal(viewerDetail.capabilities.canAcknowledge, false);
    await db.$transaction(async (tx) => {
      await revokeProjectMembership(tx, projectId, revokedActorId, workspaceId, { actorId: seededAdminId, reason: "manual_runtime_gate_revoke_actor" });
    });
    await db.project.update({ where: { id: projectId }, data: { membershipInheritanceMode: "workspaceInherited" } });
    const revokedHistory = await listProjectDelegatedGitManualRuns(projectId, delegation.id, { limit: 20 }, revokedActor, db);
    assert.equal(revokedHistory.capabilities.canAcknowledge, false);
    const stale = await runProjectDelegatedGitManualSync({
      projectId,
      delegationId: delegation.id,
      request: { clientRequestKey: staleKey },
      actor: connectionOwnerActor,
    }, db);
    assert.equal(stale.status, "unknown");
    assert.equal(stale.failureCode, "PROJECT_GIT_MANUAL_RUN_STALE");
    const replay = await runProjectDelegatedGitManualSync({
      projectId,
      delegationId: delegation.id,
      request: { clientRequestKey: staleKey },
      actor: connectionOwnerActor,
    }, db);
    assert.equal(replay.status, "unknown");
    assert.equal(await db.projectGitRepositoryManualRunAudit.count({ where: { runId: staleRunId, action: "unknown" } }), 1);
    await assert.rejects(
      () => runProjectDelegatedGitManualSync({
        projectId,
        delegationId: delegation.id,
        request: { clientRequestKey: staleKey },
        actor: projectOwnerActor,
      }, db),
      (error: unknown) => error instanceof Error && error.message === "PROJECT_GIT_MANUAL_FORBIDDEN",
    );
    assert.equal(await db.projectGitRepositoryManualRunAudit.count({ where: { runId: staleRunId, action: "unknown" } }), 1);

    await assert.rejects(
      () => acknowledgeProjectDelegatedGitManualRun(
        projectId,
        delegation.id,
        staleRunId,
        {},
        viewerActor,
        db,
      ),
      /ACCESS_FORBIDDEN/u,
    );

    const runBeforeAcknowledgement = await db.projectGitRepositoryManualRun.findUniqueOrThrow({ where: { id: staleRunId }, select: { status: true, completedAt: true } });
    const auditBeforeAcknowledgement = await db.projectGitRepositoryManualRunAudit.count({ where: { runId: staleRunId } });
    const acknowledgement = await acknowledgeProjectDelegatedGitManualRun(
      projectId,
      delegation.id,
      staleRunId,
      {},
      connectionOwnerActor,
      db,
    );
    const repeatedAcknowledgement = await acknowledgeProjectDelegatedGitManualRun(
      projectId,
      delegation.id,
      staleRunId,
      {},
      connectionOwnerActor,
      db,
    );
    assert.equal(repeatedAcknowledgement.runId, acknowledgement.runId);
    assert.equal(repeatedAcknowledgement.acknowledgedAt.toISOString(), acknowledgement.acknowledgedAt.toISOString());
    assert.deepEqual(await db.projectGitRepositoryManualRun.findUniqueOrThrow({ where: { id: staleRunId }, select: { status: true, completedAt: true } }), runBeforeAcknowledgement);
    assert.equal(await db.projectGitRepositoryManualRunAudit.count({ where: { runId: staleRunId } }), auditBeforeAcknowledgement);
    const storedAcknowledgement = await db.projectGitRepositoryManualRunReconciliation.findUniqueOrThrow({ where: { runId: staleRunId } });
    assert.equal(storedAcknowledgement.actorId, connectionOwnerId);
    assert.equal(storedAcknowledgement.actorProjectMembershipId, ownerMembership.id);
    let acknowledgementUpdateError: unknown;
    try {
      await client.query(`UPDATE "ProjectGitRepositoryManualRunReconciliation" SET "actorId" = $2::uuid WHERE "runId" = $1::uuid`, [staleRunId, projectOwnerId]);
    } catch (error) {
      acknowledgementUpdateError = error;
    }
    assert.match(String(acknowledgementUpdateError), /PROJECT_GIT_MANUAL_RECONCILIATION_IMMUTABLE/u);
    let acknowledgementDeleteError: unknown;
    try {
      await client.query(`DELETE FROM "ProjectGitRepositoryManualRunReconciliation" WHERE "runId" = $1::uuid`, [staleRunId]);
    } catch (error) {
      acknowledgementDeleteError = error;
    }
    assert.match(String(acknowledgementDeleteError), /PROJECT_GIT_MANUAL_RECONCILIATION_IMMUTABLE/u);

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
      await insertAudit({ runId: guardRunId, action: "succeeded", statusBefore: "running", statusAfter: "succeeded", dispatchState: "acknowledged", actorId: connectionOwnerId, commitSha: guardCommit, manifestFingerprint: guardManifest, reason: "manual_runtime_gate_missing_pointer" });
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
      await insertAudit({ runId: guardRunId, action: "failed", statusBefore: "running", statusAfter: "failed", dispatchState: "acknowledged", actorId: connectionOwnerId, commitSha: null, manifestFingerprint: null, reason: "manual_runtime_gate_guard_cleanup" });
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
        actor: projectOwnerActor,
        action: "archive",
        expectedUpdatedAt: beforeLiveArchive.updatedAt,
      }, db),
      (error: unknown) => error instanceof Error && error.message === "PROJECT_HAS_UNRESOLVED_JOBS",
    );
    await client.query("BEGIN");
    try {
      await client.query(`SELECT set_config('ai.project_git_manual_runtime_audit', '1', true)`);
      await client.query(`UPDATE "ProjectGitRepositoryManualRun" SET "status" = 'unknown', "stage" = 'terminal', "dispatchState" = 'dispatched', "failureCode" = 'MANUAL_RUNTIME_TERMINATED', "completedAt" = clock_timestamp() WHERE "id" = $1::uuid`, [busyRunId]);
      await insertAudit({ runId: busyRunId, action: "unknown", statusBefore: "running", statusAfter: "unknown", dispatchState: "dispatched", actorId: null, commitSha: null, manifestFingerprint: null, reason: "manual_runtime_gate_terminated" });
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    const requesterRunId = randomUUID();
    const requesterRunKey = randomUUID();
    const requesterSourceCountBefore = await db.projectSource.count({ where: { projectId } });
    await createRun(requesterRunId, requesterRunKey, "database-current", requesterEvidence, false);
    const requesterDisableReason = "manual runtime requester epoch test";
    const requesterDisablePreview = await previewAccountAccess({
      adminUserId: seededAdminId,
      adminAccountAccessVersion: seededAdmin.accountAccessVersion,
      userId: requesterId,
      action: "disable",
      reason: requesterDisableReason,
      expectedVersion: requesterActor.accountAccessVersion,
    }, db);
    const requesterDisabled = await executeAccountAccess({
      adminUserId: seededAdminId,
      adminAccountAccessVersion: seededAdmin.accountAccessVersion,
      userId: requesterId,
      action: "disable",
      reason: requesterDisableReason,
      expectedVersion: requesterDisablePreview.current.accountAccessVersion,
      expectedImpactFingerprint: requesterDisablePreview.impactFingerprint,
      requestKey: `manual runtime requester disable ${suffix}`,
      requestFingerprint: requesterDisablePreview.requestFingerprint,
      previewId: requesterDisablePreview.previewId,
      previewIssuedAt: requesterDisablePreview.previewIssuedAt,
      previewExpiresAt: requesterDisablePreview.previewExpiresAt,
      confirmation: true,
      confirmationUsername: requesterDisablePreview.user.username,
    }, db);
    assert.equal(requesterDisabled.accountAccessVersion, 2);
    const requesterRestoreReason = "manual runtime requester epoch restore";
    const requesterRestorePreview = await previewAccountAccess({
      adminUserId: seededAdminId,
      adminAccountAccessVersion: seededAdmin.accountAccessVersion,
      userId: requesterId,
      action: "restore",
      reason: requesterRestoreReason,
      expectedVersion: requesterDisabled.accountAccessVersion,
    }, db);
    const requesterRestored = await executeAccountAccess({
      adminUserId: seededAdminId,
      adminAccountAccessVersion: seededAdmin.accountAccessVersion,
      userId: requesterId,
      action: "restore",
      reason: requesterRestoreReason,
      expectedVersion: requesterRestorePreview.current.accountAccessVersion,
      expectedImpactFingerprint: requesterRestorePreview.impactFingerprint,
      requestKey: `manual runtime requester restore ${suffix}`,
      requestFingerprint: requesterRestorePreview.requestFingerprint,
      previewId: requesterRestorePreview.previewId,
      previewIssuedAt: requesterRestorePreview.previewIssuedAt,
      previewExpiresAt: requesterRestorePreview.previewExpiresAt,
      confirmation: true,
      confirmationUsername: requesterRestorePreview.user.username,
    }, db);
    assert.equal(requesterRestored.accountAccessVersion, 3);
    await assert.rejects(
      () => runProjectDelegatedGitManualSync({
        projectId,
        delegationId: delegation.id,
        request: { clientRequestKey: requesterRunKey },
        actor: requesterActor,
      }, db),
      (error: unknown) => error instanceof Error && error.message === "ACCOUNT_ACCESS_STALE",
    );
    const requesterReplayed = await runProjectDelegatedGitManualSync({
      projectId,
      delegationId: delegation.id,
      request: { clientRequestKey: requesterRunKey },
      actor: { ...requesterActor, accountAccessVersion: requesterRestored.accountAccessVersion },
    }, db);
    assert.equal(requesterReplayed.status, "unknown");
    assert.equal(requesterReplayed.failureCode, "PROJECT_GIT_MANUAL_RUN_STALE");
    assert.deepEqual(
      await db.projectGitRepositoryManualRun.findUniqueOrThrow({
        where: { id: requesterRunId },
        select: { status: true, stage: true, dispatchState: true, requestedByAccountAccessVersion: true },
      }),
      { status: "unknown", stage: "terminal", dispatchState: "dispatched", requestedByAccountAccessVersion: 1 },
    );
    assert.equal(await db.projectGitRepositoryManualRunAudit.count({ where: { runId: requesterRunId } }), 3);
    assert.equal(await db.projectGitRepositoryManualRunEntry.count({ where: { runId: requesterRunId } }), 0);
    assert.equal(await db.projectSource.count({ where: { projectId } }), requesterSourceCountBefore);

    const beforeTerminalArchive = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { updatedAt: true } });
    const archivedAfterTerminal = await updateProjectLifecycle({
      projectId,
      actor: projectOwnerActor,
      action: "archive",
      expectedUpdatedAt: beforeTerminalArchive.updatedAt,
    }, db);
    assert.ok(archivedAfterTerminal.project.archivedAt instanceof Date);
    const archivedHistory = await listProjectDelegatedGitManualRuns(projectId, delegation.id, { limit: 20 }, projectOwnerActor, db);
    assert.equal(archivedHistory.capabilities.canAcknowledge, false);

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
    assert.ok(await db.projectGitRepositoryManualRunReconciliation.findUnique({ where: { id: storedAcknowledgement.id } }));
  } finally {
    await client.end();
  }
});
