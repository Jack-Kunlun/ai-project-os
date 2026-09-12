import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDb } from "../src/lib/db";
import { executeAccountAccess, previewAccountAccess } from "../src/lib/account-access-service";
import {
  McpCapabilityError,
  createMcpControlPlaneAttestation,
  createMcpToolReview,
  executeMcpConnectionMutation,
  listMcpControlPlaneAttestationCandidates,
  previewMcpConnectionMutation,
  revokeMcpControlPlaneAttestation,
} from "../src/lib/mcp";

const shouldRun = process.env.MCP_ATTESTATION_CONTROL_PLANE_POSTGRES_GATE === "1";
const NO_CREDENTIAL_FINGERPRINT = "d2ab012fb807b99b7d059aabe98a45dd6edf6941a5f22699f8d04b5906dc2c2b";

function isMcpCode(code: string) {
  return (error: unknown): boolean => error instanceof McpCapabilityError && error.code === code;
}

test("C2 管理员 MCP 认证控制面具备精确快照、幂等创建和漂移后 CAS 撤销", { skip: !shouldRun ? "MCP_ATTESTATION_CONTROL_PLANE_POSTGRES_GATE=1 is required" : false }, async () => {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const adminId = randomUUID();
  const replacementAdminId = randomUUID();
  const memberId = randomUUID();
  const connectionId = randomUUID();
  const toolDefinitionId = randomUUID();
  const adminActor = { id: adminId, role: "admin" as const, accountAccessVersion: 1 };
  const replacementAdminActor = { id: replacementAdminId, role: "admin" as const, accountAccessVersion: 1 };
  const memberActor = { id: memberId, role: "user" as const, accountAccessVersion: 1 };
  const definitionFingerprint = "a".repeat(64);
  const networkFingerprint = "b".repeat(64);
  const configurationRevision = 1;

  const mutateReplacementAdminAccess = async (action: "disable" | "restore", reason: string, requestKey: string) => {
    const admin = await db.appUser.findUniqueOrThrow({ where: { id: adminId }, select: { accountAccessVersion: true } });
    const target = await db.appUser.findUniqueOrThrow({ where: { id: replacementAdminId }, select: { accountAccessVersion: true } });
    const preview = await previewAccountAccess({
      adminUserId: adminId,
      adminAccountAccessVersion: admin.accountAccessVersion,
      userId: replacementAdminId,
      action,
      reason,
      expectedVersion: target.accountAccessVersion,
    }, db);
    assert.equal(preview.canExecute, true);
    return executeAccountAccess({
      adminUserId: adminId,
      adminAccountAccessVersion: admin.accountAccessVersion,
      userId: replacementAdminId,
      action,
      reason,
      expectedVersion: preview.current.accountAccessVersion,
      expectedImpactFingerprint: preview.impactFingerprint,
      requestKey,
      requestFingerprint: preview.requestFingerprint,
      previewId: preview.previewId,
      previewIssuedAt: preview.previewIssuedAt,
      previewExpiresAt: preview.previewExpiresAt,
      confirmation: true,
      confirmationUsername: preview.user.username,
    }, db);
  };

  await db.appUser.createMany({ data: [
    { id: adminId, username: `mcp_c2_admin_${suffix}`, role: "admin" },
    { id: replacementAdminId, username: `mcp_c2_replacement_${suffix}`, role: "admin" },
    { id: memberId, username: `mcp_c2_member_${suffix}`, role: "user" },
  ] });
  await db.mcpConnection.create({
    data: {
      id: connectionId,
      name: `MCP C2 ${suffix}`,
      endpointUrl: "https://mcp.example.invalid/mcp",
      authKind: "none",
      credentialId: null,
      allowPrivateNetwork: false,
      resolvedAddressFingerprint: networkFingerprint,
      protocolVersion: "2026-07-28",
      catalogFingerprint: "c".repeat(64),
      credentialFingerprint: NO_CREDENTIAL_FINGERPRINT,
      configurationRevision,
      status: "verified",
      disabledAt: null,
      createdById: adminId,
      ownerUserId: adminId,
      ownerAccountAccessVersion: 1,
      ownershipState: "confirmed",
    },
  });
  await db.mcpToolDefinition.create({
    data: {
      id: toolDefinitionId,
      connectionId,
      name: "project.lookup",
      title: "Lookup",
      description: "Untrusted remote description",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
      outputSchema: { type: "object", properties: { found: { type: "boolean" } }, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      remoteReadOnlyHint: true,
      definitionFingerprint,
      current: true,
    },
  });

  const input = {
    toolDefinitionId,
    expectedConnectionConfigurationRevision: configurationRevision,
    expectedDefinitionFingerprint: definitionFingerprint,
    expectedNetworkFingerprint: networkFingerprint,
    expectedCredentialFingerprint: NO_CREDENTIAL_FINGERPRINT,
    conclusion: "read_only_verified" as const,
    riskLevel: "medium" as const,
    evidenceNote: "manual_read_only_review" as const,
  };
  const eligible = await listMcpControlPlaneAttestationCandidates(adminActor, { state: "eligible", page: 1, pageSize: 50 }, db);
  assert.equal(eligible.total, 1);
  const eligibleCandidate = eligible.candidates[0] as { snapshots?: { credentialFingerprint?: string } } | undefined;
  assert.equal(eligibleCandidate?.snapshots?.credentialFingerprint, NO_CREDENTIAL_FINGERPRINT);
  assert.equal(JSON.stringify(eligible).includes("endpointUrl"), false);

  await assert.rejects(() => createMcpControlPlaneAttestation(memberActor, input, db), isMcpCode("MCP_ADMIN_REQUIRED"));
  await assert.rejects(() => createMcpControlPlaneAttestation(adminActor, { ...input, extra: true }, db), isMcpCode("MCP_INVALID_INPUT"));
  await assert.rejects(() => createMcpControlPlaneAttestation(adminActor, { ...input, expectedNetworkFingerprint: "d".repeat(64) }, db), isMcpCode("MCP_TOOL_DEFINITION_STALE"));

  // The legacy helper remains callable only as an explicit negative fixture:
  // without an immutable review its V2 row must not enter the effective set.
  const legacyCreated = await createMcpControlPlaneAttestation(adminActor, input, db);
  assert.equal(legacyCreated.created, true);
  const legacyActive = await listMcpControlPlaneAttestationCandidates(adminActor, { state: "active", page: 1, pageSize: 50 }, db);
  assert.equal(legacyActive.total, 0);
  const legacyEligible = await listMcpControlPlaneAttestationCandidates(adminActor, { state: "eligible", page: 1, pageSize: 50 }, db);
  const legacyCandidate = legacyEligible.candidates.find((candidate) => (candidate as { blockingAttestationId?: string }).blockingAttestationId === legacyCreated.id) as {
    reviewStatus?: string;
    effective?: boolean;
    blockingAttestationId?: string;
    requiresRevocation?: boolean;
  } | undefined;
  assert.equal(legacyCandidate?.reviewStatus, "unreviewed");
  assert.equal(legacyCandidate?.effective, false);
  assert.equal(legacyCandidate?.blockingAttestationId, legacyCreated.id);
  assert.equal(legacyCandidate?.requiresRevocation, true);
  await revokeMcpControlPlaneAttestation(adminActor, legacyCreated.id, { expectedVersion: 1 }, db);

  const reviewConnection = await db.mcpConnection.findUniqueOrThrow({ where: { id: connectionId }, select: { updatedAt: true } });
  const reviewed = await createMcpToolReview(adminActor, {
    connectionId,
    toolDefinitionId,
    expectedConnectionConfigurationRevision: configurationRevision,
    expectedConnectionUpdatedAt: reviewConnection.updatedAt.toISOString(),
    expectedDefinitionFingerprint: definitionFingerprint,
    expectedNetworkFingerprint: networkFingerprint,
    expectedCredentialFingerprint: NO_CREDENTIAL_FINGERPRINT,
    conclusion: "read_only_verified",
    riskLevel: input.riskLevel,
    riskReasonCode: "read_only_eligible",
    evidenceNote: "管理员只读审核",
    requestKey: `mcp-c2-review-${suffix}`,
  }, db);
  assert.equal(reviewed.created, true);
  if (reviewed.review.attestationId === null) throw new Error("MCP_C2_REVIEW_ATTESTATION_MISSING");
  const created = { id: reviewed.review.attestationId } as const;
  const repeated = await createMcpControlPlaneAttestation(adminActor, input, db);
  assert.equal(reviewed.created, true);
  assert.equal(repeated.created, false);
  assert.equal(created.id, repeated.id);
  await assert.rejects(() => createMcpControlPlaneAttestation(adminActor, { ...input, riskLevel: "high" }, db), isMcpCode("MCP_ATTESTATION_CONFLICT"));

  await db.appUser.update({ where: { id: adminId }, data: { role: "user" } });
  const demotedActive = await listMcpControlPlaneAttestationCandidates(replacementAdminActor, { state: "active", page: 1, pageSize: 50 }, db);
  const demotedCandidate = demotedActive.candidates.find((candidate) => (candidate as { id?: string }).id === created.id) as {
    effective?: boolean;
    effectiveReason?: string | null;
  } | undefined;
  assert.equal(demotedCandidate?.effective, false);
  assert.equal(demotedCandidate?.effectiveReason, "verifier_not_admin");
  const reauthRequired = await listMcpControlPlaneAttestationCandidates(replacementAdminActor, { state: "eligible", page: 1, pageSize: 50 }, db);
  const blockedCandidate = reauthRequired.candidates.find((candidate) => (candidate as { blockingAttestationId?: string }).blockingAttestationId === created.id) as {
    blockingAttestationId?: string;
    requiresRevocation?: boolean;
  } | undefined;
  assert.equal(blockedCandidate?.blockingAttestationId, created.id);
  assert.equal(blockedCandidate?.requiresRevocation, true);
  await assert.rejects(() => createMcpControlPlaneAttestation(replacementAdminActor, input, db), isMcpCode("MCP_ATTESTATION_REAUTHENTICATION_REQUIRED"));
  await revokeMcpControlPlaneAttestation(replacementAdminActor, created.id, { expectedVersion: 1 }, db);
  await db.appUser.update({ where: { id: adminId }, data: { role: "admin" } });
  const recreateConnection = await db.mcpConnection.findUniqueOrThrow({ where: { id: connectionId }, select: { updatedAt: true } });
  const recreatedReview = await createMcpToolReview(adminActor, {
    connectionId,
    toolDefinitionId,
    expectedConnectionConfigurationRevision: configurationRevision,
    expectedConnectionUpdatedAt: recreateConnection.updatedAt.toISOString(),
    expectedDefinitionFingerprint: definitionFingerprint,
    expectedNetworkFingerprint: networkFingerprint,
    expectedCredentialFingerprint: NO_CREDENTIAL_FINGERPRINT,
    conclusion: "read_only_verified",
    riskLevel: input.riskLevel,
    riskReasonCode: "read_only_eligible",
    evidenceNote: "管理员重新完成只读审核",
    requestKey: `mcp-c2-review-recreate-${suffix}`,
  }, db);
  assert.equal(recreatedReview.created, true);
  if (recreatedReview.review.attestationId === null) throw new Error("MCP_C2_RECREATE_ATTESTATION_MISSING");
  const activeAttestationId = recreatedReview.review.attestationId;
  assert.notEqual(activeAttestationId, created.id);

  await mutateReplacementAdminAccess("disable", "C2 account access test", `mcp-c2-disable-${suffix}`);
  await assert.rejects(
    () => listMcpControlPlaneAttestationCandidates(replacementAdminActor, { state: "active", page: 1, pageSize: 50 }, db),
    isMcpCode("MCP_ADMIN_REQUIRED"),
  );
  await mutateReplacementAdminAccess("restore", "C2 account access restore", `mcp-c2-restore-${suffix}`);

  await assert.rejects(() => revokeMcpControlPlaneAttestation(adminActor, activeAttestationId, { expectedVersion: 2 }, db), isMcpCode("MCP_ATTESTATION_CONFLICT"));

  const active = await listMcpControlPlaneAttestationCandidates(adminActor, { state: "active", page: 1, pageSize: 50 }, db);
  assert.equal(active.total, 1);
  const activeCandidate = active.candidates[0] as { id?: string } | undefined;
  assert.equal(activeCandidate?.id, activeAttestationId);

  const bearerCredentialId = randomUUID();
  const bearerConnectionId = randomUUID();
  const bearerToolDefinitionId = randomUUID();
  const bearerFingerprint = "e".repeat(64);
  await db.externalCredential.create({
    data: {
      id: bearerCredentialId,
      kind: "mcp",
      ciphertext: Buffer.from("ciphertext"),
      nonce: Buffer.from("nonce"),
      authTag: Buffer.from("auth-tag"),
      maskedSuffix: "tail",
      secretFingerprint: bearerFingerprint,
    },
  });
  await db.mcpConnection.create({
    data: {
      id: bearerConnectionId,
      name: `MCP Bearer ${suffix}`,
      endpointUrl: "https://bearer.example.invalid/mcp",
      authKind: "bearer",
      credentialId: bearerCredentialId,
      allowPrivateNetwork: false,
      resolvedAddressFingerprint: "f".repeat(64),
      protocolVersion: "2026-07-28",
      catalogFingerprint: "1".repeat(64),
      credentialFingerprint: bearerFingerprint,
      configurationRevision: 1,
      status: "verified",
      disabledAt: null,
      createdById: adminId,
      ownerUserId: adminId,
      ownerAccountAccessVersion: 1,
      ownershipState: "confirmed",
    },
  });
  await db.mcpToolDefinition.create({
    data: {
      id: bearerToolDefinitionId,
      connectionId: bearerConnectionId,
      name: "project.bearerLookup",
      title: "Bearer Lookup",
      description: "Bearer remote description",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      outputSchema: { type: "object", properties: { found: { type: "boolean" } } },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      remoteReadOnlyHint: true,
      definitionFingerprint: "2".repeat(64),
      current: true,
    },
  });
  const bearerInput = {
    toolDefinitionId: bearerToolDefinitionId,
    expectedConnectionConfigurationRevision: 1,
    expectedDefinitionFingerprint: "2".repeat(64),
    expectedNetworkFingerprint: "f".repeat(64),
    expectedCredentialFingerprint: bearerFingerprint,
    conclusion: "read_only_verified" as const,
    riskLevel: "low" as const,
    evidenceNote: "manual_read_only_review" as const,
  };
  await assert.rejects(
    () => createMcpControlPlaneAttestation(adminActor, { ...bearerInput, expectedCredentialFingerprint: "3".repeat(64) }, db),
    isMcpCode("MCP_TOOL_DEFINITION_STALE"),
  );
  const bearerConnection = await db.mcpConnection.findUniqueOrThrow({ where: { id: bearerConnectionId }, select: { updatedAt: true } });
  const bearerReviewed = await createMcpToolReview(adminActor, {
    connectionId: bearerConnectionId,
    toolDefinitionId: bearerToolDefinitionId,
    expectedConnectionConfigurationRevision: 1,
    expectedConnectionUpdatedAt: bearerConnection.updatedAt.toISOString(),
    expectedDefinitionFingerprint: "2".repeat(64),
    expectedNetworkFingerprint: "f".repeat(64),
    expectedCredentialFingerprint: bearerFingerprint,
    conclusion: "read_only_verified",
    riskLevel: bearerInput.riskLevel,
    riskReasonCode: "read_only_eligible",
    evidenceNote: "只读协议审核通过",
    requestKey: `mcp-c2-bearer-review-${suffix}`,
  }, db);
  assert.equal(bearerReviewed.created, true);
  assert.equal(bearerReviewed.review.credentialFingerprint, bearerFingerprint);
  if (bearerReviewed.review.attestationId === null) throw new Error("MCP_C2_BEARER_ATTESTATION_MISSING");
  await revokeMcpControlPlaneAttestation(adminActor, bearerReviewed.review.attestationId, { expectedVersion: 1 }, db);

  await db.mcpToolDefinition.update({ where: { id: toolDefinitionId }, data: { current: false, supersededAt: new Date() } });
  const driftedActive = await listMcpControlPlaneAttestationCandidates(adminActor, { state: "active", page: 1, pageSize: 50 }, db);
  const driftedCandidate = driftedActive.candidates.find((candidate) => (candidate as { id?: string }).id === activeAttestationId) as {
    effective?: boolean;
    effectiveReason?: string | null;
  } | undefined;
  assert.equal(driftedCandidate?.effective, false);
  assert.equal(driftedCandidate?.effectiveReason, "tool_definition_stale");
  const revoked = await revokeMcpControlPlaneAttestation(adminActor, activeAttestationId, { expectedVersion: 1 }, db);
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.version, 2);
  const stored = await db.mcpToolAttestation.findUniqueOrThrow({ where: { id: activeAttestationId } });
  assert.ok(stored.revokedAt instanceof Date);
  assert.notEqual(stored.revocationTransactionId, null);
  const audits = await db.mcpToolAttestationAudit.findMany({ where: { attestationId: activeAttestationId }, orderBy: { event: "asc" } });
  assert.deepEqual(audits.map((audit) => audit.event), ["attested", "revoked"]);
  assert.ok(audits.every((audit) => audit.transactionId !== null && audit.details && JSON.stringify(audit.details) === "{}"));
  const attestedAudit = audits.find((audit) => audit.event === "attested");
  const revokedAudit = audits.find((audit) => audit.event === "revoked");
  assert.equal(attestedAudit?.connectionConfigurationRevision, configurationRevision);
  assert.equal(attestedAudit?.definitionFingerprint, definitionFingerprint);
  assert.equal(attestedAudit?.networkFingerprint, networkFingerprint);
  assert.equal(attestedAudit?.credentialFingerprint, NO_CREDENTIAL_FINGERPRINT);
  assert.equal(revokedAudit?.attestationVersion, 2);
  assert.equal(revokedAudit?.statusBefore, "active");
  assert.equal(revokedAudit?.statusAfter, "revoked");
  await assert.rejects(() => revokeMcpControlPlaneAttestation(adminActor, activeAttestationId, { expectedVersion: 1 }, db), isMcpCode("MCP_ATTESTATION_CONFLICT"));

  await db.mcpToolDefinition.update({ where: { id: toolDefinitionId }, data: { current: true, supersededAt: null } });
  const rebuildConnection = await db.mcpConnection.findUniqueOrThrow({ where: { id: connectionId }, select: { updatedAt: true } });
  const rebuiltReview = await createMcpToolReview(adminActor, {
    connectionId,
    toolDefinitionId,
    expectedConnectionConfigurationRevision: configurationRevision,
    expectedConnectionUpdatedAt: rebuildConnection.updatedAt.toISOString(),
    expectedDefinitionFingerprint: definitionFingerprint,
    expectedNetworkFingerprint: networkFingerprint,
    expectedCredentialFingerprint: NO_CREDENTIAL_FINGERPRINT,
    conclusion: "read_only_verified",
    riskLevel: input.riskLevel,
    riskReasonCode: "read_only_eligible",
    evidenceNote: "漂移后重新完成只读审核",
    requestKey: `mcp-c2-review-rebuild-${suffix}`,
  }, db);
  assert.equal(rebuiltReview.created, true);
  if (rebuiltReview.review.attestationId === null) throw new Error("MCP_C2_REBUILD_ATTESTATION_MISSING");
  assert.notEqual(rebuiltReview.review.attestationId, activeAttestationId);
  const rebuiltRevoked = await revokeMcpControlPlaneAttestation(adminActor, rebuiltReview.review.attestationId, { expectedVersion: 1 }, db);
  assert.equal(rebuiltRevoked.status, "revoked");

  const connectionBeforeDisable = await db.mcpConnection.findUniqueOrThrow({ where: { id: connectionId } });
  const disablePreview = await previewMcpConnectionMutation(connectionId, {
    action: "disable",
    requestKey: `mcp-c2-disable-connection-${suffix}`,
    reason: "governed disable retains V2 attestation evidence",
    expectedUpdatedAt: connectionBeforeDisable.updatedAt.toISOString(),
  }, adminActor, db);
  assert.equal(disablePreview.canExecute, true);
  const disableResult = await executeMcpConnectionMutation(connectionId, {
    previewId: disablePreview.id,
    requestKey: disablePreview.requestKey,
    requestFingerprint: disablePreview.requestFingerprint,
    impactFingerprint: disablePreview.impactFingerprint,
    expectedUpdatedAt: disablePreview.connection.updatedAt,
  }, adminActor, db);
  assert.equal(disableResult.status, "completed");
  const disabled = await db.mcpConnection.findUniqueOrThrow({ where: { id: connectionId } });
  assert.equal(disabled.status, "disabled");

  const blockedDeletePreview = await previewMcpConnectionMutation(connectionId, {
    action: "delete",
    requestKey: `mcp-c2-delete-blocked-${suffix}`,
    reason: "deletion remains blocked while V2 attestation evidence is retained",
    expectedUpdatedAt: disabled.updatedAt.toISOString(),
    confirmationName: disabled.name,
  }, adminActor, db);
  assert.equal(blockedDeletePreview.canExecute, false);
  assert.equal(blockedDeletePreview.blockers.includes("permanent_v2_attestation"), true);
});
