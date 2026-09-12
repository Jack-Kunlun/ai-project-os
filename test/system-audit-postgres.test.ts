import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { Client } from "pg";
import { getDb } from "@/lib/db";
import { createBootstrapSignupOfferPolicy, createPlatformGrantOfferPolicy } from "@/lib/platform-grant-offer-policy-service";
import { grantProjectMembership, grantWorkspaceMembership } from "@/lib/membership-governance";
import { consumeWebAiConfirmation } from "@/lib/web-ai-confirmation";
import {
  confirmProjectGitRepositoryDelegationOwner,
  confirmProjectGitRepositoryDelegationProject,
  proposeProjectGitRepositoryDelegation,
} from "@/lib/project-git-repository-delegation-service";
import {
  confirmProjectMcpConnectionDelegationOwner,
  confirmProjectMcpConnectionDelegationProject,
  proposeProjectMcpConnectionDelegation,
} from "@/lib/project-mcp-connection-delegation-service";
import { createMcpControlPlaneAttestation } from "@/lib/mcp-attestation-control-plane-service";
import { createProjectMcpToolGrantV2 } from "@/lib/project-mcp-tool-grant-service";
import { cancelProjectMcpAction, decideProjectMcpAction, proposeProjectMcpAction } from "@/lib/project-mcp-action-service";
import { reconcileStaleProjectMcpActionDispatchReservations } from "@/lib/project-mcp-action-dispatch-service";
import { runProjectDelegatedGitManualSync } from "@/lib/project-delegated-git-runtime-service";
import { acceptWorkspaceInvitation, createWorkspaceInvitation, getWorkspaceInvitationImpact, revokeWorkspaceInvitation } from "@/lib/workspaces";
import {
  getSystemAuditDetail,
  listSystemAudit,
  SYSTEM_AUDIT_DENYLIST_KEYS,
  SYSTEM_AUDIT_REGISTRY,
  SYSTEM_AUDIT_SOURCES,
} from "@/lib/system-audit";

const shouldRun = process.env.SYSTEM_AUDIT_POSTGRES_GATE === "1";

const expectedEnums: Readonly<Record<string, readonly string[]>> = {
  PlatformDefaultAiRouteAuditAction: ["draft_created", "draft_updated", "validated", "activated", "retired"],
  MembershipAuditEventKind: ["grant", "extend", "revoke"],
  AccountAccessAuditEvent: ["disabled", "restored"],
  MembershipAccessAuditAction: ["migration_quarantined", "confirmed", "revoked", "bootstrap_confirmed"],
  WorkspaceInvitationAuditEvent: ["created", "accepted", "revoked"],
  McpToolAttestationAuditEvent: ["attested", "revoked"],
  ProjectAiProviderDelegationAuditAction: ["proposed", "owner_confirmed", "activated", "rejected", "revoked", "expired", "platform_selected", "personal_selected", "selection_updated"],
  ProjectGitRepositoryDelegationAuditAction: ["proposed", "owner_confirmed", "activated", "rejected", "revoked", "expired"],
  ProjectGitRepositoryManualRunAuditAction: ["requested", "admitted", "dispatched", "succeeded", "failed", "unknown", "conflict"],
  ProjectMcpConnectionDelegationAuditAction: ["proposed", "owner_confirmed", "activated", "rejected", "revoked", "expired"],
  ProjectMcpToolGrantLedgerEvent: ["granted", "revoked"],
  ProjectMcpActionLedgerEvent: ["proposed", "approved", "rejected", "cancelled"],
  ProjectMcpActionRuntimeLedgerEvent: ["reserved", "succeeded", "failed", "unknown", "expired", "invalidated"],
  AiAuditEventType: ["policyCreated", "policyAdvanced", "grantIssued", "grantRevoked", "preflightRejected", "scannerRejected", "budgetRejected", "runCreated", "runClaimed", "dispatchSent", "runSucceeded", "runFailed", "runUnknown", "runCancelled", "attemptSucceeded", "attemptFailed", "attemptUnknown", "attemptCancelled"],
  WebAiConfirmationAction: ["memory_extract", "memory_index", "memory_search", "memory_answer", "asset_recognize", "intelligence_brief", "intelligence_agent"],
  PlatformProviderProbeBudgetStatus: ["draft", "active", "retired"],
  PlatformProviderProbeAttemptStatus: ["rejected", "reserved", "running", "settled", "released", "held"],
  PlatformProviderProbeLedgerEvent: ["rejected", "reserved", "dispatched", "settled", "released", "held"],
  PlatformProviderProbeCapability: ["generation", "embedding", "vision"],
  PlatformGrantOfferPolicyAuditAction: ["created", "activated", "retired"],
};

function assertLocalDatabaseUrl(value: string | undefined): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("SYSTEM_AUDIT_POSTGRES_DATABASE_URL_REQUIRED");
  const parsed = new URL(value);
  if (!(["postgres:", "postgresql:"] as readonly string[]).includes(parsed.protocol)) throw new Error("SYSTEM_AUDIT_POSTGRES_DATABASE_URL_INVALID");
  if (!(parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]")) throw new Error("SYSTEM_AUDIT_POSTGRES_DATABASE_URL_INVALID");
  if (parsed.search !== "" || parsed.hash !== "") throw new Error("SYSTEM_AUDIT_POSTGRES_DATABASE_URL_INVALID");
  return parsed.toString();
}

function collectObjectKeys(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectObjectKeys(item, output);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      output.add(key);
      collectObjectKeys(child, output);
    }
  }
  return output;
}

function assertSafePublicProjection(value: unknown): void {
  const keys = collectObjectKeys(value);
  for (const key of SYSTEM_AUDIT_DENYLIST_KEYS) assert.equal(keys.has(key), false, key);
  for (const key of keys) assert.doesNotMatch(key, /fingerprint|token/iu, key);
}

