import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const schema = readFileSync("prisma/schema.prisma", "utf8");
const migration = readFileSync("prisma/migrations/20260911010000_add_platform_token_governance/migration.sql", "utf8");
const service = readFileSync("src/lib/platform-credit-governance-service.ts", "utf8");
const principalCatalog = readFileSync("src/lib/database-principal-catalog.ts", "utf8");
const principalReconcile = readFileSync("scripts/reconcile-database-principals.ts", "utf8");
const systemAudit = readFileSync("src/lib/system-audit.ts", "utf8");
const routes = [
  readFileSync("src/app/api/admin/credits/grants/route.ts", "utf8"),
  readFileSync("src/app/api/admin/credits/grants/preview/route.ts", "utf8"),
  readFileSync("src/app/api/admin/credits/grants/execute/route.ts", "utf8"),
];
const ui = readFileSync("src/app/admin/models/platform-credit-governance-client.tsx", "utf8");

test("ENT-010 schema and migration preserve allocation facts and terminal accounting", () => {
  assert.match(schema, /model PlatformTokenReservationAllocation[\s\S]*@@unique\(\[reservationId, ordinal\]\)[\s\S]*@@unique\(\[reservationId, grantId\]\)/u);
  assert.match(schema, /model PlatformTokenGrantMutationPreview[\s\S]*previewExpiresAt[\s\S]*consumedAt/u);
  assert.match(schema, /model PlatformTokenGrantAudit[\s\S]*versionBefore[\s\S]*requestFingerprint/u);
  assert.match(migration, /INSERT INTO "PlatformTokenReservationAllocation"/u);
  assert.doesNotMatch(
    migration,
    /FROM "PlatformTokenReservation"[^;]*"releasedTokens"/u,
    "released totals belong to allocations, not the reservation parent",
  );
  assert.match(
    migration,
    /IF TG_TABLE_NAME = 'PlatformTokenReservation' THEN\s+reservation_id := NEW\."id";\s+ELSE\s+reservation_id := NEW\."reservationId";/u,
    "the shared deferred trigger must resolve table-specific NEW fields in separate PL/pgSQL branches",
  );
  assert.match(migration, /allocation total mismatch/u);
  assert.match(migration, /platform token reservation allocation facts are immutable/u);
  assert.match(migration, /platform token grant mutation previews are append-only/u);
  assert.match(migration, /platform token grant audit is append-only/u);
  assert.match(migration, /manual platform token grants require the database governance function/u);
  assert.match(migration, /SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, public/u);
  assert.match(migration, /REVOKE ALL ON FUNCTION "platform_token_runtime_apply"/u);
  assert.match(migration, /REVOKE ALL ON FUNCTION "platform_token_governance_apply"/u);
  assert.match(migration, /platform token manual ledger evidence is append-only/u);
  assert.match(migration, /clock_timestamp\(\) AT TIME ZONE 'UTC'/u);
  assert.match(migration, /requested_expires > clock_now \+ interval '1 hour'/u);
  assert.match(migration, /total_reserved::bigint <> \(\(raw_estimated::bigint \* quota_multiplier::bigint \+ 9999\) \/ 10000\)/u);
  assert.match(migration, /platform token preview timestamps must use the database clock/u);
  assert.match(migration, /platform token (?:reserve|settle|hold|release) ledger tuple mismatch/u);
  assert.match(migration, /allocationOrdinal/u);
});

test("ENT-010 service enforces writer, serializable locks and preview confirmation", () => {
  assert.match(service, /getEntitlementDb\(\)/u);
  assert.match(service, /assertEntitlementWriterSession/u);
  assert.match(service, /Prisma\.TransactionIsolationLevel\.Serializable/u);
  assert.match(service, /pg_advisory_xact_lock/u);
  assert.match(service, /PLATFORM_CREDIT_GOVERNANCE_PREVIEW_TTL_MS/u);
  assert.match(service, /PLATFORM_CREDIT_GOVERNANCE_CONFIRMATION_MISMATCH/u);
  assert.match(service, /consumedAt: null/u);
  assert.match(service, /requestFingerprint/u);
  assert.match(service, /impactFingerprint/u);
  assert.match(service, /grant\.kind !== "manual"/u);
  assert.match(service, /currentBlockers > 0/u);
  assert.match(service, /users: Object\.freeze\(users\.map/u);
  assert.match(service, /difference: PlatformCreditTargetUser\["difference"\]/u);
  assert.match(service, /availableTokens/u);
  assert.match(service, /reservedTokens/u);
  assert.match(service, /const statusWhere/u);
  assert.match(service, /grantPage/u);
  assert.match(service, /userPage/u);
  assert.match(service, /usersHasNextPage/u);
  assert.match(service, /sqlGovernance/u);
  assert.doesNotMatch(service, /const filtered = rows\.filter/u);
  assert.match(ui, /搜索会覆盖尚无额度记录的本地用户/u);
  assert.match(ui, /逐用户额度差异/u);
  assert.match(ui, /缺少额度/u);
  assert.match(ui, /value=\{selectedUserId\}/u);
});

test("ENT-010 principal boundary keeps governance tables writer-protected and allocation append-only", () => {
  assert.match(principalCatalog, /"PlatformTokenReservationAllocation"/u);
  assert.match(principalCatalog, /"PlatformTokenGrantMutationPreview"/u);
  assert.match(principalCatalog, /"PlatformTokenGrantAudit"/u);
  assert.match(principalCatalog, /ENTITLEMENT_PROTECTED_RELATIONS/u);
  assert.match(principalReconcile, /PLATFORM_TOKEN_RUNTIME_FUNCTION/u);
  assert.match(principalReconcile, /GRANT EXECUTE ON FUNCTION public\.\$\{runtimeFunction\}/u);
  assert.match(principalReconcile, /"PlatformTokenReservationAllocation"\]\.includes\(relation\)/u);
  assert.match(principalReconcile, /GRANT SELECT ON TABLE public\.\$\{quoted\}/u);
});

test("ENT-010 admin endpoints and audit projection stay strict and redacted", () => {
  for (const route of routes) {
    assert.match(route, /dynamic = "force-dynamic"/u);
    assert.match(route, /no-store/u);
  }
  assert.match(routes[1]!, /assertSameOrigin/u);
  assert.match(routes[2]!, /assertSameOrigin/u);
  assert.match(routes[0]!, /grantPage/u);
  assert.match(routes[0]!, /userPage/u);
  const auditEntry = systemAudit.match(/platformCreditGovernance:[\s\S]*?\n  \},/u)?.[0] ?? "";
  assert.notEqual(auditEntry, "");
  assert.doesNotMatch(auditEntry, /amount|fingerprint|ledger|raw/iu);
  assert.match(systemAudit, /fetchPlatformCreditGovernance/u);
  assert.match(ui, /平台额度治理/u);
  assert.match(ui, /预览补发/u);
  assert.match(ui, /确认并执行/u);
  assert.match(ui, /上一页/u);
  assert.match(ui, /下一页/u);
  assert.match(ui, /setGrantPage\(1\)/u);
  assert.match(ui, /setUserPage\(1\)/u);
  assert.doesNotMatch(ui, /\b[5-9]\d+px\b/u);
});
