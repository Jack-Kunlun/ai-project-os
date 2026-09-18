import "dotenv/config";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { Prisma, type PrismaClient } from "@prisma/client";
import { updateProviderConnection } from "../src/lib/ai-providers";
import { applyPlatformAiOperation, probePlatformAiOperation } from "../src/lib/platform-ai-operation-service";
import { createAndActivatePlatformProviderProbeBudget, PlatformProviderProbeServiceError, runPlatformProviderProbe, reconcilePlatformProviderProbeAttempts } from "../src/lib/platform-provider-probe-service";
import { getDb } from "../src/lib/db";
import { createVerifiedProviderFixture } from "./platform-provider-fixture";

const shouldRun = process.env.PLATFORM_PROVIDER_PROBE_POSTGRES_GATE === "1";

function matchesGuard(pattern: RegExp) {
  return (error: unknown): boolean => pattern.test(String(error));
}

async function assertRawGuardRejects(operation: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(operation, matchesGuard(pattern));
}

async function assertTransactionGuardRejects(
  db: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  await assert.rejects(
    () => db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('ai_project_os.platform_provider_probe_mutation', 'service-v1', true)`;
      await operation(tx);
    }),
    matchesGuard(pattern),
  );
}

async function insertProbeLedger(
  db: PrismaClient | Prisma.TransactionClient,
  input: Readonly<{
    budgetId: string | null;
    attemptId: string;
    actorId: string;
    ordinal: number;
    event: "held" | "reserved";
    capability: "generation" | "vision";
  }>,
): Promise<void> {
  await db.$executeRaw(Prisma.sql`
    INSERT INTO "PlatformProviderProbeLedger" (
      "id", "budgetId", "attemptId", "actorId", "ordinal", "event", "capability", "units"
    ) VALUES (
      ${randomUUID()}::uuid,
      ${input.budgetId}::uuid,
      ${input.attemptId}::uuid,
      ${input.actorId}::uuid,
      ${input.ordinal},
      ${input.event}::"PlatformProviderProbeLedgerEvent",
      ${input.capability}::"PlatformProviderProbeCapability",
      1
    )
  `);
}

after(async () => {
  if (shouldRun) await getDb().$disconnect();
});

test(
  "platform provider probes are independently budgeted, marked before fetch, idempotent, and fail closed",
  { skip: !shouldRun ? "PLATFORM_PROVIDER_PROBE_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const keyDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-platform-probe-"));
    const previousKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    process.env.AI_PROJECT_OS_MASTER_KEY_FILE = join(keyDirectory, "master.key");
    const adminId = "00000000-0000-4000-8000-000000000010";
    const actor = { id: adminId, role: "admin" as const, accountAccessVersion: 1 };
    const firstClientKey = randomUUID();
    const previousFetch = globalThis.fetch;
    let fetches = 0;
    try {
      const provider = await createVerifiedProviderFixture({
        name: `Platform probe ${suffix}`,
        kind: "openai",
        apiKey: "platform-probe-test-key",
        generationModelId: "gpt-4.1-mini",
        embeddingModelId: "text-embedding-3-small",
        embeddingDimensions: 1536,
        visionModelId: "gpt-4o-mini",
      }, actor, db);
      assert.equal(provider.id.length > 0, true);

      const scheduledNow = new Date();
      await createAndActivatePlatformProviderProbeBudget({
        unitLimit: 20,
        alertThresholdUnits: 3,
        startsAt: new Date(scheduledNow.getTime() + 60_000).toISOString(),
        expiresAt: new Date(scheduledNow.getTime() + 600_000).toISOString(),
      }, actor, db);

      const noBudget = await runPlatformProviderProbe(provider.id, actor, {
        clientRequestKey: firstClientKey,
        expectedConfigurationVersion: provider.configurationVersion,
      }, db);
      assert.equal(noBudget.attempt.status, "rejected");
      assert.equal(noBudget.attempt.safeErrorCode, "PLATFORM_PROVIDER_PROBE_BUDGET_REQUIRED");
      assert.equal(fetches, 0);
      assert.equal(await db.providerCallAudit.count({ where: { providerConnectionId: provider.id } }), 0);
      assert.equal(await db.platformTokenLedgerEntry.count({ where: { userId: adminId } }), 0);

      const now = new Date();
      await createAndActivatePlatformProviderProbeBudget({
        unitLimit: 20,
        alertThresholdUnits: 3,
        startsAt: new Date(now.getTime() - 1_000).toISOString(),
        expiresAt: new Date(now.getTime() + 600_000).toISOString(),
      }, actor, db);

      const successfulClientKey = randomUUID();

      globalThis.fetch = async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        fetches += 1;
        if (url.endsWith("/embeddings")) {
          return new Response(JSON.stringify({ data: [{ index: 0, embedding: Array.from({ length: 1536 }, () => 0) }] }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200, headers: { "content-type": "application/json" } });
      };

      const first = await runPlatformProviderProbe(provider.id, actor, {
        clientRequestKey: successfulClientKey,
        expectedConfigurationVersion: provider.configurationVersion,
      }, db);
      assert.equal(first.attempt.status, "settled");
      assert.equal(first.attempt.safeErrorCode, null);
      assert.deepEqual(first.attempt.capabilities, { generation: "passed", embedding: "passed", vision: "passed" });
      assert.equal(first.attempt.embeddingDimensions, 1536);
      assert.equal(fetches, 3);

      const replay = await runPlatformProviderProbe(provider.id, actor, {
        clientRequestKey: successfulClientKey,
        expectedConfigurationVersion: provider.configurationVersion,
      }, db);
      assert.deepEqual(replay, first);
      assert.equal(fetches, 3);
      const attempts = await db.platformProviderProbeAttempt.findMany({ where: { providerConnectionId: provider.id }, select: { id: true, actorId: true, status: true, clientRequestKeyHash: true, plannedUnits: true, dispatchedUnits: true, settledUnits: true, releasedUnits: true, heldUnits: true } });
      assert.equal(attempts.length, 2);
      const settled = attempts.find((attempt) => attempt.status === "settled");
      const rejected = attempts.find((attempt) => attempt.status === "rejected");
      assert.ok(settled);
      assert.ok(rejected);
      assert.equal(settled.actorId, adminId);
      assert.equal(settled.plannedUnits, 3);
      assert.deepEqual({ dispatched: settled.dispatchedUnits, settled: settled.settledUnits, released: settled.releasedUnits, held: settled.heldUnits }, { dispatched: 3, settled: 3, released: 0, held: 0 });
      assert.notEqual(settled.clientRequestKeyHash, successfulClientKey);
      assert.equal(await db.platformProviderProbeLedger.count({ where: { attemptId: settled.id, event: "dispatched" } }), 3);
      assert.equal(await db.platformProviderProbeLedger.count({ where: { attemptId: settled.id, event: "settled" } }), 3);

      const providerAfter = await db.aiProviderConnection.findUniqueOrThrow({ where: { id: provider.id }, select: { status: true, lastErrorCode: true } });
      assert.equal(providerAfter.status, "verified");
      assert.equal(providerAfter.lastErrorCode, null);
      assert.equal(await db.providerCallAudit.count({ where: { providerConnectionId: provider.id } }), 0);
      assert.equal(await db.platformTokenLedgerEntry.count({ where: { userId: adminId } }), 0);

      let appendOnlyError: unknown = null;
      try {
        await db.$executeRaw(Prisma.sql`UPDATE "PlatformProviderProbeLedger" SET "units" = 2 WHERE "attemptId" = ${settled.id}::uuid`);
        assert.fail("ledger update unexpectedly succeeded");
      } catch (error) {
        appendOnlyError = error;
      }
      assert.match(String(appendOnlyError), /append-only|insufficient_privilege/iu);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
      else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyPath;
      await rm(keyDirectory, { recursive: true, force: true });
    }
  },
);

test(
  "platform provider probe reconciliation never dispatches network work",
  { skip: !shouldRun ? "PLATFORM_PROVIDER_PROBE_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const keyDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-platform-probe-reconcile-"));
    const previousKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    process.env.AI_PROJECT_OS_MASTER_KEY_FILE = join(keyDirectory, "master.key");
    const adminId = "00000000-0000-4000-8000-000000000010";
    const actor = { id: adminId, role: "admin" as const, accountAccessVersion: 1 };
    const previousFetch = globalThis.fetch;
    let fetches = 0;
    try {
      const provider = await createVerifiedProviderFixture({
        name: `Platform probe reconcile ${suffix}`,
        kind: "openai",
        apiKey: "platform-probe-reconcile-key",
        generationModelId: "gpt-4.1-mini",
        embeddingModelId: null,
        embeddingDimensions: null,
        visionModelId: null,
      }, actor, db);
      const now = new Date();
      await createAndActivatePlatformProviderProbeBudget({
        unitLimit: 5,
        alertThresholdUnits: 1,
        startsAt: new Date(now.getTime() - 1_000).toISOString(),
        expiresAt: new Date(now.getTime() + 600_000).toISOString(),
      }, actor, db);
      globalThis.fetch = async () => {
        fetches += 1;
        throw new Error("probe dispatch must be injected by this fixture only");
      };
      const heldClientKey = randomUUID();
      const heldResult = await runPlatformProviderProbe(provider.id, actor, { clientRequestKey: heldClientKey, expectedConfigurationVersion: provider.configurationVersion }, db);
      assert.equal(heldResult.attempt.status, "held");
      assert.equal(fetches, 1);
      const heldReplay = await runPlatformProviderProbe(provider.id, actor, { clientRequestKey: heldClientKey, expectedConfigurationVersion: provider.configurationVersion }, db);
      assert.deepEqual(heldReplay, heldResult);
      assert.equal(fetches, 1);
      await assert.rejects(
        () => runPlatformProviderProbe(provider.id, actor, { clientRequestKey: randomUUID(), expectedConfigurationVersion: provider.configurationVersion }, db),
        (error: unknown) => error instanceof PlatformProviderProbeServiceError && error.code === "PLATFORM_PROVIDER_PROBE_RECONCILIATION_REQUIRED",
      );
      assert.equal(fetches, 1);
      const attempt = await db.platformProviderProbeAttempt.findFirstOrThrow({ where: { providerConnectionId: provider.id }, select: { id: true, status: true, leaseExpiresAt: true, plannedUnits: true, dispatchedUnits: true, budgetId: true, providerConfigurationVersion: true } });
      assert.equal(attempt.status, "held");
      assert.equal(attempt.dispatchedUnits, 1);
      assert.ok(attempt.budgetId);
      const reconciled = await reconcilePlatformProviderProbeAttempts(db, new Date(attempt.leaseExpiresAt.getTime() + 1_000));
      assert.equal(reconciled, 0);
      assert.equal(fetches, 1);

      const heldLedgerCount = await db.platformProviderProbeLedger.count({ where: { attemptId: attempt.id, event: "held" } });
      const rotated = await updateProviderConnection(provider.id, { apiKey: "platform-probe-reconcile-rotated-key" }, actor, db);
      assert.equal(rotated.configurationVersion, attempt.providerConfigurationVersion + 1);
      globalThis.fetch = async () => {
        fetches += 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200, headers: { "content-type": "application/json" } });
      };
      const afterRotation = await runPlatformProviderProbe(provider.id, actor, {
        clientRequestKey: randomUUID(),
        expectedConfigurationVersion: rotated.configurationVersion,
      }, db);
      assert.equal(afterRotation.attempt.status, "settled");
      assert.equal(afterRotation.attempt.safeErrorCode, null);
      assert.equal(fetches, 2);
      const heldAfterRotation = await db.platformProviderProbeAttempt.findUniqueOrThrow({ where: { id: attempt.id }, select: { status: true, heldUnits: true, providerConfigurationVersion: true } });
      assert.deepEqual(heldAfterRotation, { status: "held", heldUnits: 1, providerConfigurationVersion: attempt.providerConfigurationVersion });
      assert.equal(await db.platformProviderProbeLedger.count({ where: { attemptId: attempt.id, event: "held" } }), heldLedgerCount);
      assert.equal((await db.platformProviderProbeBudget.findUniqueOrThrow({ where: { id: attempt.budgetId }, select: { heldUnits: true } })).heldUnits, 1);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
      else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyPath;
      await rm(keyDirectory, { recursive: true, force: true });
    }
  },
);

test(
  "platform provider probe database guards deny destructive, contextless, malformed, and cross-row writes",
  { skip: !shouldRun ? "PLATFORM_PROVIDER_PROBE_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const keyDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-platform-probe-guards-"));
    const previousKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    process.env.AI_PROJECT_OS_MASTER_KEY_FILE = join(keyDirectory, "master.key");
    const adminId = "00000000-0000-4000-8000-000000000010";
    const otherActorId = randomUUID();
    const actor = { id: adminId, role: "admin" as const, accountAccessVersion: 1 };
    const previousFetch = globalThis.fetch;
    try {
      await db.appUser.create({ data: { id: otherActorId, username: `platform_probe_guard_actor_${suffix}`, role: "user" } });
      const provider = await createVerifiedProviderFixture({
        name: `Platform probe guards ${suffix}`,
        kind: "openai",
        apiKey: "platform-probe-guards-key",
        generationModelId: "gpt-4.1-mini",
        embeddingModelId: null,
        embeddingDimensions: null,
        visionModelId: null,
      }, actor, db);
      const now = new Date();
      await createAndActivatePlatformProviderProbeBudget({
        unitLimit: 10,
        alertThresholdUnits: 1,
        startsAt: new Date(now.getTime() - 1_000).toISOString(),
        expiresAt: new Date(now.getTime() + 600_000).toISOString(),
      }, actor, db);
      const firstBudget = await db.platformProviderProbeBudget.findFirstOrThrow({ where: { status: "active" }, orderBy: { version: "desc" }, select: { id: true, version: true } });
      globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200, headers: { "content-type": "application/json" } });
      const successful = await runPlatformProviderProbe(provider.id, actor, { clientRequestKey: randomUUID(), expectedConfigurationVersion: provider.configurationVersion }, db);
      assert.equal(successful.attempt.status, "settled");
      const settledAttempt = await db.platformProviderProbeAttempt.findFirstOrThrow({ where: { providerConnectionId: provider.id, status: "settled" }, select: { id: true, budgetId: true, actorId: true } });
      const settledLedger = await db.platformProviderProbeLedger.findFirstOrThrow({ where: { attemptId: settledAttempt.id, event: "settled" }, select: { id: true } });
      assert.equal(settledAttempt.budgetId, firstBudget.id);

      await createAndActivatePlatformProviderProbeBudget({
        unitLimit: 10,
        alertThresholdUnits: 1,
        startsAt: new Date(now.getTime() - 1_000).toISOString(),
        expiresAt: new Date(now.getTime() + 600_000).toISOString(),
      }, actor, db);
      const activeBudget = await db.platformProviderProbeBudget.findFirstOrThrow({ where: { status: "active" }, orderBy: { version: "desc" }, select: { id: true, version: true } });
      assert.notEqual(activeBudget.id, firstBudget.id);

      await assertRawGuardRejects(
        () => db.$executeRaw(Prisma.sql`
          INSERT INTO "PlatformProviderProbeBudget" (
            "id", "version", "status", "unitLimit", "alertThresholdUnits", "startsAt", "expiresAt", "createdById", "updatedAt"
          ) VALUES (
            ${randomUUID()}::uuid, ${activeBudget.version + 1000}, 'draft'::"PlatformProviderProbeBudgetStatus", 1, 0,
            ${now}::timestamp, ${new Date(now.getTime() + 60_000)}::timestamp, ${adminId}::uuid, ${now}::timestamp
          )
        `),
        /governed service context|insufficient_privilege/iu,
      );
      await assertRawGuardRejects(
        () => db.$executeRaw(Prisma.sql`
          INSERT INTO "PlatformProviderProbeAttempt" (
            "id", "budgetId", "providerConnectionId", "actorId", "actorAccountAccessVersion", "providerConfigurationVersion",
            "credentialSecretFingerprint", "clientRequestKeyHash", "requestFingerprint", "status", "plannedUnits", "leaseExpiresAt", "updatedAt"
          ) VALUES (
            ${randomUUID()}::uuid, ${activeBudget.id}::uuid, ${provider.id}::uuid, ${adminId}::uuid, 1, ${provider.configurationVersion},
            repeat('a', 64), repeat('b', 64), repeat('c', 64), 'reserved'::"PlatformProviderProbeAttemptStatus", 1,
            ${new Date(now.getTime() + 60_000)}::timestamp, ${now}::timestamp
          )
        `),
        /governed service context|insufficient_privilege/iu,
      );
      await assertRawGuardRejects(
        () => insertProbeLedger(db, { budgetId: firstBudget.id, attemptId: settledAttempt.id, actorId: adminId, ordinal: 1, event: "held", capability: "generation" }),
        /governed service context|insufficient_privilege/iu,
      );
      await assertRawGuardRejects(
        () => db.$executeRaw(Prisma.sql`UPDATE "PlatformProviderProbeBudget" SET "unitLimit" = "unitLimit" WHERE "id" = ${activeBudget.id}::uuid`),
        /governed service context|insufficient_privilege/iu,
      );
      await assertRawGuardRejects(
        () => db.$executeRaw(Prisma.sql`UPDATE "PlatformProviderProbeAttempt" SET "updatedAt" = "updatedAt" WHERE "id" = ${settledAttempt.id}::uuid`),
        /governed service context|insufficient_privilege/iu,
      );

      await assertTransactionGuardRejects(db, (tx) => tx.$executeRaw(Prisma.sql`DELETE FROM "PlatformProviderProbeBudget" WHERE "id" = ${activeBudget.id}::uuid`), /safety records cannot be deleted|restrict_violation/iu);
      await assertTransactionGuardRejects(db, (tx) => tx.$executeRaw(Prisma.sql`DELETE FROM "PlatformProviderProbeAttempt" WHERE "id" = ${settledAttempt.id}::uuid`), /safety records cannot be deleted|restrict_violation/iu);
      await assertTransactionGuardRejects(db, (tx) => tx.$executeRaw(Prisma.sql`UPDATE "PlatformProviderProbeLedger" SET "units" = "units" WHERE "id" = ${settledLedger.id}::uuid`), /append-only/iu);
      await assertTransactionGuardRejects(db, (tx) => tx.$executeRaw(Prisma.sql`DELETE FROM "PlatformProviderProbeLedger" WHERE "id" = ${settledLedger.id}::uuid`), /append-only/iu);

      await assertTransactionGuardRejects(db, (tx) => tx.$executeRaw(Prisma.sql`
        UPDATE "PlatformProviderProbeBudget"
        SET "retiredById" = ${adminId}::uuid, "retiredAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${activeBudget.id}::uuid
      `), /shape_check|check constraint/iu);
      await assertTransactionGuardRejects(db, (tx) => tx.$executeRaw(Prisma.sql`
        INSERT INTO "PlatformProviderProbeBudget" (
          "id", "version", "status", "unitLimit", "alertThresholdUnits", "startsAt", "expiresAt", "createdById", "activatedById", "activatedAt", "updatedAt"
        ) VALUES (
          ${randomUUID()}::uuid, ${activeBudget.version + 1}, 'draft'::"PlatformProviderProbeBudgetStatus", 1, 0,
          ${now}::timestamp, ${new Date(now.getTime() + 60_000)}::timestamp, ${adminId}::uuid, ${adminId}::uuid, ${now}::timestamp, ${now}::timestamp
        )
      `), /shape_check|check constraint/iu);
      await assertTransactionGuardRejects(db, (tx) => tx.$executeRaw(Prisma.sql`
        INSERT INTO "PlatformProviderProbeBudget" (
          "id", "version", "status", "unitLimit", "alertThresholdUnits", "startsAt", "expiresAt", "createdById", "retiredById", "retiredAt", "updatedAt"
        ) VALUES (
          ${randomUUID()}::uuid, ${activeBudget.version + 2}, 'retired'::"PlatformProviderProbeBudgetStatus", 1, 0,
          ${now}::timestamp, ${new Date(now.getTime() + 60_000)}::timestamp, ${adminId}::uuid, ${adminId}::uuid, ${now}::timestamp, ${now}::timestamp
        )
      `), /shape_check|check constraint/iu);

      await assertTransactionGuardRejects(db, (tx) => tx.$executeRaw(Prisma.sql`
        INSERT INTO "PlatformProviderProbeAttempt" (
          "id", "budgetId", "providerConnectionId", "actorId", "actorAccountAccessVersion", "providerConfigurationVersion",
          "credentialSecretFingerprint", "clientRequestKeyHash", "requestFingerprint", "status", "plannedUnits", "leaseExpiresAt", "updatedAt"
        ) VALUES (
          ${randomUUID()}::uuid, NULL::uuid, ${provider.id}::uuid, ${adminId}::uuid, 1, ${provider.configurationVersion},
          repeat('a', 64), repeat('b', 64), repeat('c', 64), 'reserved'::"PlatformProviderProbeAttemptStatus", 1,
          ${new Date(now.getTime() + 60_000)}::timestamp, ${now}::timestamp
        )
      `), /shape_check|check constraint/iu);
      await assertTransactionGuardRejects(db, (tx) => tx.$executeRaw(Prisma.sql`
        INSERT INTO "PlatformProviderProbeAttempt" (
          "id", "budgetId", "providerConnectionId", "actorId", "actorAccountAccessVersion", "providerConfigurationVersion",
          "credentialSecretFingerprint", "clientRequestKeyHash", "requestFingerprint", "status", "plannedUnits", "dispatchedUnits", "leaseExpiresAt", "updatedAt"
        ) VALUES (
          ${randomUUID()}::uuid, ${activeBudget.id}::uuid, ${provider.id}::uuid, ${adminId}::uuid, 1, ${provider.configurationVersion},
          repeat('a', 64), repeat('b', 64), repeat('c', 64), 'running'::"PlatformProviderProbeAttemptStatus", 1, 1,
          ${new Date(now.getTime() + 60_000)}::timestamp, ${now}::timestamp
        )
      `), /shape_check|check constraint/iu);
      await assertTransactionGuardRejects(db, (tx) => tx.$executeRaw(Prisma.sql`
        INSERT INTO "PlatformProviderProbeAttempt" (
          "id", "budgetId", "providerConnectionId", "actorId", "actorAccountAccessVersion", "providerConfigurationVersion",
          "credentialSecretFingerprint", "clientRequestKeyHash", "requestFingerprint", "status", "plannedUnits", "settledUnits", "leaseExpiresAt", "updatedAt"
        ) VALUES (
          ${randomUUID()}::uuid, ${activeBudget.id}::uuid, ${provider.id}::uuid, ${adminId}::uuid, 1, ${provider.configurationVersion},
          repeat('a', 64), repeat('b', 64), repeat('c', 64), 'settled'::"PlatformProviderProbeAttemptStatus", 1, 1,
          ${new Date(now.getTime() + 60_000)}::timestamp, ${now}::timestamp
        )
      `), /shape_check|check constraint/iu);

      await assertTransactionGuardRejects(db, (tx) => insertProbeLedger(tx, { budgetId: null, attemptId: settledAttempt.id, actorId: adminId, ordinal: 1, event: "held", capability: "generation" }), /shape_check|check constraint/iu);
      await assertTransactionGuardRejects(db, (tx) => insertProbeLedger(tx, { budgetId: activeBudget.id, attemptId: settledAttempt.id, actorId: adminId, ordinal: 1, event: "held", capability: "generation" }), /ledger binding|parity/iu);
      await assertTransactionGuardRejects(db, (tx) => insertProbeLedger(tx, { budgetId: firstBudget.id, attemptId: settledAttempt.id, actorId: otherActorId, ordinal: 1, event: "held", capability: "generation" }), /ledger binding|parity/iu);
      await assertTransactionGuardRejects(db, (tx) => insertProbeLedger(tx, { budgetId: firstBudget.id, attemptId: settledAttempt.id, actorId: adminId, ordinal: 1, event: "held", capability: "vision" }), /ledger binding|parity/iu);
      await assertTransactionGuardRejects(db, (tx) => insertProbeLedger(tx, { budgetId: firstBudget.id, attemptId: settledAttempt.id, actorId: adminId, ordinal: 2, event: "reserved", capability: "generation" }), /ledger binding|parity/iu);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
      else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyPath;
      await rm(keyDirectory, { recursive: true, force: true });
    }
  },
);

test(
  "draft proof consumption and operation apply preserve idempotent route evidence",
  { skip: !shouldRun ? "PLATFORM_PROVIDER_PROBE_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const keyDirectory = await mkdtemp(join(tmpdir(), "ai-project-os-platform-operation-proof-"));
    const previousKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    process.env.AI_PROJECT_OS_MASTER_KEY_FILE = join(keyDirectory, "master.key");
    const adminId = "00000000-0000-4000-8000-000000000010";
    const actor = { id: adminId, role: "admin" as const, accountAccessVersion: 1 };
    const previousFetch = globalThis.fetch;
    try {
      const provider = await createVerifiedProviderFixture({
        name: `Platform operation proof ${suffix}`,
        kind: "openai",
        apiKey: "platform-operation-proof-key",
        generationModelId: "gpt-4.1-mini",
        embeddingModelId: null,
        embeddingDimensions: null,
        visionModelId: null,
      }, actor, db);
      const draftAttempt = await db.platformProviderProbeAttempt.findFirstOrThrow({ where: { subject: "draftConnection", consumedProviderConnectionId: provider.id }, select: { id: true, subject: true, consumedAt: true, consumedProviderConnectionId: true, consumedRouteId: true } });
      assert.equal(draftAttempt.subject, "draftConnection");
      assert.ok(draftAttempt.consumedAt);
      assert.equal(draftAttempt.consumedRouteId, null);

      globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200, headers: { "content-type": "application/json" } });
      const input = {
        clientRequestKey: randomUUID(),
        providerConnectionId: provider.id,
        operation: "projectAnalysis" as const,
        modelId: "gpt-4.1-mini",
        maxOutputTokens: 256,
        quotaMultiplierBps: 10_000,
      };
      const probe = await probePlatformAiOperation(input, actor, db);
      assert.equal(probe.status, "settled");
      assert.ok(probe.probeId);
      const applied = await applyPlatformAiOperation({ ...input, probeId: probe.probeId }, actor, db);
      assert.equal(applied.route.status, "active");
      const proofAfterApply = await db.platformProviderProbeAttempt.findUniqueOrThrow({ where: { id: probe.probeId }, select: { consumedAt: true, consumedProviderConnectionId: true, consumedRouteId: true } });
      assert.equal(proofAfterApply.consumedProviderConnectionId, provider.id);
      assert.equal(proofAfterApply.consumedRouteId, applied.route.id);
      await assertTransactionGuardRejects(db, (tx) => tx.$executeRaw(Prisma.sql`UPDATE "PlatformProviderProbeAttempt" SET "consumedRouteId" = NULL WHERE "id" = ${probe.probeId}::uuid`), /consumed route reference is immutable/iu);

      const audits = await db.platformDefaultAiRouteAudit.findMany({ where: { routeId: applied.route.id }, orderBy: { createdAt: "asc" }, select: { action: true, safeSnapshot: true } });
      assert.deepEqual(audits.map((audit) => audit.action), ["draftCreated", "validated", "activated"]);
      assert.deepEqual(audits.map((audit) => (audit.safeSnapshot as { status?: string }).status), ["draft", "verified", "active"]);

      const replay = await applyPlatformAiOperation({ ...input, probeId: probe.probeId }, actor, db);
      assert.equal(replay.route.id, applied.route.id);
      assert.equal(await db.platformDefaultAiRoute.count({ where: { operation: "projectAnalysis", status: "active" } }), 1);
      await assert.rejects(
        () => applyPlatformAiOperation({ ...input, probeId: probe.probeId, maxOutputTokens: 257 }, actor, db),
        (error: unknown) => error instanceof PlatformProviderProbeServiceError && error.code === "PLATFORM_PROVIDER_PROBE_CONFIGURATION_CONFLICT",
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (previousKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
      else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyPath;
      await rm(keyDirectory, { recursive: true, force: true });
    }
  },
);
