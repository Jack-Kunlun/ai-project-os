import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import {
  deleteProviderConnection,
  ProviderServiceError,
  updateProviderConnection,
} from "../src/lib/ai-providers";
import { getDb } from "../src/lib/db";
import { createVerifiedProviderFixture } from "./platform-provider-fixture";
import { createPostgresWorkspaceFixture } from "./postgres-workspace-fixture";
import {
  createGitConnection,
  executeGitConnectionMutation,
  getGitConnection,
  GitServiceError,
  listGitConnections,
  previewGitConnectionMutation,
} from "../src/lib/git";
import {
  createMcpConnection,
  executeMcpConnectionMutation,
  getMcpConnection,
  listMcpConnections,
  McpCapabilityError,
  previewMcpConnectionMutation,
} from "../src/lib/mcp";

const shouldRun = process.env.CONFIGURATION_DELETION_POSTGRES_GATE === "1";

type GovernanceActor = Readonly<{ id: string; accountAccessVersion?: number }>;
type GitMutationAction = "rotateCredential" | "retrust" | "retest" | "disable" | "enable" | "delete";
type McpMutationAction = "rotateCredential" | "retrust" | "rediscover" | "disable" | "enable" | "delete";

function compactRequestKey(prefix: string, suffix: string, connectionId?: string): string {
  const key = `${prefix}-${suffix}${connectionId === undefined ? "" : `-${connectionId.slice(0, 8)}`}`;
  assert.ok(key.length < 40, `request key must stay below 40 characters: ${key}`);
  return key;
}

async function expectDatabaseGuard(action: () => Promise<unknown>, phrase: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes(phrase);
  });
}

async function governGitMutation(
  connectionId: string,
  current: Readonly<{ name: string; updatedAt: Date }>,
  action: GitMutationAction,
  requestKey: string,
  reason: string,
  actor: GovernanceActor,
  db: PrismaClient,
  options: Readonly<{ secret?: string; confirmationName?: string }> = {},
) {
  const preview = await previewGitConnectionMutation(connectionId, {
    action,
    requestKey,
    reason,
    expectedUpdatedAt: current.updatedAt.toISOString(),
    ...(options.secret === undefined ? {} : { secret: options.secret }),
    ...(options.confirmationName === undefined ? {} : { confirmationName: options.confirmationName }),
  }, actor, db);
  const result = await executeGitConnectionMutation(connectionId, {
    previewId: preview.id,
    requestKey: preview.requestKey,
    requestFingerprint: preview.requestFingerprint,
    impactFingerprint: preview.impactFingerprint,
    expectedUpdatedAt: preview.connection.updatedAt,
    ...(options.secret === undefined ? {} : { secret: options.secret }),
    ...(options.confirmationName === undefined ? {} : { confirmationName: options.confirmationName }),
  }, actor, db);
  return { preview, result };
}

async function governMcpMutation(
  connectionId: string,
  current: Readonly<{ name: string; updatedAt: Date }>,
  action: McpMutationAction,
  requestKey: string,
  reason: string,
  actor: GovernanceActor,
  db: PrismaClient,
  options: Readonly<{ secret?: string; confirmationName?: string }> = {},
) {
  const preview = await previewMcpConnectionMutation(connectionId, {
    action,
    requestKey,
    reason,
    expectedUpdatedAt: current.updatedAt.toISOString(),
    ...(options.secret === undefined ? {} : { secret: options.secret }),
    ...(options.confirmationName === undefined ? {} : { confirmationName: options.confirmationName }),
  }, actor, db);
  const result = await executeMcpConnectionMutation(connectionId, {
    previewId: preview.id,
    requestKey: preview.requestKey,
    requestFingerprint: preview.requestFingerprint,
    impactFingerprint: preview.impactFingerprint,
    expectedUpdatedAt: preview.connection.updatedAt,
    ...(options.secret === undefined ? {} : { secret: options.secret }),
    ...(options.confirmationName === undefined ? {} : { confirmationName: options.confirmationName }),
  }, actor, db);
  return { preview, result };
}

