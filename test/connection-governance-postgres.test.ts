import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { executeAccountAccess, previewAccountAccess } from "../src/lib/account-access-service";
import { createCredential } from "../src/lib/credential-vault";
import { getDb } from "../src/lib/db";
import {
  encodeGitCredential,
  executeGitConnectionMutation,
  GitServiceError,
  listGitConnections,
  previewGitConnectionMutation,
} from "../src/lib/git";
import {
  executeMcpConnectionMutation,
  listMcpConnections,
  McpCapabilityError,
  previewMcpConnectionMutation,
} from "../src/lib/mcp";

const shouldRun = process.env.CONNECTION_GOVERNANCE_POSTGRES_GATE === "1";

function actor(id: string) {
  return { id, accountAccessVersion: 1 } as const;
}

async function expectDatabaseGuard(action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("governance context") || message.includes("security fields require governance context");
  });
}

function stringifyForLeakCheck(value: unknown): string {
  return JSON.stringify(value, (_, nested) => typeof nested === "bigint" ? nested.toString() : nested);
}

test("connection governance rotates credentials exactly once and is the only PostgreSQL mutation path", { skip: !shouldRun ? "CONNECTION_GOVERNANCE_POSTGRES_GATE=1 is required" : false }, async () => {
  const db = getDb();
  const userId = randomUUID();
  const suffix = randomUUID().slice(0, 8);
  const gitConnectionId = randomUUID();
  const mcpConnectionId = randomUUID();
  const currentActor = actor(userId);

  await db.appUser.create({ data: { id: userId, username: `connection_gate_${suffix}`, accountAccessVersion: 1 } });
  const gitCredential = await createCredential("git", encodeGitCredential("token", `git-before-${suffix}`), db);
  const mcpCredential = await createCredential("mcp", `mcp-before-${suffix}`, db);
  const gitCredentialBefore = await db.externalCredential.findUniqueOrThrow({ where: { id: gitCredential.id }, select: { secretFingerprint: true } });
  const mcpCredentialBefore = await db.externalCredential.findUniqueOrThrow({ where: { id: mcpCredential.id }, select: { secretFingerprint: true } });
  const evidenceTime = new Date("2026-09-12T00:00:00.000Z");
  const gitConnection = await db.gitConnection.create({
    data: {
      id: gitConnectionId,
      name: `Git gate ${suffix}`,
      providerKind: "generic",
      transport: "https",
      baseUrl: "https://git.example.test",
      authKind: "token",
      credentialId: gitCredential.id,
      createdById: userId,
      ownerUserId: userId,
      ownerAccountAccessVersion: 1,
      ownershipState: "confirmed",
    },
  });
  const mcpConnection = await db.mcpConnection.create({
    data: {
      id: mcpConnectionId,
      name: `MCP gate ${suffix}`,
      endpointUrl: "https://mcp.example.test/mcp",
      authKind: "bearer",
      credentialId: mcpCredential.id,
      status: "verified",
      resolvedAddressFingerprint: "b".repeat(64),
      protocolVersion: "2025-06-18",
      catalogFingerprint: "c".repeat(64),
      lastDiscoveredAt: evidenceTime,
      lastErrorCode: "MCP_TEST_ERROR",
      createdById: userId,
      ownerUserId: userId,
      ownerAccountAccessVersion: 1,
      ownershipState: "confirmed",
    },
  });

  const rotatedGitSecret = `git-after-${suffix}`;
  const gitRotationPreview = await previewGitConnectionMutation(gitConnection.id, {
    action: "rotateCredential",
    requestKey: `git-rotate-${suffix}`,
    reason: "gate credential rotation",
    expectedUpdatedAt: gitConnection.updatedAt.toISOString(),
    secret: rotatedGitSecret,
  }, currentActor, db);
  assert.equal(gitRotationPreview.canExecute, true);
  const gitRotationResult = await executeGitConnectionMutation(gitConnection.id, {
    previewId: gitRotationPreview.id,
    requestKey: gitRotationPreview.requestKey,
    requestFingerprint: gitRotationPreview.requestFingerprint,
    impactFingerprint: gitRotationPreview.impactFingerprint,
    expectedUpdatedAt: gitRotationPreview.connection.updatedAt,
    secret: rotatedGitSecret,
  }, currentActor, db);
  assert.equal(gitRotationResult.status, "completed");
  assert.doesNotMatch(stringifyForLeakCheck(gitRotationResult), /git-after-/u);
  const rotatedGit = await db.gitConnection.findUniqueOrThrow({ where: { id: gitConnection.id } });
  assert.equal(rotatedGit.status, "configured");
  assert.equal(rotatedGit.configurationVersion, gitConnection.configurationVersion + 1);
  assert.equal(rotatedGit.resolvedAddressFingerprint, null);
  assert.equal(rotatedGit.lastTestedAt, null);
  assert.equal(rotatedGit.lastErrorCode, null);
  const gitCredentialAfter = await db.externalCredential.findUniqueOrThrow({ where: { id: gitCredential.id }, select: { secretFingerprint: true } });
  assert.notEqual(gitCredentialAfter.secretFingerprint, gitCredentialBefore.secretFingerprint);
  const gitRotationAudit = await db.gitConnectionMutationAudit.findUniqueOrThrow({ where: { id: gitRotationResult.auditId } });
  assert.doesNotMatch(stringifyForLeakCheck(gitRotationAudit), /git-after-/u);
  assert.equal(gitRotationAudit.connectionConfigurationVersion, rotatedGit.configurationVersion);
  assert.equal(gitRotationAudit.statusBefore, "configured");
  assert.equal(gitRotationAudit.statusAfter, "configured");
  const gitRotationReplay = await executeGitConnectionMutation(gitConnection.id, {
    previewId: gitRotationPreview.id,
    requestKey: gitRotationPreview.requestKey,
    requestFingerprint: gitRotationPreview.requestFingerprint,
    impactFingerprint: gitRotationPreview.impactFingerprint,
    expectedUpdatedAt: gitRotationPreview.connection.updatedAt,
    secret: rotatedGitSecret,
  }, currentActor, db);
  assert.equal(gitRotationReplay.auditId, gitRotationResult.auditId);
  assert.equal(await db.gitConnectionMutationAudit.count({ where: { previewId: gitRotationPreview.id } }), 1);

  const gitPreview = await previewGitConnectionMutation(gitConnection.id, {
    action: "disable",
    requestKey: `git-disable-${suffix}`,
    reason: "gate disable",
    expectedUpdatedAt: rotatedGit.updatedAt.toISOString(),
  }, currentActor, db);
  assert.equal(gitPreview.canExecute, true);
  const gitResult = await executeGitConnectionMutation(gitConnection.id, {
    previewId: gitPreview.id,
    requestKey: gitPreview.requestKey,
    requestFingerprint: gitPreview.requestFingerprint,
    impactFingerprint: gitPreview.impactFingerprint,
    expectedUpdatedAt: gitPreview.connection.updatedAt,
  }, currentActor, db);
  assert.equal(gitResult.status, "completed");
  const disabledGit = await db.gitConnection.findUniqueOrThrow({ where: { id: gitConnection.id } });
  assert.equal(disabledGit.status, "disabled");
  const gitReplay = await executeGitConnectionMutation(gitConnection.id, {
    previewId: gitPreview.id,
    requestKey: gitPreview.requestKey,
    requestFingerprint: gitPreview.requestFingerprint,
    impactFingerprint: gitPreview.impactFingerprint,
    expectedUpdatedAt: gitPreview.connection.updatedAt,
  }, currentActor, db);
  assert.equal(gitReplay.auditId, gitResult.auditId);
  await expectDatabaseGuard(() => db.gitConnection.update({ where: { id: gitConnection.id }, data: { status: "configured" } }));
  await expectDatabaseGuard(() => db.gitConnection.delete({ where: { id: gitConnection.id } }));

  const gitDeletePreview = await previewGitConnectionMutation(gitConnection.id, {
    action: "delete",
    requestKey: `git-delete-${suffix}`,
    reason: "gate delete",
    expectedUpdatedAt: disabledGit.updatedAt.toISOString(),
    confirmationName: disabledGit.name,
  }, currentActor, db);
  assert.equal(gitDeletePreview.canExecute, true);
  const gitDeleteResult = await executeGitConnectionMutation(gitConnection.id, {
    previewId: gitDeletePreview.id,
    requestKey: gitDeletePreview.requestKey,
    requestFingerprint: gitDeletePreview.requestFingerprint,
    impactFingerprint: gitDeletePreview.impactFingerprint,
    expectedUpdatedAt: gitDeletePreview.connection.updatedAt,
    confirmationName: disabledGit.name,
  }, currentActor, db);
  assert.equal(gitDeleteResult.status, "completed");
  assert.equal(await db.gitConnection.findUnique({ where: { id: gitConnection.id } }), null);
  assert.equal(await db.externalCredential.findUnique({ where: { id: gitCredential.id } }), null);
  const consumedGitDeletePreview = await db.gitConnectionMutationPreview.findUniqueOrThrow({ where: { id: gitDeletePreview.id } });
  assert.ok(consumedGitDeletePreview.consumedAt);
  const retainedGitDeleteAudit = await db.gitConnectionMutationAudit.findUniqueOrThrow({ where: { id: gitDeleteResult.auditId } });
  assert.equal(retainedGitDeleteAudit.connectionConfigurationVersion, disabledGit.configurationVersion);
  const gitDeleteReplay = await executeGitConnectionMutation(gitConnection.id, {
    previewId: gitDeletePreview.id,
    requestKey: gitDeletePreview.requestKey,
    requestFingerprint: gitDeletePreview.requestFingerprint,
    impactFingerprint: gitDeletePreview.impactFingerprint,
    expectedUpdatedAt: gitDeletePreview.connection.updatedAt,
    confirmationName: disabledGit.name,
  }, currentActor, db);
  assert.equal(gitDeleteReplay.auditId, gitDeleteResult.auditId);

  const rotatedMcpSecret = `mcp-after-${suffix}`;
  const mcpRotationPreview = await previewMcpConnectionMutation(mcpConnection.id, {
    action: "rotateCredential",
    requestKey: `mcp-rotate-${suffix}`,
    reason: "gate credential rotation",
    expectedUpdatedAt: mcpConnection.updatedAt.toISOString(),
    secret: rotatedMcpSecret,
  }, currentActor, db);
  assert.equal(mcpRotationPreview.canExecute, true);
  const mcpRotationResult = await executeMcpConnectionMutation(mcpConnection.id, {
    previewId: mcpRotationPreview.id,
    requestKey: mcpRotationPreview.requestKey,
    requestFingerprint: mcpRotationPreview.requestFingerprint,
    impactFingerprint: mcpRotationPreview.impactFingerprint,
    expectedUpdatedAt: mcpRotationPreview.connection.updatedAt,
    secret: rotatedMcpSecret,
  }, currentActor, db);
  assert.equal(mcpRotationResult.status, "completed");
  assert.doesNotMatch(stringifyForLeakCheck(mcpRotationResult), /mcp-after-/u);
  const rotatedMcp = await db.mcpConnection.findUniqueOrThrow({ where: { id: mcpConnection.id } });
  assert.equal(rotatedMcp.status, "configured");
  assert.equal(rotatedMcp.configurationRevision, mcpConnection.configurationRevision + 1);
  assert.equal(rotatedMcp.resolvedAddressFingerprint, "b".repeat(64));
  assert.equal(rotatedMcp.protocolVersion, null);
  assert.equal(rotatedMcp.catalogFingerprint, null);
  assert.equal(rotatedMcp.lastDiscoveredAt, null);
  assert.equal(rotatedMcp.lastErrorCode, null);
  const mcpCredentialAfter = await db.externalCredential.findUniqueOrThrow({ where: { id: mcpCredential.id }, select: { secretFingerprint: true } });
  assert.notEqual(mcpCredentialAfter.secretFingerprint, mcpCredentialBefore.secretFingerprint);
  assert.equal(rotatedMcp.credentialFingerprint, mcpCredentialAfter.secretFingerprint);
  const mcpRotationAudit = await db.mcpConnectionMutationAudit.findUniqueOrThrow({ where: { id: mcpRotationResult.auditId } });
  assert.doesNotMatch(stringifyForLeakCheck(mcpRotationAudit), /mcp-after-/u);
  assert.equal(mcpRotationAudit.configurationRevision, rotatedMcp.configurationRevision);
  assert.equal(mcpRotationAudit.statusBefore, "verified");
  assert.equal(mcpRotationAudit.statusAfter, "configured");
  const mcpRotationReplay = await executeMcpConnectionMutation(mcpConnection.id, {
    previewId: mcpRotationPreview.id,
    requestKey: mcpRotationPreview.requestKey,
    requestFingerprint: mcpRotationPreview.requestFingerprint,
    impactFingerprint: mcpRotationPreview.impactFingerprint,
    expectedUpdatedAt: mcpRotationPreview.connection.updatedAt,
    secret: rotatedMcpSecret,
  }, currentActor, db);
  assert.equal(mcpRotationReplay.auditId, mcpRotationResult.auditId);
  assert.equal(await db.mcpConnectionMutationAudit.count({ where: { previewId: mcpRotationPreview.id } }), 1);

  const mcpPreview = await previewMcpConnectionMutation(mcpConnection.id, {
    action: "disable",
    requestKey: `mcp-disable-${suffix}`,
    reason: "gate disable",
    expectedUpdatedAt: rotatedMcp.updatedAt.toISOString(),
  }, currentActor, db);
  assert.equal(mcpPreview.canExecute, true);
  const mcpResult = await executeMcpConnectionMutation(mcpConnection.id, {
    previewId: mcpPreview.id,
    requestKey: mcpPreview.requestKey,
    requestFingerprint: mcpPreview.requestFingerprint,
    impactFingerprint: mcpPreview.impactFingerprint,
    expectedUpdatedAt: mcpPreview.connection.updatedAt,
  }, currentActor, db);
  assert.equal(mcpResult.status, "completed");
  const disabledMcp = await db.mcpConnection.findUniqueOrThrow({ where: { id: mcpConnection.id } });
  assert.equal(disabledMcp.status, "disabled");
  await expectDatabaseGuard(() => db.mcpConnection.update({ where: { id: mcpConnection.id }, data: { status: "configured" } }));
  await expectDatabaseGuard(() => db.mcpConnection.delete({ where: { id: mcpConnection.id } }));

  const mcpDeletePreview = await previewMcpConnectionMutation(mcpConnection.id, {
    action: "delete",
    requestKey: `mcp-delete-${suffix}`,
    reason: "gate delete",
    expectedUpdatedAt: disabledMcp.updatedAt.toISOString(),
    confirmationName: disabledMcp.name,
  }, currentActor, db);
  assert.equal(mcpDeletePreview.canExecute, true);
  const mcpDeleteResult = await executeMcpConnectionMutation(mcpConnection.id, {
    previewId: mcpDeletePreview.id,
    requestKey: mcpDeletePreview.requestKey,
    requestFingerprint: mcpDeletePreview.requestFingerprint,
    impactFingerprint: mcpDeletePreview.impactFingerprint,
    expectedUpdatedAt: mcpDeletePreview.connection.updatedAt,
    confirmationName: disabledMcp.name,
  }, currentActor, db);
  assert.equal(mcpDeleteResult.status, "completed");
  assert.equal(await db.mcpConnection.findUnique({ where: { id: mcpConnection.id } }), null);
  assert.equal(await db.externalCredential.findUnique({ where: { id: mcpCredential.id } }), null);
  const consumedMcpDeletePreview = await db.mcpConnectionMutationPreview.findUniqueOrThrow({ where: { id: mcpDeletePreview.id } });
  assert.ok(consumedMcpDeletePreview.consumedAt);
  const retainedMcpDeleteAudit = await db.mcpConnectionMutationAudit.findUniqueOrThrow({ where: { id: mcpDeleteResult.auditId } });
  assert.equal(retainedMcpDeleteAudit.configurationRevision, disabledMcp.configurationRevision);
  const mcpDeleteReplay = await executeMcpConnectionMutation(mcpConnection.id, {
    previewId: mcpDeletePreview.id,
    requestKey: mcpDeletePreview.requestKey,
    requestFingerprint: mcpDeletePreview.requestFingerprint,
    impactFingerprint: mcpDeletePreview.impactFingerprint,
    expectedUpdatedAt: mcpDeletePreview.connection.updatedAt,
    confirmationName: disabledMcp.name,
  }, currentActor, db);
  assert.equal(mcpDeleteReplay.auditId, mcpDeleteResult.auditId);
});

