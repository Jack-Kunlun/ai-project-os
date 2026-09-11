import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  AiEntitlementError,
  holdPlatformTokenReservation,
  recoverExpiredPlatformTokenReservations,
  releasePlatformTokenReservation,
  reservePlatformTokens,
  settlePlatformTokenReservation,
} from "../src/lib/ai-entitlements";
import {
  executePlatformTokenGrantMutation,
  listPlatformTokenGrants,
  PlatformCreditGovernanceError,
  previewPlatformTokenGrantMutation,
} from "../src/lib/platform-credit-governance-service";
import { getDb } from "../src/lib/db";
import { initializeAdmin } from "../src/lib/auth";

const shouldRun = process.env.PLATFORM_CREDIT_GOVERNANCE_POSTGRES_GATE === "1";
type Preview = Awaited<ReturnType<typeof previewPlatformTokenGrantMutation>>;

function executeInput(preview: Preview, confirmationUsername: string): Record<string, unknown> {
  return {
    action: preview.action,
    userId: preview.target.id,
    grantId: preview.grant.id,
    amount: preview.action === "grant" ? preview.grant.amount : null,
    expiresAt: preview.action === "grant" ? preview.grant.expiresAt?.toISOString() ?? null : null,
    previewId: preview.previewId,
    expectedVersion: preview.expectedVersion,
    expectedRemainingTokens: preview.expectedRemainingTokens,
    impactFingerprint: preview.impactFingerprint,
    requestFingerprint: preview.requestFingerprint,
    requestKey: preview.requestKey,
    reason: preview.reason,
    previewIssuedAt: preview.issuedAt.toISOString(),
    previewExpiresAt: preview.expiresAt.toISOString(),
    confirmation: true,
    confirmationUsername,
  };
}

