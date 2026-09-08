import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mapApiError } from "../src/lib/api-errors";
import { AccountAccessServiceError, accountAccessRequestFingerprint } from "../src/lib/account-access-service";
import { AccountAccessGuardError, assertAccountAccessForActor } from "../src/lib/account-access-guard";
import { AuthError, createSession } from "../src/lib/auth";

type FakeSessionDb = {
  $transaction: <T>(callback: (tx: FakeSessionDb) => Promise<T>) => Promise<T>;
  $executeRaw: (query: unknown) => Promise<number>;
  appUser: {
    findUnique: (args: unknown) => Promise<Readonly<{
      id: string;
      username: string;
      role: "member";
      disabledAt: Date | null;
      accountAccessVersion: number;
    }> | null>;
  };
  appSession: {
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  };
};

test("createSession opens one transaction even when its transaction client exposes $transaction", async () => {
  let transactionCalls = 0;
  const createdData: Array<Record<string, unknown>> = [];
  const fakeDb: FakeSessionDb = {
    $transaction: async (callback) => {
      transactionCalls += 1;
      return callback(fakeDb);
    },
    $executeRaw: async () => 1,
    appUser: {
      findUnique: async () => ({
        id: "22222222-2222-4222-8222-222222222222",
        username: "account-user",
        role: "member",
        disabledAt: null,
        accountAccessVersion: 7,
      }),
    },
    appSession: {
      create: async ({ data }) => {
        createdData.push(data);
        return data;
      },
    },
  };

  const session = await createSession(
    fakeDb as unknown as Parameters<typeof createSession>[0],
    { id: "22222222-2222-4222-8222-222222222222", username: "account-user", role: "member" },
    new Date("2026-09-08T10:00:00.000Z"),
  );

  assert.equal(transactionCalls, 1);
  assert.equal(createdData[0]?.accountAccessVersion, 7);
  assert.equal(session.user.accountAccessVersion, 7);
});

test("createSession fails closed when a direct caller omits the account epoch", async () => {
  let sessionWrites = 0;
  const fakeDb = {
    appSession: {
      create: async () => {
        sessionWrites += 1;
        return {};
      },
    },
  } as unknown as Parameters<typeof createSession>[0];

  await assert.rejects(
    () => createSession(fakeDb, {
      id: "22222222-2222-4222-8222-222222222222",
      username: "account-user",
      role: "member",
    }),
    (error: unknown) => error instanceof AuthError && error.code === "AUTH_REQUIRED",
  );
  assert.equal(sessionWrites, 0);
});

test("account access request fingerprints are deterministic and action-sensitive", () => {
  const input = {
    userId: "22222222-2222-4222-8222-222222222222",
    action: "disable" as const,
    expectedVersion: 1,
    expectedImpactFingerprint: "a".repeat(64),
    reason: "security review",
    previewIssuedAt: "2026-09-08T10:00:00.000Z",
    previewExpiresAt: "2026-09-08T10:05:00.000Z",
  };
  const first = accountAccessRequestFingerprint(input);
  assert.equal(first, accountAccessRequestFingerprint({ ...input }));
  assert.notEqual(first, accountAccessRequestFingerprint({ ...input, action: "restore" }));
  assert.notEqual(first, accountAccessRequestFingerprint({ ...input, reason: "manual restore" }));
  assert.equal(mapApiError(new AccountAccessServiceError("ACCOUNT_ACCESS_PREVIEW_STALE")).status, 409);
  assert.equal(mapApiError(new AccountAccessServiceError("ACCOUNT_ACCESS_ADMIN_STALE")).status, 409);
  assert.equal(mapApiError(new AccountAccessServiceError("ACCOUNT_ACCESS_SELF_FORBIDDEN")).status, 403);
  assert.equal(mapApiError(new AccountAccessServiceError("ACCOUNT_ACCESS_REASON_REQUIRED")).status, 400);
});

