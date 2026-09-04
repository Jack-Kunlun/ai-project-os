import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getDb } from "../src/lib/db";

const shouldRun = process.env.PHASE_A_SCHEMA_POSTGRES_GATE === "1";
const testDatabaseName = "ai_project_os_phase_a_schema_test";
const compatibilityMigrationName = "20260903010000_add_user_system_role_compatibility";
const providerScopeMigrationName = "20260903020000_add_user_ai_provider_scope";

function assertDisposableGateDatabase(): void {
  const configuredUrl = process.env.DATABASE_URL;
  if (typeof configuredUrl !== "string" || configuredUrl.length === 0) {
    throw new Error("PHASE_A_SCHEMA_TEST_DATABASE_URL_REQUIRED");
  }

  let parsed: URL;
  try {
    parsed = new URL(configuredUrl);
  } catch {
    throw new Error("PHASE_A_SCHEMA_TEST_DATABASE_URL_INVALID");
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
    throw new Error("PHASE_A_SCHEMA_TEST_DATABASE_URL_INVALID");
  }
}

test(
  "full migration chain preserves both additive enum contracts",
  { skip: !shouldRun ? "PHASE_A_SCHEMA_POSTGRES_GATE=1 is required" : false },
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
      assert.equal(migrations.findIndex((migration) => migration.migration_name === providerScopeMigrationName), 55);

      const enumValues = await db.$queryRaw<Array<{ value: string }>>`
        SELECT value::text
        FROM unnest(enum_range(NULL::"AppUserRole")) AS value
      `;
      assert.deepEqual(enumValues.map((row) => row.value), ["admin", "member", "user"]);

      const providerScopeValues = await db.$queryRaw<Array<{ value: string }>>`
        SELECT value::text
        FROM unnest(enum_range(NULL::"AiProviderScope")) AS value
      `;
      assert.deepEqual(providerScopeValues.map((row) => row.value), ["platform", "workspace", "user"]);

      const defaultScopeRows = await db.$queryRaw<Array<{ column_default: string | null }>>`
        SELECT column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'AiProviderConnection'
          AND column_name = 'scope'
      `;
      assert.equal(defaultScopeRows.length, 1);
      assert.match(defaultScopeRows[0]?.column_default ?? "", /'platform'::"AiProviderScope"/u);

      const scopeConstraintRows = await db.$queryRaw<Array<{ definition: string }>>`
        SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conrelid = 'public."AiProviderConnection"'::regclass
          AND conname = 'AiProviderConnection_scope_check'
      `;
      assert.equal(scopeConstraintRows.length, 1);
      assert.match(scopeConstraintRows[0]!.definition, /'platform'/u);
      assert.match(scopeConstraintRows[0]!.definition, /'workspace'/u);
      assert.doesNotMatch(scopeConstraintRows[0]!.definition, /'user'/u);

      const invalidProviderId = randomUUID();
      const invalidProviderCredentialId = randomUUID();
      try {
        await db.externalCredential.create({
          data: {
            id: invalidProviderCredentialId,
            kind: "aiProvider",
            ciphertext: Buffer.from([1]),
            nonce: Buffer.from([2]),
            authTag: Buffer.from([3]),
            maskedSuffix: "gate",
            secretFingerprint: "a".repeat(64),
          },
        });
        await assert.rejects(
          () => db.$executeRaw`
            INSERT INTO "AiProviderConnection"
              ("id", "name", "kind", "scope", "protocol", "baseUrl", "credentialId", "status", "createdAt", "updatedAt")
            VALUES
              (${invalidProviderId}, ${`phase-a-invalid-user-${suffix}`}, 'openai'::"AiProviderKind", 'user'::"AiProviderScope", 'chat_completions'::"AiProviderProtocol", 'https://api.openai.com/v1', ${invalidProviderCredentialId}, 'configured'::"AiProviderConnectionStatus", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `,
          (error: unknown) => String(error).includes("AiProviderConnection_scope_check"),
        );
      } finally {
        await db.aiProviderConnection.deleteMany({ where: { id: invalidProviderId } });
        await db.externalCredential.deleteMany({ where: { id: invalidProviderCredentialId } });
      }

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
