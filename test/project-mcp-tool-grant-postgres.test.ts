import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDb } from "../src/lib/db";
import { buildMcpActionSnapshot, createMcpControlPlaneAttestation, executeMcpActionSnapshot, getProjectMcpToolCenter, grantProjectMcpTool, McpCapabilityError, revokeProjectMcpToolGrant } from "../src/lib/mcp";
import {
  confirmProjectMcpConnectionDelegationOwner,
  confirmProjectMcpConnectionDelegationProject,
  proposeProjectMcpConnectionDelegation,
  revokeProjectMcpConnectionDelegation,
} from "../src/lib/project-mcp-connection-delegation-service";
import {
  createProjectMcpToolGrantV2,
  listProjectMcpToolGrantsV2,
  ProjectMcpToolGrantServiceError,
  revokeProjectMcpToolGrantV2,
} from "../src/lib/project-mcp-tool-grant-service";
import { deleteArchivedProject } from "../src/lib/project-lifecycle";
import { grantProjectMembership, grantWorkspaceMembership } from "../src/lib/membership-governance";

const shouldRun = process.env.PROJECT_MCP_TOOL_GRANT_POSTGRES_GATE === "1";
const NO_CREDENTIAL_FINGERPRINT = "d2ab012fb807b99b7d059aabe98a45dd6edf6941a5f22699f8d04b5906dc2c2b";

function serviceCode(error: unknown): string {
  return error instanceof ProjectMcpToolGrantServiceError ? error.code : "unexpected";
}

