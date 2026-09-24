import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDb } from "../src/lib/db";
import { executeGitConnectionMutation, previewGitConnectionMutation } from "../src/lib/git/connection-governance";
import { probeGitConnectionUpdate } from "../src/lib/git/service";
import { executeMcpConnectionMutation, previewMcpConnectionMutation } from "../src/lib/mcp/connection-governance";
import { MCP_PROTOCOL_VERSION } from "../src/lib/mcp/client";
import { probeMcpConnectionUpdate } from "../src/lib/mcp/service";
import { createGitConnectionFixture, createMcpConnectionFixture } from "./personal-connection-probe-fixture";

const shouldRun = process.env.CONNECTION_CONFIGURATION_EDIT_POSTGRES_GATE === "1";

test("tested Git and MCP configuration edits consume exact proofs and invalidate old versions", { skip: !shouldRun ? "CONNECTION_CONFIGURATION_EDIT_POSTGRES_GATE=1 is required" : false }, async () => {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const userId = randomUUID();
  const actor = { id: userId, accountAccessVersion: 1 } as const;
  try {
    await db.appUser.create({ data: { id: userId, username: `config_edit_${suffix}`, accountAccessVersion: 1 } });
    const git = await createGitConnectionFixture({
      id: randomUUID(), name: `Git edit ${suffix}`, providerKind: "generic", transport: "https",
      baseUrl: "https://old-git.example.test", authKind: "none", credentialId: null,
      status: "verified", resolvedAddressFingerprint: "a".repeat(64),
      createdById: userId, ownerUserId: userId, ownerAccountAccessVersion: 1, ownershipState: "confirmed",
    }, db);
    const gitCandidate = {
      providerKind: "generic" as const, transport: "https" as const, baseUrl: "https://new-git.example.test",
      authKind: "token" as const, username: "reader", secret: `git-edit-${suffix}`,
      allowPrivateNetwork: false, tlsCaCertificate: null, sshKnownHost: null,
      repositoryPath: "owner/repository", trackedRef: "main",
    };
    const gitKey = randomUUID();
    const gitProbe = await probeGitConnectionUpdate(git.id, {
      clientRequestKey: gitKey, expectedUpdatedAt: git.updatedAt.toISOString(),
      repositoryPath: gitCandidate.repositoryPath, trackedRef: gitCandidate.trackedRef, candidate: gitCandidate,
    }, actor, db, { probeRepository: async (_connection, _repositoryPath, _trackedRef, options) => {
      assert.equal(await options.onDispatchBoundary?.(), true);
      return { commitSha: "b".repeat(40), addressFingerprint: "c".repeat(64) };
    } });
    assert.equal(gitProbe.status, "settled");
    assert.ok(gitProbe.draftProbeId);
    const gitIntent = {
      action: "retest" as const, requestKey: randomUUID(), reason: "edit address and auth",
      expectedUpdatedAt: git.updatedAt.toISOString(), draftProbeId: gitProbe.draftProbeId!,
      probeRequestKey: gitKey, repositoryPath: gitCandidate.repositoryPath, trackedRef: gitCandidate.trackedRef,
      candidate: gitCandidate,
    };
    const gitPreview = await previewGitConnectionMutation(git.id, gitIntent, actor, db);
    assert.equal(gitPreview.canExecute, true);
    const gitExecution = { previewId: gitPreview.id, requestKey: gitPreview.requestKey, requestFingerprint: gitPreview.requestFingerprint, impactFingerprint: gitPreview.impactFingerprint, expectedUpdatedAt: git.updatedAt.toISOString(), draftProbeId: gitProbe.draftProbeId!, probeRequestKey: gitKey, repositoryPath: gitCandidate.repositoryPath, trackedRef: gitCandidate.trackedRef, candidate: gitCandidate };
    await assert.rejects(() => executeGitConnectionMutation(git.id, { ...gitExecution, candidate: { ...gitCandidate, baseUrl: "https://tampered.example.test" } }, actor, db), { code: "GIT_CONNECTION_PREVIEW_MISMATCH" });
    await assert.rejects(() => executeGitConnectionMutation(git.id, { ...gitExecution, candidate: { ...gitCandidate, secret: "different-secret" } }, actor, db), { code: "GIT_CONNECTION_PREVIEW_MISMATCH" });
    await assert.rejects(() => executeGitConnectionMutation(git.id, { ...gitExecution, candidate: { ...gitCandidate, allowPrivateNetwork: true } }, actor, db), { code: "GIT_CONNECTION_PREVIEW_MISMATCH" });
    const gitResult = await executeGitConnectionMutation(git.id, gitExecution, actor, db);
    assert.equal(gitResult.status, "completed");
    const changedGit = await db.gitConnection.findUniqueOrThrow({ where: { id: git.id } });
    assert.equal(changedGit.baseUrl, gitCandidate.baseUrl);
    assert.equal(changedGit.authKind, "token");
    assert.ok(changedGit.credentialId);
    assert.equal(changedGit.configurationVersion, git.configurationVersion + 1);
    assert.equal(changedGit.resolvedAddressFingerprint, "c".repeat(64));
    assert.equal((await executeGitConnectionMutation(git.id, gitExecution, actor, db)).auditId, gitResult.auditId);

    const mcp = await createMcpConnectionFixture({
      id: randomUUID(), name: `MCP edit ${suffix}`, endpointUrl: "https://old-mcp.example.test/mcp",
      authKind: "none", credentialId: null, status: "verified", resolvedAddressFingerprint: "a".repeat(64),
      protocolVersion: MCP_PROTOCOL_VERSION, catalogFingerprint: "b".repeat(64),
      createdById: userId, ownerUserId: userId, ownerAccountAccessVersion: 1, ownershipState: "confirmed",
    }, db);
    const mcpCandidate = { endpointUrl: "https://new-mcp.example.test/mcp", authKind: "bearer" as const, bearerToken: `mcp-edit-${suffix}`, allowPrivateNetwork: false };
    const mcpKey = randomUUID();
    const mcpProbe = await probeMcpConnectionUpdate(mcp.id, { clientRequestKey: mcpKey, expectedUpdatedAt: mcp.updatedAt.toISOString(), candidate: mcpCandidate }, actor, db, {
      resolveEndpoint: async () => ({ url: mcpCandidate.endpointUrl, fingerprint: "d".repeat(64) }),
      initializeSession: async (input) => { assert.equal(await input.onDispatchBoundary?.(), true); return { protocolVersion: MCP_PROTOCOL_VERSION, sessionId: null, addressFingerprint: "d".repeat(64) }; },
      discoverTools: async (input) => { assert.equal(await input.onDispatchBoundary?.(), true); return { tools: [], rejectedCount: 0, catalogFingerprint: "e".repeat(64), addressFingerprint: "d".repeat(64), protocolVersion: MCP_PROTOCOL_VERSION }; },
    });
    assert.equal(mcpProbe.status, "settled");
    assert.ok(mcpProbe.draftProbeId);
    const mcpIntent = { action: "rediscover" as const, requestKey: randomUUID(), reason: "edit endpoint and auth", expectedUpdatedAt: mcp.updatedAt.toISOString(), draftProbeId: mcpProbe.draftProbeId!, probeRequestKey: mcpKey, candidate: mcpCandidate };
    const mcpPreview = await previewMcpConnectionMutation(mcp.id, mcpIntent, actor, db);
    assert.equal(mcpPreview.canExecute, true);
    const mcpExecution = { previewId: mcpPreview.id, requestKey: mcpPreview.requestKey, requestFingerprint: mcpPreview.requestFingerprint, impactFingerprint: mcpPreview.impactFingerprint, expectedUpdatedAt: mcp.updatedAt.toISOString(), draftProbeId: mcpProbe.draftProbeId!, probeRequestKey: mcpKey, candidate: mcpCandidate };
    await assert.rejects(() => executeMcpConnectionMutation(mcp.id, { ...mcpExecution, candidate: { ...mcpCandidate, endpointUrl: "https://tampered.example.test/mcp" } }, actor, db), { code: "MCP_CONNECTION_PREVIEW_MISMATCH" });
    await assert.rejects(() => executeMcpConnectionMutation(mcp.id, { ...mcpExecution, candidate: { ...mcpCandidate, bearerToken: "different-secret" } }, actor, db), { code: "MCP_CONNECTION_PREVIEW_MISMATCH" });
    await assert.rejects(() => executeMcpConnectionMutation(mcp.id, { ...mcpExecution, candidate: { ...mcpCandidate, allowPrivateNetwork: true } }, actor, db), { code: "MCP_CONNECTION_PREVIEW_MISMATCH" });
    const mcpResult = await executeMcpConnectionMutation(mcp.id, mcpExecution, actor, db);
    assert.equal(mcpResult.status, "completed");
    const changedMcp = await db.mcpConnection.findUniqueOrThrow({ where: { id: mcp.id } });
    assert.equal(changedMcp.endpointUrl, mcpCandidate.endpointUrl);
    assert.equal(changedMcp.authKind, "bearer");
    assert.ok(changedMcp.credentialId);
    assert.equal(changedMcp.configurationRevision, mcp.configurationRevision + 1);
    assert.equal(changedMcp.resolvedAddressFingerprint, "d".repeat(64));
    assert.equal((await executeMcpConnectionMutation(mcp.id, mcpExecution, actor, db)).auditId, mcpResult.auditId);
  } finally {
    await db.$disconnect();
  }
});
