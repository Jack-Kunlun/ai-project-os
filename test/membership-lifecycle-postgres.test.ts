import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Prisma, type ProjectAiProviderDelegation } from "@prisma/client";
import { executeAccountAccess, previewAccountAccess } from "../src/lib/account-access-service";
import { getDb } from "../src/lib/db";
import { grantProjectMembership, grantWorkspaceMembership } from "../src/lib/membership-governance";
import { createPersonalProviderConnection } from "../src/lib/personal-ai-provider-service";
import {
  executeMembership,
  MembershipServiceError,
  membershipRequestFingerprint,
  previewMembership,
  type MembershipLifecycleAction,
  type MembershipPreview,
} from "../src/lib/membership-service";
import {
  confirmProjectAiProviderDelegationOwner,
  confirmProjectAiProviderDelegationProject,
  proposeProjectAiProviderDelegation,
  putProjectAiEffectiveRouteSelection,
  revokeProjectAiProviderDelegation,
} from "../src/lib/project-ai-provider-delegation-service";

const shouldRun = process.env.MEMBERSHIP_LIFECYCLE_POSTGRES_GATE === "1";
const testDatabaseName = "ai_project_os_membership_lifecycle_test";
const gateUser = "ai_project_os_gate";
const day = 24 * 60 * 60 * 1_000;

function assertDisposableGateDatabase(): void {
  const configuredUrl = process.env.DATABASE_URL;
  if (typeof configuredUrl !== "string" || configuredUrl.length === 0) {
    throw new Error("MEMBERSHIP_LIFECYCLE_TEST_DATABASE_URL_REQUIRED");
  }
  let parsed: URL;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new Error("MEMBERSHIP_LIFECYCLE_TEST_DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== `/${testDatabaseName}`
    || parsed.username !== gateUser
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw new Error("MEMBERSHIP_LIFECYCLE_TEST_DATABASE_URL_INVALID");
  }
}

function serviceCode(error: unknown): string | null {
  return error instanceof MembershipServiceError ? error.code : null;
}

function lifecycleInput(
  preview: MembershipPreview,
  input: Readonly<{ adminUserId: string; requestKey: string; days?: number; note?: string | null; reason?: string | null; confirmationUsername?: string }>,
) {
  return {
    adminUserId: input.adminUserId,
    userId: preview.user.id,
    action: preview.action,
    days: preview.action === "revoke" ? undefined : input.days,
    note: input.note,
    reason: input.reason,
    expectedVersion: preview.current.version,
    expectedImpactFingerprint: preview.impactFingerprint,
    requestKey: input.requestKey,
    requestFingerprint: preview.requestFingerprint,
    previewId: preview.previewId,
    previewIssuedAt: preview.previewIssuedAt,
    previewExpiresAt: preview.previewExpiresAt,
    confirmation: true as const,
    confirmationUsername: input.confirmationUsername,
  };
}

async function previewFor(
  adminUserId: string,
  userId: string,
  action: MembershipLifecycleAction,
  input: Readonly<{ days?: number; note?: string | null; reason?: string | null; expectedVersion?: number }>,
) {
  return previewMembership({ adminUserId, userId, action, ...input }, getDb());
}

