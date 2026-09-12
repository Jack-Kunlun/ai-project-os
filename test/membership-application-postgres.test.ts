import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { initializeAdmin } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import {
  executeMembershipApplication,
  executeRejectMembershipApplication,
  executeWithdrawMembershipApplication,
  MembershipApplicationServiceError,
  listMembershipApplications,
  previewMembershipApplication,
  previewRejectMembershipApplication,
  previewWithdrawMembershipApplication,
} from "../src/lib/membership-application-service";
import { executeMembership, MembershipServiceError, previewMembership } from "../src/lib/membership-service";

const shouldRun = process.env.MEMBERSHIP_APPLICATION_POSTGRES_GATE === "1";

type ApplicationPreview = Awaited<ReturnType<typeof previewMembershipApplication>>;

function applicationExecuteInput(preview: ApplicationPreview, actorId: string, confirmationUsername?: string): Record<string, unknown> {
  return {
    actorId,
    applicationId: preview.preview.applicationId,
    requestKey: preview.preview.requestKey,
    requestFingerprint: preview.preview.requestFingerprint,
    impactFingerprint: preview.preview.impactFingerprint,
    previewId: preview.preview.id,
    previewIssuedAt: preview.preview.issuedAt,
    previewExpiresAt: preview.preview.expiresAt,
    confirmation: true,
    ...(confirmationUsername === undefined ? {} : { confirmationUsername }),
  };
}

function serviceCode(error: unknown): string | null {
  return error instanceof MembershipApplicationServiceError ? error.code : null;
}

