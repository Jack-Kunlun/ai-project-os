import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma } from "@prisma/client";
import { executeAccountAccess, previewAccountAccess } from "../src/lib/account-access-service";
import { lockActorAccess } from "../src/lib/access-linearization";
import { getProviderDefinition } from "../src/lib/ai-providers/registry";
import { lockProviderConfiguration } from "../src/lib/ai-providers/service";
import { createCredential, rotateCredential } from "../src/lib/credential-vault";
import { getDb } from "../src/lib/db";
import { createPersonalKnowledgeDocument, revisePersonalKnowledgeDocument } from "../src/lib/personal-knowledge-service";
import {
  executePersonalKnowledgeSemantic,
  getPersonalKnowledgeSemanticOverview,
  PersonalKnowledgeSemanticError,
  preparePersonalKnowledgeSemantic,
} from "../src/lib/personal-knowledge-semantic-service";

const shouldRun = process.env.PERSONAL_KNOWLEDGE_SEMANTIC_POSTGRES_GATE === "1";

type SemanticDb = ReturnType<typeof getDb>;
type TransactionOptions = Readonly<{
  isolationLevel?: Prisma.TransactionIsolationLevel;
  maxWait?: number;
  timeout?: number;
}>;
type TransactionCallback = (tx: Prisma.TransactionClient) => Promise<unknown>;

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return Object.freeze({ promise, resolve });
}

function valueDeferred<T>(): Readonly<{ promise: Promise<T>; resolve: (value: T) => void }> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return Object.freeze({ promise, resolve });
}

function isAdmittedSnapshot(value: unknown): value is Readonly<{ auditId: string }> {
  return typeof value === "object"
    && value !== null
    && typeof (value as { auditId?: unknown }).auditId === "string";
}

/**
 * Hold the service after its admission transaction has committed. This keeps
 * the race deterministic while retaining the production transaction path.
 */
function gateAfterAdmission(
  db: SemanticDb,
  admitted: Readonly<{ promise: Promise<void>; resolve: () => void }>,
  release: Readonly<{ promise: Promise<void>; resolve: () => void }>,
): SemanticDb {
  const transaction = db.$transaction.bind(db) as (
    callback: TransactionCallback,
    options?: TransactionOptions,
  ) => Promise<unknown>;
  let gated = false;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return async (callback: TransactionCallback, options?: TransactionOptions): Promise<unknown> => {
        const result = await transaction(callback, options);
        if (!gated && isAdmittedSnapshot(result)) {
          gated = true;
          admitted.resolve();
          await release.promise;
        }
        return result;
      };
    },
  }) as SemanticDb;
}

