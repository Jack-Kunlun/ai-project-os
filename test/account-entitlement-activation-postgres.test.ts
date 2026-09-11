import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { executeAccountAccess, previewAccountAccess } from "../src/lib/account-access-service";
import { initializeAdmin } from "../src/lib/auth";
import { activateAccountEntitlements } from "../src/lib/account-entitlement-activation-service";
import {
  changePlatformGrantOfferPolicyLifecycle,
  createPlatformGrantOfferPolicy,
  listPlatformGrantOfferPolicies,
  type PlatformGrantOfferPolicyActor,
} from "../src/lib/platform-grant-offer-policy-service";
import {
  ACCOUNT_ENTITLEMENT_BACKFILL_TTL_MS,
  executeAccountEntitlementBackfill,
  previewAccountEntitlementBackfill,
} from "../src/lib/account-entitlement-backfill-service";
import { getDb } from "../src/lib/db";
import { getSystemAuditDetail, listSystemAudit } from "../src/lib/system-audit";

const shouldRun = process.env.ACCOUNT_ENTITLEMENT_ACTIVATION_POSTGRES_GATE === "1";

test(
  "account entitlement activation is immutable, concurrent, and backfill-safe",
  { skip: !shouldRun ? "ACCOUNT_ENTITLEMENT_ACTIVATION_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    try {
      const bootstrap = await initializeAdmin({ username: `entitlement_admin_${suffix}`, password: "EntitlementGatePassword_2026" }, db);
      const actor: PlatformGrantOfferPolicyActor = bootstrap.user;

      assert.equal(await db.platformGrantOfferPolicy.count({ where: { status: "active" } }), 1);
      assert.equal(await db.platformTokenGrant.count({ where: { userId: actor.id, kind: "signup" } }), 1);
      assert.equal(await db.platformTokenLedgerEntry.count({ where: { userId: actor.id, reasonCode: "AI_SIGNUP_GRANT" } }), 1);
      assert.equal(await db.accountEntitlementActivation.count({ where: { userId: actor.id, lifecycleKey: "initial_account_v1" } }), 1);

      const concurrentUser = await db.appUser.create({
        data: { id: randomUUID(), username: `entitlement_concurrent_${suffix}`, role: "user" },
      });
      const activationInput = {
        userId: concurrentUser.id,
        source: "localProvisioning" as const,
        actorId: actor.id,
        actorAccountAccessVersion: actor.accountAccessVersion,
        accountAccessVersion: concurrentUser.accountAccessVersion,
        evidenceKind: "local-provisioning",
        evidenceRef: `membership:${concurrentUser.id}`,
        now: new Date(),
      };
      const concurrent = await Promise.all([
        activateAccountEntitlements(activationInput, db),
        activateAccountEntitlements(activationInput, db),
      ]);
      assert.equal(concurrent[0]?.id, concurrent[1]?.id);
      assert.equal(concurrent[0]?.decision, "granted");
      assert.equal(await db.accountEntitlementActivation.count({ where: { userId: concurrentUser.id } }), 1);
      assert.equal(await db.accountEntitlementActivationAudit.count({ where: { userId: concurrentUser.id } }), 1);
      const concurrentAudit = await db.accountEntitlementActivationAudit.findUniqueOrThrow({ where: { activationId: concurrent[0]!.id } });
      assert.equal(concurrentAudit.action, "created");
      assert.equal(await db.platformTokenGrant.count({ where: { userId: concurrentUser.id, kind: "signup" } }), 1);
      assert.equal(await db.platformTokenLedgerEntry.count({ where: { userId: concurrentUser.id, reasonCode: "AI_SIGNUP_GRANT" } }), 1);
      const replay = await activateAccountEntitlements(activationInput, db);
      assert.equal(replay.id, concurrent[0]?.id);

      const orphanUser = await db.appUser.create({
        data: { id: randomUUID(), username: `entitlement_orphan_${suffix}`, role: "user" },
      });
      const orphanIssuedAt = new Date("2026-09-03T00:00:00.000Z");
      await assert.rejects(() => db.$transaction(async (tx) => {
        await tx.platformTokenGrant.create({
          data: {
            id: randomUUID(),
            userId: orphanUser.id,
            kind: "signup",
            amount: 500_000,
            remainingTokens: 500_000,
            offerVersion: "signup-500k-v1",
            offerAmount: 500_000,
            offerValidForDays: 30,
            eligibilityKey: "verified_identity_v1",
            eligibilitySource: "githubRegistration",
            issuedById: actor.id,
            issuedAt: orphanIssuedAt,
            expiresAt: new Date("2026-10-03T00:00:00.000Z"),
            createdAt: orphanIssuedAt,
            updatedAt: orphanIssuedAt,
          },
        });
      }));
      await assert.rejects(() => db.$transaction(async (tx) => {
        const grantId = randomUUID();
        await tx.platformTokenGrant.create({
          data: {
            id: grantId,
            userId: orphanUser.id,
            kind: "signup",
            amount: 500_000,
            remainingTokens: 500_000,
            offerVersion: "signup-500k-v1",
            offerAmount: 500_000,
            offerValidForDays: 30,
            eligibilityKey: "verified_identity_v1",
            eligibilitySource: "githubRegistration",
            issuedById: actor.id,
            issuedAt: orphanIssuedAt,
            expiresAt: new Date("2026-10-03T00:00:00.000Z"),
            createdAt: orphanIssuedAt,
            updatedAt: orphanIssuedAt,
          },
        });
        await tx.platformTokenLedgerEntry.create({
          data: {
            id: randomUUID(),
            userId: orphanUser.id,
            grantId,
            entryKind: "grant",
            amount: 500_000,
            reasonCode: "AI_SIGNUP_GRANT",
            idempotencyKey: `grant:signup:${orphanUser.id}:signup-500k-v1`,
            metadata: { offerVersion: "signup-500k-v1", eligibilityKey: "verified_identity_v1", eligibilitySource: "githubRegistration" },
            createdAt: orphanIssuedAt,
          },
        });
        await tx.$executeRaw`SELECT set_config('app.account_entitlement_activation_context', 'service-v1', true)`;
      }));
      assert.equal(await db.platformTokenGrant.count({ where: { userId: orphanUser.id, kind: "signup" } }), 0);

      const mismatchedUser = await db.appUser.create({
        data: { id: randomUUID(), username: `entitlement_mismatch_${suffix}`, role: "user" },
      });
      await assert.rejects(() => db.$transaction(async (tx) => {
        const grantId = randomUUID();
        const issuedAt = new Date("2026-09-04T00:00:00.000Z");
        await tx.platformTokenGrant.create({
          data: {
            id: grantId,
            userId: mismatchedUser.id,
            kind: "signup",
            amount: 500_000,
            remainingTokens: 500_000,
            offerVersion: "signup-500k-v1",
            offerAmount: 500_000,
            offerValidForDays: 30,
            eligibilityKey: "verified_identity_v1",
            eligibilitySource: "githubRegistration",
            issuedById: actor.id,
            issuedAt,
            expiresAt: new Date("2026-10-04T00:00:00.000Z"),
            createdAt: issuedAt,
            updatedAt: issuedAt,
          },
        });
        await tx.platformTokenLedgerEntry.create({
          data: {
            id: randomUUID(),
            userId: actor.id,
            grantId,
            entryKind: "grant",
            amount: 1,
            reasonCode: "AI_SIGNUP_GRANT",
            idempotencyKey: `grant:signup:${mismatchedUser.id}:signup-500k-v1`,
            metadata: { offerVersion: "wrong-version", eligibilityKey: "wrong-key", eligibilitySource: "githubRegistration" },
            createdAt: issuedAt,
          },
        });
      }));
      assert.equal(await db.platformTokenGrant.count({ where: { userId: mismatchedUser.id, kind: "signup" } }), 0);

      const immutableGrant = await db.platformTokenGrant.findFirstOrThrow({ where: { userId: concurrentUser.id, kind: "signup" } });
      const immutableLedger = await db.platformTokenLedgerEntry.findFirstOrThrow({ where: { grantId: immutableGrant.id, entryKind: "grant" } });
      await assert.rejects(() => db.platformTokenGrant.update({ where: { id: immutableGrant.id }, data: { amount: immutableGrant.amount + 1 } }));
      await assert.rejects(() => db.platformTokenGrant.delete({ where: { id: immutableGrant.id } }));
      await assert.rejects(() => db.platformTokenLedgerEntry.update({ where: { id: immutableLedger.id }, data: { amount: immutableLedger.amount + 1 } }));
      await assert.rejects(() => db.platformTokenLedgerEntry.delete({ where: { id: immutableLedger.id } }));
      await assert.rejects(() => db.platformTokenLedgerEntry.create({
        data: {
          id: randomUUID(),
          userId: concurrentUser.id,
          grantId: immutableGrant.id,
          entryKind: "grant",
          amount: immutableGrant.amount,
          reasonCode: "AI_SIGNUP_GRANT",
          idempotencyKey: `grant:signup:${concurrentUser.id}:duplicate`,
          metadata: { offerVersion: immutableGrant.offerVersion, eligibilityKey: immutableGrant.eligibilityKey, eligibilitySource: immutableGrant.eligibilitySource },
          createdAt: immutableGrant.issuedAt,
        },
      }));
      await assert.rejects(() => db.accountEntitlementActivationAudit.update({
        where: { id: concurrentAudit.id },
        data: { createdAt: new Date(concurrentAudit.createdAt.getTime() + 1_000) },
      }));

      const registrationSources = [
        "githubRegistration",
        "oidcRegistration",
        "oidcInvitationRegistration",
        "localProvisioning",
      ] as const;
      for (const source of registrationSources) {
        const sourceUser = await db.appUser.create({
          data: { id: randomUUID(), username: `entitlement_${source}_${suffix}`, role: "user" },
        });
        const sourceActivation = await activateAccountEntitlements({
          userId: sourceUser.id,
          source,
          actorId: actor.id,
          actorAccountAccessVersion: actor.accountAccessVersion,
          accountAccessVersion: sourceUser.accountAccessVersion,
          evidenceKind: source === "githubRegistration" ? "github" : "oidc",
          evidenceRef: `${source}:${sourceUser.id}`,
          now: new Date(),
        }, db);
        assert.equal(sourceActivation.source, source);
        assert.equal(sourceActivation.decision, "granted");
        assert.equal(await db.accountEntitlementActivation.count({ where: { userId: sourceUser.id } }), 1);
        assert.equal(await db.platformTokenGrant.count({ where: { userId: sourceUser.id, kind: "signup" } }), 1);
        assert.equal(await db.platformTokenLedgerEntry.count({ where: { userId: sourceUser.id, reasonCode: "AI_SIGNUP_GRANT" } }), 1);
      }

      const activePolicy = (await listPlatformGrantOfferPolicies(actor, db)).find((policy) => policy.status === "active");
      assert.ok(activePolicy);
      await changePlatformGrantOfferPolicyLifecycle(activePolicy.id, {
        action: "retire",
        expectedUpdatedAt: activePolicy.updatedAt.toISOString(),
        reason: "prepare no-active entitlement evidence",
      }, actor, db);

      const noOfferUser = await db.appUser.create({
        data: { id: randomUUID(), username: `entitlement_no_offer_${suffix}`, role: "user" },
      });
      const noOfferInput = {
        userId: noOfferUser.id,
        source: "oidcRegistration" as const,
        actorId: actor.id,
        actorAccountAccessVersion: actor.accountAccessVersion,
        accountAccessVersion: noOfferUser.accountAccessVersion,
        evidenceKind: "oidc-registration",
        evidenceRef: `registration:${noOfferUser.id}`,
        now: new Date(),
      };
      const noOffer = await activateAccountEntitlements(noOfferInput, db);
      assert.equal(noOffer.decision, "no_active_offer");
      const noOfferAudit = await db.accountEntitlementActivationAudit.findUniqueOrThrow({ where: { activationId: noOffer.id } });
      assert.equal(noOfferAudit.action, "created");
      assert.equal(await db.platformTokenGrant.count({ where: { userId: noOfferUser.id, kind: "signup" } }), 0);
      const noOfferReplay = await activateAccountEntitlements(noOfferInput, db);
      assert.equal(noOfferReplay.id, noOffer.id);
      assert.equal(await db.platformTokenGrant.count({ where: { userId: noOfferUser.id, kind: "signup" } }), 0);

      const noPolicyPreview = await previewAccountEntitlementBackfill(actor, db, new Date());
      assert.ok(noPolicyPreview.eligibleMissingCount >= 1);
      const noPolicyResult = await executeAccountEntitlementBackfill({
        runId: noPolicyPreview.runId,
        impactFingerprint: noPolicyPreview.impactFingerprint,
        confirmation: true,
        requestKey: randomUUID(),
        reason: "close missing offer without an active policy",
      }, actor, db, new Date());
      assert.equal(noPolicyResult.status, "stale");
      const staleRun = await db.accountEntitlementBackfillRun.findUniqueOrThrow({ where: { id: noPolicyPreview.runId } });
      assert.equal(staleRun.requestKey, null);
      assert.equal(staleRun.consumedAt, null);

      const nextPolicy = await createPlatformGrantOfferPolicy({
        offerVersion: `signup-${suffix}-v2`,
        amount: 600_000,
        validForDays: 45,
        reason: "enable controlled historical entitlement backfill",
      }, actor, db);
      await changePlatformGrantOfferPolicyLifecycle(nextPolicy.id, {
        action: "activate",
        expectedUpdatedAt: nextPolicy.updatedAt.toISOString(),
        reason: "enable controlled historical entitlement backfill",
      }, actor, db);

      const rotatedReplay = await activateAccountEntitlements(activationInput, db);
      assert.equal(rotatedReplay.id, concurrent[0]?.id);
      assert.equal(await db.platformTokenGrant.count({ where: { userId: concurrentUser.id, kind: "signup" } }), 1);
      const rotatedGrant = await db.platformTokenGrant.findFirstOrThrow({ where: { userId: concurrentUser.id, kind: "signup" } });
      assert.equal(rotatedGrant.offerVersion, "signup-500k-v1");

      const preview = await previewAccountEntitlementBackfill(actor, db, new Date());
      assert.ok(preview.impactFingerprint.length === 64);
      assert.ok(preview.eligibleMissingCount >= 1);
      assert.ok(preview.alreadyIssuedCount >= 2);
      const successfulRequestKey = randomUUID();
      const successfulReason = "confirm controlled historical entitlement backfill";
      const result = await executeAccountEntitlementBackfill({
        runId: preview.runId,
        impactFingerprint: preview.impactFingerprint,
        confirmation: true,
        requestKey: successfulRequestKey,
        reason: successfulReason,
      }, actor, db, new Date());
      assert.equal(result.status, "completed");
      assert.ok(result.grantedCount >= 1);
      assert.equal(await db.platformTokenGrant.count({ where: { userId: noOfferUser.id, kind: "signup" } }), 1);
      assert.equal(await db.accountEntitlementActivation.count({ where: { userId: noOfferUser.id } }), 1);
      assert.equal(await db.accountEntitlementActivation.count({ where: { userId: noOfferUser.id, decision: "no_active_offer" } }), 1);
      assert.equal(await db.accountEntitlementActivationAudit.count({ where: { userId: noOfferUser.id } }), 1);
      assert.equal(await db.platformTokenLedgerEntry.count({ where: { userId: noOfferUser.id, reasonCode: "AI_SIGNUP_GRANT" } }), 1);
      const noOfferItem = await db.accountEntitlementBackfillItem.findFirstOrThrow({ where: { runId: preview.runId, userId: noOfferUser.id } });
      assert.equal(noOfferItem.classification, "eligible_missing");
      assert.equal(noOfferItem.status, "applied");
      assert.ok(noOfferItem.resultGrantId);

      const backfillEvents = await listSystemAudit({ source: "accountEntitlementBackfill", pageSize: 50 }, db, new Date());

      const repeatGrantCount = await db.platformTokenGrant.count({ where: { userId: noOfferUser.id, kind: "signup" } });
      const repeatLedgerCount = await db.platformTokenLedgerEntry.count({ where: { userId: noOfferUser.id, reasonCode: "AI_SIGNUP_GRANT" } });
      const repeatActivationCount = await db.accountEntitlementActivation.count({ where: { userId: noOfferUser.id } });
      const repeatActivationAuditCount = await db.accountEntitlementActivationAudit.count({ where: { userId: noOfferUser.id } });
      const repeatPreview = await previewAccountEntitlementBackfill(actor, db, new Date());
      const repeatResult = await executeAccountEntitlementBackfill({
        runId: repeatPreview.runId,
        impactFingerprint: repeatPreview.impactFingerprint,
        confirmation: true,
        requestKey: randomUUID(),
        reason: "repeat historical entitlement backfill is already issued",
      }, actor, db, new Date());
      assert.equal(repeatResult.status, "completed");
      const repeatItem = await db.accountEntitlementBackfillItem.findFirstOrThrow({ where: { runId: repeatPreview.runId, userId: noOfferUser.id } });
      assert.equal(repeatItem.classification, "already_issued");
      assert.equal(repeatItem.status, "skipped");
      assert.equal(repeatItem.skipCode, "ACCOUNT_STATE_CHANGED");
      assert.equal(repeatItem.resultGrantId, null);
      assert.equal(repeatItem.activationId, noOffer.id);
      assert.equal(repeatItem.existingGrantId, noOfferItem.resultGrantId);
      assert.equal(await db.platformTokenGrant.count({ where: { userId: noOfferUser.id, kind: "signup" } }), repeatGrantCount);
      assert.equal(await db.platformTokenLedgerEntry.count({ where: { userId: noOfferUser.id, reasonCode: "AI_SIGNUP_GRANT" } }), repeatLedgerCount);
      assert.equal(await db.accountEntitlementActivation.count({ where: { userId: noOfferUser.id } }), repeatActivationCount);
      assert.equal(await db.accountEntitlementActivationAudit.count({ where: { userId: noOfferUser.id } }), repeatActivationAuditCount);

      await changePlatformGrantOfferPolicyLifecycle(nextPolicy.id, {
        action: "retire",
        expectedUpdatedAt: (await db.platformGrantOfferPolicy.findUniqueOrThrow({ where: { id: nextPolicy.id }, select: { updatedAt: true } })).updatedAt.toISOString(),
        reason: "prepare expiring historical entitlement backfill",
      }, actor, db);
      const ttlUserIds = [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
      ];
      const ttlUsers = await Promise.all(ttlUserIds.map((userId, index) => db.appUser.create({
        data: { id: userId, username: `entitlement_ttl_${index}_${suffix}`, role: "user" },
      })));
      const [{ now: ttlPreviewAt }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      const ttlActivations = await Promise.all(ttlUsers.map((user) => activateAccountEntitlements({
        userId: user.id,
        source: "oidcRegistration",
        actorId: actor.id,
        actorAccountAccessVersion: actor.accountAccessVersion,
        accountAccessVersion: user.accountAccessVersion,
        evidenceKind: "oidc-registration",
        evidenceRef: `registration:${user.id}`,
        now: ttlPreviewAt,
      }, db)));
      assert.deepEqual(ttlActivations.map((activation) => activation.decision), ["no_active_offer", "no_active_offer"]);
      const ttlPolicy = await createPlatformGrantOfferPolicy({
        offerVersion: `signup-${suffix}-ttl-v3`,
        amount: 700_000,
        validForDays: 60,
        reason: "enable expiring historical entitlement backfill",
      }, actor, db);
      await changePlatformGrantOfferPolicyLifecycle(ttlPolicy.id, {
        action: "activate",
        expectedUpdatedAt: ttlPolicy.updatedAt.toISOString(),
        reason: "enable expiring historical entitlement backfill",
      }, actor, db);

      const ttlPreview = await previewAccountEntitlementBackfill(actor, db, ttlPreviewAt);
      assert.ok(ttlPreview.eligibleMissingCount >= 2);
      assert.equal(ttlPreview.expiresAt.getTime(), ttlPreviewAt.getTime() + ACCOUNT_ENTITLEMENT_BACKFILL_TTL_MS);
      const ttlItems = await db.accountEntitlementBackfillItem.findMany({
        where: { runId: ttlPreview.runId, userId: { in: ttlUserIds } },
        orderBy: { userId: "asc" },
      });
      assert.equal(ttlItems.length, 2);
      assert.deepEqual(ttlItems.map((item) => item.userId), ttlUserIds);
      assert.deepEqual(ttlItems.map((item) => item.classification), ["eligible_missing", "eligible_missing"]);
      assert.deepEqual(ttlItems.map((item) => item.status), ["pending", "pending"]);
      const ttlClockValues = [
        new Date(ttlPreviewAt.getTime() + 1_000),
        new Date(ttlPreviewAt.getTime() + 2_000),
        ttlPreview.expiresAt,
      ];
      let ttlClockIndex = 0;
      const ttlClock = (): Date => {
        const value = ttlClockValues[Math.min(ttlClockIndex, ttlClockValues.length - 1)]!;
        ttlClockIndex += 1;
        return value;
      };
      const ttlInput = {
        runId: ttlPreview.runId,
        impactFingerprint: ttlPreview.impactFingerprint,
        confirmation: true as const,
        requestKey: randomUUID(),
        reason: "expire historical entitlement backfill between items",
      };
      const ttlResult = await executeAccountEntitlementBackfill(ttlInput, actor, db, ttlClock);
      assert.equal(ttlResult.status, "expired");
      assert.ok(ttlClockIndex >= 3);
      const ttlFirstUserId = ttlUserIds[0]!;
      const ttlSecondUserId = ttlUserIds[1]!;
      const ttlFirstItem = await db.accountEntitlementBackfillItem.findUniqueOrThrow({ where: { id: ttlItems[0]!.id } });
      const ttlSecondItem = await db.accountEntitlementBackfillItem.findUniqueOrThrow({ where: { id: ttlItems[1]!.id } });
      assert.equal(ttlFirstItem.status, "applied");
      assert.ok(ttlFirstItem.resultGrantId);
      assert.equal(ttlSecondItem.status, "pending");
      assert.equal(ttlSecondItem.resultGrantId, null);
      assert.equal(await db.platformTokenGrant.count({ where: { userId: ttlFirstUserId, kind: "signup" } }), 1);
      assert.equal(await db.platformTokenGrant.count({ where: { userId: ttlSecondUserId, kind: "signup" } }), 0);
      assert.equal(await db.platformTokenLedgerEntry.count({ where: { userId: ttlFirstUserId, reasonCode: "AI_SIGNUP_GRANT" } }), 1);
      assert.equal(await db.platformTokenLedgerEntry.count({ where: { userId: ttlSecondUserId, reasonCode: "AI_SIGNUP_GRANT" } }), 0);
      assert.equal(await db.accountEntitlementActivation.count({ where: { userId: { in: ttlUserIds } } }), 2);
      assert.equal(await db.accountEntitlementActivationAudit.count({ where: { userId: { in: ttlUserIds } } }), 2);
      const ttlExpiredRun = await db.accountEntitlementBackfillRun.findUniqueOrThrow({ where: { id: ttlPreview.runId } });
      assert.equal(ttlExpiredRun.status, "expired");
      assert.equal(ttlExpiredRun.executedAt, null);
      const ttlBackfillAuditCount = await db.accountEntitlementBackfillAudit.count({ where: { runId: ttlPreview.runId } });

      await assert.rejects(
        () => executeAccountEntitlementBackfill(ttlInput, actor, db, ttlClock),
        (error: unknown) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ACCOUNT_ENTITLEMENT_BACKFILL_EXPIRED",
      );
      const ttlFirstItemAfterRetry = await db.accountEntitlementBackfillItem.findUniqueOrThrow({ where: { id: ttlItems[0]!.id } });
      const ttlSecondItemAfterRetry = await db.accountEntitlementBackfillItem.findUniqueOrThrow({ where: { id: ttlItems[1]!.id } });
      assert.equal(ttlFirstItemAfterRetry.status, "applied");
      assert.equal(ttlSecondItemAfterRetry.status, "pending");
      assert.equal(await db.platformTokenGrant.count({ where: { userId: ttlFirstUserId, kind: "signup" } }), 1);
      assert.equal(await db.platformTokenGrant.count({ where: { userId: ttlSecondUserId, kind: "signup" } }), 0);
      assert.equal(await db.platformTokenLedgerEntry.count({ where: { userId: ttlFirstUserId, reasonCode: "AI_SIGNUP_GRANT" } }), 1);
      assert.equal(await db.platformTokenLedgerEntry.count({ where: { userId: ttlSecondUserId, reasonCode: "AI_SIGNUP_GRANT" } }), 0);
      assert.equal(await db.accountEntitlementActivation.count({ where: { userId: { in: ttlUserIds } } }), 2);
      assert.equal(await db.accountEntitlementActivationAudit.count({ where: { userId: { in: ttlUserIds } } }), 2);
      assert.equal(await db.accountEntitlementBackfillAudit.count({ where: { runId: ttlPreview.runId } }), ttlBackfillAuditCount);

      const seedShortExpiryRun = async (includeItem: boolean, ttlMs: number) => {
        const runId = randomUUID();
        const itemId = randomUUID();
        await db.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL TIME ZONE 'America/Los_Angeles'`;
          await tx.$executeRaw`SELECT set_config('app.account_entitlement_backfill_context', 'service-v1', true)`;
          await tx.$executeRaw`SELECT set_config('app.account_entitlement_backfill_transaction_id', ${randomUUID()}, true)`;
          await tx.$executeRaw`
            WITH seed AS (
              SELECT
                (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS snapshot_at,
                ((clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3)
                  + (${ttlMs}::double precision * INTERVAL '1 millisecond')) AS expires_at
            ), inserted AS (
              INSERT INTO "AccountEntitlementBackfillRun" (
                "id", "actorId", "actorAccountAccessVersion", "status", "snapshotAt", "expiresAt",
                "candidateCount", "alreadyIssuedCount", "eligibleMissingCount", "legacyAmbiguousCount",
                "impactFingerprint", "transitionAt", "createdAt"
              )
              SELECT ${runId}::uuid, ${actor.id}::uuid, ${actor.accountAccessVersion},
                'previewed'::"AccountEntitlementBackfillRunStatus", snapshot_at, expires_at,
                ${includeItem ? 1 : 0}, ${includeItem ? 1 : 0}, 0, 0,
                ${"a".repeat(64)}, snapshot_at, snapshot_at
              FROM seed
              RETURNING "id", "actorId", "transitionAt"
            )
            INSERT INTO "AccountEntitlementBackfillAudit" (
              "id", "runId", "action", "statusBefore", "statusAfter", "actorId", "reasonRecorded", "transactionId", "createdAt"
            )
            SELECT gen_random_uuid(), "id", 'previewed'::"AccountEntitlementBackfillAuditAction", NULL,
              'previewed'::"AccountEntitlementBackfillRunStatus", "actorId", false, txid_current(), "transitionAt"
            FROM inserted
          `;
          if (includeItem) {
            await tx.$executeRaw`
              INSERT INTO "AccountEntitlementBackfillItem" (
                "id", "runId", "userId", "accountAccessVersion", "classification", "status",
                "existingGrantId", "activationId"
              ) VALUES (
                ${itemId}::uuid, ${runId}::uuid, ${concurrentUser.id}::uuid, ${concurrentUser.accountAccessVersion},
                'already_issued'::"AccountEntitlementBackfillItemClassification",
                'pending'::"AccountEntitlementBackfillItemStatus", ${immutableGrant.id}::uuid, ${concurrent[0]!.id}::uuid
              )
            `;
          }
        });
        return { runId, itemId };
      };

      const claimExpiryFixture = await seedShortExpiryRun(false, 250);
      await db.$executeRaw`SELECT pg_sleep(0.6)`;
      await assert.rejects(
        () => db.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL TIME ZONE 'America/Los_Angeles'`;
          await tx.$executeRaw`SELECT set_config('app.account_entitlement_backfill_context', 'service-v1', true)`;
          await tx.$executeRaw`SELECT set_config('app.account_entitlement_backfill_transaction_id', ${randomUUID()}, true)`;
          await tx.$executeRaw`
            WITH now_row AS (
              SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS at
            ), transitioned AS (
              UPDATE "AccountEntitlementBackfillRun" run
                 SET "status" = 'executing'::"AccountEntitlementBackfillRunStatus",
                     "requestKey" = ${randomUUID()}, "reason" = 'database expiry claim guard',
                     "confirmedAt" = now_row.at, "consumedAt" = now_row.at,
                     "transitionAt" = now_row.at
                FROM now_row
               WHERE run."id" = ${claimExpiryFixture.runId}::uuid
               RETURNING run."id", run."actorId", run."transitionAt"
            )
            INSERT INTO "AccountEntitlementBackfillAudit" (
              "id", "runId", "action", "statusBefore", "statusAfter", "actorId", "reasonRecorded", "transactionId", "createdAt"
            )
            SELECT gen_random_uuid(), "id", 'confirmed'::"AccountEntitlementBackfillAuditAction",
              'previewed'::"AccountEntitlementBackfillRunStatus", 'executing'::"AccountEntitlementBackfillRunStatus",
              "actorId", true, txid_current(), "transitionAt"
            FROM transitioned
          `;
        }),
        /account entitlement backfill run expired before lifecycle transition/u,
      );
      const claimExpiryRun = await db.accountEntitlementBackfillRun.findUniqueOrThrow({ where: { id: claimExpiryFixture.runId } });
      assert.equal(claimExpiryRun.status, "previewed");
      assert.equal(claimExpiryRun.requestKey, null);

      const itemExpiryFixture = await seedShortExpiryRun(true, 2_000);
      const itemGrantCountBefore = await db.platformTokenGrant.count({ where: { userId: concurrentUser.id, kind: "signup" } });
      await assert.rejects(
        () => db.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL TIME ZONE 'America/Los_Angeles'`;
          await tx.$executeRaw`SELECT set_config('app.account_entitlement_backfill_context', 'service-v1', true)`;
          await tx.$executeRaw`SELECT set_config('app.account_entitlement_backfill_transaction_id', ${randomUUID()}, true)`;
          await tx.$executeRaw`
            WITH now_row AS (
              SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS at
            ), transitioned AS (
              UPDATE "AccountEntitlementBackfillRun" run
                 SET "status" = 'executing'::"AccountEntitlementBackfillRunStatus",
                     "requestKey" = ${randomUUID()}, "reason" = 'database expiry item guard',
                     "confirmedAt" = now_row.at, "consumedAt" = now_row.at,
                     "transitionAt" = now_row.at
                FROM now_row
               WHERE run."id" = ${itemExpiryFixture.runId}::uuid
               RETURNING run."id", run."actorId", run."transitionAt"
            )
            INSERT INTO "AccountEntitlementBackfillAudit" (
              "id", "runId", "action", "statusBefore", "statusAfter", "actorId", "reasonRecorded", "transactionId", "createdAt"
            )
            SELECT gen_random_uuid(), "id", 'confirmed'::"AccountEntitlementBackfillAuditAction",
              'previewed'::"AccountEntitlementBackfillRunStatus", 'executing'::"AccountEntitlementBackfillRunStatus",
              "actorId", true, txid_current(), "transitionAt"
            FROM transitioned
          `;
          await tx.$executeRaw`SET CONSTRAINTS "AccountEntitlementBackfillRun_expiry_guard" IMMEDIATE`;
          await tx.$executeRaw`
            SELECT pg_sleep(
              GREATEST(
                0.1,
                EXTRACT(EPOCH FROM (
                  run."expiresAt" - ((clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3))
                )) + 0.1
              )
            )
              FROM "AccountEntitlementBackfillRun" run
             WHERE run."id" = ${itemExpiryFixture.runId}::uuid
          `;
          await tx.$executeRaw`
            UPDATE "AccountEntitlementBackfillItem"
               SET "status" = 'applied'::"AccountEntitlementBackfillItemStatus",
                   "resultGrantId" = ${immutableGrant.id}::uuid, "skipCode" = NULL
             WHERE "id" = ${itemExpiryFixture.itemId}::uuid
          `;
        }),
        /account entitlement backfill item expired before closure/u,
      );
      const itemExpiryRun = await db.accountEntitlementBackfillRun.findUniqueOrThrow({ where: { id: itemExpiryFixture.runId } });
      const itemExpiryItem = await db.accountEntitlementBackfillItem.findUniqueOrThrow({ where: { id: itemExpiryFixture.itemId } });
      assert.equal(itemExpiryRun.status, "previewed");
      assert.equal(itemExpiryItem.status, "pending");
      assert.equal(itemExpiryItem.resultGrantId, null);
      assert.equal(await db.platformTokenGrant.count({ where: { userId: concurrentUser.id, kind: "signup" } }), itemGrantCountBefore);

      const completionExpiryFixture = await seedShortExpiryRun(false, 2_000);
      await assert.rejects(
        () => db.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL TIME ZONE 'America/Los_Angeles'`;
          await tx.$executeRaw`SELECT set_config('app.account_entitlement_backfill_context', 'service-v1', true)`;
          await tx.$executeRaw`SELECT set_config('app.account_entitlement_backfill_transaction_id', ${randomUUID()}, true)`;
          await tx.$executeRaw`
            WITH now_row AS (
              SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS at
            ), transitioned AS (
              UPDATE "AccountEntitlementBackfillRun" run
                 SET "status" = 'executing'::"AccountEntitlementBackfillRunStatus",
                     "requestKey" = ${randomUUID()}, "reason" = 'database expiry completion guard',
                     "confirmedAt" = now_row.at, "consumedAt" = now_row.at,
                     "transitionAt" = now_row.at
                FROM now_row
               WHERE run."id" = ${completionExpiryFixture.runId}::uuid
               RETURNING run."id", run."actorId", run."transitionAt"
            )
            INSERT INTO "AccountEntitlementBackfillAudit" (
              "id", "runId", "action", "statusBefore", "statusAfter", "actorId", "reasonRecorded", "transactionId", "createdAt"
            )
            SELECT gen_random_uuid(), "id", 'confirmed'::"AccountEntitlementBackfillAuditAction",
              'previewed'::"AccountEntitlementBackfillRunStatus", 'executing'::"AccountEntitlementBackfillRunStatus",
              "actorId", true, txid_current(), "transitionAt"
            FROM transitioned
          `;
          await tx.$executeRaw`SET CONSTRAINTS "AccountEntitlementBackfillRun_expiry_guard" IMMEDIATE`;
          await tx.$executeRaw`
            SELECT pg_sleep(
              GREATEST(
                0.1,
                EXTRACT(EPOCH FROM (
                  run."expiresAt" - ((clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3))
                )) + 0.1
              )
            )
              FROM "AccountEntitlementBackfillRun" run
             WHERE run."id" = ${completionExpiryFixture.runId}::uuid
          `;
          await tx.$executeRaw`
            WITH now_row AS (
              SELECT (clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS at
            ), transitioned AS (
              UPDATE "AccountEntitlementBackfillRun" run
                 SET "status" = 'completed'::"AccountEntitlementBackfillRunStatus",
                     "executedAt" = now_row.at, "transitionAt" = now_row.at
                FROM now_row
               WHERE run."id" = ${completionExpiryFixture.runId}::uuid
               RETURNING run."id", run."actorId", run."transitionAt"
            )
            INSERT INTO "AccountEntitlementBackfillAudit" (
              "id", "runId", "action", "statusBefore", "statusAfter", "actorId", "reasonRecorded", "transactionId", "createdAt"
            )
            SELECT gen_random_uuid(), "id", 'executed'::"AccountEntitlementBackfillAuditAction",
              'executing'::"AccountEntitlementBackfillRunStatus", 'completed'::"AccountEntitlementBackfillRunStatus",
              "actorId", true, txid_current(), "transitionAt"
            FROM transitioned
          `;
        }),
        /account entitlement backfill run expired before lifecycle transition/u,
      );
      const completionExpiryRun = await db.accountEntitlementBackfillRun.findUniqueOrThrow({ where: { id: completionExpiryFixture.runId } });
      assert.equal(completionExpiryRun.status, "previewed");
      assert.equal(completionExpiryRun.executedAt, null);

      const replayInput = {
        runId: preview.runId,
        impactFingerprint: preview.impactFingerprint,
        confirmation: true as const,
        requestKey: successfulRequestKey,
        reason: successfulReason,
      };
      await assert.rejects(
        () => executeAccountEntitlementBackfill({ ...replayInput, reason: "different confirmed purpose" }, actor, db, new Date()),
        (error: unknown) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ACCOUNT_ENTITLEMENT_BACKFILL_IDEMPOTENCY_CONFLICT",
      );
      const replayedResult = await executeAccountEntitlementBackfill(replayInput, actor, db, new Date());
      assert.equal(replayedResult.status, "completed");

      const reusedKeyPreview = await previewAccountEntitlementBackfill(actor, db, new Date());
      await assert.rejects(
        () => executeAccountEntitlementBackfill({
          runId: reusedKeyPreview.runId,
          impactFingerprint: reusedKeyPreview.impactFingerprint,
          confirmation: true,
          requestKey: successfulRequestKey,
          reason: "cross-run request key reuse",
        }, actor, db, new Date()),
        (error: unknown) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ACCOUNT_ENTITLEMENT_BACKFILL_IDEMPOTENCY_CONFLICT",
      );
      const reusedKeyRun = await db.accountEntitlementBackfillRun.findUniqueOrThrow({ where: { id: reusedKeyPreview.runId } });
      assert.equal(reusedKeyRun.status, "previewed");
      assert.equal(reusedKeyRun.requestKey, null);

      const concurrentKey = randomUUID();
      const concurrentKeyPreviews = await Promise.all([
        previewAccountEntitlementBackfill(actor, db, new Date()),
        previewAccountEntitlementBackfill(actor, db, new Date()),
      ]);
      const concurrentKeyResults = await Promise.allSettled(concurrentKeyPreviews.map((candidate) => executeAccountEntitlementBackfill({
        runId: candidate.runId,
        impactFingerprint: candidate.impactFingerprint,
        confirmation: true,
        requestKey: concurrentKey,
        reason: "concurrent request key conflict",
      }, actor, db, new Date())));
      assert.equal(concurrentKeyResults.filter((entry) => entry.status === "fulfilled").length, 1);
      const concurrentKeyRejection = concurrentKeyResults.find((entry) => entry.status === "rejected");
      assert.ok(concurrentKeyRejection && concurrentKeyRejection.status === "rejected");
      assert.equal((concurrentKeyRejection.reason as { code?: unknown }).code, "ACCOUNT_ENTITLEMENT_BACKFILL_IDEMPOTENCY_CONFLICT");

      const stalePreview = await previewAccountEntitlementBackfill(actor, db, new Date());
      const actorEpoch = actor.accountAccessVersion!;
      const secondAdmin = await db.appUser.create({
        data: { id: randomUUID(), username: `entitlement_epoch_admin_${suffix}`, role: "admin" },
      });
      const disableActorPreview = await previewAccountAccess({
        adminUserId: secondAdmin.id,
        adminAccountAccessVersion: secondAdmin.accountAccessVersion,
        userId: actor.id,
        action: "disable",
        reason: "rotate backfill administrator session",
        expectedVersion: actorEpoch,
      }, db);
      await executeAccountAccess({
        adminUserId: secondAdmin.id,
        adminAccountAccessVersion: secondAdmin.accountAccessVersion,
        userId: actor.id,
        action: "disable",
        reason: "rotate backfill administrator session",
        expectedVersion: disableActorPreview.current.accountAccessVersion,
        expectedImpactFingerprint: disableActorPreview.impactFingerprint,
        requestKey: `entitlement-epoch-disable-${suffix}`,
        requestFingerprint: disableActorPreview.requestFingerprint,
        previewId: disableActorPreview.previewId,
        previewIssuedAt: disableActorPreview.previewIssuedAt,
        previewExpiresAt: disableActorPreview.previewExpiresAt,
        confirmation: true,
        confirmationUsername: disableActorPreview.user.username,
      }, db);
      const restoreActorPreview = await previewAccountAccess({
        adminUserId: secondAdmin.id,
        adminAccountAccessVersion: secondAdmin.accountAccessVersion,
        userId: actor.id,
        action: "restore",
        reason: "rotate backfill administrator session",
        expectedVersion: actorEpoch + 1,
      }, db);
      await executeAccountAccess({
        adminUserId: secondAdmin.id,
        adminAccountAccessVersion: secondAdmin.accountAccessVersion,
        userId: actor.id,
        action: "restore",
        reason: "rotate backfill administrator session",
        expectedVersion: restoreActorPreview.current.accountAccessVersion,
        expectedImpactFingerprint: restoreActorPreview.impactFingerprint,
        requestKey: `entitlement-epoch-restore-${suffix}`,
        requestFingerprint: restoreActorPreview.requestFingerprint,
        previewId: restoreActorPreview.previewId,
        previewIssuedAt: restoreActorPreview.previewIssuedAt,
        previewExpiresAt: restoreActorPreview.previewExpiresAt,
        confirmation: true,
        confirmationUsername: restoreActorPreview.user.username,
      }, db);
      await assert.rejects(
        () => previewAccountEntitlementBackfill(actor, db, new Date()),
        (error: unknown) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ACCOUNT_ENTITLEMENT_BACKFILL_EPOCH_STALE",
      );
      await assert.rejects(
        () => executeAccountEntitlementBackfill({
          runId: stalePreview.runId,
          impactFingerprint: stalePreview.impactFingerprint,
          confirmation: true,
          requestKey: randomUUID(),
          reason: "stale administrator execute",
        }, actor, db, new Date()),
        (error: unknown) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ACCOUNT_ENTITLEMENT_BACKFILL_EPOCH_STALE",
      );
      const stalePreviewRun = await db.accountEntitlementBackfillRun.findUniqueOrThrow({ where: { id: stalePreview.runId } });
      assert.equal(stalePreviewRun.status, "previewed");
      assert.equal(stalePreviewRun.requestKey, null);
      assert.equal(stalePreviewRun.consumedAt, null);

      assert.deepEqual(backfillEvents.events.map((event) => event.action), ["executed", "confirmed", "previewed", "stale", "previewed"]);
      const [noPolicyAuditRows, successfulAuditRows] = await Promise.all([
        db.accountEntitlementBackfillAudit.findMany({
          where: { runId: noPolicyPreview.runId },
          select: { id: true, action: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        }),
        db.accountEntitlementBackfillAudit.findMany({
          where: { runId: preview.runId },
          select: { id: true, action: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        }),
      ]);
      assert.deepEqual(noPolicyAuditRows.map((row) => row.action), ["stale", "previewed"]);
      assert.deepEqual(successfulAuditRows.map((row) => row.action), ["executed", "confirmed", "previewed"]);
      assert.ok(noPolicyAuditRows[0]!.createdAt.getTime() > noPolicyAuditRows[1]!.createdAt.getTime());
      const publicEventById = new Map(backfillEvents.events.map((event) => [event.id, event]));
      assert.deepEqual(noPolicyAuditRows.map((row) => publicEventById.get(row.id)?.action), ["stale", "previewed"]);
      assert.deepEqual(successfulAuditRows.map((row) => publicEventById.get(row.id)?.action), ["executed", "confirmed", "previewed"]);
      assert.equal(publicEventById.get(noPolicyAuditRows[0]!.id)?.evidence.after.status, "stale");
      assert.equal(publicEventById.get(successfulAuditRows[0]!.id)?.evidence.after.status, "completed");
      const executedEvent = publicEventById.get(successfulAuditRows[0]!.id);
      const confirmedEvent = publicEventById.get(successfulAuditRows[1]!.id);
      assert.ok(executedEvent);
      assert.ok(confirmedEvent);
      assert.ok(Date.parse(executedEvent.occurredAt) > Date.parse(confirmedEvent.occurredAt));
      assert.ok(Date.parse(confirmedEvent.occurredAt) > Date.parse(publicEventById.get(successfulAuditRows[2]!.id)!.occurredAt));
      const completedRun = await db.accountEntitlementBackfillRun.findUniqueOrThrow({ where: { id: preview.runId } });
      assert.equal(completedRun.status, "completed");
      assert.equal(completedRun.executedAt?.getTime(), Date.parse(executedEvent.occurredAt));
      assert.equal(completedRun.transitionAt.getTime(), Date.parse(executedEvent.occurredAt));
      assert.ok(backfillEvents.events.every((event) => event.subject === null));
      assert.deepEqual(await getSystemAuditDetail("accountEntitlementBackfill", backfillEvents.events[0]!.id, db), backfillEvents.events[0]);

      await assert.rejects(
        () => db.accountEntitlementActivation.create({
          data: {
            id: randomUUID(),
            userId: concurrentUser.id,
            lifecycleKey: "initial_account_v1",
            source: "localProvisioning",
            actorKind: "user",
            actorId: actor.id,
            actorAccountAccessVersion: actor.accountAccessVersion,
            accountAccessVersion: concurrentUser.accountAccessVersion,
            mutationTransactionId: randomUUID(),
            decision: "no_active_offer",
            status: "no_active_offer",
          },
        }),
        (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError || error instanceof Error,
      );
    } finally {
      await db.$disconnect();
    }
  },
);
