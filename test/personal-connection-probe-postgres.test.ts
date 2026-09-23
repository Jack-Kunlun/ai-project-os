import "dotenv/config";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeAccountAccess, previewAccountAccess } from "../src/lib/account-access-service";
import {
  consumePersonalConnectionProbe,
  runPersonalConnectionProbe,
  PersonalConnectionProbeError,
} from "../src/lib/personal-connection-probe-service";
import { getDb } from "../src/lib/db";
import { probeGitConnectionDraft } from "../src/lib/git/service";
import { probeMcpConnectionDraft } from "../src/lib/mcp/service";
import { MCP_PROTOCOL_VERSION } from "../src/lib/mcp/client";
import {
  createGitConnectionFixture,
  createMcpConnectionFixture,
  seedPersonalConnectionProbeCreateContext,
} from "./personal-connection-probe-fixture";

const shouldRun = process.env.PERSONAL_CONNECTION_PROBE_POSTGRES_GATE === "1";
const NO_CREDENTIAL_FINGERPRINT = "d2ab012fb807b99b7d059aabe98a45dd6edf6941a5f22699f8d04b5906dc2c2b";

function isCheckViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("personal connection create") || message.includes("tested connection update");
}

function actor(id: string) {
  return { id, accountAccessVersion: 1 } as const;
}

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return Object.freeze({ promise, resolve });
}

async function disableAccount(db: ReturnType<typeof getDb>, adminId: string, targetId: string, reason: string) {
  const target = await db.appUser.findUniqueOrThrow({ where: { id: targetId }, select: { accountAccessVersion: true, username: true } });
  const preview = await previewAccountAccess({
    adminUserId: adminId,
    adminAccountAccessVersion: 1,
    userId: targetId,
    action: "disable",
    reason,
    expectedVersion: target.accountAccessVersion,
  }, db);
  assert.equal(preview.canExecute, true);
  return executeAccountAccess({
    adminUserId: adminId,
    adminAccountAccessVersion: 1,
    userId: targetId,
    action: "disable",
    reason,
    expectedVersion: preview.current.accountAccessVersion,
    expectedImpactFingerprint: preview.impactFingerprint,
    requestKey: randomUUID(),
    requestFingerprint: preview.requestFingerprint,
    previewId: preview.previewId,
    previewIssuedAt: preview.previewIssuedAt,
    previewExpiresAt: preview.previewExpiresAt,
    confirmation: true,
    confirmationUsername: target.username,
  }, db);
}

