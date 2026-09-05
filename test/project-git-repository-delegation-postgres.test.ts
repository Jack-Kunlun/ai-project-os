import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { getDb } from "../src/lib/db";
import { grantProjectMembership, grantWorkspaceMembership, revokeProjectMembership } from "../src/lib/membership-governance";
import {
  confirmProjectGitRepositoryDelegationOwner,
  confirmProjectGitRepositoryDelegationProject,
  rejectProjectGitRepositoryDelegation,
  revokeProjectGitRepositoryDelegation,
  getProjectGitRepositoryDelegationLiveEligibility,
  listProjectGitRepositoryDelegations,
  proposeProjectGitRepositoryDelegation,
} from "../src/lib/project-git-repository-delegation-service";
import { deleteGitConnection, GitServiceError, updateGitConnection } from "../src/lib/git";
import { updateProjectLifecycle } from "../src/lib/project-lifecycle";

const shouldRun = process.env.PROJECT_GIT_REPOSITORY_DELEGATION_POSTGRES_GATE === "1";
const testDatabaseName = "ai_project_os_project_git_repository_delegation_test";
const seededAdminId = "00000000-0000-4000-8000-000000000010";
const workspaceId = "00000000-0000-4000-8000-000000000001";

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
      "id", "projectId", "gitConnectionId", "delegationId", "connectionOwnerId",
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
    SELECT ${randomUUID()}::uuid, delegation."projectId", delegation."gitConnectionId", delegation."id", delegation."connectionOwnerId",
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
    const viewerId = randomUUID();
    const projectId = randomUUID();
    const connectionId = randomUUID();
    const foreignConnectionId = randomUUID();
    const credentialId = randomUUID();
    const foreignCredentialId = randomUUID();
    const now = new Date();
    const connectionFingerprint = "a".repeat(64);
    const addressFingerprint = "b".repeat(64);

    await db.appUser.createMany({
      data: [
        { id: connectionOwnerId, username: `git_delegation_owner_${suffix}`, role: "user" },
        { id: projectOwnerId, username: `git_delegation_project_owner_${suffix}`, role: "user" },
        { id: viewerId, username: `git_delegation_viewer_${suffix}`, role: "user" },
      ],
    });
    const project = await db.project.create({ data: { id: projectId, workspaceId, name: `Git delegation ${suffix}`, slug: `git-delegation-${suffix}` } });
    await db.$transaction(async (tx) => {
      await grantWorkspaceMembership(tx, { workspaceId, userId: connectionOwnerId, role: "member", actorId: seededAdminId, reason: "git_delegation_gate_owner" });
      await grantWorkspaceMembership(tx, { workspaceId, userId: projectOwnerId, role: "member", actorId: seededAdminId, reason: "git_delegation_gate_project_owner" });
      await grantWorkspaceMembership(tx, { workspaceId, userId: viewerId, role: "member", actorId: seededAdminId, reason: "git_delegation_gate_viewer" });
      await grantProjectMembership(tx, { projectId: project.id, workspaceId, userId: connectionOwnerId, role: "editor", actorId: seededAdminId, reason: "git_delegation_gate_owner" });
      await grantProjectMembership(tx, { projectId: project.id, workspaceId, userId: projectOwnerId, role: "owner", actorId: seededAdminId, reason: "git_delegation_gate_project_owner" });
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
    };
    await db.gitConnection.create({ data: { ...common, id: connectionId, name: `Own Git ${suffix}` } });
    await db.gitConnection.create({ data: { ...common, id: foreignConnectionId, name: `Foreign Git ${suffix}`, ownerUserId: projectOwnerId, createdById: projectOwnerId, credentialId: foreignCredentialId } });

    await assert.rejects(
      () => proposeProjectGitRepositoryDelegation(projectId, {
        gitConnectionId: foreignConnectionId,
        repositoryPath: "org/repo",
        trackedRef: "main",
        includeRoots: ["."],
        softExcludePatterns: [],
        role: "primary",
        expiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
      }, { id: connectionOwnerId, role: "user" }, db),
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
    }, { id: connectionOwnerId, role: "user" }, db);
    assert.equal(draft.status, "draft");
    assert.doesNotMatch(JSON.stringify(draft), /github\.com|credential|Fingerprint|username|maskedSuffix|tlsCaCertificate|sshKnownHost/u);

    const ownerConfirmed = await confirmProjectGitRepositoryDelegationOwner(projectId, draft.id, {
      expectedVersion: draft.version,
      acknowledgeReadOnlyCredentialUse: true,
    }, { id: connectionOwnerId, role: "user" }, db);
    assert.equal(ownerConfirmed.status, "ownerConfirmed");
    const active = await confirmProjectGitRepositoryDelegationProject(projectId, draft.id, {
      expectedVersion: ownerConfirmed.version,
      acknowledgeRepositoryScope: true,
      acknowledgeDataEgress: true,
    }, { id: projectOwnerId, role: "user" }, db);
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
    }, { id: connectionOwnerId }, db);
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

    assert.equal((await listProjectGitRepositoryDelegations(projectId, { id: viewerId, role: "user" }, db)).delegations.length, 1);
    assert.equal((await getProjectGitRepositoryDelegationLiveEligibility(projectId, draft.id, db)).eligible, true);
    await assert.rejects(
      () => revokeProjectGitRepositoryDelegation(projectId, draft.id, {
        expectedVersion: active.version,
        reason: "viewer must not revoke",
      }, { id: viewerId, role: "user" }, db),
      /PROJECT_GIT_REPOSITORY_DELEGATION_FORBIDDEN/u,
    );
    await assert.rejects(
      () => revokeProjectGitRepositoryDelegation(projectId, randomUUID(), {
        expectedVersion: 1,
        reason: "viewer must not learn delegation existence",
      }, { id: viewerId, role: "user" }, db),
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
    }, { id: connectionOwnerId, role: "user" }, db);
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
          "id", "projectId", "gitConnectionId", "delegationId", "connectionOwnerId",
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
        SELECT ${randomUUID()}::uuid, "projectId", "gitConnectionId", "delegationId", "connectionOwnerId",
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

    const disabledConnection = await db.gitConnection.update({ where: { id: connectionId }, data: { status: "disabled", disabledAt: new Date() } });
    await assert.rejects(
      () => deleteGitConnection(connectionId, {
        confirmationName: `Own Git ${suffix}`,
        expectedUpdatedAt: disabledConnection.updatedAt.toISOString(),
      }, { id: connectionOwnerId }, db),
      (error: unknown) => error instanceof GitServiceError && error.code === "GIT_CONNECTION_IN_USE",
    );
    const drifted = await getProjectGitRepositoryDelegationLiveEligibility(projectId, draft.id, db);
    assert.equal(drifted.eligible, false);
    assert.equal(drifted.reason, "CONNECTION_DRIFT");

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

    const rejected = await rejectProjectGitRepositoryDelegation(projectId, forgedDraft.id, {
      expectedVersion: forgedDraft.version,
      reason: "connection owner rejected after membership replacement",
    }, { id: connectionOwnerId, role: "user" }, db);
    assert.equal(rejected.status, "rejected");

    const currentProject = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { updatedAt: true } });
    await updateProjectLifecycle({
      projectId,
      actor: { id: projectOwnerId, role: "user" },
      action: "archive",
      expectedUpdatedAt: currentProject.updatedAt,
    }, db);

    const revoked = await revokeProjectGitRepositoryDelegation(projectId, draft.id, {
      expectedVersion: active.version,
      reason: "connection owner revoked after membership replacement and archive",
    }, { id: connectionOwnerId, role: "user" }, db);
    assert.equal(revoked.status, "revoked");
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
    await deleteGitConnection(connectionId, {
      confirmationName: `Own Git ${suffix}`,
      expectedUpdatedAt: disabledConnection.updatedAt.toISOString(),
    }, { id: connectionOwnerId }, db);
    assert.equal(await db.projectGitRepositoryDelegation.count({ where: { gitConnectionId: connectionId } }), 0);
    assert.equal(await db.gitConnection.count({ where: { id: connectionId } }), 0);
    assert.equal(await db.externalCredential.count({ where: { id: credentialId } }), 0);
    assert.equal(await db.projectGitRepositoryDelegationAudit.count({ where: { delegationId: draft.id } }), auditCount);
    assert.equal(await db.projectGitRepositoryDelegationAudit.count({ where: { delegationId: draft.id } }), activeAuditCount);
    assert.equal(await db.projectGitRepositoryDelegationAudit.count({ where: { delegationId: forgedDraft.id } }), 2);

  },
);
