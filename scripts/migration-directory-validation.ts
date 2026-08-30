import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface MigrationDirectoryValidationResult {
  count: number;
  names: string[];
}

export async function validateMigrationDirectories(
  migrationsRoot: string,
): Promise<MigrationDirectoryValidationResult> {
  const entries = await readdir(migrationsRoot, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (names.length === 0) {
    throw new Error("PRISMA_MIGRATIONS_EMPTY: no migration directories found");
  }

  const issues: string[] = [];
  for (const name of names) {
    const migrationFile = join(migrationsRoot, name, "migration.sql");
    try {
      const migrationStat = await stat(migrationFile);
      if (!migrationStat.isFile()) {
        issues.push(`${name}: migration.sql is not a regular file`);
      } else if (migrationStat.size === 0) {
        issues.push(`${name}: migration.sql is empty`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        issues.push(`${name}: migration.sql is missing`);
        continue;
      }
      throw error;
    }
  }

  if (issues.length > 0) {
    throw new Error(`PRISMA_MIGRATION_DIRECTORY_INVALID\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
  }

  return { count: names.length, names };
}
