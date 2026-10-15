import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { recoverExpiredPlatformTokenReservations, reservePlatformTokens } from "../src/lib/ai-entitlements";
import { getDb } from "../src/lib/db";
import { createPersonalKnowledgeDocument } from "../src/lib/personal-knowledge-service";
import { executePersonalKnowledgeSemantic, listPersonalKnowledgeSemanticProviders, preparePersonalKnowledgeSemantic } from "../src/lib/personal-knowledge-semantic-service";
import { createBootstrapSignupOfferPolicy } from "../src/lib/platform-grant-offer-policy-service";
import { applyPlatformAiOperation, probePlatformAiOperation } from "../src/lib/platform-ai-operation-service";
import { activateCanonicalSignupGrant } from "./account-entitlement-test-helper";
import { createVerifiedProviderFixture } from "./platform-provider-fixture";

test("platform personal semantic search confirms scope and charges the caller without BYOK", {
  skip: process.env.PERSONAL_KNOWLEDGE_SEMANTIC_POSTGRES_GATE !== "1",
}, async () => {
  const db = getDb();
  // The full gate exercises the production runtime ACLs. Fixture setup uses
  // the separately admitted migrator connection, never the runtime identity.
  const fixtureDb = process.env.MIGRATOR_DATABASE_URL
    ? new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.MIGRATOR_DATABASE_URL }) })
    : db;
  const suffix = randomUUID();
  const admin = { id: randomUUID(), role: "admin" as const, accountAccessVersion: 1 };
  const actor = { id: randomUUID(), role: "user" as const, accountAccessVersion: 1 };
  const other = { id: randomUUID(), role: "user" as const, accountAccessVersion: 1 };
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let responseMode: "known" | "missing-usage" | "network-error" | "rejected" = "known";
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    requests += 1;
    if (responseMode === "network-error") throw new TypeError("synthetic network uncertainty");
    if (responseMode === "rejected") return Response.json({ error: { message: "synthetic rejection" } }, { status: 429 });
    return Response.json({
      data: body.input.map((text, index) => ({ index, embedding: [1, text.includes("发布") ? 1 : 0, 0, 0, 0, 0, 0, 0] })),
      ...(responseMode === "known" ? { usage: { prompt_tokens: 7, total_tokens: 7 } } : {}),
    });
  };
  try {
    await fixtureDb.appUser.createMany({ data: [
      { ...admin, username: `platform_semantic_admin_${suffix}` },
      { ...actor, username: `platform_semantic_owner_${suffix}` },
      { ...other, username: `platform_semantic_other_${suffix}` },
    ] });
    if (await fixtureDb.platformGrantOfferPolicy.count() === 0) await fixtureDb.$transaction(tx => createBootstrapSignupOfferPolicy(tx, admin.id));
    await createPersonalKnowledgeDocument({ title: "发布检查", content: "发布前检查回滚方案。" }, actor, db);
    await createPersonalKnowledgeDocument({ title: "其他人的私有内容", content: "不允许出现在当前用户索引中。" }, other, db);
    const provider = await createVerifiedProviderFixture({
      name: "Platform semantic fixture", kind: "openai", apiKey: "synthetic-platform-key",
      generationModelId: null, visionModelId: null, embeddingModelId: "text-embedding-3-small", embeddingDimensions: 8,
    }, admin, fixtureDb);
    async function configure(multiplier: number) {
      const input = { clientRequestKey: randomUUID(), providerConnectionId: provider.id, operation: "embedding", modelId: "text-embedding-3-small", embeddingDimensions: 8, quotaMultiplierBps: multiplier };
      const proof = await probePlatformAiOperation(input, admin, fixtureDb);
      await applyPlatformAiOperation({ ...input, probeId: proof.probeId, confirmEmbeddingImpact: true }, admin, fixtureDb);
    }
    await configure(20_000);
    const providers = await listPersonalKnowledgeSemanticProviders(actor, db);
    assert.equal(providers.providers[0]?.id, provider.id);
    assert.equal(providers.providers[0]?.billingMode, "platform");
    assert.doesNotMatch(JSON.stringify(providers), /credential|synthetic-platform-key|secretFingerprint/u);
    const prepareBuild = () => {
      const clientKey = randomUUID();
      return preparePersonalKnowledgeSemantic({ kind: "build", providerId: provider.id, clientKey }, actor, db).then(confirmation => ({ confirmation, clientKey }));
    };
    requests = 0;
    const noCredit = await prepareBuild();
    assert.equal(requests, 0);
    assert.equal((noCredit.confirmation.safeSummary.documents as unknown[]).length, 1);
    assert.equal((noCredit.confirmation.safeSummary.billing as { mode: string }).mode, "platform");
    await assert.rejects(executePersonalKnowledgeSemantic({ challengeId: noCredit.confirmation.challengeId, clientKey: noCredit.clientKey }, actor, db), { code: "AI_PLATFORM_TOKEN_EXHAUSTED" });
    assert.equal(requests, 0, "insufficient credits cannot dispatch a provider call");
    await activateCanonicalSignupGrant(fixtureDb, { userId: actor.id, actorId: actor.id });
    const build = await prepareBuild();
    const built = await executePersonalKnowledgeSemantic({ challengeId: build.confirmation.challengeId, clientKey: build.clientKey }, actor, db);
    assert.ok("status" in built && built.status === "ready");
    const buildReservation = await db.platformTokenReservation.findUniqueOrThrow({ where: { userId_callKey: { userId: actor.id, callKey: `personal-semantic:${build.confirmation.challengeId}` } } });
    assert.equal(buildReservation.personalKnowledgeSemanticChallengeId, build.confirmation.challengeId);
    assert.equal(buildReservation.webAiGrantId, null);
    assert.equal(buildReservation.webAiGrantProjectId, null);
    assert.equal(buildReservation.status, "settled");
    assert.equal(buildReservation.rawSettledTokens, 7);
    assert.equal(buildReservation.settledTokens, 14);
    assert.equal(buildReservation.quotaMultiplierBps, 20_000);
    await assert.rejects(executePersonalKnowledgeSemantic({ challengeId: build.confirmation.challengeId, clientKey: build.clientKey }, actor, db), { code: "PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_CONSUMED" });
    assert.equal(requests, 1, "repeated confirmation cannot charge or dispatch twice");
    async function prepareSearch() {
      const clientKey = randomUUID();
      const confirmation = await preparePersonalKnowledgeSemantic({ kind: "search", providerId: provider.id, clientKey, query: "发布" }, actor, db);
      return { clientKey, confirmation, execute: () => executePersonalKnowledgeSemantic({ challengeId: confirmation.challengeId, clientKey, query: "发布" }, actor, db) };
    }
    // Direct accounting callers cannot turn another owner's or unconfirmed
    // consent into a personal reservation. Failed admission is fully atomic.
    const forged = await preparePersonalKnowledgeSemantic({ kind: "build", providerId: provider.id, clientKey: randomUUID() }, other, db);
    const unconsumed = await preparePersonalKnowledgeSemantic({ kind: "search", providerId: provider.id, clientKey: randomUUID(), query: "发布" }, actor, db);
    const beforeForgery = await db.platformTokenGrant.aggregate({ where: { userId: actor.id }, _sum: { remainingTokens: true } });
    for (const id of [forged.challengeId, unconsumed.challengeId]) {
      await assert.rejects(reservePlatformTokens({
        userId: actor.id, providerConnectionId: provider.id, callKey: `personal-semantic:${id}`,
        operation: "embedding", modelId: "text-embedding-3-small", rawEstimatedTokens: 100,
        routeSnapshot: { source: "platform_default", routeId: buildReservation.routeId!, routeVersion: buildReservation.routeVersion!,
          routeUpdatedAt: buildReservation.routeUpdatedAt!, providerConfigurationVersion: buildReservation.providerConfigurationVersion!,
          quotaMultiplierBps: buildReservation.quotaMultiplierBps, routeFenceFingerprint: buildReservation.routeFenceFingerprint! },
      }, db));
    }
    assert.deepEqual(await db.platformTokenGrant.aggregate({ where: { userId: actor.id }, _sum: { remainingTokens: true } }), beforeForgery);
    const search = await prepareSearch();
    const result = await search.execute();
    assert.ok("results" in result && result.results.length > 0);
    assert.ok("results" in result && result.results.every(row => row.title !== "其他人的私有内容"));
    const drift = await prepareSearch();
    await configure(10_000);
    const beforeDrift = requests;
    await assert.rejects(drift.execute(), { code: "PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_STALE" });
    assert.equal(requests, beforeDrift, "a price/route change requires fresh consent");
    responseMode = "missing-usage";
    const unverified = await prepareSearch();
    await unverified.execute();
    const held = await db.platformTokenReservation.findUniqueOrThrow({ where: { userId_callKey: { userId: actor.id, callKey: `personal-semantic:${unverified.confirmation.challengeId}` } } });
    assert.equal(held.status, "held");
    assert.equal(held.reconciliationRequired, true);
    responseMode = "rejected";
    const rejection = await prepareSearch();
    const beforeRejection = await db.platformTokenGrant.aggregate({ where: { userId: actor.id }, _sum: { remainingTokens: true } });
    await assert.rejects(rejection.execute(), { code: "PERSONAL_KNOWLEDGE_SEMANTIC_PROVIDER_UNAVAILABLE" });
    const rejectedReservation = await db.platformTokenReservation.findUniqueOrThrow({ where: { userId_callKey: { userId: actor.id, callKey: `personal-semantic:${rejection.confirmation.challengeId}` } } });
    assert.equal(rejectedReservation.status, "held", "HTTP rejections also reached the external provider");
    const afterRejection = await db.platformTokenGrant.aggregate({ where: { userId: actor.id }, _sum: { remainingTokens: true } });
    assert.equal(afterRejection._sum.remainingTokens, beforeRejection._sum.remainingTokens! - rejectedReservation.reservedTokens);
    const rejectionRequests = requests;
    await assert.rejects(rejection.execute(), { code: "PERSONAL_KNOWLEDGE_SEMANTIC_CONFIRMATION_CONSUMED" });
    assert.equal(requests, rejectionRequests);
    responseMode = "network-error";
    const uncertain = await prepareSearch();
    await assert.rejects(uncertain.execute(), { code: "PERSONAL_KNOWLEDGE_SEMANTIC_PROVIDER_UNCERTAIN" });
    const unknown = await db.platformTokenReservation.findUniqueOrThrow({ where: { userId_callKey: { userId: actor.id, callKey: `personal-semantic:${uncertain.confirmation.challengeId}` } } });
    assert.equal(unknown.status, "held", "uncertain external requests must retain their reservation");
    // Simulate a process exit after reservation and before its terminal write.
    // This uses the same unique personal consent binding as actual dispatch.
    let interrupted = false;
    const crashDb = new Proxy(db, { get(target, property, receiver) {
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return async (...args: unknown[]) => {
        const value: unknown = await Reflect.apply(target.$transaction, target, args);
        if (!interrupted && value && typeof value === "object" && "reservationId" in value && "created" in value && value.created === true) {
          interrupted = true;
          throw new Error("synthetic process interruption");
        }
        return value;
      };
    } });
    responseMode = "known";
    const crash = await prepareSearch();
    const beforeCrash = requests;
    await assert.rejects(executePersonalKnowledgeSemantic({ challengeId: crash.confirmation.challengeId, clientKey: crash.clientKey, query: "发布" }, actor, crashDb));
    assert.equal(requests, beforeCrash);
    const recovered = await recoverExpiredPlatformTokenReservations({ userId: actor.id, now: new Date(Date.now() + 3_600_001) }, db);
    assert.equal(recovered.held, 1);
    assert.equal(recovered.released, 0, "a consumed personal confirmation is never automatically refunded after a crash");
  } finally {
    globalThis.fetch = originalFetch;
    await db.$disconnect();
    if (fixtureDb !== db) await fixtureDb.$disconnect();
  }
});
