import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateMigrationDirectories } from "../scripts/migration-directory-validation";

async function withTemporaryMigrations(
  action: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ai-project-os-migrations-"));
  try {
    await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("migration directory validation accepts non-empty migration.sql files", async () => {
  await withTemporaryMigrations(async (root) => {
    const migration = join(root, "20260830050000_valid_migration");
    await mkdir(migration);
    await writeFile(join(migration, "migration.sql"), "SELECT 1;\n", "utf8");

    const result = await validateMigrationDirectories(root);
    assert.deepEqual(result, {
      count: 1,
      names: ["20260830050000_valid_migration"],
    });
  });
});

test("migration directory validation rejects a directory without migration.sql", async () => {
  await withTemporaryMigrations(async (root) => {
    await mkdir(join(root, "20260830060000_missing_migration"));

    await assert.rejects(
      () => validateMigrationDirectories(root),
      /20260830060000_missing_migration: migration\.sql is missing/,
    );
  });
});

test("migration directory validation rejects an empty migration.sql", async () => {
  await withTemporaryMigrations(async (root) => {
    const migration = join(root, "20260830070000_empty_migration");
    await mkdir(migration);
    await writeFile(join(migration, "migration.sql"), "", "utf8");

    await assert.rejects(
      () => validateMigrationDirectories(root),
      /20260830070000_empty_migration: migration\.sql is empty/,
    );
  });
});
