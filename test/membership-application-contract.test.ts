import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { previewMembershipApplication } from "../src/lib/membership-application-service";

const schema = readFileSync("prisma/schema.prisma", "utf8");
const migration = readFileSync("prisma/migrations/20260912010000_add_membership_applications/migration.sql", "utf8");
const service = readFileSync("src/lib/membership-application-service.ts", "utf8");
const profileRoute = readFileSync("src/app/api/profile/route.ts", "utf8");
const profileClient = readFileSync("src/app/profile/profile-client.tsx", "utf8");
const membershipService = readFileSync("src/lib/membership-service.ts", "utf8");

test("ENT-012/013 schema is a bounded four-state, preview-controlled application", () => {
  assert.match(schema, /enum MembershipApplicationStatus \{[\s\S]*pending[\s\S]*fulfilled[\s\S]*rejected[\s\S]*withdrawn[\s\S]*\}/u);
  assert.match(schema, /model MembershipApplication \{[\s\S]*statusVersion[\s\S]*submitPreviewId[\s\S]*fulfilledSubscriptionAuditId/u);
  assert.match(schema, /model MembershipApplicationPreview \{[\s\S]*expiresAt[\s\S]*consumedAt/u);
  assert.match(schema, /model MembershipApplicationAudit \{[\s\S]*subscriptionAuditId/u);
  assert.match(migration, /CREATE UNIQUE INDEX "MembershipApplication_one_pending_user_key"[\s\S]*WHERE "status" = 'pending'/u);
  assert.match(migration, /CREATE UNIQUE INDEX "MembershipSubscriptionAudit_applicationId_key"[\s\S]*WHERE "applicationId" IS NOT NULL/u);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER "MembershipApplication_transition_guard"/u);
  assert.match(migration, /membership application preview is append-only/u);
  assert.match(migration, /fulfilled membership application must bind exact grant audit, preview, and fingerprints/u);
  for (const functionName of [
    "membership_application_preview_guard",
    "membership_application_guard",
    "membership_application_audit_guard",
    "membership_application_transition_guard",
    "membership_subscription_audit_application_guard",
    "membership_subscription_audit_application_transition_guard",
    "membership_subscription_pending_application_guard",
    "membership_mutation_preview_application_guard",
  ]) {
    const functionSource = migration.match(new RegExp(`CREATE OR REPLACE FUNCTION "${functionName}"[\\s\\S]*?\\$\\$;`, "u"))?.[0] ?? "";
    assert.match(functionSource, /LANGUAGE plpgsql\s+SET search_path = pg_catalog, public/u, `${functionName} must pin search_path`);
  }
  assert.match(migration, /subscription_audit\."eventKind" = 'grant'/u);
  assert.match(migration, /subscription_audit\."previewId" = NEW\."fulfilledMembershipPreviewId"/u);
  assert.match(migration, /application_audit\."requestFingerprint" = subscription_audit\."requestFingerprint"/u);
  assert.match(migration, /application_audit\."impactFingerprint" = subscription_audit\."impactFingerprint"/u);
  assert.match(migration, /membership grant must bind the pending membership application/u);
  assert.match(migration, /membership mutation preview application binding is immutable/u);
  assert.match(migration, /membership subscription audit requires fulfilled application closure/u);
  assert.match(migration, /application_audit\."subscriptionAuditId" = application\."fulfilledSubscriptionAuditId"/u);
  assert.match(migration, /CREATE CONSTRAINT TRIGGER "MembershipSubscriptionAudit_application_transition_guard"[\s\S]*DEFERRABLE INITIALLY DEFERRED/u);
});

test("application service keeps user identity scoped and all terminal paths preview-confirm-execute", () => {
  assert.match(service, /actorId !== targetId/u);
  assert.match(service, /previewMembershipApplication/u);
  assert.match(service, /executeMembershipApplication/u);
  assert.match(service, /previewWithdrawMembershipApplication/u);
  assert.match(service, /executeWithdrawMembershipApplication/u);
  assert.match(service, /previewRejectMembershipApplication/u);
  assert.match(service, /executeRejectMembershipApplication/u);
  assert.match(service, /confirmation !== true/u);
  assert.match(service, /Serializable/u);
  assert.match(membershipService, /fulfillMembershipApplicationInTransaction/u);
  assert.match(membershipService, /applicationId/u);
  assert.ok(
    membershipService.indexOf("const consumed = await tx.membershipMutationPreview.updateMany")
      < membershipService.indexOf("await fulfillMembershipApplicationInTransaction(tx"),
    "membership preview must be consumed before application fulfillment",
  );
});

test("application preview maps the Prisma membershipSubscription relation before state evaluation", async () => {
  const userId = "00000000-0000-4000-8000-000000000021";
  const current = new Date("2026-09-12T00:00:00.000Z");
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [{ now: current }],
    appUser: {
      findUnique: async () => ({
        id: userId,
        username: "application-shape-user",
        disabledAt: null,
        accountAccessVersion: 1,
        membershipSubscription: null,
      }),
    },
    membershipApplication: {
      findFirst: async () => null,
    },
    membershipApplicationPreview: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        applicationId: null,
        consumedAt: null,
      }),
    },
  };
  const db = {
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;

  const result = await previewMembershipApplication({
    actorId: userId,
    requestKey: "application-shape-preview",
    reason: "验证关系返回形状",
  }, db);

  assert.equal(result.application, null);
  assert.equal(result.preview.action, "submit");
  assert.equal(result.preview.expectedMembershipState, "none");
});

test("application submit preview retries recover the persisted preview without creating a duplicate", async () => {
  const userId = "00000000-0000-4000-8000-000000000022";
  const current = new Date("2026-09-12T00:00:00.000Z");
  let persistedPreview: Record<string, unknown> | null = null;
  let createCount = 0;
  const tx = {
    $executeRaw: async () => 0,
    $queryRaw: async () => [{ now: current }],
    appUser: {
      findUnique: async () => ({
        id: userId,
        username: "application-retry-user",
        disabledAt: null,
        accountAccessVersion: 1,
        membershipSubscription: null,
      }),
    },
    membershipApplication: {
      findFirst: async () => null,
    },
    membershipApplicationPreview: {
      findUnique: async () => persistedPreview,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createCount += 1;
        persistedPreview = { ...data, applicationId: null, consumedAt: null };
        return persistedPreview;
      },
    },
  };
  const db = {
    $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;
  const input = { actorId: userId, requestKey: "application-retry-preview", reason: "恢复丢失响应" };
  const first = await previewMembershipApplication(input, db);
  const replay = await previewMembershipApplication(input, db);
  assert.equal(replay.application, null);
  assert.equal(replay.preview.id, first.preview.id);
  assert.equal(createCount, 1);
  await assert.rejects(
    () => previewMembershipApplication({ ...input, reason: "改变申请原因" }, db),
    (error: unknown) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "MEMBERSHIP_APPLICATION_IDEMPOTENCY_CONFLICT",
  );
});

test("profile projection is platform-credit based and hides administrator rejection detail", () => {
  assert.match(profileRoute, /getPlatformTokenSummary/u);
  assert.match(profileRoute, /totalCredits/u);
  assert.match(profileRoute, /safeMembershipApplication/u);
  assert.doesNotMatch(profileRoute, /membershipApplication: membershipApplication/u);
  assert.match(profileClient, /平台额度/u);
  assert.match(profileClient, /不是供应商原始 Token、充值余额/u);
  assert.doesNotMatch(profileClient, /可用平台 Token|预留中 Token/u);
});
