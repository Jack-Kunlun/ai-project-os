import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { accountEntitlementPolicyFingerprint } from "../src/lib/account-entitlement-activation-service";
import { runAccountEntitlementInventory } from "../scripts/account-entitlement-inventory";

const shouldRun = process.env.ACCOUNT_ENTITLEMENT_INVENTORY_POSTGRES_GATE === "1";
const configuredUrl = process.env.ACCOUNT_ENTITLEMENT_INVENTORY_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const configuredAdminUrl = process.env.POSTGRES_GATE_ADMIN_URL;

function databaseName(): string {
  if (typeof configuredUrl !== "string") throw new Error("ACCOUNT_ENTITLEMENT_INVENTORY_TEST_DATABASE_URL_REQUIRED");
  const parsed = new URL(configuredUrl);
  const name = decodeURIComponent(parsed.pathname.slice(1));
  if (!/^ai_project_os_[a-z0-9_]+(?:_test|_world)$/u.test(name)) throw new Error("ACCOUNT_ENTITLEMENT_INVENTORY_DATABASE_NAME_INVALID");
  return name;
}

function adminDatabaseUrl(): string {
  if (typeof configuredAdminUrl !== "string") throw new Error("POSTGRES_GATE_ADMIN_URL_REQUIRED");
  const parsed = new URL(configuredAdminUrl);
  parsed.pathname = `/${databaseName()}`;
  return parsed.toString();
}

function fixtureOwnerDatabaseUrl(): string {
  if (typeof configuredUrl !== "string") throw new Error("ACCOUNT_ENTITLEMENT_INVENTORY_TEST_DATABASE_URL_REQUIRED");
  let parsed: URL;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new Error("ACCOUNT_ENTITLEMENT_INVENTORY_FIXTURE_OWNER_URL_INVALID");
  }
  if (!(parsed.protocol === "postgres:" || parsed.protocol === "postgresql:")
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== `/${databaseName()}`
    || parsed.username !== "ai_project_os_gate"
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== "") {
    throw new Error("ACCOUNT_ENTITLEMENT_INVENTORY_FIXTURE_OWNER_URL_INVALID");
  }
  return parsed.toString();
}