test("an actor from before disable and restore remains stale while the new epoch is accepted", async () => {
  const userId = "33333333-3333-4333-8333-333333333333";
  const states = [
    { disabledAt: null, accountAccessVersion: 1 },
    { disabledAt: new Date("2026-09-08T10:01:00.000Z"), accountAccessVersion: 2 },
    { disabledAt: null, accountAccessVersion: 3 },
  ] as const;
  let lookup = 0;
  const db = {
    appUser: {
      findUnique: async () => states[Math.min(lookup++, states.length - 1)],
    },
  } as unknown as Parameters<typeof assertAccountAccessForActor>[0];

  await assertAccountAccessForActor(db, { id: userId, accountAccessVersion: 1 });
  await assert.rejects(
    () => assertAccountAccessForActor(db, { id: userId, accountAccessVersion: 1 }),
    (error: unknown) => error instanceof AccountAccessGuardError && error.code === "ACCOUNT_DISABLED",
  );
  await assert.rejects(
    () => assertAccountAccessForActor(db, { id: userId, accountAccessVersion: 1 }),
    (error: unknown) => error instanceof AccountAccessGuardError && error.code === "ACCOUNT_ACCESS_STALE",
  );
  await assert.doesNotReject(() => assertAccountAccessForActor(db, { id: userId, accountAccessVersion: 3 }));
});

