import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { ApiError } from "@/lib/api-errors";
import { getProviderDefinition } from "@/lib/ai-providers/registry";
import { getDb } from "@/lib/db";
import {
  consumePersonalExtraction,
  finalizePersonalExtraction,
  personalExtractionDispatchValid,
  preparePersonalExtraction,
  visionPageManifestHash,
} from "@/lib/personal-knowledge-extraction-consent";
import { createPersonalKnowledgeDocument, revisePersonalKnowledgeDocument } from "@/lib/personal-knowledge-service";

const enabled = process.env.PERSONAL_KNOWLEDGE_EXTRACTION_POSTGRES_GATE === "1";
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const apiCode = (error: unknown, code: string) => error instanceof ApiError && error.code === code;

test("personal extraction confirmation is owner, source, provider and epoch bound, one-use and audited", {
  skip: !enabled ? "PERSONAL_KNOWLEDGE_EXTRACTION_POSTGRES_GATE=1 is required" : false,
}, async () => {
  const db = getDb();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const ownerId = randomUUID();
  const strangerId = randomUUID();
  const owner = { id: ownerId, role: "user" as const, accountAccessVersion: 1 };
  const stranger = { id: strangerId, role: "user" as const, accountAccessVersion: 1 };
  const raw = Buffer.from("private-image-bytes", "utf8");
  const source = { operation: "vision" as const, input: raw, pageManifestHash: visionPageManifestHash([{ ordinal: 0, pageNumber: 1, locatorLabel: "第 1 页", requiresVision: true }]) };
  const changed = { ...source, input: Buffer.from("different-image-bytes", "utf8") };
  const fingerprint = "a".repeat(64);
  await db.appUser.createMany({ data: [
    { id: ownerId, username: `extraction_owner_${suffix}`, role: "user" },
    { id: strangerId, username: `extraction_stranger_${suffix}`, role: "user" },
  ] });
  const credential = await db.externalCredential.create({ data: {
    kind: "aiProvider", ciphertext: Buffer.from("test"), nonce: Buffer.alloc(12), authTag: Buffer.alloc(16),
    maskedSuffix: "test", secretFingerprint: fingerprint,
  } });
  const provider = await db.aiProviderConnection.create({ data: {
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
  const changedManifest = { ...source, pageManifestHash: visionPageManifestHash([{ ordinal: 0, pageNumber: 2, locatorLabel: "第 2 页", requiresVision: true }]) };
  await assert.rejects(() => consumePersonalExtraction({ actor: owner, attemptId: prepared.attemptId, source: changedManifest, db }), (error) => apiCode(error, "PERSONAL_EXTRACTION_CONFIRMATION_STALE"));
  const expired = await db.personalKnowledgeExtractionAttempt.create({ data: {
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
  const snapshot = first.status === "fulfilled" ? first.value : second.status === "fulfilled" ? second.value : null;
  assert.ok(snapshot);
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
  await db.aiProviderConnection.update({ where: { id: provider.id }, data: { configurationVersion: { increment: 1 } } });
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
});