test("membership applications are preview-confirmed, terminally audited, and fulfilled atomically on PostgreSQL", {
  skip: !shouldRun ? "MEMBERSHIP_APPLICATION_POSTGRES_GATE=1 is required" : false,
}, async () => {
  const db = getDb();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const admin = (await initializeAdmin({ username: `membership_application_admin_${suffix}`, password: "MembershipApplicationGatePassword_2026" }, db)).user;
  const user = await db.appUser.create({ data: { id: randomUUID(), username: `membership_application_user_${suffix}`, role: "user" } });
  const otherUser = await db.appUser.create({ data: { id: randomUUID(), username: `membership_application_other_${suffix}`, role: "user" } });

  const submitPreview = await previewMembershipApplication({ actorId: user.id, requestKey: `application-${suffix}-submit`, reason: "需要平台内会员能力" }, db);
  assert.equal(submitPreview.application, null);
  assert.equal(submitPreview.preview.action, "submit");
  assert.equal(submitPreview.preview.expiresAt.getTime() - submitPreview.preview.issuedAt.getTime(), 5 * 60 * 1_000);
  const submitReplay = await previewMembershipApplication({ actorId: user.id, requestKey: `application-${suffix}-submit`, reason: "需要平台内会员能力" }, db);
  assert.equal(submitReplay.application, null);
  assert.equal(submitReplay.preview.id, submitPreview.preview.id);
  await assert.rejects(
    () => previewMembershipApplication({ actorId: user.id, requestKey: `application-${suffix}-submit`, reason: "改写申请原因" }, db),
    (error: unknown) => serviceCode(error) === "MEMBERSHIP_APPLICATION_IDEMPOTENCY_CONFLICT",
  );
  const application = await executeMembershipApplication({ ...applicationExecuteInput(submitPreview, user.id), confirmationUsername: user.username } as never, db);
  assert.equal(application.status, "pending");
  assert.equal(application.userId, user.id);
  assert.equal(await db.membershipApplicationAudit.count({ where: { applicationId: application.id, event: "submitted" } }), 1);

  await assert.rejects(
    () => previewMembershipApplication({ actorId: user.id, requestKey: `application-${suffix}-other`, reason: "重复申请" }, db),
    (error: unknown) => serviceCode(error) === "MEMBERSHIP_APPLICATION_PENDING",
  );
  await assert.rejects(
    () => previewMembershipApplication({ actorId: user.id, userId: otherUser.id, requestKey: `application-${suffix}-cross-user`, reason: "跨用户" }, db),
    (error: unknown) => serviceCode(error) === "MEMBERSHIP_APPLICATION_INVALID_INPUT",
  );

  const withdrawPreview = await previewWithdrawMembershipApplication({ actorId: user.id, applicationId: application.id, requestKey: `application-${suffix}-withdraw` }, db);
  const withdrawn = await executeWithdrawMembershipApplication(applicationExecuteInput(withdrawPreview, user.id) as never, db);
  assert.equal(withdrawn.status, "withdrawn");
  assert.equal(await db.membershipApplicationAudit.count({ where: { applicationId: application.id, event: "withdrawn" } }), 1);

  const rejectedPreview = await previewMembershipApplication({ actorId: user.id, requestKey: `application-${suffix}-reapply-reject`, reason: "重新提交申请" }, db);
  const rejectedApplication = await executeMembershipApplication({ ...applicationExecuteInput(rejectedPreview, user.id), confirmationUsername: user.username } as never, db);
  const adminRejectPreview = await previewRejectMembershipApplication({ actorId: admin.id, applicationId: rejectedApplication.id, requestKey: `application-${suffix}-reject`, reason: "当前条件暂不满足" }, db);
  const rejected = await executeRejectMembershipApplication(applicationExecuteInput(adminRejectPreview, admin.id, user.username) as never, db);
  assert.equal(rejected.status, "rejected");
  assert.equal(await db.membershipApplicationAudit.count({ where: { applicationId: rejected.id, event: "rejected" } }), 1);

  const fulfillPreview = await previewMembershipApplication({ actorId: user.id, requestKey: `application:${suffix}:reapply:fulfill`, reason: "补充会员申请说明" }, db);
  const pending = await executeMembershipApplication({ ...applicationExecuteInput(fulfillPreview, user.id), confirmationUsername: user.username } as never, db);
  const subscriptionsBeforeUnboundGrant = await db.membershipSubscription.count({ where: { userId: user.id } });
  const auditsBeforeUnboundGrant = await db.membershipSubscriptionAudit.count({ where: { userId: user.id } });
  await assert.rejects(
    () => previewMembership({ adminUserId: admin.id, userId: user.id, action: "grant", days: 7 }, db),
    (error: unknown) => error instanceof MembershipServiceError && error.code === "MEMBERSHIP_PREVIEW_STALE",
  );
  assert.equal(await db.membershipSubscription.count({ where: { userId: user.id } }), subscriptionsBeforeUnboundGrant);
  assert.equal(await db.membershipSubscriptionAudit.count({ where: { userId: user.id } }), auditsBeforeUnboundGrant);
  const toctouUser = await db.appUser.create({ data: { id: randomUUID(), username: `membership_application_toctou_${suffix}`, role: "user" } });
  const unboundPreview = await previewMembership({ adminUserId: admin.id, userId: toctouUser.id, action: "grant", days: 7 }, db);
  const toctouSubmitPreview = await previewMembershipApplication({ actorId: toctouUser.id, requestKey: `application-${suffix}-toctou-submit`, reason: "并发状态检查" }, db);
  await executeMembershipApplication({ ...applicationExecuteInput(toctouSubmitPreview, toctouUser.id), confirmationUsername: toctouUser.username } as never, db);
  const toctouSubscriptionsBeforeExecute = await db.membershipSubscription.count({ where: { userId: toctouUser.id } });
  const toctouAuditsBeforeExecute = await db.membershipSubscriptionAudit.count({ where: { userId: toctouUser.id } });
  await assert.rejects(
    () => executeMembership({
      adminUserId: admin.id,
      userId: toctouUser.id,
      action: "grant",
      days: 7,
      note: null,
      reason: null,
      expectedVersion: unboundPreview.current.version,
      expectedImpactFingerprint: unboundPreview.impactFingerprint,
      requestKey: `application-${suffix}-toctou-grant`,
      requestFingerprint: unboundPreview.requestFingerprint,
      previewId: unboundPreview.previewId,
      previewIssuedAt: unboundPreview.previewIssuedAt,
      previewExpiresAt: unboundPreview.previewExpiresAt,
      confirmation: true,
      confirmationUsername: toctouUser.username,
    }, db),
    (error: unknown) => error instanceof MembershipServiceError && error.code === "MEMBERSHIP_PREVIEW_STALE",
  );
  assert.equal(await db.membershipSubscription.count({ where: { userId: toctouUser.id } }), toctouSubscriptionsBeforeExecute);
  assert.equal(await db.membershipSubscriptionAudit.count({ where: { userId: toctouUser.id } }), toctouAuditsBeforeExecute);
  const toctouApplication = await db.membershipApplication.findFirstOrThrow({ where: { userId: toctouUser.id, status: "pending" } });
  const pendingGrantPreview = await previewMembership({ adminUserId: admin.id, userId: toctouUser.id, action: "grant", days: 7, applicationId: toctouApplication.id }, db);
  const rawSubscriptionId = randomUUID();
  await assert.rejects(
    () => db.$transaction(async (tx) => {
      const startsAt = new Date();
      const expiresAt = new Date(startsAt.getTime() + 7 * 86_400_000);
      const requestKey = `raw-closure-${suffix}`;
      await tx.$executeRaw`SELECT set_config('app.membership_lifecycle_context', '1', true)`;
      await tx.$executeRaw`SELECT set_config('app.membership_lifecycle_actor_id', ${admin.id}, true)`;
      await tx.$executeRaw`SELECT set_config('app.membership_lifecycle_user_id', ${toctouUser.id}, true)`;
      await tx.$executeRaw`SELECT set_config('app.membership_lifecycle_action', 'grant', true)`;
      await tx.$executeRaw`SELECT set_config('app.membership_lifecycle_preview_id', ${pendingGrantPreview.previewId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.membership_lifecycle_request_key', ${requestKey}, true)`;
      await tx.$executeRaw`SELECT set_config('app.membership_lifecycle_request_fingerprint', ${pendingGrantPreview.requestFingerprint}, true)`;
      await tx.$executeRaw`SELECT set_config('app.membership_lifecycle_impact_fingerprint', ${pendingGrantPreview.impactFingerprint}, true)`;
      await tx.$executeRaw`SELECT set_config('app.membership_application_id', ${toctouApplication.id}, true)`;
      await tx.$executeRaw`SELECT set_config('app.membership_application_actor_id', ${admin.id}, true)`;
      await tx.$executeRaw`SELECT set_config('app.membership_application_user_id', ${toctouUser.id}, true)`;
      await tx.$executeRaw`
        INSERT INTO "MembershipSubscription" (
          "id", "userId", "status", "startsAt", "expiresAt", "grantedById", "version", "createdAt", "updatedAt"
        ) VALUES (
          ${rawSubscriptionId}::uuid, ${toctouUser.id}::uuid, 'active'::"MembershipSubscriptionStatus",
          ${startsAt}, ${expiresAt}, ${admin.id}::uuid, 1, ${startsAt}, ${startsAt}
        )
      `;
      await tx.$executeRaw`SELECT set_config('app.membership_lifecycle_subscription_id', ${rawSubscriptionId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.membership_lifecycle_subscription_version', '1', true)`;
      await tx.$executeRaw`
        UPDATE "MembershipMutationPreview"
           SET "consumedAt" = ${startsAt}
         WHERE "id" = ${pendingGrantPreview.previewId}::uuid
      `;
      await tx.$executeRaw`
        INSERT INTO "MembershipSubscriptionAudit" (
          "id", "subscriptionId", "userId", "actorId", "eventKind", "startsAt", "expiresAt",
          "versionBefore", "versionAfter", "statusBefore", "statusAfter", "startsAtAfter", "expiresAtAfter",
          "grantedByIdAfter", "previewId", "applicationId", "reason", "requestKey", "requestFingerprint",
          "impactFingerprint", "transitionAt", "contractVersion", "createdAt"
        ) VALUES (
          ${randomUUID()}::uuid, ${rawSubscriptionId}::uuid, ${toctouUser.id}::uuid, ${admin.id}::uuid,
          'grant'::"MembershipAuditEventKind", ${startsAt}, ${expiresAt}, NULL, 1, NULL,
          'active'::"MembershipSubscriptionStatus", ${startsAt}, ${expiresAt}, ${admin.id}::uuid,
          ${pendingGrantPreview.previewId}::uuid, ${toctouApplication.id}::uuid, 'raw closure test', ${requestKey},
          ${pendingGrantPreview.requestFingerprint}, ${pendingGrantPreview.impactFingerprint}, ${startsAt}, 2, ${startsAt}
        )
      `;
      // Deliberately omit the application fulfillment update and audit.  The
      // deferred reverse-binding trigger must reject this otherwise-valid
      // subscription/audit pair at COMMIT.
    }),
    (error: unknown) => error instanceof Error,
  );
  assert.equal(await db.membershipSubscription.count({ where: { userId: toctouUser.id } }), toctouSubscriptionsBeforeExecute);
  assert.equal(await db.membershipSubscriptionAudit.count({ where: { userId: toctouUser.id } }), toctouAuditsBeforeExecute);
  await assert.rejects(
    () => db.$transaction(async (tx) => {
      const startsAt = new Date();
      await tx.$executeRaw`SELECT set_config('app.membership_lifecycle_context', '1', true)`;
      await tx.$executeRaw`SELECT set_config('app.membership_lifecycle_actor_id', ${admin.id}, true)`;
      await tx.$executeRaw`SELECT set_config('app.membership_lifecycle_user_id', ${user.id}, true)`;
      await tx.$executeRaw`SELECT set_config('app.membership_lifecycle_action', 'grant', true)`;
      await tx.$executeRaw`
        INSERT INTO "MembershipSubscription" (
          "id", "userId", "status", "startsAt", "expiresAt", "grantedById", "version", "createdAt", "updatedAt"
        ) VALUES (
          ${randomUUID()}::uuid, ${user.id}::uuid, 'active'::"MembershipSubscriptionStatus",
          ${startsAt}, ${new Date(startsAt.getTime() + 7 * 86_400_000)}, ${admin.id}::uuid,
          1, ${startsAt}, ${startsAt}
        )
      `;
    }),
    (error: unknown) => error instanceof Error,
  );
  assert.equal(await db.membershipSubscription.count({ where: { userId: user.id } }), subscriptionsBeforeUnboundGrant);
  assert.equal(await db.membershipSubscriptionAudit.count({ where: { userId: user.id } }), auditsBeforeUnboundGrant);
  const membershipPreview = await previewMembership({ adminUserId: admin.id, userId: user.id, action: "grant", days: 7, applicationId: pending.id }, db);
  const subscription = await executeMembership({
    adminUserId: admin.id,
    userId: user.id,
    action: "grant",
    days: 7,
    note: null,
    reason: null,
    expectedVersion: membershipPreview.current.version,
    expectedImpactFingerprint: membershipPreview.impactFingerprint,
    requestKey: `application-${suffix}-fulfill-grant`,
    requestFingerprint: membershipPreview.requestFingerprint,
    previewId: membershipPreview.previewId,
    previewIssuedAt: membershipPreview.previewIssuedAt,
    previewExpiresAt: membershipPreview.previewExpiresAt,
    confirmation: true,
    confirmationUsername: user.username,
    applicationId: pending.id,
  }, db);
  assert.equal(subscription.status, "active");
  const fulfilled = await db.membershipApplication.findUniqueOrThrow({ where: { id: pending.id } });
  const subscriptionAudit = await db.membershipSubscriptionAudit.findUniqueOrThrow({ where: { id: fulfilled.fulfilledSubscriptionAuditId! } });
  const fulfillmentAudit = await db.membershipApplicationAudit.findFirstOrThrow({ where: { applicationId: pending.id, event: "fulfilled" } });
  assert.equal(fulfilled.status, "fulfilled");
  assert.equal(fulfilled.fulfilledSubscriptionId, subscription.id);
  assert.equal(fulfilled.fulfilledSubscriptionVersion, subscription.version);
  assert.equal(subscriptionAudit.applicationId, pending.id);
  assert.equal(subscriptionAudit.subscriptionId, subscription.id);
  assert.equal(subscriptionAudit.versionAfter, subscription.version);
  assert.equal(fulfillmentAudit.subscriptionAuditId, subscriptionAudit.id);
  assert.equal(fulfillmentAudit.membershipPreviewId, membershipPreview.previewId);
  assert.equal((await listMembershipApplications({ adminUserId: admin.id, search: user.username, page: 1, pageSize: 1 }, db)).items[0]?.id, pending.id);

  await assert.rejects(
    () => previewMembershipApplication({ actorId: user.id, requestKey: `application-${suffix}-active`, reason: "已有会员" }, db),
    (error: unknown) => serviceCode(error) === "MEMBERSHIP_APPLICATION_ACTIVE_MEMBERSHIP",
  );

  await assert.rejects(
    () => db.$executeRaw(Prisma.sql`UPDATE "MembershipApplication" SET "statusVersion" = "statusVersion" + 1 WHERE "id" = ${pending.id}::uuid`),
    (error: unknown) => error instanceof Error,
  );
  await assert.rejects(
    () => db.$executeRaw(Prisma.sql`DELETE FROM "MembershipApplicationAudit" WHERE "applicationId" = ${pending.id}::uuid`),
    (error: unknown) => error instanceof Error,
  );
  await assert.rejects(
    () => db.$executeRaw(Prisma.sql`
      INSERT INTO "MembershipApplicationPreview" (
        "id", "actorId", "userId", "action", "expectedApplicationVersion", "expectedAccountAccessVersion",
        "expectedMembershipVersion", "expectedMembershipState", "requestKey", "requestFingerprint", "impactFingerprint",
        "issuedAt", "expiresAt"
      ) VALUES (
        ${randomUUID()}::uuid, ${user.id}::uuid, ${user.id}::uuid, 'submit'::"MembershipApplicationAction", 0, 1,
        1, 'active', ${`application-${suffix}-raw-preview`}, ${"a".repeat(64)}, ${"b".repeat(64)},
        clock_timestamp(), clock_timestamp() + interval '5 minutes'
      )
    `),
    (error: unknown) => error instanceof Error,
  );

  // Fulfillment evidence is append-only and cross-bound: a raw caller must
  // not be able to replace the event, preview binding, or fingerprints after
  // the service has committed the subscription/application pair.
  await assert.rejects(
    () => db.$executeRaw(Prisma.sql`
      UPDATE "MembershipApplicationAudit"
         SET "event" = 'rejected'::"MembershipApplicationAuditEvent"
       WHERE "id" = ${fulfillmentAudit.id}::uuid
    `),
    (error: unknown) => error instanceof Error,
  );
  await assert.rejects(
    () => db.$executeRaw(Prisma.sql`
      UPDATE "MembershipMutationPreview"
         SET "applicationId" = NULL
       WHERE "id" = ${membershipPreview.previewId}::uuid
    `),
    (error: unknown) => error instanceof Error,
  );
  await assert.rejects(
    () => db.$executeRaw(Prisma.sql`
      UPDATE "MembershipApplicationAudit"
         SET "membershipPreviewId" = ${randomUUID()}::uuid
       WHERE "id" = ${fulfillmentAudit.id}::uuid
    `),
    (error: unknown) => error instanceof Error,
  );
  await assert.rejects(
    () => db.$executeRaw(Prisma.sql`
      UPDATE "MembershipApplicationAudit"
         SET "requestFingerprint" = ${"c".repeat(64)}
       WHERE "id" = ${fulfillmentAudit.id}::uuid
    `),
    (error: unknown) => error instanceof Error,
  );
});