test(
  "system audit registry matches deployed PostgreSQL enums and critical projections",
  { skip: !shouldRun ? "SYSTEM_AUDIT_POSTGRES_GATE=1 is required" : false },
  async () => {
    const databaseUrl = assertLocalDatabaseUrl(process.env.DATABASE_URL);
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const enumRows = await client.query<{ typname: string; enumlabel: string }>(`
        SELECT type_meta.typname, enum_meta.enumlabel
        FROM pg_type AS type_meta
        JOIN pg_enum AS enum_meta ON enum_meta.enumtypid = type_meta.oid
        WHERE type_meta.typname = ANY($1::text[])
        ORDER BY type_meta.typname, enum_meta.enumsortorder
      `, [Object.keys(expectedEnums)]);
      const actualEnums = new Map<string, string[]>();
      for (const row of enumRows.rows) actualEnums.set(row.typname, [...(actualEnums.get(row.typname) ?? []), row.enumlabel]);
      for (const [name, expected] of Object.entries(expectedEnums)) assert.deepEqual(actualEnums.get(name), expected, name);
    } finally {
      await client.end();
    }

    const database = getDb();
    const page = await listSystemAudit({ pageSize: 50 }, database, new Date());
    assert.equal(page.pageSize, 50);
    assert.ok(page.events.every((event) => SYSTEM_AUDIT_SOURCES.includes(event.source)));
    assert.equal(SYSTEM_AUDIT_SOURCES.length, 21);
    assert.deepEqual(Object.keys(SYSTEM_AUDIT_REGISTRY).sort(), [...SYSTEM_AUDIT_SOURCES].sort());
    assertSafePublicProjection(page);

    const platformPage = await listSystemAudit({ source: "platformDefaultAiRoute", pageSize: 1 }, database, new Date());
    assert.ok(platformPage.events.length <= 1);
    for (const event of platformPage.events) {
      assert.deepEqual(Object.keys(event.references).sort(), ["categories"]);
      assert.match(event.references.categories, /platformDefaultRoute/u);
    }
  },
);

