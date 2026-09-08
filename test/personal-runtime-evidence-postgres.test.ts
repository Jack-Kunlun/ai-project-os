import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { getDb } from "../src/lib/db";
import { grantProjectMembership, grantWorkspaceMembership, revokeProjectMembership } from "../src/lib/membership-governance";
import {
  confirmProjectAiProviderDelegationOwner,
  confirmProjectAiProviderDelegationProject,
  proposeProjectAiProviderDelegation,
  putProjectAiEffectiveRouteSelection,
  revokeProjectAiProviderDelegation,
} from "../src/lib/project-ai-provider-delegation-service";
import { deleteArchivedProject, updateProjectLifecycle } from "../src/lib/project-lifecycle";
import { WEB_AI_TRANSFER_CONSENT_VERSION } from "../src/lib/web-ai-contract";
import { createControlledMembership, revokeControlledMembershipInTransaction } from "./membership-fixture";

const shouldRun = process.env.PERSONAL_RUNTIME_EVIDENCE_POSTGRES_GATE === "1";
const testDatabaseName = "ai_project_os_personal_runtime_evidence_test";
const workspaceId = "00000000-0000-4000-8000-000000000001";
const seededAdminId = "00000000-0000-4000-8000-000000000010";

function assertDisposableGateDatabase(): void {
  const configuredUrl = process.env.DATABASE_URL;
  if (typeof configuredUrl !== "string" || configuredUrl.length === 0) {
    throw new Error("PERSONAL_RUNTIME_EVIDENCE_TEST_DATABASE_URL_REQUIRED");
  }
  const parsed = new URL(configuredUrl);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== `/${testDatabaseName}`
    || parsed.username !== "ai_project_os_gate"
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== ""
  ) throw new Error("PERSONAL_RUNTIME_EVIDENCE_TEST_DATABASE_URL_INVALID");
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined;
    const code = "code" in error ? (error as Error & { code?: unknown }).code : undefined;
    return `${error.name} ${error.message} ${code === undefined ? "" : String(code)} ${cause === undefined ? "" : errorText(cause)}`;
  }
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    return [record.message, record.code, record.originalMessage, record.originalCode, record.cause].filter((value) => value !== undefined).map(errorText).join(" ");
  }
  return String(error);
}

