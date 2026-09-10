import "dotenv/config";
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { getDb } from "@/lib/db";
import {
  listSystemAudit,
  SYSTEM_AUDIT_DENYLIST_KEYS,
  SYSTEM_AUDIT_SOURCES,
} from "@/lib/system-audit";

const shouldRun = process.env.SYSTEM_AUDIT_POSTGRES_GATE === "1";

const expectedEnums: Readonly<Record<string, readonly string[]>> = {
  PlatformDefaultAiRouteAuditAction: ["draft_created", "draft_updated", "validated", "activated", "retired"],
  MembershipAuditEventKind: ["grant", "extend", "revoke"],
  AccountAccessAuditEvent: ["disabled", "restored"],
  MembershipAccessAuditAction: ["migration_quarantined", "confirmed", "revoked", "bootstrap_confirmed"],
  WorkspaceInvitationAuditEvent: ["created", "accepted", "revoked"],
  McpToolAttestationAuditEvent: ["attested", "revoked"],
  ProjectAiProviderDelegationAuditAction: ["proposed", "owner_confirmed", "activated", "rejected", "revoked", "expired", "platform_selected", "personal_selected", "selection_updated"],
  ProjectGitRepositoryDelegationAuditAction: ["proposed", "owner_confirmed", "activated", "rejected", "revoked", "expired"],
  ProjectMcpConnectionDelegationAuditAction: ["proposed", "owner_confirmed", "activated", "rejected", "revoked", "expired"],
  ProjectMcpToolGrantLedgerEvent: ["granted", "revoked"],
};

function assertLocalDatabaseUrl(value: string | undefined): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("SYSTEM_AUDIT_POSTGRES_DATABASE_URL_REQUIRED");
  const parsed = new URL(value);
  if (!(["postgres:", "postgresql:"] as readonly string[]).includes(parsed.protocol)) throw new Error("SYSTEM_AUDIT_POSTGRES_DATABASE_URL_INVALID");
  if (!(parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]")) throw new Error("SYSTEM_AUDIT_POSTGRES_DATABASE_URL_INVALID");
  if (parsed.search !== "" || parsed.hash !== "") throw new Error("SYSTEM_AUDIT_POSTGRES_DATABASE_URL_INVALID");
  return parsed.toString();
}

test(
  "system audit registry matches deployed PostgreSQL enums and critical projections",
  { skip: !shouldRun ? "SYSTEM_AUDIT_POSTGRES_GATE=1 is required" : false },
  async () => {
    const databaseUrl = assertLocalDatabaseUrl(process.env.DATABASE_URL);
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const enumRows = await client.query<{ typname: string; enumlabel: string }>(`
        SELECT type_meta.typname, enum_meta.enumlabel
        FROM pg_type AS type_meta
        JOIN pg_enum AS enum_meta ON enum_meta.enumtypid = type_meta.oid
        WHERE type_meta.typname = ANY($1::text[])
        ORDER BY type_meta.typname, enum_meta.enumsortorder
      `, [Object.keys(expectedEnums)]);
      const actualEnums = new Map<string, string[]>();
      for (const row of enumRows.rows) actualEnums.set(row.typname, [...(actualEnums.get(row.typname) ?? []), row.enumlabel]);
      for (const [name, expected] of Object.entries(expectedEnums)) assert.deepEqual(actualEnums.get(name), expected, name);
    } finally {
      await client.end();
    }

    const database = getDb();
    const page = await listSystemAudit({ pageSize: 50 }, database, new Date());
    assert.equal(page.pageSize, 50);
    assert.ok(page.events.every((event) => SYSTEM_AUDIT_SOURCES.includes(event.source)));
    const serialized = JSON.stringify(page).toLowerCase();
    for (const key of SYSTEM_AUDIT_DENYLIST_KEYS) assert.equal(serialized.includes(key.toLowerCase()), false, key);

    const platformPage = await listSystemAudit({ source: "platformDefaultAiRoute", pageSize: 1 }, database, new Date());
    assert.ok(platformPage.events.length <= 1);
    for (const event of platformPage.events) {
      assert.deepEqual(Object.keys(event.references).sort(), ["categories"]);
      assert.match(event.references.categories, /platformDefaultRoute/u);
    }
  },
);
