import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDb } from "../src/lib/db";
import { executeAccountAccess, previewAccountAccess } from "../src/lib/account-access-service";
import { invokeChatCompletion, ProviderTransportError } from "../src/lib/ai-providers";
import { lockMembershipUser, reservePlatformTokens } from "../src/lib/ai-entitlements";
import { resolveEffectiveAiRoute } from "../src/lib/effective-ai-route";
import { deleteArchivedProject, updateProjectLifecycle } from "../src/lib/project-lifecycle";
import { claimProjectJob } from "../src/lib/project-workflow";
import { finishWebAiJob, stableAiCallKey, auditedProviderCall } from "../src/lib/web-ai-governance";
import { WebAiAccessError, type WebAiActor } from "../src/lib/web-ai-access";
import { grantProjectMembership, grantWorkspaceMembership, revokeProjectMembership } from "../src/lib/membership-governance";
import { createPersonalKnowledgeDocument, revisePersonalKnowledgeDocument } from "../src/lib/personal-knowledge-service";
import { loadProjectPersonalDefaults } from "../src/lib/project-personal-default-memory";
import { createConfirmedWebAiJobForPostgresGate } from "./web-ai-confirmation-fixture";
import { createSignupOfferFixture } from "./platform-grant-offer-policy-fixture";
import { activateCanonicalSignupGrant } from "./account-entitlement-test-helper";

const shouldRun = process.env.WEB_AI_GOVERNANCE_POSTGRES_GATE === "1";

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return Object.freeze({ promise, resolve });
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof WebAiAccessError && error.code === code;
}

