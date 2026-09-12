import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import test from "node:test";
import { getDb } from "../src/lib/db";
import {
  createMcpControlPlaneAttestation,
} from "../src/lib/mcp";
import {
  confirmProjectMcpConnectionDelegationOwner,
  confirmProjectMcpConnectionDelegationProject,
  proposeProjectMcpConnectionDelegation,
  revokeProjectMcpConnectionDelegation,
} from "../src/lib/project-mcp-connection-delegation-service";
import {
  deleteArchivedProject,
  ProjectLifecycleError,
  updateProjectLifecycle,
} from "../src/lib/project-lifecycle";
import { grantProjectMembership, grantWorkspaceMembership } from "../src/lib/membership-governance";

const shouldRun = process.env.PROJECT_MCP_GRANT_RETENTION_POSTGRES_GATE === "1";
const NO_CREDENTIAL_FINGERPRINT = "d2ab012fb807b99b7d059aabe98a45dd6edf6941a5f22699f8d04b5906dc2c2b";

function sqlTimestamp(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

function retentionError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("PROJECT_MCP_GRANT_RETENTION_REQUIRED");
}

test(
  "V2 MCP grant creation/revocation evidence survives project deletion",
  { skip: !shouldRun ? "PROJECT_MCP_GRANT_RETENTION_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const suffix = randomUUID().slice(0, 8);
    const adminId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const connectionId = randomUUID();
    const definitionId = randomUUID();
    const grantId = randomUUID();
    const definitionFingerprint = "a".repeat(64);
    const networkFingerprint = "b".repeat(64);
      const actor = { id: adminId, role: "admin" as const, accountAccessVersion: 1 };
    try {
      await db.appUser.create({ data: { id: adminId, username: `grant_retention_${suffix}`, role: "admin" } });
      const project = await db.$transaction(async (tx) => {
        await tx.workspace.create({ data: { id: workspaceId, name: `Grant retention ${suffix}`, slug: `grant-retention-${suffix}`, createdById: adminId } });
        const createdProject = await tx.project.create({ data: { id: projectId, workspaceId, name: `Grant retention ${suffix}`, slug: `grant-retention-${suffix}` } });
        await grantWorkspaceMembership(tx, { workspaceId, userId: adminId, role: "owner", actorId: adminId, reason: "grant_retention_gate_workspace_owner" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: adminId, role: "owner", actorId: adminId, reason: "grant_retention_gate_project_owner" });
        return createdProject;
      });
      await db.mcpConnection.create({
        data: {
          id: connectionId,
          name: `Retention MCP ${suffix}`,
          endpointUrl: "https://mcp.example.invalid/mcp",
          authKind: "none",
          credentialId: null,
          allowPrivateNetwork: false,
          resolvedAddressFingerprint: networkFingerprint,
          protocolVersion: "2026-07-28",
          catalogFingerprint: "c".repeat(64),
          credentialFingerprint: NO_CREDENTIAL_FINGERPRINT,
          configurationRevision: 1,
          status: "verified",
          createdById: adminId,
          ownerUserId: adminId,
          ownerAccountAccessVersion: 1,
          ownershipState: "confirmed",
        },
      });
      await db.mcpToolDefinition.create({
        data: {
          id: definitionId,
          connectionId,
          name: "project.lookup",
          title: "Lookup",
          description: "Remote description is not grant evidence.",
          inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
          outputSchema: { type: "object", properties: { found: { type: "boolean" } }, additionalProperties: false },
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
          remoteReadOnlyHint: true,
          definitionFingerprint,
          current: true,
        },
      });
      const attestation = await createMcpControlPlaneAttestation(actor, {
        toolDefinitionId: definitionId,
        expectedConnectionConfigurationRevision: 1,
        expectedDefinitionFingerprint: definitionFingerprint,
        expectedNetworkFingerprint: networkFingerprint,
        expectedCredentialFingerprint: NO_CREDENTIAL_FINGERPRINT,
        conclusion: "read_only_verified",
        riskLevel: "medium",
        evidenceNote: "manual_read_only_review",
      }, db);
      const expiry = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
      const draft = await proposeProjectMcpConnectionDelegation(projectId, { mcpConnectionId: connectionId, expiresAt: expiry }, actor, db);
      if (!("id" in draft)) throw new Error("PROJECT_MCP_GRANT_RETENTION_DELEGATION_CREATE_FAILED");
      await confirmProjectMcpConnectionDelegationOwner(projectId, draft.id, { expectedVersion: 1, acknowledgeCredentialUse: true }, actor, db);
      const activeDelegation = await confirmProjectMcpConnectionDelegationProject(projectId, draft.id, { expectedVersion: 2, acknowledgeProjectScope: true, acknowledgeDataEgress: true }, actor, db);
      if (!("id" in activeDelegation)) throw new Error("PROJECT_MCP_GRANT_RETENTION_DELEGATION_ACTIVATE_FAILED");
      const activeRow = await db.projectMcpConnectionDelegation.findUniqueOrThrow({ where: { id: activeDelegation.id }, select: { id: true, version: true, delegationFingerprint: true, connectionOwnerAccountAccessVersion: true } });
      const membership = await db.projectMembership.findFirstOrThrow({ where: { projectId, userId: adminId, role: "owner", accessState: "confirmed" }, orderBy: { createdAt: "asc" } });
      const createdAtBefore = new Date("2000-01-01T00:00:00.000Z");

      const insertGrantRow = async (candidateGrantId: string): Promise<void> => {
        await client.query(
          `INSERT INTO "ProjectMcpToolGrant" (
             "id", "projectId", "connectionId", "delegationId", "controlPlaneVersion", "grantVersion", "toolName",
             "toolDefinitionId", "attestationId", "definitionFingerprint", "networkFingerprint", "credentialFingerprint",
             "delegationVersion", "delegationFingerprint", "connectionConfigurationRevision", "connectionOwnerAccountAccessVersion", "grantorProjectMembershipId",
             "grantorMembershipCreatedAt", "status", "managedById", "acknowledgedAt", "creationTransactionId", "createdAt", "updatedAt"
           ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 2, 1, 'project.lookup', $5::uuid, $6::uuid, $7, $8, $9,
             $10, $11, 1, $12, $13::uuid, $14::timestamp, 'active', $15::uuid, $16::timestamp, 0, $16::timestamp, $16::timestamp)`,
          [candidateGrantId, projectId, connectionId, activeRow.id, definitionId, attestation.id, definitionFingerprint, networkFingerprint, NO_CREDENTIAL_FINGERPRINT, activeRow.version, activeRow.delegationFingerprint, activeRow.connectionOwnerAccountAccessVersion, membership.id, sqlTimestamp(membership.createdAt), adminId, sqlTimestamp(createdAtBefore)],
        );
      };
      const insertCreatedAudit = async (candidateGrantId: string): Promise<void> => {
        await client.query(
          `INSERT INTO "ProjectMcpToolGrantAudit" (
             "id", "projectId", "grantId", "event", "actorId", "controlPlaneVersion", "grantVersion", "statusBefore", "statusAfter",
           "delegationVersion", "delegationFingerprint", "connectionConfigurationRevision", "grantorProjectMembershipId", "grantorMembershipCreatedAt",
             "connectionOwnerAccountAccessVersion", "definitionFingerprint", "details", "transactionId", "createdAt"
           ) SELECT $2::uuid, "projectId", "id", 'granted', "managedById", 2, 1, NULL, 'active', "delegationVersion", "delegationFingerprint",
             "connectionConfigurationRevision", "grantorProjectMembershipId", "grantorMembershipCreatedAt", "connectionOwnerAccountAccessVersion",
             "definitionFingerprint", '{}'::jsonb, 0, $3::timestamp
           FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`,
          [candidateGrantId, randomUUID(), sqlTimestamp(createdAtBefore)],
        );
      };
      const insertCreatedLedger = async (candidateGrantId: string): Promise<void> => {
        await client.query(
          `INSERT INTO "ProjectMcpToolGrantLedger" (
             "id", "projectId", "grantId", "connectionId", "delegationId", "toolDefinitionId", "attestationId", "connectionOwnerId", "connectionOwnerAccountAccessVersion", "toolName",
             "controlPlaneVersion", "grantVersion", "event", "statusBefore", "statusAfter", "actorId", "actorProjectMembershipId",
             "actorMembershipCreatedAt", "delegationVersion", "delegationFingerprint", "connectionConfigurationRevision",
             "grantorProjectMembershipId", "grantorMembershipCreatedAt", "definitionFingerprint", "networkFingerprint", "credentialFingerprint",
             "acknowledgedAt", "transactionId", "transitionAt", "createdAt"
           ) SELECT $2::uuid, "projectId", "id", "connectionId", "delegationId", "toolDefinitionId", "attestationId", $4::uuid, "connectionOwnerAccountAccessVersion", "toolName",
             2, 1, 'granted', NULL, 'active', "managedById", "grantorProjectMembershipId", "grantorMembershipCreatedAt", "delegationVersion",
             "delegationFingerprint", "connectionConfigurationRevision", "grantorProjectMembershipId", "grantorMembershipCreatedAt", "definitionFingerprint",
             "networkFingerprint", "credentialFingerprint", "acknowledgedAt", 0, $3::timestamp, $3::timestamp
           FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`,
          [candidateGrantId, randomUUID(), sqlTimestamp(createdAtBefore), adminId],
        );
      };
      const assertCreateEvidenceRollback = async (candidateGrantId: string, includeAudit: boolean, includeLedger: boolean): Promise<void> => {
        await client.query("BEGIN");
        await insertGrantRow(candidateGrantId);
        if (includeAudit) await insertCreatedAudit(candidateGrantId);
        if (includeLedger) await insertCreatedLedger(candidateGrantId);
        await assert.rejects(() => client.query("COMMIT"), /PROJECT_MCP_TOOL_GRANT_CREATE_EVIDENCE_REQUIRED/u);
        await client.query("ROLLBACK").catch(() => undefined);
        const rolledBackGrant = await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`, [candidateGrantId]);
        const rolledBackAudit = await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM "ProjectMcpToolGrantAudit" WHERE "grantId" = $1::uuid`, [candidateGrantId]);
        const rolledBackLedger = await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM "ProjectMcpToolGrantLedger" WHERE "grantId" = $1::uuid`, [candidateGrantId]);
        assert.equal(rolledBackGrant.rows[0]?.count, 0);
        assert.equal(rolledBackAudit.rows[0]?.count, 0);
        assert.equal(rolledBackLedger.rows[0]?.count, 0);
      };
      const updateGrantForRevoke = async (candidateGrantId: string): Promise<void> => {
        await client.query(
          `UPDATE "ProjectMcpToolGrant" SET "status" = 'revoked', "grantVersion" = 2, "revokedById" = $2::uuid,
             "revokerProjectMembershipId" = $3::uuid, "revokerMembershipCreatedAt" = $4::timestamp,
             "revokedAt" = $5::timestamp, "revocationTransactionId" = 0 WHERE "id" = $1::uuid`,
          [candidateGrantId, adminId, membership.id, sqlTimestamp(membership.createdAt), sqlTimestamp(createdAtBefore)],
        );
      };
      const insertRevokedAudit = async (candidateGrantId: string): Promise<void> => {
        await client.query(
          `INSERT INTO "ProjectMcpToolGrantAudit" (
             "id", "projectId", "grantId", "event", "actorId", "controlPlaneVersion", "grantVersion", "statusBefore", "statusAfter",
             "delegationVersion", "delegationFingerprint", "connectionConfigurationRevision", "connectionOwnerAccountAccessVersion", "grantorProjectMembershipId", "grantorMembershipCreatedAt",
             "revokerProjectMembershipId", "revokerMembershipCreatedAt", "definitionFingerprint", "details", "transactionId", "createdAt"
           ) SELECT $2::uuid, "projectId", "id", 'revoked', "revokedById", 2, 2, 'active', 'revoked', "delegationVersion", "delegationFingerprint",
             "connectionConfigurationRevision", "connectionOwnerAccountAccessVersion", "grantorProjectMembershipId", "grantorMembershipCreatedAt", "revokerProjectMembershipId", "revokerMembershipCreatedAt",
             "definitionFingerprint", '{}'::jsonb, 0, $3::timestamp FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`,
          [candidateGrantId, randomUUID(), sqlTimestamp(createdAtBefore)],
        );
      };
      const insertRevokedLedger = async (candidateGrantId: string): Promise<void> => {
        await client.query(
          `INSERT INTO "ProjectMcpToolGrantLedger" (
             "id", "projectId", "grantId", "connectionId", "delegationId", "toolDefinitionId", "attestationId", "connectionOwnerId", "connectionOwnerAccountAccessVersion", "toolName",
             "controlPlaneVersion", "grantVersion", "event", "statusBefore", "statusAfter", "actorId", "actorProjectMembershipId",
             "actorMembershipCreatedAt", "delegationVersion", "delegationFingerprint", "connectionConfigurationRevision",
             "grantorProjectMembershipId", "grantorMembershipCreatedAt", "revokerProjectMembershipId", "revokerMembershipCreatedAt",
             "definitionFingerprint", "networkFingerprint", "credentialFingerprint", "acknowledgedAt", "transactionId", "transitionAt", "createdAt"
           ) SELECT $2::uuid, "projectId", "id", "connectionId", "delegationId", "toolDefinitionId", "attestationId", $4::uuid, "connectionOwnerAccountAccessVersion", "toolName",
             2, 2, 'revoked', 'active', 'revoked', "revokedById", "revokerProjectMembershipId", "revokerMembershipCreatedAt", "delegationVersion",
             "delegationFingerprint", "connectionConfigurationRevision", "grantorProjectMembershipId", "grantorMembershipCreatedAt", "revokerProjectMembershipId",
             "revokerMembershipCreatedAt", "definitionFingerprint", "networkFingerprint", "credentialFingerprint", "acknowledgedAt", 0, $3::timestamp, $3::timestamp
           FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`,
          [candidateGrantId, randomUUID(), sqlTimestamp(createdAtBefore), adminId],
        );
      };
      const assertRevokeEvidenceRollback = async (includeAudit: boolean, includeLedger: boolean): Promise<void> => {
        await client.query("BEGIN");
        await updateGrantForRevoke(grantId);
        if (includeAudit) await insertRevokedAudit(grantId);
        if (includeLedger) await insertRevokedLedger(grantId);
        const expectedError = includeAudit ? "PROJECT_MCP_TOOL_GRANT_REVOKE_EVIDENCE_REQUIRED" : "PROJECT_MCP_TOOL_GRANT_REVOKE_AUDIT_REQUIRED";
        await assert.rejects(() => client.query("COMMIT"), new RegExp(expectedError, "u"));
        await client.query("ROLLBACK").catch(() => undefined);
        const rolledBackGrant = await client.query<{ status: string; grantVersion: number; revokedById: string | null; revocationTransactionId: string | null }>(
          `SELECT "status", "grantVersion", "revokedById", "revocationTransactionId" FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`, [grantId],
        );
        assert.deepEqual(rolledBackGrant.rows[0], { status: "active", grantVersion: 1, revokedById: null, revocationTransactionId: null });
        const rolledBackAudit = await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM "ProjectMcpToolGrantAudit" WHERE "grantId" = $1::uuid AND "event" = 'revoked'`, [grantId]);
        const rolledBackLedger = await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM "ProjectMcpToolGrantLedger" WHERE "grantId" = $1::uuid AND "event" = 'revoked'`, [grantId]);
        assert.equal(rolledBackAudit.rows[0]?.count, 0);
        assert.equal(rolledBackLedger.rows[0]?.count, 0);
      };

      await client.query("BEGIN");
      await insertGrantRow(randomUUID());
      await assert.rejects(() => client.query("COMMIT"), /PROJECT_MCP_TOOL_GRANT_CREATE_EVIDENCE_REQUIRED/u);
      await client.query("ROLLBACK").catch(() => undefined);

      await assertCreateEvidenceRollback(randomUUID(), true, false);
      await assertCreateEvidenceRollback(randomUUID(), false, true);

      await client.query("BEGIN");
      await insertGrantRow(grantId);
      await insertCreatedAudit(grantId);
      await insertCreatedLedger(grantId);
      await client.query("COMMIT");

      const created = (await client.query<{ acknowledgedAt: Date; createdAt: Date; updatedAt: Date; creationTransactionId: string }>(
        `SELECT "acknowledgedAt", "createdAt", "updatedAt", "creationTransactionId" FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`, [grantId],
      )).rows[0];
      assert.ok(created);
      assert.notEqual(created.creationTransactionId, "0");
      assert.ok(created.acknowledgedAt > createdAtBefore);
      assert.ok(created.createdAt > createdAtBefore);
      assert.ok(created.updatedAt > createdAtBefore);
      const createdEvidence = (await client.query<{
        creationTransactionId: string;
        auditTransactionId: string;
        ledgerTransactionId: string;
        auditCreatedAt: Date;
        ledgerTransitionAt: Date;
        ledgerCreatedAt: Date;
      }>(
        `SELECT grant_row."creationTransactionId", audit."transactionId" AS "auditTransactionId", ledger."transactionId" AS "ledgerTransactionId",
                audit."createdAt" AS "auditCreatedAt", ledger."transitionAt" AS "ledgerTransitionAt", ledger."createdAt" AS "ledgerCreatedAt"
         FROM "ProjectMcpToolGrant" AS grant_row
         JOIN "ProjectMcpToolGrantAudit" AS audit ON audit."grantId" = grant_row."id" AND audit."event" = 'granted'
         JOIN "ProjectMcpToolGrantLedger" AS ledger ON ledger."grantId" = grant_row."id" AND ledger."event" = 'granted'
         WHERE grant_row."id" = $1::uuid`, [grantId],
      )).rows[0];
      assert.ok(createdEvidence);
      assert.notEqual(createdEvidence.auditTransactionId, "0");
      assert.notEqual(createdEvidence.ledgerTransactionId, "0");
      assert.equal(createdEvidence.auditTransactionId, createdEvidence.creationTransactionId);
      assert.equal(createdEvidence.ledgerTransactionId, createdEvidence.creationTransactionId);
      assert.ok(createdEvidence.auditCreatedAt > createdAtBefore);
      assert.ok(createdEvidence.ledgerTransitionAt > createdAtBefore);
      assert.ok(createdEvidence.ledgerCreatedAt > createdAtBefore);
      const tuple = await client.query<{ valid: boolean }>(`SELECT "project_mcp_tool_grant_v2_tuple_valid"("ProjectMcpToolGrant") AS valid FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`, [grantId]);
      assert.equal(tuple.rows[0]?.valid, true);

      await client.query("BEGIN");
      await assert.rejects(() => client.query(`DELETE FROM "Project" WHERE "id" = $1::uuid`, [projectId]), retentionError);
      await client.query("ROLLBACK").catch(() => undefined);

      const archived = await updateProjectLifecycle({ projectId, actor, action: "archive", expectedUpdatedAt: project.updatedAt }, db);
      await assert.rejects(
        () => deleteArchivedProject({ projectId, actor, confirmationName: archived.project.name, expectedUpdatedAt: archived.project.updatedAt }, db),
        (error: unknown) => error instanceof ProjectLifecycleError && error.code === "PROJECT_MCP_GRANT_RETENTION_REQUIRED",
      );

      await assertRevokeEvidenceRollback(true, false);
      await assertRevokeEvidenceRollback(false, true);

      await client.query("BEGIN");
      await updateGrantForRevoke(grantId);
      await insertRevokedAudit(grantId);
      await insertRevokedLedger(grantId);
      await client.query("COMMIT");

      const revoked = (await client.query<{ status: string; grantVersion: number; revokedAt: Date; revocationTransactionId: string }>(
        `SELECT "status", "grantVersion", "revokedAt", "revocationTransactionId" FROM "ProjectMcpToolGrant" WHERE "id" = $1::uuid`, [grantId],
      )).rows[0];
      assert.equal(revoked?.status, "revoked");
      assert.equal(revoked?.grantVersion, 2);
      assert.ok(revoked?.revokedAt && revoked.revokedAt > createdAtBefore);
      assert.notEqual(revoked?.revocationTransactionId, "0");
      const revokedEvidence = (await client.query<{
        revocationTransactionId: string;
        auditTransactionId: string;
        ledgerTransactionId: string;
        auditCreatedAt: Date;
        ledgerTransitionAt: Date;
        ledgerCreatedAt: Date;
      }>(
        `SELECT grant_row."revocationTransactionId", audit."transactionId" AS "auditTransactionId", ledger."transactionId" AS "ledgerTransactionId",
                audit."createdAt" AS "auditCreatedAt", ledger."transitionAt" AS "ledgerTransitionAt", ledger."createdAt" AS "ledgerCreatedAt"
         FROM "ProjectMcpToolGrant" AS grant_row
         JOIN "ProjectMcpToolGrantAudit" AS audit ON audit."grantId" = grant_row."id" AND audit."event" = 'revoked'
         JOIN "ProjectMcpToolGrantLedger" AS ledger ON ledger."grantId" = grant_row."id" AND ledger."event" = 'revoked'
         WHERE grant_row."id" = $1::uuid`, [grantId],
      )).rows[0];
      assert.ok(revokedEvidence);
      assert.notEqual(revokedEvidence.auditTransactionId, "0");
      assert.notEqual(revokedEvidence.ledgerTransactionId, "0");
      assert.equal(revokedEvidence.auditTransactionId, revokedEvidence.revocationTransactionId);
      assert.equal(revokedEvidence.ledgerTransactionId, revokedEvidence.revocationTransactionId);
      assert.ok(revokedEvidence.auditCreatedAt > createdAtBefore);
      assert.ok(revokedEvidence.ledgerTransitionAt > createdAtBefore);
      assert.ok(revokedEvidence.ledgerCreatedAt > createdAtBefore);
      const retained = await db.projectMcpToolGrantLedger.findMany({ where: { projectId, grantId }, orderBy: { grantVersion: "asc" } });
      assert.deepEqual(retained.map((row) => [row.event, row.grantVersion]), [["granted", 1], ["revoked", 2]]);

      const terminalDelegation = await revokeProjectMcpConnectionDelegation(
        projectId,
        activeRow.id,
        { expectedVersion: activeRow.version, reason: "grant retention terminal revoke" },
        actor,
        db,
      );
      if (!("recordStatus" in terminalDelegation)) throw new Error("PROJECT_MCP_GRANT_RETENTION_DELEGATION_REVOKE_FAILED");
      assert.equal(terminalDelegation.recordStatus, "revoked");
      assert.equal(terminalDelegation.version, activeRow.version + 1);
      assert.equal(terminalDelegation.terminalReason, "grant retention terminal revoke");

      const deleted = await deleteArchivedProject({ projectId, actor, confirmationName: archived.project.name, expectedUpdatedAt: archived.project.updatedAt }, db);
      assert.equal(deleted.projectId, projectId);
      const retainedAfterDelete = await db.projectMcpToolGrantLedger.findMany({ where: { projectId, grantId }, orderBy: { grantVersion: "asc" } });
      assert.deepEqual(retainedAfterDelete.map((row) => [row.event, row.grantVersion]), [["granted", 1], ["revoked", 2]]);
      await assert.rejects(() => client.query(`UPDATE "ProjectMcpToolGrantLedger" SET "toolName" = 'mutated' WHERE "grantId" = $1::uuid`, [grantId]), /PROJECT_MCP_TOOL_GRANT_LEDGER_IMMUTABLE/u);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.query("BEGIN").catch(() => undefined);
      await client.query("SET LOCAL session_replication_role = 'replica'").catch(() => undefined);
      await client.query(`DELETE FROM "ProjectMcpToolGrantLedger" WHERE "projectId" = $1::uuid`, [projectId]).catch(() => undefined);
      await client.query(`DELETE FROM "Project" WHERE "id" = $1::uuid`, [projectId]).catch(() => undefined);
      await client.query(`DELETE FROM "McpToolAttestationAudit" WHERE "connectionId" = $1::uuid`, [connectionId]).catch(() => undefined);
      await client.query(`DELETE FROM "McpToolAttestation" WHERE "connectionId" = $1::uuid`, [connectionId]).catch(() => undefined);
      await client.query(`DELETE FROM "ProjectMcpConnectionDelegationAudit" WHERE "mcpConnectionId" = $1::uuid`, [connectionId]).catch(() => undefined);
      await client.query(`DELETE FROM "ProjectMcpConnectionDelegation" WHERE "mcpConnectionId" = $1::uuid`, [connectionId]).catch(() => undefined);
      await client.query(`DELETE FROM "McpToolDefinition" WHERE "connectionId" = $1::uuid`, [connectionId]).catch(() => undefined);
      await client.query(`DELETE FROM "McpConnection" WHERE "id" = $1::uuid`, [connectionId]).catch(() => undefined);
      await client.query(`DELETE FROM "Workspace" WHERE "id" = $1::uuid`, [workspaceId]).catch(() => undefined);
      await client.query(`DELETE FROM "AppUser" WHERE "id" = $1::uuid`, [adminId]).catch(() => undefined);
      await client.query("COMMIT").catch(() => undefined);
      await client.end();
    }
  },
);