function readerDatabaseUrl(roleName: string, password: string): string {
  if (typeof configuredUrl !== "string") throw new Error("ACCOUNT_ENTITLEMENT_INVENTORY_TEST_DATABASE_URL_REQUIRED");
  const parsed = new URL(configuredUrl);
  parsed.username = roleName;
  parsed.password = password;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function readerAdapter(client: Client) {
  return {
    query: async <Row = unknown>(text: string, values?: readonly unknown[]) => {
      const result = await client.query(text, values === undefined ? undefined : [...values]);
      return { rows: result.rows as readonly Row[] };
    },
  };
}

async function seedAggregateFixture(fixtureOwner: Client): Promise<Readonly<{ userId: string }>> {
  const adminId = randomUUID();
  const userId = randomUUID();
  const issuedUserId = randomUUID();
  const activationId = randomUUID();
  const activationAuditId = randomUUID();
  const issuedActivationId = randomUUID();
  const issuedActivationAuditId = randomUUID();
  const issuedGrantId = randomUUID();
  const runId = randomUUID();
  const itemId = randomUUID();
  const issuedItemId = randomUUID();
  const runAuditId = randomUUID();
  const policyId = randomUUID();
  const policyAuditId = randomUUID();
  const policyMutationId = randomUUID();
  const mutationId = randomUUID();
  const backfillMutationId = randomUUID();
  const now = new Date("2026-09-10T00:00:00.000Z");
  const expiresAt = new Date("2026-09-10T00:15:00.000Z");
  const offerVersion = `inventory-grant-${userId.slice(0, 8)}`;
  const policyFingerprint = accountEntitlementPolicyFingerprint({
    offerVersion,
    amount: 500,
    validForDays: 30,
    eligibilityKey: "verified_identity_v1",
  });
  await fixtureOwner.query("BEGIN");
  try {
    await fixtureOwner.query(
      `INSERT INTO "AppUser" ("id","username","role","createdAt","updatedAt")
       VALUES ($1,$2,'admin',$3,$3),($4,$5,'user',$3,$3),($6,$7,'user',$3,$3)`,
      [adminId, `inventory_admin_${adminId.slice(0, 8)}`, now, userId, `inventory_user_${userId.slice(0, 8)}`, issuedUserId, `inventory_issued_${issuedUserId.slice(0, 8)}`],
    );
    await fixtureOwner.query("SELECT set_config('app.account_entitlement_activation_context','service-v1',true)");
    await fixtureOwner.query("SELECT set_config('app.account_entitlement_activation_transaction_id',$1,true)", [mutationId]);
    await fixtureOwner.query(
      `INSERT INTO "AccountEntitlementActivation"
        ("id","userId","lifecycleKey","source","actorKind","actorId","accountAccessVersion","decision","status","mutationTransactionId","createdAt")
       VALUES ($1,$2,'initial_account_v1','oidcRegistration','system',NULL,1,'no_active_offer','no_active_offer',$3,$4)`,
      [activationId, userId, mutationId, now],
    );
    await fixtureOwner.query(
      `INSERT INTO "AccountEntitlementActivationAudit"
        ("id","activationId","userId","source","action","decision","statusAfter","actorKind","actorId","mutationTransactionId","createdAt")
       VALUES ($1,$2,$3,'oidcRegistration','created','no_active_offer','no_active_offer','system',NULL,$4,$5)`,
      [activationAuditId, activationId, userId, mutationId, now],
    );

    await fixtureOwner.query("SELECT set_config('app.platform_grant_offer_policy_context','service-v1',true)");
    await fixtureOwner.query("SELECT set_config('app.platform_grant_offer_policy_transaction_id',$1,true)", [policyMutationId]);
    await fixtureOwner.query(
      `INSERT INTO "PlatformGrantOfferPolicy"
        ("id","offerVersion","status","amount","validForDays","eligibilityKey","createdById","updatedById","activatedById","activatedAt","createdAt","updatedAt")
       VALUES ($1,$2,'active',500,30,'verified_identity_v1',$3,$3,$3,$4,$4,$4)`,
      [policyId, offerVersion, adminId, now],
    );
    await fixtureOwner.query(
      `INSERT INTO "PlatformGrantOfferPolicyAudit"
        ("id","policyId","action","statusBefore","statusAfter","offerVersion","amount","validForDays","eligibilityKey","reasonRecorded","reason","actorId","transactionId","createdAt")
       VALUES ($1,$2,'created',NULL,'active',$3,500,30,'verified_identity_v1',TRUE,'inventory fixture policy',$4,$5,$6)`,
      [policyAuditId, policyId, offerVersion, adminId, policyMutationId, now],
    );

    await fixtureOwner.query(
      `INSERT INTO "PlatformTokenGrant"
        ("id","userId","kind","amount","remainingTokens","offerVersion","offerAmount","offerValidForDays","eligibilityKey","eligibilitySource","issuedById","issuedAt","expiresAt","createdAt","updatedAt")
       VALUES ($1,$2,'signup',500,500,$3,500,30,'verified_identity_v1','oidcRegistration',NULL,$4,$5,$4,$4)`,
      [issuedGrantId, issuedUserId, offerVersion, now, new Date("2026-10-10T00:00:00.000Z")],
    );
    await fixtureOwner.query(
      `INSERT INTO "PlatformTokenLedgerEntry"
        ("id","userId","grantId","entryKind","amount","reasonCode","idempotencyKey","metadata","createdAt")
       VALUES ($1,$2,$3,'grant',500,'AI_SIGNUP_GRANT',$4,$5,$6)`,
      [randomUUID(), issuedUserId, issuedGrantId, `grant:signup:${issuedUserId}:${offerVersion}`, JSON.stringify({ offerVersion, eligibilityKey: "verified_identity_v1", eligibilitySource: "oidcRegistration" }), now],
    );
    await fixtureOwner.query(
      `INSERT INTO "AccountEntitlementActivation"
        ("id","userId","lifecycleKey","source","actorKind","actorId","accountAccessVersion","policyId","policyRevision","policyFingerprint","offerVersion","offerAmount","offerValidForDays","eligibilityKey","grantId","decision","status","mutationTransactionId","createdAt")
       VALUES ($1,$2,'initial_account_v1','oidcRegistration','system',NULL,1,$3,1,$4,$5,500,30,'verified_identity_v1',$6,'granted','granted',$7,$8)`,
      [issuedActivationId, issuedUserId, policyId, policyFingerprint, offerVersion, issuedGrantId, mutationId, now],
    );
    await fixtureOwner.query(
      `INSERT INTO "AccountEntitlementActivationAudit"
        ("id","activationId","userId","source","action","decision","statusAfter","actorKind","actorId","offerVersion","offerAmount","offerValidForDays","eligibilityKey","policyRevision","mutationTransactionId","createdAt")
       VALUES ($1,$2,$3,'oidcRegistration','created','granted','granted','system',NULL,$4,500,30,'verified_identity_v1',1,$5,$6)`,
      [issuedActivationAuditId, issuedActivationId, issuedUserId, offerVersion, mutationId, now],
    );

    await fixtureOwner.query("SELECT set_config('app.account_entitlement_backfill_context','service-v1',true)");
    await fixtureOwner.query("SELECT set_config('app.account_entitlement_backfill_transaction_id',$1,true)", [backfillMutationId]);
    await fixtureOwner.query(
      `INSERT INTO "AccountEntitlementBackfillRun"
        ("id","actorId","actorAccountAccessVersion","status","snapshotAt","expiresAt","candidateCount","alreadyIssuedCount","eligibleMissingCount","legacyAmbiguousCount","impactFingerprint","transitionAt","createdAt")
       VALUES ($1,$2,1,'previewed',$3,$4,2,1,0,1,repeat('0',64),$3,$3)`,
      [runId, adminId, now, expiresAt],
    );
    await fixtureOwner.query(
      `INSERT INTO "AccountEntitlementBackfillItem"
        ("id","runId","userId","accountAccessVersion","classification","status","evidenceKind","evidenceRefDigest","createdAt")
       VALUES ($1,$2,$3,1,'legacy_ambiguous','pending','unproven-history',repeat('1',64),$4)`,
      [itemId, runId, userId, now],
    );
    await fixtureOwner.query(
      `INSERT INTO "AccountEntitlementBackfillItem"
        ("id","runId","userId","accountAccessVersion","classification","status","evidenceKind","evidenceRefDigest","existingGrantId","activationId","createdAt")
       VALUES ($1,$2,$3,1,'already_issued','pending','existing-entitlement',repeat('2',64),$4,$5,$6)`,
      [issuedItemId, runId, issuedUserId, issuedGrantId, issuedActivationId, now],
    );
    await fixtureOwner.query(
      `INSERT INTO "AccountEntitlementBackfillAudit"
        ("id","runId","action","statusBefore","statusAfter","actorId","reasonRecorded","createdAt")
       VALUES ($1,$2,'previewed',NULL,'previewed',$3,false,$4)`,
      [runAuditId, runId, adminId, now],
    );
    await fixtureOwner.query("COMMIT");
    return { userId };
  } catch (error) {
    await fixtureOwner.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function runWithReader(databaseUrl: string): Promise<Awaited<ReturnType<typeof runAccountEntitlementInventory>>> {
  const reader = new Client({ connectionString: databaseUrl });
  await reader.connect();
  try {
    return await runAccountEntitlementInventory(readerAdapter(reader));
  } finally {
    await reader.end();
  }
}

test("account entitlement inventory PostgreSQL reader gate requires independent admin and reader URLs", {
  skip: !shouldRun ? "ACCOUNT_ENTITLEMENT_INVENTORY_POSTGRES_GATE=1 is required" : false,
}, () => {
  assert.ok(configuredUrl);
  assert.ok(configuredAdminUrl);
});

test("account entitlement inventory uses a direct restricted reader and rolls back", {
  skip: !shouldRun || configuredUrl === undefined || configuredAdminUrl === undefined ? "explicit disposable PostgreSQL gate is required" : false,
}, async () => {
  const ownerUrl = fixtureOwnerDatabaseUrl();
  const adminUrl = adminDatabaseUrl();
  assert.notEqual(new URL(adminUrl).username, new URL(ownerUrl).username);
  const admin = new Client({ connectionString: adminUrl });
  const fixtureOwner = new Client({ connectionString: ownerUrl });
  const roleName = `entitlement_inventory_reader_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const password = `InventoryReader_${randomUUID().replaceAll("-", "")}`;
  const database = databaseName();
  try {
    await admin.connect();
    await fixtureOwner.connect();
    await admin.query(`CREATE ROLE ${quoteIdentifier(roleName)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${quoteLiteral(password)}`);
    await admin.query(`ALTER ROLE ${quoteIdentifier(roleName)} SET default_transaction_read_only = 'on'`);
    const fixture = await seedAggregateFixture(fixtureOwner);
    await fixtureOwner.query(`
      CREATE OR REPLACE FUNCTION public."account_entitlement_inventory_counts"()
      RETURNS TABLE (eligible bigint, issued bigint, ambiguous bigint, missing bigint)
      LANGUAGE sql
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $inventory$
        WITH latest_run AS (
          SELECT "id" FROM public."AccountEntitlementBackfillRun"
          ORDER BY "createdAt" DESC, "id" DESC LIMIT 1
        ),
        item_counts AS (
          SELECT
            COUNT(*) FILTER (WHERE "classification" IN ('eligible_missing', 'already_issued'))::bigint AS eligible,
            COUNT(*) FILTER (WHERE "classification" = 'eligible_missing' AND "status" = 'pending')::bigint AS missing,
            COUNT(*) FILTER (WHERE "classification" = 'legacy_ambiguous')::bigint AS ambiguous
          FROM public."AccountEntitlementBackfillItem" item
          WHERE item."runId" = (SELECT "id" FROM latest_run)
        ),
        issued_counts AS (
          SELECT COUNT(DISTINCT "userId")::bigint AS issued
          FROM public."PlatformTokenGrant"
          WHERE "kind" = 'signup'
        )
        SELECT item_counts.eligible, issued_counts.issued, item_counts.ambiguous, item_counts.missing
          FROM item_counts CROSS JOIN issued_counts
      $inventory$;
    `);
    await fixtureOwner.query(`REVOKE ALL ON FUNCTION public."account_entitlement_inventory_counts"() FROM PUBLIC`);
    await fixtureOwner.query(`GRANT EXECUTE ON FUNCTION public."account_entitlement_inventory_counts"() TO ${quoteIdentifier(roleName)}`);
    await admin.query("BEGIN");
    try {
      const mutationId = randomUUID();
      await admin.query("SELECT set_config('app.account_entitlement_activation_context','service-v1',true)");
      await admin.query("SELECT set_config('app.account_entitlement_activation_transaction_id',$1,true)", [mutationId]);
      await assert.rejects(
        () => admin.query(
          `INSERT INTO "AccountEntitlementActivation"
            ("id","userId","lifecycleKey","source","actorKind","actorId","accountAccessVersion","decision","status","mutationTransactionId")
           VALUES ($1,$2,'inventory_non_owner_rejection_v1','oidcRegistration','system',NULL,1,'no_active_offer','no_active_offer',$3)`,
          [randomUUID(), fixture.userId, mutationId],
        ),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "42501",
      );
    } finally {
      await admin.query("ROLLBACK").catch(() => undefined);
    }
    await admin.query(`ALTER DATABASE ${quoteIdentifier(database)} SET default_transaction_read_only = 'on'`);
    await admin.query(`REVOKE TEMPORARY, CREATE ON DATABASE ${quoteIdentifier(database)} FROM PUBLIC`);
    await admin.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await admin.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(roleName)}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(roleName)}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION public."account_entitlement_inventory_counts"() TO ${quoteIdentifier(roleName)}`);

    const report = await runWithReader(readerDatabaseUrl(roleName, password));
    assert.equal(report.ok, true);
    assert.deepEqual(report.counts, { eligible: 1, issued: 1, ambiguous: 1, missing: 0 });

    const publicGrant = await admin.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('public', 'public.\"PlatformTokenGrant\"', 'SELECT') AS allowed",
    );
    assert.equal(publicGrant.rows[0]?.allowed, false);
    const rawReader = new Client({ connectionString: readerDatabaseUrl(roleName, password) });
    await rawReader.connect();
    try {
      await assert.rejects(
        () => rawReader.query('SELECT "userId" FROM "PlatformTokenGrant" LIMIT 1'),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "42501",
      );
    } finally {
      await rawReader.end();
    }
    await admin.query(`GRANT SELECT ON "PlatformTokenGrant" TO ${quoteIdentifier(roleName)}`);
    await assert.rejects(
      () => runWithReader(readerDatabaseUrl(roleName, password)),
      /ACCOUNT_ENTITLEMENT_INVENTORY_PREFLIGHT_FAILED/u,
    );
    await admin.query(`REVOKE SELECT ON "PlatformTokenGrant" FROM ${quoteIdentifier(roleName)}`);

    const reader = new Client({ connectionString: readerDatabaseUrl(roleName, password) });
    await reader.connect();
    try {
      await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await assert.rejects(
        () => reader.query(`INSERT INTO "AppUser" ("id","username") VALUES (gen_random_uuid(),'inventory_should_fail')`),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && ["25006", "42501"].includes(String((error as { code?: unknown }).code)),
      );
      await reader.query("ROLLBACK");
    } finally {
      await reader.end();
    }

    await admin.query(`GRANT CREATE ON SCHEMA public TO ${quoteIdentifier(roleName)}`);
    await assert.rejects(
      () => runWithReader(readerDatabaseUrl(roleName, password)),
      /ACCOUNT_ENTITLEMENT_INVENTORY_PREFLIGHT_FAILED/u,
    );
    await admin.query(`REVOKE CREATE ON SCHEMA public FROM ${quoteIdentifier(roleName)}`);
  } finally {
    await admin.query(`ALTER DATABASE ${quoteIdentifier(database)} RESET default_transaction_read_only`).catch(() => undefined);
    await admin.query(`DROP OWNED BY ${quoteIdentifier(roleName)}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(roleName)}`).catch(() => undefined);
    await fixtureOwner.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});
