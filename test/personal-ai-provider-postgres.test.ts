import "dotenv/config";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { Client } from "pg";
import { getDb } from "../src/lib/db";
import {
  createPersonalProviderConnection,
  deletePersonalProviderConnection,
  getPersonalProviderConnection,
  listPersonalProviderConnections,
  PersonalProviderServiceError,
  testPersonalProviderConnection,
  updatePersonalProviderConnection,
} from "../src/lib/personal-ai-provider-service";
import { ProviderTransportError } from "../src/lib/ai-providers/transport";
import { createControlledMembership, grantControlledMembershipInTransaction, revokeControlledMembershipInTransaction } from "./membership-fixture";

const shouldRun = process.env.PERSONAL_AI_PROVIDER_POSTGRES_GATE === "1";
const repositoryRoot = process.cwd();
const execFile = promisify(execFileCallback);

function actor(id: string, role: "admin" | "user" = "user") {
  return { id, role, accountAccessVersion: 1 } as const;
}

function activeMembership(userId: string, grantedById: string, now: Date) {
  const day = 24 * 60 * 60 * 1_000;
  return {
    userId,
    status: "active" as const,
    startsAt: new Date(now.getTime() - day),
    expiresAt: new Date(now.getTime() + 90 * day),
    grantedById,
  };
}

