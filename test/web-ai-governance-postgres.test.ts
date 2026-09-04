import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDb } from "../src/lib/db";
import { lockMembershipUser } from "../src/lib/ai-entitlements";
import { claimProjectJob } from "../src/lib/project-workflow";
import { stableAiCallKey, auditedProviderCall, WEB_AI_TRANSFER_CONSENT_VERSION } from "../src/lib/web-ai-governance";
import { WebAiAccessError, type WebAiActor } from "../src/lib/web-ai-access";
import { grantProjectMembership, grantWorkspaceMembership, revokeProjectMembership } from "../src/lib/membership-governance";

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
  const grantId = randomUUID();
  const jobId = randomUUID();
  const actor: WebAiActor = { id: userId, role: "user" };
  const now = new Date();

  await db.appUser.create({ data: { id: userId, username: `dispatch_${suffix}`, role: "user" } });
  await db.workspace.create({ data: { id: workspaceId, name: `Dispatch ${suffix}`, slug: `dispatch-${suffix}`, createdById: userId } });
  await db.project.create({ data: { id: projectId, workspaceId, name: `Dispatch project ${suffix}`, slug: `dispatch-project-${suffix}` } });
  await db.$transaction(async (tx) => {
    await grantWorkspaceMembership(tx, { workspaceId, userId, role: "owner", actorId: userId, reason: "web_ai_governance_fixture_workspace" });
    await grantProjectMembership(tx, { projectId, workspaceId, userId, role: "owner", actorId: userId, reason: "web_ai_governance_fixture_project" });
  });
  await db.membershipSubscription.create({
    data: {
      userId,
      status: "active",
      startsAt: new Date(now.getTime() - 60_000),
      expiresAt: new Date(now.getTime() + 86_400_000),
    },
  });
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
      scope: "workspace",
      workspaceId,
      ownerUserId: userId,
      ownershipState: "confirmed",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      credentialId,
      defaultGenerationModelId: "glm-4-flash",
      status: "verified",
      lastTestedAt: now,
    },
  });
  const route = await db.projectAiRoute.create({
    data: {
      projectId,
      operation: "autoExtract",
      providerConnectionId: provider.id,
      modelId: "glm-4-flash",
      maxOutputTokens: 64,
    },
    include: { providerConnection: true },
  });
  const grant = await db.webAiGrant.create({
    data: {
      id: grantId,
      projectId,
      operation: "autoExtract",
      scopeKind: "projectSources",
      scopeIds: {},
      manifestFingerprint: "e".repeat(64),
      providerConnectionId: provider.id,
      modelId: route.modelId,
      consentVersion: WEB_AI_TRANSFER_CONSENT_VERSION,
      issuedById: userId,
      billingMode: "byok",
      billingUserId: userId,
      expiresAt: new Date(now.getTime() + 86_400_000),
    },
  });
  const job = await db.backgroundJob.create({
    data: {
      id: jobId,
      projectId,
      kind: "autoExtract",
      requestedById: userId,
      webAiGrantId: grant.id,
      idempotencyKey: "f".repeat(64),
      payload: {},
    },
  });
  const claim = await claimProjectJob(job.id, db);
  assert.notEqual(claim, false);
  if (claim === false) throw new Error("dispatch fixture claim failed");
  return Object.freeze({ db, actor, projectId, workspaceId, userId, providerId, credentialId, jobId, route, claim });
}

async function cleanupDispatchFixture(fixture: Awaited<ReturnType<typeof createDispatchFixture>>): Promise<void> {
  const { db, projectId, workspaceId, userId, providerId, credentialId, jobId } = fixture;
  await db.providerCallAudit.deleteMany({ where: { jobId } });
  await db.backgroundJob.deleteMany({ where: { id: jobId } });
  await db.webAiGrant.deleteMany({ where: { projectId } });
  await db.projectAiRoute.deleteMany({ where: { projectId } });
  await db.aiProviderConnection.deleteMany({ where: { id: providerId } });
  await db.externalCredential.deleteMany({ where: { id: credentialId } });
  await db.membershipSubscription.deleteMany({ where: { userId } });
  await db.project.deleteMany({ where: { id: projectId } });
  await db.workspace.deleteMany({ where: { id: workspaceId } });
  await db.appUser.deleteMany({ where: { id: userId } });
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
        route: revokeFixture.route,
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
        route: admissionFixture.route,
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