async function createDispatchFixture() {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const providerId = randomUUID();
  const credentialId = randomUUID();
  const actor: WebAiActor = { id: userId, role: "user", accountAccessVersion: 1 };
  const now = new Date();

  await db.appUser.create({ data: { id: userId, username: `dispatch_${suffix}`, role: "user" } });
  const platformAdmin = await db.appUser.create({
    data: { id: randomUUID(), username: `dispatch_admin_${suffix}`, role: "admin" },
  });
  await createSignupOfferFixture(db, platformAdmin.id);
  await db.$transaction(async (tx) => {
    await tx.workspace.create({ data: { id: workspaceId, name: `Dispatch ${suffix}`, slug: `dispatch-${suffix}`, createdById: userId } });
    await tx.project.create({ data: { id: projectId, workspaceId, name: `Dispatch project ${suffix}`, slug: `dispatch-project-${suffix}` } });
    await grantWorkspaceMembership(tx, { workspaceId, userId, role: "owner", actorId: userId, reason: "web_ai_governance_fixture_workspace" });
    await grantWorkspaceMembership(tx, { workspaceId, userId: platformAdmin.id, role: "owner", actorId: userId, reason: "web_ai_governance_fixture_backup_owner" });
    await grantProjectMembership(tx, { projectId, workspaceId, userId, role: "owner", actorId: userId, reason: "web_ai_governance_fixture_project" });
  });
  const platformGrant = await activateCanonicalSignupGrant(db, { userId, actorId: platformAdmin.id, now });
  await db.externalCredential.create({
    data: {
      id: credentialId,
      kind: "aiProvider",
      ciphertext: Buffer.from([1]),
      nonce: Buffer.from([2]),
      authTag: Buffer.from([3]),
      maskedSuffix: "dispatch",
      secretFingerprint: "d".repeat(64),
    },
  });
  const provider = await db.aiProviderConnection.create({
    data: {
      id: providerId,
      name: `Dispatch provider ${suffix}`,
      kind: "glm",
      scope: "platform",
      ownerUserId: null,
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      credentialId,
      defaultGenerationModelId: "glm-4-flash",
      status: "verified",
      lastTestedAt: now,
    },
  });
  const activeRoute = await db.platformDefaultAiRoute.findFirst({
    where: { operation: "autoExtract", status: "active" },
    orderBy: [{ version: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  if (activeRoute !== null) {
    await db.platformDefaultAiRoute.update({
      where: { id: activeRoute.id },
      data: { status: "retired", updatedById: platformAdmin.id },
    });
  }
  const latestRoute = await db.platformDefaultAiRoute.findFirst({
    where: { operation: "autoExtract" },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const defaultRoute = await db.platformDefaultAiRoute.create({
    data: {
      operation: "autoExtract",
      version: (latestRoute?.version ?? 0) + 1,
      status: "active",
      providerConnectionId: provider.id,
      modelId: "glm-4-flash",
      embeddingDimensions: null,
      maxOutputTokens: 64,
      quotaMultiplierBps: 10_000,
      validatedProviderConfigurationVersion: provider.configurationVersion,
      validatedAt: now,
      createdById: platformAdmin.id,
      updatedById: platformAdmin.id,
    },
  });
  const route = await resolveEffectiveAiRoute(projectId, "autoExtract", db);
  const created = await createConfirmedWebAiJobForPostgresGate({
    projectId,
    kind: "autoExtract",
    route,
    requestedBy: actor,
    clientKey: `dispatch-${suffix}`,
    scopeKind: "projectSources",
    scopeIds: {},
    manifestFingerprint: "e".repeat(64),
    payload: {},
  }, db);
  const claim = await claimProjectJob(created.jobId, db);
  assert.notEqual(claim, false);
  if (claim === false) throw new Error("dispatch fixture claim failed");
  return Object.freeze({
    db,
    actor,
    projectId,
    workspaceId,
    userId,
    platformAdminId: platformAdmin.id,
    providerId,
    credentialId,
    platformGrantId: platformGrant.id,
    defaultRouteId: defaultRoute.id,
    jobId: created.jobId,
    grantId: created.grantId,
    route,
    claim,
  });
}

async function cleanupDispatchFixture(fixture: Awaited<ReturnType<typeof createDispatchFixture>>): Promise<void> {
  void fixture;
  // This gate runs against a disposable database. Evidence rows, including
  // platform-route audits and project-deletion receipts, are immutable and
  // must remain available for inspection; the gate runner drops the database
  // after the test instead of attempting row-level cleanup.
}

async function transitionDispatchActor(
  fixture: Awaited<ReturnType<typeof createDispatchFixture>>,
  action: "disable" | "restore",
  expectedVersion: number,
  requestKey: string,
) {
  const reason = `web_ai_governance_${action}`;
  const preview = await previewAccountAccess({
    adminUserId: fixture.platformAdminId,
    adminAccountAccessVersion: 1,
    userId: fixture.userId,
    action,
    reason,
    expectedVersion,
  }, fixture.db);
  return executeAccountAccess({
    adminUserId: fixture.platformAdminId,
    adminAccountAccessVersion: 1,
    userId: fixture.userId,
    action,
    reason,
    expectedVersion,
    expectedImpactFingerprint: preview.impactFingerprint,
    requestKey,
    requestFingerprint: preview.requestFingerprint,
    previewId: preview.previewId,
    previewIssuedAt: preview.previewIssuedAt,
    previewExpiresAt: preview.previewExpiresAt,
    confirmation: true,
    confirmationUsername: preview.user.username,
  }, fixture.db);
}

test(
  "PostgreSQL provider dispatch is revoke-wins before admission and admission-wins after its commit",
  { skip: !shouldRun ? "WEB_AI_GOVERNANCE_POSTGRES_GATE=1 is required" : false },
  async () => {
    const revokeFixture = await createDispatchFixture();
    try {
      const revokeLocked = deferred();
      const releaseRevoke = deferred();
      const revoke = revokeFixture.db.$transaction(async (tx) => {
        await lockMembershipUser(tx, revokeFixture.userId);
        revokeLocked.resolve();
        await revokeProjectMembership(tx, revokeFixture.projectId, revokeFixture.userId, revokeFixture.workspaceId, {
          actorId: revokeFixture.userId,
          reason: "web_ai_governance_revoke_wins",
        });
        await releaseRevoke.promise;
      });
      await revokeLocked.promise;
      let networkCalls = 0;
      const dispatch = auditedProviderCall({
        jobId: revokeFixture.jobId,
        attempt: revokeFixture.claim,
        actor: revokeFixture.actor,
        route: revokeFixture.route as never,
        grantId: revokeFixture.grantId,
        callKey: stableAiCallKey(revokeFixture.jobId, "autoExtract", "revoke-wins"),
        call: async () => {
          networkCalls += 1;
          return { inputTokens: 1, outputTokens: 1, providerRequestId: "revoke-wins", usageKnown: true };
        },
      }, revokeFixture.db);
      releaseRevoke.resolve();
      await revoke;
      await assert.rejects(dispatch, hasCode("ACCESS_FORBIDDEN"));
      assert.equal(networkCalls, 0);
      assert.equal(await revokeFixture.db.providerCallAudit.count({ where: { jobId: revokeFixture.jobId } }), 0);
      const pending = await revokeFixture.db.backgroundJobAttempt.findFirstOrThrow({ where: { jobId: revokeFixture.jobId } });
      assert.equal(pending.dispatchState, "pending");
    } finally {
      await cleanupDispatchFixture(revokeFixture);
    }

    const admissionFixture = await createDispatchFixture();
    try {
      const networkStarted = deferred();
      const releaseNetwork = deferred();
      let networkCalls = 0;
      const dispatch = auditedProviderCall({
        jobId: admissionFixture.jobId,
        attempt: admissionFixture.claim,
        actor: admissionFixture.actor,
        route: admissionFixture.route as never,
        grantId: admissionFixture.grantId,
        callKey: stableAiCallKey(admissionFixture.jobId, "autoExtract", "admission-wins"),
        call: async () => {
          networkCalls += 1;
          networkStarted.resolve();
          await releaseNetwork.promise;
          return { inputTokens: 1, outputTokens: 1, providerRequestId: "admission-wins", usageKnown: true };
        },
      }, admissionFixture.db);
      await networkStarted.promise;
      const revokeAfterAdmission = admissionFixture.db.$transaction(async (tx) => {
        await lockMembershipUser(tx, admissionFixture.userId);
        await revokeProjectMembership(tx, admissionFixture.projectId, admissionFixture.userId, admissionFixture.workspaceId, {
          actorId: admissionFixture.userId,
          reason: "web_ai_governance_revoke_after_admission",
        });
      });
      releaseNetwork.resolve();
      await dispatch;
      await revokeAfterAdmission;
      assert.equal(networkCalls, 1);
      const audit = await admissionFixture.db.providerCallAudit.findFirstOrThrow({ where: { jobId: admissionFixture.jobId } });
      assert.equal(audit.status, "succeeded");
      const acknowledged = await admissionFixture.db.backgroundJobAttempt.findFirstOrThrow({ where: { jobId: admissionFixture.jobId } });
      assert.equal(acknowledged.dispatchState, "acknowledged");
    } finally {
      await cleanupDispatchFixture(admissionFixture);
    }
  },
);

test(
  "project deletion keeps immutable platform billing and provider-call evidence without dangling Web AI grants",
  { skip: !shouldRun ? "WEB_AI_GOVERNANCE_POSTGRES_GATE=1 is required" : false },
  async () => {
    const fixture = await createDispatchFixture();
    try {
      const callKey = stableAiCallKey(fixture.jobId, "autoExtract", "project-delete-evidence");
      const result = await auditedProviderCall({
        jobId: fixture.jobId,
        attempt: fixture.claim,
        actor: fixture.actor,
        route: fixture.route,
        grantId: fixture.grantId,
        callKey,
        call: async (dispatch) => {
          assert.equal(dispatch.webAiGrantId, fixture.grantId);
          assert.equal(dispatch.routeFenceFingerprint, fixture.route.routeFenceFingerprint);
          return { inputTokens: 2, outputTokens: 3, providerRequestId: "project-delete-evidence", usageKnown: true };
        },
      }, fixture.db);
      await finishWebAiJob(fixture.jobId, fixture.claim, { ok: true }, fixture.db);

      const auditBefore = await fixture.db.providerCallAudit.findUniqueOrThrow({
        where: { id: result.providerCallAuditId },
      });
      const reservationBefore = await fixture.db.platformTokenReservation.findFirstOrThrow({
        where: { jobId: fixture.jobId, callKey },
      });
      assert.equal(auditBefore.webAiGrantId, fixture.grantId);
      assert.equal(reservationBefore.webAiGrantId, fixture.grantId);

      const currentProject = await fixture.db.project.findUniqueOrThrow({ where: { id: fixture.projectId } });
      const archived = await updateProjectLifecycle({
        projectId: fixture.projectId,
        actor: fixture.actor,
        action: "archive",
        expectedUpdatedAt: currentProject.updatedAt,
      }, fixture.db);
      await deleteArchivedProject({
        projectId: fixture.projectId,
        actor: fixture.actor,
        confirmationName: currentProject.name,
        expectedUpdatedAt: archived.project.updatedAt,
      }, fixture.db);

      assert.equal(await fixture.db.project.findUnique({ where: { id: fixture.projectId } }), null);
      assert.equal(await fixture.db.backgroundJob.findUnique({ where: { id: fixture.jobId } }), null);
      assert.equal(await fixture.db.webAiGrant.findUnique({ where: { id: fixture.grantId } }), null);
      const auditAfter = await fixture.db.providerCallAudit.findUniqueOrThrow({ where: { id: auditBefore.id } });
      const reservationAfter = await fixture.db.platformTokenReservation.findUniqueOrThrow({ where: { id: reservationBefore.id } });
      assert.equal(auditAfter.jobId, null);
      assert.equal(auditAfter.webAiGrantId, null);
      assert.equal(auditAfter.webAiGrantProjectId, fixture.projectId);
      assert.equal(auditAfter.reservationId, reservationBefore.id);
      assert.equal(reservationAfter.webAiGrantId, null);
      assert.equal(reservationAfter.webAiGrantProjectId, fixture.projectId);
      assert.equal(reservationAfter.grantId, fixture.platformGrantId);
      assert.equal(reservationAfter.routeFenceFingerprint, fixture.route.routeFenceFingerprint);
    } finally {
      await cleanupDispatchFixture(fixture);
    }
  },
);

test(
  "credential rotation after admission fails before governed transport fetch",
  { skip: !shouldRun ? "WEB_AI_GOVERNANCE_POSTGRES_GATE=1 is required" : false },
  async () => {
    const fixture = await createDispatchFixture();
    const previousFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = async () => {
      networkCalls += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      await assert.rejects(
        () => auditedProviderCall({
          jobId: fixture.jobId,
          attempt: fixture.claim,
          actor: fixture.actor,
          route: fixture.route,
          grantId: fixture.grantId,
          callKey: stableAiCallKey(fixture.jobId, "autoExtract", "credential-rotation"),
          call: async (dispatch) => {
            assert.equal(dispatch.connection.credentialSecretFingerprint, "d".repeat(64));
            await fixture.db.externalCredential.update({
              where: { id: fixture.credentialId },
              data: { secretFingerprint: "e".repeat(64) },
            });
            return invokeChatCompletion({
              connection: dispatch.connection,
              operation: "autoExtract",
              modelId: dispatch.modelId,
              messages: [{ role: "user", content: "probe" }],
              maxOutputTokens: dispatch.maxOutputTokens,
            });
          },
        }, fixture.db),
        (error: unknown) => error instanceof ProviderTransportError && error.code === "AI_PROVIDER_UNAVAILABLE",
      );
      assert.equal(networkCalls, 0);
      const audit = await fixture.db.providerCallAudit.findFirstOrThrow({
        where: { jobId: fixture.jobId, callKey: stableAiCallKey(fixture.jobId, "autoExtract", "credential-rotation") },
      });
      assert.equal(audit.credentialSecretFingerprint, "d".repeat(64));
      assert.equal(audit.status, "failed");
    } finally {
      globalThis.fetch = previousFetch;
    }
  },
);

test(
  "actor disable and restore after admission fails before credential read or provider fetch",
  { skip: !shouldRun ? "WEB_AI_GOVERNANCE_POSTGRES_GATE=1 is required" : false },
  async () => {
    const fixture = await createDispatchFixture();
    const previousFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = async () => {
      networkCalls += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const admissionPaused = deferred();
      const releaseAdmission = deferred();
      const dispatch = auditedProviderCall({
        jobId: fixture.jobId,
        attempt: fixture.claim,
        actor: fixture.actor,
        route: fixture.route,
        grantId: fixture.grantId,
        callKey: stableAiCallKey(fixture.jobId, "autoExtract", "actor-disable-restore"),
        call: async (admitted) => {
          admissionPaused.resolve();
          await releaseAdmission.promise;
          return invokeChatCompletion({
            connection: admitted.connection,
            operation: "autoExtract",
            modelId: admitted.modelId,
            messages: [{ role: "user", content: "probe" }],
            maxOutputTokens: admitted.maxOutputTokens,
          });
        },
      }, fixture.db);
      await admissionPaused.promise;
      const disabled = await transitionDispatchActor(fixture, "disable", 1, "dispatch-actor-disable");
      assert.equal(disabled.accountAccessVersion, 2);
      const restored = await transitionDispatchActor(fixture, "restore", 2, "dispatch-actor-restore");
      assert.equal(restored.accountAccessVersion, 3);
      releaseAdmission.resolve();
      await assert.rejects(
        dispatch,
        (error: unknown) => error instanceof ProviderTransportError && error.code === "AI_PROVIDER_UNAVAILABLE",
      );
      assert.equal(networkCalls, 0);
      const audit = await fixture.db.providerCallAudit.findFirstOrThrow({
        where: { jobId: fixture.jobId, callKey: stableAiCallKey(fixture.jobId, "autoExtract", "actor-disable-restore") },
      });
      assert.equal(audit.status, "failed");
      const attempt = await fixture.db.backgroundJobAttempt.findFirstOrThrow({ where: { jobId: fixture.jobId } });
      assert.equal(attempt.dispatchState, "pending");
    } finally {
      globalThis.fetch = previousFetch;
    }
  },
);

test(
  "unmarking a personal default after admission blocks the provider request",
  { skip: !shouldRun ? "WEB_AI_GOVERNANCE_POSTGRES_GATE=1 is required" : false },
  async () => {
    const fixture = await createDispatchFixture();
    const document = await createPersonalKnowledgeDocument({
      title: "Personal convention",
      content: "Prefer Vue 3",
      isDefaultMemory: true,
    }, fixture.actor, fixture.db);
    const defaults = await loadProjectPersonalDefaults(fixture.projectId, fixture.actor, fixture.db);
    const previousFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = async () => {
      networkCalls += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const callKey = stableAiCallKey(fixture.jobId, "autoExtract", "personal-default-unmark");
    try {
      await assert.rejects(
        () => auditedProviderCall({
          jobId: fixture.jobId,
          attempt: fixture.claim,
          actor: fixture.actor,
          route: fixture.route,
          grantId: fixture.grantId,
          callKey,
          personalDefaultFingerprint: defaults.fingerprint,
          call: async (dispatch) => {
            await revisePersonalKnowledgeDocument(String(document.id), {
              expectedVersion: 1,
              isDefaultMemory: false,
            }, fixture.actor, fixture.db);
            return invokeChatCompletion({
              connection: dispatch.connection,
              operation: "autoExtract",
              modelId: dispatch.modelId,
              messages: [{ role: "user", content: "Prefer Vue 3" }],
              maxOutputTokens: dispatch.maxOutputTokens,
            });
          },
        }, fixture.db),
        (error: unknown) => error instanceof ProviderTransportError && error.code === "AI_PROVIDER_UNAVAILABLE",
      );
      assert.equal(networkCalls, 0);
      const audit = await fixture.db.providerCallAudit.findFirstOrThrow({ where: { jobId: fixture.jobId, callKey } });
      assert.equal(audit.status, "failed");
      const attempt = await fixture.db.backgroundJobAttempt.findFirstOrThrow({ where: { jobId: fixture.jobId } });
      assert.equal(attempt.dispatchState, "pending");
    } finally {
      globalThis.fetch = previousFetch;
      await cleanupDispatchFixture(fixture);
    }
  },
);

test(
  "unmarking after the credential boundary is blocked by the request boundary",
  { skip: !shouldRun ? "WEB_AI_GOVERNANCE_POSTGRES_GATE=1 is required" : false },
  async () => {
    const fixture = await createDispatchFixture();
    const document = await createPersonalKnowledgeDocument({
      title: "Personal convention",
      content: "Prefer Vue 3",
      isDefaultMemory: true,
    }, fixture.actor, fixture.db);
    const defaults = await loadProjectPersonalDefaults(fixture.projectId, fixture.actor, fixture.db);
    const previousFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = async () => {
      networkCalls += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const callKey = stableAiCallKey(fixture.jobId, "autoExtract", "personal-default-after-credential");
    try {
      await assert.rejects(
        () => auditedProviderCall({
          jobId: fixture.jobId,
          attempt: fixture.claim,
          actor: fixture.actor,
          route: fixture.route,
          grantId: fixture.grantId,
          callKey,
          personalDefaultFingerprint: defaults.fingerprint,
          call: (dispatch) => invokeChatCompletion({
            connection: {
              ...dispatch.connection,
              apiKey: "disposable-test-key",
              onBeforeCredentialRead: async () => {
                await (dispatch.connection as typeof dispatch.connection & {
                  onBeforeCredentialRead?: () => void | boolean | Promise<void | boolean>;
                }).onBeforeCredentialRead?.();
                await revisePersonalKnowledgeDocument(String(document.id), {
                  expectedVersion: 1,
                  isDefaultMemory: false,
                }, fixture.actor, fixture.db);
              },
            },
            operation: "autoExtract",
            modelId: dispatch.modelId,
            messages: [{ role: "user", content: "Prefer Vue 3" }],
            maxOutputTokens: dispatch.maxOutputTokens,
          }),
        }, fixture.db),
        (error: unknown) => error instanceof ProviderTransportError && error.code === "AI_PROVIDER_UNAVAILABLE",
      );
      assert.equal(networkCalls, 0);
      const audit = await fixture.db.providerCallAudit.findFirstOrThrow({ where: { jobId: fixture.jobId, callKey } });
      assert.equal(audit.status, "failed");
      const attempt = await fixture.db.backgroundJobAttempt.findFirstOrThrow({ where: { jobId: fixture.jobId } });
      assert.equal(attempt.dispatchState, "pending");
    } finally {
      globalThis.fetch = previousFetch;
      await cleanupDispatchFixture(fixture);
    }
  },
);

test(
  "platform provider-call evidence rejects model, dimensions, and max-output drift",
  { skip: !shouldRun ? "WEB_AI_GOVERNANCE_POSTGRES_GATE=1 is required" : false },
  async () => {
    const cases = [
      { label: "model", override: { modelId: "gpt-4.1-mini" }, immediate: false },
      { label: "dimensions", override: { embeddingDimensions: 1536 }, immediate: true },
      { label: "max-output", override: { maxOutputTokens: 63 }, immediate: true },
    ] as const;

    for (const currentCase of cases) {
      const fixture = await createDispatchFixture();
      try {
        const callKey = stableAiCallKey(fixture.jobId, "autoExtract", `audit-drift-${currentCase.label}`);
        const reservation = await reservePlatformTokens({
          userId: fixture.userId,
          jobId: fixture.jobId,
          providerConnectionId: fixture.providerId,
          webAiGrantId: fixture.grantId,
          webAiGrantProjectId: fixture.projectId,
          callKey,
          operation: "autoExtract",
          modelId: fixture.route.modelId,
          rawEstimatedTokens: 1,
          routeSnapshot: fixture.route,
        }, fixture.db);
        const grant = await fixture.db.webAiGrant.findUniqueOrThrow({ where: { id: fixture.grantId } });
        const auditData = {
          id: randomUUID(),
          jobId: fixture.jobId,
          webAiGrantId: grant.id,
          webAiGrantReferenceId: grant.id,
          webAiGrantProjectId: grant.projectId,
          providerConnectionId: grant.providerConnectionId,
          operation: grant.operation,
          modelId: grant.modelId,
          billingMode: grant.billingMode,
          billingUserId: grant.billingUserId,
          callKey,
          reservationId: reservation.reservationId,
          routeSource: grant.routeSource,
          routeId: grant.routeId,
          routeVersion: grant.routeVersion,
          routeUpdatedAt: grant.routeUpdatedAt,
          providerConfigurationVersion: grant.providerConfigurationVersion,
          quotaMultiplierBps: grant.quotaMultiplierBps,
          routeFenceFingerprint: grant.routeFenceFingerprint,
          credentialSecretFingerprint: grant.credentialSecretFingerprint,
          payerKind: grant.payerKind,
          payerProviderConnectionId: grant.payerProviderConnectionId,
          embeddingDimensions: grant.embeddingDimensions,
          maxOutputTokens: grant.maxOutputTokens,
          status: "running",
          ...currentCase.override,
        };
        await assert.rejects(
          () => fixture.db.$transaction(async (tx) => {
            await tx.providerCallAudit.create({ data: auditData });
            if (currentCase.immediate) {
              await tx.$executeRawUnsafe('SET CONSTRAINTS "ProviderCallAudit_runtime_evidence_guard" IMMEDIATE');
            }
          }),
          (error: unknown) => {
            const text = error instanceof Error ? error.message : String(error);
            return text.includes("provider-call audit grant tuple mismatch")
              || text.includes("new platform audit requires credential fingerprint evidence")
              || text.includes("ProviderCallAudit_runtime_binding_check")
              || text.includes("ProviderCallAudit_runtime_evidence_guard");
          },
          `platform audit ${currentCase.label} drift`,
        );
      } finally {
        await cleanupDispatchFixture(fixture);
      }
    }
  },
);
