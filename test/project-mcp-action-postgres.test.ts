import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import test from "node:test";
import { createCredential } from "../src/lib/credential-vault";
import { getDb } from "../src/lib/db";
import { executeMcpConnectionMutation, previewMcpConnectionMutation } from "../src/lib/mcp/connection-governance";
import { createMcpToolReview } from "../src/lib/mcp-tool-review-service";
import {
  confirmProjectMcpConnectionDelegationOwner,
  confirmProjectMcpConnectionDelegationProject,
  proposeProjectMcpConnectionDelegation,
  revokeProjectMcpConnectionDelegation,
} from "../src/lib/project-mcp-connection-delegation-service";
import {
  createProjectMcpToolGrantV2,
  revokeProjectMcpToolGrantV2,
} from "../src/lib/project-mcp-tool-grant-service";
import {
  cancelProjectMcpAction,
  decideProjectMcpAction,
  getProjectMcpAction,
  listProjectMcpActions,
  proposeProjectMcpAction,
  ProjectMcpActionServiceError,
} from "../src/lib/project-mcp-action-service";
import { deleteArchivedProject } from "../src/lib/project-lifecycle";
import { grantProjectMembership, grantWorkspaceMembership } from "../src/lib/membership-governance";

const shouldRun = process.env.PROJECT_MCP_ACTION_POSTGRES_GATE === "1";
const NO_CREDENTIAL_FINGERPRINT = "d2ab012fb807b99b7d059aabe98a45dd6edf6941a5f22699f8d04b5906dc2c2b";

function serviceCode(error: unknown): string {
  return error instanceof ProjectMcpActionServiceError ? error.code : "unexpected";
}