test("ENT-010 allocation FIFO and governed manual credit lifecycle pass on PostgreSQL", {
  skip: !shouldRun ? "PLATFORM_CREDIT_GOVERNANCE_POSTGRES_GATE=1 is required" : false,
}, async () => {
  const db = getDb();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const now = new Date();
  const adminBootstrap = await initializeAdmin({ username: `credit_admin_${suffix}`, password: "CreditGovernanceGatePassword_2026" }, db);
  const actor = adminBootstrap.user;
  const user = await db.appUser.create({ data: { id: randomUUID(), username: `credit_target_${suffix}`, role: "user" } });
  const missingUser = await db.appUser.create({ data: { id: randomUUID(), username: `credit_missing_${suffix}`, role: "user" } });
  const paginationPrefix = `credit_page_${suffix}`;
  const paginationUserA = await db.appUser.create({ data: { id: randomUUID(), username: `${paginationPrefix}_a`, role: "user" } });
  const paginationUserB = await db.appUser.create({ data: { id: randomUUID(), username: `${paginationPrefix}_b`, role: "user" } });
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000);

  const initialDifferences = await listPlatformTokenGrants({ search: missingUser.username, pageSize: 1 }, actor, db);
  assert.deepEqual(initialDifferences.grants, []);
  assert.deepEqual(initialDifferences.users.map((entry) => ({ id: entry.id, difference: entry.difference, availableTokens: entry.availableTokens, reservedTokens: entry.reservedTokens })), [
    { id: missingUser.id, difference: "missing", availableTokens: 0, reservedTokens: 0 },
  ]);
  const userPageOne = await listPlatformTokenGrants({ search: paginationPrefix, userPage: 1, userPageSize: 1 }, actor, db);
  const userPageTwo = await listPlatformTokenGrants({ search: paginationPrefix, userPage: 2, userPageSize: 1 }, actor, db);
  assert.deepEqual(userPageOne.users.map((entry) => entry.id), [paginationUserA.id]);
  assert.equal(userPageOne.usersHasNextPage, true);
  assert.deepEqual(userPageTwo.users.map((entry) => entry.id), [paginationUserB.id]);
  assert.equal(userPageTwo.usersHasNextPage, false);

  const forgedIssuedAt = new Date(Date.now() - 60 * 60 * 1_000);
  await assert.rejects(() => db.$executeRaw`SELECT "platform_token_governance_preview"(${JSON.stringify({
    id: randomUUID(), actorId: actor.id, userId: user.id, grantId: null, action: "grant", amount: 1,
    expiresAt: expiresAt.toISOString(), reclaimableTokens: 0, expectedVersion: user.accountAccessVersion,
    expectedRemainingTokens: null, requestKey: `forged-preview-${suffix}`, reason: "forged preview clock",
    impactFingerprint: "a".repeat(64), requestFingerprint: "b".repeat(64), issuedAt: forgedIssuedAt.toISOString(),
    previewExpiresAt: new Date(forgedIssuedAt.getTime() + 5 * 60 * 1_000).toISOString(), createdAt: forgedIssuedAt.toISOString(),
  })}::jsonb)`);

  const firstPreview = await previewPlatformTokenGrantMutation({ action: "grant", userId: user.id, amount: 40, expiresAt: expiresAt.toISOString(), requestKey: `first-grant-${suffix}`, reason: "first FIFO allocation fixture" }, actor, db);
  const firstResult = await executePlatformTokenGrantMutation(executeInput(firstPreview, user.username), actor, db);
  const firstGrant = await db.platformTokenGrant.findUniqueOrThrow({ where: { id: firstResult.grantId } });
  const secondPreview = await previewPlatformTokenGrantMutation({ action: "grant", userId: user.id, amount: 60, expiresAt: expiresAt.toISOString(), requestKey: `second-grant-${suffix}`, reason: "second FIFO allocation fixture" }, actor, db);
  const secondResult = await executePlatformTokenGrantMutation(executeInput(secondPreview, user.username), actor, db);
  const secondGrant = await db.platformTokenGrant.findUniqueOrThrow({ where: { id: secondResult.grantId } });
  const grantPageOne = await listPlatformTokenGrants({ search: user.username, grantPage: 1, grantPageSize: 1 }, actor, db);
  const grantPageTwo = await listPlatformTokenGrants({ search: user.username, grantPage: 2, grantPageSize: 1 }, actor, db);
  assert.equal(grantPageOne.grantsHasNextPage, true);
  assert.equal(grantPageOne.grants.length, 1);
  assert.equal(grantPageTwo.grants.length, 1);
  assert.notEqual(grantPageOne.grants[0]?.id, grantPageTwo.grants[0]?.id);
  const multi = await reservePlatformTokens({ userId: user.id, callKey: `ent010:${suffix}:multi`, operation: "autoExtract", modelId: "ent010-model", estimatedTokens: 70, now }, db);
  const allocations = await db.platformTokenReservationAllocation.findMany({ where: { reservationId: multi.reservationId }, orderBy: { ordinal: "asc" } });
  assert.deepEqual(allocations.map((row) => [row.grantId, row.reservedTokens]), [[firstGrant.id, 40], [secondGrant.id, 30]]);
  assert.deepEqual(await db.platformTokenGrant.findMany({ where: { id: { in: [firstGrant.id, secondGrant.id] } }, orderBy: { offerVersion: "asc" }, select: { id: true, remainingTokens: true } }), [{ id: firstGrant.id, remainingTokens: 0 }, { id: secondGrant.id, remainingTokens: 30 }]);

  const underReservedId = randomUUID();
  const underReservedCallKey = `ent010:${suffix}:under-reserved`;
  const underReservedCreatedAt = new Date();
  const reservationCountBefore = await db.platformTokenReservation.count({ where: { userId: user.id } });
  const remainingBefore = (await db.platformTokenGrant.findUniqueOrThrow({ where: { id: secondGrant.id }, select: { remainingTokens: true } })).remainingTokens;
  await assert.rejects(() => db.$executeRaw`SELECT "platform_token_runtime_apply"(
    ${"reserve"},
    ${JSON.stringify({ id: underReservedId, userId: user.id, grantId: secondGrant.id, callKey: underReservedCallKey, operation: "autoExtract", modelId: "ent010-model", status: "reserved", reservedTokens: 1, rawEstimatedTokens: 10, quotaMultiplierBps: 10_000, createdAt: underReservedCreatedAt.toISOString(), expiresAt: new Date(underReservedCreatedAt.getTime() + 30 * 60 * 1_000).toISOString() })}::jsonb,
    ${JSON.stringify([{ id: randomUUID(), grantId: secondGrant.id, ordinal: 1, reservedTokens: 1, settledTokens: 0, releasedTokens: 0 }])}::jsonb,
    ${JSON.stringify([{ id: randomUUID(), userId: user.id, grantId: secondGrant.id, reservationId: underReservedId, entryKind: "reserve", amount: -1, usageTokens: null, reasonCode: "AI_PLATFORM_TOKEN_RESERVED", metadata: { allocationOrdinal: 1 }, idempotencyKey: `reserve:${user.id}:${underReservedCallKey}` }])}::jsonb
  )`);
  assert.equal(await db.platformTokenReservation.count({ where: { userId: user.id } }), reservationCountBefore);
  assert.equal((await db.platformTokenGrant.findUniqueOrThrow({ where: { id: secondGrant.id }, select: { remainingTokens: true } })).remainingTokens, remainingBefore);

  // Runtime lifecycle writes reject a caller-selected reservation TTL before
  // touching any grant balance.
  const overlongReservationId = randomUUID();
  const overlongCallKey = `ent010:${suffix}:overlong`;
  const overlongCreatedAt = new Date();
  await assert.rejects(() => db.$executeRaw`SELECT "platform_token_runtime_apply"(
    ${"reserve"},
    ${JSON.stringify({ id: overlongReservationId, userId: user.id, grantId: firstGrant.id, callKey: overlongCallKey, operation: "autoExtract", modelId: "ent010-model", status: "reserved", reservedTokens: 1, rawEstimatedTokens: 1, quotaMultiplierBps: 10_000, createdAt: overlongCreatedAt.toISOString(), expiresAt: new Date(overlongCreatedAt.getTime() + 2 * 60 * 60 * 1_000).toISOString() })}::jsonb,
    ${JSON.stringify([{ id: randomUUID(), grantId: firstGrant.id, ordinal: 1, reservedTokens: 1, settledTokens: 0, releasedTokens: 0 }])}::jsonb,
    ${JSON.stringify([{ id: randomUUID(), userId: user.id, grantId: firstGrant.id, reservationId: overlongReservationId, entryKind: "reserve", amount: -1, usageTokens: null, reasonCode: "AI_PLATFORM_TOKEN_RESERVED", metadata: { allocationOrdinal: 1 }, idempotencyKey: `reserve:${user.id}:${overlongCallKey}` }])}::jsonb
  )`, (error: unknown) => error instanceof Error);

  // A wrong allocation ledger key and duplicate evidence are rejected without
  // changing the reservation state; the happy-path settlement follows below.
  const runtimeHoldPayload = { id: multi.reservationId, userId: user.id, callKey: `ent010:${suffix}:multi`, reservedTokens: multi.reservedTokens, safeErrorCode: "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED" };
  const runtimeHoldAllocations = allocations.map((row) => ({ id: row.id, grantId: row.grantId, ordinal: row.ordinal, reservedTokens: row.reservedTokens, settledTokens: row.settledTokens, releasedTokens: row.releasedTokens }));
  const runtimeHoldLedger = runtimeHoldAllocations.map((row) => ({ id: randomUUID(), userId: user.id, grantId: row.grantId, reservationId: multi.reservationId, entryKind: "hold", amount: 0, usageTokens: null, reasonCode: "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED", metadata: { allocationOrdinal: row.ordinal }, idempotencyKey: `hold:${user.id}:${runtimeHoldPayload.callKey}${row.ordinal === 1 ? "" : `:allocation:${row.ordinal}`}` }));
  runtimeHoldLedger[0]!.idempotencyKey = "hold:forged-key";
  await assert.rejects(() => db.$executeRaw`SELECT "platform_token_runtime_apply"(${"hold"}, ${JSON.stringify(runtimeHoldPayload)}::jsonb, ${JSON.stringify(runtimeHoldAllocations)}::jsonb, ${JSON.stringify(runtimeHoldLedger)}::jsonb)`);
  const duplicateRuntimeHoldLedger = [runtimeHoldLedger[1]!, { ...runtimeHoldLedger[1]!, id: randomUUID() }];
  await assert.rejects(() => db.$executeRaw`SELECT "platform_token_runtime_apply"(${"hold"}, ${JSON.stringify(runtimeHoldPayload)}::jsonb, ${JSON.stringify(runtimeHoldAllocations)}::jsonb, ${JSON.stringify(duplicateRuntimeHoldLedger)}::jsonb)`);

  const settled = await settlePlatformTokenReservation({ userId: user.id, callKey: `ent010:${suffix}:multi`, actualTokens: 50, usageKnown: true, now }, db);
  assert.equal(settled.status, "settled");
  const settledAllocations = await db.platformTokenReservationAllocation.findMany({ where: { reservationId: multi.reservationId }, orderBy: { ordinal: "asc" } });
  assert.deepEqual(settledAllocations.map((row) => [row.settledTokens, row.releasedTokens]), [[40, 0], [10, 20]]);
  assert.equal((await settlePlatformTokenReservation({ userId: user.id, callKey: `ent010:${suffix}:multi`, actualTokens: 50, usageKnown: true, now }, db)).status, "settled");
  assert.equal((await db.platformTokenGrant.findUniqueOrThrow({ where: { id: secondGrant.id }, select: { remainingTokens: true } })).remainingTokens, 50);

  const releaseKey = `ent010:${suffix}:release`;
  await reservePlatformTokens({ userId: user.id, callKey: releaseKey, operation: "autoExtract", modelId: "ent010-model", estimatedTokens: 30, now }, db);
  assert.equal((await releasePlatformTokenReservation({ userId: user.id, callKey: releaseKey, now }, db))?.status, "released");
  assert.equal((await releasePlatformTokenReservation({ userId: user.id, callKey: releaseKey, now }, db))?.status, "released");

  const expiredKey = `ent010:${suffix}:expired`;
  const expired = await reservePlatformTokens({ userId: user.id, callKey: expiredKey, operation: "autoExtract", modelId: "ent010-model", estimatedTokens: 10, now }, db);
  const recovery = await recoverExpiredPlatformTokenReservations({ userId: user.id, now: new Date(now.getTime() + 2 * 60 * 60 * 1_000) }, db);
  assert.ok(recovery.released >= 1);
  assert.equal((await recoverExpiredPlatformTokenReservations({ userId: user.id, now: new Date(now.getTime() + 3 * 60 * 60 * 1_000) }, db)).released, 0);
  const expiredAllocation = await db.platformTokenReservationAllocation.findMany({ where: { reservationId: expired.reservationId } });
  assert.equal(expiredAllocation[0]?.releasedTokens, 10);

  const blockedUser = await db.appUser.create({ data: { id: randomUUID(), username: `credit_blocked_${suffix}`, role: "user" } });
  const blockedGrantPreview = await previewPlatformTokenGrantMutation({ action: "grant", userId: blockedUser.id, amount: 20, expiresAt: expiresAt.toISOString(), requestKey: `blocked-grant-${suffix}`, reason: "blocked allocation fixture" }, actor, db);
  const blockedGrantResult = await executePlatformTokenGrantMutation(executeInput(blockedGrantPreview, blockedUser.username), actor, db);
  const blockedGrant = await db.platformTokenGrant.findUniqueOrThrow({ where: { id: blockedGrantResult.grantId } });
  const blockedKey = `ent010:${suffix}:blocked`;
  await reservePlatformTokens({ userId: blockedUser.id, callKey: blockedKey, operation: "autoExtract", modelId: "ent010-model", estimatedTokens: 10, now }, db);
  await assert.rejects(
    async () => {
      const preview = await previewPlatformTokenGrantMutation({ action: "revoke", grantId: blockedGrant.id, requestKey: `revoke-${suffix}`, reason: "blocked reconciliation" }, actor, db);
      assert.equal(preview.canExecute, false);
      await executePlatformTokenGrantMutation(executeInput(preview, blockedUser.username), actor, db);
    },
    (error: unknown) => error instanceof PlatformCreditGovernanceError && error.code === "PLATFORM_CREDIT_GOVERNANCE_ALLOCATION_BLOCKED",
  );
  assert.equal((await db.platformTokenGrant.findUniqueOrThrow({ where: { id: blockedGrant.id }, select: { remainingTokens: true, revokedAt: true } })).remainingTokens, 10);
  assert.equal((await holdPlatformTokenReservation({ userId: blockedUser.id, callKey: blockedKey, now }, db))?.status, "held");

  const grantRequest = { action: "grant" as const, userId: user.id, amount: 15, expiresAt: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1_000).toISOString(), requestKey: `grant-${suffix}`, reason: "customer support adjustment" };
  const grantPreview = await previewPlatformTokenGrantMutation(grantRequest, actor, db);
  assert.equal((await previewPlatformTokenGrantMutation(grantRequest, actor, db)).previewId, grantPreview.previewId);
  const clockPreview = await previewPlatformTokenGrantMutation({ ...grantRequest, amount: 2, requestKey: `clock-${suffix}`, reason: "database clock enforcement" }, actor, db);
  const clockGrantId = randomUUID();
  const clockLedgerKey = `grant:manual:${createHash("sha256").update(`${actor.id}:${clockPreview.requestKey}`, "utf8").digest("hex")}`;
  await db.$executeRaw`SELECT "platform_token_governance_apply"(${JSON.stringify({
    action: "grant", actorId: actor.id, userId: user.id, previewId: clockPreview.previewId,
    requestKey: clockPreview.requestKey, requestFingerprint: clockPreview.requestFingerprint,
    impactFingerprint: clockPreview.impactFingerprint, newGrantId: clockGrantId, ledgerId: randomUUID(),
    auditId: randomUUID(), ledgerKey: clockLedgerKey, transitionAt: "2000-01-01T00:00:00.000Z",
  })}::jsonb)`;
  const clockGrant = await db.platformTokenGrant.findUniqueOrThrow({ where: { id: clockGrantId }, select: { issuedAt: true } });
  assert.ok(Math.abs(Date.now() - clockGrant.issuedAt.getTime()) < 30_000, "governance apply must ignore a forged transitionAt");
  const forgedPreviewTime = executeInput(grantPreview, user.username);
  forgedPreviewTime.previewIssuedAt = new Date("2000-01-01T00:00:00.000Z").toISOString();
  await assert.rejects(() => executePlatformTokenGrantMutation(forgedPreviewTime, actor, db), (error: unknown) => error instanceof PlatformCreditGovernanceError && error.code === "PLATFORM_CREDIT_GOVERNANCE_PREVIEW_STALE");
  await assert.rejects(() => executePlatformTokenGrantMutation(executeInput(grantPreview, "wrong-user"), actor, db), (error: unknown) => error instanceof PlatformCreditGovernanceError && error.code === "PLATFORM_CREDIT_GOVERNANCE_CONFIRMATION_MISMATCH");
  const granted = await executePlatformTokenGrantMutation(executeInput(grantPreview, user.username), actor, db);
  assert.equal(granted.action, "grant");
  assert.equal((await executePlatformTokenGrantMutation(executeInput(grantPreview, user.username), actor, db)).replayed, true);
  const grantedAudit = await db.platformTokenGrantAudit.findFirstOrThrow({ where: { previewId: grantPreview.previewId } });
  assert.deepEqual({ event: grantedAudit.event, versionBefore: grantedAudit.versionBefore, versionAfter: grantedAudit.versionAfter, remainingAfter: grantedAudit.remainingAfter }, { event: "grant", versionBefore: 0, versionAfter: 1, remainingAfter: 15 });

  const revokePreview = await previewPlatformTokenGrantMutation({ action: "revoke", grantId: granted.grantId, requestKey: `revoke-${suffix}-success`, reason: "duplicate support adjustment" }, actor, db);
  const revoked = await executePlatformTokenGrantMutation(executeInput(revokePreview, user.username), actor, db);
  assert.equal(revoked.status, "revoked");
  const revokedGrant = await db.platformTokenGrant.findUniqueOrThrow({ where: { id: granted.grantId }, select: { amount: true, remainingTokens: true, revokedAt: true, version: true } });
  assert.deepEqual({ amount: revokedGrant.amount, remainingTokens: revokedGrant.remainingTokens, revoked: revokedGrant.revokedAt !== null, version: revokedGrant.version }, { amount: 15, remainingTokens: 0, revoked: true, version: 2 });
  assert.equal(await db.platformTokenGrantAudit.count({ where: { grantId: granted.grantId } }), 2);

  await assert.rejects(() => db.platformTokenGrantMutationPreview.delete({ where: { id: grantPreview.previewId } }));
  await assert.rejects(() => db.platformTokenGrant.create({ data: { userId: user.id, kind: "manual", amount: 3, remainingTokens: 3, offerVersion: `ent010-bypass-${suffix}`, issuedById: actor.id, expiresAt } }));
  await assert.rejects(() => db.platformTokenGrantAudit.create({ data: { grantId: granted.grantId, userId: user.id, actorId: actor.id, event: "revoke", versionBefore: 2, versionAfter: 3, statusBefore: "revoked", statusAfter: "revoked", amount: 0, remainingBefore: 0, remainingAfter: 0, previewId: grantPreview.previewId, reason: "bypass", requestKey: `bypass-${suffix}`, requestFingerprint: "a".repeat(64), impactFingerprint: "b".repeat(64) } }));
  await assert.rejects(() => reservePlatformTokens({ userId: user.id, callKey: `ent010:${suffix}:overflow`, operation: "autoExtract", modelId: "ent010-model", estimatedTokens: 1_000_001, now }, db), (error: unknown) => error instanceof AiEntitlementError && error.code === "AI_PLATFORM_TOKEN_EXHAUSTED");
});
