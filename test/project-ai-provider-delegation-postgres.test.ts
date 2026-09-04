import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma, type ProjectAiProviderDelegation } from "@prisma/client";
import { getDb } from "../src/lib/db";
import { grantProjectMembership, grantWorkspaceMembership, revokeProjectMembership } from "../src/lib/membership-governance";
import { lockActorAccess } from "../src/lib/access-linearization";
import {
  confirmProjectAiProviderDelegationOwner,
  confirmProjectAiProviderDelegationProject,
  getProjectAiProviderDelegation,
  listProjectAiProviderDelegations,
  proposeProjectAiProviderDelegation,
  putProjectAiEffectiveRouteSelection,
  revokeProjectAiProviderDelegation,
} from "../src/lib/project-ai-provider-delegation-service";
import {
  PersonalProviderServiceError,
  updatePersonalProviderConnection,
} from "../src/lib/personal-ai-provider-service";

const shouldRun = process.env.PROJECT_AI_PROVIDER_DELEGATION_POSTGRES_GATE === "1";
const testDatabaseName = "ai_project_os_project_ai_provider_delegation_test";
const defaultWorkspaceId = "00000000-0000-4000-8000-000000000001";
const seededAdminId = "00000000-0000-4000-8000-000000000010";

function assertDisposableGateDatabase(): void {
  const configuredUrl = process.env.DATABASE_URL;
  if (typeof configuredUrl !== "string" || configuredUrl.length === 0) {
    throw new Error("PROJECT_AI_PROVIDER_DELEGATION_TEST_DATABASE_URL_REQUIRED");
  }
  let parsed: URL;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new Error("PROJECT_AI_PROVIDER_DELEGATION_TEST_DATABASE_URL_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== `/${testDatabaseName}`
    || parsed.username !== "ai_project_os_gate"
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw new Error("PROJECT_AI_PROVIDER_DELEGATION_TEST_DATABASE_URL_INVALID");
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name} ${error.message}` : String(error);
}

function isSerializationConflict(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "P2034") return true;
  return errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_LOCK_BUSY");
}

type DelegationSnapshot = Pick<
  ProjectAiProviderDelegation,
  | "id"
  | "projectId"
  | "operation"
  | "version"
  | "status"
  | "providerConnectionId"
  | "connectionOwnerId"
  | "ownerProjectMembershipId"
  | "ownerMembershipCreatedAt"
  | "projectConfirmedById"
  | "projectConfirmedAt"
  | "projectConfirmedProjectMembershipId"
  | "projectConfirmedMembershipCreatedAt"
  | "ownerConfirmedAt"
  | "connectionOwnerSubscriptionId"
  | "connectionOwnerSubscriptionVersion"
  | "connectionOwnerSubscriptionStartsAt"
  | "connectionOwnerSubscriptionExpiresAt"
  | "modelId"
  | "embeddingDimensions"
  | "maxOutputTokens"
  | "providerConfigurationVersion"
  | "credentialFingerprint"
  | "delegationFingerprint"
  | "proposedById"
  | "proposedAt"
  | "activatedAt"
  | "rejectedAt"
  | "revokedAt"
  | "expiredAt"
  | "terminalActorKind"
  | "terminalActorId"
  | "terminalActorProjectMembershipId"
  | "terminalActorMembershipCreatedAt"
  | "terminalReason"
>;

type AiOperation = DelegationSnapshot["operation"];

async function insertDelegationAudit(
  tx: Prisma.TransactionClient,
  delegation: DelegationSnapshot,
  action: "proposed" | "ownerConfirmed" | "activated" | "rejected" | "revoked" | "expired",
  actorId: string | null,
  statusBefore: "draft" | "ownerConfirmed" | "active" | null,
  createdAtValue?: Date,
): Promise<void> {
  const terminalAction = action === "rejected" || action === "revoked" || action === "expired";
  const systemExpiry = action === "expired";
  const actorMembershipId = action === "activated"
    ? delegation.projectConfirmedProjectMembershipId
    : terminalAction
      ? delegation.terminalActorProjectMembershipId
      : delegation.ownerProjectMembershipId;
  const actorMembershipCreatedAt = action === "activated"
    ? delegation.projectConfirmedMembershipCreatedAt
    : terminalAction
      ? delegation.terminalActorMembershipCreatedAt
      : delegation.ownerMembershipCreatedAt;
  const transitionAt = action === "proposed"
    ? delegation.proposedAt
    : action === "ownerConfirmed"
      ? delegation.ownerConfirmedAt
      : action === "activated"
        ? delegation.activatedAt
        : action === "rejected"
          ? delegation.rejectedAt
          : action === "revoked"
            ? delegation.revokedAt
            : delegation.expiredAt;
  if ((!systemExpiry && (!actorId || !actorMembershipId || !actorMembershipCreatedAt)) || !transitionAt) {
    throw new Error("DELEGATION_AUDIT_FIXTURE_SNAPSHOT_INCOMPLETE");
  }
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
      actorKind: systemExpiry ? "systemExpiry" : "user",
      actorId: systemExpiry ? null : actorId,
      actorProjectMembershipId: systemExpiry ? null : actorMembershipId,
      actorMembershipCreatedAt: systemExpiry ? null : actorMembershipCreatedAt,
      reason: systemExpiry ? "system_expiry" : terminalAction ? delegation.terminalReason ?? `delegation_${action}` : `delegation_${action}`,
      transitionAt,
      createdAt: createdAtValue,
    },
  });
}

async function insertSelectionAudit(
  tx: Prisma.TransactionClient,
  input: {
    id: string;
    projectId: string;
    operation: "embedding" | "visionExtract" | "autoExtract" | "sourceSummary" | "projectAnalysis" | "generateWithContext";
    source: "platformDefault" | "personalDelegation";
    delegationId: string | null;
    selectedById: string;
    selectedByProjectMembershipId: string;
    selectedByMembershipCreatedAt: Date;
    version: number;
    createdAt: Date;
    updatedAt: Date;
  },
  action: "platformSelected" | "personalSelected" | "selectionUpdated",
  createdAtValue?: Date,
): Promise<void> {
  await tx.projectAiProviderDelegationAudit.create({
    data: {
      id: randomUUID(),
      projectId: input.projectId,
      operation: input.operation,
      entity: "selection",
      action,
      selectionId: input.id,
      selectionVersion: input.version,
      selectionSource: input.source,
      selectedDelegationId: input.delegationId,
      selectedByProjectMembershipId: input.selectedByProjectMembershipId,
      selectedByMembershipCreatedAt: input.selectedByMembershipCreatedAt,
      actorId: input.selectedById,
      actorProjectMembershipId: input.selectedByProjectMembershipId,
      actorMembershipCreatedAt: input.selectedByMembershipCreatedAt,
      reason: `selection_${action}`,
      transitionAt: input.version === 1 ? input.createdAt : input.updatedAt,
      createdAt: createdAtValue,
    },
  });
}

test(
  "WP05B1 project personal-model delegation is double-confirmed, audited, and fail-closed",
  { skip: !shouldRun ? "PROJECT_AI_PROVIDER_DELEGATION_POSTGRES_GATE=1 is required" : false },
  async () => {
    assertDisposableGateDatabase();
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const connectionOwnerId = randomUUID();
    const projectOwnerId = randomUUID();
    const nonOwnerEditorId = randomUUID();
    const freeEditorId = randomUUID();
    const expiredEditorId = randomUUID();
    const adminEditorId = randomUUID();
    const projectId = randomUUID();
    const providerId = randomUUID();
    const credentialId = randomUUID();
    const foreignProviderId = randomUUID();
    const foreignCredentialId = randomUUID();
    const fingerprint = "a".repeat(64);
    const foreignFingerprint = "f".repeat(64);
    const delegationFingerprint = "b".repeat(64);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000);

    await db.appUser.createMany({
      data: [
        { id: connectionOwnerId, username: `delegation_owner_${suffix}`, role: "user" },
        { id: projectOwnerId, username: `delegation_project_owner_${suffix}`, role: "user" },
        { id: nonOwnerEditorId, username: `delegation_other_editor_${suffix}`, role: "user" },
        { id: freeEditorId, username: `delegation_free_editor_${suffix}`, role: "user" },
        { id: expiredEditorId, username: `delegation_expired_editor_${suffix}`, role: "user" },
        { id: adminEditorId, username: `delegation_admin_editor_${suffix}`, role: "admin" },
      ],
    });
    const ownerSubscription = await db.membershipSubscription.create({
      data: {
        userId: connectionOwnerId,
        status: "active",
        startsAt: new Date(now.getTime() - 60_000),
        expiresAt,
        grantedById: seededAdminId,
      },
    });
    const expiredSubscription = await db.membershipSubscription.create({
      data: {
        userId: expiredEditorId,
        status: "active",
        startsAt: new Date(now.getTime() - 120_000),
        expiresAt: new Date(now.getTime() - 60_000),
        grantedById: seededAdminId,
      },
    });
    await db.project.create({ data: { id: projectId, workspaceId: defaultWorkspaceId, name: `Delegation ${suffix}`, slug: `delegation-${suffix}` } });
    await db.$transaction(async (tx) => {
      await grantWorkspaceMembership(tx, {
        workspaceId: defaultWorkspaceId,
        userId: connectionOwnerId,
        role: "member",
        actorId: seededAdminId,
        reason: "delegation_gate_workspace_owner",
      });
      await grantWorkspaceMembership(tx, {
        workspaceId: defaultWorkspaceId,
        userId: projectOwnerId,
        role: "member",
        actorId: seededAdminId,
        reason: "delegation_gate_project_owner",
      });
      await grantProjectMembership(tx, {
        projectId,
        workspaceId: defaultWorkspaceId,
        userId: connectionOwnerId,
        role: "editor",
        actorId: seededAdminId,
        reason: "delegation_gate_connection_owner",
      });
      await grantProjectMembership(tx, {
        projectId,
        workspaceId: defaultWorkspaceId,
        userId: projectOwnerId,
        role: "owner",
        actorId: seededAdminId,
        reason: "delegation_gate_project_owner",
      });
      for (const [userId, reason] of [
        [nonOwnerEditorId, "delegation_gate_other_editor"],
        [freeEditorId, "delegation_gate_free_editor"],
        [expiredEditorId, "delegation_gate_expired_editor"],
        [adminEditorId, "delegation_gate_admin_editor"],
      ] as const) {
        await grantWorkspaceMembership(tx, {
          workspaceId: defaultWorkspaceId,
          userId,
          role: "member",
          actorId: seededAdminId,
          reason,
        });
        await grantProjectMembership(tx, {
          projectId,
          workspaceId: defaultWorkspaceId,
          userId,
          role: "editor",
          actorId: seededAdminId,
          reason,
        });
      }
    });
    const ownerMembership = await db.projectMembership.findFirstOrThrow({
      where: { projectId, userId: connectionOwnerId },
    });
    const projectOwnerMembership = await db.projectMembership.findFirstOrThrow({
      where: { projectId, userId: projectOwnerId },
    });
    await db.externalCredential.create({
      data: {
        id: credentialId,
        kind: "aiProvider",
        ciphertext: Buffer.from([1]),
        nonce: Buffer.from([2]),
        authTag: Buffer.from([3]),
        maskedSuffix: "gate",
        secretFingerprint: fingerprint,
      },
    });
    await db.aiProviderConnection.create({
      data: {
        id: providerId,
        name: `Personal delegation provider ${suffix}`,
        kind: "openai",
        scope: "user",
        ownerUserId: connectionOwnerId,
        ownershipState: "confirmed",
        protocol: "chatCompletions",
        baseUrl: "https://api.openai.com/v1",
        credentialId,
        defaultGenerationModelId: "gpt-4.1-mini",
        defaultVisionModelId: "gpt-4.1-mini",
        status: "verified",
        lastTestedAt: now,
      },
    });
    await db.externalCredential.create({
      data: {
        id: foreignCredentialId,
        kind: "aiProvider",
        ciphertext: Buffer.from([4]),
        nonce: Buffer.from([5]),
        authTag: Buffer.from([6]),
        maskedSuffix: "foreign",
        secretFingerprint: foreignFingerprint,
      },
    });
    await db.aiProviderConnection.create({
      data: {
        id: foreignProviderId,
        name: `Foreign delegation provider ${suffix}`,
        kind: "openai",
        scope: "user",
        ownerUserId: projectOwnerId,
        ownershipState: "confirmed",
        protocol: "chatCompletions",
        baseUrl: "https://api.openai.com/v1",
        credentialId: foreignCredentialId,
        defaultGenerationModelId: "gpt-4.1-mini",
        defaultVisionModelId: "gpt-4.1-mini",
        status: "verified",
        lastTestedAt: now,
      },
    });

    const proposalExpiresAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    for (const providerConnectionId of [providerId, foreignProviderId, randomUUID()]) {
      await assert.rejects(
        () => proposeProjectAiProviderDelegation(
          projectId,
          { providerConnectionId, operation: "autoExtract", expiresAt: proposalExpiresAt },
          { id: freeEditorId, role: "user" },
          db,
        ),
        (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_MEMBERSHIP_REQUIRED"),
      );
      await assert.rejects(
        () => proposeProjectAiProviderDelegation(
          projectId,
          { providerConnectionId, operation: "autoExtract", expiresAt: proposalExpiresAt },
          { id: expiredEditorId, role: "user" },
          db,
        ),
        (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_MEMBERSHIP_EXPIRED"),
      );
      await assert.rejects(
        () => proposeProjectAiProviderDelegation(
          projectId,
          { providerConnectionId, operation: "autoExtract", expiresAt: proposalExpiresAt },
          { id: adminEditorId, role: "admin" },
          db,
        ),
        (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_MEMBERSHIP_REQUIRED"),
      );
    }
    assert.equal(expiredSubscription.status, "active");
    await assert.rejects(
      () => proposeProjectAiProviderDelegation(
        projectId,
        { providerConnectionId: providerId, operation: "embedding", maxOutputTokens: 128, expiresAt: proposalExpiresAt },
        { id: connectionOwnerId, role: "user" },
        db,
      ),
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_INVALID_INPUT"),
    );

    const createDraft = async (
      operation: AiOperation = "projectAnalysis",
      modelId = "gpt-4.1-mini",
      maxOutputTokens = 2048,
      providerConfigurationVersion = 1,
      delegationFingerprintValue = delegationFingerprint,
      options: {
        expiresAt?: Date;
        proposedAt?: Date;
        auditCreatedAt?: Date;
        providerConnectionId?: string;
        credentialFingerprint?: string;
        ownerProjectMembershipId?: string;
        ownerMembershipCreatedAt?: Date;
        subscriptionVersion?: number;
        subscriptionStartsAt?: Date;
        subscriptionExpiresAt?: Date;
        terminalActorKind?: "user" | "systemExpiry";
      } = {},
    ): Promise<ProjectAiProviderDelegation> => db.$transaction(async (tx) => {
      const draft = await tx.projectAiProviderDelegation.create({
        data: {
          id: randomUUID(),
          projectId,
          operation,
          providerConnectionId: options.providerConnectionId ?? providerId,
          connectionOwnerId,
          ownerProjectMembershipId: options.ownerProjectMembershipId ?? ownerMembership.id,
          ownerMembershipCreatedAt: options.ownerMembershipCreatedAt ?? ownerMembership.createdAt,
          connectionOwnerSubscriptionId: ownerSubscription.id,
          connectionOwnerSubscriptionVersion: options.subscriptionVersion ?? ownerSubscription.version,
          connectionOwnerSubscriptionStartsAt: options.subscriptionStartsAt ?? ownerSubscription.startsAt,
          connectionOwnerSubscriptionExpiresAt: options.subscriptionExpiresAt ?? ownerSubscription.expiresAt,
          modelId,
          maxOutputTokens,
          providerConfigurationVersion,
          credentialFingerprint: options.credentialFingerprint ?? fingerprint,
          delegationFingerprint: delegationFingerprintValue,
          expiresAt: options.expiresAt ?? expiresAt,
          proposedById: connectionOwnerId,
          proposedAt: options.proposedAt,
          terminalActorKind: options.terminalActorKind,
        },
      });
      await insertDelegationAudit(tx, draft, "proposed", connectionOwnerId, null, options.auditCreatedAt);
      return draft;
    });

    await db.appUser.update({
      where: { id: connectionOwnerId },
      data: { disabledAt: new Date(), disabledReason: "delegation_gate_disabled_owner" },
    });
    await assert.rejects(
      () => createDraft("projectAnalysis"),
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_LIVE_OWNER_INVALID"),
    );
    await db.appUser.update({ where: { id: connectionOwnerId }, data: { disabledAt: null, disabledReason: null } });

    await assert.rejects(
      () => createDraft("visionExtract", "gpt-4.1-mini", 2048, 1, delegationFingerprint, {
        providerConnectionId: foreignProviderId,
        credentialFingerprint: foreignFingerprint,
      }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_LIVE_PROVIDER_INVALID"),
    );
    await assert.rejects(
      () => createDraft("autoExtract", "gpt-4.1-mini", 2048, 2),
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_LIVE_PROVIDER_INVALID"),
    );
    await assert.rejects(
      () => createDraft("sourceSummary", "gpt-4.1-mini", 2048, 1, delegationFingerprint, {
        credentialFingerprint: "c".repeat(64),
      }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_LIVE_PROVIDER_INVALID"),
    );
    await assert.rejects(
      () => createDraft("generateWithContext", "gpt-4.1-mini", 2048, 1, delegationFingerprint, {
        ownerMembershipCreatedAt: new Date(ownerMembership.createdAt.getTime() + 1),
      }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_LIVE_OWNER_INVALID"),
    );
    await assert.rejects(
      () => createDraft("projectAnalysis", "gpt-4.1-mini", 2048, 1, delegationFingerprint, {
        subscriptionExpiresAt: new Date(now.getTime() - 1_000),
      }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_LIVE_OWNER_INVALID"),
    );
    const rejectDelegation = async (delegationId: string): Promise<ProjectAiProviderDelegation> => db.$transaction(async (tx) => {
      const current = await tx.projectAiProviderDelegation.findUniqueOrThrow({ where: { id: delegationId } });
      if (current.status !== "draft" && current.status !== "ownerConfirmed") {
        throw new Error("DELEGATION_FIXTURE_REJECTION_STATE_INVALID");
      }
      const row = await tx.projectAiProviderDelegation.update({
        where: { id: delegationId },
        data: {
          version: current.version + 1,
          status: "rejected",
          rejectedAt: new Date(Date.now() + 10_000),
          terminalActorId: connectionOwnerId,
          terminalActorProjectMembershipId: ownerMembership.id,
          terminalActorMembershipCreatedAt: ownerMembership.createdAt,
          terminalReason: "fixture_explicit_rejection",
        },
      });
      await insertDelegationAudit(tx, row, "rejected", connectionOwnerId, current.status);
      return row;
    });
    const expireDelegation = async (
      delegationId: string,
      statusBefore: "draft" | "ownerConfirmed" | "active",
    ): Promise<ProjectAiProviderDelegation> => db.$transaction(async (tx) => {
      const current = await tx.projectAiProviderDelegation.findUniqueOrThrow({ where: { id: delegationId } });
      assert.equal(current.status, statusBefore);
      const row = await tx.projectAiProviderDelegation.update({
        where: { id: delegationId },
        data: { version: current.version + 1, status: "expired" },
      });
      await insertDelegationAudit(tx, row, "expired", null, statusBefore);
      return row;
    });
    const waitForExpiry = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));

    const fakeEventTime = new Date("2099-01-01T00:00:00.000Z");
    const timeProbe = await createDraft("autoExtract", "gpt-4.1-mini", 2048, 1, delegationFingerprint, {
      proposedAt: fakeEventTime,
      auditCreatedAt: fakeEventTime,
    });
    assert.notEqual(timeProbe.proposedAt.getTime(), fakeEventTime.getTime());
    const timeProbeProposalAudit = await db.projectAiProviderDelegationAudit.findFirstOrThrow({
      where: { delegationId: timeProbe.id, delegationVersion: 1 },
    });
    assert.equal(timeProbeProposalAudit.transitionAt.getTime(), timeProbe.proposedAt.getTime());
    assert.notEqual(timeProbeProposalAudit.createdAt.getTime(), fakeEventTime.getTime());
    const timeProbeOwnerConfirmed = await db.$transaction(async (tx) => {
      const row = await tx.projectAiProviderDelegation.update({
        where: { id: timeProbe.id },
        data: {
          version: 2,
          status: "ownerConfirmed",
          ownerConfirmedById: connectionOwnerId,
          ownerConfirmedAt: fakeEventTime,
        },
      });
      await insertDelegationAudit(tx, row, "ownerConfirmed", connectionOwnerId, "draft", fakeEventTime);
      return row;
    });
    assert.notEqual(timeProbeOwnerConfirmed.ownerConfirmedAt?.getTime(), fakeEventTime.getTime());
    const rejectedTimeProbe = await rejectDelegation(timeProbeOwnerConfirmed.id);
    assert.notEqual(rejectedTimeProbe.rejectedAt?.getTime(), fakeEventTime.getTime());
    const timeProbeTerminalAudit = await db.projectAiProviderDelegationAudit.findFirstOrThrow({
      where: { delegationId: timeProbe.id, delegationVersion: 3 },
    });
    assert.equal(timeProbeTerminalAudit.transitionAt.getTime(), rejectedTimeProbe.rejectedAt?.getTime());

    for (const terminalActorKind of ["user", "systemExpiry"] as const) {
      await assert.rejects(
        () => createDraft("autoExtract", "gpt-4.1-mini", 2048, 1, delegationFingerprint, { terminalActorKind }),
        (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_STATE_INVALID"),
      );
    }
    const terminalActorShapeProbe = await createDraft("autoExtract");
    await rejectDelegation(terminalActorShapeProbe.id);

    const draft = await createDraft();
    const ownerConfirmed = await db.$transaction(async (tx) => {
      const row = await tx.projectAiProviderDelegation.update({
        where: { id: draft.id },
        data: {
          version: 2,
          status: "ownerConfirmed",
          ownerConfirmedById: connectionOwnerId,
          ownerConfirmedAt: new Date(now.getTime() + 1_000),
        },
      });
      await insertDelegationAudit(tx, row, "ownerConfirmed", connectionOwnerId, "draft");
      return row;
    });
    const active = await db.$transaction(async (tx) => {
      const row = await tx.projectAiProviderDelegation.update({
        where: { id: draft.id },
        data: {
          version: 3,
          status: "active",
          projectConfirmedById: projectOwnerId,
          projectConfirmedAt: new Date(now.getTime() + 2_000),
          projectConfirmedProjectMembershipId: projectOwnerMembership.id,
          projectConfirmedMembershipCreatedAt: projectOwnerMembership.createdAt,
          activatedAt: new Date(now.getTime() + 3_000),
        },
      });
      await insertDelegationAudit(tx, row, "activated", projectOwnerId, "ownerConfirmed");
      return row;
    });
    assert.equal(active.status, "active");
    assert.equal(ownerConfirmed.version, 2);
    assert.equal(await db.projectAiProviderDelegationAudit.count({ where: { delegationId: draft.id } }), 3);

    const fakeSelectionCreatedAt = new Date("2000-01-01T00:00:00.000Z");
    const fakeSelectionUpdatedAt = new Date("2099-01-01T00:00:00.000Z");
    const selection = await db.$transaction(async (tx) => {
      const row = await tx.projectAiEffectiveRouteSelection.create({
        data: {
          id: randomUUID(),
          projectId,
          operation: "projectAnalysis",
          source: "personalDelegation",
          delegationId: active.id,
          selectedById: projectOwnerId,
          selectedByProjectMembershipId: projectOwnerMembership.id,
          selectedByMembershipCreatedAt: projectOwnerMembership.createdAt,
          createdAt: fakeSelectionCreatedAt,
          updatedAt: fakeSelectionUpdatedAt,
        },
      });
      await insertSelectionAudit(tx, row, "personalSelected");
      return row;
    });
    assert.equal(selection.version, 1);
    assert.notEqual(selection.createdAt.getTime(), fakeSelectionCreatedAt.getTime());
    assert.notEqual(selection.updatedAt.getTime(), fakeSelectionUpdatedAt.getTime());
    assert.equal(selection.createdAt.getTime(), selection.updatedAt.getTime());
    const selectionCreationAudit = await db.projectAiProviderDelegationAudit.findFirstOrThrow({
      where: { selectionId: selection.id, selectionVersion: 1 },
    });
    assert.equal(selectionCreationAudit.transitionAt.getTime(), selection.createdAt.getTime());
    assert.notEqual(selectionCreationAudit.createdAt.getTime(), fakeSelectionUpdatedAt.getTime());

    const fakeSelectionUpdateAt = new Date("2099-02-01T00:00:00.000Z");
    const platformSelection = await db.$transaction(async (tx) => {
      const row = await tx.projectAiEffectiveRouteSelection.update({
        where: { id: selection.id },
        data: {
          version: 2,
          source: "platformDefault",
          delegationId: null,
          updatedAt: fakeSelectionUpdateAt,
        },
      });
      await insertSelectionAudit(tx, row, "selectionUpdated");
      return row;
    });
    assert.equal(platformSelection.source, "platformDefault");
    assert.equal(platformSelection.delegationId, null);
    assert.notEqual(platformSelection.updatedAt.getTime(), fakeSelectionUpdateAt.getTime());
    assert.ok(platformSelection.updatedAt.getTime() >= selection.updatedAt.getTime());
    const selectionUpdateAudit = await db.projectAiProviderDelegationAudit.findFirstOrThrow({
      where: { selectionId: selection.id, selectionVersion: 2 },
    });
    assert.equal(selectionUpdateAudit.transitionAt.getTime(), platformSelection.updatedAt.getTime());
    assert.notEqual(selectionUpdateAudit.createdAt.getTime(), fakeSelectionUpdateAt.getTime());

    const expiringDraft = await createDraft("autoExtract", "gpt-4.1-mini", 2048, 1, delegationFingerprint, {
      expiresAt: new Date(Date.now() + 250),
    });
    await waitForExpiry();
    const expiredDraft = await expireDelegation(expiringDraft.id, "draft");
    assert.equal(expiredDraft.status, "expired");
    assert.equal(expiredDraft.terminalActorKind, "systemExpiry");
    assert.equal(expiredDraft.terminalActorId, null);
    assert.equal(expiredDraft.ownerConfirmedById, null);
    const replacementDraft = await createDraft("autoExtract");
    await rejectDelegation(replacementDraft.id);

    const expiringOwnerConfirmed = await createDraft("sourceSummary", "gpt-4.1-mini", 2048, 1, delegationFingerprint, {
      expiresAt: new Date(Date.now() + 250),
    });
    const expiringOwnerConfirmedRow = await db.$transaction(async (tx) => {
      const row = await tx.projectAiProviderDelegation.update({
        where: { id: expiringOwnerConfirmed.id },
        data: {
          version: 2,
          status: "ownerConfirmed",
          ownerConfirmedById: connectionOwnerId,
          ownerConfirmedAt: new Date(now.getTime() + 1_000),
        },
      });
      await insertDelegationAudit(tx, row, "ownerConfirmed", connectionOwnerId, "draft");
      return row;
    });
    await waitForExpiry();
    const expiredOwnerConfirmed = await expireDelegation(expiringOwnerConfirmedRow.id, "ownerConfirmed");
    assert.equal(expiredOwnerConfirmed.status, "expired");
    assert.equal(expiredOwnerConfirmed.ownerConfirmedById, connectionOwnerId);
    assert.equal(expiredOwnerConfirmed.projectConfirmedById, null);
    const replacementOwnerConfirmed = await createDraft("sourceSummary");
    await rejectDelegation(replacementOwnerConfirmed.id);

    const expiringActive = await createDraft("visionExtract", "gpt-4.1-mini", 2048, 1, delegationFingerprint, {
      expiresAt: new Date(Date.now() + 250),
    });
    const expiringOwnerConfirmedActive = await db.$transaction(async (tx) => {
      const row = await tx.projectAiProviderDelegation.update({
        where: { id: expiringActive.id },
        data: {
          version: 2,
          status: "ownerConfirmed",
          ownerConfirmedById: connectionOwnerId,
          ownerConfirmedAt: new Date(now.getTime() + 1_000),
        },
      });
      await insertDelegationAudit(tx, row, "ownerConfirmed", connectionOwnerId, "draft");
      return row;
    });
    const expiringActiveRow = await db.$transaction(async (tx) => {
      const row = await tx.projectAiProviderDelegation.update({
        where: { id: expiringOwnerConfirmedActive.id },
        data: {
          version: 3,
          status: "active",
          projectConfirmedById: projectOwnerId,
          projectConfirmedAt: new Date(now.getTime() + 2_000),
          projectConfirmedProjectMembershipId: projectOwnerMembership.id,
          projectConfirmedMembershipCreatedAt: projectOwnerMembership.createdAt,
          activatedAt: new Date(now.getTime() + 3_000),
        },
      });
      await insertDelegationAudit(tx, row, "activated", projectOwnerId, "ownerConfirmed");
      return row;
    });
    const expiringSelection = await db.$transaction(async (tx) => {
      const row = await tx.projectAiEffectiveRouteSelection.create({
        data: {
          id: randomUUID(),
          projectId,
          operation: "visionExtract",
          source: "personalDelegation",
          delegationId: expiringActiveRow.id,
          selectedById: projectOwnerId,
          selectedByProjectMembershipId: projectOwnerMembership.id,
          selectedByMembershipCreatedAt: projectOwnerMembership.createdAt,
        },
      });
      await insertSelectionAudit(tx, row, "personalSelected");
      return row;
    });
    await db.$transaction(async (tx) => {
      const row = await tx.projectAiEffectiveRouteSelection.update({
        where: { id: expiringSelection.id },
        data: { version: 2, source: "platformDefault", delegationId: null },
      });
      await insertSelectionAudit(tx, row, "selectionUpdated");
    });
    await waitForExpiry();
    const expiredActive = await expireDelegation(expiringActiveRow.id, "active");
    assert.equal(expiredActive.status, "expired");
    const replacementActive = await createDraft("visionExtract");
    await rejectDelegation(replacementActive.id);

    await assert.rejects(
      () => db.$transaction(async (tx) => {
        const row = await tx.projectAiEffectiveRouteSelection.update({
          where: { id: platformSelection.id },
          data: {
            version: 3,
            selectedById: connectionOwnerId,
            selectedByProjectMembershipId: ownerMembership.id,
            selectedByMembershipCreatedAt: ownerMembership.createdAt,
          },
        });
        await insertSelectionAudit(tx, row, "selectionUpdated");
      }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_OWNER_INVALID"),
    );

    const ownerConfirmedOnly = await createDraft("sourceSummary", "gpt-4.1-mini", 2048);
    await db.$transaction(async (tx) => {
      const row = await tx.projectAiProviderDelegation.update({
        where: { id: ownerConfirmedOnly.id },
        data: {
          version: 2,
          status: "ownerConfirmed",
          ownerConfirmedById: connectionOwnerId,
          ownerConfirmedAt: new Date(now.getTime() + 1_000),
        },
      });
      await insertDelegationAudit(tx, row, "ownerConfirmed", connectionOwnerId, "draft");
    });
    await assert.rejects(
      () => db.$transaction(async (tx) => {
        const row = await tx.projectAiEffectiveRouteSelection.create({
          data: {
            id: randomUUID(),
            projectId,
            operation: "sourceSummary",
            source: "personalDelegation",
            delegationId: ownerConfirmedOnly.id,
            selectedById: projectOwnerId,
            selectedByProjectMembershipId: projectOwnerMembership.id,
            selectedByMembershipCreatedAt: projectOwnerMembership.createdAt,
          },
        });
        await insertSelectionAudit(tx, row, "personalSelected");
      }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_DELEGATION_INVALID"),
    );

    const rejectedOwnerConfirmed = await db.$transaction(async (tx) => {
      const row = await tx.projectAiProviderDelegation.update({
        where: { id: ownerConfirmedOnly.id },
        data: {
          version: 3,
          status: "rejected",
          rejectedAt: new Date(now.getTime() + 4_000),
          terminalActorId: connectionOwnerId,
          terminalActorProjectMembershipId: ownerMembership.id,
          terminalActorMembershipCreatedAt: ownerMembership.createdAt,
          terminalReason: "owner_cancelled_before_project_confirmation",
        },
      });
      await insertDelegationAudit(tx, row, "rejected", connectionOwnerId, "ownerConfirmed");
      return row;
    });
    assert.equal(rejectedOwnerConfirmed.status, "rejected");
    assert.equal(rejectedOwnerConfirmed.terminalReason, "owner_cancelled_before_project_confirmation");

    await assert.rejects(
      () => createDraft("autoExtract", "gpt-4.1-mini", 2048, 2, "c".repeat(64)),
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_LIVE_PROVIDER_INVALID"),
    );

    const statusAuditMissing = await createDraft("sourceSummary", "gpt-4.1-mini", 2048);
    await assert.rejects(
      () => db.$transaction(async (tx) => {
        await tx.projectAiProviderDelegation.update({
          where: { id: statusAuditMissing.id },
          data: {
            version: 2,
            status: "ownerConfirmed",
            ownerConfirmedById: connectionOwnerId,
            ownerConfirmedAt: new Date(now.getTime() + 1_000),
          },
        });
      }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_AUDIT_REQUIRED"),
    );

    await assert.rejects(
      () => db.$transaction(async (tx) => {
        await tx.projectAiEffectiveRouteSelection.create({
          data: {
            id: randomUUID(),
            projectId,
            operation: "embedding",
            source: "platformDefault",
            selectedById: projectOwnerId,
            selectedByProjectMembershipId: projectOwnerMembership.id,
            selectedByMembershipCreatedAt: projectOwnerMembership.createdAt,
          },
        });
      }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_AUDIT_REQUIRED"),
    );

    const selectionAuditMissing = await db.$transaction(async (tx) => {
      const row = await tx.projectAiEffectiveRouteSelection.create({
        data: {
          id: randomUUID(),
          projectId,
          operation: "sourceSummary",
          source: "platformDefault",
          selectedById: projectOwnerId,
          selectedByProjectMembershipId: projectOwnerMembership.id,
          selectedByMembershipCreatedAt: projectOwnerMembership.createdAt,
        },
      });
      await insertSelectionAudit(tx, row, "platformSelected");
      return row;
    });
    await assert.rejects(
      () => db.$transaction(async (tx) => {
        await tx.projectAiEffectiveRouteSelection.update({
          where: { id: selectionAuditMissing.id },
          data: { version: 2, selectedById: projectOwnerId },
        });
      }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_AUDIT_REQUIRED"),
    );

    await assert.rejects(
      () => db.$transaction(async (tx) => {
        const row = await tx.projectAiEffectiveRouteSelection.create({
          data: {
            id: randomUUID(),
            projectId,
            operation: "autoExtract",
            source: "personalDelegation",
            delegationId: active.id,
            selectedById: projectOwnerId,
            selectedByProjectMembershipId: projectOwnerMembership.id,
            selectedByMembershipCreatedAt: projectOwnerMembership.createdAt,
          },
        });
        await insertSelectionAudit(tx, row, "personalSelected");
      }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_DELEGATION_INVALID"),
    );

    await assert.rejects(
      () => db.$transaction(async (tx) => {
        await tx.aiProviderConnection.update({
          where: { id: providerId },
          data: { configurationVersion: 2 },
        });
      }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_UPSTREAM_INVALIDATION_REQUIRED"),
    );
    await assert.rejects(
      () => db.$transaction(async (tx) => {
        await tx.membershipSubscription.update({
          where: { id: ownerSubscription.id },
          data: { version: 2 },
        });
      }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_UPSTREAM_INVALIDATION_REQUIRED"),
    );

    const concurrentDraft = await createDraft("generateWithContext");
    const activateConcurrentDraft = async (): Promise<ProjectAiProviderDelegation> => db.$transaction(async (tx) => {
      const ownerConfirmedRow = await tx.projectAiProviderDelegation.update({
        where: { id: concurrentDraft.id },
        data: {
          version: 2,
          status: "ownerConfirmed",
          ownerConfirmedById: connectionOwnerId,
          ownerConfirmedAt: new Date(now.getTime() + 5_000),
        },
      });
      await insertDelegationAudit(tx, ownerConfirmedRow, "ownerConfirmed", connectionOwnerId, "draft");
      const activeRow = await tx.projectAiProviderDelegation.update({
        where: { id: concurrentDraft.id },
        data: {
          version: 3,
          status: "active",
          projectConfirmedById: projectOwnerId,
          projectConfirmedAt: new Date(now.getTime() + 6_000),
          projectConfirmedProjectMembershipId: projectOwnerMembership.id,
          projectConfirmedMembershipCreatedAt: projectOwnerMembership.createdAt,
          activatedAt: new Date(now.getTime() + 7_000),
        },
      });
      await insertDelegationAudit(tx, activeRow, "activated", projectOwnerId, "ownerConfirmed");
      return activeRow;
    });

    const invalidationPromise = db.$transaction(async (tx) => {
      await tx.aiProviderConnection.update({
        where: { id: providerId },
        data: { configurationVersion: 2 },
      });
      await tx.$executeRawUnsafe("SELECT pg_sleep(0.2)");
    });
    // Give the invalidation statement time to acquire the serialization-domain
    // lock before deliberately exercising the fail-fast activation path.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const firstActivationPromise = activateConcurrentDraft();
    const [invalidationResult, firstActivationResult] = await Promise.allSettled([
      invalidationPromise,
      firstActivationPromise,
    ]);
    assert.equal(invalidationResult.status, "rejected");
    assert.match(errorText(invalidationResult.reason), /PROJECT_AI_PROVIDER_DELEGATION_UPSTREAM_INVALIDATION_REQUIRED/u);
    assert.equal(firstActivationResult.status, "rejected");
    assert.equal(isSerializationConflict(firstActivationResult.reason), true);
    const activationResult = await activateConcurrentDraft();
    assert.equal(activationResult.status, "active");

    const concurrentSelection = await db.$transaction(async (tx) => {
      const row = await tx.projectAiEffectiveRouteSelection.create({
        data: {
          id: randomUUID(),
          projectId,
          operation: "generateWithContext",
          source: "personalDelegation",
          delegationId: activationResult.id,
          selectedById: projectOwnerId,
          selectedByProjectMembershipId: projectOwnerMembership.id,
          selectedByMembershipCreatedAt: projectOwnerMembership.createdAt,
        },
      });
      await insertSelectionAudit(tx, row, "personalSelected");
      return row;
    });

    const activeSnapshotForExpiry = await db.projectAiProviderDelegation.findUniqueOrThrow({
      where: { id: active.id },
    });
    await assert.rejects(
      () => db.$transaction(async (tx) => {
        await tx.projectAiProviderDelegation.update({
          where: { id: activeSnapshotForExpiry.id },
          data: {
            version: activeSnapshotForExpiry.version + 1,
            status: "expired",
            ownerConfirmedById: activeSnapshotForExpiry.ownerConfirmedById,
            ownerConfirmedAt: activeSnapshotForExpiry.ownerConfirmedAt,
            projectConfirmedById: activeSnapshotForExpiry.projectConfirmedById,
            projectConfirmedAt: activeSnapshotForExpiry.projectConfirmedAt,
            projectConfirmedProjectMembershipId: activeSnapshotForExpiry.projectConfirmedProjectMembershipId,
            projectConfirmedMembershipCreatedAt: activeSnapshotForExpiry.projectConfirmedMembershipCreatedAt,
            activatedAt: activeSnapshotForExpiry.activatedAt,
            expiredAt: new Date(activeSnapshotForExpiry.expiresAt.getTime() - 1),
            terminalActorId: connectionOwnerId,
            terminalActorProjectMembershipId: ownerMembership.id,
            terminalActorMembershipCreatedAt: ownerMembership.createdAt,
            terminalReason: "expired_too_early",
          },
        });
      }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_STATE_INVALID"),
    );
    await rejectDelegation(statusAuditMissing.id);

    const terminalizePromise = db.$transaction(async (tx) => {
      const switchedSelection = await tx.projectAiEffectiveRouteSelection.update({
        where: { id: concurrentSelection.id },
        data: { version: 2, source: "platformDefault", delegationId: null },
      });
      await insertSelectionAudit(tx, switchedSelection, "selectionUpdated");
      const revokedMain = await tx.projectAiProviderDelegation.update({
        where: { id: active.id },
        data: {
          version: 4,
          status: "revoked",
          revokedAt: new Date(Date.now() + 10_000),
          terminalActorId: projectOwnerId,
          terminalActorProjectMembershipId: projectOwnerMembership.id,
          terminalActorMembershipCreatedAt: projectOwnerMembership.createdAt,
          terminalReason: "project_owner_revoked_after_provider_review",
        },
      });
      await insertDelegationAudit(tx, revokedMain, "revoked", projectOwnerId, "active");
      const revokedConcurrent = await tx.projectAiProviderDelegation.update({
        where: { id: concurrentDraft.id },
        data: {
          version: 4,
          status: "revoked",
          revokedAt: new Date(Date.now() + 10_000),
          terminalActorId: projectOwnerId,
          terminalActorProjectMembershipId: projectOwnerMembership.id,
          terminalActorMembershipCreatedAt: projectOwnerMembership.createdAt,
          terminalReason: "project_owner_revoked_after_provider_review",
        },
      });
      await insertDelegationAudit(tx, revokedConcurrent, "revoked", projectOwnerId, "active");
      await tx.$executeRawUnsafe("SELECT pg_sleep(0.2)");
      await tx.aiProviderConnection.update({
        where: { id: providerId },
        data: { configurationVersion: 2 },
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const competingProviderMutation = db.$transaction(async (tx) => {
      await tx.aiProviderConnection.update({
        where: { id: providerId },
        data: { configurationVersion: 3 },
      });
    });
    const [terminalizeResult, competingMutationResult] = await Promise.allSettled([
      terminalizePromise,
      competingProviderMutation,
    ]);
    assert.equal(terminalizeResult.status, "fulfilled");
    assert.equal(competingMutationResult.status, "rejected");
    assert.equal(isSerializationConflict(competingMutationResult.reason), true);
    await db.$transaction(async (tx) => {
      await tx.aiProviderConnection.update({
        where: { id: providerId },
        data: { configurationVersion: 3 },
      });
    });
    const finalConcurrentSelection = await db.projectAiEffectiveRouteSelection.findUniqueOrThrow({
      where: { id: concurrentSelection.id },
    });
    assert.equal(finalConcurrentSelection.source, "platformDefault");
    assert.equal(finalConcurrentSelection.delegationId, null);
    assert.equal(
      (await db.projectAiProviderDelegation.findUniqueOrThrow({ where: { id: concurrentDraft.id } })).status,
      "revoked",
    );
    assert.equal(
      (await db.aiProviderConnection.findUniqueOrThrow({ where: { id: providerId } })).configurationVersion,
      3,
    );

    const generateDelegationCountBeforeLegacy = await db.projectAiProviderDelegation.count({
      where: { operation: "generateWithContext" },
    });
    const legacyRoute = await db.projectAiRoute.create({
      data: {
        projectId,
        operation: "generateWithContext",
        providerConnectionId: providerId,
        modelId: "gpt-4.1-mini",
        maxOutputTokens: 2048,
      },
    });
    assert.equal(legacyRoute.projectId, projectId);
    assert.equal(
      await db.projectAiProviderDelegation.count({ where: { operation: "generateWithContext" } }),
      generateDelegationCountBeforeLegacy,
    );

    await assert.rejects(
      () => db.$transaction(async (tx) => {
        await tx.projectAiEffectiveRouteSelection.delete({ where: { id: selection.id } });
      }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_DELETE_FORBIDDEN"),
    );
    await assert.rejects(
      () => db.$transaction(async (tx) => {
        await tx.projectAiProviderDelegation.delete({ where: { id: active.id } });
      }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_DELETE_FORBIDDEN"),
    );
    await assert.rejects(
      () => db.$transaction(async (tx) => {
        await tx.projectAiProviderDelegation.update({
          where: { id: active.id },
          data: {
            version: 4,
            projectConfirmedProjectMembershipId: ownerMembership.id,
          },
        });
      }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_CONFIRMATION_IMMUTABLE"),
    );
    await assert.rejects(
      () => db.$transaction(async (tx) => {
        await tx.projectAiProviderDelegation.update({
          where: { id: active.id },
          data: { version: 4, modelId: "tampered-model" },
        });
      }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_IMMUTABLE"),
    );
    await assert.rejects(
      () => db.$transaction(async (tx) => {
        await tx.projectAiProviderDelegation.update({
          where: { id: active.id },
          data: { version: 6 },
        });
      }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_VERSION_INVALID"),
    );
    await assert.rejects(
      () => db.$transaction(async (tx) => {
        const invalid = await tx.projectAiProviderDelegation.create({
          data: {
            id: randomUUID(),
            projectId,
            operation: "generateWithContext",
            providerConnectionId: providerId,
            connectionOwnerId,
            ownerProjectMembershipId: ownerMembership.id,
            ownerMembershipCreatedAt: ownerMembership.createdAt,
            connectionOwnerSubscriptionId: ownerSubscription.id,
            connectionOwnerSubscriptionVersion: ownerSubscription.version,
            connectionOwnerSubscriptionStartsAt: ownerSubscription.startsAt,
            connectionOwnerSubscriptionExpiresAt: ownerSubscription.expiresAt,
            modelId: "gpt-4.1-mini",
            maxOutputTokens: 2048,
            providerConfigurationVersion: 3,
            credentialFingerprint: fingerprint,
            delegationFingerprint: "c".repeat(64),
            expiresAt,
            proposedById: connectionOwnerId,
          },
        });
        await tx.projectAiProviderDelegation.update({
          where: { id: invalid.id },
          data: {
            version: 2,
            status: "active",
            ownerConfirmedById: connectionOwnerId,
            ownerConfirmedAt: new Date(now.getTime() + 1_000),
            projectConfirmedById: projectOwnerId,
            projectConfirmedAt: new Date(now.getTime() + 2_000),
            projectConfirmedProjectMembershipId: projectOwnerMembership.id,
            projectConfirmedMembershipCreatedAt: projectOwnerMembership.createdAt,
            activatedAt: new Date(now.getTime() + 3_000),
          },
        });
      }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_STATE_INVALID"),
    );
    await assert.rejects(
      () => db.$transaction(async (tx) => {
        await tx.projectAiProviderDelegation.create({
          data: {
            id: randomUUID(),
            projectId,
            operation: "autoExtract",
            providerConnectionId: providerId,
            connectionOwnerId,
            ownerProjectMembershipId: ownerMembership.id,
            ownerMembershipCreatedAt: ownerMembership.createdAt,
            connectionOwnerSubscriptionId: ownerSubscription.id,
            connectionOwnerSubscriptionVersion: ownerSubscription.version,
            connectionOwnerSubscriptionStartsAt: ownerSubscription.startsAt,
            connectionOwnerSubscriptionExpiresAt: ownerSubscription.expiresAt,
            modelId: "gpt-4.1-mini",
            maxOutputTokens: 2048,
            providerConfigurationVersion: 3,
            credentialFingerprint: fingerprint,
            delegationFingerprint: "d".repeat(64),
            expiresAt,
            proposedById: connectionOwnerId,
          },
        });
      }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_AUDIT_REQUIRED"),
    );
    const existingAudit = await db.projectAiProviderDelegationAudit.findFirstOrThrow({ where: { delegationId: active.id } });
    const {
      id: _auditId,
      createdAt: _auditCreatedAt,
      transactionId: _auditTransactionId,
      ...auditData
    } = existingAudit;
    assert.equal(_auditId, existingAudit.id);
    assert.equal(_auditCreatedAt, existingAudit.createdAt);
    assert.equal(_auditTransactionId, existingAudit.transactionId);
    await assert.rejects(
      () => db.$transaction(async (tx) => {
        await tx.projectAiProviderDelegationAudit.create({
          data: { ...auditData, id: randomUUID() },
        });
      }),
    );
    await assert.rejects(
      () => db.$transaction(async (tx) => {
        await tx.projectAiProviderDelegationAudit.create({
          data: { ...auditData, id: randomUUID(), delegationId: randomUUID() },
        });
      }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_AUDIT_ENTITY_INVALID"),
    );
    await assert.rejects(
      () => db.projectAiProviderDelegationAudit.update({ where: { id: existingAudit.id }, data: { reason: "tamper" } }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_AUDIT_IMMUTABLE"),
    );
    await assert.rejects(
      () => db.projectAiProviderDelegationAudit.delete({ where: { id: existingAudit.id } }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_AUDIT_IMMUTABLE"),
    );

    // Exercise the B2 control-plane service after the lower-level guard cases.
    // Revoke the delegation after switching the selection explicitly so the
    // project can still be deleted by the fixture below.
    const serviceDraft = await proposeProjectAiProviderDelegation(
      projectId,
      { providerConnectionId: providerId, operation: "autoExtract", expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString() },
      { id: connectionOwnerId, role: "user" },
      db,
    );
    assert.equal(serviceDraft.status, "draft");
    const serviceOwnerConfirmed = await confirmProjectAiProviderDelegationOwner(
      projectId,
      serviceDraft.id,
      { expectedVersion: serviceDraft.version, acknowledgeProviderCharges: true },
      { id: connectionOwnerId, role: "user" },
      db,
    );
    assert.equal(serviceOwnerConfirmed.status, "ownerConfirmed");
    const serviceActive = await confirmProjectAiProviderDelegationProject(
      projectId,
      serviceDraft.id,
      { expectedVersion: serviceOwnerConfirmed.version, acknowledgeDataEgress: true, acknowledgeIndexImpact: true },
      { id: projectOwnerId, role: "user" },
      db,
    );
    assert.equal(serviceActive.status, "active");
    const serviceSelection = await putProjectAiEffectiveRouteSelection(
      projectId,
      "autoExtract",
      { source: "personalDelegation", delegationId: serviceDraft.id, expectedVersion: null },
      { id: projectOwnerId, role: "user" },
      db,
    );
    assert.equal(serviceSelection.source, "personalDelegation");
    const serviceRevoked = await revokeProjectAiProviderDelegation(
      projectId,
      serviceDraft.id,
      { expectedVersion: serviceActive.version, reason: "service gate cleanup", switchToPlatformDefault: true },
      { id: projectOwnerId, role: "user" },
      db,
    );
    assert.equal(serviceRevoked.status, "revoked");
    assert.equal(
      (await db.projectAiEffectiveRouteSelection.findUnique({ where: { projectId_operation: { projectId, operation: "autoExtract" } } }))?.source,
      "platformDefault",
    );

    // A connection owner who is only an explicit project editor may perform
    // the safety switch themselves.  The database guard requires the final
    // revoked delegation and both same-transaction causal audits.
    const ownerSwitchDraft = await proposeProjectAiProviderDelegation(
      projectId,
      { providerConnectionId: providerId, operation: "sourceSummary", expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString() },
      { id: connectionOwnerId, role: "user" },
      db,
    );
    const ownerSwitchConfirmed = await confirmProjectAiProviderDelegationOwner(
      projectId,
      ownerSwitchDraft.id,
      { expectedVersion: ownerSwitchDraft.version, acknowledgeProviderCharges: true },
      { id: connectionOwnerId, role: "user" },
      db,
    );
    const ownerSwitchActive = await confirmProjectAiProviderDelegationProject(
      projectId,
      ownerSwitchDraft.id,
      { expectedVersion: ownerSwitchConfirmed.version, acknowledgeDataEgress: true, acknowledgeIndexImpact: true },
      { id: projectOwnerId, role: "user" },
      db,
    );
    const sourceSummarySelection = await db.projectAiEffectiveRouteSelection.findUniqueOrThrow({
      where: { projectId_operation: { projectId, operation: "sourceSummary" } },
    });
    const ownerSwitchSelection = await putProjectAiEffectiveRouteSelection(
      projectId,
      "sourceSummary",
      { source: "personalDelegation", delegationId: ownerSwitchDraft.id, expectedVersion: sourceSummarySelection.version },
      { id: projectOwnerId, role: "user" },
      db,
    );
    assert.equal(ownerSwitchSelection.source, "personalDelegation");
    await assert.rejects(
      () => db.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "ProjectAiEffectiveRouteSelection"
          SET "version" = "version" + 1,
              "source" = 'platform_default',
              "delegationId" = NULL,
              "selectedById" = ${connectionOwnerId}::uuid,
              "selectedByProjectMembershipId" = ${ownerMembership.id}::uuid,
              "selectedByMembershipCreatedAt" = ${ownerMembership.createdAt}
          WHERE "id" = ${ownerSwitchSelection.id}::uuid
        `);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "ProjectAiProviderDelegationAudit" (
            "id", "projectId", "operation", "entity", "action", "selectionId",
            "selectionVersion", "selectionSource", "selectedDelegationId",
            "selectedByProjectMembershipId", "selectedByMembershipCreatedAt",
            "actorKind", "actorId", "actorProjectMembershipId",
            "actorMembershipCreatedAt", "reason", "transitionAt"
          )
          SELECT
            ${randomUUID()}::uuid, "projectId", "operation", 'selection', 'selection_updated',
            "id", "version", "source", NULL,
            "selectedByProjectMembershipId", "selectedByMembershipCreatedAt",
            'user', "selectedById", "selectedByProjectMembershipId",
            "selectedByMembershipCreatedAt",
            'delegation_owner_revocation_explicit_platform_switch', "updatedAt"
          FROM "ProjectAiEffectiveRouteSelection"
          WHERE "id" = ${ownerSwitchSelection.id}::uuid
        `);
      }),
      (error: unknown) => errorText(error).includes("PROJECT_AI_EFFECTIVE_ROUTE_SELECTION_OWNER_INVALID"),
    );
    const rawSwitchRollback = await db.projectAiEffectiveRouteSelection.findUniqueOrThrow({ where: { id: ownerSwitchSelection.id } });
    assert.equal(rawSwitchRollback.source, "personalDelegation");
    assert.equal(rawSwitchRollback.delegationId, ownerSwitchDraft.id);
    assert.equal(rawSwitchRollback.version, ownerSwitchSelection.version);
    assert.equal((await db.projectAiProviderDelegation.findUniqueOrThrow({ where: { id: ownerSwitchDraft.id } })).status, "active");
    await assert.rejects(
      () => revokeProjectAiProviderDelegation(
        projectId,
        ownerSwitchDraft.id,
        { expectedVersion: ownerSwitchActive.version, reason: "owner switch must be explicit" },
        { id: connectionOwnerId, role: "user" },
        db,
      ),
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_SELECTION_SWITCH_REQUIRED"),
    );
    const unchangedOwnerSwitch = await db.projectAiProviderDelegation.findUniqueOrThrow({ where: { id: ownerSwitchDraft.id } });
    assert.equal(unchangedOwnerSwitch.status, "active");
    assert.equal(
      (await db.projectAiEffectiveRouteSelection.findUniqueOrThrow({ where: { id: ownerSwitchSelection.id } })).source,
      "personalDelegation",
    );
    await assert.rejects(
      () => revokeProjectAiProviderDelegation(
        projectId,
        ownerSwitchDraft.id,
        { expectedVersion: ownerSwitchActive.version, reason: "another editor cannot revoke", switchToPlatformDefault: true },
        { id: nonOwnerEditorId, role: "user" },
        db,
      ),
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_PROJECT_OWNER_REQUIRED"),
    );
    await assert.rejects(
      () => updatePersonalProviderConnection(
        providerId,
        { enabled: false },
        { id: connectionOwnerId, role: "user" },
        db,
      ),
      (error: unknown) => error instanceof PersonalProviderServiceError && error.code === "AI_PROVIDER_IN_USE",
    );
    const ownerRevoked = await revokeProjectAiProviderDelegation(
      projectId,
      ownerSwitchDraft.id,
      { expectedVersion: ownerSwitchActive.version, reason: "connection owner explicit safety switch", switchToPlatformDefault: true },
      { id: connectionOwnerId, role: "user" },
      db,
    );
    assert.equal(ownerRevoked.status, "revoked");
    const switchedSourceSummary = await db.projectAiEffectiveRouteSelection.findUniqueOrThrow({ where: { id: ownerSwitchSelection.id } });
    assert.equal(switchedSourceSummary.source, "platformDefault");
    assert.equal(switchedSourceSummary.delegationId, null);
    const ownerSelectionAudit = await db.projectAiProviderDelegationAudit.findFirstOrThrow({
      where: { selectionId: ownerSwitchSelection.id, selectionVersion: switchedSourceSummary.version },
    });
    const ownerDelegationAudit = await db.projectAiProviderDelegationAudit.findFirstOrThrow({
      where: { delegationId: ownerSwitchDraft.id, delegationVersion: ownerRevoked.version },
    });
    assert.equal(ownerSelectionAudit.reason, "delegation_owner_revocation_explicit_platform_switch");
    assert.equal(ownerSelectionAudit.actorId, connectionOwnerId);
    assert.equal(ownerSelectionAudit.actorProjectMembershipId, ownerMembership.id);
    assert.equal(ownerSelectionAudit.actorMembershipCreatedAt?.getTime(), ownerMembership.createdAt.getTime());
    assert.equal(ownerDelegationAudit.actorId, connectionOwnerId);
    assert.equal(ownerDelegationAudit.actorProjectMembershipId, ownerMembership.id);
    assert.equal(ownerDelegationAudit.actorMembershipCreatedAt?.getTime(), ownerMembership.createdAt.getTime());
    assert.equal(ownerSelectionAudit.transactionId, ownerDelegationAudit.transactionId);

    const casBaseSelection = await db.projectAiEffectiveRouteSelection.findUniqueOrThrow({ where: { id: switchedSourceSummary.id } });
    const casResults = await Promise.allSettled([
      putProjectAiEffectiveRouteSelection(
        projectId,
        "sourceSummary",
        { source: "platformDefault", delegationId: null, expectedVersion: casBaseSelection.version },
        { id: projectOwnerId, role: "user" },
        db,
      ),
      putProjectAiEffectiveRouteSelection(
        projectId,
        "sourceSummary",
        { source: "platformDefault", delegationId: null, expectedVersion: casBaseSelection.version },
        { id: projectOwnerId, role: "user" },
        db,
      ),
    ]);
    assert.equal(casResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(casResults.filter((result) => result.status === "rejected").length, 1);
    const casFinalSelection = await db.projectAiEffectiveRouteSelection.findUniqueOrThrow({ where: { id: switchedSourceSummary.id } });
    assert.equal(casFinalSelection.version, casBaseSelection.version + 1);

    const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
    let releaseListRevoke!: () => void;
    const listRevokeHold = new Promise<void>((resolve) => { releaseListRevoke = resolve; });
    let listRevokeReady!: () => void;
    const listRevokeReadyPromise = new Promise<void>((resolve) => { listRevokeReady = resolve; });
    const listRevokeTransaction = db.$transaction(async (tx) => {
      await lockActorAccess(tx, nonOwnerEditorId);
      await revokeProjectMembership(tx, projectId, nonOwnerEditorId, defaultWorkspaceId, {
        actorId: seededAdminId,
        reason: "delegation_gate_read_barrier_list_revoke",
      });
      listRevokeReady();
      await listRevokeHold;
    });
    await listRevokeReadyPromise;
    let listSettled = false;
    const gatedList = listProjectAiProviderDelegations(
      projectId,
      { id: nonOwnerEditorId, role: "user" },
      db,
    ).then((value) => {
      listSettled = true;
      return value;
    }, (error: unknown) => {
      listSettled = true;
      throw error;
    });
    await sleep(150);
    assert.equal(listSettled, false);
    releaseListRevoke();
    await listRevokeTransaction;
    await assert.rejects(
      () => gatedList,
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_FORBIDDEN"),
    );

    await db.$transaction(async (tx) => {
      await grantProjectMembership(tx, {
        projectId,
        workspaceId: defaultWorkspaceId,
        userId: nonOwnerEditorId,
        role: "editor",
        actorId: seededAdminId,
        reason: "delegation_gate_read_barrier_detail_regrant",
      });
    });
    let releaseDetailRevoke!: () => void;
    const detailRevokeHold = new Promise<void>((resolve) => { releaseDetailRevoke = resolve; });
    let detailRevokeReady!: () => void;
    const detailRevokeReadyPromise = new Promise<void>((resolve) => { detailRevokeReady = resolve; });
    const detailRevokeTransaction = db.$transaction(async (tx) => {
      await lockActorAccess(tx, nonOwnerEditorId);
      await revokeProjectMembership(tx, projectId, nonOwnerEditorId, defaultWorkspaceId, {
        actorId: seededAdminId,
        reason: "delegation_gate_read_barrier_detail_revoke",
      });
      detailRevokeReady();
      await detailRevokeHold;
    });
    await detailRevokeReadyPromise;
    let detailSettled = false;
    const gatedDetail = getProjectAiProviderDelegation(
      projectId,
      ownerSwitchDraft.id,
      { id: nonOwnerEditorId, role: "user" },
      db,
    ).then((value) => {
      detailSettled = true;
      return value;
    }, (error: unknown) => {
      detailSettled = true;
      throw error;
    });
    await sleep(150);
    assert.equal(detailSettled, false);
    releaseDetailRevoke();
    await detailRevokeTransaction;
    await assert.rejects(
      () => gatedDetail,
      (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_FORBIDDEN"),
    );

    const receiptId = randomUUID();
    await db.projectDeletionReceipt.create({
      data: {
        id: receiptId,
        deletedProjectId: projectId,
        workspaceId: defaultWorkspaceId,
        requestedById: projectOwnerId,
        projectFingerprint: "e".repeat(64),
        expectedUpdatedAt: (await db.project.findUniqueOrThrow({ where: { id: projectId } })).updatedAt,
      },
    });
    await db.project.delete({ where: { id: projectId } });
    assert.equal(await db.projectAiProviderDelegation.count({ where: { projectId } }), 0);
    assert.equal(await db.projectAiEffectiveRouteSelection.count({ where: { projectId } }), 0);
    assert.equal(await db.projectAiProviderDelegationAudit.count({ where: { projectId } }) >= 5, true);
    assert.ok(await db.projectDeletionReceipt.findUnique({ where: { id: receiptId } }));
  },
);
