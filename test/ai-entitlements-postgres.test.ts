import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProviderConnection } from "../src/lib/ai-providers";
import {
  AiEntitlementError,
  holdPlatformTokenReservation,
  issueVerifiedSignupGrant,
  recoverExpiredPlatformTokenReservations,
  releasePlatformTokenReservation,
  reservePlatformTokens,
  settlePlatformTokenReservation,
} from "../src/lib/ai-entitlements";
import { getDb } from "../src/lib/db";
import { createSignupOfferFixture } from "./platform-grant-offer-policy-fixture";

const shouldRun = process.env.AI_ENTITLEMENTS_POSTGRES_GATE === "1";

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
        { id: ownerId, username: `entitlement_owner_${suffix}`, role: "user" },
      ],
    });
    await createSignupOfferFixture(db, adminId);
    await db.workspace.create({ data: { id: workspaceId, name: `Entitlements ${suffix}`, slug: `entitlements-${suffix}`, createdById: adminId } });
    // Exercise the actual serializable signup grant and billing ledger path,
    // including the retry/idempotency boundary used by verified auth flows.
    const entitlementNow = new Date("2026-09-02T00:00:00.000Z");
    const signupGrant = await issueVerifiedSignupGrant(ownerId, { eligibilitySource: "verifiedGithub", now: entitlementNow }, db);
    const signupReplay = await issueVerifiedSignupGrant(ownerId, { eligibilitySource: "verifiedGithub", now: new Date(entitlementNow.getTime() + 1_000) }, db);
    assert.ok(signupGrant);
    assert.ok(signupReplay);
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

    await db.project.create({ data: { id: projectId, name: `Entitlement project ${suffix}`, slug: `entitlement-project-${suffix}`, workspaceId } });
    const grant = await db.platformTokenGrant.create({ data: { userId: ownerId, kind: "manual", amount: 100, remainingTokens: 100, offerVersion: "gate", expiresAt: new Date("2026-10-01T00:00:00.000Z") } });
    grantIds.push(grant.id);
    const reservation = await db.platformTokenReservation.create({ data: { userId: ownerId, grantId: grant.id, jobId: randomUUID(), callKey: `gate:${suffix}:retention`, operation: "autoExtract", modelId: "deepseek-v4-flash", reservedTokens: 10, rawEstimatedTokens: 10, quotaMultiplierBps: 10_000, expiresAt: new Date("2026-10-01T00:00:00.000Z") } });
    reservationIds.push(reservation.id);
    const ledger = await db.platformTokenLedgerEntry.create({ data: { userId: ownerId, grantId: grant.id, reservationId: reservation.id, entryKind: "reserve", amount: -10, reasonCode: "GATE", idempotencyKey: `gate:${suffix}:ledger` } });
    const provider = await createProviderConnection({ name: `Retention DeepSeek ${suffix}`, kind: "deepseek", apiKey: "deepseek-retention-key", generationModelId: "deepseek-v4-flash", visionModelId: null, embeddingModelId: null, embeddingDimensions: null }, adminActor, db);
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
    await db.workspace.deleteMany({ where: { id: workspaceId } });
    if (previousKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyPath;
    await rm(keyDirectory, { recursive: true, force: true });
  }
});