test(
  "V2 project MCP grant control plane enforces owner CAS, snapshots, evidence, and retention",
  { skip: !shouldRun ? "PROJECT_MCP_TOOL_GRANT_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const adminId = randomUUID();
    const editorId = randomUUID();
    const viewerId = randomUUID();
    const workspaceAdminId = randomUUID();
    const systemAdminId = randomUUID();
    const nonmemberId = randomUUID();
    const disabledOwnerId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const connectionId = randomUUID();
    const definitionId = randomUUID();
    const definition2Id = randomUUID();
    const fingerprint = "a".repeat(64);
    const fingerprint2 = "d".repeat(64);
    const networkFingerprint = "b".repeat(64);
    const actor = { id: adminId, role: "admin" } as const;
    try {
      await db.appUser.createMany({ data: [
        { id: adminId, username: `mcp_grant_owner_${suffix}`, role: "admin" },
        { id: editorId, username: `mcp_grant_editor_${suffix}`, role: "member" },
        { id: viewerId, username: `mcp_grant_viewer_${suffix}`, role: "member" },
        { id: workspaceAdminId, username: `mcp_grant_workspace_admin_${suffix}`, role: "admin" },
        { id: systemAdminId, username: `mcp_grant_system_admin_${suffix}`, role: "admin" },
        { id: nonmemberId, username: `mcp_grant_nonmember_${suffix}`, role: "member" },
        { id: disabledOwnerId, username: `mcp_grant_disabled_owner_${suffix}`, role: "member" },
      ] });
      await db.workspace.create({ data: { id: workspaceId, name: `MCP grant ${suffix}`, slug: `mcp-grant-${suffix}`, createdById: adminId } });
      const project = await db.project.create({ data: { id: projectId, workspaceId, name: `MCP grant ${suffix}`, slug: `mcp-grant-project-${suffix}` } });
      await db.$transaction(async (tx) => {
        await grantWorkspaceMembership(tx, { workspaceId, userId: adminId, role: "owner", actorId: adminId, reason: "mcp_grant_gate_workspace_owner" });
        await grantWorkspaceMembership(tx, { workspaceId, userId: workspaceAdminId, role: "admin", actorId: adminId, reason: "mcp_grant_gate_workspace_admin" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: adminId, role: "owner", actorId: adminId, reason: "mcp_grant_gate_project_owner" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: editorId, role: "editor", actorId: adminId, reason: "mcp_grant_gate_project_editor" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: viewerId, role: "viewer", actorId: adminId, reason: "mcp_grant_gate_project_viewer" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: disabledOwnerId, role: "owner", actorId: adminId, reason: "mcp_grant_gate_disabled_owner" });
      });
      await db.appUser.update({ where: { id: disabledOwnerId }, data: { disabledAt: new Date() } });
      await db.mcpConnection.create({ data: {
        id: connectionId, name: `MCP grant connection ${suffix}`, endpointUrl: "https://mcp.example.invalid/mcp", authKind: "none",
        credentialId: null, allowPrivateNetwork: false, resolvedAddressFingerprint: networkFingerprint, protocolVersion: "2026-07-28",
        catalogFingerprint: "c".repeat(64), credentialFingerprint: NO_CREDENTIAL_FINGERPRINT, configurationRevision: 1,
        status: "verified", createdById: adminId, ownerUserId: adminId, ownershipState: "confirmed",
      } });
      await db.mcpToolDefinition.create({ data: {
        id: definitionId, connectionId, name: "project.lookup", title: "Lookup", description: "Safe read-only lookup",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        outputSchema: { type: "object", properties: { found: { type: "boolean" } } }, annotations: { readOnlyHint: true },
        remoteReadOnlyHint: true, definitionFingerprint: fingerprint, current: true,
      } });
      await db.mcpToolDefinition.create({ data: {
        id: definition2Id, connectionId, name: "project.lookup.concurrent", title: "Concurrent lookup", description: "Concurrent safe lookup",
        inputSchema: { type: "object" }, outputSchema: { type: "object" }, annotations: { readOnlyHint: true },
        remoteReadOnlyHint: true, definitionFingerprint: fingerprint2, current: true,
      } });
      const attestation = await createMcpControlPlaneAttestation(adminId, {
        toolDefinitionId: definitionId, expectedConnectionConfigurationRevision: 1, expectedDefinitionFingerprint: fingerprint,
        expectedNetworkFingerprint: networkFingerprint, expectedCredentialFingerprint: NO_CREDENTIAL_FINGERPRINT,
        conclusion: "read_only_verified", riskLevel: "low", evidenceNote: "manual_read_only_review",
      }, db);
      const attestation2 = await createMcpControlPlaneAttestation(adminId, {
        toolDefinitionId: definition2Id, expectedConnectionConfigurationRevision: 1, expectedDefinitionFingerprint: fingerprint2,
        expectedNetworkFingerprint: networkFingerprint, expectedCredentialFingerprint: NO_CREDENTIAL_FINGERPRINT,
        conclusion: "read_only_verified", riskLevel: "low", evidenceNote: "manual_read_only_review",
      }, db);
      const draft = await proposeProjectMcpConnectionDelegation(projectId, { mcpConnectionId: connectionId, expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString() }, actor, db);
      if (!("id" in draft)) throw new Error("MCP_GRANT_GATE_DELEGATION_CREATE_FAILED");
      await confirmProjectMcpConnectionDelegationOwner(projectId, draft.id, { expectedVersion: 1, acknowledgeCredentialUse: true }, actor, db);
      const activeDelegation = await confirmProjectMcpConnectionDelegationProject(projectId, draft.id, { expectedVersion: 2, acknowledgeProjectScope: true, acknowledgeDataEgress: true }, actor, db);
      if (!("id" in activeDelegation)) throw new Error("MCP_GRANT_GATE_DELEGATION_ACTIVATE_FAILED");
      const delegation = await db.projectMcpConnectionDelegation.findUniqueOrThrow({ where: { id: activeDelegation.id }, select: { id: true, version: true } });
      const createInput = { delegationId: delegation.id, toolDefinitionId: definitionId, attestationId: attestation.id, expectedDelegationVersion: delegation.version, expectedAttestationVersion: 1 as const, acknowledgeReadOnly: true as const };
      const concurrentInput = { ...createInput, toolDefinitionId: definition2Id, attestationId: attestation2.id };

      await assert.rejects(() => createProjectMcpToolGrantV2(projectId, { ...createInput, extra: true }, actor, db), (error: unknown) => serviceCode(error) === "PROJECT_MCP_TOOL_GRANT_INVALID_INPUT");
      await assert.rejects(() => createProjectMcpToolGrantV2(projectId, createInput, { id: editorId, role: "member" }, db), (error: unknown) => serviceCode(error) === "PROJECT_MCP_TOOL_GRANT_PROJECT_OWNER_REQUIRED");
      await assert.rejects(() => createProjectMcpToolGrantV2(projectId, createInput, { id: viewerId, role: "member" }, db), (error: unknown) => serviceCode(error) === "PROJECT_MCP_TOOL_GRANT_PROJECT_OWNER_REQUIRED");
      for (const unauthorized of [workspaceAdminId, systemAdminId, nonmemberId]) {
        await assert.rejects(() => createProjectMcpToolGrantV2(projectId, createInput, { id: unauthorized, role: "admin" }, db), (error: unknown) => serviceCode(error) === "PROJECT_MCP_TOOL_GRANT_FORBIDDEN");
      }
      await assert.rejects(() => createProjectMcpToolGrantV2(projectId, createInput, { id: disabledOwnerId, role: "member" }, db), (error: unknown) => serviceCode(error) === "PROJECT_MCP_TOOL_GRANT_ACCOUNT_DISABLED");

      const supersededAt = new Date();
      await db.mcpToolDefinition.update({ where: { id: definitionId }, data: { current: false, supersededAt } });
      await assert.rejects(() => createProjectMcpToolGrantV2(projectId, createInput, actor, db), (error: unknown) => serviceCode(error) === "PROJECT_MCP_TOOL_GRANT_STALE");
      await db.mcpToolDefinition.update({ where: { id: definitionId }, data: { current: true, supersededAt: null } });
      await db.appUser.update({ where: { id: adminId }, data: { role: "member" } });
      await assert.rejects(() => createProjectMcpToolGrantV2(projectId, createInput, actor, db), (error: unknown) => serviceCode(error) === "PROJECT_MCP_TOOL_GRANT_STALE");
      await db.appUser.update({ where: { id: adminId }, data: { role: "admin" } });

      const concurrentResults = await Promise.allSettled([
        createProjectMcpToolGrantV2(projectId, concurrentInput, actor, db),
        createProjectMcpToolGrantV2(projectId, concurrentInput, actor, db),
      ]);
      const concurrentSuccesses = concurrentResults.filter((result): result is PromiseFulfilledResult<{ created: boolean; grant: Readonly<Record<string, unknown>> }> => result.status === "fulfilled");
      assert.ok(concurrentSuccesses.some((result) => result.value.created));
      assert.ok(concurrentSuccesses.filter((result) => result.value.created).length === 1);
      for (const result of concurrentResults) {
        if (result.status === "rejected") assert.equal(serviceCode(result.reason), "PROJECT_MCP_TOOL_GRANT_CONFLICT");
        if (result.status === "fulfilled" && !result.value.created) assert.equal(result.value.created, false);
      }
      const concurrentGrantCount = await db.projectMcpToolGrant.count({ where: { projectId, toolDefinitionId: definition2Id, status: "active" } });
      assert.equal(concurrentGrantCount, 1);
      const concurrentEvidenceCount = await db.$queryRaw<Array<{ audits: bigint; ledgers: bigint }>>`
        SELECT (SELECT COUNT(*) FROM "ProjectMcpToolGrantAudit" AS audit JOIN "ProjectMcpToolGrant" AS grant_row ON grant_row."id" = audit."grantId" WHERE grant_row."projectId" = ${projectId}::uuid AND grant_row."toolDefinitionId" = ${definition2Id}::uuid AND audit."event" = 'granted') AS audits,
               (SELECT COUNT(*) FROM "ProjectMcpToolGrantLedger" AS ledger JOIN "ProjectMcpToolGrant" AS grant_row ON grant_row."id" = ledger."grantId" WHERE grant_row."projectId" = ${projectId}::uuid AND grant_row."toolDefinitionId" = ${definition2Id}::uuid AND ledger."event" = 'granted') AS ledgers
      `;
      assert.equal(concurrentEvidenceCount[0]?.audits, BigInt(1));
      assert.equal(concurrentEvidenceCount[0]?.ledgers, BigInt(1));

      const first = await createProjectMcpToolGrantV2(projectId, createInput, actor, db);
      assert.equal(first.created, true);
      const firstId = first.grant.id as string;
      const firstCounts = await db.$queryRaw<Array<{ audits: bigint; ledgers: bigint }>>`
        SELECT
          (SELECT COUNT(*) FROM "ProjectMcpToolGrantAudit" WHERE "grantId" = ${firstId}::uuid) AS audits,
          (SELECT COUNT(*) FROM "ProjectMcpToolGrantLedger" WHERE "grantId" = ${firstId}::uuid) AS ledgers
      `;
      assert.equal(firstCounts[0]?.audits, BigInt(1));
      assert.equal(firstCounts[0]?.ledgers, BigInt(1));
      const replay = await createProjectMcpToolGrantV2(projectId, createInput, actor, db);
      assert.equal(replay.created, false);
      const replayCounts = await db.$queryRaw<Array<{ audits: bigint; ledgers: bigint }>>`
        SELECT
          (SELECT COUNT(*) FROM "ProjectMcpToolGrantAudit" WHERE "grantId" = ${firstId}::uuid) AS audits,
          (SELECT COUNT(*) FROM "ProjectMcpToolGrantLedger" WHERE "grantId" = ${firstId}::uuid) AS ledgers
      `;
      assert.deepEqual(replayCounts[0], firstCounts[0]);
      const createdSnapshot = await db.projectMcpToolGrant.findUniqueOrThrow({ where: { id: firstId }, select: { creationTransactionId: true, acknowledgedAt: true, createdAt: true, updatedAt: true } });
      assert.ok(createdSnapshot.creationTransactionId !== null && createdSnapshot.creationTransactionId !== BigInt(0));
      assert.ok(createdSnapshot.acknowledgedAt.getTime() > 0 && createdSnapshot.createdAt.getTime() > 0 && createdSnapshot.updatedAt.getTime() > 0);
      const creationEvidence = await db.$queryRaw<Array<{ grantXid: bigint; auditXid: bigint; ledgerXid: bigint; grantAcknowledgedAt: Date; ledgerAcknowledgedAt: Date }>>`
        SELECT grant_row."creationTransactionId" AS "grantXid", audit."transactionId" AS "auditXid", ledger."transactionId" AS "ledgerXid",
               grant_row."acknowledgedAt" AS "grantAcknowledgedAt", ledger."acknowledgedAt" AS "ledgerAcknowledgedAt"
        FROM "ProjectMcpToolGrant" AS grant_row
        JOIN "ProjectMcpToolGrantAudit" AS audit ON audit."grantId" = grant_row."id" AND audit."event" = 'granted'
        JOIN "ProjectMcpToolGrantLedger" AS ledger ON ledger."grantId" = grant_row."id" AND ledger."event" = 'granted'
        WHERE grant_row."id" = ${firstId}::uuid
      `;
      assert.equal(creationEvidence[0]?.grantXid, creationEvidence[0]?.auditXid);
      assert.equal(creationEvidence[0]?.grantXid, creationEvidence[0]?.ledgerXid);
      assert.equal(creationEvidence[0]?.grantAcknowledgedAt.getTime(), creationEvidence[0]?.ledgerAcknowledgedAt.getTime());

      const revoked = await revokeProjectMcpToolGrantV2(projectId, firstId, { expectedGrantVersion: 1 }, actor, db);
      assert.equal(revoked.created, true);
      const revokeReplay = await revokeProjectMcpToolGrantV2(projectId, firstId, { expectedGrantVersion: 1 }, actor, db);
      assert.equal(revokeReplay.created, false);
      await assert.rejects(() => revokeProjectMcpToolGrantV2(projectId, firstId, { expectedGrantVersion: 2 }, actor, db), (error: unknown) => serviceCode(error) === "PROJECT_MCP_TOOL_GRANT_CONFLICT");
      const revokedSnapshot = await db.projectMcpToolGrant.findUniqueOrThrow({ where: { id: firstId }, select: { status: true, grantVersion: true, revocationTransactionId: true, revokedAt: true } });
      assert.equal(revokedSnapshot.status, "revoked");
      assert.equal(revokedSnapshot.grantVersion, 2);
      assert.ok(revokedSnapshot.revocationTransactionId !== null && revokedSnapshot.revocationTransactionId !== BigInt(0));
      assert.ok(revokedSnapshot.revokedAt !== null && revokedSnapshot.revokedAt.getTime() > 0);
      const revokeEvidence = await db.$queryRaw<Array<{ grantXid: bigint; auditXid: bigint; ledgerXid: bigint }>>`
        SELECT grant_row."revocationTransactionId" AS "grantXid", audit."transactionId" AS "auditXid", ledger."transactionId" AS "ledgerXid"
        FROM "ProjectMcpToolGrant" AS grant_row
        JOIN "ProjectMcpToolGrantAudit" AS audit ON audit."grantId" = grant_row."id" AND audit."event" = 'revoked'
        JOIN "ProjectMcpToolGrantLedger" AS ledger ON ledger."grantId" = grant_row."id" AND ledger."event" = 'revoked'
        WHERE grant_row."id" = ${firstId}::uuid
      `;
      assert.equal(revokeEvidence[0]?.grantXid, revokeEvidence[0]?.auditXid);
      assert.equal(revokeEvidence[0]?.grantXid, revokeEvidence[0]?.ledgerXid);

      const second = await createProjectMcpToolGrantV2(projectId, createInput, actor, db);
      assert.equal(second.created, true);
      assert.notEqual(second.grant.id, firstId);
      const secondId = second.grant.id as string;
      const concurrentGrant = await db.projectMcpToolGrant.findFirstOrThrow({ where: { projectId, toolDefinitionId: definition2Id, status: "active" }, select: { id: true } });
      await revokeProjectMcpToolGrantV2(projectId, concurrentGrant.id, { expectedGrantVersion: 1 }, actor, db);
      const archived = await db.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
      const archivedList = await listProjectMcpToolGrantsV2(projectId, actor, db);
      assert.equal(archivedList.archived, true);
      assert.deepEqual(archivedList.candidates, []);
      await assert.rejects(() => createProjectMcpToolGrantV2(projectId, createInput, actor, db), (error: unknown) => serviceCode(error) === "PROJECT_MCP_TOOL_GRANT_PROJECT_ARCHIVED");
      await db.mcpConnection.update({ where: { id: connectionId }, data: { status: "configured" } });
      const archivedRevoke = await revokeProjectMcpToolGrantV2(projectId, secondId, { expectedGrantVersion: 1 }, actor, db);
      assert.equal(archivedRevoke.created, true);
      await db.mcpConnection.update({ where: { id: connectionId }, data: { status: "verified" } });
      const terminalDelegation = await revokeProjectMcpConnectionDelegation(projectId, delegation.id, { expectedVersion: delegation.version, reason: "grant cleanup" }, actor, db);
      assert.ok("recordStatus" in terminalDelegation);
      assert.equal(terminalDelegation.recordStatus, "revoked");
      const deleted = await deleteArchivedProject({ projectId, actor, confirmationName: project.name, expectedUpdatedAt: archived.updatedAt }, db);
      assert.equal(deleted.projectId, projectId);
      const retained = await db.projectMcpToolGrantLedger.count({ where: { projectId } });
      assert.equal(retained, 6);

      const fakeDb = {} as never;
      const frozen = (error: unknown): boolean => error instanceof McpCapabilityError && error.code === "MCP_LEGACY_PROJECT_RUNTIME_FROZEN";
      await assert.rejects(() => getProjectMcpToolCenter(projectId, actor, fakeDb), frozen);
      await assert.rejects(() => grantProjectMcpTool(projectId, { toolDefinitionId: definitionId, acknowledgeReadOnly: true, expectedUpdatedAt: null }, actor, fakeDb), frozen);
      await assert.rejects(() => revokeProjectMcpToolGrant(projectId, firstId, { expectedUpdatedAt: new Date().toISOString() }, actor, fakeDb), frozen);
      await assert.rejects(() => buildMcpActionSnapshot(projectId, { grantId: firstId, arguments: {} }, fakeDb), frozen);
      await assert.rejects(() => executeMcpActionSnapshot(projectId, {
        grantId: firstId, connectionId, toolName: "project.lookup", toolDefinitionId: definitionId, attestationId: attestation.id,
        toolDefinitionFingerprint: fingerprint, networkFingerprint, credentialFingerprint: NO_CREDENTIAL_FINGERPRINT, arguments: {},
      }, fakeDb), frozen);
    } finally {
      await db.$disconnect();
    }
  },
);
