import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ACCOUNT_ENTITLEMENT_INVENTORY_TABLES,
  AccountEntitlementInventoryError,
  buildAccountEntitlementInventoryReport,
  parseAccountEntitlementInventoryDatabaseUrl,
  readAccountEntitlementInventoryDatabaseUrl,
} from "../scripts/account-entitlement-inventory-contract";

test("account entitlement inventory is an aggregate-only restricted reader", async () => {
  const script = await readFile("scripts/account-entitlement-inventory.ts", "utf8");
  assert.deepEqual(ACCOUNT_ENTITLEMENT_INVENTORY_TABLES, [
    "AccountEntitlementActivation",
    "AccountEntitlementBackfillRun",
    "AccountEntitlementBackfillItem",
    "PlatformTokenGrant",
  ]);
  assert.match(script, /REPEATABLE READ READ ONLY/u);
  assert.match(script, /SET LOCAL search_path = pg_catalog, public/u);
  assert.match(script, /ROLLBACK/u);
  assert.match(script, /session_user = current_user/u);
  assert.match(script, /rolinherit/u);
  assert.match(script, /relkind IN \('r','p','v','m','f'\)/u);
  assert.match(script, /has_database_privilege\(current_user, current_database\(\), 'CREATE'\)/u);
  assert.match(script, /public\.account_entitlement_inventory_counts\(\)/u);
  assert.doesNotMatch(script, /FROM\s+"(?:AccountEntitlementActivation|AccountEntitlementBackfillRun|AccountEntitlementBackfillItem|PlatformTokenGrant)"/u);
  assert.doesNotMatch(script, /SET ROLE/u);
  assert.doesNotMatch(script, /SELECT[\s\S]{0,500}(?:"userId"|"evidenceRefDigest"|"impactFingerprint")/u);
  assert.doesNotMatch(script, /getDb|PrismaClient/u);
});

test("account entitlement inventory URL and report are strict and redacted", () => {
  const url = "postgresql://reader:reader-password@127.0.0.1:56432/ai_project_os_account_entitlement_inventory_test";
  assert.equal(parseAccountEntitlementInventoryDatabaseUrl(url), url);
  assert.equal(readAccountEntitlementInventoryDatabaseUrl({ ACCOUNT_ENTITLEMENT_INVENTORY_DATABASE_URL: url }), url);
  assert.throws(() => parseAccountEntitlementInventoryDatabaseUrl("postgresql://reader:password@example.com/db"), AccountEntitlementInventoryError);
  assert.deepEqual(buildAccountEntitlementInventoryReport({ eligible: 2, issued: 3, ambiguous: 4, missing: 1 }).counts, { eligible: 2, issued: 3, ambiguous: 4, missing: 1 });
  assert.throws(() => buildAccountEntitlementInventoryReport({ eligible: -1, issued: 0, ambiguous: 0, missing: 0 }), AccountEntitlementInventoryError);
});
