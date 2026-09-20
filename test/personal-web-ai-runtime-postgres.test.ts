import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { MemoryIndexStatus, PrismaClient } from "@prisma/client";
import { getDb } from "../src/lib/db";
import { resolveEffectiveAiRoute } from "../src/lib/effective-ai-route";
import { getProjectMemoryIndexPlan, getProjectMemoryIndexStatus, getProjectMemoryInputManifest } from "../src/lib/web-memory-index";
import { getActiveMemoryIndex } from "../src/lib/web-rag";
import { grantProjectMembership, grantWorkspaceMembership } from "../src/lib/membership-governance";
import {
  confirmProjectAiProviderDelegationOwner,
  confirmProjectAiProviderDelegationProject,
  proposeProjectAiProviderDelegation,
  putProjectAiEffectiveRouteSelection,
  revokeProjectAiProviderDelegation,
} from "../src/lib/project-ai-provider-delegation-service";
import {
  auditedProviderCall,
  claimWebAiJob,
  createGrantedWebAiJob,
} from "../src/lib/web-ai-governance";
import { createControlledMembership } from "./membership-fixture";
import { createConfirmedWebAiJobForPostgresGate } from "./web-ai-confirmation-fixture";
import { createPostgresWorkspaceFixture } from "./postgres-workspace-fixture";
const shouldRun = process.env.PERSONAL_WEB_AI_RUNTIME_POSTGRES_GATE === "1";
const testDatabaseName = "ai_project_os_personal_web_ai_runtime_test";
const seededAdminId = "00000000-0000-4000-8000-000000000010";