test("account recovery exposes safe connection states and only permits credential rebind", { skip: !shouldRun ? "CONNECTION_GOVERNANCE_POSTGRES_GATE=1 is required" : false }, async () => {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const adminId = randomUUID();
  const targetId = randomUUID();
  const gitCredential = await createCredential("git", encodeGitCredential("token", `git-recovery-before-${suffix}`), db);
  const mcpCredential = await createCredential("mcp", `mcp-recovery-before-${suffix}`, db);
  const gitCredentialId = gitCredential.id;
  const mcpCredentialId = mcpCredential.id;
  const gitCredentialConnectionId = randomUUID();
  const gitNoCredentialConnectionId = randomUUID();
  const mcpCredentialConnectionId = randomUUID();
  const mcpNoCredentialConnectionId = randomUUID();

  await db.appUser.createMany({
    data: [
      { id: adminId, username: `connection_recovery_admin_${suffix}`, role: "admin", accountAccessVersion: 1 },
      { id: targetId, username: `connection_recovery_${suffix}`, accountAccessVersion: 1 },
    ],
  });
  await db.gitConnection.createMany({
    data: [
      {
        id: gitCredentialConnectionId,
        name: `Git recovery credential ${suffix}`,
        providerKind: "generic",
        transport: "https",
        baseUrl: "https://git.example.test",
        authKind: "token",
        credentialId: gitCredentialId,
        status: "verified",
        resolvedAddressFingerprint: "a".repeat(64),
        createdById: targetId,
        ownerUserId: targetId,
        ownerAccountAccessVersion: 1,
        ownershipState: "confirmed",
      },
      {
        id: gitNoCredentialConnectionId,
        name: `Git recovery rebuild ${suffix}`,
        providerKind: "generic",
        transport: "https",
        baseUrl: "https://git.example.test",
        authKind: "none",
        status: "configured",
        createdById: targetId,
        ownerUserId: targetId,
        ownerAccountAccessVersion: 1,
        ownershipState: "confirmed",
      },
    ],
  });
  await db.mcpConnection.createMany({
    data: [
      {
        id: mcpCredentialConnectionId,
        name: `MCP recovery credential ${suffix}`,
        endpointUrl: "https://mcp.example.test/mcp",
        authKind: "bearer",
        credentialId: mcpCredentialId,
        status: "configured",
        createdById: targetId,
        ownerUserId: targetId,
        ownerAccountAccessVersion: 1,
        ownershipState: "confirmed",
      },
      {
        id: mcpNoCredentialConnectionId,
        name: `MCP recovery rebuild ${suffix}`,
        endpointUrl: "https://mcp.example.test/mcp",
        authKind: "none",
        status: "configured",
        createdById: targetId,
        ownerUserId: targetId,
        ownerAccountAccessVersion: 1,
        ownershipState: "confirmed",
      },
    ],
  });

  const disablePreview = await previewAccountAccess({
    adminUserId: adminId,
    adminAccountAccessVersion: 1,
    userId: targetId,
    action: "disable",
    reason: "recovery test disable",
    expectedVersion: 1,
  }, db);
  const disable = await executeAccountAccess({
    adminUserId: adminId,
    adminAccountAccessVersion: 1,
    userId: targetId,
    action: "disable",
    reason: "recovery test disable",
    expectedVersion: disablePreview.current.accountAccessVersion,
    expectedImpactFingerprint: disablePreview.impactFingerprint,
    requestKey: `recovery-disable-${suffix}`,
    requestFingerprint: disablePreview.requestFingerprint,
    previewId: disablePreview.previewId,
    previewIssuedAt: disablePreview.previewIssuedAt,
    previewExpiresAt: disablePreview.previewExpiresAt,
    confirmation: true,
    confirmationUsername: `connection_recovery_${suffix}`,
  }, db);
  assert.equal(disable.state, "disabled");

  const restorePreview = await previewAccountAccess({
    adminUserId: adminId,
    adminAccountAccessVersion: 1,
    userId: targetId,
    action: "restore",
    reason: "recovery test restore",
    expectedVersion: disable.accountAccessVersion,
  }, db);
  const restore = await executeAccountAccess({
    adminUserId: adminId,
    adminAccountAccessVersion: 1,
    userId: targetId,
    action: "restore",
    reason: "recovery test restore",
    expectedVersion: restorePreview.current.accountAccessVersion,
    expectedImpactFingerprint: restorePreview.impactFingerprint,
    requestKey: `recovery-restore-${suffix}`,
    requestFingerprint: restorePreview.requestFingerprint,
    previewId: restorePreview.previewId,
    previewIssuedAt: restorePreview.previewIssuedAt,
    previewExpiresAt: restorePreview.previewExpiresAt,
    confirmation: true,
    confirmationUsername: `connection_recovery_${suffix}`,
  }, db);
  assert.equal(restore.state, "enabled");
  assert.equal(restore.accountAccessVersion, 3);

  const currentActor = { id: targetId, accountAccessVersion: restore.accountAccessVersion };
  const gitConnections = await listGitConnections(currentActor, db);
  const gitRecovery = new Map(gitConnections.map((connection) => [connection.id, connection.recoveryState]));
  assert.equal(gitRecovery.get(gitCredentialConnectionId), "credentialRebindRequired");
  assert.equal(gitRecovery.get(gitNoCredentialConnectionId), "rebuildRequired");
  const mcpConnections = await listMcpConnections(currentActor, db);
  const mcpRecovery = new Map(mcpConnections.map((connection) => [connection.id, connection.recoveryState]));
  assert.equal(mcpRecovery.get(mcpCredentialConnectionId), "credentialRebindRequired");
  assert.equal(mcpRecovery.get(mcpNoCredentialConnectionId), "rebuildRequired");
  const serializedConnections = stringifyForLeakCheck({ gitConnections, mcpConnections });
  assert.doesNotMatch(serializedConnections, /ownerAccountAccessVersion|credentialFingerprint|ownerUserId/u);

  const staleGitNone = await db.gitConnection.findUniqueOrThrow({ where: { id: gitNoCredentialConnectionId }, select: { name: true, updatedAt: true } });
  await assert.rejects(
    () => previewGitConnectionMutation(gitNoCredentialConnectionId, {
      action: "rotateCredential",
      requestKey: `recovery-git-none-${suffix}`,
      reason: "must rebuild without credential",
      expectedUpdatedAt: staleGitNone.updatedAt.toISOString(),
      secret: `git-invalid-rebind-${suffix}`,
    }, currentActor, db),
    (error: unknown) => error instanceof GitServiceError && error.code === "GIT_CONNECTION_NOT_VERIFIED",
  );

  const staleGitCredential = await db.gitConnection.findUniqueOrThrow({ where: { id: gitCredentialConnectionId }, select: { updatedAt: true } });
  await assert.rejects(
    () => previewGitConnectionMutation(gitCredentialConnectionId, {
      action: "disable",
      requestKey: `recovery-git-disable-${suffix}`,
      reason: "stale roots may only rotate credentials",
      expectedUpdatedAt: staleGitCredential.updatedAt.toISOString(),
    }, currentActor, db),
    (error: unknown) => error instanceof GitServiceError && error.code === "GIT_CONNECTION_NOT_VERIFIED",
  );
  const gitRotationPreview = await previewGitConnectionMutation(gitCredentialConnectionId, {
    action: "rotateCredential",
    requestKey: `recovery-git-credential-${suffix}`,
    reason: "rebind rotated credential",
    expectedUpdatedAt: staleGitCredential.updatedAt.toISOString(),
    secret: `git-recovery-after-${suffix}`,
  }, currentActor, db);
  assert.equal(gitRotationPreview.canExecute, true);
  const gitRotation = await executeGitConnectionMutation(gitCredentialConnectionId, {
    previewId: gitRotationPreview.id,
    requestKey: gitRotationPreview.requestKey,
    requestFingerprint: gitRotationPreview.requestFingerprint,
    impactFingerprint: gitRotationPreview.impactFingerprint,
    expectedUpdatedAt: gitRotationPreview.connection.updatedAt,
    secret: `git-recovery-after-${suffix}`,
  }, currentActor, db);
  assert.equal(gitRotation.status, "completed");
  const reboundGit = await db.gitConnection.findUniqueOrThrow({ where: { id: gitCredentialConnectionId }, select: { status: true, ownerAccountAccessVersion: true } });
  assert.deepEqual(reboundGit, { status: "configured", ownerAccountAccessVersion: 3 });

  const staleMcpNone = await db.mcpConnection.findUniqueOrThrow({ where: { id: mcpNoCredentialConnectionId }, select: { updatedAt: true } });
  await assert.rejects(
    () => previewMcpConnectionMutation(mcpNoCredentialConnectionId, {
      action: "rotateCredential",
      requestKey: `recovery-mcp-none-${suffix}`,
      reason: "must rebuild without credential",
      expectedUpdatedAt: staleMcpNone.updatedAt.toISOString(),
      secret: `mcp-invalid-rebind-${suffix}`,
    }, currentActor, db),
    (error: unknown) => error instanceof McpCapabilityError && error.code === "MCP_CONNECTION_NOT_VERIFIED",
  );

  const staleMcpCredential = await db.mcpConnection.findUniqueOrThrow({ where: { id: mcpCredentialConnectionId }, select: { updatedAt: true } });
  await assert.rejects(
    () => previewMcpConnectionMutation(mcpCredentialConnectionId, {
      action: "disable",
      requestKey: `recovery-mcp-disable-${suffix}`,
      reason: "stale roots may only rotate credentials",
      expectedUpdatedAt: staleMcpCredential.updatedAt.toISOString(),
    }, currentActor, db),
    (error: unknown) => error instanceof McpCapabilityError && error.code === "MCP_CONNECTION_NOT_VERIFIED",
  );
  const mcpRotationPreview = await previewMcpConnectionMutation(mcpCredentialConnectionId, {
    action: "rotateCredential",
    requestKey: `recovery-mcp-credential-${suffix}`,
    reason: "rebind rotated credential",
    expectedUpdatedAt: staleMcpCredential.updatedAt.toISOString(),
    secret: `mcp-recovery-after-${suffix}`,
  }, currentActor, db);
  assert.equal(mcpRotationPreview.canExecute, true);
  const mcpRotation = await executeMcpConnectionMutation(mcpCredentialConnectionId, {
    previewId: mcpRotationPreview.id,
    requestKey: mcpRotationPreview.requestKey,
    requestFingerprint: mcpRotationPreview.requestFingerprint,
    impactFingerprint: mcpRotationPreview.impactFingerprint,
    expectedUpdatedAt: mcpRotationPreview.connection.updatedAt,
    secret: `mcp-recovery-after-${suffix}`,
  }, currentActor, db);
  assert.equal(mcpRotation.status, "completed");
  const reboundMcp = await db.mcpConnection.findUniqueOrThrow({ where: { id: mcpCredentialConnectionId }, select: { status: true, ownerAccountAccessVersion: true } });
  assert.deepEqual(reboundMcp, { status: "configured", ownerAccountAccessVersion: 3 });
  const recoveredGit = await listGitConnections(currentActor, db);
  const recoveredMcp = await listMcpConnections(currentActor, db);
  assert.equal(recoveredGit.find((connection) => connection.id === gitCredentialConnectionId)?.recoveryState, "ready");
  assert.equal(recoveredMcp.find((connection) => connection.id === mcpCredentialConnectionId)?.recoveryState, "ready");
});
