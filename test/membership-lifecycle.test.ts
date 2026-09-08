import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mapApiError } from "../src/lib/api-errors";
import { MembershipServiceError, membershipRequestFingerprint } from "../src/lib/membership-service";

test("membership lifecycle fingerprint is deterministic and action-sensitive", () => {
  const input = {
    userId: "22222222-2222-4222-8222-222222222222",
    action: "grant" as const,
    days: 30,
    note: "manual grant",
    expectedVersion: 0,
    impactFingerprint: "a".repeat(64),
    previewIssuedAt: "2026-09-08T10:00:00.000Z",
    previewExpiresAt: "2026-09-08T10:05:00.000Z",
  };
  const first = membershipRequestFingerprint(input);
  assert.equal(first, membershipRequestFingerprint({ ...input }));
  assert.notEqual(first, membershipRequestFingerprint({ ...input, action: "extend" }));
  assert.notEqual(first, membershipRequestFingerprint({ ...input, previewExpiresAt: "2026-09-08T10:06:00.000Z" }));
  assert.notEqual(first, membershipRequestFingerprint({ ...input, previewIssuedAt: "2026-09-08T09:59:00.000Z" }));
  assert.equal(mapApiError(new MembershipServiceError("MEMBERSHIP_PREVIEW_STALE")).status, 409);
  assert.equal(mapApiError(new MembershipServiceError("MEMBERSHIP_REASON_REQUIRED")).status, 400);
  assert.equal(mapApiError(new MembershipServiceError("MEMBERSHIP_DEPENDENCY_RESOLUTION_REQUIRED")).status, 409);
  assert.equal(new MembershipServiceError("MEMBERSHIP_REASON_REQUIRED").code, "MEMBERSHIP_REASON_REQUIRED");
});

test("membership mutation surface is preview plus detail PATCH only", async () => {
  const [service, collection, detail, preview, schema, migration] = await Promise.all([
    readFile("src/lib/membership-service.ts", "utf8"),
    readFile("src/app/api/system/memberships/route.ts", "utf8"),
    readFile("src/app/api/system/memberships/[userId]/route.ts", "utf8"),
    readFile("src/app/api/system/memberships/preview/route.ts", "utf8"),
    readFile("prisma/schema.prisma", "utf8"),
    readFile("prisma/migrations/20260905020000_harden_membership_subscription_lifecycle/migration.sql", "utf8"),
  ]);
  assert.match(service, /lockActorsAccess\(tx, \[adminId, targetId\]\)/u);
  assert.match(service, /MEMBERSHIP_DEPENDENCY_RESOLUTION_REQUIRED/u);
  assert.match(service, /set_config\('app\.membership_lifecycle_context'/u);
  assert.match(service, /requestFingerprint/u);
  assert.match(service, /delegation\."status" IN \('draft', 'owner_confirmed', 'active'\)/u);
  assert.doesNotMatch(
    service.slice(service.indexOf('FROM "ProjectAiProviderDelegation" delegation'), service.indexOf('GROUP BY delegation."projectId"')),
    /expiresAt/u,
  );
  assert.match(service, /nonTerminalPersonalDelegations/u);
  assert.match(service, /timeout: MEMBERSHIP_MUTATION_TRANSACTION_TIMEOUT_MS/u);
  assert.match(service, /isPrismaCode\(error, "P2028"\)/u);
  assert.match(service, /expired transaction/u);
  assert.equal(service.match(/isMembershipTransactionConflict\(error\)/gu)?.length, 2);
  const actionGuardOffset = service.lastIndexOf("assertActionAllowed(action, state);");
  const impactOffset = service.lastIndexOf("const currentImpact = impactFingerprint");
  assert.ok(actionGuardOffset >= 0 && impactOffset > actionGuardOffset, "execute checks lifecycle action before impact drift");
  assert.doesNotMatch(service, /export async function grantOrExtendMembership/u);
  assert.doesNotMatch(service, /export async function revokeMembership/u);
  assert.match(service, /previewIssuedAt/u);
  assert.match(service, /expiresAtMs - issuedAtMs/u);
  assert.match(collection, /MEMBERSHIP_METHOD_NOT_ALLOWED/u);
  assert.doesNotMatch(collection, /grantOrExtendMembership/u);
  assert.match(detail, /executeMembership/u);
  assert.match(detail, /export async function PATCH/u);
  assert.match(detail, /export async function DELETE/u);
  assert.match(preview, /export async function POST/u);
  assert.doesNotMatch(preview, /export async function GET/u);
  assert.match(schema, /versionBefore\s+Int\?/u);
  assert.match(schema, /impactFingerprint\s+String\?/u);
  assert.match(schema, /model MembershipMutationPreview/u);
  assert.match(schema, /previewId\s+String\?/u);
  assert.match(schema, /@@unique\(\[actorId, requestKey\]\)/u);
  assert.match(migration, /MembershipSubscription_lifecycle_guard/u);
  assert.match(migration, /MembershipSubscription_lifecycle_audit_guard/u);
  assert.match(migration, /MembershipSubscriptionAudit_immutable_guard/u);
  assert.match(migration, /membership subscription user ownership is immutable/u);
  assert.match(migration, /membership subscription delete is forbidden/u);
  assert.match(migration, /contractVersion.*<> 2/u);
  assert.match(migration, /MembershipSubscriptionAudit_lifecycle_transition_guard/u);
  assert.match(migration, /clock_timestamp()/u);
  assert.match(migration, /COALESCE\(\s*NULLIF\(current_setting\('app\.membership_preview_id', true\), ''\),\s*NULLIF\(current_setting\('app\.membership_lifecycle_preview_id', true\), ''\)/u);
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/u);
});
