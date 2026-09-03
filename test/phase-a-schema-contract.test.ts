import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationName = "20260903010000_add_user_system_role_compatibility";

async function readRoleEnum(): Promise<string> {
  const schema = await readFile("prisma/schema.prisma", "utf8");
  const roleEnum = schema.match(/^enum AppUserRole \{([\s\S]*?)^\}/mu)?.[1];
  assert.ok(roleEnum, "AppUserRole enum is missing");
  return roleEnum;
}

test("AppUserRole keeps legacy values and adds the semantic user value", async () => {
  const roleEnum = await readRoleEnum();
  const values = roleEnum
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^[a-z]+$/u.test(line));
  assert.deepEqual(values, ["admin", "member", "user"]);

  const schema = await readFile("prisma/schema.prisma", "utf8");
  const appUserModel = schema.match(/^model AppUser \{([\s\S]*?)^\}/mu)?.[1];
  assert.ok(appUserModel, "AppUser model is missing");
  assert.match(appUserModel, /^\s*role\s+AppUserRole\s+@default\(member\)\s*$/mu);
});

test("the compatibility migration is a standalone additive enum change", async () => {
  const migration = await readFile(`prisma/migrations/${migrationName}/migration.sql`, "utf8");
  const executableSql = migration.replace(/--[^\n]*(?:\n|$)/gu, "").trim();
  assert.equal(executableSql, 'ALTER TYPE "AppUserRole" ADD VALUE IF NOT EXISTS \'user\';');
  assert.doesNotMatch(migration, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP|CREATE)\b/iu);
  assert.doesNotMatch(migration, /\bALTER\s+TABLE\b/iu);
  assert.doesNotMatch(migration, /\b(?:SET\s+DEFAULT|DEFAULT\s+)\b/iu);
  assert.doesNotMatch(migration, /\b(?:admin|member)\b/iu);
});

test("the compatibility migration occupies stable migration slot 55", async () => {
  const entries = await readdir("prisma/migrations", { withFileTypes: true });
  const migrations = entries
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  assert.equal(migrations.indexOf(migrationName), 54);
});