test(
  "personal runtime evidence is structurally complete, relationally fenced, and remains non-platform",
  { skip: !shouldRun ? "PERSONAL_RUNTIME_EVIDENCE_POSTGRES_GATE=1 is required" : false },
  async () => {
    assertDisposableGateDatabase();
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const ownerId = randomUUID();
    const projectOwnerId = randomUUID();
    const projectId = randomUUID();
    const providerId = randomUUID();
    const alternateProviderId = randomUUID();
    const credentialId = randomUUID();
    const alternateCredentialId = randomUUID();
    const fingerprint = "a".repeat(64);
    const delegationExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);

    try {
      await db.appUser.createMany({
        data: [
          { id: ownerId, username: `personal_runtime_owner_${suffix}`, role: "user" },
          { id: projectOwnerId, username: `personal_runtime_project_owner_${suffix}`, role: "user" },
        ],
      });
      const subscription = await createControlledMembership(db, {
        adminId: seededAdminId,
        userId: ownerId,
        startsAt: new Date(Date.now() - 60_000),
        expiresAt: delegationExpiresAt,
        grantedById: seededAdminId,
      });
      await db.project.create({
        data: { id: projectId, workspaceId, name: `Personal runtime ${suffix}`, slug: `personal-runtime-${suffix}` },
      });
      await db.$transaction(async (tx) => {
        await grantWorkspaceMembership(tx, { workspaceId, userId: ownerId, role: "member", actorId: seededAdminId, reason: "personal_runtime_owner" });
        await grantWorkspaceMembership(tx, { workspaceId, userId: projectOwnerId, role: "member", actorId: seededAdminId, reason: "personal_runtime_project_owner" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: ownerId, role: "editor", actorId: seededAdminId, reason: "personal_runtime_owner" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: projectOwnerId, role: "owner", actorId: seededAdminId, reason: "personal_runtime_project_owner" });
      });
      await db.externalCredential.create({
        data: {
          id: credentialId,
          kind: "aiProvider",
          ciphertext: Buffer.from([1]),
          nonce: Buffer.from([2]),
          authTag: Buffer.from([3]),
          maskedSuffix: "gate",
          secretFingerprint: fingerprint,
        },
      });
      await db.externalCredential.create({
        data: {
          id: alternateCredentialId,
          kind: "aiProvider",
          ciphertext: Buffer.from([4]),
          nonce: Buffer.from([5]),
          authTag: Buffer.from([6]),
          maskedSuffix: "alternate",
          secretFingerprint: "b".repeat(64),
        },
      });
      await db.aiProviderConnection.create({
        data: {
          id: providerId,
          name: `Personal runtime provider ${suffix}`,
          kind: "openai",
          scope: "user",
          ownerUserId: ownerId,
          ownershipState: "confirmed",
          protocol: "chatCompletions",
          baseUrl: "https://api.openai.com/v1",
          credentialId,
          defaultGenerationModelId: "gpt-4.1-mini",
          defaultEmbeddingModelId: "text-embedding-3-small",
          embeddingDimensions: 1536,
          status: "verified",
          lastTestedAt: new Date(),
        },
      });
      await db.aiProviderConnection.create({
        data: {
          id: alternateProviderId,
          name: `Alternate personal runtime provider ${suffix}`,
          kind: "openai",
          scope: "user",
          ownerUserId: ownerId,
          ownershipState: "confirmed",
          protocol: "chatCompletions",
          baseUrl: "https://api.openai.com/v1",
          credentialId: alternateCredentialId,
          defaultGenerationModelId: "gpt-4.1-mini",
          defaultEmbeddingModelId: "text-embedding-3-small",
          embeddingDimensions: 1536,
          status: "verified",
          lastTestedAt: new Date(),
        },
      });

      const proposal = await proposeProjectAiProviderDelegation(
        projectId,
        { providerConnectionId: providerId, operation: "autoExtract", expiresAt: delegationExpiresAt.toISOString() },
        { id: ownerId, role: "user" },
        db,
      );
      const ownerConfirmed = await confirmProjectAiProviderDelegationOwner(
        projectId,
        proposal.id,
        { expectedVersion: proposal.version, acknowledgeProviderCharges: true },
        { id: ownerId, role: "user" },
        db,
      );
      const active = await confirmProjectAiProviderDelegationProject(
        projectId,
        proposal.id,
        { expectedVersion: ownerConfirmed.version, acknowledgeDataEgress: true, acknowledgeIndexImpact: true },
        { id: projectOwnerId, role: "user" },
        db,
      );
      const selection = await putProjectAiEffectiveRouteSelection(
        projectId,
        "autoExtract",
        { source: "personalDelegation", delegationId: proposal.id, expectedVersion: null },
        { id: projectOwnerId, role: "user" },
        db,
      );
      assert.equal(active.status, "active");
      assert.equal(selection.source, "personalDelegation");

      const selected = await db.projectAiEffectiveRouteSelection.findUniqueOrThrow({ where: { id: selection.id } });
      const delegation = await db.projectAiProviderDelegation.findUniqueOrThrow({ where: { id: proposal.id } });
      const ownerMembership = await db.projectMembership.findUniqueOrThrow({ where: { id: delegation.ownerProjectMembershipId } });
      const projectOwnerMembership = await db.projectMembership.findUniqueOrThrow({ where: { id: delegation.projectConfirmedProjectMembershipId! } });
      const grantBase = {
        projectId,
        operation: "autoExtract" as const,
        scopeKind: "query" as const,
        scopeIds: { projectId },
        manifestFingerprint: "c".repeat(64),
        providerConnectionId: providerId,
        modelId: delegation.modelId,
        consentVersion: WEB_AI_TRANSFER_CONSENT_VERSION,
        issuedById: ownerId,
        billingMode: "byok" as const,
        billingUserId: ownerId,
        routeSource: "personal_delegation",
        routeId: selected.id,
        routeVersion: selected.version,
        routeUpdatedAt: selected.updatedAt,
        providerConfigurationVersion: delegation.providerConfigurationVersion,
        quotaMultiplierBps: 10_000,
        routeFenceFingerprint: "d".repeat(64),
        personalDelegationId: delegation.id,
        personalDelegationVersion: delegation.version,
        personalDelegationFingerprint: delegation.delegationFingerprint,
        effectiveRouteSelectionId: selected.id,
        effectiveRouteSelectionVersion: selected.version,
        effectiveRouteSelectionUpdatedAt: selected.updatedAt,
        payerKind: "personalConnectionOwner" as const,
        payerProviderConnectionId: providerId,
        ownerProjectMembershipId: ownerMembership.id,
        ownerMembershipCreatedAt: ownerMembership.createdAt,
        ownerSubscriptionId: subscription.id,
        ownerSubscriptionVersion: subscription.version,
        ownerSubscriptionStartsAt: subscription.startsAt,
        ownerSubscriptionExpiresAt: subscription.expiresAt,
        projectConfirmedById: projectOwnerId,
        projectConfirmedProjectMembershipId: projectOwnerMembership.id,
        projectConfirmedMembershipCreatedAt: projectOwnerMembership.createdAt,
        selectedById: projectOwnerId,
        selectedByProjectMembershipId: selected.selectedByProjectMembershipId,
        selectedByMembershipCreatedAt: selected.selectedByMembershipCreatedAt,
        credentialSecretFingerprint: fingerprint,
        embeddingDimensions: null,
        maxOutputTokens: delegation.maxOutputTokens,
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      };

      const job = await db.backgroundJob.create({
        data: {
          id: randomUUID(),
          projectId,
          kind: "projectBrief",
          requestedById: ownerId,
          idempotencyKey: "e".repeat(64),
        },
      });
      const grant = await db.webAiGrant.create({ data: { id: randomUUID(), callKey: `personal-runtime-${suffix}`, boundJobId: job.id, ...grantBase } });
      assert.equal(grant.payerKind, "personalConnectionOwner");
      assert.equal(grant.billingMode, "byok");

      const insertInvalidGrant = async (overrides: Record<string, unknown>, label: string) => {
        const invalidJobId = randomUUID();
        await db.backgroundJob.create({ data: { id: invalidJobId, projectId, kind: "projectBrief", requestedById: ownerId, idempotencyKey: `${label}-${suffix}-${randomUUID()}`.slice(0, 64) } });
        await assert.rejects(
          () => db.$transaction(async (tx) => {
            await tx.webAiGrant.create({ data: { id: randomUUID(), callKey: `${label}-${suffix}`, boundJobId: invalidJobId, ...grantBase, ...overrides } });
          }),
          (error: unknown) => errorText(error).includes("PERSONAL_RUNTIME_EVIDENCE_INVALID") || errorText(error).includes("WebAiGrant_route_snapshot_check"),
          label,
        );
      };
      await insertInvalidGrant({ personalDelegationFingerprint: null }, "missing-fingerprint");
      await insertInvalidGrant({ payerKind: "platformCaller" }, "wrong-payer");
      await insertInvalidGrant({ effectiveRouteSelectionId: randomUUID() }, "wrong-selection");
      await insertInvalidGrant({ ownerSubscriptionId: randomUUID() }, "wrong-subscription");
      await insertInvalidGrant({ selectedById: randomUUID() }, "wrong-selected-by");
      await insertInvalidGrant({ modelId: "gpt-4o-mini" }, "wrong-model");
      await insertInvalidGrant({ maxOutputTokens: 1 }, "wrong-max-output");

      const personalAuditBase = {
        jobId: job.id,
        webAiGrantId: grant.id,
        webAiGrantReferenceId: grant.id,
        webAiGrantProjectId: projectId,
        providerConnectionId: providerId,
        operation: grant.operation,
        modelId: grant.modelId,
        billingMode: grant.billingMode,
        billingUserId: grant.billingUserId,
        routeSource: grant.routeSource,
        routeId: grant.routeId,
        routeVersion: grant.routeVersion,
        routeUpdatedAt: grant.routeUpdatedAt,
        providerConfigurationVersion: grant.providerConfigurationVersion,
        quotaMultiplierBps: grant.quotaMultiplierBps,
        routeFenceFingerprint: grant.routeFenceFingerprint,
        credentialSecretFingerprint: grant.credentialSecretFingerprint,
        personalDelegationId: grant.personalDelegationId,
        personalDelegationVersion: grant.personalDelegationVersion,
        personalDelegationFingerprint: grant.personalDelegationFingerprint,
        effectiveRouteSelectionId: grant.effectiveRouteSelectionId,
        effectiveRouteSelectionVersion: grant.effectiveRouteSelectionVersion,
        effectiveRouteSelectionUpdatedAt: grant.effectiveRouteSelectionUpdatedAt,
        payerKind: grant.payerKind,
        payerProviderConnectionId: grant.payerProviderConnectionId,
        ownerProjectMembershipId: grant.ownerProjectMembershipId,
        ownerMembershipCreatedAt: grant.ownerMembershipCreatedAt,
        ownerSubscriptionId: grant.ownerSubscriptionId,
        ownerSubscriptionVersion: grant.ownerSubscriptionVersion,
        ownerSubscriptionStartsAt: grant.ownerSubscriptionStartsAt,
        ownerSubscriptionExpiresAt: grant.ownerSubscriptionExpiresAt,
        projectConfirmedById: grant.projectConfirmedById,
        projectConfirmedProjectMembershipId: grant.projectConfirmedProjectMembershipId,
        projectConfirmedMembershipCreatedAt: grant.projectConfirmedMembershipCreatedAt,
        selectedById: grant.selectedById,
        selectedByProjectMembershipId: grant.selectedByProjectMembershipId,
        selectedByMembershipCreatedAt: grant.selectedByMembershipCreatedAt,
        embeddingDimensions: grant.embeddingDimensions,
        maxOutputTokens: grant.maxOutputTokens,
        reservationId: null,
        status: "running",
      } as const;
      const personalAudit = await db.providerCallAudit.create({
        data: { ...personalAuditBase, callKey: `personal-audit-${suffix}` },
      });
      assert.equal(personalAudit.webAiGrantId, grant.id);
      await assert.rejects(
        () => db.providerCallAudit.create({
          data: { ...personalAuditBase, callKey: `personal-audit-invalid-${suffix}`, payerKind: "platformCaller" },
        }),
        (error: unknown) => errorText(error).includes("PERSONAL_RUNTIME_EVIDENCE_INVALID") || errorText(error).includes("ProviderCallAudit_runtime_binding_check"),
        "personal audit payer mismatch",
      );

      const memoryJob = await db.backgroundJob.create({
        data: { id: randomUUID(), projectId, kind: "memoryIndex", requestedById: ownerId, idempotencyKey: `memory-${suffix}-${randomUUID()}`.slice(0, 64) },
      });
      await assert.rejects(
        () => db.memoryIndexGeneration.create({
          data: {
            id: randomUUID(),
            projectId,
            jobId: memoryJob.id,
            providerConnectionId: providerId,
            modelId: grant.modelId,
            dimensions: 1536,
            status: "staging",
            buildMode: "full",
            inputManifestFingerprint: "f".repeat(64),
            expectedEmbeddingRouteSource: "personal_delegation",
            expectedEmbeddingRouteId: selected.id,
            expectedEmbeddingRouteVersion: selected.version,
            expectedEmbeddingRouteUpdatedAt: selected.updatedAt,
            expectedEmbeddingProviderConfigurationVersion: delegation.providerConfigurationVersion,
            expectedEmbeddingRouteFenceFingerprint: grant.routeFenceFingerprint,
            embeddingWebAiGrantId: grant.id,
          },
        }),
        (error: unknown) => errorText(error).includes("PERSONAL_MEMORY_INDEX_EVIDENCE_INVALID"),
        "personal memory grant operation mismatch",
      );
      const missingMemoryJob = await db.backgroundJob.create({
        data: { id: randomUUID(), projectId, kind: "memoryIndex", requestedById: ownerId, idempotencyKey: `memory-missing-${suffix}-${randomUUID()}`.slice(0, 64) },
      });
      await assert.rejects(
        () => db.memoryIndexGeneration.create({
          data: {
            id: randomUUID(),
            projectId,
            jobId: missingMemoryJob.id,
            providerConnectionId: providerId,
            modelId: grant.modelId,
            dimensions: 1536,
            status: "staging",
            buildMode: "full",
            inputManifestFingerprint: "e".repeat(64),
            expectedEmbeddingRouteSource: "personal_delegation",
            expectedEmbeddingRouteId: selected.id,
            expectedEmbeddingRouteVersion: selected.version,
            expectedEmbeddingRouteUpdatedAt: selected.updatedAt,
            expectedEmbeddingProviderConfigurationVersion: delegation.providerConfigurationVersion,
            expectedEmbeddingRouteFenceFingerprint: grant.routeFenceFingerprint,
            embeddingWebAiGrantId: null,
          },
        }),
        (error: unknown) => errorText(error).includes("MemoryIndexGeneration_embedding_route_snapshot_check") || errorText(error).includes("new job-backed memory index generation requires a complete route snapshot"),
        "personal memory grant evidence missing",
      );

      const persisted = await db.webAiGrant.findUniqueOrThrow({ where: { id: grant.id } });
      assert.equal(persisted.personalDelegationId, delegation.id);
      assert.equal(persisted.effectiveRouteSelectionId, selected.id);
      assert.equal(persisted.routeSource, "personal_delegation");

      // A valid personal embedding generation may need to be terminalized
      // after admission when the grant is revoked.  The INSERT path still
      // requires the complete live tuple, while UPDATE only freezes that
      // tuple so failure/unknown evidence remains durable after revocation.
      const embeddingProposal = await proposeProjectAiProviderDelegation(
        projectId,
        { providerConnectionId: providerId, operation: "embedding", expiresAt: delegationExpiresAt.toISOString() },
        { id: ownerId, role: "user" },
        db,
      );
      const embeddingOwnerConfirmed = await confirmProjectAiProviderDelegationOwner(
        projectId,
        embeddingProposal.id,
        { expectedVersion: embeddingProposal.version, acknowledgeProviderCharges: true },
        { id: ownerId, role: "user" },
        db,
      );
      await confirmProjectAiProviderDelegationProject(
        projectId,
        embeddingProposal.id,
        { expectedVersion: embeddingOwnerConfirmed.version, acknowledgeDataEgress: true, acknowledgeIndexImpact: true },
        { id: projectOwnerId, role: "user" },
        db,
      );
      const embeddingSelection = await putProjectAiEffectiveRouteSelection(
        projectId,
        "embedding",
        { source: "personalDelegation", delegationId: embeddingProposal.id, expectedVersion: null },
        { id: projectOwnerId, role: "user" },
        db,
      );
      const persistedEmbeddingSelection = await db.projectAiEffectiveRouteSelection.findUniqueOrThrow({ where: { id: embeddingSelection.id } });
      const embeddingDelegation = await db.projectAiProviderDelegation.findUniqueOrThrow({ where: { id: embeddingProposal.id } });
      const embeddingJob = await db.backgroundJob.create({
        data: {
          id: randomUUID(),
          projectId,
          kind: "memoryIndex",
          requestedById: ownerId,
          idempotencyKey: `memory-valid-${suffix}-${randomUUID()}`.slice(0, 64),
        },
      });
      const embeddingGrant = await db.webAiGrant.create({
        data: {
          id: randomUUID(),
          callKey: `personal-embedding-${suffix}`,
          boundJobId: embeddingJob.id,
          projectId,
          operation: "embedding",
          scopeKind: "query",
          scopeIds: { projectId },
          manifestFingerprint: "b".repeat(64),
          providerConnectionId: providerId,
          modelId: embeddingDelegation.modelId,
          consentVersion: WEB_AI_TRANSFER_CONSENT_VERSION,
          issuedById: ownerId,
          billingMode: "byok",
          billingUserId: ownerId,
          routeSource: "personal_delegation",
          routeId: embeddingSelection.id,
          routeVersion: embeddingSelection.version,
          routeUpdatedAt: embeddingSelection.updatedAt,
          providerConfigurationVersion: embeddingDelegation.providerConfigurationVersion,
          quotaMultiplierBps: 10_000,
          routeFenceFingerprint: "e".repeat(64),
          personalDelegationId: embeddingDelegation.id,
          personalDelegationVersion: embeddingDelegation.version,
          personalDelegationFingerprint: embeddingDelegation.delegationFingerprint,
          effectiveRouteSelectionId: embeddingSelection.id,
          effectiveRouteSelectionVersion: embeddingSelection.version,
          effectiveRouteSelectionUpdatedAt: embeddingSelection.updatedAt,
          payerKind: "personalConnectionOwner",
          payerProviderConnectionId: providerId,
          ownerProjectMembershipId: ownerMembership.id,
          ownerMembershipCreatedAt: ownerMembership.createdAt,
          ownerSubscriptionId: subscription.id,
          ownerSubscriptionVersion: subscription.version,
          ownerSubscriptionStartsAt: subscription.startsAt,
          ownerSubscriptionExpiresAt: subscription.expiresAt,
          projectConfirmedById: projectOwnerId,
          projectConfirmedProjectMembershipId: projectOwnerMembership.id,
          projectConfirmedMembershipCreatedAt: projectOwnerMembership.createdAt,
          selectedById: projectOwnerId,
          selectedByProjectMembershipId: persistedEmbeddingSelection.selectedByProjectMembershipId,
          selectedByMembershipCreatedAt: persistedEmbeddingSelection.selectedByMembershipCreatedAt,
          credentialSecretFingerprint: fingerprint,
          embeddingDimensions: embeddingDelegation.embeddingDimensions,
          maxOutputTokens: null,
          expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
        },
      });
      const createInvalidEmbeddingGeneration = async (label: string, overrides: Record<string, unknown> = {}) => {
        const candidateJob = await db.backgroundJob.create({
          data: {
            id: randomUUID(),
            projectId,
            kind: "memoryIndex",
            requestedById: ownerId,
            idempotencyKey: `memory-invalid-${label}-${suffix}-${randomUUID()}`.slice(0, 64),
          },
        });
        await assert.rejects(
          () => db.memoryIndexGeneration.create({
            data: {
              id: randomUUID(),
              projectId,
              jobId: candidateJob.id,
              providerConnectionId: providerId,
              modelId: embeddingGrant.modelId,
              dimensions: embeddingGrant.embeddingDimensions!,
              status: "staging",
              buildMode: "full",
              inputManifestFingerprint: "a".repeat(64),
              expectedEmbeddingRouteSource: "personal_delegation",
              expectedEmbeddingRouteId: embeddingSelection.id,
              expectedEmbeddingRouteVersion: embeddingSelection.version,
              expectedEmbeddingRouteUpdatedAt: embeddingSelection.updatedAt,
              expectedEmbeddingProviderConfigurationVersion: embeddingDelegation.providerConfigurationVersion,
              expectedEmbeddingRouteFenceFingerprint: embeddingGrant.routeFenceFingerprint,
              embeddingWebAiGrantId: embeddingGrant.id,
              ...overrides,
            } as never,
          }),
          (error: unknown) => errorText(error).includes("PERSONAL_MEMORY_INDEX_EVIDENCE_INVALID"),
          `personal memory ${label} evidence mismatch`,
        );
        return candidateJob;
      };
      const wrongJob = await db.backgroundJob.create({
        data: {
          id: randomUUID(),
          projectId,
          kind: "memoryIndex",
          requestedById: ownerId,
          idempotencyKey: `memory-wrong-job-${suffix}-${randomUUID()}`.slice(0, 64),
        },
      });
      await createInvalidEmbeddingGeneration("wrong-job", { jobId: wrongJob.id });
      await createInvalidEmbeddingGeneration("wrong-provider", { providerConnectionId: alternateProviderId });
      await createInvalidEmbeddingGeneration("wrong-model", { modelId: "text-embedding-3-large" });
      await createInvalidEmbeddingGeneration("wrong-config", {
        expectedEmbeddingProviderConfigurationVersion: embeddingDelegation.providerConfigurationVersion + 1,
      });
      const validGeneration = await db.memoryIndexGeneration.create({
        data: {
          id: randomUUID(),
          projectId,
          jobId: embeddingJob.id,
          providerConnectionId: providerId,
          modelId: embeddingGrant.modelId,
          dimensions: embeddingGrant.embeddingDimensions!,
          status: "building",
          buildMode: "full",
          inputManifestFingerprint: "9".repeat(64),
          expectedEmbeddingRouteSource: "personal_delegation",
          expectedEmbeddingRouteId: embeddingSelection.id,
          expectedEmbeddingRouteVersion: embeddingSelection.version,
          expectedEmbeddingRouteUpdatedAt: embeddingSelection.updatedAt,
          expectedEmbeddingProviderConfigurationVersion: embeddingDelegation.providerConfigurationVersion,
          expectedEmbeddingRouteFenceFingerprint: embeddingGrant.routeFenceFingerprint,
          embeddingWebAiGrantId: embeddingGrant.id,
        },
      });
      await assert.rejects(
        () => db.webAiGrant.delete({ where: { id: embeddingGrant.id } }),
        (error: unknown) => errorText(error).includes("PERSONAL_MEMORY_INDEX_EVIDENCE_INVALID"),
        "direct personal grant delete cannot orphan an embedding generation",
      );
      await assert.rejects(
        () => db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
          await tx.webAiGrant.update({ where: { id: embeddingGrant.id }, data: { revokedAt: new Date() } });
        }),
        (error: unknown) => errorText(error).includes("PERSONAL_MEMORY_INDEX_EVIDENCE_INVALIDATION_REQUIRED"),
        "grant revoke after immediate constraint evaluation cannot leave a building generation stale",
      );
      assert.equal((await db.webAiGrant.findUniqueOrThrow({ where: { id: embeddingGrant.id } })).revokedAt, null);
      const terminalizedGeneration = await db.$transaction(async (tx) => {
        const generation = await tx.memoryIndexGeneration.update({
          where: { id: validGeneration.id },
          data: { status: "failed", failureCode: "PERSONAL_GRANT_REVOKED", completedAt: new Date() },
        });
        await tx.webAiGrant.update({ where: { id: embeddingGrant.id }, data: { revokedAt: new Date() } });
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        return generation;
      });
      assert.equal(terminalizedGeneration.status, "failed");
      assert.equal(terminalizedGeneration.embeddingWebAiGrantId, embeddingGrant.id);
      await createInvalidEmbeddingGeneration("revoked-grant");

      const completeCandidateJob = await db.backgroundJob.create({
        data: {
          id: randomUUID(),
          projectId,
          kind: "memoryIndex",
          requestedById: ownerId,
          idempotencyKey: `memory-complete-pointer-${suffix}-${randomUUID()}`.slice(0, 64),
        },
      });
      const completeCandidateGrant = await db.webAiGrant.create({
        data: {
          ...embeddingGrant,
          id: randomUUID(),
          callKey: `personal-complete-pointer-${suffix}`,
          boundJobId: completeCandidateJob.id,
          revokedAt: null,
        } as never,
      });
      const completeCandidateGeneration = await db.memoryIndexGeneration.create({
        data: {
          id: randomUUID(),
          projectId,
          jobId: completeCandidateJob.id,
          providerConnectionId: providerId,
          modelId: completeCandidateGrant.modelId,
          dimensions: completeCandidateGrant.embeddingDimensions!,
          status: "building",
          buildMode: "full",
          inputManifestFingerprint: "7".repeat(64),
          expectedEmbeddingRouteSource: "personal_delegation",
          expectedEmbeddingRouteId: embeddingSelection.id,
          expectedEmbeddingRouteVersion: embeddingSelection.version,
          expectedEmbeddingRouteUpdatedAt: embeddingSelection.updatedAt,
          expectedEmbeddingProviderConfigurationVersion: embeddingDelegation.providerConfigurationVersion,
          expectedEmbeddingRouteFenceFingerprint: completeCandidateGrant.routeFenceFingerprint,
          embeddingWebAiGrantId: completeCandidateGrant.id,
        },
      });
      await db.memoryIndexGeneration.update({
        where: { id: completeCandidateGeneration.id },
        data: { status: "complete", completedAt: new Date() },
      });
      await db.memoryIndexPointer.create({ data: { projectId, indexGenerationId: completeCandidateGeneration.id } });

      const assertPersonalInvalidationRejected = async (label: string, operation: () => Promise<unknown>) => {
        await assert.rejects(
          operation,
          (error: unknown) => errorText(error).includes("PERSONAL_MEMORY_INDEX_EVIDENCE_INVALIDATION_REQUIRED"),
          label,
        );
        assert.equal((await db.memoryIndexPointer.findUnique({ where: { projectId } }))?.indexGenerationId, completeCandidateGeneration.id);
        assert.equal((await db.memoryIndexGeneration.findUniqueOrThrow({ where: { id: completeCandidateGeneration.id } })).status, "complete");
      };

      await db.aiProviderConnection.update({
        where: { id: providerId },
        data: { name: `Personal runtime provider maintained ${suffix}`, lastTestedAt: new Date() },
      });
      await db.appUser.update({ where: { id: ownerId }, data: { displayName: `Owner profile ${suffix}` } });

      await assertPersonalInvalidationRejected(
        "selection switch cannot leave a published personal generation stale",
        () => putProjectAiEffectiveRouteSelection(
          projectId,
          "embedding",
          { source: "platformDefault", delegationId: null, expectedVersion: embeddingSelection.version },
          { id: projectOwnerId, role: "user" },
          db,
        ),
      );
      await assertPersonalInvalidationRejected(
        "delegation terminalization cannot leave a published personal generation stale",
        () => revokeProjectAiProviderDelegation(
          projectId,
          embeddingDelegation.id,
          { expectedVersion: embeddingDelegation.version, reason: "published generation invalidation test", switchToPlatformDefault: true },
          { id: projectOwnerId, role: "user" },
          db,
        ),
      );
      await assertPersonalInvalidationRejected(
        "provider configuration changes cannot leave a published personal generation stale",
        () => db.$transaction(async (tx) => {
          const provider = await tx.aiProviderConnection.findUniqueOrThrow({ where: { id: providerId }, select: { configurationVersion: true } });
          await tx.aiProviderConnection.update({ where: { id: providerId }, data: { configurationVersion: provider.configurationVersion + 1 } });
        }),
      );
      await assertPersonalInvalidationRejected(
        "credential rotation cannot leave a published personal generation stale",
        () => db.$transaction((tx) => tx.externalCredential.update({ where: { id: credentialId }, data: { secretFingerprint: "b".repeat(64) } })),
      );
      await assertPersonalInvalidationRejected(
        "subscription revocation cannot leave a published personal generation stale",
        () => db.$transaction((tx) => revokeControlledMembershipInTransaction(tx, {
          subscriptionId: subscription.id,
          adminId: seededAdminId,
          reason: "published generation invalidation test",
        })),
      );
      await assertPersonalInvalidationRejected(
        "membership revocation cannot leave a published personal generation stale",
        () => db.$transaction((tx) => revokeProjectMembership(
          tx,
          projectId,
          ownerId,
          workspaceId,
          { actorId: projectOwnerId, reason: "published generation invalidation test" },
        )),
      );
      await assertPersonalInvalidationRejected(
        "user disable cannot leave a published personal generation stale",
        () => db.$transaction((tx) => tx.appUser.update({ where: { id: ownerId }, data: { disabledAt: new Date(), disabledById: seededAdminId, disabledReason: "published generation invalidation test" } })),
      );
      await assertPersonalInvalidationRejected(
        "project archive cannot leave a published personal generation stale",
        () => db.$transaction((tx) => tx.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } })),
      );

      const safeInvalidationRollback = "PERSONAL_MEMORY_SAFE_INVALIDATION_ROLLBACK";
      const assertSafeInvalidation = async (
        label: string,
        action: (tx: Prisma.TransactionClient) => Promise<void>,
        verify: (tx: Prisma.TransactionClient) => Promise<void>,
      ) => {
        await assert.rejects(
          () => db.$transaction(async (tx) => {
            const pointer = await tx.memoryIndexPointer.findUnique({ where: { projectId } });
            assert.equal(pointer?.indexGenerationId, completeCandidateGeneration.id);
            await tx.memoryIndexPointer.delete({ where: { projectId } });
            const currentGeneration = await tx.memoryIndexGeneration.findUniqueOrThrow({ where: { id: completeCandidateGeneration.id } });
            assert.equal(currentGeneration.status, "complete");
            assert.ok(currentGeneration.completedAt);
            await tx.memoryIndexGeneration.update({
              where: { id: completeCandidateGeneration.id },
              data: {
                status: "failed",
                failureCode: "PERSONAL_UPSTREAM_INVALIDATED",
                reconciliationRequired: false,
                completedAt: currentGeneration.completedAt,
              },
            });
            await action(tx);
            await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
            assert.equal(await tx.memoryIndexPointer.findUnique({ where: { projectId } }), null);
            const terminalGeneration = await tx.memoryIndexGeneration.findUniqueOrThrow({ where: { id: completeCandidateGeneration.id } });
            assert.equal(terminalGeneration.status, "failed");
            assert.equal(terminalGeneration.completedAt?.getTime(), currentGeneration.completedAt.getTime());
            await verify(tx);
            throw new Error(safeInvalidationRollback);
          }),
          (error: unknown) => errorText(error).includes(safeInvalidationRollback),
          label,
        );
        const restoredGeneration = await db.memoryIndexGeneration.findUniqueOrThrow({ where: { id: completeCandidateGeneration.id } });
        assert.equal(restoredGeneration.status, "complete");
        assert.equal((await db.memoryIndexPointer.findUnique({ where: { projectId } }))?.indexGenerationId, completeCandidateGeneration.id);
      };

      const revokeProviderDelegationDependencies = async (tx: Prisma.TransactionClient) => {
        for (const delegationId of [embeddingDelegation.id, delegation.id]) {
          const current = await tx.projectAiProviderDelegation.findUniqueOrThrow({ where: { id: delegationId } });
          const revoked = await revokeProjectAiProviderDelegation(
            projectId,
            current.id,
            { expectedVersion: current.version, reason: "safe personal memory invalidation test", switchToPlatformDefault: true },
            { id: projectOwnerId, role: "user" },
            tx,
          );
          assert.equal(revoked.status, "revoked");
        }
      };

      await assertSafeInvalidation(
        "safe selection switch can precede selection invalidation",
        async (tx) => {
          await putProjectAiEffectiveRouteSelection(
            projectId,
            "embedding",
            { source: "platformDefault", delegationId: null, expectedVersion: embeddingSelection.version },
            { id: projectOwnerId, role: "user" },
            tx,
          );
        },
        async (tx) => {
          const current = await tx.projectAiEffectiveRouteSelection.findUniqueOrThrow({ where: { id: embeddingSelection.id } });
          assert.equal(current.source, "platformDefault");
          assert.equal(current.delegationId, null);
        },
      );

      await assertSafeInvalidation(
        "safe delegation terminalization can precede delegation invalidation",
        async (tx) => { await revokeProviderDelegationDependencies(tx); },
        async (tx) => {
          const current = await tx.projectAiProviderDelegation.findUniqueOrThrow({ where: { id: embeddingDelegation.id } });
          assert.equal(current.status, "revoked");
          assert.equal((await tx.projectAiEffectiveRouteSelection.findUniqueOrThrow({ where: { id: embeddingSelection.id } })).source, "platformDefault");
        },
      );

      await assertSafeInvalidation(
        "safe provider configuration invalidation can commit after cleanup",
        async (tx) => {
          await revokeProviderDelegationDependencies(tx);
          await tx.aiProviderConnection.update({ where: { id: providerId }, data: { configurationVersion: embeddingDelegation.providerConfigurationVersion + 1 } });
        },
        async (tx) => assert.equal(
          (await tx.aiProviderConnection.findUniqueOrThrow({ where: { id: providerId } })).configurationVersion,
          embeddingDelegation.providerConfigurationVersion + 1,
        ),
      );

      await assertSafeInvalidation(
        "safe credential fingerprint invalidation can commit after cleanup",
        async (tx) => {
          await revokeProviderDelegationDependencies(tx);
          await tx.externalCredential.update({ where: { id: credentialId }, data: { secretFingerprint: "c".repeat(64) } });
        },
        async (tx) => assert.equal(
          (await tx.externalCredential.findUniqueOrThrow({ where: { id: credentialId } })).secretFingerprint,
          "c".repeat(64),
        ),
      );

      await assertSafeInvalidation(
        "safe subscription revocation can commit after cleanup",
        async (tx) => {
          await revokeProviderDelegationDependencies(tx);
          await revokeControlledMembershipInTransaction(tx, {
            subscriptionId: subscription.id,
            adminId: seededAdminId,
            reason: "safe personal memory invalidation test",
          });
        },
        async (tx) => assert.equal((await tx.membershipSubscription.findUniqueOrThrow({ where: { id: subscription.id } })).status, "revoked"),
      );

      await assertSafeInvalidation(
        "safe membership revocation can commit after cleanup",
        async (tx) => {
          await revokeProviderDelegationDependencies(tx);
          await revokeProjectMembership(tx, projectId, ownerId, workspaceId, { actorId: projectOwnerId, reason: "safe personal memory invalidation test" });
        },
        async (tx) => assert.equal(
          (await tx.projectMembership.findUniqueOrThrow({ where: { id: embeddingDelegation.ownerProjectMembershipId } })).accessState,
          "revoked",
        ),
      );

      await assertSafeInvalidation(
        "safe user disable can commit after cleanup",
        async (tx) => {
          await revokeProviderDelegationDependencies(tx);
          await tx.appUser.update({ where: { id: ownerId }, data: { disabledAt: new Date(), disabledById: seededAdminId, disabledReason: "safe personal memory invalidation test" } });
        },
        async (tx) => assert.ok((await tx.appUser.findUniqueOrThrow({ where: { id: ownerId } })).disabledAt),
      );

      await assertSafeInvalidation(
        "safe project archive can commit after cleanup",
        async (tx) => {
          await revokeProviderDelegationDependencies(tx);
          const archivedAt = new Date();
          const archivedProject = await tx.project.update({ where: { id: projectId }, data: { archivedAt } });
          await tx.projectLifecycleRevision.create({
            data: {
              projectId,
              action: "archived",
              actorId: projectOwnerId,
              previousArchivedAt: null,
              currentArchivedAt: archivedProject.archivedAt,
              projectUpdatedAt: archivedProject.updatedAt,
            },
          });
        },
        async (tx) => assert.ok((await tx.project.findUniqueOrThrow({ where: { id: projectId } })).archivedAt),
      );

      await assert.rejects(
        () => db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
          await tx.webAiGrant.update({ where: { id: completeCandidateGrant.id }, data: { revokedAt: new Date() } });
        }),
        (error: unknown) => errorText(error).includes("PERSONAL_MEMORY_INDEX_EVIDENCE_INVALIDATION_REQUIRED"),
        "a published personal generation cannot be revoked before it is terminalized and unpublished",
      );
      assert.equal((await db.webAiGrant.findUniqueOrThrow({ where: { id: completeCandidateGrant.id } })).revokedAt, null);
      assert.equal((await db.memoryIndexPointer.findUnique({ where: { projectId } }))?.indexGenerationId, completeCandidateGeneration.id);
      const completeCandidateRow = await db.memoryIndexGeneration.findUniqueOrThrow({ where: { id: completeCandidateGeneration.id }, select: { completedAt: true } });
      assert.ok(completeCandidateRow.completedAt);
      await assert.rejects(
        () => db.$transaction((tx) => tx.memoryIndexGeneration.update({
          where: { id: completeCandidateGeneration.id },
          data: {
            status: "failed",
            failureCode: "PERSONAL_GRANT_REVOKED",
            reconciliationRequired: false,
            completedAt: new Date(),
            recordCount: { increment: 1 },
            modelId: `${completeCandidateGrant.modelId}-tampered`,
          },
        })),
        (error: unknown) => errorText(error).includes("PERSONAL_MEMORY_INDEX_TERMINALIZATION_INVALID"),
        "personal terminalization cannot mutate frozen generation evidence",
      );
      await db.$transaction(async (tx) => {
        await tx.memoryIndexPointer.delete({ where: { projectId } });
        await tx.memoryIndexGeneration.update({
          where: { id: completeCandidateGeneration.id },
          data: { status: "failed", failureCode: "PERSONAL_GRANT_REVOKED", completedAt: completeCandidateRow.completedAt },
        });
        await tx.webAiGrant.update({ where: { id: completeCandidateGrant.id }, data: { revokedAt: new Date() } });
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      });
      assert.ok((await db.webAiGrant.findUniqueOrThrow({ where: { id: completeCandidateGrant.id } })).revokedAt !== null);

      const expiredJob = await db.backgroundJob.create({
        data: {
          id: randomUUID(),
          projectId,
          kind: "memoryIndex",
          requestedById: ownerId,
          idempotencyKey: `memory-expired-grant-${suffix}-${randomUUID()}`.slice(0, 64),
        },
      });
      await assert.rejects(
        () => db.$transaction(async (tx) => {
          const expiredGrant = await tx.webAiGrant.create({
            data: {
              ...embeddingGrant,
              id: randomUUID(),
              callKey: `personal-expired-embedding-${suffix}`,
              boundJobId: expiredJob.id,
              expiresAt: new Date(Date.now() - 60_000),
              revokedAt: null,
            } as never,
          });
          await tx.memoryIndexGeneration.create({
            data: {
              id: randomUUID(),
              projectId,
              jobId: expiredJob.id,
              providerConnectionId: providerId,
              modelId: expiredGrant.modelId,
              dimensions: expiredGrant.embeddingDimensions!,
              status: "staging",
              buildMode: "full",
              inputManifestFingerprint: "8".repeat(64),
              expectedEmbeddingRouteSource: "personal_delegation",
              expectedEmbeddingRouteId: embeddingSelection.id,
              expectedEmbeddingRouteVersion: embeddingSelection.version,
              expectedEmbeddingRouteUpdatedAt: embeddingSelection.updatedAt,
              expectedEmbeddingProviderConfigurationVersion: embeddingDelegation.providerConfigurationVersion,
              expectedEmbeddingRouteFenceFingerprint: expiredGrant.routeFenceFingerprint,
              embeddingWebAiGrantId: expiredGrant.id,
            },
          });
        }),
        (error: unknown) => errorText(error).includes("PERSONAL_RUNTIME_EVIDENCE_INVALID"),
        "expired personal grant cannot admit an embedding generation",
      );

      const sameTransactionJob = await db.backgroundJob.create({
        data: {
          id: randomUUID(),
          projectId,
          kind: "memoryIndex",
          requestedById: ownerId,
          idempotencyKey: `memory-pointer-revoke-${suffix}-${randomUUID()}`.slice(0, 64),
        },
      });
      const sameTransactionGrant = await db.webAiGrant.create({
        data: {
          ...embeddingGrant,
          id: randomUUID(),
          callKey: `personal-pointer-revoke-${suffix}`,
          boundJobId: sameTransactionJob.id,
          revokedAt: null,
        } as never,
      });
      const sameTransactionGeneration = await db.memoryIndexGeneration.create({
        data: {
          id: randomUUID(),
          projectId,
          jobId: sameTransactionJob.id,
          providerConnectionId: providerId,
          modelId: sameTransactionGrant.modelId,
          dimensions: sameTransactionGrant.embeddingDimensions!,
          status: "building",
          buildMode: "full",
          inputManifestFingerprint: "6".repeat(64),
          expectedEmbeddingRouteSource: "personal_delegation",
          expectedEmbeddingRouteId: embeddingSelection.id,
          expectedEmbeddingRouteVersion: embeddingSelection.version,
          expectedEmbeddingRouteUpdatedAt: embeddingSelection.updatedAt,
          expectedEmbeddingProviderConfigurationVersion: embeddingDelegation.providerConfigurationVersion,
          expectedEmbeddingRouteFenceFingerprint: sameTransactionGrant.routeFenceFingerprint,
          embeddingWebAiGrantId: sameTransactionGrant.id,
        },
      });

      await db.memoryIndexGeneration.update({
        where: { id: sameTransactionGeneration.id },
        data: { status: "complete", completedAt: new Date() },
      });
      await db.memoryIndexPointer.create({
        data: { projectId, indexGenerationId: sameTransactionGeneration.id },
      });

      let releaseRace!: () => void;
      let signalRaceReady!: () => void;
      const raceRelease = new Promise<void>((resolve) => { releaseRace = resolve; });
      const raceReady = new Promise<void>((resolve) => { signalRaceReady = resolve; });
      const publishRace = db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended('ai-project-provider-delegation-global', 0))");
        await tx.memoryIndexPointer.update({ where: { projectId }, data: { publishedAt: new Date() } });
        signalRaceReady();
        await raceRelease;
      });
      await raceReady;
      await assert.rejects(
        () => db.$transaction(async (tx) => {
          const provider = await tx.aiProviderConnection.findUniqueOrThrow({ where: { id: providerId }, select: { configurationVersion: true } });
          await tx.aiProviderConnection.update({ where: { id: providerId }, data: { configurationVersion: provider.configurationVersion + 1 } });
        }),
        (error: unknown) => errorText(error).includes("PROJECT_AI_PROVIDER_DELEGATION_LOCK_BUSY")
          || errorText(error).includes("40001")
          || errorText(error).includes("P2034")
          || errorText(error).includes("write conflict"),
        "provider invalidation loses deterministically to the memory publish advisory lock",
      );
      releaseRace();
      await publishRace;
      assert.equal((await db.memoryIndexPointer.findUnique({ where: { projectId } }))?.indexGenerationId, sameTransactionGeneration.id);

      await assert.rejects(
        () => db.$transaction(async (tx) => {
          await tx.memoryIndexPointer.update({ where: { projectId }, data: { indexGenerationId: sameTransactionGeneration.id } });
          await tx.webAiGrant.update({ where: { id: sameTransactionGrant.id }, data: { revokedAt: new Date() } });
        }),
        (error: unknown) => errorText(error).includes("PERSONAL_MEMORY_INDEX_EVIDENCE_INVALID"),
        "pointer then revoke in one transaction cannot bypass personal live evidence",
      );
      const sameTransactionCompletedAt = (await db.memoryIndexGeneration.findUniqueOrThrow({
        where: { id: sameTransactionGeneration.id },
        select: { completedAt: true },
      })).completedAt;
      assert.ok(sameTransactionCompletedAt);
      const unknownGeneration = await db.$transaction(async (tx) => {
        await tx.memoryIndexPointer.delete({ where: { projectId } });
        const generation = await tx.memoryIndexGeneration.update({
          where: { id: sameTransactionGeneration.id },
          data: { status: "unknown", failureCode: "PERSONAL_GRANT_REVOKED", reconciliationRequired: true, completedAt: sameTransactionCompletedAt },
        });
        await tx.webAiGrant.update({ where: { id: sameTransactionGrant.id }, data: { revokedAt: new Date() } });
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        return generation;
      });
      assert.equal(unknownGeneration.status, "unknown");

      // The project-deletion contract intentionally refuses unresolved jobs.
      // These jobs only support evidence-negative cases in this gate, so close
      // them explicitly before exercising the real cascade path.
      await db.backgroundJob.updateMany({
        where: { projectId },
        data: { status: "cancelled", stage: "terminal", completedAt: new Date(), reconciliationRequired: false },
      });
      for (const liveDelegation of [delegation, embeddingDelegation]) {
        await revokeProjectAiProviderDelegation(
          projectId,
          liveDelegation.id,
          { expectedVersion: liveDelegation.version, reason: "personal runtime evidence deletion fixture", switchToPlatformDefault: true },
          { id: projectOwnerId, role: "user" },
          db,
        );
      }
      const projectBeforeDelete = await db.project.findUniqueOrThrow({ where: { id: projectId } });
      const archivedProject = await updateProjectLifecycle({
        projectId,
        actor: { id: projectOwnerId, role: "user" },
        action: "archive",
        expectedUpdatedAt: projectBeforeDelete.updatedAt,
      }, db);
      await deleteArchivedProject({
        projectId,
        actor: { id: projectOwnerId, role: "user" },
        confirmationName: projectBeforeDelete.name,
        expectedUpdatedAt: archivedProject.project.updatedAt,
      }, db);
      assert.equal(await db.project.findUnique({ where: { id: projectId } }), null);
      assert.equal(await db.webAiGrant.findUnique({ where: { id: embeddingGrant.id } }), null);
      assert.equal(await db.memoryIndexGeneration.findUnique({ where: { id: validGeneration.id } }), null);
      assert.equal(await db.projectAiProviderDelegation.findUnique({ where: { id: embeddingDelegation.id } }), null);
      assert.ok(await db.projectAiProviderDelegationAudit.count({ where: { projectId } }) > 0);
    } finally {
      await db.$disconnect();
    }
  },
);
