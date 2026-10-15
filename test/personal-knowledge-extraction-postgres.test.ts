import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { recoverExpiredPlatformTokenReservations, reservePlatformTokens } from "@/lib/ai-entitlements";
import { ApiError } from "@/lib/api-errors";
import { getProviderDefinition } from "@/lib/ai-providers/registry";
import { getDb } from "@/lib/db";
import {
  consumePersonalExtraction,
  finalizePersonalExtraction,
  personalExtractionDispatchValid,
  preparePersonalExtraction,
  visionPageManifestHash,
  withPersonalExtractionRouteFence,
} from "@/lib/personal-knowledge-extraction-consent";
import { extractPersonalKnowledgeVision, preparePersonalKnowledgeVision } from "@/lib/personal-knowledge-vision";
import { listPersonalKnowledgeVisionProviders } from "@/lib/personal-knowledge-vision-provider";
import { createPersonalKnowledgeDocument, revisePersonalKnowledgeDocument } from "@/lib/personal-knowledge-service";
import { probePlatformAiOperation, applyPlatformAiOperation } from "@/lib/platform-ai-operation-service";
import { createBootstrapSignupOfferPolicy } from "@/lib/platform-grant-offer-policy-service";
import { activateCanonicalSignupGrant } from "./account-entitlement-test-helper";
import { createVerifiedProviderFixture } from "./platform-provider-fixture";
import type { ParsedAssetSegment } from "@/lib/project-assets/parser";

const enabled = process.env.PERSONAL_KNOWLEDGE_EXTRACTION_POSTGRES_GATE === "1";
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const apiCode = (error: unknown, code: string) => error instanceof ApiError && error.code === code;