test(
  "system audit PostgreSQL adapters project all new rows safely and consistently",
  { skip: !shouldRun ? "SYSTEM_AUDIT_POSTGRES_GATE=1 is required" : false },
  async () => {
    const database = getDb();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const userId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const policyRevisionId = randomUUID();
    const aiAuditId = randomUUID();
    const expiredChallengeId = randomUUID();
    const pendingChallengeId = randomUUID();
    const snapshotHeadChallengeId = randomUUID();
    const snapshotJobId = randomUUID();
    const snapshotGrantId = randomUUID();
    const snapshotProviderId = randomUUID();
    const snapshotCredentialId = randomUUID();
    const gitConnectionId = randomUUID();
    const gitCredentialId = randomUUID();
    const manualRunId = randomUUID();
    const mcpConnectionId = randomUUID();
    const mcpDefinitionId = randomUUID();
    let now = new Date();
    const auditSnapshotAt = new Date(now.getTime());
    const createdAt = new Date(now.getTime() - 10_000);
    const expiredIssuedAt = new Date(now.getTime() - 9_000);
    const pendingIssuedAt = new Date(now.getTime() - 8_000);
    const fingerprint = "a".repeat(64);

    await database.appUser.create({
      data: { id: userId, username: `system-audit-${suffix}`, role: "admin" },
    });
    await database.$transaction((tx) => createBootstrapSignupOfferPolicy(tx, userId));
    const policyAuditId = (await database.platformGrantOfferPolicyAudit.findFirstOrThrow({
      where: { action: "created" },
      select: { id: true },
    })).id;
    await database.workspace.create({
      data: { id: workspaceId, name: `System audit ${suffix}`, slug: `system-audit-${suffix}` },
    });
    await database.project.create({
      data: { id: projectId, workspaceId, name: `System audit ${suffix}`, slug: `system-audit-${suffix}-project` },
    });
    await database.projectAiPolicyRevision.create({
      data: {
        id: policyRevisionId,
        projectId,
        revision: 1,
        policyFingerprint: fingerprint,
        profileFingerprint: fingerprint,
        processorFingerprint: fingerprint,
        regionFingerprint: fingerprint,
        retentionFingerprint: fingerprint,
        endpointFingerprint: fingerprint,
        budgetFingerprint: fingerprint,
        scannerFingerprint: fingerprint,
      },
    });
    await database.aiAuditEvent.create({
      data: {
        id: aiAuditId,
        projectId,
        policyRevisionId,
        eventType: "preflightRejected",
        safeCode: "aiProviderUnknown",
        createdAt,
      },
    });

    const challengeData = {
      projectId,
      actorId: userId,
      actorAccountAccessVersion: 1,
      actorAccessFingerprint: fingerprint,
      contentVersion: "system-audit-test",
      inputFingerprint: fingerprint,
      routeSnapshot: { kind: "test" },
      safeSummary: { targetAction: "memoryIndex" },
      preparedClientKeyHash: fingerprint,
    } as const;
    await database.webAiConfirmationChallenge.create({
      data: {
        id: expiredChallengeId,
        ...challengeData,
        targetAction: "memoryIndex",
        issuedAt: expiredIssuedAt,
        expiresAt: new Date(now.getTime() - 1_000),
      },
    });
    await database.webAiConfirmationChallenge.create({
      data: {
        id: pendingChallengeId,
        ...challengeData,
        targetAction: "memorySearch",
        issuedAt: pendingIssuedAt,
        expiresAt: new Date(now.getTime() + 600_000),
      },
    });
    await database.webAiConfirmationChallenge.create({
      data: {
        id: snapshotHeadChallengeId,
        ...challengeData,
        targetAction: "memoryIndex",
        issuedAt: new Date(now.getTime() - 7_000),
        expiresAt: new Date(now.getTime() + 600_000),
      },
    });

    const projectOwnerActor = { id: userId, role: "user" as const, accountAccessVersion: 1 };
    const platformAdminActor = { id: userId, role: "admin" as const, accountAccessVersion: 1 };
    const draftPolicy = await createPlatformGrantOfferPolicy({
      offerVersion: `system-audit-draft-${suffix}`,
      amount: 600_000,
      validForDays: 45,
      reason: "system audit draft projection",
    }, platformAdminActor, database);
    const draftPolicyAuditId = (await database.platformGrantOfferPolicyAudit.findFirstOrThrow({
      where: { policyId: draftPolicy.id, action: "created" },
      select: { id: true },
    })).id;
    let manualAuditId: string | null = null;
    let manualRecoveryAuditId: string | null = null;
    let approvalAuditId: string | null = null;
    let runtimeAuditId: string | null = null;
    let approvalActionId: string | null = null;
    let approvalActionRevision: string | null = null;
    const manualClientRequestKey = randomUUID();

    try {
      await database.$transaction(async (tx) => {
        await grantWorkspaceMembership(tx, { workspaceId, userId, role: "owner", actorId: userId, reason: "system_audit_gate_workspace_owner" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId, role: "owner", actorId: userId, reason: "system_audit_gate_project_owner" });
      });

      await database.externalCredential.create({
        data: {
          id: snapshotCredentialId,
          kind: "aiProvider",
          ciphertext: Buffer.from([4]),
          nonce: Buffer.from([5]),
          authTag: Buffer.from([6]),
          maskedSuffix: "audit",
          secretFingerprint: "9".repeat(64),
        },
      });
      await database.aiProviderConnection.create({
        data: {
          id: snapshotProviderId,
          name: `System audit snapshot provider ${suffix}`,
          kind: "glm",
          scope: "platform",
          ownerUserId: null,
          protocol: "chatCompletions",
          baseUrl: "https://provider.example.invalid/v1",
          credentialId: snapshotCredentialId,
          defaultEmbeddingModelId: "audit-embedding",
          embeddingDimensions: 1024,
          status: "verified",
          lastTestedAt: now,
        },
      });
      await database.backgroundJob.create({
        data: {
          id: snapshotJobId,
          projectId,
          kind: "semanticSearch",
          payload: {},
          idempotencyKey: "audit-snapshot-job".padEnd(64, "0"),
          requestedById: userId,
        },
      });
      await database.webAiGrant.create({
        data: {
          id: snapshotGrantId,
          projectId,
          operation: "embedding",
          scopeKind: "query",
          scopeIds: { projectId },
          manifestFingerprint: "8".repeat(64),
          providerConnectionId: snapshotProviderId,
          modelId: "audit-embedding",
          consentVersion: "web-ai-transfer-consent:v1",
          issuedById: userId,
          billingMode: "platform",
          billingUserId: userId,
          boundJobId: snapshotJobId,
          confirmationChallengeId: pendingChallengeId,
          routeSource: "platform_default",
          routeId: randomUUID(),
          routeVersion: 1,
          routeUpdatedAt: now,
          providerConfigurationVersion: 1,
          quotaMultiplierBps: 10_000,
          routeFenceFingerprint: "7".repeat(64),
          credentialSecretFingerprint: "9".repeat(64),
          payerKind: "platformCaller",
          payerProviderConnectionId: snapshotProviderId,
          embeddingDimensions: 1024,
          maxOutputTokens: 128,
          expiresAt: new Date(now.getTime() + 600_000),
        },
      });
      await database.backgroundJob.update({ where: { id: snapshotJobId }, data: { webAiGrantId: snapshotGrantId } });

      const acceptedInviteeId = randomUUID();
      const acceptedInviteeEmail = `system-audit-invitee-${suffix}@example.com`;
      await database.appUser.create({
        data: {
          id: acceptedInviteeId,
          username: `system-audit-invitee-${suffix}`,
          email: acceptedInviteeEmail,
          emailVerifiedAt: new Date(),
          role: "user",
        },
      });
      const pendingInvitation = await createWorkspaceInvitation(workspaceId, {
        email: `system-audit-pending-${suffix}@example.com`,
        workspaceRole: "member",
        requestKey: randomUUID(),
      }, projectOwnerActor, database);
      const acceptedInvitation = await createWorkspaceInvitation(workspaceId, {
        email: acceptedInviteeEmail,
        workspaceRole: "member",
        requestKey: randomUUID(),
      }, projectOwnerActor, database);
      if (acceptedInvitation.token === null) throw new Error("SYSTEM_AUDIT_INVITATION_TOKEN_MISSING");
      await acceptWorkspaceInvitation(acceptedInvitation.token, { id: acceptedInviteeId }, "/dashboard", database);
      const revokedInvitation = await createWorkspaceInvitation(workspaceId, {
        email: `system-audit-revoked-${suffix}@example.com`,
        workspaceRole: "member",
        requestKey: randomUUID(),
      }, projectOwnerActor, database);
      const revokedImpact = await getWorkspaceInvitationImpact(workspaceId, revokedInvitation.invitation.id, projectOwnerActor, database);
      await revokeWorkspaceInvitation(workspaceId, revokedInvitation.invitation.id, {
        reason: "system audit cleanup",
        requestKey: randomUUID(),
        expectedVersion: revokedImpact.expectedVersion,
        expectedImpactFingerprint: revokedImpact.impactFingerprint,
        confirmation: true,
      }, projectOwnerActor, database);

      const gitCredentialFingerprint = "b".repeat(64);
      await database.externalCredential.create({
        data: {
          id: gitCredentialId,
          kind: "git",
          ciphertext: Buffer.from([1]),
          nonce: Buffer.from([2]),
          authTag: Buffer.from([3]),
          maskedSuffix: "gate",
          secretFingerprint: gitCredentialFingerprint,
        },
      });
      await database.gitConnection.create({
        data: {
          id: gitConnectionId,
          name: `System audit Git ${suffix}`,
          providerKind: "github",
          transport: "https",
          baseUrl: "https://github.com",
          authKind: "token",
          allowPrivateNetwork: false,
          resolvedAddressFingerprint: "c".repeat(64),
          status: "verified",
          configurationVersion: 1,
          ownershipState: "confirmed",
          createdById: userId,
          ownerUserId: userId,
          ownerAccountAccessVersion: 1,
          credentialId: gitCredentialId,
        },
      });
      const gitDraft = await proposeProjectGitRepositoryDelegation(projectId, {
        gitConnectionId,
        repositoryPath: "org/system-audit",
        trackedRef: "main",
        includeRoots: ["."],
        softExcludePatterns: [],
        role: "primary",
        expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      }, projectOwnerActor, database);
      const gitOwnerConfirmed = await confirmProjectGitRepositoryDelegationOwner(projectId, gitDraft.id, {
        expectedVersion: gitDraft.version,
        acknowledgeReadOnlyCredentialUse: true,
      }, projectOwnerActor, database);
      const gitActive = await confirmProjectGitRepositoryDelegationProject(projectId, gitDraft.id, {
        expectedVersion: gitOwnerConfirmed.version,
        acknowledgeRepositoryScope: true,
        acknowledgeDataEgress: true,
      }, projectOwnerActor, database);
      const gitDelegation = await database.projectGitRepositoryDelegation.findUniqueOrThrow({ where: { id: gitActive.id } });
      const gitMembership = await database.projectMembership.findFirstOrThrow({ where: { projectId, userId, role: "owner", accessState: "confirmed" }, select: { id: true, createdAt: true } });
      manualAuditId = await database.$transaction(async (tx) => {
        const run = await tx.projectGitRepositoryManualRun.create({
          data: {
            id: manualRunId,
            projectId,
            delegationId: gitDelegation.id,
            requestedById: userId,
            requestedByAccountAccessVersion: 1,
            requestedByProjectMembershipId: gitMembership.id,
            requestedByMembershipCreatedAt: gitMembership.createdAt,
            clientRequestKey: manualClientRequestKey,
            delegationVersion: gitDelegation.version,
            delegationFingerprint: gitDelegation.delegationFingerprint,
            connectionOwnerId: gitDelegation.connectionOwnerId,
            connectionOwnerAccountAccessVersion: gitDelegation.connectionOwnerAccountAccessVersion,
            ownerProjectMembershipId: gitDelegation.ownerProjectMembershipId,
            ownerMembershipCreatedAt: gitDelegation.ownerMembershipCreatedAt,
            projectConfirmedById: gitDelegation.projectConfirmedById!,
            projectConfirmedProjectMembershipId: gitDelegation.projectConfirmedProjectMembershipId!,
            projectConfirmedMembershipCreatedAt: gitDelegation.projectConfirmedMembershipCreatedAt!,
            connectionConfigurationVersion: gitDelegation.connectionConfigurationVersion,
            resolvedAddressFingerprint: gitDelegation.resolvedAddressFingerprint,
            credentialFingerprint: gitDelegation.credentialFingerprint,
            repositoryPath: gitDelegation.repositoryPath,
            trackedRef: gitDelegation.trackedRef,
            includeRoots: gitDelegation.includeRoots as Prisma.InputJsonValue,
            softExcludePatterns: gitDelegation.softExcludePatterns as Prisma.InputJsonValue,
            role: gitDelegation.role,
            requiredForProjectSnapshot: gitDelegation.requiredForProjectSnapshot,
            codeEnabled: gitDelegation.codeEnabled,
            metadataEnabled: gitDelegation.metadataEnabled,
            manualSyncAllowed: gitDelegation.manualSyncAllowed,
            automationAllowed: gitDelegation.automationAllowed,
          },
          select: { id: true },
        });
        await tx.$executeRaw(Prisma.sql`SELECT set_config('ai.project_git_manual_runtime_audit', '1', true)`);
        const auditRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          INSERT INTO "ProjectGitRepositoryManualRunAudit" (
            "id", "runId", "projectId", "delegationId", "action", "statusBefore", "statusAfter", "dispatchState", "actorId",
            "requestedById", "requestedByAccountAccessVersion", "requestedByProjectMembershipId", "requestedByMembershipCreatedAt",
            "connectionOwnerId", "connectionOwnerAccountAccessVersion", "ownerProjectMembershipId", "ownerMembershipCreatedAt",
            "projectConfirmedById", "projectConfirmedProjectMembershipId", "projectConfirmedMembershipCreatedAt", "reason",
            "delegationVersion", "delegationFingerprint", "connectionConfigurationVersion", "resolvedAddressFingerprint", "credentialFingerprint",
            "role", "requiredForProjectSnapshot", "codeEnabled", "metadataEnabled", "manualSyncAllowed", "automationAllowed", "commitSha", "manifestFingerprint"
          )
          SELECT gen_random_uuid(), run."id", run."projectId", run."delegationId", 'requested'::"ProjectGitRepositoryManualRunAuditAction",
            NULL::"ProjectGitRepositoryManualRunStatus", run."status", run."dispatchState", run."requestedById", run."requestedById", run."requestedByAccountAccessVersion",
            run."requestedByProjectMembershipId", run."requestedByMembershipCreatedAt", run."connectionOwnerId", run."connectionOwnerAccountAccessVersion",
            run."ownerProjectMembershipId", run."ownerMembershipCreatedAt", run."projectConfirmedById", run."projectConfirmedProjectMembershipId", run."projectConfirmedMembershipCreatedAt",
            'system_audit_gate_requested', run."delegationVersion", run."delegationFingerprint", run."connectionConfigurationVersion", run."resolvedAddressFingerprint", run."credentialFingerprint",
            run."role", run."requiredForProjectSnapshot", run."codeEnabled", run."metadataEnabled", run."manualSyncAllowed", run."automationAllowed", NULL, NULL
          FROM "ProjectGitRepositoryManualRun" AS run
          WHERE run."id" = ${run.id}::uuid
          RETURNING "id"
        `);
        await tx.projectGitRepositoryManualRun.update({
          where: { id: run.id },
          data: {
            status: "running",
            stage: "admitted",
            dispatchState: "pending",
            startedAt: new Date(now.getTime() - 600_000),
          },
        });
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "ProjectGitRepositoryManualRunAudit" (
            "id", "runId", "projectId", "delegationId", "action", "statusBefore", "statusAfter", "dispatchState", "actorId",
            "requestedById", "requestedByAccountAccessVersion", "requestedByProjectMembershipId", "requestedByMembershipCreatedAt",
            "connectionOwnerId", "connectionOwnerAccountAccessVersion", "ownerProjectMembershipId", "ownerMembershipCreatedAt",
            "projectConfirmedById", "projectConfirmedProjectMembershipId", "projectConfirmedMembershipCreatedAt", "reason",
            "delegationVersion", "delegationFingerprint", "connectionConfigurationVersion", "resolvedAddressFingerprint", "credentialFingerprint",
            "role", "requiredForProjectSnapshot", "codeEnabled", "metadataEnabled", "manualSyncAllowed", "automationAllowed", "commitSha", "manifestFingerprint"
          )
          SELECT gen_random_uuid(), run."id", run."projectId", run."delegationId", 'admitted'::"ProjectGitRepositoryManualRunAuditAction",
            'queued'::"ProjectGitRepositoryManualRunStatus", run."status", run."dispatchState", run."requestedById", run."requestedById", run."requestedByAccountAccessVersion",
            run."requestedByProjectMembershipId", run."requestedByMembershipCreatedAt", run."connectionOwnerId", run."connectionOwnerAccountAccessVersion",
            run."ownerProjectMembershipId", run."ownerMembershipCreatedAt", run."projectConfirmedById", run."projectConfirmedProjectMembershipId", run."projectConfirmedMembershipCreatedAt",
            'system_audit_gate_admitted', run."delegationVersion", run."delegationFingerprint", run."connectionConfigurationVersion", run."resolvedAddressFingerprint", run."credentialFingerprint",
            run."role", run."requiredForProjectSnapshot", run."codeEnabled", run."metadataEnabled", run."manualSyncAllowed", run."automationAllowed", NULL, NULL
          FROM "ProjectGitRepositoryManualRun" AS run
          WHERE run."id" = ${run.id}::uuid
        `);
        return auditRows[0]?.id ?? null;
      });

      const replayedManualRun = await runProjectDelegatedGitManualSync({
        projectId,
        delegationId: gitDelegation.id,
        request: { clientRequestKey: manualClientRequestKey },
        actor: projectOwnerActor,
      }, database);
      assert.equal(replayedManualRun.status, "unknown");
      manualRecoveryAuditId = (await database.projectGitRepositoryManualRunAudit.findFirstOrThrow({
        where: { runId: manualRunId, action: "unknown" },
        select: { id: true },
      })).id;

      const snapshotFirstPage = await listSystemAudit({ source: "webAiConfirmation", pageSize: 1 }, database, auditSnapshotAt);
      assert.equal(snapshotFirstPage.events[0]?.id, snapshotHeadChallengeId);
      assert.ok(snapshotFirstPage.nextCursor);
      const snapshotPendingFirstPage = await listSystemAudit({ source: "webAiConfirmation", result: "pending", pageSize: 1 }, database, auditSnapshotAt);
      assert.equal(snapshotPendingFirstPage.events[0]?.id, snapshotHeadChallengeId);
      assert.ok(snapshotPendingFirstPage.nextCursor);
      const pendingChallenge = await database.webAiConfirmationChallenge.findUniqueOrThrow({ where: { id: pendingChallengeId } });
      await database.$transaction((tx) => consumeWebAiConfirmation(tx, {
        row: pendingChallenge,
        clientKeyHash: fingerprint,
        targetAction: "memorySearch",
        contentVersion: pendingChallenge.contentVersion,
        actorAccountAccessVersion: pendingChallenge.actorAccountAccessVersion,
        actorAccessFingerprint: pendingChallenge.actorAccessFingerprint,
        routeSnapshot: pendingChallenge.routeSnapshot,
        inputFingerprint: pendingChallenge.inputFingerprint,
      }, snapshotJobId, userId));
      const snapshotSecondPage = await listSystemAudit({ source: "webAiConfirmation", pageSize: 1, cursor: snapshotFirstPage.nextCursor ?? undefined }, database, new Date());
      assert.equal(snapshotSecondPage.events[0]?.id, pendingChallengeId);
      assert.equal(snapshotSecondPage.events[0]?.result, "pending");
      assert.deepEqual((await listSystemAudit({ source: "webAiConfirmation", result: "pending", pageSize: 1, cursor: snapshotPendingFirstPage.nextCursor ?? undefined }, database, new Date())).events.map((event) => event.id), [pendingChallengeId]);

      const mcpNetworkFingerprint = "d".repeat(64);
      const noCredentialFingerprint = "d2ab012fb807b99b7d059aabe98a45dd6edf6941a5f22699f8d04b5906dc2c2b";
      const mcpDefinitionFingerprint = "e".repeat(64);
      await database.mcpConnection.create({
        data: {
          id: mcpConnectionId,
          name: `System audit MCP ${suffix}`,
          endpointUrl: "https://mcp.example.invalid/mcp",
          authKind: "none",
          credentialId: null,
          allowPrivateNetwork: false,
          resolvedAddressFingerprint: mcpNetworkFingerprint,
          protocolVersion: "2026-07-28",
          catalogFingerprint: "f".repeat(64),
          credentialFingerprint: noCredentialFingerprint,
          configurationRevision: 1,
          status: "verified",
          createdById: userId,
          ownerUserId: userId,
          ownerAccountAccessVersion: 1,
          ownershipState: "confirmed",
        },
      });
      await database.mcpToolDefinition.create({
        data: {
          id: mcpDefinitionId,
          connectionId: mcpConnectionId,
          name: "project.audit.lookup",
          title: "Audit lookup",
          description: "Safe audit fixture",
          inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false },
          outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
          annotations: { readOnlyHint: true, destructiveHint: false },
          remoteReadOnlyHint: true,
          definitionFingerprint: mcpDefinitionFingerprint,
          current: true,
        },
      });
      const attestation = await createMcpControlPlaneAttestation(platformAdminActor, {
        toolDefinitionId: mcpDefinitionId,
        expectedConnectionConfigurationRevision: 1,
        expectedDefinitionFingerprint: mcpDefinitionFingerprint,
        expectedNetworkFingerprint: mcpNetworkFingerprint,
        expectedCredentialFingerprint: noCredentialFingerprint,
        conclusion: "read_only_verified",
        riskLevel: "low",
        evidenceNote: "manual_read_only_review",
      }, database);
      const mcpDraft = await proposeProjectMcpConnectionDelegation(projectId, {
        mcpConnectionId,
        expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      }, projectOwnerActor, database);
      if (!("id" in mcpDraft)) throw new Error("SYSTEM_AUDIT_MCP_DELEGATION_CREATE_FAILED");
      await confirmProjectMcpConnectionDelegationOwner(projectId, mcpDraft.id, { expectedVersion: 1, acknowledgeCredentialUse: true }, projectOwnerActor, database);
      const mcpActive = await confirmProjectMcpConnectionDelegationProject(projectId, mcpDraft.id, { expectedVersion: 2, acknowledgeProjectScope: true, acknowledgeDataEgress: true }, projectOwnerActor, database);
      if (!("id" in mcpActive)) throw new Error("SYSTEM_AUDIT_MCP_DELEGATION_ACTIVATE_FAILED");
      const mcpDelegation = await database.projectMcpConnectionDelegation.findUniqueOrThrow({ where: { id: mcpActive.id }, select: { id: true, version: true } });
      const mcpGrant = await createProjectMcpToolGrantV2(projectId, {
        delegationId: mcpDelegation.id,
        toolDefinitionId: mcpDefinitionId,
        attestationId: attestation.id,
        expectedDelegationVersion: mcpDelegation.version,
        expectedAttestationVersion: 1,
        acknowledgeReadOnly: true,
      }, platformAdminActor, database);
      const mcpGrantId = mcpGrant.grant.id as string;
      const approvalProposal = await proposeProjectMcpAction(projectId, {
        clientRequestId: randomUUID(),
        grantId: mcpGrantId,
        expectedGrantVersion: 1,
        arguments: { query: "audit approval" },
      }, platformAdminActor, database);
      approvalActionId = approvalProposal.action.id as string;
      approvalActionRevision = approvalProposal.action.actionRevision as string;
      const approved = await decideProjectMcpAction(projectId, approvalProposal.action.id as string, {
        decision: "approved",
        expectedStateVersion: 1,
        expectedActionRevision: approvalActionRevision,
        acknowledgeSingleUse: true,
      }, platformAdminActor, database);
      assert.equal(approved.created, true);
      approvalAuditId = (await database.projectMcpActionLedger.findFirstOrThrow({ where: { actionId: approvalProposal.action.id as string, event: "approved" }, select: { id: true } })).id;

      const recoveryProposal = await proposeProjectMcpAction(projectId, {
        clientRequestId: randomUUID(),
        grantId: mcpGrantId,
        expectedGrantVersion: 1,
        arguments: { query: "audit recovery" },
      }, platformAdminActor, database);
      const recoveryApproved = await decideProjectMcpAction(projectId, recoveryProposal.action.id as string, {
        decision: "approved",
        expectedStateVersion: 1,
        expectedActionRevision: recoveryProposal.action.actionRevision as string,
        acknowledgeSingleUse: true,
      }, platformAdminActor, database);
      assert.equal(recoveryApproved.created, true);
      const recoveryActionId = recoveryProposal.action.id as string;
      const recoveryAttemptId = randomUUID();
      const recoveryRpcId = randomUUID();
      await database.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "ProjectMcpAction"
          SET "status" = 'dispatch_reserved'::"ProjectMcpActionStatus", "stateVersion" = 3
          WHERE "id" = ${recoveryActionId}::uuid AND "projectId" = ${projectId}::uuid
        `);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "ProjectMcpActionDispatchAttempt" (
            "id", "projectId", "actionId", "actorKind", "actorId", "actorProjectMembershipId", "actorMembershipCreatedAt", "rpcRequestId", "reservationTokenHash", "status",
            "actionFingerprint", "definitionFingerprint", "networkFingerprint", "credentialFingerprint", "connectionConfigurationRevision", "connectionOwnerId", "connectionOwnerAccountAccessVersion", "reservationTransactionId", "reservationExpiresAt", "reservedAt", "createdAt"
          )
          SELECT ${recoveryAttemptId}::uuid, source."projectId", source."id", 'owner'::"ProjectMcpActionRuntimeActorKind", source."lastActorId", source."lastActorProjectMembershipId", source."lastActorMembershipCreatedAt", ${recoveryRpcId}::uuid,
            repeat('1', 64), 'reserved'::"ProjectMcpActionDispatchAttemptStatus", source."actionFingerprint", source."definitionFingerprint", source."networkFingerprint", source."credentialFingerprint", source."connectionConfigurationRevision", source."connectionOwnerId", source."connectionOwnerAccountAccessVersion", source."transitionTransactionId",
            source."transitionAt" + interval '200 milliseconds', source."transitionAt", source."transitionAt"
          FROM "ProjectMcpAction" AS source WHERE source."id" = ${recoveryActionId}::uuid AND source."projectId" = ${projectId}::uuid
        `);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "ProjectMcpActionRuntimeLedger" (
            "id", "projectId", "actionId", "attemptId", "rpcRequestId", "actorKind", "actorId", "actorProjectMembershipId", "actorMembershipCreatedAt", "event", "statusBefore", "statusAfter", "stateVersion",
            "actionFingerprint", "definitionFingerprint", "networkFingerprint", "credentialFingerprint", "connectionConfigurationRevision", "connectionOwnerId", "connectionOwnerAccountAccessVersion", "transactionId", "transitionAt", "createdAt"
          )
          SELECT gen_random_uuid(), source."projectId", source."id", ${recoveryAttemptId}::uuid, ${recoveryRpcId}::uuid, 'owner'::"ProjectMcpActionRuntimeActorKind", source."lastActorId", source."lastActorProjectMembershipId", source."lastActorMembershipCreatedAt", 'reserved'::"ProjectMcpActionRuntimeLedgerEvent", 'approved'::"ProjectMcpActionStatus", 'dispatch_reserved'::"ProjectMcpActionStatus", 3,
            source."actionFingerprint", source."definitionFingerprint", source."networkFingerprint", source."credentialFingerprint", source."connectionConfigurationRevision", source."connectionOwnerId", source."connectionOwnerAccountAccessVersion", 0, TIMESTAMP 'epoch', TIMESTAMP 'epoch'
          FROM "ProjectMcpAction" AS source WHERE source."id" = ${recoveryActionId}::uuid AND source."projectId" = ${projectId}::uuid
        `);
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(await reconcileStaleProjectMcpActionDispatchReservations(database, 1), 1);
      runtimeAuditId = (await database.projectMcpActionRuntimeLedger.findFirstOrThrow({ where: { actionId: recoveryActionId, event: "unknown" }, select: { id: true } })).id;
      now = new Date();

      assert.ok(manualAuditId !== null);
      assert.ok(manualRecoveryAuditId !== null);
      assert.ok(approvalAuditId !== null);
      assert.ok(runtimeAuditId !== null);

      const manualPage = await listSystemAudit({ source: "projectGitManualRun", pageSize: 50 }, database, now);
      const manualEvent = manualPage.events.find((event) => event.id === manualAuditId);
      assert.ok(manualEvent);
      assert.equal(manualEvent.action, "requested");
      assert.equal(manualEvent.result, "pending");
      assert.equal(manualEvent.actor.id, userId);
      assert.equal(manualEvent.subject?.id, userId);
      assert.deepEqual((await listSystemAudit({ source: "projectGitManualRun", action: "requested", pageSize: 50 }, database, now)).events.map((event) => event.id), [manualAuditId]);
      const manualActorSubjectEvents = (await listSystemAudit({ source: "projectGitManualRun", actor: userId, subject: userId, pageSize: 50 }, database, now)).events;
      assert.ok(manualActorSubjectEvents.some((event) => event.id === manualAuditId));
      assert.equal(manualActorSubjectEvents.some((event) => event.id === manualRecoveryAuditId), false);
      assert.ok(manualActorSubjectEvents.every((event) => event.actor.kind === "user" && event.actor.id === userId && event.subject?.id === userId));
      assert.deepEqual(await getSystemAuditDetail("projectGitManualRun", manualAuditId, database), manualEvent);
      assertSafePublicProjection(manualEvent);
      const manualRecoveryEvent = manualPage.events.find((event) => event.id === manualRecoveryAuditId);
      assert.ok(manualRecoveryEvent);
      assert.equal(manualRecoveryEvent.action, "unknown");
      assert.equal(manualRecoveryEvent.result, "unknown");
      assert.equal(manualRecoveryEvent.actor.kind, "system");
      assert.equal(manualRecoveryEvent.actor.id, null);
      assert.deepEqual((await listSystemAudit({ source: "projectGitManualRun", result: "unknown", pageSize: 50 }, database, now)).events.map((event) => event.id), [manualRecoveryAuditId]);
      assert.equal((await listSystemAudit({ source: "projectGitManualRun", actor: userId, pageSize: 50 }, database, now)).events.some((event) => event.id === manualRecoveryAuditId), false);
      assert.deepEqual(await getSystemAuditDetail("projectGitManualRun", manualRecoveryAuditId, database), manualRecoveryEvent);
      assertSafePublicProjection(manualRecoveryEvent);

      const approvalPage = await listSystemAudit({ source: "projectMcpActionApproval", pageSize: 50 }, database, now);
      const approvalEvent = approvalPage.events.find((event) => event.id === approvalAuditId);
      assert.ok(approvalEvent);
      assert.equal(approvalEvent.action, "approved");
      assert.equal(approvalEvent.result, "applied");
      assert.equal(approvalEvent.actor.id, userId);
      assert.equal(approvalEvent.subject?.id, userId);
      assert.ok((await listSystemAudit({ source: "projectMcpActionApproval", result: "applied", pageSize: 50 }, database, now)).events.some((event) => event.id === approvalAuditId));
      assert.ok((await listSystemAudit({ source: "projectMcpActionApproval", actor: userId, subject: userId, pageSize: 50 }, database, now)).events.some((event) => event.id === approvalAuditId));
      assert.deepEqual(await getSystemAuditDetail("projectMcpActionApproval", approvalAuditId, database), approvalEvent);
      assertSafePublicProjection(approvalEvent);

      const runtimePage = await listSystemAudit({ source: "projectMcpActionRuntime", pageSize: 50 }, database, now);
      const recoveryEvent = runtimePage.events.find((event) => event.id === runtimeAuditId);
      assert.ok(recoveryEvent);
      assert.equal(recoveryEvent.action, "unknown");
      assert.equal(recoveryEvent.result, "unknown");
      assert.equal(recoveryEvent.actor.kind, "system");
      assert.equal(recoveryEvent.actor.id, null);
      assert.equal(recoveryEvent.subject?.id, userId);
      assert.equal(recoveryEvent.evidence.safeErrorCode, "MCP_DISPATCH_RESERVATION_STALE");
      assert.deepEqual((await listSystemAudit({ source: "projectMcpActionRuntime", result: "unknown", pageSize: 50 }, database, now)).events.map((event) => event.id), [runtimeAuditId]);
      const ownerRuntimeEvents = (await listSystemAudit({ source: "projectMcpActionRuntime", actor: userId, pageSize: 50 }, database, now)).events;
      assert.ok(ownerRuntimeEvents.length > 0);
      assert.ok(ownerRuntimeEvents.some((event) => event.action === "reserved" && event.result === "pending"));
      assert.ok(ownerRuntimeEvents.every((event) => event.id !== runtimeAuditId));
      assert.ok(ownerRuntimeEvents.every((event) => event.actor.kind === "user" && event.actor.id === userId));
      assert.deepEqual(await getSystemAuditDetail("projectMcpActionRuntime", runtimeAuditId, database), recoveryEvent);
      assertSafePublicProjection(runtimePage);

      const aiPage = await listSystemAudit({ source: "aiRuntime", pageSize: 50 }, database, now);
      assert.deepEqual(aiPage.events.map((event) => event.id), [aiAuditId]);
      assert.equal(aiPage.events[0]?.result, "rejected");
      assert.equal(aiPage.events[0]?.evidence.safeErrorCode, "AI_PROVIDER_UNKNOWN");
      assert.equal(aiPage.events[0]?.actor.kind, "unrecorded");
      assert.equal(aiPage.events[0]?.actor.id, null);
      assert.equal(aiPage.events[0]?.subject, null);
      assert.deepEqual((await listSystemAudit({ source: "aiRuntime", actor: userId, pageSize: 50 }, database, now)).events, []);
      assertSafePublicProjection(aiPage);

      const webPage = await listSystemAudit({ source: "webAiConfirmation", pageSize: 50 }, database, now);
      assert.deepEqual(webPage.events.map((event) => event.id), [snapshotHeadChallengeId, pendingChallengeId, expiredChallengeId]);
      assert.deepEqual(webPage.events.map((event) => event.result), ["pending", "applied", "expired"]);
      assert.deepEqual((await listSystemAudit({ source: "webAiConfirmation", result: "expired", pageSize: 50 }, database, now)).events.map((event) => event.id), [expiredChallengeId]);
      assert.deepEqual((await listSystemAudit({ source: "webAiConfirmation", result: "pending", pageSize: 50 }, database, now)).events.map((event) => event.id), [snapshotHeadChallengeId]);
      assert.deepEqual((await listSystemAudit({ source: "webAiConfirmation", result: "applied", pageSize: 50 }, database, now)).events.map((event) => event.id), [pendingChallengeId]);
      assertSafePublicProjection(webPage);

      const detail = await getSystemAuditDetail("webAiConfirmation", pendingChallengeId, database);
      assert.equal(detail.result, "applied");
      assertSafePublicProjection(detail);

      const policyPage = await listSystemAudit({ source: "platformGrantOfferPolicy", pageSize: 50 }, database, now);
      const policyEvent = policyPage.events.find((event) => event.id === policyAuditId);
      assert.ok(policyEvent);
      assert.equal(policyEvent.action, "created");
      assert.equal(policyEvent.result, "applied");
      assert.equal(policyEvent.actor.id, userId);
      assert.equal(policyEvent.evidence.after.offerVersion, "signup-500k-v1");
      assert.equal(policyEvent.evidence.after.amount, 500000);
      assert.equal(policyEvent.evidence.reasonRecorded, true);
      assert.deepEqual(await getSystemAuditDetail("platformGrantOfferPolicy", policyAuditId, database), policyEvent);
      assertSafePublicProjection(policyEvent);

      const draftPolicyEvent = policyPage.events.find((event) => event.id === draftPolicyAuditId);
      assert.ok(draftPolicyEvent);
      assert.equal(draftPolicyEvent.action, "created");
      assert.equal(draftPolicyEvent.result, "pending");
      assert.equal(draftPolicyEvent.evidence.after.status, "draft");
      assert.deepEqual(await getSystemAuditDetail("platformGrantOfferPolicy", draftPolicyAuditId, database), draftPolicyEvent);
      assertSafePublicProjection(draftPolicyEvent);
      assert.deepEqual(
        (await listSystemAudit({ source: "platformGrantOfferPolicy", result: "pending", pageSize: 50 }, database, now)).events.map((event) => event.id),
        [draftPolicyAuditId],
      );
      assert.deepEqual(
        (await listSystemAudit({ source: "platformGrantOfferPolicy", result: "applied", pageSize: 50 }, database, now)).events.map((event) => event.id),
        [policyAuditId],
      );
      assert.deepEqual(
        (await listSystemAudit({ source: "platformGrantOfferPolicy", result: "revoked", pageSize: 50 }, database, now)).events,
        [],
      );

      const invitationAuditRows = await database.workspaceInvitationAudit.findMany({
        where: { workspaceId },
        select: { id: true, invitationId: true, event: true },
      });
      const invitationPage = await listSystemAudit({ source: "workspaceInvitation", pageSize: 50 }, database, now);
      const invitationCases = [
        [pendingInvitation.invitation.id, "created", "pending"],
        [acceptedInvitation.invitation.id, "accepted", "applied"],
        [revokedInvitation.invitation.id, "revoked", "revoked"],
      ] as const;
      for (const [invitationId, action, result] of invitationCases) {
        const auditRow = invitationAuditRows.find((row) => row.invitationId === invitationId && row.event === action);
        assert.ok(auditRow, `${action} invitation audit row should exist`);
        const event = invitationPage.events.find((candidate) => candidate.id === auditRow.id);
        assert.ok(event, `${action} invitation event should be projected`);
        assert.equal(event.action, action);
        assert.equal(event.result, result);
        assertSafePublicProjection(event);
      }
      assert.ok((await listSystemAudit({ source: "workspaceInvitation", result: "pending", pageSize: 50 }, database, now)).events.every((event) => event.action === "created"));

      const scoped = await listSystemAudit({ workspaceId, pageSize: 50 }, database, now);
      assert.ok(scoped.events.some((event) => event.id === aiAuditId));
      assert.ok(scoped.events.some((event) => event.id === pendingChallengeId));
      assert.ok(scoped.events.some((event) => event.id === manualAuditId));
      assert.ok(scoped.events.some((event) => event.id === approvalAuditId));
      assert.ok(scoped.events.some((event) => event.id === runtimeAuditId));
      assert.ok(scoped.events.every((event) => event.source !== "platformDefaultAiRoute"));
      assert.deepEqual((await listSystemAudit({ workspaceId, projectId: randomUUID(), pageSize: 50 }, database, now)).events, []);

      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await listSystemAudit({ pageSize: 1, ...(cursor === undefined ? {} : { cursor }) }, database, now);
        for (const event of page.events) {
          assert.equal(seen.has(event.id), false, event.id);
          seen.add(event.id);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      assert.ok(seen.has(aiAuditId));
      assert.ok(seen.has(expiredChallengeId));
      assert.ok(seen.has(pendingChallengeId));
      assert.ok(seen.has(snapshotHeadChallengeId));
      assert.ok(seen.has(manualAuditId));
      assert.ok(seen.has(manualRecoveryAuditId));
      assert.ok(seen.has(approvalAuditId));
      assert.ok(seen.has(runtimeAuditId));
      assert.ok(approvalActionId !== null);
      assert.ok(approvalActionRevision !== null);
      const cancelledApproval = await cancelProjectMcpAction(projectId, approvalActionId, {
        expectedStateVersion: 2,
        expectedActionRevision: approvalActionRevision,
      }, platformAdminActor, database);
      assert.equal(cancelledApproval.created, true);
    } finally {
      // The gate runner drops this disposable database after the test.  The
      // MCP control-plane and append-only audit rows intentionally keep the
      // fixture relations protected, so teardown only releases the client.
      await database.$disconnect();
    }
  },
);