async function cleanupGitConnection(connectionId: string, actor: GovernanceActor, suffix: string, db: PrismaClient): Promise<void> {
  const existing = await db.gitConnection.findUnique({ where: { id: connectionId }, select: { id: true, status: true, name: true, updatedAt: true } });
  if (existing === null) return;
  await db.projectGitRepositoryLink.deleteMany({ where: { repository: { gitConnectionId: connectionId } } });
  await db.gitRepository.deleteMany({ where: { gitConnectionId: connectionId } });
  let current = await db.gitConnection.findUnique({ where: { id: connectionId }, select: { id: true, status: true, name: true, updatedAt: true } });
  if (current === null) return;
  if (current.status !== "disabled") {
    await governGitMutation(connectionId, current, "disable", compactRequestKey("g-cln-x", suffix, connectionId), "test fixture cleanup", actor, db);
    current = await db.gitConnection.findUnique({ where: { id: connectionId }, select: { id: true, status: true, name: true, updatedAt: true } });
  }
  if (current !== null) {
    const deletion = await previewGitConnectionMutation(connectionId, {
      action: "delete",
      requestKey: compactRequestKey("g-cln-d", suffix, connectionId),
      reason: "test fixture cleanup",
      expectedUpdatedAt: current.updatedAt.toISOString(),
      confirmationName: current.name,
    }, actor, db);
    if (deletion.canExecute) {
      await executeGitConnectionMutation(connectionId, {
        previewId: deletion.id,
        requestKey: deletion.requestKey,
        requestFingerprint: deletion.requestFingerprint,
        impactFingerprint: deletion.impactFingerprint,
        expectedUpdatedAt: deletion.connection.updatedAt,
        confirmationName: current.name,
      }, actor, db);
    }
  }
}

async function cleanupMcpConnection(connectionId: string, actor: GovernanceActor, suffix: string, db: PrismaClient): Promise<void> {
  let current = await db.mcpConnection.findUnique({ where: { id: connectionId }, select: { id: true, status: true, name: true, updatedAt: true } });
  if (current === null) return;
  if (current.status !== "disabled") {
    await governMcpMutation(connectionId, current, "disable", compactRequestKey("m-cln-x", suffix, connectionId), "test fixture cleanup", actor, db);
    current = await db.mcpConnection.findUnique({ where: { id: connectionId }, select: { id: true, status: true, name: true, updatedAt: true } });
  }
  if (current !== null) {
    const deletion = await previewMcpConnectionMutation(connectionId, {
      action: "delete",
      requestKey: compactRequestKey("m-cln-d", suffix, connectionId),
      reason: "test fixture cleanup",
      expectedUpdatedAt: current.updatedAt.toISOString(),
      confirmationName: current.name,
    }, actor, db);
    if (deletion.canExecute) {
      await executeMcpConnectionMutation(connectionId, {
        previewId: deletion.id,
        requestKey: deletion.requestKey,
        requestFingerprint: deletion.requestFingerprint,
        impactFingerprint: deletion.impactFingerprint,
        expectedUpdatedAt: deletion.connection.updatedAt,
        confirmationName: current.name,
      }, actor, db);
    }
  }
}