test("account access lifecycle is a separate preview and detail PATCH surface", async () => {
  const [schema, migration, epochMigration, auditDeletionMigration, multiFkAuditDeletionMigration, auth, service, collection, preview, detail, navigation, page] = await Promise.all([
    readFile("prisma/schema.prisma", "utf8"),
    readFile("prisma/migrations/20260905030000_harden_account_access_lifecycle/migration.sql", "utf8"),
    readFile("prisma/migrations/20260905040000_bind_personal_ai_owner_access_epoch/migration.sql", "utf8"),
    readFile("prisma/migrations/20260905045000_preserve_personal_ai_audit_on_project_deletion/migration.sql", "utf8"),
    readFile("prisma/migrations/20260905046000_preserve_personal_ai_audit_multi_fk_cascade/migration.sql", "utf8"),
    readFile("src/lib/auth.ts", "utf8"),
    readFile("src/lib/account-access-service.ts", "utf8"),
    readFile("src/app/api/system/account-access/route.ts", "utf8"),
    readFile("src/app/api/system/account-access/[userId]/preview/route.ts", "utf8"),
    readFile("src/app/api/system/account-access/[userId]/route.ts", "utf8"),
    readFile("src/components/admin-shell.tsx", "utf8"),
    readFile("src/app/system/account-access/page.tsx", "utf8"),
  ]);
  assert.match(schema, /accountAccessVersion\s+Int\s+@default\(1\)/u);
  assert.match(schema, /model AccountAccessMutationPreview/u);
  assert.match(schema, /model AccountAccessAudit/u);
  assert.match(schema, /accountAccessVersion\s+Int\s+@default\(1\)/u);
  assert.match(schema, /ownerAccountAccessVersion\s+Int\?/u);
  assert.match(schema, /connectionOwnerAccountAccessVersion\s+Int\?/u);
  assert.match(schema, /expectedEmbeddingConnectionOwnerAccountAccessVersion\s+Int\?/u);
  assert.match(service, /lockActorsAccess\(tx, \[adminId, targetId\]\)/u);
  assert.match(service, /ACCOUNT_ACCESS_SELF_FORBIDDEN/u);
  assert.match(service, /adminAccountAccessVersion/u);
  assert.match(service, /ACCOUNT_ACCESS_ADMIN_STALE/u);
  assert.match(service, /ACCOUNT_ACCESS_LAST_ADMIN_REQUIRED/u);
  assert.match(service, /set_config\('app\.account_access_lifecycle_context'/u);
  assert.match(service, /timeout: MUTATION_TRANSACTION_TIMEOUT_MS/u);
  assert.match(service, /isPrismaCode\(error, "P2028"\)/u);
  assert.match(service, /requestFingerprint/u);
  assert.match(service, /confirmationUsername/u);
  assert.match(auth, /session\.accountAccessVersion !== session\.user\.accountAccessVersion/u);
  assert.doesNotMatch(auth, /accountAccessVersion\s*\?\?\s*1/u);
  assert.match(auth, /accountAccessVersion,\s*tokenHash/u);
  assert.match(auth, /accountAccessVersion:\s*session\.accountAccessVersion/u);
  assert.match(auth, /user:\s*\{\s*is:\s*\{[\s\S]*accountAccessVersion:\s*session\.user\.accountAccessVersion/u);
  assert.match(migration, /AppUser_account_access_guard/u);
  assert.match(migration, /AppUser_account_access_audit_guard/u);
  assert.match(migration, /AccountAccessAudit_immutable_guard/u);
  assert.match(migration, /AccountAccessMutationPreview_guard/u);
  assert.match(migration, /AppSession_account_access_guard/u);
  assert.match(migration, /app session deletion is forbidden/u);
  assert.match(migration, /at least one enabled system admin is required/u);
  assert.match(migration, /admin_count\s*<=\s*1/u);
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/u);
  assert.match(epochMigration, /personal_ai_owner_account_access_epoch_valid/u);
  assert.match(epochMigration, /personal_memory_frozen_evidence_valid_without_epoch/u);
  assert.match(epochMigration, /NEW\."source" IS DISTINCT FROM 'personal_delegation'/u);
  assert.match(epochMigration, /NEW\."routeSource" IS DISTINCT FROM 'personal_delegation'/u);
  assert.match(epochMigration, /NEW\."expectedEmbeddingRouteSource" IS DISTINCT FROM 'personal_delegation'/u);
  assert.match(epochMigration, /app\.account_access_lifecycle_context/u);
  assert.match(epochMigration, /lifecycle_action IN \('disable', 'restore'\)/u);
  assert.match(auditDeletionMigration, /CREATE OR REPLACE FUNCTION "personal_ai_provider_call_audit_epoch_guard"/u);
  assert.match(auditDeletionMigration, /OLD\."webAiGrantId" IS NOT NULL[\s\S]*NEW\."webAiGrantId" IS NULL/u);
  assert.match(auditDeletionMigration, /OLD\."webAiGrantReferenceId" IS NOT DISTINCT FROM NEW\."webAiGrantReferenceId"/u);
  assert.match(auditDeletionMigration, /OLD\."webAiGrantProjectId" IS NOT DISTINCT FROM NEW\."webAiGrantProjectId"/u);
  assert.match(auditDeletionMigration, /OLD\."connectionOwnerAccountAccessVersion" IS NOT DISTINCT FROM NEW\."connectionOwnerAccountAccessVersion"/u);
  assert.match(auditDeletionMigration, /NOT EXISTS \(SELECT 1 FROM "ProjectAiProviderDelegation" WHERE "id" = NEW\."personalDelegationId"\)/u);
  assert.match(auditDeletionMigration, /receipt\."status" IN \('database_deleted', 'completed', 'cleanup_failed'\)/u);
  assert.doesNotMatch(auditDeletionMigration, /receipt\."status" IN \([^)]*'pending'/u);
  assert.match(multiFkAuditDeletionMigration, /CREATE OR REPLACE FUNCTION "personal_ai_provider_call_audit_epoch_guard"/u);
  assert.match(multiFkAuditDeletionMigration, /OLD\."jobId" IS NOT NULL[\s\S]*NEW\."jobId" IS NULL/u);
  assert.match(multiFkAuditDeletionMigration, /OLD\."webAiGrantId" IS NOT NULL[\s\S]*NEW\."webAiGrantId" IS NULL/u);
  assert.match(multiFkAuditDeletionMigration, /SELECT \* INTO audit_final[\s\S]*FROM "ProviderCallAudit"\s+WHERE "id" = NEW\."id"/u);
  assert.match(multiFkAuditDeletionMigration, /audit_final\."jobId" IS NULL[\s\S]*audit_final\."webAiGrantId" IS NULL/u);
  assert.match(multiFkAuditDeletionMigration, /audit_final\."connectionOwnerAccountAccessVersion" IS NOT DISTINCT FROM OLD\."connectionOwnerAccountAccessVersion"/u);
  assert.match(multiFkAuditDeletionMigration, /NOT EXISTS \(SELECT 1 FROM "ProjectAiProviderDelegation" WHERE "id" = audit_final\."personalDelegationId"\)/u);
  assert.match(multiFkAuditDeletionMigration, /receipt\."status" IN \('database_deleted', 'completed', 'cleanup_failed'\)/u);
  assert.doesNotMatch(multiFkAuditDeletionMigration, /receipt\."status" IN \([^)]*'pending'/u);
  assert.match(multiFkAuditDeletionMigration, /IF NEW\."connectionOwnerAccountAccessVersion" IS NULL THEN[\s\S]*PERSONAL_AI_ACCOUNT_EPOCH_INVALID/u);
  assert.match(collection, /export async function GET/u);
  assert.match(collection, /adminAccountAccessVersion: admin\.accountAccessVersion/u);
  assert.match(collection, /ACCOUNT_ACCESS_METHOD_NOT_ALLOWED/u);
  assert.match(preview, /export async function POST/u);
  assert.match(preview, /adminAccountAccessVersion: admin\.accountAccessVersion/u);
  assert.match(detail, /export async function PATCH/u);
  assert.match(detail, /adminAccountAccessVersion: admin\.accountAccessVersion/u);
  assert.match(detail, /export async function DELETE/u);
  assert.match(navigation, /accountAccess/u);
  assert.match(page, /requireSystemAdminPage/u);
});
