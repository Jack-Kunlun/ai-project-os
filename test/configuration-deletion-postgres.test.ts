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
  GitServiceError,
  updateGitConnection,
} from "../src/lib/git";

const shouldRun = process.env.CONFIGURATION_DELETION_POSTGRES_GATE === "1";

test("unused model and Git connections can be permanently deleted while historical Git links stay protected", {
  skip: !shouldRun ? "CONFIGURATION_DELETION_POSTGRES_GATE=1 is required" : false,
}, async () => {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const userId = randomUUID();
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

  await db.appUser.create({ data: { id: userId, username: `configuration_delete_${suffix}`, role: "admin" } });
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
    }, db);
    providerId = provider.id;
    providerCredentialId = (await db.aiProviderConnection.findUniqueOrThrow({ where: { id: provider.id }, select: { credentialId: true } })).credentialId;
    await assert.rejects(
      () => deleteProviderConnection(provider.id, { confirmationName: provider.name }, db),
      (error: unknown) => error instanceof ProviderServiceError && error.code === "AI_PROVIDER_DELETE_REQUIRES_DISABLED",
    );
    await updateProviderConnection(provider.id, { enabled: false }, db);
    await assert.rejects(
      () => deleteProviderConnection(provider.id, { confirmationName: "wrong name" }, db),
      (error: unknown) => error instanceof ProviderServiceError && error.code === "AI_PROVIDER_CONFIRMATION_MISMATCH",
    );
    await deleteProviderConnection(provider.id, { confirmationName: provider.name }, db);
    assert.equal(await db.aiProviderConnection.count({ where: { id: provider.id } }), 0);
    assert.equal(await db.externalCredential.count({ where: { id: providerCredentialId } }), 0);
    providerId = null;
    providerCredentialId = null;

    const gitConnection = await createGitConnection({
      name: `Disposable Git ${suffix}`,
      providerKind: "github",
      transport: "https",
      baseUrl: "https://github.com",
      authKind: "token",
      secret: `github-test-${suffix}`,
      allowPrivateNetwork: false,
    }, { id: userId }, db);
    gitConnectionId = gitConnection.id;
    gitCredentialId = (await db.gitConnection.findUniqueOrThrow({ where: { id: gitConnection.id }, select: { credentialId: true } })).credentialId;
    await assert.rejects(
      () => deleteGitConnection(gitConnection.id, { confirmationName: gitConnection.name }, db),
      (error: unknown) => error instanceof GitServiceError && error.code === "GIT_CONNECTION_DELETE_REQUIRES_DISABLED",
    );
    await updateGitConnection(gitConnection.id, { enabled: false }, db);
    await assert.rejects(
      () => deleteGitConnection(gitConnection.id, { confirmationName: "wrong name" }, db),
      (error: unknown) => error instanceof GitServiceError && error.code === "GIT_CONNECTION_CONFIRMATION_MISMATCH",
    );
    await deleteGitConnection(gitConnection.id, { confirmationName: gitConnection.name }, db);
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
    }, { id: userId }, db);
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
    await updateGitConnection(historicalConnection.id, { enabled: false }, db);
    await assert.rejects(
      () => deleteGitConnection(historicalConnection.id, { confirmationName: historicalConnection.name }, db),
      (error: unknown) => error instanceof GitServiceError && error.code === "GIT_CONNECTION_IN_USE",
    );
  } finally {
    await db.project.deleteMany({ where: { id: projectId } });
    if (providerId !== null) await db.aiProviderConnection.deleteMany({ where: { id: providerId } });
    if (gitConnectionId !== null) await db.gitConnection.deleteMany({ where: { id: gitConnectionId } });
    if (historicalConnectionId !== null) {
      await db.gitRepository.deleteMany({ where: { gitConnectionId: historicalConnectionId } });
      await db.gitConnection.deleteMany({ where: { id: historicalConnectionId } });
    }
    const credentialIds = [providerCredentialId, gitCredentialId, historicalCredentialId].filter((id): id is string => id !== null);
    if (credentialIds.length > 0) await db.externalCredential.deleteMany({ where: { id: { in: credentialIds } } });
    await db.appUser.deleteMany({ where: { id: userId } });
    if (previousKeyFile === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyFile;
    await rm(keyDirectory, { recursive: true, force: true });
  }
});
