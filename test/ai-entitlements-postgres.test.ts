import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProviderConnection } from "../src/lib/ai-providers";
import {
  holdPlatformTokenReservation,
  issueVerifiedSignupGrant,
  recoverExpiredPlatformTokenReservations,
  releasePlatformTokenReservation,
  reservePlatformTokens,
  settlePlatformTokenReservation,
} from "../src/lib/ai-entitlements";
import { getDb } from "../src/lib/db";
import {
  createWorkspaceProviderConnection,
  assertWorkspaceProviderOutbound,
  deleteWorkspaceProviderConnection,
  listWorkspaceProviderConnections,
  testWorkspaceProviderConnection,
  updateWorkspaceProviderConnection,
  WorkspaceProviderServiceError,
} from "../src/lib/workspace-provider-service";
import { revokeMembership } from "../src/lib/membership-service";

const shouldRun = process.env.AI_ENTITLEMENTS_POSTGRES_GATE === "1";

test("AI entitlements enforce signup-compatible scope, workspace BYOK ownership and project cleanup retention", {
  skip: !shouldRun ? "AI_ENTITLEMENTS_POSTGRES_GATE=1 is required" : false,
}, async () => {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const keyDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-entitlements-"));
  const previousKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
  process.env.AI_PROJECT_OS_MASTER_KEY_FILE = join(keyDirectory, "master.key");
  const workspaceId = randomUUID();
  const adminId = randomUUID();
  const ownerId = randomUUID();
  const workspaceAdminId = randomUUID();
  const outsiderId = randomUUID();
  const projectId = randomUUID();
  const createdProviderIds: string[] = [];
  const createdCredentialIds: string[] = [];
  const grantIds: string[] = [];
  const reservationIds: string[] = [];
  const auditIds: string[] = [];
  const jobIds: string[] = [];
  try {
    await db.appUser.createMany({
      data: [
        { id: adminId, username: `entitlement_admin_${suffix}`, role: "admin" },
        { id: ownerId, username: `entitlement_owner_${suffix}`, role: "member" },
        { id: workspaceAdminId, username: `entitlement_workspace_admin_${suffix}`, role: "member" },
        { id: outsiderId, username: `entitlement_outsider_${suffix}`, role: "member" },
      ],
    });
    await db.workspace.create({ data: { id: workspaceId, name: `Entitlements ${suffix}`, slug: `entitlements-${suffix}`, createdById: adminId } });
    await db.workspaceMembership.createMany({
      data: [
        { id: randomUUID(), workspaceId, userId: ownerId, role: "owner" },
        { id: randomUUID(), workspaceId, userId: workspaceAdminId, role: "admin" },
      ],
    });
    await db.membershipSubscription.create({
      data: {
        userId: ownerId,
        status: "active",
        startsAt: new Date("2026-08-01T00:00:00.000Z"),
        expiresAt: new Date("2026-10-01T00:00:00.000Z"),
        grantedById: adminId,
      },
    });

    // Exercise the actual serializable signup grant and billing ledger path,
    // including the retry/idempotency boundary used by verified auth flows.
    const entitlementNow = new Date("2026-09-02T00:00:00.000Z");
    const signupGrant = await issueVerifiedSignupGrant(ownerId, { now: entitlementNow }, db);
    const signupReplay = await issueVerifiedSignupGrant(ownerId, { now: new Date(entitlementNow.getTime() + 1_000) }, db);
    assert.equal(signupReplay.id, signupGrant.id);
    assert.equal(signupReplay.amount, 500_000);
    const signupLedger = await db.platformTokenLedgerEntry.findUnique({ where: { idempotencyKey: `grant:signup:${ownerId}` }, select: { id: true, amount: true } });
    assert.ok(signupLedger);
    assert.equal(signupLedger.amount, 500_000);
    grantIds.push(signupGrant.id);

    const settledKey = `gate:${suffix}:real-settle`;
    const settledReservation = await reservePlatformTokens({ userId: ownerId, callKey: settledKey, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 100, now: entitlementNow }, db);
    assert.equal(settledReservation.created, true);
    reservationIds.push(settledReservation.reservationId);
    const settledReplay = await reservePlatformTokens({ userId: ownerId, callKey: settledKey, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 1, now: entitlementNow }, db);
    assert.equal(settledReplay.created, false);
    const settledResult = await settlePlatformTokenReservation({ userId: ownerId, callKey: settledKey, actualTokens: 40, usageKnown: true, now: entitlementNow }, db);
    assert.equal(settledResult.status, "settled");
    const settledGrant = await db.platformTokenGrant.findUniqueOrThrow({ where: { id: signupGrant.id }, select: { remainingTokens: true } });
    assert.equal(settledGrant.remainingTokens, 499_960);

    const releasedKey = `gate:${suffix}:real-release`;
    const releasedReservation = await reservePlatformTokens({ userId: ownerId, callKey: releasedKey, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 50, now: entitlementNow }, db);
    reservationIds.push(releasedReservation.reservationId);
    assert.equal((await releasePlatformTokenReservation({ userId: ownerId, callKey: releasedKey, now: entitlementNow }, db))?.status, "released");

    const heldKey = `gate:${suffix}:real-held`;
    const heldReservation = await reservePlatformTokens({ userId: ownerId, callKey: heldKey, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 40, now: entitlementNow }, db);
    reservationIds.push(heldReservation.reservationId);
    assert.equal((await settlePlatformTokenReservation({ userId: ownerId, callKey: heldKey, usageKnown: false, now: entitlementNow }, db)).status, "held");
    assert.equal((await holdPlatformTokenReservation({ userId: ownerId, callKey: heldKey, now: entitlementNow }, db))?.status, "held");

    const expiredKey = `gate:${suffix}:expired-release`;
    const expiredReservation = await reservePlatformTokens({ userId: ownerId, callKey: expiredKey, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 30, now: entitlementNow }, db);
    reservationIds.push(expiredReservation.reservationId);
    assert.deepEqual(await recoverExpiredPlatformTokenReservations({ userId: ownerId, now: new Date("2026-09-02T02:00:00.000Z") }, db), { inspected: 1, released: 1, held: 0 });
    assert.deepEqual(await recoverExpiredPlatformTokenReservations({ userId: ownerId, now: new Date("2026-09-02T03:00:00.000Z") }, db), { inspected: 0, released: 0, held: 0 });

    await assert.rejects(
      () => createWorkspaceProviderConnection(workspaceId, { name: `Denied ${suffix}`, kind: "deepseek", apiKey: "deepseek-denied-key", generationModelId: "deepseek-custom" }, { id: outsiderId, role: "member" }, db),
      (error: unknown) => error instanceof WorkspaceProviderServiceError && error.code === "AI_PROVIDER_SCOPE_FORBIDDEN",
    );
    await assert.rejects(
      () => listWorkspaceProviderConnections(workspaceId, { id: adminId, role: "admin" }, db),
      (error: unknown) => error instanceof WorkspaceProviderServiceError && error.code === "AI_PROVIDER_SCOPE_FORBIDDEN",
    );
    await assert.rejects(
      () => createWorkspaceProviderConnection(workspaceId, { name: `Denied system admin ${suffix}`, kind: "deepseek", apiKey: "deepseek-denied-system-key", generationModelId: "deepseek-custom" }, { id: adminId, role: "admin" }, db),
      (error: unknown) => error instanceof WorkspaceProviderServiceError && error.code === "AI_PROVIDER_SCOPE_FORBIDDEN",
    );
    await assert.rejects(
      () => createWorkspaceProviderConnection(workspaceId, { name: `Denied admin ${suffix}`, kind: "deepseek", apiKey: "deepseek-denied-admin-key", generationModelId: "deepseek-custom" }, { id: workspaceAdminId, role: "member" }, db),
      (error: unknown) => error instanceof WorkspaceProviderServiceError && error.code === "AI_MEMBERSHIP_REQUIRED",
    );

    const deepseek = await createWorkspaceProviderConnection(workspaceId, {
      name: `Workspace DeepSeek ${suffix}`,
      kind: "deepseek",
      apiKey: "deepseek-workspace-key",
      generationModelId: "deepseek-custom-model",
      visionModelId: null,
    }, { id: ownerId, role: "member" }, db);
    createdProviderIds.push(deepseek.id);
    const deepseekRecord = await db.aiProviderConnection.findUniqueOrThrow({ where: { id: deepseek.id }, select: { credentialId: true } });
    createdCredentialIds.push(deepseekRecord.credentialId);
    assert.equal(deepseek.scope, "workspace");
    assert.equal(deepseek.ownerUserId, ownerId);
    assert.equal(deepseek.defaultGenerationModelId, "deepseek-custom-model");
    const verifiedDeepseek = await db.aiProviderConnection.update({ where: { id: deepseek.id }, data: { status: "verified", lastTestedAt: entitlementNow } });
    await assert.rejects(
      () => assertWorkspaceProviderOutbound(workspaceId, deepseek.id, { id: adminId, role: "admin" }, db),
      (error: unknown) => error instanceof WorkspaceProviderServiceError && error.code === "AI_PROVIDER_SCOPE_FORBIDDEN",
    );

    const updated = await updateWorkspaceProviderConnection(workspaceId, deepseek.id, {
      generationModelId: "deepseek-custom-model-v2",
      expectedUpdatedAt: verifiedDeepseek.updatedAt.toISOString(),
    }, { id: ownerId, role: "member" }, db);
    assert.equal(updated.defaultGenerationModelId, "deepseek-custom-model-v2");
    await assert.rejects(
      () => updateWorkspaceProviderConnection(workspaceId, deepseek.id, { generationModelId: "cross-owner-model" }, { id: workspaceAdminId, role: "member" }, db),
      (error: unknown) => error instanceof WorkspaceProviderServiceError && error.code === "AI_PROVIDER_OWNER_REQUIRED",
    );
    await assert.rejects(
      () => listWorkspaceProviderConnections(workspaceId, { id: outsiderId, role: "member" }, db),
      (error: unknown) => error instanceof WorkspaceProviderServiceError && error.code === "AI_PROVIDER_SCOPE_FORBIDDEN",
    );
    assert.equal((await listWorkspaceProviderConnections(workspaceId, { id: ownerId, role: "member" }, db)).length, 1);

    await db.aiProviderConnection.update({ where: { id: deepseek.id }, data: { status: "disabled", disabledAt: new Date() } });
    await assert.rejects(
      () => testWorkspaceProviderConnection(workspaceId, deepseek.id, { id: outsiderId, role: "member" }, db),
      (error: unknown) => error instanceof WorkspaceProviderServiceError && error.code === "AI_PROVIDER_SCOPE_FORBIDDEN",
    );
    await assert.rejects(
      () => testWorkspaceProviderConnection(workspaceId, deepseek.id, { id: ownerId, role: "member" }, db),
      (error: unknown) => error instanceof WorkspaceProviderServiceError && error.code === "AI_PROVIDER_CONNECTION_UNAVAILABLE",
    );

    await db.membershipSubscription.update({ where: { userId: ownerId }, data: { expiresAt: new Date("2026-08-02T00:00:00.000Z") } });
    await assert.rejects(
      () => updateWorkspaceProviderConnection(workspaceId, deepseek.id, { generationModelId: "blocked-after-expiry" }, { id: ownerId, role: "member" }, db),
      (error: unknown) => error instanceof WorkspaceProviderServiceError && error.code === "AI_MEMBERSHIP_EXPIRED",
    );
    await assert.rejects(
      () => updateWorkspaceProviderConnection(workspaceId, deepseek.id, { enabled: false, apiKey: "replacement-key" }, { id: ownerId, role: "member" }, db),
      (error: unknown) => error instanceof WorkspaceProviderServiceError && error.code === "AI_MEMBERSHIP_EXPIRED",
    );
    const disabled = await updateWorkspaceProviderConnection(workspaceId, deepseek.id, { enabled: false }, { id: ownerId, role: "member" }, db);
    assert.equal(disabled.status, "disabled");
    // The expiry check above is intentionally covered before continuing with
    // the remaining lifecycle assertions. Restore the fixture's membership
    // window so the owner can create the independent GLM embedding-only
    // connection below.
    await db.membershipSubscription.update({ where: { userId: ownerId }, data: { expiresAt: new Date("2026-10-01T00:00:00.000Z") } });

    const glm = await createWorkspaceProviderConnection(workspaceId, {
      name: `Workspace GLM ${suffix}`,
      kind: "glm",
      apiKey: "glm-workspace-key",
      generationModelId: null,
      embeddingModelId: "embedding-3",
      embeddingDimensions: 1024,
      visionModelId: null,
    }, { id: ownerId, role: "member" }, db);
    createdProviderIds.push(glm.id);
    const glmRecord = await db.aiProviderConnection.findUniqueOrThrow({ where: { id: glm.id }, select: { credentialId: true, defaultGenerationModelId: true, defaultEmbeddingModelId: true, embeddingDimensions: true } });
    createdCredentialIds.push(glmRecord.credentialId);
    assert.equal(glmRecord.defaultGenerationModelId, null);
    assert.equal(glmRecord.defaultEmbeddingModelId, "embedding-3");
    assert.equal(glmRecord.embeddingDimensions, 1024);
    await assert.rejects(
      () => deleteWorkspaceProviderConnection(workspaceId, glm.id, { confirmationName: glm.name }, { id: ownerId, role: "member" }, db),
      (error: unknown) => error instanceof WorkspaceProviderServiceError && error.code === "AI_PROVIDER_DELETE_REQUIRES_DISABLED",
    );
    await updateWorkspaceProviderConnection(workspaceId, glm.id, { enabled: false }, { id: ownerId, role: "member" }, db);
    await deleteWorkspaceProviderConnection(workspaceId, glm.id, { confirmationName: glm.name }, { id: ownerId, role: "member" }, db);
    createdProviderIds.splice(createdProviderIds.indexOf(glm.id), 1);
    createdCredentialIds.splice(createdCredentialIds.indexOf(glmRecord.credentialId), 1);
    assert.equal(await db.aiProviderConnection.count({ where: { id: glm.id } }), 0);

    // The owner lock must cover the complete bounded provider probe. This
    // barrier proves a revoke started after the test fence cannot commit until
    // the probe and final provider CAS have completed; the follow-up call then
    // proves revoke-first fails before another fetch.
    await updateWorkspaceProviderConnection(workspaceId, deepseek.id, { enabled: true }, { id: ownerId, role: "member" }, db);
    const originalProviderFetch = globalThis.fetch;
    let fetchCount = 0;
    let signalFetchStarted = () => {};
    const fetchStarted = new Promise<void>((resolve) => { signalFetchStarted = resolve; });
    let releaseFetch = () => {};
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    globalThis.fetch = async () => {
      fetchCount += 1;
      signalFetchStarted();
      await fetchGate;
      return Response.json({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }, { headers: { "x-request-id": "workspace-probe" } });
    };
    try {
      const testing = testWorkspaceProviderConnection(workspaceId, deepseek.id, { id: ownerId, role: "member" }, db);
      await Promise.race([
        fetchStarted,
        testing.then(() => { throw new Error("provider test completed before fetch barrier"); }, (error) => { throw error; }),
      ]);
      let revokeSettled = false;
      const revokeStartedAt = Date.now();
      const revoking = revokeMembership({ adminUserId: adminId, userId: ownerId }, db).finally(() => { revokeSettled = true; });
      // Keep the probe open beyond Prisma's five-second default interactive
      // transaction timeout. The owner lock must remain held until the
      // bounded provider probe and final CAS have completed.
      await new Promise((resolve) => setTimeout(resolve, 5_200));
      assert.equal(revokeSettled, false);
      assert.ok(Date.now() - revokeStartedAt >= 5_000);
      releaseFetch();
      const tested = await testing;
      const revoked = await revoking;
      assert.equal(tested.provider.status, "verified");
      assert.equal(revoked.status, "revoked");

      globalThis.fetch = async () => {
        fetchCount += 1;
        throw new Error("revoke-first provider test must not dispatch");
      };
      await assert.rejects(
        () => testWorkspaceProviderConnection(workspaceId, deepseek.id, { id: ownerId, role: "member" }, db),
        (error: unknown) => error instanceof WorkspaceProviderServiceError && error.code === "AI_MEMBERSHIP_REQUIRED",
      );
      assert.equal(fetchCount, 1);
    } finally {
      releaseFetch();
      globalThis.fetch = originalProviderFetch;
    }

    await db.project.create({ data: { id: projectId, name: `Entitlement project ${suffix}`, slug: `entitlement-project-${suffix}`, workspaceId } });
    const grant = await db.platformTokenGrant.create({ data: { userId: ownerId, kind: "manual", amount: 100, remainingTokens: 100, offerVersion: "gate", expiresAt: new Date("2026-10-01T00:00:00.000Z") } });
    grantIds.push(grant.id);
    const reservation = await db.platformTokenReservation.create({ data: { userId: ownerId, grantId: grant.id, jobId: randomUUID(), callKey: `gate:${suffix}:retention`, operation: "autoExtract", modelId: "deepseek-v4-flash", reservedTokens: 10, expiresAt: new Date("2026-10-01T00:00:00.000Z") } });
    reservationIds.push(reservation.id);
    const ledger = await db.platformTokenLedgerEntry.create({ data: { userId: ownerId, grantId: grant.id, reservationId: reservation.id, entryKind: "reserve", amount: -10, reasonCode: "GATE", idempotencyKey: `gate:${suffix}:ledger` } });
    const provider = await createProviderConnection({ name: `Retention DeepSeek ${suffix}`, kind: "deepseek", apiKey: "deepseek-retention-key", generationModelId: "deepseek-v4-flash", visionModelId: null, embeddingModelId: null, embeddingDimensions: null }, db);
    createdProviderIds.push(provider.id);
    createdCredentialIds.push((await db.aiProviderConnection.findUniqueOrThrow({ where: { id: provider.id }, select: { credentialId: true } })).credentialId);
    const job = await db.backgroundJob.create({ data: { id: randomUUID(), projectId, kind: "autoExtract", idempotencyKey: "a".repeat(64), requestedById: ownerId, payload: {} } });
    jobIds.push(job.id);
    const audit = await db.providerCallAudit.create({ data: { jobId: job.id, providerConnectionId: provider.id, operation: "autoExtract", modelId: "deepseek-v4-flash", billingMode: "platform", billingUserId: ownerId, callKey: `gate:${suffix}:call`, status: "running", reservationId: reservation.id } });
    auditIds.push(audit.id);
    await db.project.delete({ where: { id: projectId } });
    assert.equal(await db.backgroundJob.count({ where: { id: job.id } }), 0);
    const retainedAudit = await db.providerCallAudit.findUniqueOrThrow({ where: { id: audit.id }, select: { jobId: true } });
    assert.equal(retainedAudit.jobId, null);
    assert.equal(await db.platformTokenReservation.count({ where: { id: reservation.id } }), 1);
    assert.equal(await db.platformTokenLedgerEntry.count({ where: { id: ledger.id } }), 1);
  } finally {
    if (auditIds.length > 0) await db.providerCallAudit.deleteMany({ where: { id: { in: auditIds } } });
    if (jobIds.length > 0) await db.backgroundJob.deleteMany({ where: { id: { in: jobIds } } });
    await db.project.deleteMany({ where: { id: projectId } });
    // The owner is a fresh gate fixture, so deleting by its user id also
    // removes signup/settlement/release/hold entries created above.
    await db.platformTokenLedgerEntry.deleteMany({ where: { userId: ownerId } });
    if (reservationIds.length > 0) await db.platformTokenReservation.deleteMany({ where: { id: { in: reservationIds } } });
    if (grantIds.length > 0) await db.platformTokenGrant.deleteMany({ where: { id: { in: grantIds } } });
    if (createdProviderIds.length > 0) await db.aiProviderConnection.deleteMany({ where: { id: { in: createdProviderIds } } });
    if (createdCredentialIds.length > 0) await db.externalCredential.deleteMany({ where: { id: { in: createdCredentialIds } } });
    await db.membershipSubscriptionAudit.deleteMany({ where: { userId: ownerId } });
    await db.membershipSubscription.deleteMany({ where: { userId: ownerId } });
    await db.workspaceMembership.deleteMany({ where: { workspaceId } });
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    await db.appUser.deleteMany({ where: { id: { in: [adminId, ownerId, workspaceAdminId, outsiderId] } } });
    if (previousKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyPath;
    await rm(keyDirectory, { recursive: true, force: true });
  }
});