test(
  "project MCP action approval control plane enforces Owner admission, CAS, TTL, drift, and retained evidence",
  { skip: !shouldRun ? "PROJECT_MCP_ACTION_POSTGRES_GATE=1 is required" : false },
  async () => {
    const keyDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-mcp-action-key-"));
    const previousMasterKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    process.env.AI_PROJECT_OS_MASTER_KEY_FILE = join(keyDirectory, "master.key");
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const ownerId = randomUUID();
    const secondOwnerId = randomUUID();
    const editorId = randomUUID();
    const viewerId = randomUUID();
    const workspaceAdminId = randomUUID();
    const systemAdminId = randomUUID();
    const nonmemberId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const connectionId = randomUUID();
    const definitionId = randomUUID();
    const bearerConnectionId = randomUUID();
    const bearerDefinitionId = randomUUID();
    const networkFingerprint = "b".repeat(64);
    const definitionFingerprint = "a".repeat(64);
    const bearerNetworkFingerprint = "e".repeat(64);
    const bearerDefinitionFingerprint = "f".repeat(64);
    const actor = { id: ownerId, role: "admin", accountAccessVersion: 1 } as const;
    const approvingOwner = { id: secondOwnerId, role: "user", accountAccessVersion: 1 } as const;
    const createProposal = async (grantId: string, query: string) => proposeProjectMcpAction(projectId, { clientRequestId: randomUUID(), grantId, expectedGrantVersion: 1, arguments: { query } }, actor, db);
    const recomputeFingerprint = async (targetActionId: string, dateStyle?: "ISO, MDY" | "SQL, DMY") => db.$transaction(async (tx) => {
      if (dateStyle === "ISO, MDY") await tx.$executeRaw(Prisma.sql`SET LOCAL DateStyle = 'ISO, MDY'`);
      if (dateStyle === "SQL, DMY") await tx.$executeRaw(Prisma.sql`SET LOCAL DateStyle = 'SQL, DMY'`);
      const rows = await tx.$queryRaw<Array<{ fingerprint: string }>>(Prisma.sql`
        SELECT "project_mcp_action_snapshot_fingerprint"(source) AS "fingerprint"
        FROM "ProjectMcpAction" AS source
        WHERE source."id" = ${targetActionId}::uuid
      `);
      return rows[0]?.fingerprint;
    });
    const rawCancelWithFakeTimes = async (targetActionId: string, statusBefore: "waiting_approval" | "approved", stateVersion: 2 | 3) => db.$transaction(async (tx) => {
      const fakeApprovedAt = new Date("2001-01-01T00:00:00.000Z");
      const fakeApprovalExpiresAt = new Date("2001-01-01T00:15:00.000Z");
      const fakeRejectedAt = new Date("2001-01-01T00:30:00.000Z");
      const fakeCancelledAt = new Date("2001-01-01T00:45:00.000Z");
      await tx.$executeRaw(Prisma.sql`
        UPDATE "ProjectMcpAction"
        SET "status" = 'cancelled'::"ProjectMcpActionStatus",
            "stateVersion" = ${stateVersion},
            "approvedAt" = ${fakeApprovedAt},
            "approvalExpiresAt" = ${fakeApprovalExpiresAt},
            "rejectedAt" = ${fakeRejectedAt},
            "cancelledAt" = ${fakeCancelledAt}
        WHERE "id" = ${targetActionId}::uuid AND "projectId" = ${projectId}::uuid
      `);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "ProjectMcpActionLedger" (
          "id", "projectId", "actionId", "clientRequestId", "grantId", "delegationId", "toolDefinitionId", "attestationId", "connectionId", "connectionOwnerId", "toolName",
          "event", "statusBefore", "statusAfter", "stateVersion", "actorId", "actorProjectMembershipId", "actorMembershipCreatedAt",
          "grantVersion", "delegationVersion", "attestationVersion", "delegationFingerprint", "definitionFingerprint", "networkFingerprint", "credentialFingerprint",
          "connectionConfigurationRevision", "connectionOwnerAccountAccessVersion", "canonicalArgumentsHash", "actionFingerprint", "transactionId", "transitionAt", "createdAt"
        )
        SELECT gen_random_uuid(), source."projectId", source."id", source."clientRequestId", source."grantId", source."delegationId", source."toolDefinitionId", source."attestationId", source."connectionId", source."connectionOwnerId", source."toolName",
          'cancelled'::"ProjectMcpActionLedgerEvent", ${statusBefore}::"ProjectMcpActionStatus", source."status", source."stateVersion", source."lastActorId", source."lastActorProjectMembershipId", source."lastActorMembershipCreatedAt",
          source."grantVersion", source."delegationVersion", source."attestationVersion", source."delegationFingerprint", source."definitionFingerprint", source."networkFingerprint", source."credentialFingerprint",
          source."connectionConfigurationRevision", source."connectionOwnerAccountAccessVersion", source."canonicalArgumentsHash", source."actionFingerprint", 0, TIMESTAMP 'epoch', TIMESTAMP 'epoch'
        FROM "ProjectMcpAction" AS source
        WHERE source."id" = ${targetActionId}::uuid AND source."projectId" = ${projectId}::uuid
      `);
      return {
        action: await tx.projectMcpAction.findUniqueOrThrow({ where: { id: targetActionId }, select: { status: true, stateVersion: true, actionFingerprint: true, approvedAt: true, approvalExpiresAt: true, rejectedAt: true, cancelledAt: true, transitionAt: true } }),
        ledger: await tx.projectMcpActionLedger.findFirstOrThrow({ where: { actionId: targetActionId, event: "cancelled" }, select: { transitionAt: true, createdAt: true } }),
      };
    });
    try {
      await db.appUser.createMany({ data: [
        { id: ownerId, username: `mcp_action_owner_${suffix}`, role: "admin" },
        { id: secondOwnerId, username: `mcp_action_second_owner_${suffix}`, role: "user" },
        { id: editorId, username: `mcp_action_editor_${suffix}`, role: "user" },
        { id: viewerId, username: `mcp_action_viewer_${suffix}`, role: "user" },
        { id: workspaceAdminId, username: `mcp_action_workspace_admin_${suffix}`, role: "admin" },
        { id: systemAdminId, username: `mcp_action_system_admin_${suffix}`, role: "admin" },
        { id: nonmemberId, username: `mcp_action_nonmember_${suffix}`, role: "user" },
      ] });
      const project = await db.$transaction(async (tx) => {
        await tx.workspace.create({ data: { id: workspaceId, name: `MCP action ${suffix}`, slug: `mcp-action-${suffix}`, createdById: ownerId } });
        const createdProject = await tx.project.create({ data: { id: projectId, workspaceId, name: `MCP action ${suffix}`, slug: `mcp-action-project-${suffix}` } });
        assert.equal(createdProject.id, projectId);
        await grantWorkspaceMembership(tx, { workspaceId, userId: ownerId, role: "owner", actorId: ownerId, reason: "mcp_action_gate_workspace_owner" });
        await grantWorkspaceMembership(tx, { workspaceId, userId: secondOwnerId, role: "owner", actorId: ownerId, reason: "mcp_action_gate_second_workspace_owner" });
        await grantWorkspaceMembership(tx, { workspaceId, userId: workspaceAdminId, role: "admin", actorId: ownerId, reason: "mcp_action_gate_workspace_admin" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: ownerId, role: "owner", actorId: ownerId, reason: "mcp_action_gate_project_owner" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: secondOwnerId, role: "owner", actorId: ownerId, reason: "mcp_action_gate_second_project_owner" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: editorId, role: "editor", actorId: ownerId, reason: "mcp_action_gate_project_editor" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: viewerId, role: "viewer", actorId: ownerId, reason: "mcp_action_gate_project_viewer" });
        return createdProject;
      });
      await db.mcpConnection.create({ data: {
        id: connectionId, name: `MCP action connection ${suffix}`, endpointUrl: "https://mcp.example.invalid/mcp", authKind: "none", credentialId: null,
        allowPrivateNetwork: false, resolvedAddressFingerprint: networkFingerprint, protocolVersion: "2026-07-28", catalogFingerprint: "c".repeat(64),
        credentialFingerprint: NO_CREDENTIAL_FINGERPRINT, configurationRevision: 1, status: "verified", createdById: ownerId, ownerUserId: ownerId, ownerAccountAccessVersion: 1, ownershipState: "confirmed",
      } });
      await db.mcpToolDefinition.create({ data: {
        id: definitionId, connectionId, name: "project.lookup", title: "Lookup", description: "Safe lookup",
        inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false },
        outputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: false }, remoteReadOnlyHint: true, definitionFingerprint, current: true,
      } });
      const connectionSnapshot = await db.mcpConnection.findUniqueOrThrow({ where: { id: connectionId }, select: { updatedAt: true } });
      const reviewed = await createMcpToolReview(actor, {
        connectionId,
        toolDefinitionId: definitionId,
        expectedConnectionConfigurationRevision: 1,
        expectedConnectionUpdatedAt: connectionSnapshot.updatedAt.toISOString(),
        expectedDefinitionFingerprint: definitionFingerprint,
        expectedNetworkFingerprint: networkFingerprint,
        expectedCredentialFingerprint: NO_CREDENTIAL_FINGERPRINT,
        conclusion: "read_only_verified",
        riskLevel: "low",
        riskReasonCode: "read_only_eligible",
        evidenceNote: "动作控制面只读审核",
        requestKey: `mcp-action-review-${suffix}`,
      }, db);
      if (reviewed.review.attestationId === null) throw new Error("MCP_ACTION_GATE_REVIEW_ATTESTATION_MISSING");
      const attestation = { id: reviewed.review.attestationId } as const;
      const draft = await proposeProjectMcpConnectionDelegation(projectId, { mcpConnectionId: connectionId, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, actor, db);
      if (!("id" in draft)) throw new Error("MCP_ACTION_GATE_DELEGATION_CREATE_FAILED");
      await confirmProjectMcpConnectionDelegationOwner(projectId, draft.id, { expectedVersion: 1, acknowledgeCredentialUse: true }, actor, db);
      const activeDelegation = await confirmProjectMcpConnectionDelegationProject(projectId, draft.id, { expectedVersion: 2, acknowledgeProjectScope: true, acknowledgeDataEgress: true }, actor, db);
      if (!("id" in activeDelegation)) throw new Error("MCP_ACTION_GATE_DELEGATION_ACTIVATE_FAILED");
      const delegation = await db.projectMcpConnectionDelegation.findUniqueOrThrow({ where: { id: activeDelegation.id }, select: { id: true, version: true } });
      const grant = await createProjectMcpToolGrantV2(projectId, { delegationId: delegation.id, toolDefinitionId: definitionId, attestationId: attestation.id, expectedDelegationVersion: delegation.version, expectedAttestationVersion: 1 as const, acknowledgeReadOnly: true as const }, actor, db);
      const grantId = grant.grant.id as string;

      // Keep the primary no-credential tuple unchanged.  This isolated
      // bearer-backed tuple exists only to exercise governance rotation as a
      // safe source-snapshot drift for the action approval assertions.
      const bearerCredential = await createCredential("mcp", `action-rotation-${suffix}`, db);
      const bearerCredentialSnapshot = await db.externalCredential.findUniqueOrThrow({
        where: { id: bearerCredential.id },
        select: { secretFingerprint: true },
      });
      await db.mcpConnection.create({ data: {
        id: bearerConnectionId,
        name: `MCP action drift connection ${suffix}`,
        endpointUrl: "https://mcp.example.invalid/mcp",
        authKind: "bearer",
        credentialId: bearerCredential.id,
        allowPrivateNetwork: false,
        resolvedAddressFingerprint: bearerNetworkFingerprint,
        protocolVersion: "2026-07-28",
        catalogFingerprint: "d".repeat(64),
        credentialFingerprint: bearerCredentialSnapshot.secretFingerprint,
        configurationRevision: 1,
        status: "verified",
        createdById: ownerId,
        ownerUserId: ownerId,
        ownerAccountAccessVersion: 1,
        ownershipState: "confirmed",
      } });
      await db.mcpToolDefinition.create({ data: {
        id: bearerDefinitionId,
        connectionId: bearerConnectionId,
        name: "project.lookup.drift",
        title: "Drift lookup",
        description: "Governance drift fixture",
        inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false },
        outputSchema: { type: "object" },
        annotations: { readOnlyHint: true, destructiveHint: false },
        remoteReadOnlyHint: true,
        definitionFingerprint: bearerDefinitionFingerprint,
        current: true,
      } });
      const bearerConnectionSnapshot = await db.mcpConnection.findUniqueOrThrow({ where: { id: bearerConnectionId }, select: { updatedAt: true } });
      const bearerReviewed = await createMcpToolReview(actor, {
        connectionId: bearerConnectionId,
        toolDefinitionId: bearerDefinitionId,
        expectedConnectionConfigurationRevision: 1,
        expectedConnectionUpdatedAt: bearerConnectionSnapshot.updatedAt.toISOString(),
        expectedDefinitionFingerprint: bearerDefinitionFingerprint,
        expectedNetworkFingerprint: bearerNetworkFingerprint,
        expectedCredentialFingerprint: bearerCredentialSnapshot.secretFingerprint,
        conclusion: "read_only_verified",
        riskLevel: "low",
        riskReasonCode: "read_only_eligible",
        evidenceNote: "动作控制面凭据只读审核",
        requestKey: `mcp-action-bearer-review-${suffix}`,
      }, db);
      if (bearerReviewed.review.attestationId === null) throw new Error("MCP_ACTION_GATE_BEARER_REVIEW_ATTESTATION_MISSING");
      const bearerAttestation = { id: bearerReviewed.review.attestationId } as const;
      const bearerDraft = await proposeProjectMcpConnectionDelegation(projectId, {
        mcpConnectionId: bearerConnectionId,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }, actor, db);
      if (!("id" in bearerDraft)) throw new Error("MCP_ACTION_GATE_BEARER_DELEGATION_CREATE_FAILED");
      await confirmProjectMcpConnectionDelegationOwner(projectId, bearerDraft.id, { expectedVersion: 1, acknowledgeCredentialUse: true }, actor, db);
      const activeBearerDelegation = await confirmProjectMcpConnectionDelegationProject(projectId, bearerDraft.id, { expectedVersion: 2, acknowledgeProjectScope: true, acknowledgeDataEgress: true }, actor, db);
      if (!("id" in activeBearerDelegation)) throw new Error("MCP_ACTION_GATE_BEARER_DELEGATION_ACTIVATE_FAILED");
      const bearerDelegation = await db.projectMcpConnectionDelegation.findUniqueOrThrow({ where: { id: activeBearerDelegation.id }, select: { id: true, version: true } });
      const bearerGrant = await createProjectMcpToolGrantV2(projectId, {
        delegationId: bearerDelegation.id,
        toolDefinitionId: bearerDefinitionId,
        attestationId: bearerAttestation.id,
        expectedDelegationVersion: bearerDelegation.version,
        expectedAttestationVersion: 1,
        acknowledgeReadOnly: true,
      }, actor, db);
      const bearerGrantId = bearerGrant.grant.id as string;

      for (const unauthorized of [editorId, viewerId, workspaceAdminId, systemAdminId, nonmemberId]) {
        await assert.rejects(() => listProjectMcpActions(projectId, { id: unauthorized, role: "user" }, db), (error: unknown) => ["PROJECT_MCP_ACTION_PROJECT_OWNER_REQUIRED", "PROJECT_MCP_ACTION_FORBIDDEN"].includes(serviceCode(error)));
        await assert.rejects(() => proposeProjectMcpAction(projectId, { clientRequestId: randomUUID(), grantId, expectedGrantVersion: 1, arguments: { query: "blocked" } }, { id: unauthorized, role: "user" }, db), (error: unknown) => ["PROJECT_MCP_ACTION_PROJECT_OWNER_REQUIRED", "PROJECT_MCP_ACTION_FORBIDDEN"].includes(serviceCode(error)));
      }

      const proposal = await proposeProjectMcpAction(projectId, { clientRequestId: randomUUID(), grantId, expectedGrantVersion: 1, arguments: { query: "release" } }, actor, db);
      assert.equal(proposal.created, true);
      const actionId = proposal.action.id as string;
      const actionRevision = proposal.action.actionRevision as string;
      assert.match(actionRevision, /^[0-9a-f]{64}$/u);
      assert.equal("actionFingerprint" in proposal.action, false);
      assert.equal("canonicalArgumentsHash" in proposal.action, false);
      const replay = await proposeProjectMcpAction(projectId, { clientRequestId: proposal.action.clientRequestId, grantId, expectedGrantVersion: 1, arguments: { query: "release" } }, actor, db);
      assert.equal(replay.created, false);
      await assert.rejects(() => proposeProjectMcpAction(projectId, { clientRequestId: proposal.action.clientRequestId, grantId, expectedGrantVersion: 1, arguments: { query: "different" } }, actor, db), (error: unknown) => serviceCode(error) === "PROJECT_MCP_ACTION_IDEMPOTENCY_CONFLICT");
      const list = await listProjectMcpActions(projectId, actor, db);
      assert.equal(list.actions.length, 1);
      assert.equal("arguments" in list.actions[0]!, false);
      assert.equal("actionFingerprint" in list.actions[0]!, false);
      const detail = await getProjectMcpAction(projectId, actionId, actor, db);
      assert.deepEqual(detail.arguments, { query: "release" });
      const editorMembership = await db.projectMembership.findFirstOrThrow({
        where: { projectId, userId: editorId, role: "editor", accessState: "confirmed" },
        select: { id: true, createdAt: true },
      });
      const persisted = await db.projectMcpAction.findUniqueOrThrow({ where: { id: actionId }, select: {
        actionFingerprint: true,
        canonicalArgumentsHash: true,
        creationTransactionId: true,
        transitionTransactionId: true,
        createdAt: true,
        transitionAt: true,
        canonicalArguments: true,
      } });
      const recomputed = await db.$queryRaw<Array<{ argumentsHash: string; fingerprint: string }>>(Prisma.sql`
        SELECT
          encode(digest(convert_to(source."canonicalArguments"::text, 'UTF8'), 'sha256'), 'hex') AS "argumentsHash",
          "project_mcp_action_snapshot_fingerprint"(source) AS "fingerprint"
        FROM "ProjectMcpAction" AS source
        WHERE source."id" = ${actionId}::uuid
      `);
      assert.equal(persisted.canonicalArgumentsHash, recomputed[0]?.argumentsHash);
      assert.equal(persisted.actionFingerprint, recomputed[0]?.fingerprint);
      assert.equal(persisted.creationTransactionId, persisted.transitionTransactionId);
      assert.notEqual(persisted.creationTransactionId, BigInt(0));
      assert.ok(persisted.createdAt.getTime() > 0 && persisted.transitionAt.getTime() > 0);
      assert.equal(persisted.createdAt.getTime(), persisted.transitionAt.getTime());
      const proposalLedger = await db.projectMcpActionLedger.findFirstOrThrow({ where: { actionId }, orderBy: { stateVersion: "asc" }, select: { transitionAt: true, createdAt: true } });
      assert.equal(proposalLedger.transitionAt.getTime(), persisted.transitionAt.getTime());
      assert.equal(proposalLedger.createdAt.getTime(), persisted.transitionAt.getTime());
      assert.equal(await recomputeFingerprint(actionId, "ISO, MDY"), persisted.actionFingerprint);
      assert.equal(await recomputeFingerprint(actionId, "SQL, DMY"), persisted.actionFingerprint);

      await assert.rejects(() => db.$executeRaw(Prisma.sql`
        INSERT INTO "ProjectMcpAction" (
          "id", "projectId", "clientRequestId", "grantId", "delegationId", "toolDefinitionId", "attestationId", "connectionId", "toolName",
          "inputSchema", "canonicalArguments", "canonicalArgumentsHash", "actionFingerprint", "status", "stateVersion",
          "proposerProjectMembershipId", "proposerMembershipCreatedAt", "lastActorId", "lastActorProjectMembershipId", "lastActorMembershipCreatedAt",
          "grantVersion", "delegationVersion", "attestationVersion", "delegationFingerprint", "definitionFingerprint", "networkFingerprint", "credentialFingerprint",
          "connectionConfigurationRevision", "connectionOwnerId", "connectionOwnerAccountAccessVersion", "connectionOwnershipState", "connectionAllowPrivateNetwork", "connectionUpdatedAt", "credentialUpdatedAt",
          "creationTransactionId", "transitionTransactionId"
        )
        SELECT gen_random_uuid(), source."projectId", gen_random_uuid(), ${randomUUID()}::uuid, source."delegationId", source."toolDefinitionId", source."attestationId", source."connectionId", source."toolName",
          source."inputSchema", source."canonicalArguments", repeat('f', 64), repeat('e', 64), 'waiting_approval'::"ProjectMcpActionStatus", 1,
          source."proposerProjectMembershipId", source."proposerMembershipCreatedAt", source."lastActorId", source."lastActorProjectMembershipId", source."lastActorMembershipCreatedAt",
          source."grantVersion", source."delegationVersion", source."attestationVersion", source."delegationFingerprint", source."definitionFingerprint", source."networkFingerprint", source."credentialFingerprint",
          source."connectionConfigurationRevision", source."connectionOwnerId", source."connectionOwnerAccountAccessVersion", source."connectionOwnershipState", source."connectionAllowPrivateNetwork", source."connectionUpdatedAt", source."credentialUpdatedAt",
          0, 0
        FROM "ProjectMcpAction" AS source
        WHERE source."id" = ${actionId}::uuid
      `), /PROJECT_MCP_ACTION_SOURCE_TUPLE_INVALID/u);

      const cloneRequestId = randomUUID();
      await assert.rejects(() => db.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "ProjectMcpAction" (
            "id", "projectId", "clientRequestId", "grantId", "delegationId", "toolDefinitionId", "attestationId", "connectionId", "toolName",
            "inputSchema", "canonicalArguments", "canonicalArgumentsHash", "actionFingerprint", "status", "stateVersion",
            "proposerProjectMembershipId", "proposerMembershipCreatedAt", "lastActorId", "lastActorProjectMembershipId", "lastActorMembershipCreatedAt",
            "grantVersion", "delegationVersion", "attestationVersion", "delegationFingerprint", "definitionFingerprint", "networkFingerprint", "credentialFingerprint",
            "connectionConfigurationRevision", "connectionOwnerId", "connectionOwnerAccountAccessVersion", "connectionOwnershipState", "connectionAllowPrivateNetwork", "connectionUpdatedAt", "credentialUpdatedAt",
            "creationTransactionId", "transitionTransactionId"
          )
          SELECT gen_random_uuid(), source."projectId", ${cloneRequestId}::uuid, source."grantId", source."delegationId", source."toolDefinitionId", source."attestationId", source."connectionId", source."toolName",
            source."inputSchema", source."canonicalArguments", repeat('f', 64), repeat('e', 64), 'waiting_approval'::"ProjectMcpActionStatus", 1,
            source."proposerProjectMembershipId", source."proposerMembershipCreatedAt", source."lastActorId", source."lastActorProjectMembershipId", source."lastActorMembershipCreatedAt",
            source."grantVersion", source."delegationVersion", source."attestationVersion", source."delegationFingerprint", source."definitionFingerprint", source."networkFingerprint", source."credentialFingerprint",
            source."connectionConfigurationRevision", source."connectionOwnerId", source."connectionOwnerAccountAccessVersion", source."connectionOwnershipState", source."connectionAllowPrivateNetwork", source."connectionUpdatedAt", source."credentialUpdatedAt",
            0, 0
          FROM "ProjectMcpAction" AS source
          WHERE source."id" = ${actionId}::uuid
        `);
        const clone = await tx.projectMcpAction.findUniqueOrThrow({ where: { projectId_clientRequestId: { projectId, clientRequestId: cloneRequestId } }, select: { canonicalArgumentsHash: true, actionFingerprint: true } });
        assert.notEqual(clone.canonicalArgumentsHash, "f".repeat(64));
        assert.notEqual(clone.actionFingerprint, "e".repeat(64));
        throw new Error("ROLLBACK_DB_OWNED_HASH_EVIDENCE");
      }), /ROLLBACK_DB_OWNED_HASH_EVIDENCE/u);

      // A terminal state cannot be committed without its matching decision.
      // Keep the source action in waiting state by rolling back each forged
      // transition, then exercise both terminal decision kinds.
      const assertTerminalWithoutDecisionRejected = async (proposalId: string, status: "approved" | "rejected") => {
        await assert.rejects(() => db.$transaction(async (tx) => {
          await tx.$executeRaw(Prisma.sql`
            UPDATE "ProjectMcpAction"
            SET "status" = ${status === "approved" ? "approved" : "rejected"}::"ProjectMcpActionStatus", "stateVersion" = 2
            WHERE "id" = ${proposalId}::uuid AND "projectId" = ${projectId}::uuid
          `);
          await tx.$executeRaw(Prisma.sql`
            INSERT INTO "ProjectMcpActionLedger" (
              "id", "projectId", "actionId", "clientRequestId", "grantId", "delegationId", "toolDefinitionId", "attestationId", "connectionId", "connectionOwnerId", "toolName",
              "event", "statusBefore", "statusAfter", "stateVersion", "actorId", "actorProjectMembershipId", "actorMembershipCreatedAt",
              "grantVersion", "delegationVersion", "attestationVersion", "delegationFingerprint", "definitionFingerprint", "networkFingerprint", "credentialFingerprint",
              "connectionConfigurationRevision", "connectionOwnerAccountAccessVersion", "canonicalArgumentsHash", "actionFingerprint", "transactionId", "transitionAt", "createdAt"
            )
            SELECT gen_random_uuid(), source."projectId", source."id", source."clientRequestId", source."grantId", source."delegationId", source."toolDefinitionId", source."attestationId", source."connectionId", source."connectionOwnerId", source."toolName",
              ${status === "approved" ? "approved" : "rejected"}::"ProjectMcpActionLedgerEvent", 'waiting_approval'::"ProjectMcpActionStatus", source."status", source."stateVersion", source."lastActorId", source."lastActorProjectMembershipId", source."lastActorMembershipCreatedAt",
              source."grantVersion", source."delegationVersion", source."attestationVersion", source."delegationFingerprint", source."definitionFingerprint", source."networkFingerprint", source."credentialFingerprint",
              source."connectionConfigurationRevision", source."connectionOwnerAccountAccessVersion", source."canonicalArgumentsHash", source."actionFingerprint", 0, TIMESTAMP 'epoch', TIMESTAMP 'epoch'
            FROM "ProjectMcpAction" AS source
            WHERE source."id" = ${proposalId}::uuid AND source."projectId" = ${projectId}::uuid
          `);
        }), /PROJECT_MCP_ACTION_(?:EVIDENCE_REQUIRED|RELATED_EVIDENCE_REQUIRED)/u);
      };
      const missingApproved = await createProposal(grantId, "missing-approved");
      await assertTerminalWithoutDecisionRejected(missingApproved.action.id as string, "approved");
      const missingRejected = await createProposal(grantId, "missing-rejected");
      await assertTerminalWithoutDecisionRejected(missingRejected.action.id as string, "rejected");

      // A decision supplied after cancellation, or by a different actor/epoch,
      // is rejected by the database trigger before any evidence can be forged.
      const lateProposal = await createProposal(grantId, "late-decision");
      await cancelProjectMcpAction(projectId, lateProposal.action.id as string, { expectedStateVersion: 1, expectedActionRevision: lateProposal.action.actionRevision }, actor, db);
      const latePersisted = await db.projectMcpAction.findUniqueOrThrow({ where: { id: lateProposal.action.id as string }, select: { actionFingerprint: true, proposerProjectMembershipId: true } });
      await assert.rejects(() => db.$executeRaw(Prisma.sql`
        INSERT INTO "ProjectMcpActionDecision" (
          "id", "projectId", "actionId", "decision", "expectedStateVersion", "expectedActionFingerprint", "actorId", "actorProjectMembershipId", "actorMembershipCreatedAt", "reasonCode", "acknowledgedSingleUse", "transactionId", "decidedAt", "createdAt"
        ) VALUES (
          gen_random_uuid(), ${projectId}::uuid, ${lateProposal.action.id}::uuid, 'approved'::"ProjectMcpActionDecisionKind", 1, ${latePersisted.actionFingerprint}, ${ownerId}::uuid, ${latePersisted.proposerProjectMembershipId}::uuid, ${new Date(0)}, NULL, true, 0, TIMESTAMP 'epoch', TIMESTAMP 'epoch'
        )
      `), /PROJECT_MCP_ACTION_DECISION_INVALID/u);

      const forgedActorProposal = await createProposal(grantId, "wrong-actor");
      const forgedActorPersisted = await db.projectMcpAction.findUniqueOrThrow({ where: { id: forgedActorProposal.action.id as string }, select: { actionFingerprint: true } });
      await assert.rejects(() => db.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "ProjectMcpAction"
          SET "status" = 'approved'::"ProjectMcpActionStatus", "stateVersion" = 2
          WHERE "id" = ${forgedActorProposal.action.id}::uuid AND "projectId" = ${projectId}::uuid
        `);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "ProjectMcpActionDecision" (
            "id", "projectId", "actionId", "decision", "expectedStateVersion", "expectedActionFingerprint", "actorId", "actorProjectMembershipId", "actorMembershipCreatedAt", "reasonCode", "acknowledgedSingleUse", "transactionId", "decidedAt", "createdAt"
          ) VALUES (
            gen_random_uuid(), ${projectId}::uuid, ${forgedActorProposal.action.id}::uuid, 'approved'::"ProjectMcpActionDecisionKind", 1, ${forgedActorPersisted.actionFingerprint}, ${editorId}::uuid, ${editorMembership.id}::uuid, ${editorMembership.createdAt}, NULL, true, 0, TIMESTAMP 'epoch', TIMESTAMP 'epoch'
          )
        `);
      }), /PROJECT_MCP_ACTION_DECISION_INVALID/u);

      const forgedEpochProposal = await createProposal(grantId, "wrong-epoch");
      const forgedEpochPersisted = await db.projectMcpAction.findUniqueOrThrow({ where: { id: forgedEpochProposal.action.id as string }, select: { actionFingerprint: true, proposerProjectMembershipId: true } });
      await assert.rejects(() => db.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "ProjectMcpAction"
          SET "status" = 'approved'::"ProjectMcpActionStatus", "stateVersion" = 2
          WHERE "id" = ${forgedEpochProposal.action.id}::uuid AND "projectId" = ${projectId}::uuid
        `);
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "ProjectMcpActionDecision" (
            "id", "projectId", "actionId", "decision", "expectedStateVersion", "expectedActionFingerprint", "actorId", "actorProjectMembershipId", "actorMembershipCreatedAt", "reasonCode", "acknowledgedSingleUse", "transactionId", "decidedAt", "createdAt"
          ) VALUES (
            gen_random_uuid(), ${projectId}::uuid, ${forgedEpochProposal.action.id}::uuid, 'approved'::"ProjectMcpActionDecisionKind", 1, ${forgedEpochPersisted.actionFingerprint}, ${ownerId}::uuid, ${forgedEpochPersisted.proposerProjectMembershipId}::uuid, ${new Date(0)}, NULL, true, 0, TIMESTAMP 'epoch', TIMESTAMP 'epoch'
          )
        `);
      }), /PROJECT_MCP_ACTION_DECISION_INVALID/u);

      for (const forged of [missingApproved, missingRejected, forgedActorProposal, forgedEpochProposal]) {
        await cancelProjectMcpAction(projectId, forged.action.id as string, { expectedStateVersion: 1, expectedActionRevision: forged.action.actionRevision }, actor, db);
      }

      const approved = await decideProjectMcpAction(projectId, actionId, { decision: "approved", expectedStateVersion: 1, expectedActionRevision: actionRevision, acknowledgeSingleUse: true }, approvingOwner, db);
      assert.equal(approved.created, true);
      const approvedReplay = await decideProjectMcpAction(projectId, actionId, { decision: "approved", expectedStateVersion: 1, expectedActionRevision: actionRevision, acknowledgeSingleUse: true }, approvingOwner, db);
      assert.equal(approvedReplay.created, false);
      const approvedRow = await db.projectMcpAction.findUniqueOrThrow({ where: { id: actionId }, select: { status: true, stateVersion: true, approvedAt: true, approvalExpiresAt: true, actionFingerprint: true } });
      assert.equal(approvedRow.status, "approved");
      assert.equal(approvedRow.stateVersion, 2);
      assert.ok(approvedRow.approvedAt !== null);
      assert.ok(approvedRow.approvalExpiresAt !== null && approvedRow.approvalExpiresAt.getTime() > Date.now() + 14 * 60_000);
      assert.ok(approvedRow.approvedAt !== null && approvedRow.approvalExpiresAt !== null);
      assert.equal(approvedRow.approvalExpiresAt.getTime() - approvedRow.approvedAt.getTime(), 15 * 60_000);
      const approvedEvidence = await db.projectMcpAction.findUniqueOrThrow({ where: { id: actionId }, select: { actionFingerprint: true, transitionTransactionId: true, transitionAt: true, lastActorId: true, lastActorProjectMembershipId: true, lastActorMembershipCreatedAt: true } });
      const approvedLedger = await db.projectMcpActionLedger.findFirstOrThrow({ where: { actionId, event: "approved" }, select: { transitionAt: true, createdAt: true, transactionId: true } });
      const decisionEvidence = await db.projectMcpActionDecision.findUniqueOrThrow({ where: { projectId_actionId: { projectId, actionId } } });
      assert.equal(decisionEvidence.transactionId, approvedEvidence.transitionTransactionId);
      assert.notEqual(decisionEvidence.transactionId, BigInt(0));
      assert.equal(decisionEvidence.expectedActionFingerprint, approvedEvidence.actionFingerprint);
      assert.equal(decisionEvidence.actorId, approvedEvidence.lastActorId);
      assert.equal(decisionEvidence.actorProjectMembershipId, approvedEvidence.lastActorProjectMembershipId);
      assert.equal(decisionEvidence.actorMembershipCreatedAt.getTime(), approvedEvidence.lastActorMembershipCreatedAt.getTime());
      assert.equal(approvedEvidence.transitionAt.getTime(), approvedLedger.transitionAt.getTime());
      assert.equal(approvedEvidence.transitionAt.getTime(), approvedLedger.createdAt.getTime());
      assert.equal(decisionEvidence.transactionId, approvedLedger.transactionId);
      assert.equal(decisionEvidence.decidedAt.getTime(), approvedLedger.transitionAt.getTime());
      assert.equal(decisionEvidence.createdAt.getTime(), approvedLedger.createdAt.getTime());
      assert.equal(await recomputeFingerprint(actionId, "ISO, MDY"), approvedEvidence.actionFingerprint);
      assert.equal(await recomputeFingerprint(actionId, "SQL, DMY"), approvedEvidence.actionFingerprint);
      await assert.rejects(() => db.projectMcpActionDecision.updateMany({ where: { projectId, actionId }, data: { reasonCode: "notNeeded" } }), /PROJECT_MCP_ACTION_DECISION_IMMUTABLE/u);
      await assert.rejects(() => db.projectMcpActionDecision.deleteMany({ where: { projectId, actionId } }), /PROJECT_MCP_ACTION_DECISION_IMMUTABLE/u);
      const cancelled = await cancelProjectMcpAction(projectId, actionId, { expectedStateVersion: 2, expectedActionRevision: actionRevision }, actor, db);
      assert.equal(cancelled.created, true);
      const cancelledRow = await db.projectMcpAction.findUniqueOrThrow({ where: { id: actionId }, select: { status: true, stateVersion: true, approvedAt: true, approvalExpiresAt: true, rejectedAt: true, cancelledAt: true, transitionAt: true, actionFingerprint: true } });
      const cancelledLedger = await db.projectMcpActionLedger.findFirstOrThrow({ where: { actionId, event: "cancelled" }, select: { transitionAt: true, createdAt: true } });
      assert.equal(cancelledRow.status, "cancelled");
      assert.equal(cancelledRow.stateVersion, 3);
      assert.equal(cancelledRow.approvedAt?.getTime(), approvedRow.approvedAt?.getTime());
      assert.equal(cancelledRow.approvalExpiresAt?.getTime(), approvedRow.approvalExpiresAt?.getTime());
      assert.equal(cancelledRow.rejectedAt, null);
      assert.ok(cancelledRow.cancelledAt !== null);
      assert.equal(cancelledRow.cancelledAt.getTime(), cancelledRow.transitionAt.getTime());
      assert.equal(cancelledLedger.transitionAt.getTime(), cancelledRow.transitionAt.getTime());
      assert.equal(cancelledLedger.createdAt.getTime(), cancelledRow.transitionAt.getTime());
      assert.equal(await recomputeFingerprint(actionId, "ISO, MDY"), cancelledRow.actionFingerprint);
      assert.equal(await recomputeFingerprint(actionId, "SQL, DMY"), cancelledRow.actionFingerprint);
      assert.equal(await db.projectMcpActionDecision.count({ where: { projectId, actionId } }), 1);
      const cancelReplay = await cancelProjectMcpAction(projectId, actionId, { expectedStateVersion: 2, expectedActionRevision: actionRevision }, actor, db);
      assert.equal(cancelReplay.created, false);

      const rejectedProposal = await createProposal(grantId, "reject-me");
      const rejectedId = rejectedProposal.action.id as string;
      const rejected = await decideProjectMcpAction(projectId, rejectedId, { decision: "rejected", expectedStateVersion: 1, expectedActionRevision: rejectedProposal.action.actionRevision, reasonCode: "not_needed" }, actor, db);
      assert.equal(rejected.created, true);
      const rejectedRow = await db.projectMcpAction.findUniqueOrThrow({ where: { id: rejectedId }, select: { status: true, stateVersion: true, rejectedAt: true, transitionAt: true, actionFingerprint: true } });
      const rejectedLedger = await db.projectMcpActionLedger.findFirstOrThrow({ where: { actionId: rejectedId, event: "rejected" }, select: { transitionAt: true, createdAt: true } });
      const rejectedDecision = await db.projectMcpActionDecision.findUniqueOrThrow({ where: { projectId_actionId: { projectId, actionId: rejectedId } }, select: { decidedAt: true, createdAt: true } });
      assert.equal(rejectedRow.status, "rejected");
      assert.equal(rejectedRow.stateVersion, 2);
      assert.ok(rejectedRow.rejectedAt !== null);
      assert.equal(rejectedRow.rejectedAt.getTime(), rejectedRow.transitionAt.getTime());
      assert.equal(rejectedLedger.transitionAt.getTime(), rejectedRow.transitionAt.getTime());
      assert.equal(rejectedLedger.createdAt.getTime(), rejectedRow.transitionAt.getTime());
      assert.equal(rejectedDecision.decidedAt.getTime(), rejectedLedger.transitionAt.getTime());
      assert.equal(rejectedDecision.createdAt.getTime(), rejectedLedger.createdAt.getTime());
      assert.equal(await recomputeFingerprint(rejectedId, "ISO, MDY"), rejectedRow.actionFingerprint);
      assert.equal(await recomputeFingerprint(rejectedId, "SQL, DMY"), rejectedRow.actionFingerprint);

      const rawWaitingCancelProposal = await createProposal(grantId, "raw-waiting-cancel");
      const rawWaitingCancelled = await rawCancelWithFakeTimes(rawWaitingCancelProposal.action.id as string, "waiting_approval", 2);
      assert.equal(rawWaitingCancelled.action.status, "cancelled");
      assert.equal(rawWaitingCancelled.action.stateVersion, 2);
      assert.equal(rawWaitingCancelled.action.approvedAt, null);
      assert.equal(rawWaitingCancelled.action.approvalExpiresAt, null);
      assert.equal(rawWaitingCancelled.action.rejectedAt, null);
      assert.ok(rawWaitingCancelled.action.cancelledAt !== null);
      assert.equal(rawWaitingCancelled.action.cancelledAt.getTime(), rawWaitingCancelled.action.transitionAt.getTime());
      assert.equal(rawWaitingCancelled.ledger.transitionAt.getTime(), rawWaitingCancelled.action.transitionAt.getTime());
      assert.equal(rawWaitingCancelled.ledger.createdAt.getTime(), rawWaitingCancelled.action.transitionAt.getTime());
      assert.equal(await recomputeFingerprint(rawWaitingCancelProposal.action.id as string, "ISO, MDY"), rawWaitingCancelled.action.actionFingerprint);
      assert.equal(await recomputeFingerprint(rawWaitingCancelProposal.action.id as string, "SQL, DMY"), rawWaitingCancelled.action.actionFingerprint);

      const rawApprovedCancelProposal = await createProposal(grantId, "raw-approved-cancel");
      const rawApprovedId = rawApprovedCancelProposal.action.id as string;
      await decideProjectMcpAction(projectId, rawApprovedId, { decision: "approved", expectedStateVersion: 1, expectedActionRevision: rawApprovedCancelProposal.action.actionRevision, acknowledgeSingleUse: true }, approvingOwner, db);
      const rawApprovedBeforeCancel = await db.projectMcpAction.findUniqueOrThrow({ where: { id: rawApprovedId }, select: { approvedAt: true, approvalExpiresAt: true, actionFingerprint: true } });
      const rawApprovedCancelled = await rawCancelWithFakeTimes(rawApprovedId, "approved", 3);
      assert.equal(rawApprovedCancelled.action.status, "cancelled");
      assert.equal(rawApprovedCancelled.action.stateVersion, 3);
      assert.equal(rawApprovedCancelled.action.approvedAt?.getTime(), rawApprovedBeforeCancel.approvedAt?.getTime());
      assert.equal(rawApprovedCancelled.action.approvalExpiresAt?.getTime(), rawApprovedBeforeCancel.approvalExpiresAt?.getTime());
      assert.equal(rawApprovedCancelled.action.rejectedAt, null);
      assert.ok(rawApprovedCancelled.action.cancelledAt !== null);
      assert.equal(rawApprovedCancelled.action.cancelledAt.getTime(), rawApprovedCancelled.action.transitionAt.getTime());
      assert.equal(rawApprovedCancelled.ledger.transitionAt.getTime(), rawApprovedCancelled.action.transitionAt.getTime());
      assert.equal(rawApprovedCancelled.ledger.createdAt.getTime(), rawApprovedCancelled.action.transitionAt.getTime());
      assert.equal(await recomputeFingerprint(rawApprovedId, "ISO, MDY"), rawApprovedCancelled.action.actionFingerprint);
      assert.equal(await recomputeFingerprint(rawApprovedId, "SQL, DMY"), rawApprovedCancelled.action.actionFingerprint);
      const rawApprovedDecision = await db.projectMcpActionDecision.findUniqueOrThrow({ where: { projectId_actionId: { projectId, actionId: rawApprovedId } }, select: { decidedAt: true, createdAt: true } });
      const rawApprovedLedger = await db.projectMcpActionLedger.findFirstOrThrow({ where: { actionId: rawApprovedId, event: "approved" }, select: { transitionAt: true, createdAt: true } });
      assert.equal(rawApprovedDecision.decidedAt.getTime(), rawApprovedLedger.transitionAt.getTime());
      assert.equal(rawApprovedDecision.createdAt.getTime(), rawApprovedLedger.createdAt.getTime());

      const connectionDriftProposal = await createProposal(bearerGrantId, "connection-drift");
      const driftConnectionBefore = await db.mcpConnection.findUniqueOrThrow({ where: { id: bearerConnectionId }, select: { updatedAt: true } });
      const driftPreview = await previewMcpConnectionMutation(bearerConnectionId, {
        action: "rotateCredential",
        requestKey: `mcpa-rotate-${suffix}`,
        reason: "rotate isolated action drift fixture credential",
        expectedUpdatedAt: driftConnectionBefore.updatedAt.toISOString(),
        secret: `action-rotation-next-${suffix}`,
      }, actor, db);
      assert.equal(driftPreview.canExecute, true);
      const driftExecution = await executeMcpConnectionMutation(bearerConnectionId, {
        previewId: driftPreview.id,
        requestKey: driftPreview.requestKey,
        requestFingerprint: driftPreview.requestFingerprint,
        impactFingerprint: driftPreview.impactFingerprint,
        expectedUpdatedAt: driftPreview.connection.updatedAt,
        secret: `action-rotation-next-${suffix}`,
      }, actor, db);
      assert.equal(driftExecution.status, "completed");
      const driftedConnection = await db.mcpConnection.findUniqueOrThrow({ where: { id: bearerConnectionId }, select: { status: true, configurationRevision: true } });
      assert.equal(driftedConnection.status, "configured");
      assert.equal(driftedConnection.configurationRevision, 2);
      await assert.rejects(() => db.$executeRaw(Prisma.sql`
        UPDATE "ProjectMcpAction"
        SET "status" = 'approved'::"ProjectMcpActionStatus", "stateVersion" = 2
        WHERE "id" = ${connectionDriftProposal.action.id}::uuid AND "projectId" = ${projectId}::uuid
      `), /PROJECT_MCP_ACTION_SOURCE_TUPLE_INVALID/u);
      await assert.rejects(() => decideProjectMcpAction(projectId, connectionDriftProposal.action.id as string, { decision: "approved", expectedStateVersion: 1, expectedActionRevision: connectionDriftProposal.action.actionRevision, acknowledgeSingleUse: true }, actor, db), (error: unknown) => serviceCode(error) === "PROJECT_MCP_ACTION_STALE");
      await cancelProjectMcpAction(projectId, connectionDriftProposal.action.id as string, { expectedStateVersion: 1, expectedActionRevision: connectionDriftProposal.action.actionRevision }, actor, db);
      await revokeProjectMcpToolGrantV2(projectId, bearerGrantId, { expectedGrantVersion: 1 }, actor, db);
      await revokeProjectMcpConnectionDelegation(projectId, bearerDelegation.id, { expectedVersion: bearerDelegation.version, reason: "action drift fixture cleanup" }, actor, db);

      const driftProposal = await createProposal(grantId, "drift");
      const driftId = driftProposal.action.id as string;
      await revokeProjectMcpToolGrantV2(projectId, grantId, { expectedGrantVersion: 1 }, actor, db);
      const revokedGrantReplay = await proposeProjectMcpAction(projectId, { clientRequestId: proposal.action.clientRequestId, grantId, expectedGrantVersion: 1, arguments: { query: "release" } }, actor, db);
      assert.equal(revokedGrantReplay.created, false);
      await assert.rejects(() => db.$executeRaw(Prisma.sql`
        UPDATE "ProjectMcpAction"
        SET "status" = 'approved'::"ProjectMcpActionStatus", "stateVersion" = 2
        WHERE "id" = ${driftId}::uuid AND "projectId" = ${projectId}::uuid
      `), /PROJECT_MCP_ACTION_SOURCE_TUPLE_INVALID/u);
      await assert.rejects(() => decideProjectMcpAction(projectId, driftId, { decision: "approved", expectedStateVersion: 1, expectedActionRevision: driftProposal.action.actionRevision, acknowledgeSingleUse: true }, actor, db), (error: unknown) => serviceCode(error) === "PROJECT_MCP_ACTION_STALE");
      const driftCancelled = await cancelProjectMcpAction(projectId, driftId, { expectedStateVersion: 1, expectedActionRevision: driftProposal.action.actionRevision }, actor, db);
      assert.equal(driftCancelled.created, true);

      const ledgerBefore = await db.projectMcpActionLedger.count({ where: { actionId } });
      assert.equal(ledgerBefore, 3);
      await assert.rejects(() => db.projectMcpActionLedger.updateMany({ where: { actionId }, data: { toolName: "tampered" } }), /PROJECT_MCP_ACTION_LEDGER_IMMUTABLE/u);
      await assert.rejects(() => db.projectMcpActionLedger.deleteMany({ where: { actionId } }), /PROJECT_MCP_ACTION_LEDGER_IMMUTABLE/u);

      const archiveGrant = await createProjectMcpToolGrantV2(projectId, { delegationId: delegation.id, toolDefinitionId: definitionId, attestationId: attestation.id, expectedDelegationVersion: delegation.version, expectedAttestationVersion: 1 as const, acknowledgeReadOnly: true as const }, actor, db);
      const pendingProposal = await createProposal(archiveGrant.grant.id as string, "archive");
      await assert.rejects(() => db.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } }), /PROJECT_MCP_ACTION_PENDING_ARCHIVE_FORBIDDEN/u);
      await cancelProjectMcpAction(projectId, pendingProposal.action.id as string, { expectedStateVersion: 1, expectedActionRevision: pendingProposal.action.actionRevision }, actor, db);
      await revokeProjectMcpToolGrantV2(projectId, pendingProposal.action.grantId as string, { expectedGrantVersion: 1 }, actor, db);
      await revokeProjectMcpConnectionDelegation(projectId, delegation.id, { expectedVersion: delegation.version, reason: "action gate cleanup" }, actor, db);
      const archived = await db.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
      const decisionsBeforeDelete = await db.projectMcpActionDecision.count({ where: { projectId } });
      await deleteArchivedProject({ projectId, actor, confirmationName: project.name, expectedUpdatedAt: archived.updatedAt }, db);
      assert.ok((await db.projectMcpActionLedger.count({ where: { projectId } })) >= 7);
      assert.equal(await db.projectMcpAction.count({ where: { projectId } }), 0);
      assert.equal(await db.projectMcpActionDecision.count({ where: { projectId } }), decisionsBeforeDelete);
    } finally {
      await db.$disconnect();
      if (previousMasterKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
      else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousMasterKeyPath;
      await rm(keyDirectory, { recursive: true, force: true });
    }
  },
);
