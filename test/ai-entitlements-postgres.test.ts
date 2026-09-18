import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AiEntitlementError,
  holdPlatformTokenReservation,
  recoverExpiredPlatformTokenReservations,
  releasePlatformTokenReservation,
  reservePlatformTokens,
  settlePlatformTokenReservation,
} from "../src/lib/ai-entitlements";
import { getDb } from "../src/lib/db";
import { grantWorkspaceMembership } from "../src/lib/membership-governance";
import {
  executePlatformTokenGrantMutation,
  previewPlatformTokenGrantMutation,
} from "../src/lib/platform-credit-governance-service";
import { createSignupOfferFixture } from "./platform-grant-offer-policy-fixture";
import { activateCanonicalSignupGrant } from "./account-entitlement-test-helper";
import { createVerifiedProviderFixture } from "./platform-provider-fixture";

const shouldRun = process.env.AI_ENTITLEMENTS_POSTGRES_GATE === "1";
type GovernancePreview = Awaited<ReturnType<typeof previewPlatformTokenGrantMutation>>;

function governanceExecuteInput(preview: GovernancePreview, confirmationUsername: string): Record<string, unknown> {
  return {
    action: preview.action, userId: preview.target.id, grantId: preview.grant.id,
    amount: preview.action === "grant" ? preview.grant.amount : null,
    expiresAt: preview.action === "grant" ? preview.grant.expiresAt?.toISOString() ?? null : null,
    previewId: preview.previewId, expectedVersion: preview.expectedVersion,
    expectedRemainingTokens: preview.expectedRemainingTokens,
    impactFingerprint: preview.impactFingerprint, requestFingerprint: preview.requestFingerprint,
    requestKey: preview.requestKey, reason: preview.reason,
    previewIssuedAt: preview.issuedAt.toISOString(), previewExpiresAt: preview.expiresAt.toISOString(),
    confirmation: true, confirmationUsername,
  };
}