function assertDisposableGateDatabase(): void {
  const configuredUrl = process.env.DATABASE_URL;
  if (typeof configuredUrl !== "string" || configuredUrl.length === 0) {
    throw new Error("PERSONAL_WEB_AI_RUNTIME_TEST_DATABASE_URL_REQUIRED");
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
  ) throw new Error("PERSONAL_WEB_AI_RUNTIME_TEST_DATABASE_URL_INVALID");
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message}`;
  if (typeof error === "object" && error !== null) {
    const row = error as Record<string, unknown>;
    return [row.message, row.code, row.originalMessage, row.originalCode].filter((value) => value !== undefined).join(" ");
  }
  return String(error);
}

type TestRuntimeRoute = NonNullable<Awaited<ReturnType<typeof resolveEffectiveAiRoute>>>;

function generationConfirmationRoutes(
  routeByOperation: ReadonlyMap<string, Awaited<ReturnType<typeof resolveEffectiveAiRoute>>>,
  generationRoute: TestRuntimeRoute,
) {
  const embeddingRoute = routeByOperation.get("embedding");
  assert.ok(embeddingRoute);
  return { embedding: embeddingRoute, generation: generationRoute };
}

async function createTestMemoryGeneration(
  db: PrismaClient,
  input: Readonly<{
    projectId: string;
    jobId: string;
    grantId: string;
    route: TestRuntimeRoute;
    inputManifestFingerprint: string;
    status: MemoryIndexStatus;
  }>,
) {
  const terminal = input.status === "failed" || input.status === "unknown";
  return db.memoryIndexGeneration.create({
    data: {
      id: randomUUID(),
      projectId: input.projectId,
      jobId: input.jobId,
      providerConnectionId: input.route.providerConnectionId,
      modelId: input.route.modelId,
      dimensions: input.route.embeddingDimensions!,
      status: input.status,
      buildMode: "full",
      inputManifestFingerprint: input.inputManifestFingerprint,
      expectedInputCount: 1,
      expectedEmbeddingRouteUpdatedAt: input.route.routeUpdatedAt,
      expectedEmbeddingRouteSource: input.route.source,
      expectedEmbeddingRouteId: input.route.routeId,
      expectedEmbeddingRouteVersion: input.route.routeVersion,
      expectedEmbeddingProviderConfigurationVersion: input.route.providerConfigurationVersion,
      expectedEmbeddingConnectionOwnerAccountAccessVersion: input.route.source === "personal_delegation"
        ? input.route.personalEvidence?.connectionOwnerAccountAccessVersion ?? null
        : null,
      expectedEmbeddingRouteFenceFingerprint: input.route.routeFenceFingerprint,
      embeddingWebAiGrantId: input.grantId,
      failureCode: terminal ? `PERSONAL_RUNTIME_${input.status.toUpperCase()}_FIXTURE` : null,
      reconciliationRequired: input.status === "unknown",
      completedAt: terminal ? new Date() : null,
    },
  });
}

test(
  "personal Web AI runtime uses the public grant/claim/dispatch chain without platform quota",
  { skip: !shouldRun ? "PERSONAL_WEB_AI_RUNTIME_POSTGRES_GATE=1 is required" : false },
  async () => {
    assertDisposableGateDatabase();
    const db = getDb();
    const { workspaceId } = await createPostgresWorkspaceFixture(db);
    const suffix = randomUUID().slice(0, 8);
    const ownerId = randomUUID();
    const projectOwnerId = randomUUID();
    const projectId = randomUUID();
    const providerId = randomUUID();
    const credentialId = randomUUID();
    const credentialFingerprint = "a".repeat(64);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
    const ownerActor = { id: ownerId, role: "user" as const, accountAccessVersion: 1 };
    const projectOwnerActor = { id: projectOwnerId, role: "user" as const, accountAccessVersion: 1 };
    const actorFor = (id: string) => ({ id, role: "user" as const, accountAccessVersion: 1 });
    const operations = [
      { operation: "embedding" as const, kind: "memoryIndex" as const, scopeKind: "projectMemory" as const },
      { operation: "visionExtract" as const, kind: "assetExtract" as const, scopeKind: "projectAssets" as const },
      { operation: "autoExtract" as const, kind: "autoExtract" as const, scopeKind: "projectSources" as const },
      { operation: "projectAnalysis" as const, kind: "projectBrief" as const, scopeKind: "projectIntelligence" as const },
      { operation: "generateWithContext" as const, kind: "ragAnswer" as const, scopeKind: "query" as const },
    ];

    try {
      await db.appUser.createMany({
        data: [
          { id: ownerId, username: `personal_web_runtime_owner_${suffix}`, role: "user" },
          { id: projectOwnerId, username: `personal_web_runtime_project_owner_${suffix}`, role: "user" },
        ],
      });
      await createControlledMembership(db, {
        adminId: seededAdminId,
        userId: ownerId,
        startsAt: new Date(now.getTime() - 60_000),
        expiresAt,
        grantedById: seededAdminId,
      });
      await db.project.create({
        data: { id: projectId, workspaceId, name: `Personal Web runtime ${suffix}`, slug: `personal-web-runtime-${suffix}` },
      });
      await db.$transaction(async (tx) => {
        await grantWorkspaceMembership(tx, { workspaceId, userId: ownerId, role: "member", actorId: seededAdminId, reason: "personal_web_runtime_owner" });
        await grantWorkspaceMembership(tx, { workspaceId, userId: projectOwnerId, role: "member", actorId: seededAdminId, reason: "personal_web_runtime_project_owner" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: ownerId, role: "editor", actorId: seededAdminId, reason: "personal_web_runtime_owner" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: projectOwnerId, role: "owner", actorId: seededAdminId, reason: "personal_web_runtime_project_owner" });
      });
      await db.externalCredential.create({
        data: {
          id: credentialId,
          kind: "aiProvider",
          ciphertext: Buffer.from([1]),
          nonce: Buffer.from([2]),
          authTag: Buffer.from([3]),
          maskedSuffix: "gate",
          secretFingerprint: credentialFingerprint,
        },
      });
      await db.aiProviderConnection.create({
        data: {
          id: providerId,
          name: `Personal Web runtime provider ${suffix}`,
          kind: "openai",
          scope: "user",
          ownerUserId: ownerId,
          ownerAccountAccessVersion: 1,
          protocol: "chatCompletions",
          baseUrl: "https://api.openai.com/v1",
          credentialId,
          defaultGenerationModelId: "gpt-4.1-mini",
          defaultEmbeddingModelId: "text-embedding-3-small",
          defaultVisionModelId: "gpt-4o-mini",
          embeddingDimensions: 1536,
          status: "verified",
          lastTestedAt: now,
        },
      });
      const memoryContent = `Personal runtime liveness source ${suffix}`;
      const memoryContentHash = createHash("sha256").update(memoryContent, "utf8").digest("hex");
      const memorySource = await db.projectSource.create({
        data: {
          projectId,
          kind: "manual",
          contentText: memoryContent,
          contentHash: memoryContentHash,
          manualContentDedupeKey: memoryContentHash,
        },
      });
      const memoryManifest = await getProjectMemoryInputManifest(projectId, ownerActor, db);
      assert.ok(memoryManifest);

      const routeByOperation = new Map<string, Awaited<ReturnType<typeof resolveEffectiveAiRoute>>>();
      for (const item of operations) {
        const proposal = await proposeProjectAiProviderDelegation(
          projectId,
          { providerConnectionId: providerId, operation: item.operation, expiresAt: expiresAt.toISOString() },
          ownerActor,
          db,
        );
        const ownerConfirmed = await confirmProjectAiProviderDelegationOwner(
          projectId,
          proposal.id,
          { expectedVersion: proposal.version, acknowledgeProviderCharges: true },
          ownerActor,
          db,
        );
        const active = await confirmProjectAiProviderDelegationProject(
          projectId,
          proposal.id,
          { expectedVersion: ownerConfirmed.version, acknowledgeDataEgress: true, acknowledgeIndexImpact: true },
          projectOwnerActor,
          db,
        );
        const selection = await putProjectAiEffectiveRouteSelection(
          projectId,
          item.operation,
          { source: "personalDelegation", delegationId: active.id, expectedVersion: null },
          projectOwnerActor,
          db,
        );
        assert.equal(active.status, "active");
        assert.equal(selection.source, "personalDelegation");
        routeByOperation.set(item.operation, await resolveEffectiveAiRoute(projectId, item.operation, db));
      }

      const reservationCountBefore = await db.platformTokenReservation.count();
      const ledgerCountBefore = await db.platformTokenLedgerEntry.count({ where: { userId: ownerId } });
      let embeddingGenerationId: string | null = null;
      let embeddingGrantId: string | null = null;
      for (const [index, item] of operations.entries()) {
        const route = routeByOperation.get(item.operation);
        assert.ok(route);
        const created = await createConfirmedWebAiJobForPostgresGate({
          projectId,
          kind: item.kind,
          route,
          confirmationRoutes: item.operation === "projectAnalysis" || item.operation === "generateWithContext"
            ? generationConfirmationRoutes(routeByOperation, route)
            : undefined,
          requestedBy: ownerActor,
          clientKey: `personal-web-runtime-${item.operation}-${suffix}`,
          scopeKind: item.scopeKind,
          scopeIds: { projectId, operation: item.operation },
          manifestFingerprint: `${String(index + 1).repeat(64)}`.slice(0, 64),
          payload: { operation: item.operation },
          afterCreate: item.operation === "embedding"
            ? async (tx, jobId, grantId) => {
              const selectedRoute = route;
              const generation = await tx.memoryIndexGeneration.create({
                data: {
                  projectId,
                  jobId,
                  providerConnectionId: selectedRoute.providerConnectionId,
                  modelId: selectedRoute.modelId,
                  dimensions: selectedRoute.embeddingDimensions!,
                  status: "staging",
                  buildMode: "full",
                  inputManifestFingerprint: memoryManifest,
                  expectedInputCount: 1,
                  expectedEmbeddingRouteUpdatedAt: selectedRoute.routeUpdatedAt,
                  expectedEmbeddingRouteSource: selectedRoute.source,
                  expectedEmbeddingRouteId: selectedRoute.routeId,
                  expectedEmbeddingRouteVersion: selectedRoute.routeVersion,
                  expectedEmbeddingProviderConfigurationVersion: selectedRoute.providerConfigurationVersion,
                  expectedEmbeddingConnectionOwnerAccountAccessVersion: selectedRoute.source === "personal_delegation"
                    ? selectedRoute.personalEvidence?.connectionOwnerAccountAccessVersion ?? null
                    : null,
                  expectedEmbeddingRouteFenceFingerprint: selectedRoute.routeFenceFingerprint,
                  embeddingWebAiGrantId: grantId,
                },
                select: { id: true },
              });
              embeddingGenerationId = generation.id;
            }
            : undefined,
        }, db);
        if (item.operation === "embedding") embeddingGrantId = created.grantId;
        const claim = await claimWebAiJob(created.jobId, db);
        assert.notEqual(claim, false);
        if (claim === false) throw new Error("PERSONAL_WEB_RUNTIME_CLAIM_FAILED");
        let networkCalls = 0;
        const result: {
          providerCallAuditId: string;
          webAiGrantId: string;
          routeFenceFingerprint: string;
          inputTokens: number;
          outputTokens: number;
          providerRequestId: string | null;
          usageKnown: boolean;
        } = await auditedProviderCall<{
          inputTokens: number;
          outputTokens: number;
          providerRequestId: string;
          usageKnown: boolean;
        }>({
          jobId: created.jobId,
          attempt: claim,
          actor: ownerActor,
          route,
          grantId: created.grantId,
          personalMemoryGeneration: item.operation === "embedding"
            ? { generationId: embeddingGenerationId!, mode: "build" }
            : undefined,
          callKey: `personal-web-runtime-call-${item.operation}-${suffix}`,
          requestPayload: { operation: item.operation },
          call: async (dispatch) => {
            networkCalls += 1;
            assert.equal(dispatch.billingMode, "byok");
            assert.equal(dispatch.billingUserId, ownerId);
            assert.equal(dispatch.payerKind, "personalConnectionOwner");
            assert.equal(dispatch.payerProviderConnectionId, providerId);
            assert.equal(dispatch.connection.credentialSecretFingerprint, credentialFingerprint);
            if (item.operation === "embedding") assert.equal(dispatch.maxOutputTokens, 128);
            else assert.ok(dispatch.maxOutputTokens > 0);
            return { inputTokens: 2, outputTokens: 3, providerRequestId: `mock-${item.operation}`, usageKnown: true };
          },
        }, db);
        assert.equal(networkCalls, 1);
        assert.ok(result.providerCallAuditId);
        const grant = await db.webAiGrant.findUniqueOrThrow({ where: { id: created.grantId } });
        const audit = await db.providerCallAudit.findUniqueOrThrow({ where: { id: result.providerCallAuditId } });
        assert.equal(grant.billingMode, "byok");
        assert.equal(grant.billingUserId, ownerId);
        assert.equal(grant.payerKind, "personalConnectionOwner");
        assert.equal(grant.payerProviderConnectionId, providerId);
        assert.equal(audit.billingMode, "byok");
        assert.equal(audit.billingUserId, ownerId);
        assert.equal(audit.payerKind, "personalConnectionOwner");
        assert.equal(audit.payerProviderConnectionId, providerId);
        assert.equal(audit.reservationId, null);
        if (item.operation === "embedding") {
          assert.equal(grant.maxOutputTokens, null);
          assert.equal(audit.maxOutputTokens, null);
        } else {
          assert.ok((grant.maxOutputTokens ?? 0) > 0);
          assert.ok((audit.maxOutputTokens ?? 0) > 0);
        }
        assert.equal(await db.platformTokenReservation.count(), reservationCountBefore);
        assert.equal(await db.platformTokenLedgerEntry.count({ where: { userId: ownerId } }), ledgerCountBefore);
      }

      const sourceSummaryProposal = await proposeProjectAiProviderDelegation(
        projectId,
        { providerConnectionId: providerId, operation: "sourceSummary", expiresAt: expiresAt.toISOString() },
        ownerActor,
        db,
      );
      const sourceSummaryOwnerConfirmed = await confirmProjectAiProviderDelegationOwner(
        projectId,
        sourceSummaryProposal.id,
        { expectedVersion: sourceSummaryProposal.version, acknowledgeProviderCharges: true },
        ownerActor,
        db,
      );
      const sourceSummaryActive = await confirmProjectAiProviderDelegationProject(
        projectId,
        sourceSummaryProposal.id,
        { expectedVersion: sourceSummaryOwnerConfirmed.version, acknowledgeDataEgress: true, acknowledgeIndexImpact: true },
        projectOwnerActor,
        db,
      );
      await putProjectAiEffectiveRouteSelection(
        projectId,
        "sourceSummary",
        { source: "personalDelegation", delegationId: sourceSummaryActive.id, expectedVersion: null },
        projectOwnerActor,
        db,
      );
      const sourceSummaryRoute = await resolveEffectiveAiRoute(projectId, "sourceSummary", db);
      // This route is intentionally exercised with the original function:
      // the invalid operation must fail before confirmation is consulted.
      await assert.rejects(
        () => createGrantedWebAiJob({
          projectId,
          kind: "projectBrief",
          route: sourceSummaryRoute,
          requestedBy: ownerActor,
          clientKey: `personal-web-runtime-source-summary-${suffix}`,
          scopeKind: "projectSources",
          scopeIds: { projectId },
          manifestFingerprint: "9".repeat(64),
          payload: {},
        }, db),
        (error: unknown) => errorText(error).includes("AI_ROUTE_CONFIGURATION_FORBIDDEN"),
        "sourceSummary personal dispatch remains outside the runtime allowlist",
      );

      // The dispatch function binds a generation to the current project for
      // the final admission.  Build a second project so this rejection goes
      // through the public job/grant/dispatch chain rather than a direct SQL
      // shortcut.
      const crossProjectId = randomUUID();
      await db.project.create({
        data: { id: crossProjectId, workspaceId, name: `Personal Web cross project ${suffix}`, slug: `personal-web-cross-${suffix}` },
      });
      await db.$transaction(async (tx) => {
        await grantProjectMembership(tx, { projectId: crossProjectId, workspaceId, userId: ownerId, role: "editor", actorId: seededAdminId, reason: "personal_web_runtime_cross_project" });
        await grantProjectMembership(tx, { projectId: crossProjectId, workspaceId, userId: projectOwnerId, role: "owner", actorId: seededAdminId, reason: "personal_web_runtime_cross_project" });
      });
      const crossProposal = await proposeProjectAiProviderDelegation(
        crossProjectId,
        { providerConnectionId: providerId, operation: "embedding", expiresAt: expiresAt.toISOString() },
        ownerActor,
        db,
      );
      const crossOwnerConfirmed = await confirmProjectAiProviderDelegationOwner(
        crossProjectId,
        crossProposal.id,
        { expectedVersion: crossProposal.version, acknowledgeProviderCharges: true },
        ownerActor,
        db,
      );
      const crossActive = await confirmProjectAiProviderDelegationProject(
        crossProjectId,
        crossProposal.id,
        { expectedVersion: crossOwnerConfirmed.version, acknowledgeDataEgress: true, acknowledgeIndexImpact: true },
        projectOwnerActor,
        db,
      );
      await putProjectAiEffectiveRouteSelection(
        crossProjectId,
        "embedding",
        { source: "personalDelegation", delegationId: crossActive.id, expectedVersion: null },
        projectOwnerActor,
        db,
      );
      const crossRoute = await resolveEffectiveAiRoute(crossProjectId, "embedding", db);
      const crossJob = await createConfirmedWebAiJobForPostgresGate({
        projectId: crossProjectId,
        kind: "memoryIndex",
        route: crossRoute,
        requestedBy: ownerActor,
        clientKey: `personal-web-runtime-cross-project-${suffix}`,
        scopeKind: "projectMemory",
        scopeIds: { projectId: crossProjectId },
        manifestFingerprint: "e".repeat(64),
        payload: {},
      }, db);
      const crossClaim = await claimWebAiJob(crossJob.jobId, db);
      assert.notEqual(crossClaim, false);
      if (crossClaim === false) throw new Error("PERSONAL_WEB_RUNTIME_CROSS_PROJECT_CLAIM_FAILED");
      let crossNetworkCalls = 0;
      await assert.rejects(
        () => auditedProviderCall({
          jobId: crossJob.jobId,
          attempt: crossClaim,
          actor: ownerActor,
          route: crossRoute,
          grantId: crossJob.grantId,
          personalMemoryGeneration: { generationId: embeddingGenerationId!, mode: "build" },
          callKey: `personal-web-runtime-cross-project-call-${suffix}`,
          call: async () => {
            crossNetworkCalls += 1;
            return { inputTokens: 1, outputTokens: 1, providerRequestId: "must-not-fetch", usageKnown: true };
          },
        }, db),
        (error: unknown) => errorText(error).includes("AI_ROUTE_CONFIGURATION_FORBIDDEN"),
        "a personal generation from another project is rejected before transport",
      );
      assert.equal(crossNetworkCalls, 0);
      assert.equal(await db.providerCallAudit.count({ where: { webAiGrantId: crossJob.grantId } }), 0);
      const crossAttempt = await db.backgroundJobAttempt.findUniqueOrThrow({ where: { id: crossClaim.attemptId }, select: { dispatchState: true } });
      assert.equal(crossAttempt.dispatchState, "pending");

      // Failed and reconciliation-unknown generations are never valid build
      // evidence, even when their frozen grant tuple is otherwise current.
      for (const status of ["failed", "unknown"] as const) {
        const invalidJob = await createConfirmedWebAiJobForPostgresGate({
          projectId: crossProjectId,
          kind: "memoryIndex",
          route: crossRoute,
          requestedBy: ownerActor,
          clientKey: `personal-web-runtime-${status}-${suffix}`,
          scopeKind: "projectMemory",
          scopeIds: { projectId: crossProjectId, status },
          manifestFingerprint: `${status === "failed" ? "f" : "d"}`.repeat(64),
          payload: {},
        }, db);
        const invalidGeneration = await createTestMemoryGeneration(db, {
          projectId: crossProjectId,
          jobId: invalidJob.jobId,
          grantId: invalidJob.grantId,
          route: crossRoute,
          inputManifestFingerprint: memoryManifest,
          status,
        });
        const invalidClaim = await claimWebAiJob(invalidJob.jobId, db);
        assert.notEqual(invalidClaim, false);
        if (invalidClaim === false) throw new Error(`PERSONAL_WEB_RUNTIME_${status.toUpperCase()}_CLAIM_FAILED`);
        let invalidNetworkCalls = 0;
        await assert.rejects(
          () => auditedProviderCall({
            jobId: invalidJob.jobId,
            attempt: invalidClaim,
            actor: ownerActor,
            route: crossRoute,
            grantId: invalidJob.grantId,
            personalMemoryGeneration: { generationId: invalidGeneration.id, mode: "build" },
            callKey: `personal-web-runtime-${status}-call-${suffix}`,
            call: async () => {
              invalidNetworkCalls += 1;
              return { inputTokens: 1, outputTokens: 1, providerRequestId: "must-not-fetch", usageKnown: true };
            },
          }, db),
          (error: unknown) => errorText(error).includes("AI_ROUTE_CONFIGURATION_FORBIDDEN"),
          `${status} personal generation is rejected before transport`,
        );
        assert.equal(invalidNetworkCalls, 0);
        assert.equal(await db.providerCallAudit.count({ where: { webAiGrantId: invalidJob.grantId } }), 0);
        const invalidAttempt = await db.backgroundJobAttempt.findUniqueOrThrow({ where: { id: invalidClaim.attemptId }, select: { dispatchState: true } });
        assert.equal(invalidAttempt.dispatchState, "pending");
      }

      // Replace the projectAnalysis delegation with a second connection owner
      // so the supplemental grant proves payer evidence is independent from
      // the primary job requester.
      const supplementalOwnerId = randomUUID();
      const supplementalProviderId = randomUUID();
      const supplementalCredentialId = randomUUID();
      const supplementalCredentialFingerprint = "b".repeat(64);
      await db.appUser.create({ data: { id: supplementalOwnerId, username: `personal_web_runtime_supplemental_${suffix}`, role: "user" } });
      await createControlledMembership(db, {
        adminId: seededAdminId,
        userId: supplementalOwnerId,
        startsAt: new Date(now.getTime() - 60_000),
        expiresAt,
        grantedById: seededAdminId,
      });
      await db.$transaction(async (tx) => {
        await grantWorkspaceMembership(tx, { workspaceId, userId: supplementalOwnerId, role: "member", actorId: seededAdminId, reason: "personal_web_runtime_supplemental" });
        await grantProjectMembership(tx, { projectId, workspaceId, userId: supplementalOwnerId, role: "editor", actorId: seededAdminId, reason: "personal_web_runtime_supplemental" });
      });
      await db.externalCredential.create({
        data: {
          id: supplementalCredentialId,
          kind: "aiProvider",
          ciphertext: Buffer.from([4]),
          nonce: Buffer.from([5]),
          authTag: Buffer.from([6]),
          maskedSuffix: "supplemental",
          secretFingerprint: supplementalCredentialFingerprint,
        },
      });
      await db.aiProviderConnection.create({
        data: {
          id: supplementalProviderId,
          name: `Personal Web supplemental provider ${suffix}`,
          kind: "openai",
          scope: "user",
          ownerUserId: supplementalOwnerId,
          ownerAccountAccessVersion: 1,
          protocol: "chatCompletions",
          baseUrl: "https://api.openai.com/v1",
          credentialId: supplementalCredentialId,
          defaultGenerationModelId: "gpt-4.1-mini",
          defaultEmbeddingModelId: "text-embedding-3-small",
          defaultVisionModelId: "gpt-4o-mini",
          embeddingDimensions: 1536,
          status: "verified",
          lastTestedAt: now,
        },
      });
      const previousProjectAnalysis = await db.projectAiProviderDelegation.findFirstOrThrow({ where: { projectId, operation: "projectAnalysis", status: "active" } });
      await revokeProjectAiProviderDelegation(
        projectId,
        previousProjectAnalysis.id,
        { expectedVersion: previousProjectAnalysis.version, reason: "replace supplemental payer fixture", switchToPlatformDefault: true },
        projectOwnerActor,
        db,
      );
      const platformProjectAnalysisSelection = await db.projectAiEffectiveRouteSelection.findUniqueOrThrow({ where: { projectId_operation: { projectId, operation: "projectAnalysis" } }, select: { version: true } });
      const supplementalProposal = await proposeProjectAiProviderDelegation(
        projectId,
        { providerConnectionId: supplementalProviderId, operation: "projectAnalysis", expiresAt: expiresAt.toISOString() },
        actorFor(supplementalOwnerId),
        db,
      );
      const supplementalOwnerConfirmed = await confirmProjectAiProviderDelegationOwner(
        projectId,
        supplementalProposal.id,
        { expectedVersion: supplementalProposal.version, acknowledgeProviderCharges: true },
        actorFor(supplementalOwnerId),
        db,
      );
      const supplementalActive = await confirmProjectAiProviderDelegationProject(
        projectId,
        supplementalProposal.id,
        { expectedVersion: supplementalOwnerConfirmed.version, acknowledgeDataEgress: true, acknowledgeIndexImpact: true },
        projectOwnerActor,
        db,
      );
      await putProjectAiEffectiveRouteSelection(
        projectId,
        "projectAnalysis",
        { source: "personalDelegation", delegationId: supplementalActive.id, expectedVersion: platformProjectAnalysisSelection.version },
        projectOwnerActor,
        db,
      );
      const supplementalRoute = await resolveEffectiveAiRoute(projectId, "projectAnalysis", db);

      // Supplemental grants are independently bound to the same job and
      // operation tuple; no platform reservation or ledger row is created.
      const embeddingRoute = routeByOperation.get("embedding");
      const generationRoute = supplementalRoute;
      assert.ok(embeddingRoute);
      assert.ok(generationRoute);
      const supplementalJob = await createConfirmedWebAiJobForPostgresGate({
        projectId,
        kind: "memoryIndex",
        route: embeddingRoute,
        requestedBy: ownerActor,
        clientKey: `personal-web-runtime-supplemental-${suffix}`,
        scopeKind: "query",
        scopeIds: { projectId },
        manifestFingerprint: "8".repeat(64),
        payload: {},
        supplemental: {
          route: generationRoute,
          scopeKind: "projectMemory",
          scopeIds: { supplemental: true },
          manifestFingerprint: "7".repeat(64),
        },
      }, db);
      const supplementalGrant = await db.webAiGrant.findFirstOrThrow({
        where: {
          boundJobId: supplementalJob.jobId,
          operation: generationRoute.operation,
        },
      });
      assert.equal(supplementalGrant.billingUserId, supplementalOwnerId);
      assert.equal(supplementalGrant.payerProviderConnectionId, supplementalProviderId);
      const supplementalClaim = await claimWebAiJob(supplementalJob.jobId, db);
      assert.notEqual(supplementalClaim, false);
      if (supplementalClaim === false) throw new Error("PERSONAL_WEB_RUNTIME_SUPPLEMENTAL_CLAIM_FAILED");
      const supplementalReservationCount = await db.platformTokenReservation.count();
      const supplementalLedgerCount = await db.platformTokenLedgerEntry.count({ where: { userId: supplementalOwnerId } });
      let supplementalNetworkCalls = 0;
      const supplementalResult = await auditedProviderCall({
        jobId: supplementalJob.jobId,
        attempt: supplementalClaim,
        actor: ownerActor,
        route: generationRoute,
        grantId: supplementalGrant.id,
        callKey: `personal-web-runtime-supplemental-call-${suffix}`,
        call: async (dispatch) => {
          supplementalNetworkCalls += 1;
          assert.equal(dispatch.billingMode, "byok");
          assert.equal(dispatch.billingUserId, supplementalOwnerId);
          assert.equal(dispatch.payerKind, "personalConnectionOwner");
          assert.equal(dispatch.payerProviderConnectionId, supplementalProviderId);
          return { inputTokens: 2, outputTokens: 2, providerRequestId: "mock-supplemental", usageKnown: true };
        },
      }, db);
      assert.equal(supplementalNetworkCalls, 1);
      const supplementalAudit = await db.providerCallAudit.findUniqueOrThrow({ where: { id: supplementalResult.providerCallAuditId } });
      assert.equal(supplementalAudit.billingUserId, supplementalOwnerId);
      assert.equal(supplementalAudit.payerProviderConnectionId, supplementalProviderId);
      assert.equal(supplementalAudit.reservationId, null);
      assert.equal(await db.platformTokenReservation.count(), supplementalReservationCount);
      assert.equal(await db.platformTokenLedgerEntry.count({ where: { userId: supplementalOwnerId } }), supplementalLedgerCount);

      const revokedRoute = routeByOperation.get("autoExtract");
      assert.ok(revokedRoute);
      const revokedJob = await createConfirmedWebAiJobForPostgresGate({
        projectId,
        kind: "autoExtract",
        route: revokedRoute,
        requestedBy: ownerActor,
        clientKey: `personal-web-runtime-revoked-${suffix}`,
        scopeKind: "projectSources",
        scopeIds: { projectId },
        manifestFingerprint: "6".repeat(64),
        payload: {},
      }, db);
      const revokedClaim = await claimWebAiJob(revokedJob.jobId, db);
      assert.notEqual(revokedClaim, false);
      if (revokedClaim === false) throw new Error("PERSONAL_WEB_RUNTIME_REVOKED_CLAIM_FAILED");
      await db.webAiGrant.update({ where: { id: revokedJob.grantId }, data: { revokedAt: new Date() } });
      let revokedNetworkCalls = 0;
      await assert.rejects(
        () => auditedProviderCall({
          jobId: revokedJob.jobId,
          attempt: revokedClaim,
          actor: ownerActor,
          route: revokedRoute,
          grantId: revokedJob.grantId,
          callKey: `personal-web-runtime-revoked-call-${suffix}`,
          call: async () => {
            revokedNetworkCalls += 1;
            return { inputTokens: 1, outputTokens: 1, providerRequestId: "must-not-fetch", usageKnown: true };
          },
        }, db),
        (error: unknown) => errorText(error).includes("AI_ROUTE_CONFIGURATION_FORBIDDEN"),
        "revoked personal grant is rejected before transport",
      );
      assert.equal(revokedNetworkCalls, 0);

      const driftRoute = routeByOperation.get("generateWithContext");
      assert.ok(driftRoute);
      const driftJob = await createConfirmedWebAiJobForPostgresGate({
        projectId,
        kind: "ragAnswer",
        route: driftRoute,
        confirmationRoutes: generationConfirmationRoutes(routeByOperation, driftRoute),
        requestedBy: ownerActor,
        clientKey: `personal-web-runtime-credential-drift-${suffix}`,
        scopeKind: "query",
        scopeIds: { projectId, drift: true },
        manifestFingerprint: "5".repeat(64),
        payload: {},
      }, db);
      const driftClaim = await claimWebAiJob(driftJob.jobId, db);
      assert.notEqual(driftClaim, false);
      if (driftClaim === false) throw new Error("PERSONAL_WEB_RUNTIME_DRIFT_CLAIM_FAILED");
      const driftedRoute = {
        ...driftRoute,
        credentialSecretFingerprint: "f".repeat(64),
        providerConnection: {
          ...driftRoute.providerConnection,
          credentialSecretFingerprint: "f".repeat(64),
        },
      };
      let driftNetworkCalls = 0;
      await assert.rejects(
        () => auditedProviderCall({
          jobId: driftJob.jobId,
          attempt: driftClaim,
          actor: ownerActor,
          route: driftedRoute,
          grantId: driftJob.grantId,
          callKey: `personal-web-runtime-credential-drift-call-${suffix}`,
          call: async () => {
            driftNetworkCalls += 1;
            return { inputTokens: 1, outputTokens: 1, providerRequestId: "must-not-fetch", usageKnown: true };
          },
        }, db),
        (error: unknown) => errorText(error).includes("AI_ROUTE_CONFIGURATION_FORBIDDEN"),
        "stale or forged credential fingerprint tuple is rejected before personal transport",
      );
      assert.equal(driftNetworkCalls, 0);

      assert.ok(embeddingGrantId);
      assert.ok(embeddingGenerationId);
      await db.memoryIndexGeneration.update({
        where: { id: embeddingGenerationId! },
        data: { status: "failed", failureCode: "PERSONAL_RUNTIME_GATE_REPLACED", completedAt: new Date() },
      });
      assert.ok(embeddingGrantId);
      // Create the expiry fixture through the internal expiry cap.
      // Grant expiry is immutable by design, so the cap is applied while the
      // confirmation-bound job and grant are created atomically.
      const shortExpiresAt = new Date(Date.now() + 60_000);
      const shortEmbeddingRoute = embeddingRoute;
      assert.ok(shortEmbeddingRoute);
      const shortJob = await createConfirmedWebAiJobForPostgresGate({
        projectId,
        kind: "memoryIndex",
        route: shortEmbeddingRoute,
        requestedBy: ownerActor,
        clientKey: `personal-web-runtime-expiry-${suffix}`,
        scopeKind: "projectMemory",
        scopeIds: { projectId, expiry: true },
        manifestFingerprint: "8".repeat(64),
        payload: { expiry: true },
        grantExpiresAtCap: shortExpiresAt,
      }, db);
      const shortGrant = await db.webAiGrant.findUniqueOrThrow({ where: { id: shortJob.grantId } });
      assert.equal(shortGrant.expiresAt.getTime(), shortExpiresAt.getTime());
      const shortGeneration = await db.memoryIndexGeneration.create({
        data: {
          id: randomUUID(),
          projectId,
          jobId: shortJob.jobId,
          providerConnectionId: shortGrant.providerConnectionId,
          modelId: shortGrant.modelId,
          dimensions: shortGrant.embeddingDimensions!,
          status: "building",
          buildMode: "full",
          inputManifestFingerprint: memoryManifest,
          expectedEmbeddingRouteUpdatedAt: shortGrant.routeUpdatedAt!,
          expectedEmbeddingRouteSource: shortGrant.routeSource!,
          expectedEmbeddingRouteId: shortGrant.routeId,
          expectedEmbeddingRouteVersion: shortGrant.routeVersion,
          expectedEmbeddingProviderConfigurationVersion: shortGrant.providerConfigurationVersion!,
          expectedEmbeddingConnectionOwnerAccountAccessVersion: shortGrant.connectionOwnerAccountAccessVersion,
          expectedEmbeddingRouteFenceFingerprint: shortGrant.routeFenceFingerprint!,
          embeddingWebAiGrantId: shortGrant.id,
          expectedInputCount: 1,
        },
      });
      await db.memoryRecord.create({
        data: {
          id: randomUUID(),
          projectId,
          indexGenerationId: shortGeneration.id,
          scope: "projectSource",
          projectSourceId: memorySource.id,
          rangeStart: 0,
          rangeEnd: memoryContent.length,
          contentText: memoryContent,
          contentHash: memoryContentHash,
          embedding: [1, ...Array.from({ length: 1535 }, () => 0)],
          inputFingerprint: "c".repeat(64),
          embeddingFingerprint: "d".repeat(64),
        },
      });
      await db.memoryIndexGeneration.update({
        where: { id: shortGeneration.id },
        data: { status: "complete", generatedRecordCount: 1, recordCount: 1, completedAt: new Date() },
      });
      await db.memoryIndexPointer.create({ data: { projectId, indexGenerationId: shortGeneration.id } });
      const shortClaim = await claimWebAiJob(shortJob.jobId, db);
      assert.notEqual(shortClaim, false);
      if (shortClaim === false) throw new Error("PERSONAL_WEB_RUNTIME_EXPIRY_CLAIM_FAILED");
      const embeddingConsumeJob = await createConfirmedWebAiJobForPostgresGate({
        projectId,
        kind: "memoryIndex",
        route: shortEmbeddingRoute,
        requestedBy: ownerActor,
        clientKey: `personal-web-runtime-embedding-consume-${suffix}`,
        scopeKind: "projectMemory",
        scopeIds: { projectId, indexGenerationId: shortGeneration.id, consume: true },
        manifestFingerprint: "1".repeat(64),
        payload: { indexGenerationId: shortGeneration.id },
      }, db);
      const embeddingConsumeClaim = await claimWebAiJob(embeddingConsumeJob.jobId, db);
      assert.notEqual(embeddingConsumeClaim, false);
      if (embeddingConsumeClaim === false) throw new Error("PERSONAL_WEB_RUNTIME_EMBEDDING_CONSUME_CLAIM_FAILED");
      let embeddingConsumeNetworkCalls = 0;
      const embeddingConsumeResult = await auditedProviderCall({
        jobId: embeddingConsumeJob.jobId,
        attempt: embeddingConsumeClaim,
        actor: ownerActor,
        route: shortEmbeddingRoute,
        grantId: embeddingConsumeJob.grantId,
        personalMemoryGeneration: { generationId: shortGeneration.id, mode: "consume" },
        callKey: `personal-web-runtime-embedding-consume-call-${suffix}`,
        call: async (dispatch) => {
          embeddingConsumeNetworkCalls += 1;
          assert.equal(dispatch.billingMode, "byok");
          assert.equal(dispatch.billingUserId, ownerId);
          assert.equal(dispatch.payerKind, "personalConnectionOwner");
          assert.equal(dispatch.maxOutputTokens, 128);
          return { inputTokens: 1, outputTokens: 1, providerRequestId: "mock-embedding-consume", usageKnown: true };
        },
      }, db);
      assert.equal(embeddingConsumeNetworkCalls, 1);
      const embeddingConsumeAudit = await db.providerCallAudit.findUniqueOrThrow({ where: { id: embeddingConsumeResult.providerCallAuditId } });
      assert.equal(embeddingConsumeAudit.operation, "embedding");
      assert.equal(embeddingConsumeAudit.billingUserId, ownerId);
      assert.equal(embeddingConsumeAudit.reservationId, null);
      const consumeRoute = routeByOperation.get("generateWithContext");
      assert.ok(consumeRoute);
      const consumeJob = await createConfirmedWebAiJobForPostgresGate({
        projectId,
        kind: "ragAnswer",
        route: consumeRoute,
        confirmationRoutes: generationConfirmationRoutes(routeByOperation, consumeRoute),
        requestedBy: ownerActor,
        clientKey: `personal-web-runtime-consume-${suffix}`,
        scopeKind: "query",
        scopeIds: { projectId, indexGenerationId: shortGeneration.id },
        manifestFingerprint: "3".repeat(64),
        payload: { indexGenerationId: shortGeneration.id },
      }, db);
      const consumeClaim = await claimWebAiJob(consumeJob.jobId, db);
      assert.notEqual(consumeClaim, false);
      if (consumeClaim === false) throw new Error("PERSONAL_WEB_RUNTIME_CONSUME_CLAIM_FAILED");
      let consumeNetworkCalls = 0;
      await auditedProviderCall({
        jobId: consumeJob.jobId,
        attempt: consumeClaim,
        actor: ownerActor,
        route: consumeRoute,
        grantId: consumeJob.grantId,
        personalMemoryGeneration: { generationId: shortGeneration.id, mode: "consume" },
        callKey: `personal-web-runtime-consume-call-${suffix}`,
        call: async () => {
          consumeNetworkCalls += 1;
          return { inputTokens: 1, outputTokens: 1, providerRequestId: "mock-consume", usageKnown: true };
        },
      }, db);
      assert.equal(consumeNetworkCalls, 1);

      // A complete generation without the project pointer is not a valid
      // consume admission, even while its frozen evidence remains live.
      const nonPointerJob = await createConfirmedWebAiJobForPostgresGate({
        projectId,
        kind: "memoryIndex",
        route: shortEmbeddingRoute,
        requestedBy: ownerActor,
        clientKey: `personal-web-runtime-nonpointer-embedding-${suffix}`,
        scopeKind: "projectMemory",
        scopeIds: { projectId, nonPointer: true },
        manifestFingerprint: "2".repeat(64),
        payload: {},
      }, db);
      const nonPointerGeneration = await createTestMemoryGeneration(db, {
        projectId,
        jobId: nonPointerJob.jobId,
        grantId: nonPointerJob.grantId,
        route: shortEmbeddingRoute,
        inputManifestFingerprint: memoryManifest,
        status: "building",
      });
      await db.memoryRecord.create({
        data: {
          id: randomUUID(),
          projectId,
          indexGenerationId: nonPointerGeneration.id,
          scope: "projectSource",
          projectSourceId: memorySource.id,
          rangeStart: 0,
          rangeEnd: memoryContent.length,
          contentText: memoryContent,
          contentHash: memoryContentHash,
          embedding: [1, ...Array.from({ length: 1535 }, () => 0)],
          inputFingerprint: "1".repeat(64),
          embeddingFingerprint: "2".repeat(64),
        },
      });
      await db.memoryIndexGeneration.update({
        where: { id: nonPointerGeneration.id },
        data: { status: "complete", generatedRecordCount: 1, recordCount: 1, completedAt: new Date() },
      });
      // The generation is produced by an embedding build job, but consume
      // admission must be exercised through the separate generation route and
      // grant that would actually serve the RAG answer.
      const nonPointerConsumeJob = await createConfirmedWebAiJobForPostgresGate({
        projectId,
        kind: "ragAnswer",
        route: consumeRoute,
        confirmationRoutes: generationConfirmationRoutes(routeByOperation, consumeRoute),
        requestedBy: ownerActor,
        clientKey: `personal-web-runtime-nonpointer-consume-${suffix}`,
        scopeKind: "query",
        scopeIds: { projectId, indexGenerationId: nonPointerGeneration.id, nonPointer: true },
        manifestFingerprint: "7".repeat(64),
        payload: { indexGenerationId: nonPointerGeneration.id },
      }, db);
      const nonPointerClaim = await claimWebAiJob(nonPointerConsumeJob.jobId, db);
      assert.notEqual(nonPointerClaim, false);
      if (nonPointerClaim === false) throw new Error("PERSONAL_WEB_RUNTIME_NONPOINTER_CLAIM_FAILED");
      let nonPointerNetworkCalls = 0;
      const nonPointerAuditCountBefore = await db.providerCallAudit.count({ where: { webAiGrantId: nonPointerConsumeJob.grantId } });
      assert.equal(nonPointerAuditCountBefore, 0);
      await assert.rejects(
        () => auditedProviderCall({
          jobId: nonPointerConsumeJob.jobId,
          attempt: nonPointerClaim,
          actor: ownerActor,
          route: consumeRoute,
          grantId: nonPointerConsumeJob.grantId,
          personalMemoryGeneration: { generationId: nonPointerGeneration.id, mode: "consume" },
          callKey: `personal-web-runtime-nonpointer-consume-${suffix}`,
          call: async () => {
            nonPointerNetworkCalls += 1;
            return { inputTokens: 1, outputTokens: 1, providerRequestId: "must-not-fetch", usageKnown: true };
          },
        }, db),
        (error: unknown) => errorText(error).includes("AI_ROUTE_CONFIGURATION_FORBIDDEN"),
        "a complete non-pointer generation is rejected before transport",
      );
      assert.equal(nonPointerNetworkCalls, 0);
      assert.equal(await db.providerCallAudit.count({ where: { webAiGrantId: nonPointerConsumeJob.grantId } }), nonPointerAuditCountBefore);
      const nonPointerAttempt = await db.backgroundJobAttempt.findUniqueOrThrow({ where: { id: nonPointerClaim.attemptId }, select: { dispatchState: true } });
      assert.equal(nonPointerAttempt.dispatchState, "pending");
      const readyStatus = await getProjectMemoryIndexStatus(projectId, ownerActor, db);
      assert.equal(readyStatus.readiness, "ready");
      assert.deepEqual(readyStatus.route?.providerConnection, {
        name: `Personal Web runtime provider ${suffix}`,
        kind: "openai",
        status: "verified",
      });
      assert.equal("providerConnectionId" in (readyStatus.route ?? {}), false);
      assert.equal("providerConnectionId" in (readyStatus.activeIndex?.generation ?? {}), false);
      const projectOwnerStatus = await getProjectMemoryIndexStatus(projectId, projectOwnerActor, db);
      assert.deepEqual(projectOwnerStatus.route?.providerConnection, { kind: "openai" });
      assert.deepEqual(projectOwnerStatus.activeIndex?.generation.providerConnection, { kind: "openai" });
      assert.equal(projectOwnerStatus.route?.modelId, embeddingRoute.modelId);
      assert.equal(projectOwnerStatus.route?.embeddingDimensions, embeddingRoute.embeddingDimensions);
      assert.equal(JSON.stringify(projectOwnerStatus).includes(providerId), false);
      const activeMemory = await getActiveMemoryIndex(projectId, ownerActor, db);
      assert.equal(activeMemory.id, shortGeneration.id);
      const incrementalPlan = await getProjectMemoryIndexPlan(projectId, "incremental", ownerActor, db);
      assert.equal(incrementalPlan.reuseCount, 0);
      while (Date.now() < shortExpiresAt.getTime()) await new Promise<void>((resolve) => setTimeout(resolve, 50));
      const liveAfterExpiry = await db.$queryRaw<Array<{ live: boolean }>>`
        SELECT "personal_memory_frozen_evidence_valid"(${shortGeneration.id}::uuid, true) AS live
      `;
      assert.equal(liveAfterExpiry[0]?.live, false);
      let expiredNetworkCalls = 0;
      await assert.rejects(
        () => auditedProviderCall({
          jobId: shortJob.jobId,
          attempt: shortClaim,
          actor: ownerActor,
          route: shortEmbeddingRoute,
          grantId: shortGrant.id,
          personalMemoryGeneration: { generationId: shortGeneration.id, mode: "consume" },
          callKey: `personal-web-runtime-expiry-call-${suffix}`,
          call: async () => {
            expiredNetworkCalls += 1;
            return { inputTokens: 1, outputTokens: 1, providerRequestId: "must-not-fetch", usageKnown: true };
          },
        }, db),
        (error: unknown) => errorText(error).includes("AI_ROUTE_CONFIGURATION_FORBIDDEN"),
        "expired personal grant is rejected before transport",
      );
      assert.equal(expiredNetworkCalls, 0);
      const staleGenerationRoute = routeByOperation.get("generateWithContext");
      assert.ok(staleGenerationRoute);
      const staleGenerationJob = await createConfirmedWebAiJobForPostgresGate({
        projectId,
        kind: "ragAnswer",
        route: staleGenerationRoute,
        confirmationRoutes: generationConfirmationRoutes(routeByOperation, staleGenerationRoute),
        requestedBy: ownerActor,
        clientKey: `personal-web-runtime-stale-generation-${suffix}`,
        scopeKind: "query",
        scopeIds: { projectId, indexGenerationId: activeMemory.id },
        manifestFingerprint: "4".repeat(64),
        payload: { indexGenerationId: activeMemory.id },
      }, db);
      const staleGenerationClaim = await claimWebAiJob(staleGenerationJob.jobId, db);
      assert.notEqual(staleGenerationClaim, false);
      if (staleGenerationClaim === false) throw new Error("PERSONAL_WEB_RUNTIME_STALE_GENERATION_CLAIM_FAILED");
      let staleGenerationNetworkCalls = 0;
      await assert.rejects(
        () => auditedProviderCall({
          jobId: staleGenerationJob.jobId,
          attempt: staleGenerationClaim,
          actor: ownerActor,
          route: staleGenerationRoute,
          grantId: staleGenerationJob.grantId,
          personalMemoryGeneration: { generationId: activeMemory.id, mode: "consume" },
          callKey: `personal-web-runtime-stale-generation-call-${suffix}`,
          call: async () => {
            staleGenerationNetworkCalls += 1;
            return { inputTokens: 1, outputTokens: 1, providerRequestId: "must-not-fetch", usageKnown: true };
          },
        }, db),
        (error: unknown) => errorText(error).includes("AI_ROUTE_CONFIGURATION_FORBIDDEN"),
        "a stale personal index blocks a later generation admission",
      );
      assert.equal(staleGenerationNetworkCalls, 0);
      await assert.rejects(
        () => getActiveMemoryIndex(projectId, ownerActor, db),
        (error: unknown) => errorText(error).includes("SEMANTIC_INDEX_NOT_READY"),
        "naturally expired personal evidence cannot be read as an active memory index",
      );
      const expiredStatus = await getProjectMemoryIndexStatus(projectId, ownerActor, db);
      assert.notEqual(expiredStatus.readiness, "ready");
      const expiredPlan = await getProjectMemoryIndexPlan(projectId, "incremental", ownerActor, db);
      assert.equal(expiredPlan.reuseCount, 0);
    } finally {
      await db.$disconnect();
    }
  },
);