async function executeGovernedAccountAccess(
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
    db.appUser.findUniqueOrThrow({ where: { id: input.adminUserId }, select: { accountAccessVersion: true } }),
    db.appUser.findUniqueOrThrow({ where: { id: input.userId }, select: { accountAccessVersion: true } }),
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
    userId: input.userId,
    action: input.action,
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

async function createNearExpiryMembershipFixture(db: ReturnType<typeof getDb>, input: Readonly<{ adminId: string; userId: string; requestKey: string }>): Promise<void> {
  const previewId = randomUUID();
  const requestFingerprint = "c".repeat(64);
  const impactFingerprint = "d".repeat(64);
  await db.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_preview_context', '1', true)`);
    await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_preview_id', ${previewId}, true)`);
    await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_preview_actor_id', ${input.adminId}, true)`);
    await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_preview_user_id', ${input.userId}, true)`);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "MembershipMutationPreview" (
        "id", "actorId", "userId", "action", "expectedVersion", "impactFingerprint", "requestFingerprint",
        "issuedAt", "expiresAt", "consumedAt"
      ) VALUES (
        ${previewId}::uuid, ${input.adminId}::uuid, ${input.userId}::uuid, 'grant'::"MembershipAuditEventKind", 0,
        ${impactFingerprint}, ${requestFingerprint}, clock_timestamp() - interval '1 second',
        clock_timestamp() + interval '5 minutes', clock_timestamp()
      )
    `);
    await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_context', '1', true)`);
    await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_actor_id', ${input.adminId}, true)`);
    await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_user_id', ${input.userId}, true)`);
    await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_action', 'grant', true)`);
    await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_request_key', ${input.requestKey}, true)`);
    await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_request_fingerprint', ${requestFingerprint}, true)`);
    await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_impact_fingerprint', ${impactFingerprint}, true)`);
    await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_preview_id', ${previewId}, true)`);
    await tx.$executeRaw(Prisma.sql`
      WITH subscription AS (
        INSERT INTO "MembershipSubscription" (
          "id", "userId", "status", "startsAt", "expiresAt", "grantedById", "revokedById",
          "revokedAt", "revocationReason", "note", "version", "createdAt", "updatedAt"
        ) VALUES (
          ${randomUUID()}::uuid, ${input.userId}::uuid, 'active'::"MembershipSubscriptionStatus",
          clock_timestamp() - interval '1 second', clock_timestamp() + interval '2 seconds', ${input.adminId}::uuid,
          NULL, NULL, NULL, 'near expiry fixture', 1, clock_timestamp(), clock_timestamp()
        )
        RETURNING *
      )
      INSERT INTO "MembershipSubscriptionAudit" (
        "id", "subscriptionId", "userId", "actorId", "eventKind", "startsAt", "expiresAt", "note",
        "versionBefore", "versionAfter", "statusBefore", "statusAfter", "startsAtBefore", "startsAtAfter",
        "expiresAtBefore", "expiresAtAfter", "revokedAtBefore", "revokedAtAfter", "revocationReasonBefore",
        "revocationReasonAfter", "noteBefore", "noteAfter", "grantedByIdBefore", "grantedByIdAfter",
        "revokedByIdBefore", "revokedByIdAfter", "reason", "requestKey", "requestFingerprint",
        "impactFingerprint", "previewId", "contractVersion"
      )
      SELECT ${randomUUID()}::uuid, subscription."id", subscription."userId", ${input.adminId}::uuid,
             'grant'::"MembershipAuditEventKind", subscription."startsAt", subscription."expiresAt", subscription."note",
             NULL, subscription."version", NULL, subscription."status", NULL, subscription."startsAt",
             NULL, subscription."expiresAt", NULL, subscription."revokedAt", NULL, subscription."revocationReason",
             NULL, subscription."note", NULL, subscription."grantedById", NULL, subscription."revokedById",
             'near expiry fixture', ${input.requestKey}, ${requestFingerprint}, ${impactFingerprint}, ${previewId}::uuid, 2
        FROM subscription
    `);
  });
}

async function insertDelegationFixtureAudit(
  tx: Prisma.TransactionClient,
  delegation: ProjectAiProviderDelegation,
  action: "proposed" | "expired",
  statusBefore: "draft" | "ownerConfirmed" | "active" | null,
): Promise<void> {
  const isExpiry = action === "expired";
  const transitionAt = action === "proposed" ? delegation.proposedAt : delegation.expiredAt;
  if (transitionAt === null) throw new Error("MEMBERSHIP_LIFECYCLE_DELEGATION_AUDIT_FIXTURE_INVALID");
  const connectionOwnerAccountAccessVersion = delegation.connectionOwnerAccountAccessVersion;
  if (connectionOwnerAccountAccessVersion === null) throw new Error("MEMBERSHIP_LIFECYCLE_DELEGATION_OWNER_EPOCH_MISSING");
  await tx.projectAiProviderDelegationAudit.create({
    data: {
      id: randomUUID(),
      projectId: delegation.projectId,
      operation: delegation.operation,
      entity: "delegation",
      action,
      delegationId: delegation.id,
      delegationVersion: delegation.version,
      statusBefore,
      statusAfter: delegation.status,
      providerConnectionId: delegation.providerConnectionId,
      connectionOwnerId: delegation.connectionOwnerId,
      connectionOwnerAccountAccessVersion,
      ownerProjectMembershipId: delegation.ownerProjectMembershipId,
      projectConfirmedProjectMembershipId: delegation.projectConfirmedProjectMembershipId,
      projectConfirmedMembershipCreatedAt: delegation.projectConfirmedMembershipCreatedAt,
      connectionOwnerSubscriptionId: delegation.connectionOwnerSubscriptionId,
      connectionOwnerSubscriptionVersion: delegation.connectionOwnerSubscriptionVersion,
      connectionOwnerSubscriptionStartsAt: delegation.connectionOwnerSubscriptionStartsAt,
      connectionOwnerSubscriptionExpiresAt: delegation.connectionOwnerSubscriptionExpiresAt,
      modelId: delegation.modelId,
      embeddingDimensions: delegation.embeddingDimensions,
      maxOutputTokens: delegation.maxOutputTokens,
      providerConfigurationVersion: delegation.providerConfigurationVersion,
      credentialFingerprint: delegation.credentialFingerprint,
      delegationFingerprint: delegation.delegationFingerprint,
      terminalActorKind: delegation.terminalActorKind,
      terminalActorId: delegation.terminalActorId,
      terminalActorProjectMembershipId: delegation.terminalActorProjectMembershipId,
      terminalActorMembershipCreatedAt: delegation.terminalActorMembershipCreatedAt,
      terminalReason: delegation.terminalReason,
      actorKind: isExpiry ? "systemExpiry" : "user",
      actorId: isExpiry ? null : delegation.proposedById,
      actorProjectMembershipId: isExpiry ? null : delegation.ownerProjectMembershipId,
      actorMembershipCreatedAt: isExpiry ? null : delegation.ownerMembershipCreatedAt,
      reason: isExpiry ? "system_expiry" : "membership_lifecycle_short_expiry_fixture",
      transitionAt,
    },
  });
}

