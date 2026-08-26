import assert from "node:assert/strict";
import test from "node:test";

test("database client initialization is lazy and production calls reuse one instance", async () => {
  const mutableEnv = process.env as Record<string, string | undefined>;
  const previousNodeEnv = mutableEnv.NODE_ENV;
  const previousDatabaseUrl = process.env.DATABASE_URL;

  mutableEnv.NODE_ENV = "production";
  delete process.env.DATABASE_URL;

  try {
    const dbModule = await import("@/lib/db");

    assert.throws(() => dbModule.getDb(), /Invalid environment configuration/);

    process.env.DATABASE_URL = "postgresql://127.0.0.1:59999/ai_project_os";
    const firstClient = dbModule.getDb();
    const secondClient = dbModule.getDb();
    const thirdClient = dbModule.getDb();

    assert.strictEqual(firstClient, secondClient);
    assert.strictEqual(secondClient, thirdClient);

    await firstClient.$disconnect();
  } finally {
    if (previousNodeEnv === undefined) {
      delete mutableEnv.NODE_ENV;
    } else {
      mutableEnv.NODE_ENV = previousNodeEnv;
    }

    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  }
});