test("AI entitlements enforce signup-compatible scope and project cleanup retention", {
  skip: !shouldRun ? "AI_ENTITLEMENTS_POSTGRES_GATE=1 is required" : false,
}, async () => {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const keyDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-entitlements-"));
  const previousKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
  process.env.AI_PROJECT_OS_MASTER_KEY_FILE = join(keyDirectory, "master.key");
  const workspaceId = randomUUID();
  const adminId = randomUUID();
  const adminActor = { id: adminId, role: "admin" as const, accountAccessVersion: 1 };
  const ownerId = randomUUID();
  const retentionUserId = randomUUID();
  const retentionUsername = `entitlement_retention_${suffix}`;
  const projectId = randomUUID();
  const createdProviderIds: string[] = [];
  const createdCredentialIds: string[] = [];
  const auditIds: string[] = [];
  const jobIds: string[] = [];
  try {
    await db.appUser.createMany({
      data: [
        { id: adminId, username: `entitlement_admin_${suffix}`, role: "admin" },
        { id: ownerId, username: `entitlement_owner_${suffix}`, role: "user" },
        { id: retentionUserId, username: retentionUsername, role: "user" },
      ],
    });
    await createSignupOfferFixture(db, adminId);
    await db.$transaction(async (tx) => {
      await tx.workspace.create({ data: { id: workspaceId, name: `Entitlements ${suffix}`, slug: `entitlements-${suffix}`, createdById: adminId } });
      await grantWorkspaceMembership(tx, {
        workspaceId,
        userId: adminId,
        role: "owner",
        actorId: adminId,
        reason: "ai_entitlements_gate_workspace_owner",
      });
    });
    // Exercise the actual serializable signup grant and billing ledger path,
    // including the retry/idempotency boundary used by verified auth flows.
    const entitlementNow = new Date();
    const signupGrant = await activateCanonicalSignupGrant(db, { userId: ownerId, actorId: adminId, now: entitlementNow });
    const signupReplay = await activateCanonicalSignupGrant(db, { userId: ownerId, actorId: adminId, now: new Date(entitlementNow.getTime() + 1_000) });
    assert.equal(signupReplay.id, signupGrant.id);
    assert.equal(signupReplay.amount, 500_000);
    const signupLedger = await db.platformTokenLedgerEntry.findUnique({ where: { idempotencyKey: `grant:signup:${ownerId}:signup-500k-v1` }, select: { id: true, amount: true } });
    assert.ok(signupLedger);
    assert.equal(signupLedger.amount, 500_000);

    const settledKey = `gate:${suffix}:real-settle`;
    const settledReservation = await reservePlatformTokens({ userId: ownerId, callKey: settledKey, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 100, now: entitlementNow }, db);
    assert.equal(settledReservation.created, true);
    const settledReplay = await reservePlatformTokens({ userId: ownerId, callKey: settledKey, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 100, now: entitlementNow }, db);
    assert.equal(settledReplay.created, false);
    await assert.rejects(
      () => reservePlatformTokens({ userId: ownerId, callKey: settledKey, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 1, now: entitlementNow }, db),
      (error: unknown) => error instanceof AiEntitlementError && error.code === "AI_ROUTE_CONFIGURATION_FORBIDDEN",
    );
    const settledResult = await settlePlatformTokenReservation({ userId: ownerId, callKey: settledKey, actualTokens: 40, usageKnown: true, now: entitlementNow }, db);
    assert.equal(settledResult.status, "settled");
    const settledGrant = await db.platformTokenGrant.findUniqueOrThrow({ where: { id: signupGrant.id }, select: { remainingTokens: true } });
    assert.equal(settledGrant.remainingTokens, 499_960);

    const releasedKey = `gate:${suffix}:real-release`;
    await reservePlatformTokens({ userId: ownerId, callKey: releasedKey, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 50, now: entitlementNow }, db);
    assert.equal((await releasePlatformTokenReservation({ userId: ownerId, callKey: releasedKey, now: entitlementNow }, db))?.status, "released");

    const heldKey = `gate:${suffix}:real-held`;
    await reservePlatformTokens({ userId: ownerId, callKey: heldKey, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 40, now: entitlementNow }, db);
    assert.equal((await settlePlatformTokenReservation({ userId: ownerId, callKey: heldKey, usageKnown: false, now: entitlementNow }, db)).status, "held");
    assert.equal((await holdPlatformTokenReservation({ userId: ownerId, callKey: heldKey, now: entitlementNow }, db))?.status, "held");

    const expiredKey = `gate:${suffix}:expired-release`;
    await reservePlatformTokens({ userId: ownerId, callKey: expiredKey, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 30, now: entitlementNow }, db);
    assert.deepEqual(await recoverExpiredPlatformTokenReservations({ userId: ownerId, now: new Date(entitlementNow.getTime() + 2 * 60 * 60 * 1_000) }, db), { inspected: 1, released: 1, held: 0 });
    assert.deepEqual(await recoverExpiredPlatformTokenReservations({ userId: ownerId, now: new Date(entitlementNow.getTime() + 3 * 60 * 60 * 1_000) }, db), { inspected: 0, released: 0, held: 0 });

    await db.project.create({ data: { id: projectId, name: `Entitlement project ${suffix}`, slug: `entitlement-project-${suffix}`, workspaceId } });
    const grantPreview = await previewPlatformTokenGrantMutation({ action: "grant", userId: retentionUserId, amount: 100, expiresAt: new Date("2026-10-01T00:00:00.000Z").toISOString(), requestKey: `grant-retention-${suffix}`, reason: "retention gate fixture" }, adminActor, db);
    const governedGrant = await executePlatformTokenGrantMutation(governanceExecuteInput(grantPreview, retentionUsername), adminActor, db);
    const retentionJobId = randomUUID();
    const retained = await reservePlatformTokens({ userId: retentionUserId, jobId: retentionJobId, callKey: `gate:${suffix}:retention`, operation: "autoExtract", modelId: "deepseek-v4-flash", estimatedTokens: 10, now: entitlementNow }, db);
    const reservation = await db.platformTokenReservation.findUniqueOrThrow({ where: { id: retained.reservationId } });
    const ledger = await db.platformTokenLedgerEntry.findFirstOrThrow({ where: { reservationId: reservation.id, entryKind: "reserve", grantId: governedGrant.grantId } });
    const provider = await createVerifiedProviderFixture({ name: `Retention DeepSeek ${suffix}`, kind: "deepseek", apiKey: "deepseek-retention-key", generationModelId: "deepseek-v4-flash", visionModelId: null, embeddingModelId: null, embeddingDimensions: null }, adminActor, db);
    createdProviderIds.push(provider.id);
    createdCredentialIds.push((await db.aiProviderConnection.findUniqueOrThrow({ where: { id: provider.id }, select: { credentialId: true } })).credentialId);
    const job = await db.backgroundJob.create({ data: { id: randomUUID(), projectId, kind: "autoExtract", idempotencyKey: "a".repeat(64), requestedById: ownerId, payload: {} } });
    jobIds.push(job.id);
    const audit = await db.providerCallAudit.create({ data: { jobId: job.id, providerConnectionId: provider.id, operation: "autoExtract", modelId: "deepseek-v4-flash", billingMode: "platform", billingUserId: retentionUserId, callKey: `gate:${suffix}:call`, status: "running", reservationId: reservation.id } });
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
    // Reservation allocations and their parent grant/ledger facts are
    // append-only audit evidence. The isolated gate runner owns their final
    // database teardown, so this test must not bypass those retention guards.
    if (createdProviderIds.length > 0) await db.aiProviderConnection.deleteMany({ where: { id: { in: createdProviderIds } } });
    if (createdCredentialIds.length > 0) await db.externalCredential.deleteMany({ where: { id: { in: createdCredentialIds } } });
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    if (previousKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyPath;
    await rm(keyDirectory, { recursive: true, force: true });
  }
});