test("membership lifecycle is preview-confirmed, idempotent, CAS protected, and append-only in PostgreSQL", {
  skip: !shouldRun ? "MEMBERSHIP_LIFECYCLE_POSTGRES_GATE=1 is required" : false,
}, async () => {
  assertDisposableGateDatabase();
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const adminId = randomUUID();
  const secondAdminId = randomUUID();
  const targetId = randomUUID();
  const concurrentTargetId = randomUUID();
  const disabledAdminTargetId = randomUUID();
  const rawOwnershipOtherTargetId = randomUUID();
  const expiringTargetId = randomUUID();
  const dependencyWorkspaceId = randomUUID();
  const dependencyProjectId = randomUUID();
  const previousMasterKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
  const masterKeyDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-membership-lifecycle-"));
  process.env.AI_PROJECT_OS_MASTER_KEY_FILE = join(masterKeyDirectory, "master.key");

  await db.appUser.createMany({
    data: [
      { id: adminId, username: `membership_admin_${suffix}`, role: "admin" },
      { id: secondAdminId, username: `membership_admin_two_${suffix}`, role: "admin" },
      { id: targetId, username: `membership_target_${suffix}`, role: "user" },
      { id: concurrentTargetId, username: `membership_concurrent_${suffix}`, role: "user" },
      { id: disabledAdminTargetId, username: `membership_disabled_admin_target_${suffix}`, role: "user" },
      { id: rawOwnershipOtherTargetId, username: `membership_raw_ownership_other_${suffix}`, role: "user" },
      { id: expiringTargetId, username: `membership_expiring_${suffix}`, role: "user" },
    ],
  });
  const targetActor = { id: targetId, role: "user" as const, accountAccessVersion: 1 };

  try {
    const grantPreview = await previewFor(adminId, targetId, "grant", { days: 30, note: "gate grant" });
    assert.equal(grantPreview.current.state, "none");
    assert.equal(grantPreview.current.version, 0);
    assert.equal(grantPreview.target.state, "active");
    assert.equal(grantPreview.target.version, 1);
    assert.equal(grantPreview.canExecute, true);
    assert.deepEqual(grantPreview.blockingCategories, []);
    assert.equal(grantPreview.issuedAt.toISOString(), grantPreview.previewIssuedAt.toISOString());
    assert.equal(grantPreview.expiresAt.toISOString(), grantPreview.previewExpiresAt.toISOString());
    assert.equal(grantPreview.previewExpiresAt.getTime() - grantPreview.previewIssuedAt.getTime(), 5 * 60 * 1_000);
    assert.equal(grantPreview.dependencyStats.personalModelAutomationsAffected, 0);
    assert.equal(grantPreview.dependencyStats.platformAutomationImpact, "unaffected");
    assert.equal(grantPreview.dependencyStats.gitMcpImpact, "unaffected");
    assert.deepEqual(grantPreview.dependencyStats.affectedProjects, []);

    const grantInput = lifecycleInput(grantPreview, { adminUserId: adminId, requestKey: `membership-${suffix}-grant`, days: 30, note: "gate grant" });
    const crossAdminPreview = await previewFor(secondAdminId, targetId, "grant", { days: 30, note: "gate grant" });
    await assert.rejects(
      () => executeMembership({ ...grantInput, previewId: crossAdminPreview.previewId }, db),
      (error: unknown) => serviceCode(error) === "MEMBERSHIP_PREVIEW_STALE",
      "a preview issued to another administrator cannot authorize this mutation",
    );
    const crossTargetPreview = await previewFor(adminId, disabledAdminTargetId, "grant", { days: 1 });
    await assert.rejects(
      () => executeMembership({ ...lifecycleInput(crossTargetPreview, { adminUserId: adminId, requestKey: `membership-${suffix}-cross-target`, days: 1 }), userId: targetId }, db),
      (error: unknown) => serviceCode(error) === "MEMBERSHIP_PREVIEW_STALE",
      "a preview issued for another target cannot authorize this mutation",
    );
    const granted = await executeMembership(grantInput, db);
    assert.equal(granted.status, "active");
    assert.equal(granted.version, 1);
    assert.equal(granted.revocationReason, null);
    assert.equal(granted.expiresAt.getTime() - granted.startsAt.getTime(), 30 * day);

    const grantReplay = await executeMembership(grantInput, db);
    assert.equal(grantReplay.id, granted.id);
    assert.equal(grantReplay.version, granted.version);
    assert.equal(grantReplay.expiresAt.toISOString(), granted.expiresAt.toISOString());
    await assert.rejects(
      () => executeMembership({ ...grantInput, requestFingerprint: "b".repeat(64) }, db),
      (error: unknown) => serviceCode(error) === "MEMBERSHIP_IDEMPOTENCY_CONFLICT",
    );

    const extendPreview = await previewFor(adminId, targetId, "extend", { days: 5, note: "gate extension", expectedVersion: granted.version });
    const extendInput = lifecycleInput(extendPreview, { adminUserId: adminId, requestKey: `membership-${suffix}-extend`, days: 5, note: "gate extension" });
    const extended = await executeMembership(extendInput, db);
    assert.equal(extended.version, 2);
    assert.equal(extended.expiresAt.getTime() - granted.expiresAt.getTime(), 5 * day);
    await assert.rejects(
      () => previewFor(adminId, targetId, "extend", { days: 1, expectedVersion: 1 }),
      (error: unknown) => serviceCode(error) === "MEMBERSHIP_PREVIEW_STALE",
    );

    const revokePreview = await previewFor(adminId, targetId, "revoke", { reason: "gate revoke", expectedVersion: extended.version });
    const revokeInput = lifecycleInput(revokePreview, { adminUserId: adminId, requestKey: `membership-${suffix}-revoke`, reason: "gate revoke", confirmationUsername: `membership_target_${suffix}` });
    const revoked = await executeMembership(revokeInput, db);
    assert.equal(revoked.version, 3);
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.revocationReason, "gate revoke");
    await assert.rejects(
      () => executeMembership({ ...revokeInput, confirmationUsername: "wrong" }, db),
      (error: unknown) => serviceCode(error) === "MEMBERSHIP_CONFIRMATION_REQUIRED",
    );

    const regrantPreview = await previewFor(adminId, targetId, "grant", { days: 7, note: "gate regrant", expectedVersion: revoked.version });
    const regrantInput = lifecycleInput(regrantPreview, { adminUserId: adminId, requestKey: `membership-${suffix}-regrant`, days: 7, note: "gate regrant" });
    const regranted = await executeMembership(regrantInput, db);
    assert.equal(regranted.version, 4);
    assert.equal(regranted.status, "active");
    assert.equal(regranted.revokedAt, null);
    assert.equal(regranted.revokedById, null);
    assert.equal(regranted.revocationReason, null);

    await createNearExpiryMembershipFixture(db, { adminId, userId: expiringTargetId, requestKey: `membership-${suffix}-near-expiry` });
    const edgePreview = await previewFor(adminId, expiringTargetId, "extend", { days: 1, note: "edge extension", expectedVersion: 1 });
    let releaseEdgeLock = () => {};
    let signalEdgeLock = () => {};
    const edgeLockHeld = new Promise<void>((resolve) => { signalEdgeLock = resolve; });
    const edgeLock = db.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${expiringTargetId}::text, 29082027))`);
      signalEdgeLock();
      await new Promise<void>((resolve) => { releaseEdgeLock = resolve; });
    });
    await edgeLockHeld;
    let edgeExecutionSettled = false;
    const edgeExecution = executeMembership(lifecycleInput(edgePreview, { adminUserId: adminId, requestKey: `membership-${suffix}-edge-execute`, days: 1, note: "edge extension" }), db).finally(() => { edgeExecutionSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(edgeExecutionSettled, false);
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    releaseEdgeLock();
    await edgeLock;
    await assert.rejects(
      () => edgeExecution,
      (error: unknown) => serviceCode(error) === "MEMBERSHIP_ACTION_CONFLICT",
    );

    // A live personal delegation and a selected personal route are explicit
    // blockers.  The gate resolves them through the delegation API before
    // retrying membership revoke, proving that the membership service never
    // silently cleans or switches personal configuration.
    await db.$transaction(async (tx) => {
      await tx.workspace.create({ data: { id: dependencyWorkspaceId, name: `Membership lifecycle ${suffix}`, slug: `membership-lifecycle-${suffix}`, createdById: targetId } });
      await tx.project.create({ data: { id: dependencyProjectId, workspaceId: dependencyWorkspaceId, name: `Membership dependency ${suffix}`, slug: `membership-dependency-${suffix}` } });
      await grantWorkspaceMembership(tx, { workspaceId: dependencyWorkspaceId, userId: secondAdminId, role: "owner", actorId: adminId, reason: "membership_lifecycle_gate_workspace_owner" });
      await grantWorkspaceMembership(tx, { workspaceId: dependencyWorkspaceId, userId: targetId, role: "member", actorId: adminId, reason: "membership_lifecycle_gate_workspace" });
      await grantProjectMembership(tx, { projectId: dependencyProjectId, workspaceId: dependencyWorkspaceId, userId: targetId, role: "owner", actorId: adminId, reason: "membership_lifecycle_gate_project" });
    });
    const assertDelegationDependencyBlock = async (
      label: string,
      requestCode: "draft" | "owner" | "active" | "expired",
      expectedDelegationCount: number,
      expectedSelectionCount: number,
    ): Promise<MembershipPreview> => {
      const preview = await previewFor(adminId, targetId, "revoke", { reason: `dependency ${label}`, expectedVersion: regranted.version });
      assert.equal(preview.canExecute, false);
      assert.equal(preview.dependencyStats.nonTerminalPersonalDelegations, expectedDelegationCount);
      assert.equal(preview.dependencyStats.effectivePersonalRouteSelections, expectedSelectionCount);
      const affectedProject = preview.dependencyStats.affectedProjects.find((project) => project.projectId === dependencyProjectId);
      assert.ok(affectedProject);
      assert.equal(affectedProject.nonTerminalPersonalDelegations, expectedDelegationCount);
      assert.equal(affectedProject.effectivePersonalRouteSelections, expectedSelectionCount);
      assert.ok(preview.blockingCategories.includes("non_terminal_personal_ai_delegation"));
      const beforeSubscription = await db.membershipSubscription.findUniqueOrThrow({ where: { userId: targetId } });
      const beforeAuditCount = await db.membershipSubscriptionAudit.count({ where: { userId: targetId, contractVersion: 2 } });
      const beforePreview = await db.membershipMutationPreview.findUniqueOrThrow({ where: { id: preview.previewId } });
      await assert.rejects(
        () => executeMembership(lifecycleInput(preview, {
          adminUserId: adminId,
          requestKey: `membership-${suffix}-dep-${requestCode}`,
          reason: `dependency ${label}`,
          confirmationUsername: `membership_target_${suffix}`,
        }), db),
        (error: unknown) => serviceCode(error) === "MEMBERSHIP_DEPENDENCY_RESOLUTION_REQUIRED",
      );
      const afterSubscription = await db.membershipSubscription.findUniqueOrThrow({ where: { userId: targetId } });
      assert.equal(afterSubscription.version, beforeSubscription.version);
      assert.equal(afterSubscription.status, beforeSubscription.status);
      assert.equal(afterSubscription.expiresAt.toISOString(), beforeSubscription.expiresAt.toISOString());
      assert.equal(await db.membershipSubscriptionAudit.count({ where: { userId: targetId, contractVersion: 2 } }), beforeAuditCount);
      const afterPreview = await db.membershipMutationPreview.findUniqueOrThrow({ where: { id: preview.previewId } });
      assert.equal(afterPreview.consumedAt?.toISOString() ?? null, beforePreview.consumedAt?.toISOString() ?? null);
      return preview;
    };
    const personalProvider = await createPersonalProviderConnection({
      name: `Membership lifecycle provider ${suffix}`,
      kind: "openai",
      apiKey: `membership-lifecycle-key-${suffix}`,
      generationModelId: "gpt-4.1-mini",
    }, targetActor, db);
    await db.aiProviderConnection.update({ where: { id: personalProvider.id }, data: { status: "verified", lastTestedAt: new Date() } });
    const delegation = await proposeProjectAiProviderDelegation(dependencyProjectId, {
      providerConnectionId: personalProvider.id,
      operation: "generateWithContext",
      maxOutputTokens: 128,
      expiresAt: new Date(Date.now() + day).toISOString(),
    }, targetActor, db);
    await assertDelegationDependencyBlock("draft", "draft", 1, 0);
    const ownerConfirmed = await confirmProjectAiProviderDelegationOwner(dependencyProjectId, delegation.id, { expectedVersion: delegation.version, acknowledgeProviderCharges: true }, targetActor, db);
    await assertDelegationDependencyBlock("owner-confirmed", "owner", 1, 0);
    const activeDelegation = await confirmProjectAiProviderDelegationProject(dependencyProjectId, delegation.id, { expectedVersion: ownerConfirmed.version, acknowledgeDataEgress: true, acknowledgeIndexImpact: true }, targetActor, db);
    await putProjectAiEffectiveRouteSelection(dependencyProjectId, "generateWithContext", { source: "personalDelegation", delegationId: activeDelegation.id, expectedVersion: null }, targetActor, db);

    const blockedRevokePreview = await assertDelegationDependencyBlock("active", "active", 1, 1);
    assert.equal(blockedRevokePreview.dependencyStats.affectedProjects.length, 1);
    assert.equal(blockedRevokePreview.dependencyStats.affectedProjects[0]?.projectId, dependencyProjectId);
    assert.equal(blockedRevokePreview.dependencyStats.affectedProjects[0]?.projectName, `Membership dependency ${suffix}`);
    assert.equal(blockedRevokePreview.dependencyStats.affectedProjects[0]?.nonTerminalPersonalDelegations, 1);
    assert.equal(blockedRevokePreview.dependencyStats.affectedProjects[0]?.effectivePersonalRouteSelections, 1);
    assert.ok(blockedRevokePreview.blockingCategories.includes("non_terminal_personal_ai_delegation"));
    assert.ok(blockedRevokePreview.blockingCategories.includes("effective_personal_route_selection"));
    const activeDelegationRecord = await db.projectAiProviderDelegation.findUniqueOrThrow({ where: { id: activeDelegation.id } });
    await revokeProjectAiProviderDelegation(dependencyProjectId, activeDelegation.id, { expectedVersion: activeDelegation.version, reason: "membership lifecycle gate explicit resolution", switchToPlatformDefault: true }, targetActor, db);
    const connectionOwnerAccountAccessVersion = activeDelegationRecord.connectionOwnerAccountAccessVersion;
    assert.ok(connectionOwnerAccountAccessVersion !== null, "MEMBERSHIP_LIFECYCLE_DELEGATION_OWNER_EPOCH_MISSING");
    const shortExpiryDraft = await db.$transaction(async (tx) => {
      const draft = await tx.projectAiProviderDelegation.create({
        data: {
          id: randomUUID(),
          projectId: dependencyProjectId,
          operation: "sourceSummary",
          providerConnectionId: activeDelegationRecord.providerConnectionId,
          connectionOwnerId: activeDelegationRecord.connectionOwnerId,
          connectionOwnerAccountAccessVersion,
          ownerProjectMembershipId: activeDelegationRecord.ownerProjectMembershipId,
          ownerMembershipCreatedAt: activeDelegationRecord.ownerMembershipCreatedAt,
          connectionOwnerSubscriptionId: activeDelegationRecord.connectionOwnerSubscriptionId,
          connectionOwnerSubscriptionVersion: activeDelegationRecord.connectionOwnerSubscriptionVersion,
          connectionOwnerSubscriptionStartsAt: activeDelegationRecord.connectionOwnerSubscriptionStartsAt,
          connectionOwnerSubscriptionExpiresAt: activeDelegationRecord.connectionOwnerSubscriptionExpiresAt,
          modelId: activeDelegationRecord.modelId,
          maxOutputTokens: activeDelegationRecord.maxOutputTokens,
          providerConfigurationVersion: activeDelegationRecord.providerConfigurationVersion,
          credentialFingerprint: activeDelegationRecord.credentialFingerprint,
          delegationFingerprint: activeDelegationRecord.delegationFingerprint,
          expiresAt: new Date(Date.now() + 20_000),
          proposedById: activeDelegationRecord.proposedById,
        },
      });
      await insertDelegationFixtureAudit(tx, draft, "proposed", null);
      return draft;
    });
    const shortExpiryOwnerConfirmed = await confirmProjectAiProviderDelegationOwner(dependencyProjectId, shortExpiryDraft.id, { expectedVersion: shortExpiryDraft.version, acknowledgeProviderCharges: true }, targetActor, db);
    const shortExpiryActive = await confirmProjectAiProviderDelegationProject(dependencyProjectId, shortExpiryDraft.id, { expectedVersion: shortExpiryOwnerConfirmed.version, acknowledgeDataEgress: true, acknowledgeIndexImpact: true }, targetActor, db);
    assert.equal(shortExpiryActive.status, "active");
    await new Promise((resolve) => setTimeout(resolve, 20_200));
    await assertDelegationDependencyBlock("expired-active", "expired", 1, 0);
    const expiredActiveRow = await db.$transaction(async (tx) => {
      const current = await tx.projectAiProviderDelegation.findUniqueOrThrow({ where: { id: shortExpiryActive.id } });
      assert.equal(current.status, "active");
      assert.ok(current.expiresAt.getTime() <= Date.now());
      const expired = await tx.projectAiProviderDelegation.update({
        where: { id: current.id },
        data: { version: current.version + 1, status: "expired" },
      });
      await insertDelegationFixtureAudit(tx, expired, "expired", "active");
      return expired;
    });
    assert.equal(expiredActiveRow.status, "expired");
    const resolvedRevokePreview = await previewFor(adminId, targetId, "revoke", { reason: "resolved revoke", expectedVersion: regranted.version });
    assert.equal(resolvedRevokePreview.canExecute, true);
    const resolvedRevoked = await executeMembership(lifecycleInput(resolvedRevokePreview, { adminUserId: adminId, requestKey: `membership-${suffix}-resolved-revoke`, reason: "resolved revoke", confirmationUsername: `membership_target_${suffix}` }), db);
    assert.equal(resolvedRevoked.status, "revoked");

    const disabledPreview = await previewFor(adminId, disabledAdminTargetId, "grant", { days: 1 });
    const tamperedIssuedAt = new Date(disabledPreview.previewIssuedAt.getTime() - 60 * 1_000);
    const extendedExpiry = new Date(tamperedIssuedAt.getTime() + 10 * 60 * 1_000);
    const tamperedFingerprint = membershipRequestFingerprint({
      userId: disabledPreview.user.id,
      action: "grant",
      days: 1,
      note: null,
      reason: null,
      expectedVersion: disabledPreview.current.version,
      impactFingerprint: disabledPreview.impactFingerprint,
      previewIssuedAt: tamperedIssuedAt,
      previewExpiresAt: extendedExpiry,
    });
    await assert.rejects(
      () => executeMembership({
        ...lifecycleInput(disabledPreview, { adminUserId: adminId, requestKey: `membership-${suffix}-extended-preview`, days: 1 }),
        requestFingerprint: tamperedFingerprint,
        previewIssuedAt: tamperedIssuedAt,
        previewExpiresAt: extendedExpiry,
      }, db),
      (error: unknown) => serviceCode(error) === "MEMBERSHIP_PREVIEW_EXPIRED",
    );
    await executeGovernedAccountAccess(db, {
      adminUserId: secondAdminId,
      userId: adminId,
      action: "disable",
      reason: "membership lifecycle gate",
      requestKey: `membership-${suffix}-disable-admin`,
    });
    await assert.rejects(
      () => executeMembership(lifecycleInput(disabledPreview, { adminUserId: adminId, requestKey: `membership-${suffix}-disabled`, days: 1 }), db),
      (error: unknown) => serviceCode(error) === "MEMBERSHIP_ADMIN_REQUIRED",
    );
    await executeGovernedAccountAccess(db, {
      adminUserId: secondAdminId,
      userId: adminId,
      action: "restore",
      reason: "membership lifecycle gate restore",
      requestKey: `membership-${suffix}-restore-admin`,
    });

    const concurrentPreviewOne = await previewFor(adminId, concurrentTargetId, "grant", { days: 10, note: "concurrent grant" });
    const concurrentPreviewTwo = await previewFor(secondAdminId, concurrentTargetId, "grant", { days: 10, note: "concurrent grant" });
    const concurrentResults = await Promise.allSettled([
      executeMembership(lifecycleInput(concurrentPreviewOne, { adminUserId: adminId, requestKey: `membership-${suffix}-concurrent-one`, days: 10, note: "concurrent grant" }), db),
      executeMembership(lifecycleInput(concurrentPreviewTwo, { adminUserId: secondAdminId, requestKey: `membership-${suffix}-concurrent-two`, days: 10, note: "concurrent grant" }), db),
    ]);
    assert.equal(concurrentResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(concurrentResults.filter((result) => result.status === "rejected").length, 1);
    const rejectedConcurrent = concurrentResults.find((result) => result.status === "rejected");
    assert.ok(rejectedConcurrent && rejectedConcurrent.status === "rejected");
    assert.ok(["MEMBERSHIP_CONFLICT", "MEMBERSHIP_PREVIEW_STALE", "MEMBERSHIP_ACTION_CONFLICT"].includes(serviceCode(rejectedConcurrent.reason) ?? ""));
    assert.equal(await db.membershipSubscription.count({ where: { userId: concurrentTargetId } }), 1);
    assert.equal(await db.membershipSubscriptionAudit.count({ where: { userId: concurrentTargetId, contractVersion: 2 } }), 1);

    const lifecycleAudits = await db.membershipSubscriptionAudit.findMany({ where: { userId: targetId, contractVersion: 2 }, orderBy: { versionAfter: "asc" } });
    assert.deepEqual(lifecycleAudits.map((audit) => audit.eventKind), ["grant", "extend", "revoke", "grant", "revoke"]);
    assert.deepEqual(lifecycleAudits.map((audit) => audit.versionAfter), [1, 2, 3, 4, 5]);
    assert.ok(lifecycleAudits.every((audit) => audit.requestKey !== null && audit.requestFingerprint !== null && audit.impactFingerprint !== null && audit.transactionId > BigInt(0)));
    assert.equal(lifecycleAudits[2]?.reason, "gate revoke");
    assert.equal(lifecycleAudits[2]?.revocationReasonAfter, "gate revoke");
    assert.equal(lifecycleAudits[4]?.reason, "resolved revoke");
    assert.equal(lifecycleAudits[4]?.revocationReasonAfter, "resolved revoke");

    const auditId = lifecycleAudits[0]!.id;
    await assert.rejects(
      () => db.membershipSubscriptionAudit.update({ where: { id: auditId }, data: { reason: "tampered" } }),
      (error: unknown) => error instanceof Error && /append-only/u.test(error.message),
    );
    await assert.rejects(
      () => db.membershipSubscriptionAudit.delete({ where: { id: auditId } }),
      (error: unknown) => error instanceof Error && /append-only/u.test(error.message),
    );
    await assert.rejects(
      () => db.membershipSubscription.create({
        data: {
          userId: rawOwnershipOtherTargetId,
          status: "active",
          startsAt: new Date(),
          expiresAt: new Date(Date.now() + day),
          grantedById: adminId,
        },
      }),
      (error: unknown) => error instanceof Error && /lifecycle context|grant transition|constraint/u.test(error.message),
    );
    await assert.rejects(
      () => db.$executeRaw(Prisma.sql`UPDATE "MembershipSubscription" SET "userId" = ${rawOwnershipOtherTargetId}::uuid WHERE "userId" = ${targetId}::uuid`),
      (error: unknown) => error instanceof Error && /ownership is immutable|constraint/u.test(error.message),
    );
    await assert.rejects(
      () => db.$executeRaw(Prisma.sql`DELETE FROM "MembershipSubscription" WHERE "userId" = ${targetId}::uuid`),
      (error: unknown) => error instanceof Error && /delete is forbidden|constraint/u.test(error.message),
    );
    const currentSubscription = await db.membershipSubscription.findUniqueOrThrow({ where: { userId: targetId } });
    const consumedPreviewId = lifecycleAudits[0]?.previewId;
    assert.ok(consumedPreviewId);
    await assert.rejects(
      () => db.$executeRaw(Prisma.sql`
        INSERT INTO "MembershipSubscriptionAudit" ("id", "subscriptionId", "userId", "actorId", "eventKind", "startsAt", "expiresAt", "note")
        VALUES (${randomUUID()}::uuid, ${currentSubscription.id}::uuid, ${targetId}::uuid, ${adminId}::uuid, 'revoke'::"MembershipAuditEventKind", ${currentSubscription.startsAt}, ${currentSubscription.expiresAt}, ${currentSubscription.note})
      `),
      (error: unknown) => error instanceof Error && /lifecycle context|check_violation/u.test(error.message),
    );
    const orphanRequestKey = `orphan-${suffix}`;
    const orphanRequestFingerprint = "a".repeat(64);
    const orphanImpactFingerprint = "b".repeat(64);
    await assert.rejects(
      () => db.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_context', '1', true)`);
        await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_actor_id', ${adminId}, true)`);
        await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_user_id', ${targetId}, true)`);
        await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_action', 'revoke', true)`);
        await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_request_key', ${orphanRequestKey}, true)`);
        await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_request_fingerprint', ${orphanRequestFingerprint}, true)`);
        await tx.$executeRaw(Prisma.sql`SELECT set_config('app.membership_lifecycle_impact_fingerprint', ${orphanImpactFingerprint}, true)`);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "MembershipSubscriptionAudit" (
            "id", "subscriptionId", "userId", "actorId", "eventKind", "startsAt", "expiresAt", "note",
            "versionBefore", "versionAfter", "statusBefore", "statusAfter", "startsAtBefore", "startsAtAfter",
            "expiresAtBefore", "expiresAtAfter", "revokedAtBefore", "revokedAtAfter", "revocationReasonBefore",
            "revocationReasonAfter", "noteBefore", "noteAfter", "grantedByIdBefore", "grantedByIdAfter",
            "revokedByIdBefore", "revokedByIdAfter", "reason", "requestKey", "requestFingerprint",
            "impactFingerprint", "previewId", "contractVersion"
          )
          SELECT ${randomUUID()}::uuid, subscription."id", subscription."userId", ${adminId}::uuid,
                 'revoke'::"MembershipAuditEventKind", subscription."startsAt", subscription."expiresAt", subscription."note",
                 subscription."version" - 1, subscription."version", 'active'::"MembershipSubscriptionStatus", subscription."status",
                 subscription."startsAt", subscription."startsAt", subscription."expiresAt", subscription."expiresAt",
                 NULL, subscription."revokedAt", NULL, subscription."revocationReason", subscription."note", subscription."note",
                 subscription."grantedById", subscription."grantedById", NULL, subscription."revokedById",
                 'orphan audit', ${orphanRequestKey}, ${orphanRequestFingerprint}, ${orphanImpactFingerprint}, ${consumedPreviewId}::uuid, 2
            FROM "MembershipSubscription" subscription
           WHERE subscription."id" = ${currentSubscription.id}::uuid
        `);
      }),
      (error: unknown) => error instanceof Error && /real lifecycle transition|lifecycle marker|lifecycle context/u.test(error.message),
    );
    await assert.rejects(
      () => db.membershipSubscription.update({ where: { userId: targetId }, data: { note: "direct lifecycle mutation", version: { increment: 1 } } }),
      (error: unknown) => error instanceof Error && /lifecycle context|constraint/u.test(error.message),
    );
  } finally {
    if (previousMasterKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousMasterKeyPath;
    await rm(masterKeyDirectory, { recursive: true, force: true }).catch(() => undefined);
    await db.$disconnect();
  }
});
