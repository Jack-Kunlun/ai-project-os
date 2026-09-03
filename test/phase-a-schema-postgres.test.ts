import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDb } from "../src/lib/db";

const shouldRun = process.env.SYSTEM_ROLE_COMPATIBILITY_POSTGRES_GATE === "1";
const testDatabaseName = "ai_project_os_system_role_compatibility_test";
const compatibilityMigrationName = "20260903010000_add_user_system_role_compatibility";

function assertDisposableGateDatabase(): void {
  const configuredUrl = process.env.DATABASE_URL;
  if (typeof configuredUrl !== "string" || configuredUrl.length === 0) {
    throw new Error("SYSTEM_ROLE_COMPATIBILITY_TEST_DATABASE_URL_REQUIRED");
  }

  let parsed: URL;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new Error("SYSTEM_ROLE_COMPATIBILITY_TEST_DATABASE_URL_INVALID");
  }

  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase())
    || parsed.port !== "56432"
    || parsed.pathname !== `/${testDatabaseName}`
    || parsed.username !== "ai_project_os_gate"
    || parsed.password.length === 0
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw new Error("SYSTEM_ROLE_COMPATIBILITY_TEST_DATABASE_URL_INVALID");
  }
}

test(
  "full migration chain preserves legacy and semantic AppUserRole values",
  { skip: !shouldRun ? "SYSTEM_ROLE_COMPATIBILITY_POSTGRES_GATE=1 is required" : false },
  async () => {
    assertDisposableGateDatabase();
    const db = getDb();
    const userIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const suffix = randomUUID().slice(0, 8);

    try {
      const migrations = await db.$queryRaw<Array<{ migration_name: string }>>`
        SELECT "migration_name"
        FROM "_prisma_migrations"
        WHERE "finished_at" IS NOT NULL
        ORDER BY "started_at"
      `;
      assert.equal(migrations.findIndex((migration) => migration.migration_name === compatibilityMigrationName), 54);

      const enumValues = await db.$queryRaw<Array<{ value: string }>>`
        SELECT value::text
        FROM unnest(enum_range(NULL::"AppUserRole")) AS value
      `;
      assert.deepEqual(enumValues.map((row) => row.value), ["admin", "member", "user"]);

      const roleRows = [
        { id: userIds[0]!, username: `phase-a-admin-${suffix}`, role: "admin" as const },
        { id: userIds[1]!, username: `phase-a-legacy-member-${suffix}`, role: "member" as const },
        { id: userIds[2]!, username: `phase-a-user-${suffix}`, role: "user" as const },
      ];
      for (const roleRow of roleRows) await db.appUser.create({ data: roleRow });
      const defaultUser = await db.appUser.create({
        data: { id: userIds[3]!, username: `phase-a-default-${suffix}` },
      });
      assert.equal(defaultUser.role, "member");

      const persisted = await db.appUser.findMany({
        where: { id: { in: userIds } },
        select: { id: true, role: true },
      });
      const persistedRoles = new Map(persisted.map((row) => [row.id, row.role]));
      for (const roleRow of roleRows) assert.equal(persistedRoles.get(roleRow.id), roleRow.role);
      assert.equal(persistedRoles.get(defaultUser.id), "member");
    } finally {
      try {
        await db.appUser.deleteMany({ where: { id: { in: userIds } } });
      } finally {
        await db.$disconnect();
      }
    }
  },
);