test("unused model and Git connections can be permanently deleted while historical Git links stay protected", {
  skip: !shouldRun ? "CONFIGURATION_DELETION_POSTGRES_GATE=1 is required" : false,
}, async () => {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const adminActor = { id: userId, role: "admin" as const, accountAccessVersion: 1 };
  const projectId = randomUUID();
  const keyDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-configuration-delete-"));
  const previousKeyFile = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
  const gitActor = { id: userId, accountAccessVersion: 1 };
  const otherActor = { id: otherUserId, accountAccessVersion: 1 };
  process.env.AI_PROJECT_OS_MASTER_KEY_FILE = join(keyDirectory, "master.key");
  let providerId: string | null = null;
  let providerCredentialId: string | null = null;
  let gitConnectionId: string | null = null;
  let gitCredentialId: string | null = null;
  let historicalConnectionId: string | null = null;
  let historicalCredentialId: string | null = null;
  let mcpConnectionId: string | null = null;
  let mcpCredentialId: string | null = null;

  await db.appUser.createMany({ data: [
    { id: userId, username: `configuration_delete_${suffix}`, role: "admin" },
    { id: otherUserId, username: `configuration_delete_other_${suffix}`, role: "user" },
  ] });
  const workspace = await createPostgresWorkspaceFixture(db);
  await db.project.create({ data: { id: projectId, workspaceId: workspace.workspaceId, name: `Configuration deletion ${suffix}`, slug: `configuration-deletion-${suffix}` } });

  try {
    const provider = await createVerifiedProviderFixture({
      name: `Disposable DeepSeek ${suffix}`,
      kind: "deepseek",
      apiKey: `deepseek-test-${suffix}`,
      generationModelId: "deepseek-chat",
      visionModelId: null,
      embeddingModelId: null,
      embeddingDimensions: null,
    }, adminActor, db);
    providerId = provider.id;
    providerCredentialId = (await db.aiProviderConnection.findUniqueOrThrow({ where: { id: provider.id }, select: { credentialId: true } })).credentialId;
    await assert.rejects(
      () => deleteProviderConnection(provider.id, { confirmationName: provider.name }, adminActor, db),
      (error: unknown) => error instanceof ProviderServiceError && error.code === "AI_PROVIDER_DELETE_REQUIRES_DISABLED",
    );
    await updateProviderConnection(provider.id, { enabled: false }, adminActor, db);
    await assert.rejects(
      () => deleteProviderConnection(provider.id, { confirmationName: "wrong name" }, adminActor, db),
      (error: unknown) => error instanceof ProviderServiceError && error.code === "AI_PROVIDER_CONFIRMATION_MISMATCH",
    );
    await deleteProviderConnection(provider.id, { confirmationName: provider.name }, adminActor, db);
    assert.equal(await db.aiProviderConnection.count({ where: { id: provider.id } }), 0);
    assert.equal(await db.externalCredential.count({ where: { id: providerCredentialId } }), 0);
    providerId = null;
    providerCredentialId = null;

    const createdGitConnection = await createGitConnection({
      name: `Disposable Git ${suffix}`,
      providerKind: "github",
      transport: "https",
      baseUrl: "https://github.com",
      authKind: "token",
      secret: `github-test-${suffix}`,
      allowPrivateNetwork: false,
    }, adminActor, db);
    gitConnectionId = createdGitConnection.id;
    gitCredentialId = (await db.gitConnection.findUniqueOrThrow({ where: { id: createdGitConnection.id }, select: { credentialId: true } })).credentialId;
    let gitConnection = await db.gitConnection.findUniqueOrThrow({ where: { id: createdGitConnection.id } });
    await expectDatabaseGuard(
      () => db.gitConnection.update({ where: { id: gitConnection.id }, data: { username: `git-user-${suffix}` } }),
      "security fields require governance context",
    );
    assert.deepEqual(await listGitConnections(otherActor, db), []);
    await assert.rejects(
      () => getGitConnection(gitConnection.id, otherActor, db),
      (error: unknown) => error instanceof GitServiceError && error.code === "GIT_CONNECTION_NOT_FOUND",
    );
    await assert.rejects(
      () => previewGitConnectionMutation(gitConnection.id, {
        action: "rotateCredential",
        requestKey: compactRequestKey("g-xo-r", suffix),
        reason: "cross-owner mutation must be hidden",
        expectedUpdatedAt: gitConnection.updatedAt.toISOString(),
        secret: `cross-owner-${suffix}`,
      }, otherActor, db),
      (error: unknown) => error instanceof GitServiceError && error.code === "GIT_CONNECTION_NOT_FOUND",
    );
    await assert.rejects(
      () => previewGitConnectionMutation(gitConnection.id, {
        action: "delete",
        requestKey: compactRequestKey("g-xo-d", suffix),
        reason: "cross-owner deletion must be hidden",
        expectedUpdatedAt: gitConnection.updatedAt.toISOString(),
        confirmationName: gitConnection.name,
      }, otherActor, db),
      (error: unknown) => error instanceof GitServiceError && error.code === "GIT_CONNECTION_NOT_FOUND",
    );
    await assert.rejects(
      () => db.gitConnection.delete({ where: { id: gitConnection.id } }),
      (error: unknown) => error instanceof Error && error.message.includes("delete requires governance context"),
    );
    const connectionBeforeRotation = await db.gitConnection.findUniqueOrThrow({ where: { id: gitConnection.id } });
    const credentialBeforeRotation = await db.externalCredential.findUniqueOrThrow({ where: { id: gitCredentialId! }, select: { secretFingerprint: true } });
    const rotatedSecret = `github-rotated-${suffix}`;
    const rotation = await governGitMutation(
      gitConnection.id,
      connectionBeforeRotation,
      "rotateCredential",
      compactRequestKey("g-rot", suffix),
      "rotate Git credential through governed preview",
      gitActor,
      db,
      { secret: rotatedSecret },
    );
    assert.equal(rotation.preview.canExecute, true);
    assert.equal(rotation.result.status, "completed");
    gitConnection = await db.gitConnection.findUniqueOrThrow({ where: { id: gitConnection.id } });
    assert.equal(gitConnection.status, "configured");
    assert.equal(gitConnection.configurationVersion, connectionBeforeRotation.configurationVersion + 1);
    assert.equal(gitConnection.resolvedAddressFingerprint, null);
    assert.equal(gitConnection.lastTestedAt, null);
    const credentialAfterRotation = await db.externalCredential.findUniqueOrThrow({ where: { id: gitCredentialId! }, select: { secretFingerprint: true } });
    assert.notEqual(credentialAfterRotation.secretFingerprint, credentialBeforeRotation.secretFingerprint);

    const blockedDeletePreview = await previewGitConnectionMutation(gitConnection.id, {
      action: "delete",
      requestKey: compactRequestKey("g-pre-d", suffix),
      reason: "preview delete must require disabled state",
      expectedUpdatedAt: gitConnection.updatedAt.toISOString(),
      confirmationName: gitConnection.name,
    }, gitActor, db);
    assert.equal(blockedDeletePreview.canExecute, false);
    assert.equal(blockedDeletePreview.blockers.includes("connection_must_be_disabled"), true);

    const disable = await governGitMutation(
      gitConnection.id,
      gitConnection,
      "disable",
      compactRequestKey("g-dis", suffix),
      "disable Git connection through governed preview",
      gitActor,
      db,
    );
    assert.equal(disable.preview.canExecute, true);
    assert.equal(disable.result.status, "completed");
    const disabledGit = await db.gitConnection.findUniqueOrThrow({ where: { id: gitConnection.id } });
    assert.equal(disabledGit.status, "disabled");
    assert.equal(disabledGit.configurationVersion, gitConnection.configurationVersion + 1);
    assert.ok(disabledGit.disabledAt);

    const enable = await governGitMutation(
      gitConnection.id,
      disabledGit,
      "enable",
      compactRequestKey("g-en", suffix),
      "enable Git connection through governed preview",
      gitActor,
      db,
    );
    assert.equal(enable.preview.canExecute, true);
    assert.equal(enable.result.status, "completed");
    gitConnection = await db.gitConnection.findUniqueOrThrow({ where: { id: gitConnection.id } });
    assert.equal(gitConnection.status, "configured");

    const stalePreview = previewGitConnectionMutation(gitConnection.id, {
      action: "disable",
      requestKey: compactRequestKey("g-stale", suffix),
      reason: "stale CAS must fail",
      expectedUpdatedAt: new Date(0).toISOString(),
    }, gitActor, db);
    await assert.rejects(
      () => stalePreview,
      (error: unknown) => error instanceof GitServiceError && error.code === "GIT_CONNECTION_CONFLICT",
    );

    const disabledForConfirmationResult = await governGitMutation(
      gitConnection.id,
      gitConnection,
      "disable",
      compactRequestKey("g-dis-confirm", suffix),
      "disable before deletion confirmation",
      gitActor,
      db,
    );
    assert.equal(disabledForConfirmationResult.result.status, "completed");
    const disabledForConfirmation = await db.gitConnection.findUniqueOrThrow({ where: { id: gitConnection.id } });
    const wrongDeletePreview = await previewGitConnectionMutation(gitConnection.id, {
      action: "delete",
      requestKey: compactRequestKey("g-wrong", suffix),
      reason: "wrong confirmation must remain blocked",
      expectedUpdatedAt: disabledForConfirmation.updatedAt.toISOString(),
      confirmationName: "wrong name",
    }, gitActor, db);
    assert.equal(wrongDeletePreview.canExecute, false);
    assert.equal(wrongDeletePreview.blockers.includes("confirmation_name_mismatch"), true);
    await assert.rejects(
      () => executeGitConnectionMutation(gitConnection.id, {
        previewId: wrongDeletePreview.id,
        requestKey: wrongDeletePreview.requestKey,
        requestFingerprint: wrongDeletePreview.requestFingerprint,
        impactFingerprint: wrongDeletePreview.impactFingerprint,
        expectedUpdatedAt: wrongDeletePreview.connection.updatedAt,
        confirmationName: "wrong name",
      }, gitActor, db),
      (error: unknown) => error instanceof GitServiceError && error.code === "GIT_CONNECTION_IN_USE",
    );
    const deletion = await governGitMutation(
      gitConnection.id,
      disabledForConfirmation,
      "delete",
      compactRequestKey("g-del", suffix),
      "delete unused Git connection through governed preview",
      gitActor,
      db,
      { confirmationName: disabledForConfirmation.name },
    );
    assert.equal(deletion.preview.canExecute, true);
    assert.equal(deletion.result.status, "completed");
    assert.equal(await db.gitConnection.count({ where: { id: gitConnection.id } }), 0);
    assert.equal(await db.externalCredential.count({ where: { id: gitCredentialId! } }), 0);
    gitConnectionId = null;
    gitCredentialId = null;

    const historicalConnection = await createGitConnection({
      name: `Historical Git ${suffix}`,
      providerKind: "github",
      transport: "https",
      baseUrl: "https://github.com",
      authKind: "token",
      secret: `github-history-${suffix}`,
      allowPrivateNetwork: false,
    }, gitActor, db);
    historicalConnectionId = historicalConnection.id;
    historicalCredentialId = (await db.gitConnection.findUniqueOrThrow({ where: { id: historicalConnection.id }, select: { credentialId: true } })).credentialId;
    const repository = await db.gitRepository.create({
      data: {
        gitConnectionId: historicalConnection.id,
        repositoryPath: `owner/repository-${suffix}`,
        displayName: `Repository ${suffix}`,
        defaultBranch: "main",
      },
    });
    await db.projectGitRepositoryLink.create({
      data: {
        projectId,
        gitRepositoryId: repository.id,
        role: "primary",
        trackedRef: "main",
        createdById: userId,
      },
    });
    const disabledHistoricalResult = await governGitMutation(
      historicalConnection.id,
      historicalConnection,
      "disable",
      compactRequestKey("g-hist-dis", suffix),
      "disable Git connection with legacy project reference",
      gitActor,
      db,
    );
    assert.equal(disabledHistoricalResult.result.status, "completed");
    const disabledHistorical = await db.gitConnection.findUniqueOrThrow({ where: { id: historicalConnection.id } });
    const historicalDeletePreview = await previewGitConnectionMutation(historicalConnection.id, {
      action: "delete",
      requestKey: compactRequestKey("g-hist-del", suffix),
      reason: "legacy project reference must be retained",
      expectedUpdatedAt: disabledHistorical.updatedAt.toISOString(),
      confirmationName: historicalConnection.name,
    }, gitActor, db);
    assert.equal(historicalDeletePreview.canExecute, false);
    assert.equal(historicalDeletePreview.blockers.includes("legacy_project_link"), true);
    await assert.rejects(
      () => executeGitConnectionMutation(historicalConnection.id, {
        previewId: historicalDeletePreview.id,
        requestKey: historicalDeletePreview.requestKey,
        requestFingerprint: historicalDeletePreview.requestFingerprint,
        impactFingerprint: historicalDeletePreview.impactFingerprint,
        expectedUpdatedAt: historicalDeletePreview.connection.updatedAt,
        confirmationName: historicalConnection.name,
      }, gitActor, db),
      (error: unknown) => error instanceof GitServiceError && error.code === "GIT_CONNECTION_IN_USE",
    );

    const mcpConnection = await createMcpConnection({
      name: `Private MCP ${suffix}`,
      endpointUrl: "http://127.0.0.1:9/mcp",
      authKind: "bearer",
      bearerToken: `mcp-test-token-${suffix}`,
      allowPrivateNetwork: true,
    }, gitActor, db);
    mcpConnectionId = mcpConnection.id;
    mcpCredentialId = (await db.mcpConnection.findUniqueOrThrow({ where: { id: mcpConnection.id }, select: { credentialId: true } })).credentialId;
    assert.deepEqual(await listMcpConnections(otherActor, db), []);
    await assert.rejects(
      () => getMcpConnection(mcpConnection.id, otherActor, db),
      (error: unknown) => error instanceof McpCapabilityError && error.code === "MCP_CONNECTION_NOT_FOUND",
    );
    await assert.rejects(
      () => previewMcpConnectionMutation(mcpConnection.id, {
        action: "rotateCredential",
        requestKey: compactRequestKey("m-xo-r", suffix),
        reason: "cross-owner mutation must be hidden",
        expectedUpdatedAt: mcpConnection.updatedAt.toISOString(),
        secret: `cross-owner-${suffix}`,
      }, otherActor, db),
      (error: unknown) => error instanceof McpCapabilityError && error.code === "MCP_CONNECTION_NOT_FOUND",
    );
    await assert.rejects(
      () => previewMcpConnectionMutation(mcpConnection.id, {
        action: "delete",
        requestKey: compactRequestKey("m-xo-d", suffix),
        reason: "cross-owner deletion must be hidden",
        expectedUpdatedAt: mcpConnection.updatedAt.toISOString(),
        confirmationName: mcpConnection.name,
      }, otherActor, db),
      (error: unknown) => error instanceof McpCapabilityError && error.code === "MCP_CONNECTION_NOT_FOUND",
    );
    await assert.rejects(
      () => db.mcpConnection.update({ where: { id: mcpConnection.id }, data: { endpointUrl: "https://cross-owner.example.test/mcp" } }),
      (error: unknown) => error instanceof Error && error.message.includes("security fields require governance context"),
    );
    await assert.rejects(
      () => db.mcpConnection.delete({ where: { id: mcpConnection.id } }),
      (error: unknown) => error instanceof Error && error.message.includes("delete requires governance context"),
    );
    const mcpBeforeRotation = await db.mcpConnection.findUniqueOrThrow({ where: { id: mcpConnection.id } });
    const rotatedToken = `mcp-rotated-token-${suffix}`;
    const mcpRotation = await governMcpMutation(
      mcpConnection.id,
      mcpBeforeRotation,
      "rotateCredential",
      compactRequestKey("m-rot", suffix),
      "rotate MCP credential through governed preview",
      gitActor,
      db,
      { secret: rotatedToken },
    );
    assert.equal(mcpRotation.preview.canExecute, true);
    assert.equal(mcpRotation.result.status, "completed");
    let currentMcp = await db.mcpConnection.findUniqueOrThrow({ where: { id: mcpConnection.id } });
    assert.equal(currentMcp.status, "configured");
    assert.equal(currentMcp.configurationRevision, mcpBeforeRotation.configurationRevision + 1);
    assert.equal(currentMcp.protocolVersion, null);
    assert.equal(currentMcp.catalogFingerprint, null);
    assert.equal(currentMcp.lastDiscoveredAt, null);

    const mcpDisable = await governMcpMutation(
      mcpConnection.id,
      currentMcp,
      "disable",
      compactRequestKey("m-dis", suffix),
      "disable MCP connection through governed preview",
      gitActor,
      db,
    );
    assert.equal(mcpDisable.preview.canExecute, true);
    assert.equal(mcpDisable.result.status, "completed");
    currentMcp = await db.mcpConnection.findUniqueOrThrow({ where: { id: mcpConnection.id } });
    assert.equal(currentMcp.status, "disabled");
    assert.equal(currentMcp.configurationRevision, mcpBeforeRotation.configurationRevision + 2);

    const disabledRediscoverPreview = await previewMcpConnectionMutation(mcpConnection.id, {
      action: "rediscover",
      requestKey: compactRequestKey("m-dis-redisc", suffix),
      reason: "rediscovery remains held while disabled",
      expectedUpdatedAt: currentMcp.updatedAt.toISOString(),
    }, gitActor, db);
    assert.equal(disabledRediscoverPreview.canExecute, false);
    assert.equal(disabledRediscoverPreview.blockers.includes("connection_disabled"), true);
    assert.equal(disabledRediscoverPreview.blockers.includes("external_io_planned_not_dispatched"), true);

    const mcpEnable = await governMcpMutation(
      mcpConnection.id,
      currentMcp,
      "enable",
      compactRequestKey("m-en", suffix),
      "enable MCP connection through governed preview",
      gitActor,
      db,
    );
    assert.equal(mcpEnable.preview.canExecute, true);
    assert.equal(mcpEnable.result.status, "completed");
    currentMcp = await db.mcpConnection.findUniqueOrThrow({ where: { id: mcpConnection.id } });
    assert.equal(currentMcp.status, "configured");
    const rediscoverPreview = await previewMcpConnectionMutation(mcpConnection.id, {
      action: "rediscover",
      requestKey: compactRequestKey("m-redisc", suffix),
      reason: "rediscovery must remain fail-closed until external dispatch is implemented",
      expectedUpdatedAt: currentMcp.updatedAt.toISOString(),
    }, gitActor, db);
    assert.equal(rediscoverPreview.canExecute, false);
    assert.equal(rediscoverPreview.blockers.includes("external_io_planned_not_dispatched"), true);
    await assert.rejects(
      () => previewMcpConnectionMutation(mcpConnection.id, {
        action: "rediscover",
        requestKey: compactRequestKey("m-xo-redisc", suffix),
        reason: "cross-owner discovery must be hidden",
        expectedUpdatedAt: currentMcp.updatedAt.toISOString(),
      }, otherActor, db),
      (error: unknown) => error instanceof McpCapabilityError && error.code === "MCP_CONNECTION_NOT_FOUND",
    );
  } finally {
    await db.project.deleteMany({ where: { id: projectId } });
    if (providerId !== null) await db.aiProviderConnection.deleteMany({ where: { id: providerId } });
    if (historicalConnectionId !== null) {
      await cleanupGitConnection(historicalConnectionId, gitActor, suffix, db);
    }
    if (gitConnectionId !== null) await cleanupGitConnection(gitConnectionId, gitActor, suffix, db);
    if (mcpConnectionId !== null) await cleanupMcpConnection(mcpConnectionId, gitActor, suffix, db);
    const credentialIds = [providerCredentialId, gitCredentialId, historicalCredentialId, mcpCredentialId].filter((id): id is string => id !== null);
    if (credentialIds.length > 0) await db.externalCredential.deleteMany({ where: { id: { in: credentialIds } } });
    // Immutable governance previews/audits retain actor FKs; the disposable gate runner drops this database.
    if (previousKeyFile === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyFile;
    await rm(keyDirectory, { recursive: true, force: true });
  }
});
