import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";

const gate = process.env.ACCOUNT_ENTITLEMENT_UPGRADE_POSTGRES_GATE;
const configuredUrl = process.env.ACCOUNT_ENTITLEMENT_UPGRADE_TEST_DATABASE_URL;
const shouldRun = gate === "1" && typeof configuredUrl === "string" && configuredUrl.length > 0;
const migrationRoot = join(process.cwd(), "prisma/migrations");
const targetMigration = "20260910040000_add_account_entitlement_activation";

function validateUrl(value: string): string {
  const parsed = new URL(value);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname.toLowerCase()) || parsed.port !== "56432" || parsed.pathname.length < 2 || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("ACCOUNT_ENTITLEMENT_UPGRADE_DATABASE_URL_INVALID");
  }
  return value;
}

async function migrationSqlBeforeTarget(): Promise<readonly string[]> {
  const entries = (await readdir(migrationRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{14}_/u.test(entry.name) && entry.name < targetMigration)
    .sort((left, right) => left.name.localeCompare(right.name));
  return Promise.all(entries.map((entry) => readFile(join(migrationRoot, entry.name, "migration.sql"), "utf8")));
}

async function targetMigrationSql(): Promise<string> {
  return readFile(join(migrationRoot, targetMigration, "migration.sql"), "utf8");
}

const ENUM_ADD_VALUE_LINE = /^\s*ALTER\s+TYPE\s+(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)\s+ADD\s+VALUE(?:\s+IF\s+NOT\s+EXISTS)?\s+'(?:''|[^'])*'\s*;\s*(?:--[^\r\n]*)?(?:\r?\n)?$/iu;
const DOLLAR_QUOTE_TAG = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/gu;