async function migrationNamesFromDisk(): Promise<readonly string[]> {
  const entries = await readdir(join(repositoryRoot, "prisma", "migrations"), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function stageMigrations(tempRoot: string, names: readonly string[]): Promise<void> {
  const migrationsRoot = join(tempRoot, "prisma", "migrations");
  await mkdir(migrationsRoot, { recursive: true });
  for (const name of names) {
    await cp(join(repositoryRoot, "prisma", "migrations", name), join(migrationsRoot, name), { recursive: true });
  }
}

async function deployStagedMigrations(tempRoot: string, databaseUrl: string): Promise<void> {
  await execFile(
    "pnpm",
    ["exec", "prisma", "migrate", "deploy", "--config", join(tempRoot, "prisma.config.ts")],
    {
      cwd: repositoryRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

function adminDatabaseUrl(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  parsed.pathname = "/postgres";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function upgradeDatabaseName(suffix: string): string {
  const normalized = suffix.replaceAll("-", "");
  if (!/^[0-9a-f]{8,32}$/u.test(normalized)) throw new Error("PERSONAL_AI_PROVIDER_UPGRADE_DATABASE_INVALID");
  return `ai_project_os_personal_upgrade_${normalized}_test`;
}

async function prepareStagedMigrationRoot(): Promise<string> {
  const tempRoot = await mkdtemp(join(tmpdir(), "ai-project-os-personal-upgrade-migrations-"));
  await mkdir(join(tempRoot, "prisma"), { recursive: true });
  await symlink(join(repositoryRoot, "node_modules"), join(tempRoot, "node_modules"), "dir");
  await cp(join(repositoryRoot, "prisma", "schema.prisma"), join(tempRoot, "prisma", "schema.prisma"));
  await writeFile(join(tempRoot, "prisma.config.ts"), `import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DATABASE_URL") },
});
`, "utf8");
  return tempRoot;
}

test("WP05A personal providers enforce owner scope, membership lifecycle, and safe probes", {
  skip: !shouldRun ? "PERSONAL_AI_PROVIDER_POSTGRES_GATE=1 is required" : false,
}, async () => {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const keyDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-personal-provider-"));
  const previousKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
  process.env.AI_PROJECT_OS_MASTER_KEY_FILE = join(keyDirectory, "master.key");

  const adminId = randomUUID();
  const activeId = randomUUID();
  const otherId = randomUUID();
  const freeId = randomUUID();
  const expiredId = randomUUID();
  const providerIds: string[] = [];
  let originalFetch: typeof globalThis.fetch | undefined;
  try {
    const membershipNow = new Date();
    await db.appUser.createMany({
      data: [
        { id: adminId, username: `personal_admin_${suffix}`, role: "admin" },
        { id: activeId, username: `personal_active_${suffix}`, role: "user" },
        { id: otherId, username: `personal_other_${suffix}`, role: "user" },
        { id: freeId, username: `personal_free_${suffix}`, role: "user" },
        { id: expiredId, username: `personal_expired_${suffix}`, role: "user" },
      ],
    });
    for (const userId of [activeId, otherId]) {
      await createControlledMembership(db, {
        adminId,
        ...activeMembership(userId, adminId, membershipNow),
      });
    }
    const expiredMembership = await createControlledMembership(db, {
      adminId,
      ...activeMembership(expiredId, adminId, membershipNow),
    });

    const sameName = `Personal OpenAI ${suffix}`;
    const firstApiKey = `personal-key-${suffix}-a`;
    const first = await createPersonalProviderConnection({
      name: sameName,
      kind: "openai",
      apiKey: firstApiKey,
      generationModelId: "gpt-4.1-mini",
    }, actor(activeId), db);
    providerIds.push(first.id);
    assert.equal(first.scope, "user");
    assert.equal(first.baseUrl, "https://api.openai.com/v1");
    assert.equal(first.credential.maskedSuffix, firstApiKey.slice(-4));
    assert.doesNotMatch(JSON.stringify(first), /credentialId|ownerUserId|secretFingerprint|ciphertext|apiKey/u);

    const otherSameName = await createPersonalProviderConnection({
      name: sameName,
      kind: "openai",
      apiKey: `personal-key-${suffix}-b`,
      generationModelId: "gpt-4.1-mini",
    }, actor(otherId), db);
    providerIds.push(otherSameName.id);
    assert.equal(otherSameName.name, first.name);
    await assert.rejects(
      () => createPersonalProviderConnection({
        name: sameName,
        kind: "openai",
        apiKey: `personal-key-${suffix}-c`,
        generationModelId: "gpt-4.1-mini",
      }, actor(activeId), db),
      (error: unknown) => error instanceof PersonalProviderServiceError && error.code === "AI_PROVIDER_NAME_CONFLICT",
    );

    // The API always writes canonical registry data, but the database must
    // also reject a direct SQL caller that attempts to create or drift a
    // user-scoped endpoint.
    const invalidInsertProviderId = randomUUID();
    const invalidInsertCredentialId = randomUUID();
    await db.$executeRaw`
      INSERT INTO "ExternalCredential"
        ("id", "kind", "ciphertext", "nonce", "authTag", "keyVersion", "maskedSuffix", "secretFingerprint", "updatedAt")
      VALUES
        (${invalidInsertCredentialId}, 'ai_provider', decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex'), 1, '0000', ${"c".repeat(64)}, CURRENT_TIMESTAMP)
    `;
    await assert.rejects(
      () => db.$executeRaw`
        INSERT INTO "AiProviderConnection"
          ("id", "name", "kind", "scope", "workspaceId", "ownerUserId", "ownershipState", "protocol", "baseUrl", "credentialId", "defaultGenerationModelId", "configurationVersion", "status", "updatedAt")
        VALUES
          (${invalidInsertProviderId}, ${`Noncanonical ${suffix}`}, 'openai', 'user', NULL, ${activeId}, 'confirmed', 'chat_completions', 'https://attacker.invalid', ${invalidInsertCredentialId}, 'gpt-4.1-mini', 1, 'configured', CURRENT_TIMESTAMP)
      `,
    );
    await assert.rejects(
      () => db.$executeRaw`UPDATE "AiProviderConnection" SET "baseUrl" = 'https://attacker.invalid' WHERE "id" = ${first.id}`,
    );

    const activeList = await listPersonalProviderConnections(actor(activeId), db);
    assert.deepEqual(activeList.map((provider) => provider.id), [first.id]);
    await assert.rejects(
      () => getPersonalProviderConnection(first.id, actor(otherId), db),
      (error: unknown) => error instanceof PersonalProviderServiceError && error.code === "AI_PROVIDER_NOT_FOUND",
    );

    const beforeCrossUserFetch = 0;
    let fetchCalls = beforeCrossUserFetch;
    originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("unexpected personal provider network call");
    };
    for (const operation of [
      () => updatePersonalProviderConnection(first.id, { apiKey: `cross-user-${suffix}-key` }, actor(otherId), db),
      () => deletePersonalProviderConnection(first.id, { confirmationName: sameName }, actor(otherId), db),
      () => testPersonalProviderConnection(first.id, actor(otherId), db),
    ]) {
      await assert.rejects(
        operation,
        (error: unknown) => error instanceof PersonalProviderServiceError && error.code === "AI_PROVIDER_NOT_FOUND",
      );
    }
    assert.equal(fetchCalls, beforeCrossUserFetch);

    // Exercise the runtime fence against a deliberately injected legacy
    // drift. The DB trigger is disabled only inside this disposable test so
    // the service's pre-dispatch check can be proven independently; it is
    // immediately re-enabled before the request is attempted.
    const firstCredential = await db.aiProviderConnection.findUniqueOrThrow({
      where: { id: first.id },
      select: {
        credentialId: true,
        credential: { select: { ciphertext: true, nonce: true, authTag: true } },
      },
    });
    await db.$executeRaw`ALTER TABLE "AiProviderConnection" DISABLE TRIGGER "AiProviderConnection_workspace_owner_guard"`;
    try {
      await db.$executeRaw`UPDATE "AiProviderConnection" SET "baseUrl" = 'https://attacker.invalid' WHERE "id" = ${first.id}`;
      // An invalid vault payload makes an accidental decrypt observable while
      // keeping the probe fully offline. The registry guard must reject the
      // drift before this malformed credential can be read.
      await db.$executeRaw`
        UPDATE "ExternalCredential"
           SET "ciphertext" = decode('00', 'hex'),
               "nonce" = decode('00', 'hex'),
               "authTag" = decode('00', 'hex')
         WHERE "id" = ${firstCredential.credentialId}
      `;
    } finally {
      await db.$executeRaw`ALTER TABLE "AiProviderConnection" ENABLE TRIGGER "AiProviderConnection_workspace_owner_guard"`;
    }
    try {
      await assert.rejects(
        () => testPersonalProviderConnection(first.id, actor(activeId), db),
        (error: unknown) => error instanceof PersonalProviderServiceError && error.code === "AI_PROVIDER_CONNECTION_UNAVAILABLE",
      );
      assert.equal(fetchCalls, beforeCrossUserFetch);
    } finally {
      await db.$executeRaw`UPDATE "AiProviderConnection" SET "baseUrl" = ${first.baseUrl} WHERE "id" = ${first.id}`;
      await db.$executeRaw`
        UPDATE "ExternalCredential"
           SET "ciphertext" = ${firstCredential.credential.ciphertext},
               "nonce" = ${firstCredential.credential.nonce},
               "authTag" = ${firstCredential.credential.authTag}
         WHERE "id" = ${firstCredential.credentialId}
      `;
    }

    const credentialCountBeforeFreeCreate = await db.externalCredential.count({ where: { kind: "aiProvider" } });
    await assert.rejects(
      () => createPersonalProviderConnection({
        name: `Free ${suffix}`,
        kind: "openai",
        apiKey: `free-key-${suffix}-a`,
        generationModelId: "gpt-4.1-mini",
      }, actor(freeId), db),
      (error: unknown) => error instanceof PersonalProviderServiceError && error.code === "AI_MEMBERSHIP_REQUIRED",
    );
    assert.equal(await db.externalCredential.count({ where: { kind: "aiProvider" } }), credentialCountBeforeFreeCreate);

    await db.appUser.create({ data: { id: randomUUID(), username: `not-used_${suffix}`, role: "admin" } });
    const adminWithoutMembership = await db.appUser.findFirstOrThrow({ where: { username: `not-used_${suffix}` }, select: { id: true } });
    await assert.rejects(
      () => createPersonalProviderConnection({
        name: `Admin without membership ${suffix}`,
        kind: "openai",
        apiKey: `admin-key-${suffix}-a`,
        generationModelId: "gpt-4.1-mini",
    }, actor(adminWithoutMembership.id, "admin"), db),
      (error: unknown) => error instanceof PersonalProviderServiceError && error.code === "AI_MEMBERSHIP_REQUIRED",
    );

    const expiredProvider = await createPersonalProviderConnection({
      name: `Expired ${suffix}`,
      kind: "openai",
      apiKey: `expired-key-${suffix}-a`,
      generationModelId: "gpt-4.1-mini",
    }, actor(expiredId), db);
    providerIds.push(expiredProvider.id);
    await db.aiProviderConnection.update({ where: { id: expiredProvider.id }, data: { status: "verified", lastTestedAt: new Date() } });

    const expiredTransitionAt = new Date();
    await db.$transaction((tx) => revokeControlledMembershipInTransaction(tx, {
      subscriptionId: expiredMembership.id,
      adminId,
      reason: `personal provider expired fixture ${suffix}`,
      transitionAt: expiredTransitionAt,
    }), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    await db.$transaction((tx) => grantControlledMembershipInTransaction(tx, {
      subscriptionId: expiredMembership.id,
      adminId,
      startsAt: new Date(expiredTransitionAt.getTime() - 2 * 24 * 60 * 60 * 1_000),
      expiresAt: new Date(expiredTransitionAt.getTime() - 24 * 60 * 60 * 1_000),
      grantedById: adminId,
      transitionAt: expiredTransitionAt,
    }), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    const expiredList = await listPersonalProviderConnections(actor(expiredId), db);
    assert.equal(expiredList.length, 1);
    const rotated = await updatePersonalProviderConnection(expiredProvider.id, { apiKey: `expired-key-${suffix}-b` }, actor(expiredId), db);
    assert.equal(rotated.status, "configured");
    assert.equal(rotated.lastTestedAt, null);
    assert.equal(rotated.lastErrorCode, null);
    await assert.rejects(
      () => updatePersonalProviderConnection(expiredProvider.id, { name: `Expired renamed ${suffix}` }, actor(expiredId), db),
      (error: unknown) => error instanceof PersonalProviderServiceError && error.code === "AI_MEMBERSHIP_EXPIRED",
    );
    const disabled = await updatePersonalProviderConnection(expiredProvider.id, { enabled: false }, actor(expiredId), db);
    assert.equal(disabled.status, "disabled");
    await assert.rejects(
      () => testPersonalProviderConnection(expiredProvider.id, actor(expiredId), db),
      (error: unknown) => error instanceof PersonalProviderServiceError && error.code === "AI_MEMBERSHIP_EXPIRED",
    );
    const deleted = await deletePersonalProviderConnection(expiredProvider.id, { confirmationName: expiredProvider.name }, actor(expiredId), db);
    assert.equal(deleted.id, expiredProvider.id);

    const foreignOwnerId = randomUUID();
    await assert.rejects(
      () => db.$executeRaw`UPDATE "AiProviderConnection" SET "ownerUserId" = ${foreignOwnerId} WHERE "id" = ${first.id}`,
    );
    await assert.rejects(
      () => db.$executeRaw`UPDATE "AiProviderConnection" SET "scope" = 'platform' WHERE "id" = ${first.id}`,
    );
    const persisted = await db.aiProviderConnection.findUniqueOrThrow({ where: { id: first.id }, select: { ownerUserId: true, scope: true } });
    assert.equal(persisted.ownerUserId, activeId);
    assert.equal(persisted.scope, "user");

    let releaseProbe: (() => void) | undefined;
    let probeStarted = false;
    globalThis.fetch = async () => {
      probeStarted = true;
      return new Promise<Response>((resolve) => {
        releaseProbe = () => resolve(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } }));
      });
    };
    const probePromise = testPersonalProviderConnection(first.id, actor(activeId), db);
    for (let attempt = 0; attempt < 1_000 && !probeStarted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!probeStarted) await probePromise;
    assert.equal(probeStarted, true);
    assert.ok(releaseProbe);
    let rotationCommitted = false;
    const rotationPromise = updatePersonalProviderConnection(
      first.id,
      { apiKey: `personal-key-${suffix}-rotated` },
      actor(activeId),
      db,
    ).then((provider) => {
      rotationCommitted = true;
      return provider;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(rotationCommitted, false);
    releaseProbe!();
    const tested = await probePromise;
    assert.equal(tested.provider.status, "verified");
    assert.equal(tested.check.generation, true);
    assert.equal(tested.check.embeddingDimensions, null);
    assert.equal(tested.check.vision, false);
    const rotatedAfterAdmission = await rotationPromise;
    assert.equal(rotationCommitted, true);
    assert.equal(rotatedAfterAdmission.status, "configured");

    globalThis.fetch = async () => new Response(JSON.stringify({ error: "probe failed" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    await assert.rejects(
      () => testPersonalProviderConnection(first.id, actor(activeId), db),
      (error: unknown) => error instanceof ProviderTransportError && error.code === "AI_PROVIDER_UNAVAILABLE",
    );
    const failedProbe = await db.aiProviderConnection.findUniqueOrThrow({
      where: { id: first.id },
      select: { status: true, lastErrorCode: true, lastTestedAt: true },
    });
    assert.equal(failedProbe.status, "error");
    assert.equal(failedProbe.lastErrorCode, "AI_PROVIDER_UNAVAILABLE");
    assert.ok(failedProbe.lastTestedAt instanceof Date);
  } finally {
    if (originalFetch !== undefined) globalThis.fetch = originalFetch;
    process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyPath;
    await rm(keyDirectory, { recursive: true, force: true });
    await db.$disconnect();
  }
});

test("0800 preserves canonical historical personal and legacy provider rows", {
  skip: !shouldRun ? "PERSONAL_AI_PROVIDER_POSTGRES_GATE=1 is required" : false,
}, async () => {
  const configuredUrl = process.env.DATABASE_URL;
  if (typeof configuredUrl !== "string" || configuredUrl.length === 0) {
    throw new Error("PERSONAL_AI_PROVIDER_UPGRADE_DATABASE_URL_REQUIRED");
  }
  const migrations = await migrationNamesFromDisk();
  const beforeUserWindow = migrations.indexOf("20260903030000_add_platform_policies_and_connection_ownership");
  const beforeGovernance = migrations.indexOf("20260904040000_add_membership_access_governance");
  const personalOwnership = migrations.indexOf("20260904080000_add_personal_ai_provider_ownership");
  if (beforeUserWindow < 0 || beforeGovernance < 0 || personalOwnership < 0 || beforeUserWindow >= beforeGovernance || beforeGovernance >= personalOwnership) {
    throw new Error("PERSONAL_AI_PROVIDER_UPGRADE_MIGRATION_ORDER_INVALID");
  }

  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const databaseName = upgradeDatabaseName(suffix);
  const targetUrl = new URL(configuredUrl);
  targetUrl.pathname = `/${databaseName}`;
  targetUrl.search = "";
  targetUrl.hash = "";
  const admin = new Client({ connectionString: adminDatabaseUrl(configuredUrl), connectionTimeoutMillis: 5_000 });
  const raw = new Client({ connectionString: targetUrl.toString(), connectionTimeoutMillis: 5_000 });
  let tempRoot: string | undefined;
  let databaseCreated = false;
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const workspaceMembershipId = randomUUID();
  const platformProviderId = randomUUID();
  const workspaceProviderId = randomUUID();
  const userProviderId = randomUUID();
  const driftProviderId = randomUUID();
  const platformCredentialId = randomUUID();
  const workspaceCredentialId = randomUUID();
  const userCredentialId = randomUUID();
  const driftCredentialId = randomUUID();
  const historicalRows = [
    { id: platformProviderId, name: `Historical platform ${suffix}`, kind: "openai", scope: "platform", workspaceId: null, ownerUserId: null, ownershipState: "legacy_pending", baseUrl: "https://api.openai.com/v1" },
    { id: workspaceProviderId, name: `Historical workspace ${suffix}`, kind: "deepseek", scope: "workspace", workspaceId, ownerUserId: userId, ownershipState: "legacy_pending", baseUrl: "https://api.deepseek.com" },
    { id: userProviderId, name: `Historical personal ${suffix}`, kind: "openai", scope: "user", workspaceId: null, ownerUserId: userId, ownershipState: "confirmed", baseUrl: "https://api.openai.com/v1" },
    // Before 0800, the user scope accepted arbitrary endpoint values. This
    // row proves the migration preserves that legacy value and only applies
    // the registry guard to future endpoint mutations.
    { id: driftProviderId, name: `Historical personal drift ${suffix}`, kind: "openai", scope: "user", workspaceId: null, ownerUserId: userId, ownershipState: "confirmed", baseUrl: "https://legacy-personal.invalid" },
  ] as const;

  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    const configuredRole = decodeURIComponent(new URL(configuredUrl).username);
    assert.ok(configuredRole.length > 0);
    const ownerResult = await admin.query<{ owner: string }>(
      `SELECT pg_get_userbyid("datdba") AS owner FROM pg_database WHERE "datname" = $1`,
      [databaseName],
    );
    assert.equal(ownerResult.rows[0]?.owner, configuredRole);
    tempRoot = await prepareStagedMigrationRoot();

    await stageMigrations(tempRoot, migrations.slice(0, beforeUserWindow + 1));
    await deployStagedMigrations(tempRoot, targetUrl.toString());
    await raw.connect();
    await raw.query(
      `INSERT INTO "AppUser" ("id", "username", "role", "updatedAt") VALUES ($1, $2, 'user', CURRENT_TIMESTAMP)`,
      [userId, `historical_personal_${suffix}`],
    );
    await raw.query(
      `INSERT INTO "Workspace" ("id", "name", "slug", "createdById", "updatedAt") VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
      [workspaceId, `Historical workspace ${suffix}`, `historical-${suffix}`, userId],
    );
    await raw.query(
      `INSERT INTO "WorkspaceMembership" ("id", "workspaceId", "userId", "role", "updatedAt") VALUES ($1, $2, $3, 'admin', CURRENT_TIMESTAMP)`,
      [workspaceMembershipId, workspaceId, userId],
    );

    for (const credentialId of [platformCredentialId, workspaceCredentialId, userCredentialId, driftCredentialId]) {
      await raw.query(
        `INSERT INTO "ExternalCredential"
          ("id", "kind", "ciphertext", "nonce", "authTag", "keyVersion", "maskedSuffix", "secretFingerprint", "updatedAt")
         VALUES ($1, 'ai_provider', decode('00', 'hex'), decode('00', 'hex'), decode('00', 'hex'), 1, '0000', repeat('d', 64), CURRENT_TIMESTAMP)`,
        [credentialId],
      );
    }
    for (const row of historicalRows) {
      const credentialId = row.id === platformProviderId
        ? platformCredentialId
        : row.id === workspaceProviderId
          ? workspaceCredentialId
          : row.id === userProviderId ? userCredentialId : driftCredentialId;
      await raw.query(
        `INSERT INTO "AiProviderConnection"
          ("id", "name", "kind", "scope", "workspaceId", "ownerUserId", "ownershipState", "protocol", "baseUrl", "credentialId", "defaultGenerationModelId", "status", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'chat_completions', $8, $9, 'historical-model', $10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [row.id, row.name, row.kind, row.scope, row.workspaceId, row.ownerUserId, row.ownershipState, row.baseUrl, credentialId, row.scope === "workspace" ? "disabled" : "verified"],
      );
    }

    const beforeRows = await raw.query<{
      id: string;
      name: string;
      kind: string;
      scope: string;
      workspaceId: string | null;
      ownerUserId: string | null;
      ownershipState: string;
      protocol: string;
      baseUrl: string;
    }>(
      `SELECT "id", "name", "kind"::text, "scope"::text, "workspaceId", "ownerUserId", "ownershipState"::text, "protocol"::text, "baseUrl"
         FROM "AiProviderConnection" WHERE "id" = ANY($1::uuid[]) ORDER BY "id"`,
      [[platformProviderId, workspaceProviderId, userProviderId, driftProviderId]],
    );
    assert.equal(beforeRows.rows.length, historicalRows.length);

    await stageMigrations(tempRoot, migrations.slice(beforeUserWindow + 1, personalOwnership));
    await deployStagedMigrations(tempRoot, targetUrl.toString());
    await stageMigrations(tempRoot, migrations.slice(personalOwnership));
    await deployStagedMigrations(tempRoot, targetUrl.toString());

    const afterRows = await raw.query<{
      id: string;
      name: string;
      kind: string;
      scope: string;
      workspaceId: string | null;
      ownerUserId: string | null;
      ownershipState: string;
      protocol: string;
      baseUrl: string;
    }>(
      `SELECT "id", "name", "kind"::text, "scope"::text, "workspaceId", "ownerUserId", "ownershipState"::text, "protocol"::text, "baseUrl"
         FROM "AiProviderConnection" WHERE "id" = ANY($1::uuid[]) ORDER BY "id"`,
      [[platformProviderId, workspaceProviderId, userProviderId, driftProviderId]],
    );
    assert.deepEqual(afterRows.rows, beforeRows.rows);

    // A historical drift may still be maintained or explicitly repaired, but
    // it cannot be changed into another non-canonical endpoint after 0800.
    await raw.query(
      `UPDATE "AiProviderConnection"
          SET "status" = 'disabled', "disabledAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1`,
      [driftProviderId],
    );
    const maintainedDrift = await raw.query<{ status: string; baseUrl: string }>(
      `SELECT "status"::text, "baseUrl" FROM "AiProviderConnection" WHERE "id" = $1`,
      [driftProviderId],
    );
    assert.equal(maintainedDrift.rows[0]?.status, "disabled");
    assert.equal(maintainedDrift.rows[0]?.baseUrl, "https://legacy-personal.invalid");
    await assert.rejects(
      () => raw.query(
        `UPDATE "AiProviderConnection" SET "baseUrl" = $1 WHERE "id" = $2`,
        ["https://another-personal.invalid", driftProviderId],
      ),
      /AI_PROVIDER_USER_ENDPOINT_INVALID/u,
    );
    await raw.query(
      `UPDATE "AiProviderConnection" SET "baseUrl" = $1 WHERE "id" = $2`,
      ["https://api.openai.com/v1", driftProviderId],
    );
    const repairedDrift = await raw.query<{ baseUrl: string; status: string }>(
      `SELECT "baseUrl", "status"::text FROM "AiProviderConnection" WHERE "id" = $1`,
      [driftProviderId],
    );
    assert.equal(repairedDrift.rows[0]?.baseUrl, "https://api.openai.com/v1");
    assert.equal(repairedDrift.rows[0]?.status, "disabled");
    const applied = await raw.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "_prisma_migrations" WHERE "migration_name" = '20260904080000_add_personal_ai_provider_ownership' AND "finished_at" IS NOT NULL`,
    );
    assert.equal(applied.rows[0]?.count, "1");
  } finally {
    await raw.end().catch(() => undefined);
    if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true });
    if (databaseCreated) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});
