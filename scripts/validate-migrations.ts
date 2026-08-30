import { resolve } from "node:path";
import { validateMigrationDirectories } from "./migration-directory-validation";

const migrationsRoot = resolve(process.cwd(), "prisma/migrations");

async function main(): Promise<void> {
  try {
    const result = await validateMigrationDirectories(migrationsRoot);
    console.log(`Validated ${result.count} Prisma migration directories.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

void main();