function advanceDollarQuoteState(line: string, currentTag: string | null): string | null {
  let tag = currentTag;
  let index = 0;
  while (index < line.length) {
    if (tag !== null) {
      const closeIndex = line.indexOf(tag, index);
      if (closeIndex < 0) return tag;
      index = closeIndex + tag.length;
      tag = null;
      continue;
    }
    const character = line[index];
    if (character === "-" && line[index + 1] === "-") break;
    if (character === "'") {
      index += 1;
      while (index < line.length) {
        if (line[index] === "'" && line[index + 1] === "'") {
          index += 2;
          continue;
        }
        if (line[index] === "'") {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (character === '"') {
      index += 1;
      while (index < line.length) {
        if (line[index] === '"' && line[index + 1] === '"') {
          index += 2;
          continue;
        }
        if (line[index] === '"') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (character === "$") {
      DOLLAR_QUOTE_TAG.lastIndex = index;
      const match = DOLLAR_QUOTE_TAG.exec(line);
      if (match?.index === index) {
        tag = match[0];
        index += tag.length;
        continue;
      }
    }
    index += 1;
  }
  return tag;
}

/**
 * Keep historical migrations in source order while giving each enum value its
 * own commit boundary.  This is intentionally line-based and dollar-quote
 * aware; splitting every semicolon would corrupt PL/pgSQL function bodies.
 */
export function splitMigrationAtEnumValueStatements(sql: string): readonly string[] {
  const chunks: string[] = [];
  let current = "";
  let dollarQuoteTag: string | null = null;
  for (const line of sql.split(/(?<=\n)/u)) {
    const isEnumValueLine = dollarQuoteTag === null && ENUM_ADD_VALUE_LINE.test(line);
    if (isEnumValueLine) {
      if (current.length > 0) chunks.push(current);
      chunks.push(line);
      current = "";
    } else {
      current += line;
    }
    dollarQuoteTag = advanceDollarQuoteState(line, dollarQuoteTag);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function executeHistoricalMigration(client: Client, sql: string): Promise<void> {
  for (const chunk of splitMigrationAtEnumValueStatements(sql)) {
    if (chunk.trim().length === 0) continue;
    await client.query("BEGIN");
    try {
      await client.query(chunk);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}

async function resetAndApplyBeforeTarget(client: Client): Promise<void> {
  await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  for (const sql of await migrationSqlBeforeTarget()) await executeHistoricalMigration(client, sql);
}

test("upgrade fixture preserves migration order without splitting PL/pgSQL", async () => {
  const migration = [
    "ALTER TYPE \"Example\" ADD VALUE 'first';\n",
    "CREATE FUNCTION example() RETURNS void LANGUAGE plpgsql AS $$\n",
    "BEGIN\n  ALTER TYPE \"InsideFunction\" ADD VALUE 'not-a-boundary';\nEND;\n",
    "$$;\n",
    "ALTER TYPE \"Example\" ADD VALUE IF NOT EXISTS 'second';\n",
    "CREATE TABLE example_row (value text);\n",
  ].join("");
  const chunks = splitMigrationAtEnumValueStatements(migration);
  assert.equal(chunks.join(""), migration);
  assert.deepEqual(chunks.filter((chunk) => ENUM_ADD_VALUE_LINE.test(chunk)), [
    "ALTER TYPE \"Example\" ADD VALUE 'first';\n",
    "ALTER TYPE \"Example\" ADD VALUE IF NOT EXISTS 'second';\n",
  ]);
  assert.equal(chunks.some((chunk) => chunk.includes("ALTER TYPE \"InsideFunction\" ADD VALUE 'not-a-boundary';")), true);
  const source = await readFile(new URL(import.meta.url), "utf8");
  assert.match(source, /for \(const sql of await migrationSqlBeforeTarget\(\)\) await executeHistoricalMigration\(client, sql\);/u);
  assert.match(source, /await client\.query\(await targetMigrationSql\(\)\);/u);
});

async function seedLegacyAccounting(client: Client, mode: "valid" | "missingLedger" | "mismatchLedger" | "duplicateGrant"): Promise<{ grantId: string; userId: string }> {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const grantId = randomUUID();
  const now = new Date("2026-09-10T00:00:00.000Z");
  await client.query(`INSERT INTO "AppUser" ("id","username","role","updatedAt") VALUES ($1,$2,'user',$3),($4,$5,'user',$3)`, [userId, `upgrade_${userId.slice(0, 8)}`, now, otherUserId, `upgrade_${otherUserId.slice(0, 8)}`]);
  if (mode === "duplicateGrant") await client.query('DROP INDEX "PlatformTokenGrant_userId_kind_key"');
  await client.query(`INSERT INTO "PlatformTokenGrant" ("id","userId","kind","amount","remainingTokens","offerVersion","issuedAt","expiresAt","createdAt","updatedAt") VALUES ($1,$2,'signup',500000,500000,'signup-500k-v1',$3,$4,$3,$3)`, [grantId, userId, now, new Date("2026-10-10T00:00:00.000Z")]);
  if (mode === "duplicateGrant") await client.query(`INSERT INTO "PlatformTokenGrant" ("id","userId","kind","amount","remainingTokens","offerVersion","issuedAt","expiresAt","createdAt","updatedAt") VALUES ($1,$2,'signup',500000,500000,'signup-500k-v1',$3,$4,$3,$3)`, [randomUUID(), userId, now, new Date("2026-10-10T00:00:00.000Z")]);
  if (mode !== "missingLedger") {
    await client.query(`INSERT INTO "PlatformTokenLedgerEntry" ("id","userId","grantId","entryKind","amount","reasonCode","idempotencyKey","metadata","createdAt") VALUES ($1,$2,$3,'grant',$4,$5,$6,'{}',$7)`, [randomUUID(), mode === "mismatchLedger" ? otherUserId : userId, grantId, mode === "mismatchLedger" ? 1 : 500000, mode === "mismatchLedger" ? "WRONG" : "AI_SIGNUP_GRANT", mode === "mismatchLedger" ? `upgrade:${grantId}` : `grant:signup:${userId}:signup-500k-v1`, now]);
  }
  return { grantId, userId };
}

async function assertUpgradeRejected(client: Client, mode: "missingLedger" | "mismatchLedger" | "duplicateGrant"): Promise<void> {
  await resetAndApplyBeforeTarget(client);
  const seeded = await seedLegacyAccounting(client, mode);
  await assert.rejects(() => targetMigrationSql().then((sql) => client.query(sql)));
  const oldIndex = await client.query(`SELECT 1 FROM pg_class WHERE relname = 'PlatformTokenGrant_userId_kind_key'`);
  assert.equal(oldIndex.rowCount, mode === "duplicateGrant" ? 0 : 1);
  const accounting = await client.query<{ grant_count: string; ledger_count: string }>(
    `SELECT (SELECT COUNT(*)::text FROM "PlatformTokenGrant" WHERE "userId" = $1 AND "kind" = 'signup') AS grant_count,
            (SELECT COUNT(*)::text FROM "PlatformTokenLedgerEntry" WHERE "grantId" = $2) AS ledger_count`,
    [seeded.userId, seeded.grantId],
  );
  assert.deepEqual(accounting.rows[0], {
    grant_count: mode === "duplicateGrant" ? "2" : "1",
    ledger_count: mode === "missingLedger" ? "0" : "1",
  });
  for (const relationName of [
    "AccountEntitlementActivation",
    "AccountEntitlementActivationAudit",
    "AccountEntitlementBackfillRun",
    "AccountEntitlementBackfillItem",
    "AccountEntitlementBackfillAudit",
    "PlatformTokenGrant_userId_offerVersion_signup_key",
    "PlatformTokenLedgerEntry_signup_grant_key",
  ]) {
    const relation = await client.query(`SELECT 1 FROM pg_class WHERE relname = $1`, [relationName]);
    assert.equal(relation.rowCount, 0, `${relationName} must roll back with the rejected migration`);
  }
  for (const triggerName of ["AccountEntitlementSignupGrant_insert_link_guard", "AccountEntitlementSignupLedger_insert_link_guard"]) {
    const trigger = await client.query(`SELECT 1 FROM pg_trigger WHERE tgname = $1`, [triggerName]);
    assert.equal(trigger.rowCount, 0, `${triggerName} must roll back with the rejected migration`);
  }
}

async function captureAccountingRows(client: Client, userId: string): Promise<Readonly<{
  grants: readonly Record<string, unknown>[];
  ledger: readonly Record<string, unknown>[];
  reservations: readonly Record<string, unknown>[];
}>> {
  const [grants, ledger, reservations] = await Promise.all([
    client.query<Record<string, unknown>>(`SELECT * FROM "PlatformTokenGrant" WHERE "userId" = $1 ORDER BY "id"`, [userId]),
    client.query<Record<string, unknown>>(`SELECT * FROM "PlatformTokenLedgerEntry" WHERE "userId" = $1 ORDER BY "id"`, [userId]),
    client.query<Record<string, unknown>>(`SELECT * FROM "PlatformTokenReservation" WHERE "userId" = $1 ORDER BY "id"`, [userId]),
  ]);
  return { grants: grants.rows, ledger: ledger.rows, reservations: reservations.rows };
}

async function assertLateFailureRollback(client: Client): Promise<void> {
  await resetAndApplyBeforeTarget(client);
  const seeded = await seedLegacyAccounting(client, "valid");
  await client.query("BEGIN");
  try {
    const sql = await targetMigrationSql();
    await assert.rejects(
      () => client.query(`${sql}\nDO $$ BEGIN RAISE EXCEPTION 'ENT_009_LATE_FAILURE'; END $$;`),
      /ENT_009_LATE_FAILURE/u,
    );
  } finally {
    await client.query("ROLLBACK");
  }
  const oldIndex = await client.query(`SELECT 1 FROM pg_class WHERE relname = 'PlatformTokenGrant_userId_kind_key'`);
  const activationTable = await client.query(`SELECT 1 FROM pg_class WHERE relname = 'AccountEntitlementActivation'`);
  const newGrantIndex = await client.query(`SELECT 1 FROM pg_class WHERE relname = 'PlatformTokenLedgerEntry_signup_grant_key'`);
  const newTrigger = await client.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'AccountEntitlementSignupGrant_insert_link_guard'`);
  const preserved = await client.query<{ grant_count: string; ledger_count: string }>(
    `SELECT (SELECT COUNT(*)::text FROM "PlatformTokenGrant" WHERE "id"=$1) AS grant_count,
            (SELECT COUNT(*)::text FROM "PlatformTokenLedgerEntry" WHERE "grantId"=$1) AS ledger_count`,
    [seeded.grantId],
  );
  assert.equal(oldIndex.rowCount, 1);
  assert.equal(activationTable.rowCount, 0);
  assert.equal(newGrantIndex.rowCount, 0);
  assert.equal(newTrigger.rowCount, 0);
  assert.deepEqual(preserved.rows[0], { grant_count: "1", ledger_count: "1" });
}

test("account entitlement upgrade gate requires an explicit disposable target", {
  skip: gate === "1" && configuredUrl !== undefined ? false : "ACCOUNT_ENTITLEMENT_UPGRADE_POSTGRES_GATE=1 and test URL are required",
}, () => {
  assert.ok(configuredUrl);
});

test("ENT-009 upgrade preserves legacy accounting and rejects unsafe preflight atomically", {
  skip: !shouldRun ? "explicit disposable PostgreSQL upgrade gate is required" : false,
}, async () => {
  const client = new Client({ connectionString: validateUrl(configuredUrl!) });
  await client.connect();
  try {
    await resetAndApplyBeforeTarget(client);
    const seeded = await seedLegacyAccounting(client, "valid");
    const manualGrantId = randomUUID();
    const manualNow = new Date("2026-09-10T00:00:00.000Z");
    await client.query(
      `INSERT INTO "PlatformTokenGrant" ("id","userId","kind","amount","remainingTokens","offerVersion","issuedAt","expiresAt","createdAt","updatedAt")
       VALUES ($1,$2,'manual',777,701,'manual-legacy',$3,$4,$3,$3)`,
      [manualGrantId, seeded.userId, manualNow, new Date("2026-10-10T00:00:00.000Z")],
    );
    await client.query(
      `INSERT INTO "PlatformTokenLedgerEntry" ("id","userId","grantId","entryKind","amount","reasonCode","idempotencyKey","metadata","createdAt")
       VALUES ($1,$2,$3,'grant',777,'MANUAL_GRANT',$4,'{}',$5)`,
      [randomUUID(), seeded.userId, manualGrantId, `upgrade:manual:${manualGrantId}`, manualNow],
    );
    const reservationId = randomUUID();
    const now = new Date("2026-09-10T00:00:00.000Z");
    const reservationIds: string[] = [];
    for (const status of ["reserved", "settled", "held"] as const) {
      const currentReservationId = randomUUID();
      reservationIds.push(currentReservationId);
      await client.query(`INSERT INTO "PlatformTokenReservation" ("id","userId","grantId","callKey","operation","modelId","status","reservedTokens","rawEstimatedTokens","quotaMultiplierBps","expiresAt","createdAt") VALUES ($1,$2,$3,$4,'autoExtract','model',$5,1,1,10000,$6,$6)`, [currentReservationId, seeded.userId, seeded.grantId, `upgrade:${status}:${reservationId}`, status, new Date(now.getTime() + 86_400_000)]);
      await client.query(`INSERT INTO "PlatformTokenLedgerEntry" ("id","userId","grantId","reservationId","entryKind","amount","reasonCode","idempotencyKey","metadata","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{}',$9)`, [randomUUID(), seeded.userId, seeded.grantId, currentReservationId, status === "reserved" ? "reserve" : status === "settled" ? "settle" : "hold", status === "reserved" ? -1 : 0, `UPGRADE_${status.toUpperCase()}`, `upgrade:ledger:${status}:${reservationId}`, now]);
    }
    const before = await captureAccountingRows(client, seeded.userId);
    await client.query(await targetMigrationSql());
    const after = await captureAccountingRows(client, seeded.userId);
    assert.deepEqual(after, before);
    assert.equal(after.grants.filter((row) => row.id === manualGrantId).length, 1);
    assert.equal(after.reservations.length, reservationIds.length);
    await assertLateFailureRollback(client);
    for (const mode of ["missingLedger", "mismatchLedger", "duplicateGrant"] as const) await assertUpgradeRejected(client, mode);
  } finally {
    await client.end();
  }
});