test("personal extraction confirmation is owner, source, provider and epoch bound, one-use and audited", {
  skip: !enabled ? "PERSONAL_KNOWLEDGE_EXTRACTION_POSTGRES_GATE=1 is required" : false,
}, async (context) => {
  const db = getDb();
  const fixtureDb = process.env.MIGRATOR_DATABASE_URL
    ? new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.MIGRATOR_DATABASE_URL }) })
    : db;
  context.after(async () => {
    await db.$disconnect();
    if (fixtureDb !== db) await fixtureDb.$disconnect();
  });
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const ownerId = randomUUID();
  const strangerId = randomUUID();
  const owner = { id: ownerId, role: "user" as const, accountAccessVersion: 1 };
  const stranger = { id: strangerId, role: "user" as const, accountAccessVersion: 1 };
  const raw = Buffer.from("private-image-bytes", "utf8");
  const visionPageManifest = [{ ordinal: 0, pageNumber: 1, locatorLabel: "第 1 页" }];
  const source = { operation: "vision" as const, input: raw, pageManifestHash: visionPageManifestHash([{ ...visionPageManifest[0]!, requiresVision: true }]), visionPageManifest };
  const changed = { ...source, input: Buffer.from("different-image-bytes", "utf8") };
  const fingerprint = "a".repeat(64);
  await fixtureDb.appUser.createMany({ data: [
    { id: ownerId, username: `extraction_owner_${suffix}`, role: "user" },
    { id: strangerId, username: `extraction_stranger_${suffix}`, role: "user" },
  ] });
  const credential = await fixtureDb.externalCredential.create({ data: {
    kind: "aiProvider", ciphertext: Buffer.from("test"), nonce: Buffer.alloc(12), authTag: Buffer.alloc(16),
    maskedSuffix: "test", secretFingerprint: fingerprint,
  } });
  const provider = await fixtureDb.aiProviderConnection.create({ data: {
    name: "Extraction test", kind: "openai", scope: "user", ownerUserId: ownerId,
    protocol: "chatCompletions", baseUrl: getProviderDefinition("openai").baseUrl,
    credentialId: credential.id, defaultGenerationModelId: "test-generation", defaultVisionModelId: "test-vision",
    ownerAccountAccessVersion: 1, status: "verified", lastTestedAt: new Date(),
  } });
  const prepared = await preparePersonalExtraction({ actor: owner, providerId: provider.id, source, db });
  assert.equal(prepared.providerName, provider.name);
  const issued = await db.personalKnowledgeExtractionAttempt.findUniqueOrThrow({ where: { id: prepared.attemptId } });
  assert.equal(issued.status, "issued");
  assert.equal(issued.inputHash, digest(raw));
  assert.equal(issued.documentId, null);
  assert.deepEqual(issued.providerRequestIds, []);
  assert.ok(!JSON.stringify(issued).includes(raw.toString("utf8")));
  await assert.rejects(() => consumePersonalExtraction({ actor: stranger, attemptId: prepared.attemptId, source, db }), (error) => apiCode(error, "PERSONAL_EXTRACTION_CONFIRMATION_EXPIRED"));
  await assert.rejects(() => consumePersonalExtraction({ actor: owner, attemptId: prepared.attemptId, source: changed, db }), (error) => apiCode(error, "PERSONAL_EXTRACTION_CONFIRMATION_STALE"));
  const changedPages = [{ ordinal: 0, pageNumber: 2, locatorLabel: "第 2 页" }];
  const changedManifest = { ...source, visionPageManifest: changedPages, pageManifestHash: visionPageManifestHash([{ ...changedPages[0]!, requiresVision: true }]) };
  await assert.rejects(() => consumePersonalExtraction({ actor: owner, attemptId: prepared.attemptId, source: changedManifest, db }), (error) => apiCode(error, "PERSONAL_EXTRACTION_CONFIRMATION_STALE"));
  const expired = await fixtureDb.personalKnowledgeExtractionAttempt.create({ data: {
    ownerUserId: ownerId, operation: "vision", inputHash: digest(raw), inputBytes: raw.length,
    pageManifestHash: source.pageManifestHash, providerConnectionId: provider.id,
    providerConfigurationVersion: provider.configurationVersion, modelId: provider.defaultVisionModelId!,
    credentialSecretFingerprint: fingerprint, actorAccountAccessVersion: 1,
    issuedAt: new Date(Date.now() - 120_000), expiresAt: new Date(Date.now() - 60_000),
  } });
  await assert.rejects(() => consumePersonalExtraction({ actor: owner, attemptId: expired.id, source, db }), (error) => apiCode(error, "PERSONAL_EXTRACTION_CONFIRMATION_EXPIRED"));
  const [first, second] = await Promise.allSettled([
    consumePersonalExtraction({ actor: owner, attemptId: prepared.attemptId, source, db }),
    consumePersonalExtraction({ actor: owner, attemptId: prepared.attemptId, source, db }),
  ]);
  assert.equal([first, second].filter((value) => value.status === "fulfilled").length, 1);
  const rejected = [first, second].find((value) => value.status === "rejected");
  assert.ok(rejected?.status === "rejected" && apiCode(rejected.reason, "PERSONAL_EXTRACTION_CONFIRMATION_USED"));
  assert.equal((rejected.reason as ApiError).status, 409);
  const snapshot = first.status === "fulfilled" ? first.value : second.status === "fulfilled" ? second.value : null;
  assert.ok(snapshot);
  await withPersonalExtractionRouteFence(snapshot, owner, async () => undefined, db);
  assert.equal(await personalExtractionDispatchValid(snapshot, owner, db), true);
  await finalizePersonalExtraction({ actor: owner, attemptId: prepared.attemptId, status: "succeeded", requestCount: 1, requestIds: ["req-test-1"], inputTokens: 12, outputTokens: 4, usageKnown: true, db });
  const complete = await db.personalKnowledgeExtractionAttempt.findUniqueOrThrow({ where: { id: prepared.attemptId } });
  assert.equal(complete.status, "succeeded");
  assert.equal(complete.requestCount, 1);
  assert.deepEqual(complete.providerRequestIds, ["req-test-1"]);
  assert.equal(await personalExtractionDispatchValid(snapshot, owner, db), false);
  await assert.rejects(() => finalizePersonalExtraction({ actor: owner, attemptId: prepared.attemptId, status: "failed", db }), (error) => apiCode(error, "PERSONAL_EXTRACTION_AUDIT_CONFLICT"));
  await assert.rejects(() => db.personalKnowledgeExtractionAttempt.update({ where: { id: prepared.attemptId }, data: { status: "unknown" } }));

  const changedProvider = await preparePersonalExtraction({ actor: owner, providerId: provider.id, source, db });
  await fixtureDb.aiProviderConnection.update({ where: { id: provider.id }, data: { configurationVersion: { increment: 1 } } });
  await assert.rejects(() => consumePersonalExtraction({ actor: owner, attemptId: changedProvider.attemptId, source, db }), (error) => apiCode(error, "PERSONAL_EXTRACTION_CONFIRMATION_STALE"));
  const changedEpoch = await preparePersonalExtraction({ actor: owner, providerId: provider.id, source, db });
  await assert.rejects(() => consumePersonalExtraction({ actor: { ...owner, accountAccessVersion: 2 }, attemptId: changedEpoch.attemptId, source, db }));

  const freshOwner = owner;
  const page = await createPersonalKnowledgeDocument({ title: "Project default", content: "个人偏好是 Vue 3" }, freshOwner, db);
  const pageId = page.id as string;
  const doc = await db.personalKnowledgeDocument.findUniqueOrThrow({ where: { id: pageId }, include: { currentRevision: true } });
  const graphSource = { operation: "graph" as const, input: Buffer.from(doc.currentRevision!.content, "utf8"), documentId: pageId, revisionId: doc.currentRevisionId! };
  const graphAttempt = await preparePersonalExtraction({ actor: freshOwner, providerId: provider.id, source: graphSource, db });
  await revisePersonalKnowledgeDocument(pageId, { title: "Project default", content: "个人偏好已经更新" , expectedVersion: doc.version }, freshOwner, db);
  await assert.rejects(() => consumePersonalExtraction({ actor: freshOwner, attemptId: graphAttempt.attemptId, source: graphSource, db }), (error) => apiCode(error, "PERSONAL_EXTRACTION_CONFIRMATION_STALE"));

  const admin = { id: randomUUID(), role: "admin" as const, accountAccessVersion: 1 };
  const noCreditId = randomUUID();
  const noCreditActor = { id: noCreditId, role: "user" as const, accountAccessVersion: 1 };
  await fixtureDb.appUser.createMany({ data: [
    { ...admin, username: `extraction_admin_${suffix}` },
    { id: noCreditId, username: `extraction_no_credit_${suffix}`, role: "user" },
  ] });
  if (await fixtureDb.platformGrantOfferPolicy.count() === 0) {
    await fixtureDb.$transaction((tx) => createBootstrapSignupOfferPolicy(tx, admin.id));
  }
  const platformProvider = await createVerifiedProviderFixture({
    name: "Personal vision platform fixture", kind: "openai", apiKey: "synthetic-personal-vision-key",
    generationModelId: "gpt-4o-mini", visionModelId: "gpt-4o-mini", embeddingModelId: null, embeddingDimensions: null,
  }, admin, fixtureDb);
  async function configureVisionRoute(multiplier: number, maxOutputTokens = 2_048) {
    const input = {
      clientRequestKey: randomUUID(), providerConnectionId: platformProvider.id,
      operation: "visionExtract", modelId: "gpt-4o-mini", maxOutputTokens,
      quotaMultiplierBps: multiplier,
    };
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: "OK" } }] });
    try {
      const proof = await probePlatformAiOperation(input, admin, fixtureDb);
      assert.ok(proof.probeId, "platform vision route probe must succeed before activation");
      await applyPlatformAiOperation({ ...input, probeId: proof.probeId }, admin, fixtureDb);
    } finally {
      globalThis.fetch = previousFetch;
    }
  }
  await configureVisionRoute(20_000);
  await activateCanonicalSignupGrant(fixtureDb, { userId: ownerId, actorId: ownerId });
  await activateCanonicalSignupGrant(fixtureDb, { userId: strangerId, actorId: strangerId });
  const candidates = await listPersonalKnowledgeVisionProviders(owner, db);
  assert.equal(candidates.platformRouteAvailable, true);
  assert.equal(candidates.providers[0]?.id, platformProvider.id);
  assert.equal(candidates.providers[0]?.billingMode, "platform");
  assert.equal(candidates.providers[0]?.isDefault, true);
  assert.doesNotMatch(JSON.stringify(candidates), /synthetic-personal-vision-key|secretFingerprint|credentialId/u);

  const image = Buffer.from("synthetic image bytes", "utf8");
  const visualSegments = [1, 2].map((page) => ({
    ordinal: page - 1, locatorKind: "image" as const, locatorLabel: `图片 ${page}`,
    pageNumber: null, slideNumber: null, sheetName: null, cellRange: null,
    requiresVision: true, extractionMethod: "vision" as const, contentText: "", contentHash: digest(Buffer.alloc(0)),
  })) satisfies readonly ParsedAssetSegment[];
  const originalFetch = globalThis.fetch;
  let mode: "success" | "429-second" | "missing-usage" = "success";
  let dispatches = 0;
  const requestedCaps: number[] = [];
  globalThis.fetch = async (_url, init) => {
    requestedCaps.push((JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens);
    dispatches += 1;
    if (mode === "429-second" && dispatches === 2) return Response.json({ error: { message: "synthetic rate limit" } }, { status: 429 });
    return Response.json({
      choices: [{ message: { content: JSON.stringify({ transcript: "识别内容", description: "" }) } }],
      ...(mode === "missing-usage" ? {} : { usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    }, { headers: { "x-request-id": `vision-${dispatches}` } });
  };
  try {
    const noCredit = await preparePersonalKnowledgeVision({ actor: noCreditActor, providerId: platformProvider.id, buffer: image, mimeType: "image/png", segments: visualSegments, db });
    await assert.rejects(() => extractPersonalKnowledgeVision({ actor: noCreditActor, attemptId: noCredit.attemptId, buffer: image, mimeType: "image/png", segments: visualSegments, db }), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "AI_PLATFORM_TOKEN_EXHAUSTED");
    assert.equal(dispatches, 0, "insufficient personal quota must fail before provider dispatch");

    const confirmation = await preparePersonalKnowledgeVision({ actor: owner, providerId: platformProvider.id, buffer: image, mimeType: "image/png", segments: visualSegments, db });
    assert.equal(confirmation.billingMode, "platform");
    assert.equal(confirmation.quotaMultiplierBps, 20_000);
    assert.equal(confirmation.maxOutputTokens, 2_048);
    assert.deepEqual(confirmation.pages.map((page) => page.locatorLabel), ["图片 1", "图片 2"]);
    const extracted = await extractPersonalKnowledgeVision({ actor: owner, attemptId: confirmation.attemptId, buffer: image, mimeType: "image/png", segments: visualSegments, db });
    assert.equal(extracted.length, 2);
    assert.equal(dispatches, 2);
    const reservations = await db.platformTokenReservation.findMany({
      where: { userId: ownerId, personalKnowledgeExtractionAttemptId: confirmation.attemptId },
      orderBy: { personalKnowledgeExtractionPageIndex: "asc" },
    });
    assert.deepEqual(reservations.map((row) => row.personalKnowledgeExtractionPageIndex), [1, 2]);
    assert.ok(reservations.every((row) => row.rawEstimatedTokens >= 2_048 + 2_048), "each page reserves the image token budget in addition to its output budget");
    assert.ok(reservations.every((row) => row.personalKnowledgeSemanticChallengeId === null && row.webAiGrantProjectId === null && row.routeSource === "platform_default"));
    assert.ok(reservations.every((row) => row.status === "settled" && row.rawSettledTokens === 15 && row.settledTokens === 30));
    await assert.rejects(() => extractPersonalKnowledgeVision({ actor: owner, attemptId: confirmation.attemptId, buffer: image, mimeType: "image/png", segments: visualSegments, db }));
    assert.equal(dispatches, 2, "a consumed confirmation cannot dispatch twice");

    const capDrift = await preparePersonalKnowledgeVision({ actor: owner, providerId: platformProvider.id, buffer: image, mimeType: "image/png", segments: visualSegments.slice(0, 1), db });
    await configureVisionRoute(20_000, 4_096);
    await assert.rejects(() => extractPersonalKnowledgeVision({ actor: owner, attemptId: capDrift.attemptId, buffer: image, mimeType: "image/png", segments: visualSegments.slice(0, 1), db }), { code: "PERSONAL_EXTRACTION_CONFIRMATION_STALE" });
    assert.equal(dispatches, 2, "an output-cap change requires fresh consent");
    const largerCap = await preparePersonalKnowledgeVision({ actor: owner, providerId: platformProvider.id, buffer: image, mimeType: "image/png", segments: visualSegments.slice(0, 1), db });
    assert.equal(largerCap.maxOutputTokens, 2_048, "personal vision retains its bounded output cap");
    await extractPersonalKnowledgeVision({ actor: owner, attemptId: largerCap.attemptId, buffer: image, mimeType: "image/png", segments: visualSegments.slice(0, 1), db });
    await configureVisionRoute(20_000, 1);
    const smallerCap = await preparePersonalKnowledgeVision({ actor: owner, providerId: platformProvider.id, buffer: image, mimeType: "image/png", segments: visualSegments.slice(0, 1), db });
    assert.equal(smallerCap.maxOutputTokens, 1);
    await extractPersonalKnowledgeVision({ actor: owner, attemptId: smallerCap.attemptId, buffer: image, mimeType: "image/png", segments: visualSegments.slice(0, 1), db });
    assert.deepEqual(requestedCaps, [2_048, 2_048, 2_048, 1], "provider requests honor the smaller of platform and personal output caps");
    const smallerProof = await db.personalKnowledgeExtractionAttempt.findUniqueOrThrow({ where: { id: smallerCap.attemptId } });
    assert.equal(smallerProof.platformMaxOutputTokens, 1);
    assert.equal(smallerProof.visionMaxOutputTokens, 1);
    await configureVisionRoute(20_000);

    const largerImage = Buffer.alloc(256 * 1_024 + 1, 1);
    const imageBudget = Math.ceil(largerImage.length / 1_024) * 16;
    const largerImageConsent = await preparePersonalKnowledgeVision({ actor: owner, providerId: platformProvider.id, buffer: largerImage, mimeType: "image/png", segments: visualSegments.slice(0, 1), db });
    await extractPersonalKnowledgeVision({ actor: owner, attemptId: largerImageConsent.attemptId, buffer: largerImage, mimeType: "image/png", segments: visualSegments.slice(0, 1), db });
    const largerReservation = await db.platformTokenReservation.findUniqueOrThrow({ where: { userId_callKey: { userId: ownerId, callKey: `personal-vision:${largerImageConsent.attemptId}:1` } } });
    assert.ok(largerReservation.rawEstimatedTokens >= reservations[0]!.rawEstimatedTokens + imageBudget - 2_048, "image preauthorization grows with actual byte size above the minimum budget");

    const changedRoute = await preparePersonalKnowledgeVision({ actor: owner, providerId: platformProvider.id, buffer: image, mimeType: "image/png", segments: visualSegments.slice(0, 1), db });
    await configureVisionRoute(10_000);
    const beforeRouteDrift = dispatches;
    await assert.rejects(() => extractPersonalKnowledgeVision({ actor: owner, attemptId: changedRoute.attemptId, buffer: image, mimeType: "image/png", segments: visualSegments.slice(0, 1), db }), { code: "PERSONAL_EXTRACTION_CONFIRMATION_STALE" });
    assert.equal(dispatches, beforeRouteDrift, "a changed model route or price requires fresh consent before sending");

    mode = "429-second";
    dispatches = 0;
    const partial = await preparePersonalKnowledgeVision({ actor: owner, providerId: platformProvider.id, buffer: image, mimeType: "image/png", segments: visualSegments, db });
    await assert.rejects(() => extractPersonalKnowledgeVision({ actor: owner, attemptId: partial.attemptId, buffer: image, mimeType: "image/png", segments: visualSegments, db }), { code: "PERSONAL_KNOWLEDGE_VISION_FAILED" });
    const partialReservations = await db.platformTokenReservation.findMany({ where: { userId: ownerId, personalKnowledgeExtractionAttemptId: partial.attemptId }, orderBy: { personalKnowledgeExtractionPageIndex: "asc" } });
    assert.deepEqual(partialReservations.map((row) => row.status), ["settled", "held"]);
    assert.equal((await db.personalKnowledgeExtractionAttempt.findUniqueOrThrow({ where: { id: partial.attemptId } })).status, "unknown");

    mode = "missing-usage";
    dispatches = 0;
    const unmetered = await preparePersonalKnowledgeVision({ actor: owner, providerId: platformProvider.id, buffer: image, mimeType: "image/png", segments: visualSegments.slice(0, 1), db });
    await assert.rejects(() => extractPersonalKnowledgeVision({ actor: owner, attemptId: unmetered.attemptId, buffer: image, mimeType: "image/png", segments: visualSegments.slice(0, 1), db }), { code: "AI_PLATFORM_TOKEN_USAGE_UNVERIFIED" });
    const unmeteredReservation = await db.platformTokenReservation.findUniqueOrThrow({ where: { userId_callKey: { userId: ownerId, callKey: `personal-vision:${unmetered.attemptId}:1` } } });
    assert.equal(unmeteredReservation.status, "held", "a response without validated usage retains the reservation");

    mode = "success";
    const forgedAttempt = await preparePersonalKnowledgeVision({ actor: owner, providerId: platformProvider.id, buffer: image, mimeType: "image/png", segments: visualSegments.slice(0, 1), db });
    const forgedSnapshot = await consumePersonalExtraction({ actor: owner, attemptId: forgedAttempt.attemptId, source: {
      operation: "vision", input: image,
      pageManifestHash: visionPageManifestHash(visualSegments.slice(0, 1)),
      visionPageManifest: visualSegments.slice(0, 1).map(({ ordinal, pageNumber, locatorLabel }) => ({ ordinal, pageNumber, locatorLabel })),
    }, db });
    const route = forgedSnapshot.provider.billingMode === "platform" ? forgedSnapshot.provider.billingRoute : undefined;
    assert.ok(route);
    await assert.rejects(() => db.personalKnowledgeExtractionAttempt.update({
      where: { id: forgedAttempt.attemptId },
      data: { platformMaxOutputTokens: 1, visionMaxOutputTokens: 1 },
    }), "consumed output-cap evidence is immutable");
    const beforeForgery = await db.platformTokenReservation.count({ where: { userId: ownerId, personalKnowledgeExtractionAttemptId: forgedAttempt.attemptId } });
    await assert.rejects(() => reservePlatformTokens({
      userId: strangerId, providerConnectionId: platformProvider.id,
      callKey: `personal-vision:${forgedAttempt.attemptId}:1`, operation: "visionExtract",
      modelId: "gpt-4o-mini", rawEstimatedTokens: 100,
      routeSnapshot: route,
    }, db));
    await assert.rejects(() => reservePlatformTokens({
      userId: ownerId, providerConnectionId: platformProvider.id,
      callKey: `personal-vision:${forgedAttempt.attemptId}:2`, operation: "visionExtract",
      modelId: "gpt-4o-mini", rawEstimatedTokens: 100,
      routeSnapshot: route,
    }, db));
    assert.equal(await db.platformTokenReservation.count({ where: { userId: ownerId, personalKnowledgeExtractionAttemptId: forgedAttempt.attemptId } }), beforeForgery);
    await finalizePersonalExtraction({ actor: owner, attemptId: forgedAttempt.attemptId, status: "failed", safeErrorCode: "TEST_NO_DISPATCH", db });

    const recovery = await preparePersonalKnowledgeVision({ actor: owner, providerId: platformProvider.id, buffer: image, mimeType: "image/png", segments: visualSegments.slice(0, 1), db });
    const recoverySnapshot = await consumePersonalExtraction({ actor: owner, attemptId: recovery.attemptId, source: {
      operation: "vision", input: image,
      pageManifestHash: visionPageManifestHash(visualSegments.slice(0, 1)),
      visionPageManifest: visualSegments.slice(0, 1).map(({ ordinal, pageNumber, locatorLabel }) => ({ ordinal, pageNumber, locatorLabel })),
    }, db });
    const recoveryRoute = recoverySnapshot.provider.billingMode === "platform" ? recoverySnapshot.provider.billingRoute : undefined;
    assert.ok(recoveryRoute);
    await reservePlatformTokens({ userId: ownerId, providerConnectionId: platformProvider.id,
      callKey: `personal-vision:${recovery.attemptId}:1`, operation: "visionExtract", modelId: "gpt-4o-mini",
      rawEstimatedTokens: 100, routeSnapshot: recoveryRoute,
    }, db);
    await fixtureDb.platformTokenReservation.update({
      where: { userId_callKey: { userId: ownerId, callKey: `personal-vision:${recovery.attemptId}:1` } },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const recovered = await recoverExpiredPlatformTokenReservations({ userId: ownerId, now: new Date() }, db);
    assert.equal(recovered.held, 1);
    assert.equal(recovered.released, 0, "a personal visual reservation is possible dispatch evidence and cannot be refunded after a crash");
    assert.equal((await db.platformTokenReservation.findUniqueOrThrow({ where: { userId_callKey: { userId: ownerId, callKey: `personal-vision:${recovery.attemptId}:1` } } })).status, "held");
    await finalizePersonalExtraction({ actor: owner, attemptId: recovery.attemptId, status: "unknown", safeErrorCode: "AI_PROVIDER_CALL_RECONCILIATION_REQUIRED", db });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
