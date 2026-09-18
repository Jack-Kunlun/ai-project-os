import "dotenv/config";

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createProviderConnection } from "../src/lib/ai-providers/service";
import { getDb } from "../src/lib/db";
import { grantProjectMembership, grantWorkspaceMembership } from "../src/lib/membership-governance";
import { createAndActivatePlatformProviderProbeBudget, runPlatformProviderProbe } from "../src/lib/platform-provider-probe-service";
import { assertSystemFailureInboxAdmin, listSystemFailureInbox } from "../src/lib/system-failure-inbox";

const shouldRun = process.env.SYSTEM_FAILURE_INBOX_POSTGRES_GATE === "1";
const ADMIN_ID = "00000000-0000-4000-8000-000000000010";
const NOW = new Date();
const RECENT = new Date(NOW.getTime() - 60 * 60 * 1_000);
const OLD = new Date(NOW.getTime() - 12 * 24 * 60 * 60 * 1_000);

function gateError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as { code?: unknown }).code === "SYSTEM_FAILURE_INBOX_ADMIN_REQUIRED";
}

function idempotencyKey(index: number): string {
  return `${String(index).padStart(8, "0")}${"a".repeat(56)}`;
}

after(async () => {
  if (shouldRun) await getDb().$disconnect();
});

test(
  "system failure inbox uses real PostgreSQL ownership, safe projection, current-state coverage and bounded sources",
  { skip: !shouldRun ? "SYSTEM_FAILURE_INBOX_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const nonAdminId = randomUUID();
    const businessOwnerId = randomUUID();
    const disabledAdminId = randomUUID();
    const workspaceId = randomUUID();
    const directProjectId = randomUUID();
    const inheritedProjectId = randomUUID();
    const privateProjectId = randomUUID();
    const archivedProjectId = randomUUID();
    const memoryJobId = randomUUID();
    const memoryIndexId = randomUUID();
    const pausedRuleId = randomUUID();
    const pausedRunId = randomUUID();
    const mcpActionId = randomUUID();
    const mcpAttemptId = randomUUID();
    const keyDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-system-failure-inbox-"));
    const previousKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    const previousFetch = globalThis.fetch;
    process.env.AI_PROJECT_OS_MASTER_KEY_FILE = join(keyDirectory, "master.key");

    try {
      await db.appUser.createMany({
        data: [
          { id: nonAdminId, username: `failure_inbox_user_${suffix}`, role: "user" },
          { id: businessOwnerId, username: `failure_inbox_owner_${suffix}`, role: "user" },
          { id: disabledAdminId, username: `failure_inbox_disabled_${suffix}`, role: "admin", disabledAt: NOW },
        ],
      });

      await assert.rejects(
        () => assertSystemFailureInboxAdmin({ id: nonAdminId, role: "user" }, db),
        gateError,
      );
      await assert.rejects(
        () => assertSystemFailureInboxAdmin({ id: disabledAdminId, role: "admin" }, db),
        gateError,
      );

      await db.$transaction(async (tx) => {
        await tx.workspace.create({ data: { id: workspaceId, name: `Failure inbox ${suffix}`, slug: `failure-inbox-${suffix}`, createdById: ADMIN_ID } });
        await grantWorkspaceMembership(tx, { workspaceId, userId: ADMIN_ID, role: "owner", actorId: ADMIN_ID, reason: "system_failure_inbox_gate_workspace_owner" });
        await grantWorkspaceMembership(tx, { workspaceId, userId: businessOwnerId, role: "admin", actorId: ADMIN_ID, reason: "system_failure_inbox_gate_business_owner" });
      });
      const directMembership = await db.$transaction(async (tx) => {
        await tx.project.createMany({
          data: [
            { id: directProjectId, workspaceId, name: `Direct ${suffix}`, slug: `failure-direct-${suffix}` },
            { id: inheritedProjectId, workspaceId, membershipInheritanceMode: "workspaceInherited", name: `Inherited ${suffix}`, slug: `failure-inherited-${suffix}` },
            { id: privateProjectId, workspaceId, name: `Private ${suffix}`, slug: `failure-private-${suffix}` },
            { id: archivedProjectId, workspaceId, name: `Archived ${suffix}`, slug: `failure-archived-${suffix}` },
          ],
        });
        const direct = await grantProjectMembership(tx, { projectId: directProjectId, workspaceId, userId: businessOwnerId, role: "owner", actorId: businessOwnerId, reason: "system_failure_inbox_gate_direct_business_owner" });
        await grantProjectMembership(tx, { projectId: directProjectId, workspaceId, userId: ADMIN_ID, role: "viewer", actorId: ADMIN_ID, reason: "system_failure_inbox_gate_direct_admin_relation" });
        await grantProjectMembership(tx, { projectId: archivedProjectId, workspaceId, userId: businessOwnerId, role: "owner", actorId: businessOwnerId, reason: "system_failure_inbox_gate_archived_business_owner" });
        await grantProjectMembership(tx, { projectId: archivedProjectId, workspaceId, userId: ADMIN_ID, role: "viewer", actorId: ADMIN_ID, reason: "system_failure_inbox_gate_archived_admin_relation" });
        await tx.project.update({ where: { id: archivedProjectId }, data: { archivedAt: NOW } });
        return direct;
      });

      const provider = await createProviderConnection({
        name: `Failure inbox provider ${suffix}`,
        kind: "openai",
        apiKey: `failure-inbox-platform-key-${suffix}`,
        generationModelId: "gpt-4.1-mini",
        embeddingModelId: null,
        embeddingDimensions: null,
        visionModelId: null,
      }, { id: ADMIN_ID, role: "admin", accountAccessVersion: 1 }, db);
      await createAndActivatePlatformProviderProbeBudget({
        unitLimit: 5,
        alertThresholdUnits: 1,
        startsAt: new Date(NOW.getTime() - 60_000).toISOString(),
        expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
      }, { id: ADMIN_ID, role: "admin", accountAccessVersion: 1 }, db);
      globalThis.fetch = async () => { throw new Error("injected transport failure"); };
      const held = await runPlatformProviderProbe(provider.id, { id: ADMIN_ID, role: "admin", accountAccessVersion: 1 }, { clientRequestKey: randomUUID(), expectedConfigurationVersion: provider.configurationVersion }, db);
      assert.equal(held.attempt.status, "held");

      const personalCredentialId = randomUUID();
      const personalProviderId = randomUUID();
      await db.externalCredential.create({
        data: {
          id: personalCredentialId,
          kind: "aiProvider",
          ciphertext: Buffer.from([1]),
          nonce: Buffer.from([2]),
          authTag: Buffer.from([3]),
          maskedSuffix: "gate",
          secretFingerprint: "b".repeat(64),
        },
      });
      await db.aiProviderConnection.create({
        data: {
          id: personalProviderId,
          name: `Personal BYOK ${suffix}`,
          kind: "openai",
          scope: "user",
          ownerUserId: nonAdminId,
          ownerAccountAccessVersion: 1,
          protocol: "chatCompletions",
          baseUrl: "https://api.openai.com/v1",
          credentialId: personalCredentialId,
          defaultGenerationModelId: "personal-model",
          status: "error",
          lastErrorCode: "PERSONAL_PROVIDER_FAILURE",
        },
      });

      await db.backgroundJob.create({
        data: {
          id: memoryJobId,
          projectId: privateProjectId,
          kind: "memoryIndex",
          status: "unknown",
          failureCode: "MEMORY_JOB_SHOULD_BE_DEDUPED",
          reconciliationRequired: true,
          requestedById: businessOwnerId,
          idempotencyKey: idempotencyKey(1),
          createdAt: OLD,
        },
      });
      await db.memoryIndexGeneration.create({
        data: {
          id: memoryIndexId,
          projectId: privateProjectId,
          jobId: memoryJobId,
          providerConnectionId: provider.id,
          modelId: "text-embedding-3-small",
          dimensions: 1536,
          status: "unknown",
          buildMode: "full",
          inputManifestFingerprint: "c".repeat(64),
          expectedEmbeddingRouteUpdatedAt: OLD,
          expectedEmbeddingRouteSource: "project_override",
          expectedEmbeddingProviderConfigurationVersion: provider.configurationVersion,
          expectedEmbeddingRouteFenceFingerprint: "a".repeat(64),
          expectedInputCount: 0,
          failureCode: "MEMORY_INDEX_UNKNOWN",
          reconciliationRequired: true,
          completedAt: OLD,
          createdAt: OLD,
        },
      });
      await db.memoryIndexGeneration.createMany({
        data: [
          { id: randomUUID(), projectId: directProjectId, providerConnectionId: provider.id, modelId: "text-embedding-3-small", dimensions: 1536, status: "unknown", buildMode: "full", inputManifestFingerprint: "d".repeat(64), expectedInputCount: 0, failureCode: "MEMORY_INDEX_UNKNOWN", reconciliationRequired: true, completedAt: OLD, createdAt: OLD },
          { id: randomUUID(), projectId: inheritedProjectId, providerConnectionId: provider.id, modelId: "text-embedding-3-small", dimensions: 1536, status: "unknown", buildMode: "full", inputManifestFingerprint: "e".repeat(64), expectedInputCount: 0, failureCode: "MEMORY_INDEX_UNKNOWN", reconciliationRequired: true, completedAt: OLD, createdAt: OLD },
          { id: randomUUID(), projectId: archivedProjectId, providerConnectionId: provider.id, modelId: "text-embedding-3-small", dimensions: 1536, status: "unknown", buildMode: "full", inputManifestFingerprint: "f".repeat(64), expectedInputCount: 0, failureCode: "MEMORY_INDEX_UNKNOWN", reconciliationRequired: true, completedAt: OLD, createdAt: OLD },
        ],
      });

      await db.automationRule.create({
        data: {
          id: pausedRuleId,
          projectId: directProjectId,
          name: `Paused rule ${suffix}`,
          kind: "memoryIndex",
          status: "paused",
          intervalMinutes: 60,
          config: { private: "not projected" },
          nextRunAt: OLD,
          lastRunAt: OLD,
          consecutiveFailures: 3,
          createdById: businessOwnerId,
          createdAt: OLD,
          updatedAt: OLD,
        },
      });
      await db.automationRun.create({
        data: {
          id: pausedRunId,
          automationRuleId: pausedRuleId,
          projectId: directProjectId,
          status: "failed",
          scheduledFor: RECENT,
          failureCode: "PAUSED_RUN_SHOULD_BE_DEDUPED",
          createdAt: RECENT,
          completedAt: RECENT,
        },
      });

      await db.$transaction(async (tx) => {
        // This is an isolated historical fixture. The production dispatch
        // trigger only permits the service's multi-step reservation protocol;
        // bypass it here to model the already-observed unknown attempt while
        // keeping the test read path on the real PostgreSQL schema.
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
        await tx.projectMcpAction.create({
          data: {
            id: mcpActionId,
            projectId: directProjectId,
            clientRequestId: randomUUID(),
            grantId: randomUUID(),
            delegationId: randomUUID(),
            toolDefinitionId: randomUUID(),
            attestationId: randomUUID(),
            connectionId: randomUUID(),
            toolName: "fixture.redacted",
            inputSchema: {},
            canonicalArguments: {},
            canonicalArgumentsHash: "1".repeat(64),
            actionFingerprint: "2".repeat(64),
            status: "dispatchReserved",
            stateVersion: 3,
            proposerProjectMembershipId: directMembership.id,
            proposerMembershipCreatedAt: directMembership.createdAt,
            lastActorId: businessOwnerId,
            lastActorProjectMembershipId: directMembership.id,
            lastActorMembershipCreatedAt: directMembership.createdAt,
            grantVersion: 1,
            delegationVersion: 1,
            attestationVersion: 1,
            delegationFingerprint: "3".repeat(64),
            definitionFingerprint: "4".repeat(64),
            networkFingerprint: "5".repeat(64),
            credentialFingerprint: "6".repeat(64),
            connectionConfigurationRevision: 1,
            connectionOwnerId: businessOwnerId,
            connectionOwnerAccountAccessVersion: 1,
            connectionOwnershipState: "confirmed",
            connectionAllowPrivateNetwork: false,
            connectionUpdatedAt: OLD,
            credentialUpdatedAt: OLD,
            createdAt: OLD,
            transitionAt: OLD,
          },
        });
        await tx.projectMcpActionDispatchAttempt.create({
          data: {
            id: mcpAttemptId,
            projectId: directProjectId,
            actionId: mcpActionId,
            actorKind: "owner",
            actorId: businessOwnerId,
            actorProjectMembershipId: directMembership.id,
            actorMembershipCreatedAt: directMembership.createdAt,
            rpcRequestId: randomUUID(),
            reservationTokenHash: "7".repeat(64),
            status: "unknown",
            actionFingerprint: "2".repeat(64),
            definitionFingerprint: "4".repeat(64),
            networkFingerprint: "5".repeat(64),
            credentialFingerprint: "6".repeat(64),
            connectionConfigurationRevision: 1,
            connectionOwnerId: businessOwnerId,
            connectionOwnerAccountAccessVersion: 1,
            reservationTransactionId: BigInt(1),
            reservationExpiresAt: new Date(NOW.getTime() + 60_000),
            reservedAt: OLD,
            createdAt: OLD,
            safeErrorCode: "MCP_UNKNOWN",
          },
        });
      });

      await db.backgroundJob.createMany({
        data: Array.from({ length: 100 }, (_, index) => ({
          id: randomUUID(),
          projectId: privateProjectId,
          kind: "autoExtract" as const,
          status: "unknown" as const,
          reconciliationRequired: true,
          requestedById: businessOwnerId,
          idempotencyKey: idempotencyKey(index + 10),
          createdAt: OLD,
        })),
      });
      await db.backgroundJob.create({
        data: {
          id: randomUUID(),
          projectId: privateProjectId,
          kind: "autoExtract",
          status: "failed",
          failureCode: "RECENT_AFTER_CURRENT_LIMIT",
          reconciliationRequired: false,
          requestedById: businessOwnerId,
          idempotencyKey: idempotencyKey(999),
          createdAt: OLD,
          completedAt: RECENT,
        },
      });

      const result = await listSystemFailureInbox(ADMIN_ID, { pageSize: 50 }, db, { now: NOW, cursorKey: new Uint8Array(32).fill(9) });
      assert.equal(result.entries.filter((entry) => entry.source === "providerHeld").length, 1);
      assert.equal(result.entries.some((entry) => entry.safeErrorCode === "MEMORY_JOB_SHOULD_BE_DEDUPED"), false);
      assert.equal(result.entries.some((entry) => entry.safeErrorCode === "PAUSED_RUN_SHOULD_BE_DEDUPED"), false);
      const pausedRule = result.entries.find((entry) => entry.safeErrorCode === "AUTOMATION_RULE_PAUSED");
      assert.equal(pausedRule?.lifecycle, "requires_owner_review");
      assert.equal(pausedRule?.destination, null);
      assert.equal(result.entries.some((entry) => entry.safeErrorCode === "RECENT_AFTER_CURRENT_LIMIT"), true);
      assert.deepEqual(result.partialSources, ["workerBackgroundJob"]);

      assert.equal(result.entries.filter((entry) => entry.source === "indexGeneration").every((entry) => entry.destination === null), true);
      assert.equal(result.entries.find((entry) => entry.safeErrorCode === "MCP_UNKNOWN")?.destination, null);
      assert.equal(JSON.stringify(result).includes("/projects/"), false);
      assert.equal(JSON.stringify(result).includes(directProjectId), false);
      assert.equal(JSON.stringify(result).includes(inheritedProjectId), false);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
      else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyPath;
      await rm(keyDirectory, { recursive: true, force: true });
    }
  },
);