/** Keep a real account access writer transaction open after its mutation. */
function holdTransactionAfterWork(
  db: SemanticDb,
  writerReady: Readonly<{ promise: Promise<void>; resolve: () => void }>,
  release: Readonly<{ promise: Promise<void>; resolve: () => void }>,
  writerPid: Readonly<{ promise: Promise<number>; resolve: (value: number) => void }>,
): SemanticDb {
  const transaction = db.$transaction.bind(db) as (
    callback: TransactionCallback,
    options?: TransactionOptions,
  ) => Promise<unknown>;
  let held = false;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return async (callback: TransactionCallback, options?: TransactionOptions): Promise<unknown> => transaction(
        async (tx) => {
          try {
            const result = await callback(tx);
            if (!held) {
              held = true;
              const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::integer AS pid`;
              const pid = rows[0]?.pid;
              if (typeof pid !== "number") throw new Error("PERSONAL_KNOWLEDGE_SEMANTIC_WRITER_PID_REQUIRED");
              writerPid.resolve(pid);
              writerReady.resolve();
              await release.promise;
            }
            return result;
          } catch (error) {
            if (!held) {
              held = true;
              writerReady.resolve();
            }
            throw error;
          }
        },
        options,
      );
    },
  }) as SemanticDb;
}

async function waitForAdvisoryFenceWait(db: SemanticDb, blockingPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<Array<{
      blockedPid: number;
      blockingPids: number[];
      waitEventType: string | null;
      waitEvent: string | null;
      query: string;
    }>>(Prisma.sql`
      SELECT
        a.pid::integer AS "blockedPid",
        pg_blocking_pids(a.pid) AS "blockingPids",
        a.wait_event_type AS "waitEventType",
        a.wait_event AS "waitEvent",
        a.query AS "query"
      FROM pg_stat_activity AS a
      WHERE a.datname = current_database()
        AND a.pid <> pg_backend_pid()
        AND ${blockingPid}::integer = ANY(pg_blocking_pids(a.pid))
        AND a.wait_event_type = 'Lock'
        AND a.query LIKE '%pg_advisory_xact_lock%'
    `);
    const row = rows[0];
    if (row !== undefined && row.blockingPids.includes(blockingPid) && row.waitEventType === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("PERSONAL_KNOWLEDGE_SEMANTIC_ADVISORY_WAIT_NOT_OBSERVED");
}

async function readSemanticAudit(db: SemanticDb, challengeId: string) {
  return db.personalKnowledgeSemanticAudit.findUniqueOrThrow({
    where: { challengeId },
    select: { status: true, safeErrorCode: true, requestCount: true },
  });
}

async function runSemanticFenceRace(input: Readonly<{
  db: SemanticDb;
  actor: Readonly<{ id: string; role: "user"; accountAccessVersion: number }>;
  challengeId: string;
  clientKey: string;
  lock: (tx: Prisma.TransactionClient) => Promise<void>;
  mutate: (tx: Prisma.TransactionClient) => Promise<void>;
}>): Promise<Awaited<ReturnType<typeof readSemanticAudit>>> {
  const admitted = deferred();
  const releaseAdmission = deferred();
  const writerLocked = deferred();
  const releaseWriter = deferred();
  const writerPid = valueDeferred<number>();
  const dispatchDb = gateAfterAdmission(input.db, admitted, releaseAdmission);
  const dispatch = executePersonalKnowledgeSemantic(
    { phase: "execute", challengeId: input.challengeId, clientKey: input.clientKey },
    input.actor,
    dispatchDb,
  );
  await admitted.promise;
  const writer = input.db.$transaction(async (tx) => {
    await input.lock(tx);
    const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::integer AS pid`;
    const pid = rows[0]?.pid;
    if (typeof pid !== "number") throw new Error("PERSONAL_KNOWLEDGE_SEMANTIC_WRITER_PID_REQUIRED");
    writerPid.resolve(pid);
    writerLocked.resolve();
    await releaseWriter.promise;
    await input.mutate(tx);
  });
  await writerLocked.promise;
  releaseAdmission.resolve();
  try {
    await waitForAdvisoryFenceWait(input.db, await writerPid.promise);
  } finally {
    releaseWriter.resolve();
  }
  await writer;
  await assert.rejects(
    () => dispatch,
    (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_SEMANTIC_STALE",
  );
  return readSemanticAudit(input.db, input.challengeId);
}

function serviceCode(error: unknown): string | null {
  return error instanceof PersonalKnowledgeSemanticError ? error.code : null;
}

function embedding(value: string): number[] {
  const vector = Array.from({ length: 8 }, () => 0);
  vector[0] = value.includes("回滚") || value.includes("索引") ? 1 : 0.1;
  vector[1] = value.includes("知识") ? 1 : 0.2;
  return vector;
}

test(
  "personal semantic index builds with explicit outbound confirmation and searches current owner revisions",
  { skip: !shouldRun ? "PERSONAL_KNOWLEDGE_SEMANTIC_POSTGRES_GATE=1 is required" : false },
  async () => {
    if (typeof process.env.DATABASE_URL !== "string" || process.env.DATABASE_URL.length === 0) {
      throw new Error("PERSONAL_KNOWLEDGE_SEMANTIC_POSTGRES_DATABASE_URL_REQUIRED");
    }
    const db = getDb();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const ownerId = randomUUID();
    const otherOwnerId = randomUUID();
    const adminId = randomUUID();
    const owner = { id: ownerId, role: "user" as const, accountAccessVersion: 1 };
    const otherOwner = { id: otherOwnerId, role: "user" as const, accountAccessVersion: 1 };
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;

    try {
      await db.appUser.createMany({
        data: [
          { id: ownerId, username: `personal_semantic_owner_${suffix}`, role: "user" },
          { id: otherOwnerId, username: `personal_semantic_other_${suffix}`, role: "user" },
          { id: adminId, username: `personal_semantic_admin_${suffix}`, role: "admin" },
        ],
      });
      const page = await createPersonalKnowledgeDocument(
        { title: "发布知识", content: "发布前要确认回滚方案，并检查当前知识索引。" },
        owner,
        db,
      );
      await createPersonalKnowledgeDocument(
        { title: "另一页", content: "另一页记录团队背景知识。" },
        owner,
        db,
      );
      await createPersonalKnowledgeDocument(
        { title: "私有页面", content: "其他用户不可见的知识。" },
        otherOwner,
        db,
      );
      const credential = await createCredential("aiProvider", "semantic-test-secret-123456", db);
      const provider = await db.aiProviderConnection.create({
        data: {
          name: "Semantic personal provider",
          kind: "openai",
          scope: "user",
          ownerUserId: ownerId,
          protocol: "chatCompletions",
          baseUrl: getProviderDefinition("openai").baseUrl,
          credentialId: credential.id,
          defaultEmbeddingModelId: "embedding-test",
          embeddingDimensions: 8,
          ownerAccountAccessVersion: 1,
          status: "verified",
          lastTestedAt: new Date(),
        },
      });

      const buildClientKey = randomUUID();
      const confirmation = await preparePersonalKnowledgeSemantic({ kind: "build", providerId: provider.id, clientKey: buildClientKey }, owner, db);
      assert.equal(confirmation.kind, "build");
      assert.equal((confirmation.safeSummary.provider as { name: string }).name, provider.name);
      assert.equal(JSON.stringify(confirmation.safeSummary).includes("发布前要确认"), false);
      const challenge = await db.personalKnowledgeSemanticChallenge.findUniqueOrThrow({ where: { id: confirmation.challengeId }, select: { sourceManifest: true, status: true, queryHash: true } });
      assert.equal(challenge.status, "issued");
      assert.equal(challenge.queryHash, null);
      assert.equal(JSON.stringify(challenge.sourceManifest).includes("发布前要确认"), false);

      globalThis.fetch = async (_input, init) => {
        fetchCount += 1;
        const body = JSON.parse(String(init?.body)) as { input?: string[] };
        const texts = body.input ?? [];
        return new Response(JSON.stringify({ data: texts.map((text, index) => ({ index, embedding: embedding(text) })), usage: { prompt_tokens: texts.length * 3 }, }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "semantic-build" } });
      };
      const wrongKey = await executePersonalKnowledgeSemantic({ phase: "execute", challengeId: confirmation.challengeId, clientKey: "wrong-key-123456" }, owner, db).catch((error: unknown) => {
        assert.equal(serviceCode(error), "PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_REQUIRED");
        return null;
      });
      assert.equal(wrongKey, null);
      assert.equal(fetchCount, 0);

      const built = await executePersonalKnowledgeSemantic({ phase: "execute", challengeId: confirmation.challengeId, clientKey: buildClientKey }, owner, db);
      assert.equal("status" in built ? built.status : null, "ready");
      assert.ok("indexedEntryCount" in built && built.indexedEntryCount > 0);
      assert.equal(fetchCount, 1);
      const buildAudit = await db.personalKnowledgeSemanticAudit.findUniqueOrThrow({
        where: { challengeId: confirmation.challengeId },
        select: { status: true, safeErrorCode: true, requestCount: true, inputTokens: true, usageKnown: true, completedAt: true },
      });
      assert.deepEqual(buildAudit.status, "succeeded");
      assert.equal(buildAudit.safeErrorCode, null);
      assert.equal(buildAudit.requestCount, 1);
      assert.ok(buildAudit.inputTokens > 0);
      assert.equal(buildAudit.usageKnown, true);
      assert.ok(buildAudit.completedAt instanceof Date);
      const overview = await getPersonalKnowledgeSemanticOverview(owner, db);
      assert.equal(overview.status, "ready");
      const vectorShape = await db.$queryRaw<Array<{ dimensions: number }>>`SELECT vector_dims("vector") AS dimensions FROM "PersonalKnowledgeSemanticEntry" WHERE "ownerUserId" = ${ownerId}::uuid LIMIT 1`;
      assert.equal(Number(vectorShape[0]?.dimensions), 8);

      const searchClientKey = randomUUID();
      const searchConfirmation = await preparePersonalKnowledgeSemantic({ kind: "search", providerId: provider.id, query: "回滚方案", clientKey: searchClientKey }, owner, db);
      const search = await executePersonalKnowledgeSemantic({ phase: "execute", challengeId: searchConfirmation.challengeId, query: "回滚方案", clientKey: searchClientKey }, owner, db);
      assert.equal("results" in search, true);
      if (!("results" in search)) throw new Error("PERSONAL_KNOWLEDGE_SEMANTIC_SEARCH_RESULT_REQUIRED");
      assert.equal(search.results[0]?.documentId, page.id);
      assert.equal(search.results[0]?.excerpt.includes("回滚方案"), true);
      assert.equal(fetchCount, 2);

      // Seed one already-expired issued proof through the same mutation
      // context used by the service. Expiry is checked before provider
      // access, so the ready generation remains searchable and fetch stays at
      // zero for this dispatch.
      const searchChallengeRow = await db.personalKnowledgeSemanticChallenge.findUniqueOrThrow({
        where: { id: searchConfirmation.challengeId },
        select: {
          sourceManifest: true,
          expectedEntryCount: true,
          queryHash: true,
        },
      });
      const currentState = await db.personalKnowledgeSemanticIndexState.findUniqueOrThrow({
        where: { ownerUserId: ownerId },
        select: { corpusEpoch: true, activeGenerationId: true },
      });
      assert.ok(currentState.activeGenerationId);
      const providerSnapshot = await db.aiProviderConnection.findUniqueOrThrow({
        where: { id: provider.id },
        select: {
          configurationVersion: true,
          defaultEmbeddingModelId: true,
          embeddingDimensions: true,
          credential: { select: { secretFingerprint: true } },
        },
      });
      const modelId = providerSnapshot.defaultEmbeddingModelId;
      const dimensions = providerSnapshot.embeddingDimensions;
      const sourceManifest = searchChallengeRow.sourceManifest;
      const queryHash = searchChallengeRow.queryHash;
      if (modelId === null || dimensions === null || sourceManifest === null || queryHash === null) throw new Error("PERSONAL_KNOWLEDGE_SEMANTIC_EXPIRED_FIXTURE_INVALID");
      const expiredClientKey = randomUUID();
      const expiredIssuedAt = new Date(Date.now() - 120_000);
      const expiredAt = new Date(Date.now() - 60_000);
      const expiredHash = randomUUID().replaceAll("-", "").repeat(2);
      const expiredChallengeId = randomUUID();
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.personal_knowledge_semantic_mutation_context', 'service-v1', true)`;
        await tx.personalKnowledgeSemanticChallenge.create({
          data: {
            id: expiredChallengeId,
            ownerUserId: ownerId,
            kind: "search",
            generationId: currentState.activeGenerationId!,
            providerConnectionId: provider.id,
            providerConfigurationVersion: providerSnapshot.configurationVersion,
            credentialSecretFingerprint: providerSnapshot.credential.secretFingerprint,
            modelId,
            dimensions,
            corpusEpoch: currentState.corpusEpoch,
            sourceManifest,
            expectedEntryCount: searchChallengeRow.expectedEntryCount,
            queryHash,
            actorAccountAccessVersion: 1,
            clientKeyHash: expiredHash,
            inputFingerprint: expiredHash,
            status: "issued",
            issuedAt: expiredIssuedAt,
            expiresAt: expiredAt,
          },
        });
      });
      await assert.rejects(
        () => executePersonalKnowledgeSemantic({ phase: "execute", challengeId: expiredChallengeId, query: "回滚方案", clientKey: expiredClientKey }, owner, db),
        (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_EXPIRED",
      );
      assert.equal(fetchCount, 2);
      assert.equal((await getPersonalKnowledgeSemanticOverview(owner, db)).status, "ready");

      // Preparing a replacement does not take the currently ready generation
      // out of service. An unconfirmed/wrong-key dispatch therefore leaves
      // the existing search index available.
      const abandonedBuildKey = randomUUID();
      const abandonedBuild = await preparePersonalKnowledgeSemantic({ kind: "build", providerId: provider.id, clientKey: abandonedBuildKey }, owner, db);
      assert.equal((await getPersonalKnowledgeSemanticOverview(owner, db)).status, "ready");
      await assert.rejects(
        () => executePersonalKnowledgeSemantic({ phase: "execute", challengeId: abandonedBuild.challengeId, clientKey: "wrong-abandoned-key" }, owner, db),
        (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_REQUIRED",
      );
      assert.equal(fetchCount, 2);
      assert.equal((await getPersonalKnowledgeSemanticOverview(owner, db)).status, "ready");

      // Once execution is confirmed, a provider failure restores the prior
      // ready generation while the failed replacement remains historical.
      const failedBuildKey = randomUUID();
      const failedBuild = await preparePersonalKnowledgeSemantic({ kind: "build", providerId: provider.id, clientKey: failedBuildKey }, owner, db);
      globalThis.fetch = async () => {
        fetchCount += 1;
        return new Response(JSON.stringify({ error: { message: "provider unavailable" } }), { status: 500, headers: { "content-type": "application/json" } });
      };
      await assert.rejects(
        () => executePersonalKnowledgeSemantic({ phase: "execute", challengeId: failedBuild.challengeId, clientKey: failedBuildKey }, owner, db),
        (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_SEMANTIC_PROVIDER_UNCERTAIN",
      );
      assert.equal(fetchCount, 3);
      assert.equal((await getPersonalKnowledgeSemanticOverview(owner, db)).status, "ready");

      globalThis.fetch = async (_input, init) => {
        fetchCount += 1;
        const body = JSON.parse(String(init?.body)) as { input?: string[] };
        const texts = body.input ?? [];
        return new Response(JSON.stringify({ data: texts.map((text, index) => ({ index, embedding: embedding(text) })), usage: { prompt_tokens: texts.length * 3 }, }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "semantic-build" } });
      };

      // A provider writer that commits while the post-admission provider
      // fence is waiting invalidates the dispatch before transport. The
      // blocked backend is observed directly through pg_stat_activity.
      const disableRaceKey = randomUUID();
      const disableRace = await preparePersonalKnowledgeSemantic({ kind: "build", providerId: provider.id, clientKey: disableRaceKey }, owner, db);
      const disableAudit = await runSemanticFenceRace({
        db,
        actor: owner,
        challengeId: disableRace.challengeId,
        clientKey: disableRaceKey,
        lock: (tx) => lockProviderConfiguration(tx, provider.id),
        mutate: async (tx) => {
          await tx.aiProviderConnection.update({
            where: { id: provider.id },
            data: { status: "disabled", disabledAt: new Date(), configurationVersion: { increment: 1 }, lastTestedAt: null },
          });
        },
      });
      assert.deepEqual(disableAudit, { status: "failed", safeErrorCode: "PERSONAL_KNOWLEDGE_SEMANTIC_STALE", requestCount: 0 });
      assert.equal(fetchCount, 3);
      await db.$transaction(async (tx) => {
        await lockProviderConfiguration(tx, provider.id);
        await tx.aiProviderConnection.update({
          where: { id: provider.id },
          data: { status: "verified", disabledAt: null, configurationVersion: { increment: 1 }, lastTestedAt: new Date() },
        });
      });

      const afterDisableKey = randomUUID();
      const afterDisable = await preparePersonalKnowledgeSemantic({ kind: "build", providerId: provider.id, clientKey: afterDisableKey }, owner, db);
      const rebuiltAfterDisable = await executePersonalKnowledgeSemantic({ phase: "execute", challengeId: afterDisable.challengeId, clientKey: afterDisableKey }, owner, db);
      assert.equal("status" in rebuiltAfterDisable ? rebuiltAfterDisable.status : null, "ready");
      assert.equal(fetchCount, 4);

      const configRaceKey = randomUUID();
      const configRace = await preparePersonalKnowledgeSemantic({ kind: "build", providerId: provider.id, clientKey: configRaceKey }, owner, db);
      const configAudit = await runSemanticFenceRace({
        db,
        actor: owner,
        challengeId: configRace.challengeId,
        clientKey: configRaceKey,
        lock: (tx) => lockProviderConfiguration(tx, provider.id),
        mutate: async (tx) => {
          await tx.aiProviderConnection.update({ where: { id: provider.id }, data: { configurationVersion: { increment: 1 } } });
        },
      });
      assert.deepEqual(configAudit, { status: "failed", safeErrorCode: "PERSONAL_KNOWLEDGE_SEMANTIC_STALE", requestCount: 0 });
      assert.equal(fetchCount, 4);

      const afterConfigKey = randomUUID();
      const afterConfig = await preparePersonalKnowledgeSemantic({ kind: "build", providerId: provider.id, clientKey: afterConfigKey }, owner, db);
      const rebuiltAfterConfig = await executePersonalKnowledgeSemantic({ phase: "execute", challengeId: afterConfig.challengeId, clientKey: afterConfigKey }, owner, db);
      assert.equal("status" in rebuiltAfterConfig ? rebuiltAfterConfig.status : null, "ready");
      assert.equal(fetchCount, 5);

      // Preparing a second rebuild retires the first unconfirmed generation;
      // executing the first proof therefore fails before any provider call.
      const firstRebuildKey = randomUUID();
      const firstRebuild = await preparePersonalKnowledgeSemantic({ kind: "build", providerId: provider.id, clientKey: firstRebuildKey }, owner, db);
      const secondRebuildKey = randomUUID();
      const secondRebuild = await preparePersonalKnowledgeSemantic({ kind: "build", providerId: provider.id, clientKey: secondRebuildKey }, owner, db);
      await assert.rejects(
        () => executePersonalKnowledgeSemantic({ phase: "execute", challengeId: firstRebuild.challengeId, clientKey: firstRebuildKey }, owner, db),
        (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_STALE",
      );
      assert.equal(fetchCount, 5);
      const rebuiltAfterRace = await executePersonalKnowledgeSemantic({ phase: "execute", challengeId: secondRebuild.challengeId, clientKey: secondRebuildKey }, owner, db);
      assert.equal("status" in rebuiltAfterRace ? rebuiltAfterRace.status : null, "ready");
      assert.equal(fetchCount, 6);

      await assert.rejects(
        () => executePersonalKnowledgeSemantic({ phase: "execute", challengeId: searchConfirmation.challengeId, query: "回滚方案", clientKey: searchClientKey }, owner, db),
        (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_CONSUMED",
      );
      assert.equal(fetchCount, 6);

      const staleClientKey = randomUUID();
      const staleConfirmation = await preparePersonalKnowledgeSemantic({ kind: "search", providerId: provider.id, query: "回滚方案", clientKey: staleClientKey }, owner, db);
      await revisePersonalKnowledgeDocument(page.id, { expectedVersion: 1, content: "已更新的知识正文，不再是旧索引内容。" }, owner, db);
      await assert.rejects(
        () => executePersonalKnowledgeSemantic({ phase: "execute", challengeId: staleConfirmation.challengeId, query: "回滚方案", clientKey: staleClientKey }, owner, db),
        (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_STALE",
      );
      assert.equal((await getPersonalKnowledgeSemanticOverview(owner, db)).status, "not_available");

      const rebuildClientKey = randomUUID();
      const rebuildConfirmation = await preparePersonalKnowledgeSemantic({ kind: "build", providerId: provider.id, clientKey: rebuildClientKey }, owner, db);
      await rotateCredential(provider.credentialId, "aiProvider", "semantic-test-rotated-secret-123456", db);
      await assert.rejects(
        () => executePersonalKnowledgeSemantic({ phase: "execute", challengeId: rebuildConfirmation.challengeId, clientKey: rebuildClientKey }, owner, db),
        (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_STALE",
      );
      assert.equal(fetchCount, 6);

      // An intervening generation invalidation also wins while the final
      // actor fence waits. The generation and index state are changed under
      // the same mutation context used by the service, so this exercises the
      // owner fence without fabricating a second provider request.
      const generationRaceKey = randomUUID();
      const generationRace = await preparePersonalKnowledgeSemantic({ kind: "build", providerId: provider.id, clientKey: generationRaceKey }, owner, db);
      const generationRaceRow = await db.personalKnowledgeSemanticChallenge.findUniqueOrThrow({
        where: { id: generationRace.challengeId },
        select: { generationId: true },
      });
      const generationAudit = await runSemanticFenceRace({
        db,
        actor: owner,
        challengeId: generationRace.challengeId,
        clientKey: generationRaceKey,
        lock: async (tx) => {
          await lockActorAccess(tx, owner.id);
        },
        mutate: async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.personal_knowledge_semantic_mutation_context', 'service-v1', true)`;
          await tx.personalKnowledgeSemanticGeneration.update({
            where: { id: generationRaceRow.generationId },
            data: { status: "failed", safeErrorCode: "PERSONAL_KNOWLEDGE_SEMANTIC_STALE", completedAt: new Date() },
          });
          await tx.personalKnowledgeSemanticIndexState.update({
            where: { ownerUserId: owner.id },
            data: { status: "stale", activeGenerationId: null },
          });
        },
      });
      assert.deepEqual(generationAudit, { status: "failed", safeErrorCode: "PERSONAL_KNOWLEDGE_SEMANTIC_STALE", requestCount: 0 });
      assert.equal(fetchCount, 6);

      // Account disable uses the shared actor lock. The dispatch is admitted
      // first, then waits on that lock until the disabling writer commits.
      const accountRaceKey = randomUUID();
      const accountRace = await preparePersonalKnowledgeSemantic({ kind: "build", providerId: provider.id, clientKey: accountRaceKey }, owner, db);
      const accessPreview = await previewAccountAccess({
        adminUserId: adminId,
        adminAccountAccessVersion: 1,
        userId: ownerId,
        action: "disable",
        reason: "Semantic writer-first disable race",
        expectedVersion: 1,
      }, db);
      const admitted = deferred();
      const releaseAdmission = deferred();
      const dispatchDb = gateAfterAdmission(db, admitted, releaseAdmission);
      const dispatch = executePersonalKnowledgeSemantic(
        { phase: "execute", challengeId: accountRace.challengeId, clientKey: accountRaceKey },
        owner,
        dispatchDb,
      );
      await admitted.promise;

      const writerReady = deferred();
      const releaseWriter = deferred();
      const writerPid = valueDeferred<number>();
      const writer = executeAccountAccess({
        adminUserId: adminId,
        adminAccountAccessVersion: 1,
        userId: ownerId,
        action: "disable",
        reason: "Semantic writer-first disable race",
        expectedVersion: accessPreview.current.accountAccessVersion,
        expectedImpactFingerprint: accessPreview.impactFingerprint,
        requestKey: randomUUID(),
        requestFingerprint: accessPreview.requestFingerprint,
        previewId: accessPreview.previewId,
        previewIssuedAt: accessPreview.issuedAt,
        previewExpiresAt: accessPreview.expiresAt,
        confirmation: true,
        confirmationUsername: `personal_semantic_owner_${suffix}`,
      }, holdTransactionAfterWork(db, writerReady, releaseWriter, writerPid));
      try {
        await writerReady.promise;
        releaseAdmission.resolve();
        await waitForAdvisoryFenceWait(db, await writerPid.promise);
        releaseWriter.resolve();
        await writer;
        await assert.rejects(
          () => dispatch,
          (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_SEMANTIC_STALE",
        );
      } finally {
        releaseAdmission.resolve();
        releaseWriter.resolve();
        await Promise.allSettled([writer, dispatch]);
      }
      const accountAudit = await readSemanticAudit(db, accountRace.challengeId);
      assert.deepEqual(accountAudit, { status: "failed", safeErrorCode: "PERSONAL_KNOWLEDGE_SEMANTIC_STALE", requestCount: 0 });
      assert.equal(fetchCount, 6);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