test("personal connection probe trigger binds table, actor, connection, expiry, and one-use proof", { skip: !shouldRun ? "PERSONAL_CONNECTION_PROBE_POSTGRES_GATE=1 is required" : false }, async () => {
  const keyDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-personal-probe-gate-"));
  const previousMasterKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
  process.env.AI_PROJECT_OS_MASTER_KEY_FILE = join(keyDirectory, "master.key");
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const ownerId = randomUUID();
  const secondOwnerId = randomUUID();
  const directGitId = randomUUID();
  const directMcpId = randomUUID();
  try {
    await db.appUser.createMany({ data: [
      { id: ownerId, username: `probe_owner_${suffix}`, accountAccessVersion: 1 },
      { id: secondOwnerId, username: `probe_second_owner_${suffix}`, accountAccessVersion: 1 },
    ] });

    const directGit = {
      id: directGitId,
      name: `Direct Git ${suffix}`,
      providerKind: "generic" as const,
      transport: "https" as const,
      baseUrl: "https://git.example.invalid",
      authKind: "none" as const,
      credentialId: null,
      createdById: ownerId,
      ownerUserId: ownerId,
      ownerAccountAccessVersion: 1,
      ownershipState: "confirmed" as const,
    };
    await assert.rejects(() => db.gitConnection.create({ data: directGit }), isCheckViolation);

    const directMcp = {
      id: directMcpId,
      name: `Direct MCP ${suffix}`,
      endpointUrl: "https://mcp.example.invalid/mcp",
      authKind: "none" as const,
      credentialId: null,
      credentialFingerprint: "d2ab012fb807b99b7d059aabe98a45dd6edf6941a5f22699f8d04b5906dc2c2b",
      resolvedAddressFingerprint: "b".repeat(64),
      protocolVersion: "2025-06-18",
      catalogFingerprint: "c".repeat(64),
      status: "verified" as const,
      createdById: ownerId,
      ownerUserId: ownerId,
      ownerAccountAccessVersion: 1,
      ownershipState: "confirmed" as const,
    };
    await assert.rejects(() => db.mcpConnection.create({ data: directMcp }), isCheckViolation);

    const gitId = randomUUID();
    const mcpId = randomUUID();
    const git = await createGitConnectionFixture({
      id: gitId,
      name: `Valid Git ${suffix}`,
      providerKind: "generic",
      transport: "https",
      baseUrl: "https://git.example.invalid",
      authKind: "none",
      credentialId: null,
      status: "verified",
      resolvedAddressFingerprint: "a".repeat(64),
      createdById: ownerId,
      ownerUserId: ownerId,
      ownerAccountAccessVersion: 1,
      ownershipState: "confirmed",
    }, db);
    assert.equal(git.id, gitId);
    const mcp = await createMcpConnectionFixture({
      id: mcpId,
      name: `Valid MCP ${suffix}`,
      endpointUrl: "https://mcp.example.invalid/mcp",
      authKind: "none",
      credentialId: null,
      credentialFingerprint: NO_CREDENTIAL_FINGERPRINT,
      status: "verified",
      resolvedAddressFingerprint: "a".repeat(64),
      protocolVersion: "2025-06-18",
      catalogFingerprint: "c".repeat(64),
      createdById: ownerId,
      ownerUserId: ownerId,
      ownerAccountAccessVersion: 1,
      ownershipState: "confirmed",
    }, db);
    assert.equal(mcp.id, mcpId);

    await assert.rejects(() => db.$transaction(async (tx) => {
      await seedPersonalConnectionProbeCreateContext(tx, { kind: "git", actorId: ownerId, connectionId: randomUUID() });
      await tx.mcpConnection.create({
        data: { ...directMcp, id: randomUUID(), name: `Cross kind ${suffix}` },
      });
    }), isCheckViolation);

    await assert.rejects(() => db.$transaction(async (tx) => {
      await seedPersonalConnectionProbeCreateContext(tx, { kind: "git", actorId: ownerId, connectionId: randomUUID() });
      await tx.$executeRaw`SELECT set_config('app.personal_connection_probe_actor_id', ${secondOwnerId}, true)`;
      await tx.gitConnection.create({ data: { ...directGit, id: randomUUID(), name: `Cross actor ${suffix}`, ownerUserId: secondOwnerId, createdById: secondOwnerId } });
    }), isCheckViolation);

    await assert.rejects(() => db.$transaction(async (tx) => {
      await seedPersonalConnectionProbeCreateContext(tx, { kind: "git", actorId: ownerId, connectionId: randomUUID() });
      await tx.gitConnection.create({ data: { ...directGit, id: randomUUID(), name: `Cross connection ${suffix}` } });
    }), isCheckViolation);

    await assert.rejects(() => db.$transaction(async (tx) => {
      await seedPersonalConnectionProbeCreateContext(tx, { kind: "git", actorId: ownerId, connectionId: randomUUID(), expiresAt: new Date(Date.now() - 1_000) });
      await tx.gitConnection.create({ data: { ...directGit, id: randomUUID(), name: `Expired ${suffix}` } });
    }), isCheckViolation);

    const replayRequestKey = randomUUID();
    const replayConfiguration = { fixture: "replay", suffix };
    const replayProbe = await runPersonalConnectionProbe({
      kind: "git",
      action: "create",
      connectionId: null,
      clientRequestKey: replayRequestKey,
      configuration: replayConfiguration,
      secret: null,
    }, actor(ownerId), async () => ({ addressFingerprint: "a".repeat(64), commitSha: "d".repeat(40), resultSnapshot: {} }), db);
    if (replayProbe.draftProbeId === null) throw new Error("PERSONAL_CONNECTION_PROBE_REPLAY_PROBE_MISSING");
    const replayProbeId = replayProbe.draftProbeId;
    const replayFirstConnectionId = randomUUID();
    const replaySecondConnectionId = randomUUID();
    await db.$transaction((tx) => consumePersonalConnectionProbe({
      kind: "git", action: "create", connectionId: null, clientRequestKey: replayRequestKey, configuration: replayConfiguration, secret: null,
    }, actor(ownerId), replayFirstConnectionId, tx, replayProbeId));
    await assert.rejects(() => db.$transaction((tx) => consumePersonalConnectionProbe({
      kind: "git", action: "create", connectionId: null, clientRequestKey: replayRequestKey, configuration: replayConfiguration, secret: null,
    }, actor(ownerId), replaySecondConnectionId, tx, replayProbeId)), (error: unknown) => error instanceof PersonalConnectionProbeError && error.code === "PERSONAL_CONNECTION_PROBE_CONFIGURATION_CONFLICT");

    const updateRequestKey = randomUUID();
    const updateConfiguration = { fixture: "update", connectionId: git.id };
    const updateProbe = await runPersonalConnectionProbe({
      kind: "git", action: "update", connectionId: git.id, clientRequestKey: updateRequestKey, configuration: updateConfiguration, secret: null,
    }, actor(ownerId), async () => ({ addressFingerprint: "a".repeat(64), commitSha: "e".repeat(40), resultSnapshot: {} }), db);
    if (updateProbe.draftProbeId === null) throw new Error("PERSONAL_CONNECTION_PROBE_UPDATE_PROBE_MISSING");
    await db.$transaction(async (tx) => {
      await consumePersonalConnectionProbe({ kind: "git", action: "update", connectionId: git.id, clientRequestKey: updateRequestKey, configuration: updateConfiguration, secret: null }, actor(ownerId), git.id, tx, updateProbe.draftProbeId!);
      await tx.$executeRaw`SELECT set_config('app.git_connection_governance_context', '1', true)`;
      await tx.$executeRaw`SELECT set_config('app.git_connection_governance_connection_id', ${git.id}, true)`;
      await tx.$executeRaw`SELECT set_config('app.git_connection_governance_actor_id', ${ownerId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.git_connection_governance_action', 'retest', true)`;
      await tx.gitConnection.update({ where: { id: git.id }, data: { lastTestedAt: new Date() } });
    });
    await assert.rejects(() => db.$transaction((tx) => consumePersonalConnectionProbe({
      kind: "git", action: "update", connectionId: git.id, clientRequestKey: updateRequestKey, configuration: updateConfiguration, secret: null,
    }, actor(ownerId), git.id, tx, updateProbe.draftProbeId!)), (error: unknown) => error instanceof PersonalConnectionProbeError && error.code === "PERSONAL_CONNECTION_PROBE_CONFIGURATION_CONFLICT");
  } finally {
    if (previousMasterKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousMasterKeyPath;
    await rm(keyDirectory, { recursive: true, force: true });
  }
});

test("draft probes recheck revoked actor access before Git or MCP dispatch", { skip: !shouldRun ? "PERSONAL_CONNECTION_PROBE_POSTGRES_GATE=1 is required" : false }, async () => {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const adminId = randomUUID();
  const gitOwnerId = randomUUID();
  const mcpOwnerId = randomUUID();
  await db.appUser.createMany({ data: [
    { id: adminId, username: `probe_dispatch_admin_${suffix}`, role: "admin" },
    { id: gitOwnerId, username: `probe_dispatch_git_${suffix}`, role: "user" },
    { id: mcpOwnerId, username: `probe_dispatch_mcp_${suffix}`, role: "user" },
  ] });

  const gitStarted = deferred();
  const releaseGit = deferred();
  let gitProcessCount = 0;
  const gitProbePromise = probeGitConnectionDraft({
    name: `Draft Git ${suffix}`,
    providerKind: "generic",
    transport: "https",
    baseUrl: "https://git.example.test",
    authKind: "token",
    username: "oauth2",
    secret: "draft-git-token-123456",
    allowPrivateNetwork: false,
    tlsCaCertificate: null,
    sshKnownHost: null,
    clientRequestKey: randomUUID(),
    repositoryPath: "owner/repository",
    trackedRef: "main",
  }, actor(gitOwnerId), db, {
    probeRepository: async (_connection, _repositoryPath, _trackedRef, options) => {
      gitStarted.resolve();
      await releaseGit.promise;
      const accepted = await options.onDispatchBoundary?.() ?? true;
      if (accepted) gitProcessCount += 1;
      return { addressFingerprint: "a".repeat(64), commitSha: "b".repeat(40) };
    },
  });
  await gitStarted.promise;
  const gitDisable = await disableAccount(db, adminId, gitOwnerId, "draft Git dispatch fence");
  assert.equal(gitDisable.state, "disabled");
  releaseGit.resolve();
  const gitProbe = await gitProbePromise;
  assert.equal(gitProbe.status, "rejected");
  assert.equal(gitProbe.safeErrorCode, "PERSONAL_CONNECTION_PROBE_CONFIGURATION_CONFLICT");
  assert.equal(gitProcessCount, 0);

  const mcpStarted = deferred();
  const releaseMcp = deferred();
  let mcpRequestCount = 0;
  let authorizationSent = false;
  const mcpProbePromise = probeMcpConnectionDraft({
    name: `Draft MCP ${suffix}`,
    endpointUrl: "https://mcp.example.test/rpc",
    authKind: "bearer",
    bearerToken: "draft-mcp-token-123456",
    allowPrivateNetwork: false,
    clientRequestKey: randomUUID(),
  }, actor(mcpOwnerId), db, {
    resolveEndpoint: async () => {
      mcpStarted.resolve();
      await releaseMcp.promise;
      return { url: "https://mcp.example.test/rpc", fingerprint: "c".repeat(64), addresses: ["198.51.100.20"] };
    },
    initializeSession: async (input) => {
      const accepted = await input.onDispatchBoundary?.() ?? true;
      if (accepted) {
        mcpRequestCount += 1;
        authorizationSent ||= input.bearerToken !== null;
      }
      return { protocolVersion: MCP_PROTOCOL_VERSION, sessionId: null, addressFingerprint: "c".repeat(64) };
    },
    discoverTools: async (input) => {
      const accepted = await input.onDispatchBoundary?.() ?? true;
      if (accepted) {
        mcpRequestCount += 1;
        authorizationSent ||= input.bearerToken !== null;
      }
      return { tools: [], rejectedCount: 0, catalogFingerprint: "d".repeat(64), addressFingerprint: "c".repeat(64), protocolVersion: MCP_PROTOCOL_VERSION };
    },
  });
  await mcpStarted.promise;
  const mcpDisable = await disableAccount(db, adminId, mcpOwnerId, "draft MCP dispatch fence");
  assert.equal(mcpDisable.state, "disabled");
  releaseMcp.resolve();
  const mcpProbe = await mcpProbePromise;
  assert.equal(mcpProbe.status, "rejected");
  assert.equal(mcpProbe.safeErrorCode, "PERSONAL_CONNECTION_PROBE_CONFIGURATION_CONFLICT");
  assert.equal(mcpRequestCount, 0);
  assert.equal(authorizationSent, false);
});
