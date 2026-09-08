import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createProviderConnection,
  deleteProviderConnection,
  ProviderServiceError,
  updateProviderConnection,
} from "../src/lib/ai-providers";
import { getDb } from "../src/lib/db";
import {
  createGitConnection,
  deleteGitConnection,
  getGitConnection,
  GitServiceError,
  listGitConnections,
  testGitConnection,
  updateGitConnection,
} from "../src/lib/git";
import {
  createMcpConnection,
  deleteMcpConnection,
  discoverMcpConnectionTools,
  getMcpConnection,
  listMcpConnections,
  McpCapabilityError,
  updateMcpConnection,
} from "../src/lib/mcp";

const shouldRun = process.env.CONFIGURATION_DELETION_POSTGRES_GATE === "1";

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
    { id: otherUserId, username: `configuration_delete_other_${suffix}`, role: "member" },
  ] });
  await db.project.create({ data: { id: projectId, name: `Configuration deletion ${suffix}`, slug: `configuration-deletion-${suffix}` } });

  try {
    const provider = await createProviderConnection({
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

    let gitConnection = await createGitConnection({
      name: `Disposable Git ${suffix}`,
      providerKind: "github",
      transport: "https",
      baseUrl: "https://github.com",
      authKind: "token",
      secret: `github-test-${suffix}`,
      allowPrivateNetwork: false,
    }, adminActor, db);
    gitConnectionId = gitConnection.id;
    gitCredentialId = (await db.gitConnection.findUniqueOrThrow({ where: { id: gitConnection.id }, select: { credentialId: true } })).credentialId;
    const verifiedGit = await db.gitConnection.update({
      where: { id: gitConnection.id },
      data: { status: "verified", resolvedAddressFingerprint: "d".repeat(64), lastTestedAt: new Date(), lastErrorCode: null },
    });
    const usernameChangedGit = await updateGitConnection(gitConnection.id, {
      username: `git-user-${suffix}`,
      expectedUpdatedAt: verifiedGit.updatedAt.toISOString(),
    }, adminActor, db);
    const usernameChangedDetails = await db.gitConnection.findUniqueOrThrow({
      where: { id: gitConnection.id },
      select: { status: true, configurationVersion: true, resolvedAddressFingerprint: true },
    });
    assert.equal(usernameChangedGit.status, "configured");
    assert.equal(usernameChangedDetails.status, "configured");
    assert.equal(usernameChangedDetails.configurationVersion, verifiedGit.configurationVersion + 1);
    assert.equal(usernameChangedDetails.resolvedAddressFingerprint, null);
    gitConnection = usernameChangedGit;
    const gitActor = { id: userId, accountAccessVersion: 1 };
    const otherActor = { id: otherUserId, accountAccessVersion: 1 };
    assert.deepEqual(await listGitConnections(otherActor, db), []);
    await assert.rejects(
      () => getGitConnection(gitConnection.id, otherActor, db),
      (error: unknown) => error instanceof GitServiceError && error.code === "GIT_CONNECTION_NOT_FOUND",
    );
    await assert.rejects(
      () => updateGitConnection(gitConnection.id, { secret: `cross-owner-${suffix}`, expectedUpdatedAt: gitConnection.updatedAt.toISOString() }, otherActor, db),
      (error: unknown) => error instanceof GitServiceError && error.code === "GIT_CONNECTION_NOT_FOUND",
    );
    await assert.rejects(
      () => deleteGitConnection(gitConnection.id, { confirmationName: gitConnection.name, expectedUpdatedAt: gitConnection.updatedAt.toISOString() }, otherActor, db),
      (error: unknown) => error instanceof GitServiceError && error.code === "GIT_CONNECTION_NOT_FOUND",
    );
    await assert.rejects(
      () => testGitConnection(gitConnection.id, { repositoryPath: "owner/private", trackedRef: "main", expectedUpdatedAt: gitConnection.updatedAt.toISOString() }, otherActor, db),
      (error: unknown) => error instanceof GitServiceError && error.code === "GIT_CONNECTION_NOT_FOUND",
    );
    await assert.rejects(
      () => deleteGitConnection(gitConnection.id, { confirmationName: gitConnection.name, expectedUpdatedAt: gitConnection.updatedAt.toISOString() }, gitActor, db),
      (error: unknown) => error instanceof GitServiceError && error.code === "GIT_CONNECTION_DELETE_REQUIRES_DISABLED",
    );
    const disabledGit = await updateGitConnection(gitConnection.id, { enabled: false, expectedUpdatedAt: gitConnection.updatedAt.toISOString() }, gitActor, db);
    const disabledWithExplicitSecret = await updateGitConnection(gitConnection.id, { secret: `github-explicit-disabled-${suffix}`, enabled: false, expectedUpdatedAt: disabledGit.updatedAt.toISOString() }, gitActor, db);
    assert.equal(disabledWithExplicitSecret.status, "disabled");
    const disabledWithImplicitSecret = await updateGitConnection(gitConnection.id, { secret: `github-implicit-disabled-${suffix}`, expectedUpdatedAt: disabledWithExplicitSecret.updatedAt.toISOString() }, gitActor, db);
    assert.equal(disabledWithImplicitSecret.status, "disabled");
    assert.equal(disabledWithImplicitSecret.configurationVersion, disabledWithExplicitSecret.configurationVersion);
    const renamedDisabled = await updateGitConnection(gitConnection.id, { name: `Renamed Git ${suffix}`, expectedUpdatedAt: disabledWithImplicitSecret.updatedAt.toISOString() }, gitActor, db);
    assert.equal(renamedDisabled.status, "disabled");
    assert.equal(renamedDisabled.configurationVersion, disabledWithImplicitSecret.configurationVersion);
    const disabledNoOp = await updateGitConnection(gitConnection.id, { allowPrivateNetwork: false, expectedUpdatedAt: renamedDisabled.updatedAt.toISOString() }, gitActor, db);
    assert.equal(disabledNoOp.configurationVersion, renamedDisabled.configurationVersion);
    const disabledConfigurationChange = await updateGitConnection(gitConnection.id, { allowPrivateNetwork: true, expectedUpdatedAt: disabledNoOp.updatedAt.toISOString() }, gitActor, db);
    assert.equal(disabledConfigurationChange.configurationVersion, disabledNoOp.configurationVersion + 1);
    const reenabledGit = await updateGitConnection(gitConnection.id, { enabled: true, expectedUpdatedAt: disabledConfigurationChange.updatedAt.toISOString() }, gitActor, db);
    assert.equal(reenabledGit.status, "configured");
    const disabledForConfirmation = await updateGitConnection(gitConnection.id, { enabled: false, expectedUpdatedAt: reenabledGit.updatedAt.toISOString() }, gitActor, db);
    await assert.rejects(
      () => deleteGitConnection(gitConnection.id, { confirmationName: disabledForConfirmation.name, expectedUpdatedAt: new Date(0).toISOString() }, gitActor, db),
      (error: unknown) => error instanceof GitServiceError && error.code === "GIT_CONNECTION_CONFLICT",
    );
    await assert.rejects(
      () => deleteGitConnection(gitConnection.id, { confirmationName: "wrong name", expectedUpdatedAt: disabledForConfirmation.updatedAt.toISOString() }, gitActor, db),
      (error: unknown) => error instanceof GitServiceError && error.code === "GIT_CONNECTION_CONFIRMATION_MISMATCH",
    );
    await deleteGitConnection(gitConnection.id, { confirmationName: disabledForConfirmation.name, expectedUpdatedAt: disabledForConfirmation.updatedAt.toISOString() }, gitActor, db);
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
    const link = await db.projectGitRepositoryLink.create({
      data: {
        projectId,
        gitRepositoryId: repository.id,
        role: "primary",
        trackedRef: "main",
        createdById: userId,
      },
    });
    await db.projectGitRepositoryLink.update({
      where: { id: link.id },
      data: { status: "disabled", disabledAt: new Date() },
    });
    const disabledHistorical = await updateGitConnection(historicalConnection.id, { enabled: false, expectedUpdatedAt: historicalConnection.updatedAt.toISOString() }, gitActor, db);
    await assert.rejects(
      () => deleteGitConnection(historicalConnection.id, { confirmationName: historicalConnection.name, expectedUpdatedAt: disabledHistorical.updatedAt.toISOString() }, gitActor, db),
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
      () => updateMcpConnection(mcpConnection.id, { bearerToken: `cross-owner-${suffix}`, expectedUpdatedAt: mcpConnection.updatedAt.toISOString() }, otherActor, db),
      (error: unknown) => error instanceof McpCapabilityError && error.code === "MCP_CONNECTION_NOT_FOUND",
    );
    await assert.rejects(
      () => deleteMcpConnection(mcpConnection.id, { confirmationName: mcpConnection.name, expectedUpdatedAt: mcpConnection.updatedAt.toISOString() }, otherActor, db),
      (error: unknown) => error instanceof McpCapabilityError && error.code === "MCP_CONNECTION_NOT_FOUND",
    );
    await assert.rejects(
      () => discoverMcpConnectionTools(mcpConnection.id, { expectedUpdatedAt: mcpConnection.updatedAt.toISOString() }, otherActor, db),
      (error: unknown) => error instanceof McpCapabilityError && error.code === "MCP_CONNECTION_NOT_FOUND",
    );
  } finally {
    await db.project.deleteMany({ where: { id: projectId } });
    if (providerId !== null) await db.aiProviderConnection.deleteMany({ where: { id: providerId } });
    if (gitConnectionId !== null) await db.gitConnection.deleteMany({ where: { id: gitConnectionId } });
    if (historicalConnectionId !== null) {
      await db.gitRepository.deleteMany({ where: { gitConnectionId: historicalConnectionId } });
      await db.gitConnection.deleteMany({ where: { id: historicalConnectionId } });
    }
    if (mcpConnectionId !== null) await db.mcpConnection.deleteMany({ where: { id: mcpConnectionId } });
    const credentialIds = [providerCredentialId, gitCredentialId, historicalCredentialId, mcpCredentialId].filter((id): id is string => id !== null);
    if (credentialIds.length > 0) await db.externalCredential.deleteMany({ where: { id: { in: credentialIds } } });
    await db.appUser.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    if (previousKeyFile === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyFile;
    await rm(keyDirectory, { recursive: true, force: true });
  }
});
