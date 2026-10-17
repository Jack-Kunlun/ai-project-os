import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { activateCanonicalSignupGrant } from "./account-entitlement-test-helper";
import { createVerifiedProviderFixture } from "./platform-provider-fixture";
import { createBootstrapSignupOfferPolicy } from "../src/lib/platform-grant-offer-policy-service";
import { applyPlatformAiOperation, probePlatformAiOperation } from "../src/lib/platform-ai-operation-service";
import { recoverExpiredPlatformTokenReservations, reservePlatformTokens } from "../src/lib/ai-entitlements";
import { getProviderDefinition } from "../src/lib/ai-providers/registry";
import { createCredential } from "../src/lib/credential-vault";
import { getDb } from "../src/lib/db";
import { rotateCredential } from "../src/lib/credential-vault";
import { executeAccountAccess, previewAccountAccess } from "../src/lib/account-access-service";
import {
  executePersonalKnowledgeQa,
  listPersonalKnowledgeQaProviders,
  PersonalKnowledgeQaError,
  preparePersonalKnowledgeQa,
} from "../src/lib/personal-knowledge-qa-service";
import { readPersonalKnowledgeQaPlatformProvider } from "../src/lib/personal-knowledge-qa-provider";
import { createPersonalKnowledgeDocument, revisePersonalKnowledgeDocument } from "../src/lib/personal-knowledge-service";
import { personalKnowledgeQaQuestionHash } from "../src/lib/personal-knowledge-qa-contract";

const shouldRun = process.env.PERSONAL_KNOWLEDGE_QA_POSTGRES_GATE === "1";

function serviceCode(error: unknown): string | null {
  return error instanceof PersonalKnowledgeQaError ? error.code : null;
}

type Deferred = Readonly<{ promise: Promise<void>; resolve: () => void }>;
type TransactionCallback = (tx: Prisma.TransactionClient) => Promise<unknown>;
type TransactionOptions = Readonly<{
  isolationLevel?: Prisma.TransactionIsolationLevel;
  maxWait?: number;
  timeout?: number;
}>;

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return Object.freeze({ promise, resolve });
}

/** Pause exactly once after the admission transaction has committed. */
function pauseAfterAdmission(db: PrismaClient, admissionReady: Deferred, resume: Deferred): PrismaClient {
  let paused = false;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return ((callback: TransactionCallback, options?: TransactionOptions) => target.$transaction(
        async (tx) => callback(tx),
        options,
      ).then(async (result) => {
        if (paused) return result;
        paused = true;
        admissionReady.resolve();
        await resume.promise;
        return result;
      })) as PrismaClient["$transaction"];
    },
  }) as unknown as PrismaClient;
}

/** Keep a real writer transaction open after its mutation, before commit. */
function holdTransactionAfterWork(db: PrismaClient, writerReady: Deferred, release: Deferred): PrismaClient {
  let held = false;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return ((callback: TransactionCallback, options?: TransactionOptions) => target.$transaction(
        async (tx) => {
          try {
            const result = await callback(tx);
            if (!held) {
              held = true;
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
      )) as PrismaClient["$transaction"];
    },
  }) as unknown as PrismaClient;
}

async function waitForActorAdvisoryLockWait(db: PrismaClient): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const rows = await db.$queryRaw<Array<{ waiting: number }>>(Prisma.sql`
      SELECT count(*)::integer AS waiting
        FROM pg_locks locks
        JOIN pg_stat_activity activity ON activity.pid = locks.pid
       WHERE locks.locktype = 'advisory'
         AND locks.granted = false
         AND locks.pid <> pg_backend_pid()
         AND activity.datname = current_database()
    `);
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("PERSONAL_KNOWLEDGE_QA_ACTOR_FENCE_WAIT_NOT_OBSERVED");
}

test(
  "personal page QA prepares owner scoped evidence, consumes once, and audits metadata without bodies",
  { skip: !shouldRun ? "PERSONAL_KNOWLEDGE_QA_POSTGRES_GATE=1 is required" : false },
  async () => {
    if (typeof process.env.DATABASE_URL !== "string" || process.env.DATABASE_URL.length === 0) {
      throw new Error("PERSONAL_KNOWLEDGE_QA_POSTGRES_DATABASE_URL_REQUIRED");
    }
    const db = getDb();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const ownerId = randomUUID();
    const otherOwnerId = randomUUID();
    const owner = { id: ownerId, role: "user" as const, accountAccessVersion: 1 };
    const otherOwner = { id: otherOwnerId, role: "user" as const, accountAccessVersion: 1 };
    let fetchCount = 0;
    const originalFetch = globalThis.fetch;

    try {
      await db.appUser.createMany({
        data: [
          { id: ownerId, username: `personal_qa_owner_${suffix}`, role: "user" },
          { id: otherOwnerId, username: `personal_qa_other_${suffix}`, role: "user" },
        ],
      });
      const page = await createPersonalKnowledgeDocument(
        { title: "发布检查", content: "发布前检查包括确认回滚方案、检查迁移状态，并记录审批人。" },
        owner,
        db,
      );
      const otherPage = await createPersonalKnowledgeDocument(
        { title: "其他用户页面", content: "回滚方案只属于另一个用户。" },
        otherOwner,
        db,
      );
      const credential = await createCredential("aiProvider", "qa-test-secret-123456", db);
      const provider = await db.aiProviderConnection.create({
        data: {
          name: "QA personal provider",
          kind: "openai",
          scope: "user",
          ownerUserId: ownerId,
          protocol: "chatCompletions",
          baseUrl: getProviderDefinition("openai").baseUrl,
          credentialId: credential.id,
          defaultGenerationModelId: "gpt-test",
          ownerAccountAccessVersion: 1,
          status: "verified",
          lastTestedAt: new Date(),
        },
      });

      const firstClientKey = randomUUID();
      const confirmation = await preparePersonalKnowledgeQa(
        page.id,
        { question: "发布前检查包括什么？", clientKey: firstClientKey, providerId: provider.id },
        owner,
        db,
      );
      assert.equal(confirmation.safeSummary.provider, provider.name);
      assert.equal(confirmation.safeSummary.model, "gpt-test");
      assert.equal(confirmation.providerId, provider.id);
      const challenge = await db.personalKnowledgeQaChallenge.findUniqueOrThrow({
        where: { id: confirmation.challengeId },
        select: { questionHash: true, evidenceManifest: true, status: true },
      });
      assert.notEqual(challenge.questionHash, personalKnowledgeQaQuestionHash("发布前检查包括什么？"));
      assert.equal(challenge.status, "issued");
      assert.ok(Array.isArray(challenge.evidenceManifest));
      assert.deepEqual(Object.keys((challenge.evidenceManifest as Array<Record<string, unknown>>)[0] ?? {}).sort(), [
        "byteCount", "citationKey", "contentHash", "documentId", "excerptHash", "rangeEnd", "rangeStart", "revisionId", "version",
      ]);

      await assert.rejects(
        () => executePersonalKnowledgeQa(
          page.id,
          { phase: "execute", challengeId: confirmation.challengeId, question: "发布前检查包括什么？", clientKey: firstClientKey, providerId: randomUUID() },
          owner,
          db,
        ),
        (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_QA_CONFIRMATION_STALE",
      );

      await assert.rejects(
        () => preparePersonalKnowledgeQa(
          otherPage.id,
          { question: "回滚方案是什么？", clientKey: randomUUID(), providerId: provider.id },
          otherOwner,
          db,
        ),
        (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_QA_PROVIDER_NOT_FOUND",
      );
      const noEvidencePage = await createPersonalKnowledgeDocument(
        { title: "无匹配页面", content: "这里没有发布流程关键词。" },
        owner,
        db,
      );
      await assert.rejects(
        () => preparePersonalKnowledgeQa(
          noEvidencePage.id,
          { question: "数据库迁移？", clientKey: randomUUID(), providerId: provider.id },
          owner,
          db,
        ),
        (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_QA_NO_EVIDENCE",
      );

      globalThis.fetch = async () => {
        fetchCount += 1;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ answer: "先确认回滚方案，再检查迁移状态。", citations: ["p1"] }) } }],
          usage: { prompt_tokens: 21, completion_tokens: 13 },
        }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "qa-test-request" } });
      };
      const answer = await executePersonalKnowledgeQa(
        page.id,
        { phase: "execute", challengeId: confirmation.challengeId, question: "发布前检查包括什么？", clientKey: "wrong-key", providerId: provider.id },
        owner,
        db,
      ).catch((error: unknown) => {
        // The first attempt intentionally proves that the client key is bound to
        // the challenge before any provider request can be dispatched.
        assert.equal(serviceCode(error), "PERSONAL_KNOWLEDGE_QA_CONFIRMATION_REQUIRED");
        return null;
      });
      assert.equal(answer, null);
      assert.equal(fetchCount, 0);

      // Prepare a fresh challenge with the real client key so the successful
      // path can be exercised without ever putting the key in persisted rows.
      const clientKey = randomUUID();
      const secondConfirmation = await preparePersonalKnowledgeQa(
        page.id,
        { question: "发布前检查包括什么？", clientKey, providerId: provider.id },
        owner,
        db,
      );
      const successful = await executePersonalKnowledgeQa(
        page.id,
        { phase: "execute", challengeId: secondConfirmation.challengeId, question: "发布前检查包括什么？", clientKey, providerId: provider.id },
        owner,
        db,
      );
      assert.equal(successful.answer, "先确认回滚方案，再检查迁移状态。");
      assert.deepEqual(successful.citations.map((citation) => citation.citationKey), ["p1"]);
      assert.equal(fetchCount, 1);

      const audit = await db.personalKnowledgeQaAudit.findFirstOrThrow({
        where: { challengeId: secondConfirmation.challengeId },
        select: { status: true, evidenceManifest: true, safeErrorCode: true, providerRequestId: true },
      });
      assert.equal(audit.status, "succeeded");
      assert.equal(audit.safeErrorCode, null);
      assert.equal(audit.providerRequestId, "qa-test-request");
      assert.ok(Array.isArray(audit.evidenceManifest));
      assert.equal(JSON.stringify(audit.evidenceManifest).includes("先确认回滚方案"), false);
      const consumed = await db.personalKnowledgeQaChallenge.findUniqueOrThrow({ where: { id: secondConfirmation.challengeId }, select: { status: true, consumedAt: true } });
      assert.equal(consumed.status, "consumed");
      assert.ok(consumed.consumedAt);

      await assert.rejects(
        () => executePersonalKnowledgeQa(
          page.id,
          { phase: "execute", challengeId: secondConfirmation.challengeId, question: "发布前检查包括什么？", clientKey, providerId: provider.id },
          owner,
          db,
        ),
        (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_QA_CONFIRMATION_CONSUMED",
      );
      assert.equal(fetchCount, 1);

      const revisionClientKey = randomUUID();
      const revisionConfirmation = await preparePersonalKnowledgeQa(
        page.id,
        { question: "发布前检查包括什么？", clientKey: revisionClientKey, providerId: provider.id },
        owner,
        db,
      );
      await revisePersonalKnowledgeDocument(
        page.id,
        { expectedVersion: 1, content: "发布前检查包括确认回滚方案、检查迁移状态，并记录新的审批人。" },
        owner,
        db,
      );
      await assert.rejects(
        () => executePersonalKnowledgeQa(
          page.id,
          { phase: "execute", challengeId: revisionConfirmation.challengeId, question: "发布前检查包括什么？", clientKey: revisionClientKey },
          owner,
          db,
        ),
        (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_QA_CONFIRMATION_STALE",
      );
      assert.equal(fetchCount, 1);

      const credentialClientKey = randomUUID();
      const credentialConfirmation = await preparePersonalKnowledgeQa(
        page.id,
        { question: "发布前检查包括什么？", clientKey: credentialClientKey, providerId: provider.id },
        owner,
        db,
      );
      await rotateCredential(provider.credentialId, "aiProvider", "qa-test-rotated-secret-123456", db);
      await assert.rejects(
        () => executePersonalKnowledgeQa(
          page.id,
          { phase: "execute", challengeId: credentialConfirmation.challengeId, question: "发布前检查包括什么？", clientKey: credentialClientKey },
          owner,
          db,
        ),
        (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_QA_CONFIRMATION_STALE",
      );
      assert.equal(fetchCount, 1);

      const invalidCitationKey = randomUUID();
      const invalidCitationConfirmation = await preparePersonalKnowledgeQa(
        page.id,
        { question: "发布前检查包括什么？", clientKey: invalidCitationKey, providerId: provider.id },
        owner,
        db,
      );
      globalThis.fetch = async () => {
        fetchCount += 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: "无效引用", citations: ["p8"] }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
      };
      await assert.rejects(
        () => executePersonalKnowledgeQa(
          page.id,
          { phase: "execute", challengeId: invalidCitationConfirmation.challengeId, question: "发布前检查包括什么？", clientKey: invalidCitationKey },
          owner,
          db,
        ),
        (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_QA_INVALID_CITATION",
      );
      assert.equal(fetchCount, 2);

      const adminId = randomUUID();
      await db.appUser.create({ data: { id: adminId, username: `personal_qa_admin_${suffix}`, role: "admin" } });
      const accessPreview = await previewAccountAccess({
        adminUserId: adminId,
        adminAccountAccessVersion: 1,
        userId: ownerId,
        action: "disable",
        reason: "QA account epoch fence",
        expectedVersion: 1,
      }, db);
      const accountClientKey = randomUUID();
      const accountConfirmation = await preparePersonalKnowledgeQa(
        page.id,
        { question: "发布前检查包括什么？", clientKey: accountClientKey, providerId: provider.id },
        owner,
        db,
      );
      await executeAccountAccess({
        adminUserId: adminId,
        adminAccountAccessVersion: 1,
        userId: ownerId,
        action: "disable",
        reason: "QA account epoch fence",
        expectedVersion: accessPreview.current.accountAccessVersion,
        expectedImpactFingerprint: accessPreview.impactFingerprint,
        requestKey: randomUUID(),
        requestFingerprint: accessPreview.requestFingerprint,
        previewId: accessPreview.previewId,
        previewIssuedAt: accessPreview.issuedAt,
        previewExpiresAt: accessPreview.expiresAt,
        confirmation: true,
        confirmationUsername: `personal_qa_owner_${suffix}`,
      }, db);
      await assert.rejects(
        () => executePersonalKnowledgeQa(
          page.id,
          { phase: "execute", challengeId: accountConfirmation.challengeId, question: "发布前检查包括什么？", clientKey: accountClientKey },
          owner,
          db,
        ),
        (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_QA_ACCOUNT_DISABLED",
      );
      assert.equal(fetchCount, 2);

      await assert.rejects(
        () => db.personalKnowledgeQaChallenge.delete({ where: { id: secondConfirmation.challengeId } }),
        (error: unknown) => error instanceof Error,
      );
      await assert.rejects(
        () => db.personalKnowledgeQaAudit.updateMany({ where: { challengeId: secondConfirmation.challengeId }, data: { status: "failed" } }),
        (error: unknown) => error instanceof Error,
      );
      await assert.rejects(
        () => db.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.personal_knowledge_qa_mutation_context', 'service-v1', true)`;
          return tx.personalKnowledgeQaAudit.updateMany({ where: { challengeId: secondConfirmation.challengeId }, data: { status: "failed", completedAt: new Date() } });
        }),
        (error: unknown) => error instanceof Error,
      );
    } finally {
      globalThis.fetch = originalFetch;
      // QA challenge and audit rows are intentionally append-only. The isolated
      // gate database is disposable, so fixture rows are left for the teardown.
    }
  },
);

test(
  "personal page QA uses the default platform route and accounts for every dispatch outcome",
  { skip: !shouldRun ? "PERSONAL_KNOWLEDGE_QA_POSTGRES_GATE=1 is required" : false },
  async () => {
    if (typeof process.env.DATABASE_URL !== "string" || process.env.DATABASE_URL.length === 0) {
      throw new Error("PERSONAL_KNOWLEDGE_QA_POSTGRES_DATABASE_URL_REQUIRED");
    }
    const db = getDb();
    const fixtureDb = process.env.MIGRATOR_DATABASE_URL
      ? new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.MIGRATOR_DATABASE_URL }) })
      : db;
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const admin = { id: randomUUID(), role: "admin" as const, accountAccessVersion: 1 };
    const owner = { id: randomUUID(), role: "user" as const, accountAccessVersion: 1 };
    const otherOwner = { id: randomUUID(), role: "user" as const, accountAccessVersion: 1 };
    const originalFetch = globalThis.fetch;
    let requests = 0;
    const pageText = "发布前检查包括确认回滚方案、检查迁移状态，并记录审批人。";

    try {
      await fixtureDb.appUser.createMany({ data: [
        { ...admin, username: `platform_qa_admin_${suffix}` },
        { ...owner, username: `platform_qa_owner_${suffix}` },
        { ...otherOwner, username: `platform_qa_other_${suffix}` },
      ] });
      if (await fixtureDb.platformGrantOfferPolicy.count() === 0) {
        await fixtureDb.$transaction((tx) => createBootstrapSignupOfferPolicy(tx, admin.id));
      }
      const provider = await createVerifiedProviderFixture({
        name: "Personal page QA platform fixture",
        kind: "openai",
        apiKey: "synthetic-personal-qa-platform-key",
        generationModelId: "gpt-4.1-mini",
        visionModelId: null,
        embeddingModelId: null,
        embeddingDimensions: null,
      }, admin, fixtureDb);
      async function configure(multiplier: number) {
        const input = {
          clientRequestKey: randomUUID(),
          providerConnectionId: provider.id,
          operation: "generateWithContext" as const,
          modelId: "gpt-4.1-mini",
          maxOutputTokens: 256,
          quotaMultiplierBps: multiplier,
        };
        const previousFetch = globalThis.fetch;
        globalThis.fetch = async () => Response.json({ choices: [{ message: { content: "OK" } }] });
        try {
          const proof = await probePlatformAiOperation(input, admin, fixtureDb);
          assert.ok(proof.probeId, "the platform default route must pass a live validation probe");
          await applyPlatformAiOperation({ ...input, probeId: proof.probeId }, admin, fixtureDb);
        } finally {
          globalThis.fetch = previousFetch;
        }
      }
      await configure(20_000);
      const page = await createPersonalKnowledgeDocument({ title: "发布检查", content: pageText }, owner, db);
      const otherPage = await createPersonalKnowledgeDocument({ title: "其他用户页面", content: pageText }, otherOwner, db);
      const choices = await listPersonalKnowledgeQaProviders(owner, db);
      assert.equal(choices.platformRouteAvailable, true);
      assert.equal(choices.providers[0]?.id, provider.id);
      assert.equal(choices.providers[0]?.billingMode, "platform");
      assert.equal(choices.providers[0]?.isDefault, true);
      assert.doesNotMatch(JSON.stringify(choices), /synthetic-personal-qa-platform-key|secretFingerprint|credentialId/u);
      await assert.rejects(
        () => preparePersonalKnowledgeQa(otherPage.id, { question: "发布前检查包括什么？", clientKey: randomUUID() }, owner, db),
        (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_QA_DOCUMENT_NOT_FOUND",
      );

      let mode: "known" | "missing-usage" | "over-reserve" | "invalid-citation" | "truncated" | "unknown" | "waiting" = "known";
      let providerCallStarted: Deferred | null = null;
      let releaseProviderCall: Deferred | null = null;
      globalThis.fetch = async (_input, init) => {
        requests += 1;
        const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: string }> };
        assert.ok(Array.isArray(body.messages));
        if (mode === "unknown") throw new Error("synthetic network loss after dispatch");
        if (mode === "waiting") {
          assert.ok(providerCallStarted && releaseProviderCall);
          providerCallStarted.resolve();
          await releaseProviderCall.promise;
        }
        return Response.json({
          choices: [{ message: { content: JSON.stringify({
            answer: mode === "invalid-citation" ? "错误引用" : "先确认回滚方案，再检查迁移状态。",
            citations: [mode === "invalid-citation" ? "p8" : "p1"],
          }) }, ...(mode === "truncated" ? { finish_reason: "length" } : {}) }],
          ...(mode === "missing-usage" ? {} : { usage: mode === "over-reserve"
            ? { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }
            : { prompt_tokens: 21, completion_tokens: 13 } }),
        }, { headers: { "x-request-id": "personal-qa-platform-test" } });
      };
      const unconfiguredQuestion = { question: "发布前检查包括什么？", clientKey: randomUUID() };
      const noCreditConfirmation = await preparePersonalKnowledgeQa(page.id, unconfiguredQuestion, owner, db);
      assert.equal(noCreditConfirmation.safeSummary.billingMode, "platform");
      assert.equal(noCreditConfirmation.safeSummary.quotaMultiplierBps, 20_000);
      assert.equal(requests, 0, "prepare does not dispatch");
      await assert.rejects(
        () => executePersonalKnowledgeQa(page.id, {
          phase: "execute", challengeId: noCreditConfirmation.challengeId,
          question: unconfiguredQuestion.question, clientKey: unconfiguredQuestion.clientKey,
        }, owner, db),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error
          && (error as { code?: unknown }).code === "AI_PLATFORM_TOKEN_EXHAUSTED",
      );
      assert.equal(requests, 0, "insufficient platform credits cannot send the page to a provider");
      await activateCanonicalSignupGrant(fixtureDb, { userId: owner.id, actorId: owner.id });

      const successfulQuestion = { question: "发布前检查包括什么？", clientKey: randomUUID() };
      const successConfirmation = await preparePersonalKnowledgeQa(page.id, successfulQuestion, owner, db);
      const answer = await executePersonalKnowledgeQa(page.id, {
        phase: "execute", challengeId: successConfirmation.challengeId,
        question: successfulQuestion.question, clientKey: successfulQuestion.clientKey,
      }, owner, db);
      assert.match(answer.answer, /回滚方案/u);
      assert.deepEqual(answer.citations.map((citation) => citation.citationKey), ["p1"]);
      const successReservation = await db.platformTokenReservation.findUniqueOrThrow({
        where: { userId_callKey: { userId: owner.id, callKey: `personal-qa:${successConfirmation.challengeId}` } },
      });
      assert.equal(successReservation.personalKnowledgeQaChallengeId, successConfirmation.challengeId);
      assert.equal(successReservation.webAiGrantId, null);
      assert.equal(successReservation.webAiGrantProjectId, null);
      assert.equal(successReservation.operation, "generateWithContext");
      assert.equal(successReservation.status, "settled");
      assert.equal(successReservation.rawSettledTokens, 34);
      assert.equal(successReservation.settledTokens, 68);
      assert.equal(successReservation.quotaMultiplierBps, 20_000);
      assert.equal(requests, 1);

      mode = "invalid-citation";
      const knownFailure = { question: "发布前检查包括什么？", clientKey: randomUUID() };
      const knownFailureConfirmation = await preparePersonalKnowledgeQa(page.id, knownFailure, owner, db);
      await assert.rejects(() => executePersonalKnowledgeQa(page.id, {
        phase: "execute", challengeId: knownFailureConfirmation.challengeId,
        question: knownFailure.question, clientKey: knownFailure.clientKey,
      }, owner, db), (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_QA_INVALID_CITATION");
      const knownFailureReservation = await db.platformTokenReservation.findUniqueOrThrow({
        where: { userId_callKey: { userId: owner.id, callKey: `personal-qa:${knownFailureConfirmation.challengeId}` } },
      });
      const knownFailureAudit = await db.personalKnowledgeQaAudit.findUniqueOrThrow({
        where: { challengeId: knownFailureConfirmation.challengeId }, select: { status: true, safeErrorCode: true, completedAt: true },
      });
      assert.equal(knownFailureReservation.status, "settled");
      assert.equal(knownFailureReservation.rawSettledTokens, 34);
      assert.equal(knownFailureAudit.status, "failed", "known provider usage with invalid output is a completed failure, not an unresolved dispatch");
      assert.equal(knownFailureAudit.safeErrorCode, "PERSONAL_KNOWLEDGE_QA_INVALID_CITATION");
      assert.ok(knownFailureAudit.completedAt instanceof Date);

      mode = "truncated";
      const truncated = { question: "发布前检查包括什么？", clientKey: randomUUID() };
      const truncatedConfirmation = await preparePersonalKnowledgeQa(page.id, truncated, owner, db);
      await assert.rejects(() => executePersonalKnowledgeQa(page.id, {
        phase: "execute", challengeId: truncatedConfirmation.challengeId,
        question: truncated.question, clientKey: truncated.clientKey,
      }, owner, db), (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_QA_OUTPUT_TRUNCATED");
      const truncatedReservation = await db.platformTokenReservation.findUniqueOrThrow({
        where: { userId_callKey: { userId: owner.id, callKey: `personal-qa:${truncatedConfirmation.challengeId}` } },
      });
      const truncatedAudit = await db.personalKnowledgeQaAudit.findUniqueOrThrow({
        where: { challengeId: truncatedConfirmation.challengeId }, select: { status: true, safeErrorCode: true },
      });
      assert.equal(truncatedReservation.status, "settled", "known usage is charged even when the answer was truncated");
      assert.equal(truncatedAudit.status, "failed");
      assert.equal(truncatedAudit.safeErrorCode, "PERSONAL_KNOWLEDGE_QA_OUTPUT_TRUNCATED");

      mode = "missing-usage";
      const missingUsage = { question: "发布前检查包括什么？", clientKey: randomUUID() };
      const missingUsageConfirmation = await preparePersonalKnowledgeQa(page.id, missingUsage, owner, db);
      const missingUsageAnswer = await executePersonalKnowledgeQa(page.id, {
        phase: "execute", challengeId: missingUsageConfirmation.challengeId,
        question: missingUsage.question, clientKey: missingUsage.clientKey,
      }, owner, db);
      const heldForUsage = await db.platformTokenReservation.findUniqueOrThrow({
        where: { userId_callKey: { userId: owner.id, callKey: `personal-qa:${missingUsageConfirmation.challengeId}` } },
      });
      const missingUsageAudit = await db.personalKnowledgeQaAudit.findUniqueOrThrow({
        where: { challengeId: missingUsageConfirmation.challengeId }, select: { status: true, completedAt: true, usageKnown: true },
      });
      assert.match(missingUsageAnswer.answer, /迁移状态/u, "validated answer content can be returned while its quota remains held");
      assert.equal(heldForUsage.status, "held");
      assert.equal(heldForUsage.reconciliationRequired, true);
      assert.equal(missingUsageAudit.status, "succeeded", "answer outcome is known even when provider usage is not");
      assert.equal(missingUsageAudit.usageKnown, false);
      assert.ok(missingUsageAudit.completedAt instanceof Date);

      mode = "over-reserve";
      const overReserve = { question: "发布前检查包括什么？", clientKey: randomUUID() };
      const overReserveConfirmation = await preparePersonalKnowledgeQa(page.id, overReserve, owner, db);
      const overReserveAnswer = await executePersonalKnowledgeQa(page.id, {
        phase: "execute", challengeId: overReserveConfirmation.challengeId,
        question: overReserve.question, clientKey: overReserve.clientKey,
      }, owner, db);
      const heldForOverReserve = await db.platformTokenReservation.findUniqueOrThrow({
        where: { userId_callKey: { userId: owner.id, callKey: `personal-qa:${overReserveConfirmation.challengeId}` } },
      });
      const overReserveAudit = await db.personalKnowledgeQaAudit.findUniqueOrThrow({
        where: { challengeId: overReserveConfirmation.challengeId }, select: { status: true, safeErrorCode: true, completedAt: true, usageKnown: true },
      });
      assert.match(overReserveAnswer.answer, /迁移状态/u, "validated answer can be returned when measured usage exceeds the reservation");
      assert.equal(heldForOverReserve.status, "held", "usage exceeding the reservation stays held for reconciliation");
      assert.equal(heldForOverReserve.reconciliationRequired, true);
      assert.equal(overReserveAudit.status, "succeeded");
      assert.equal(overReserveAudit.safeErrorCode, null);
      assert.equal(overReserveAudit.usageKnown, true);
      assert.ok(overReserveAudit.completedAt instanceof Date);

      mode = "unknown";
      const unknown = { question: "发布前检查包括什么？", clientKey: randomUUID() };
      const unknownConfirmation = await preparePersonalKnowledgeQa(page.id, unknown, owner, db);
      await assert.rejects(() => executePersonalKnowledgeQa(page.id, {
        phase: "execute", challengeId: unknownConfirmation.challengeId,
        question: unknown.question, clientKey: unknown.clientKey,
      }, owner, db), (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_QA_PROVIDER_UNCERTAIN");
      const unknownReservation = await db.platformTokenReservation.findUniqueOrThrow({
        where: { userId_callKey: { userId: owner.id, callKey: `personal-qa:${unknownConfirmation.challengeId}` } },
      });
      const unknownAudit = await db.personalKnowledgeQaAudit.findUniqueOrThrow({
        where: { challengeId: unknownConfirmation.challengeId }, select: { status: true, completedAt: true },
      });
      assert.equal(unknownReservation.status, "held", "an uncertain dispatched call keeps its quota held");
      assert.equal(unknownReservation.reconciliationRequired, true);
      assert.equal(unknownAudit.status, "unknown");
      assert.ok(unknownAudit.completedAt instanceof Date, "unknown outcome is terminal audit evidence once the request ends");

      mode = "known";
      const afterUnknown = { question: "发布前检查包括什么？", clientKey: randomUUID() };
      const afterUnknownConfirmation = await preparePersonalKnowledgeQa(page.id, afterUnknown, owner, db);
      const afterUnknownAnswer = await executePersonalKnowledgeQa(page.id, {
        phase: "execute", challengeId: afterUnknownConfirmation.challengeId,
        question: afterUnknown.question, clientKey: afterUnknown.clientKey,
      }, owner, db);
      assert.match(afterUnknownAnswer.answer, /迁移状态/u, "a terminal unknown QA audit holds quota without blocking later work");

      mode = "waiting";
      providerCallStarted = deferred();
      releaseProviderCall = deferred();
      const active = { question: "发布前检查包括什么？", clientKey: randomUUID() };
      const activeConfirmation = await preparePersonalKnowledgeQa(page.id, active, owner, db);
      const activeExecution = executePersonalKnowledgeQa(page.id, {
        phase: "execute", challengeId: activeConfirmation.challengeId,
        question: active.question, clientKey: active.clientKey,
      }, owner, db);
      await providerCallStarted.promise;
      const blocked = { question: "发布前检查包括什么？", clientKey: randomUUID() };
      const blockedConfirmation = await preparePersonalKnowledgeQa(page.id, blocked, owner, db);
      await assert.rejects(() => executePersonalKnowledgeQa(page.id, {
        phase: "execute", challengeId: blockedConfirmation.challengeId,
        question: blocked.question, clientKey: blocked.clientKey,
      }, owner, db), (error: unknown) => typeof error === "object" && error !== null && "code" in error
        && (error as { code?: unknown }).code === "AI_PLATFORM_CONCURRENCY_LIMIT");
      releaseProviderCall.resolve();
      const activeAnswer = await activeExecution;
      assert.match(activeAnswer.answer, /迁移状态/u, "an actually running QA request still occupies platform concurrency");
      mode = "known";

      const stale = { question: "发布前检查包括什么？", clientKey: randomUUID() };
      const staleConfirmation = await preparePersonalKnowledgeQa(page.id, stale, owner, db);
      await configure(10_000);
      const sentBeforeStale = requests;
      await assert.rejects(() => executePersonalKnowledgeQa(page.id, {
        phase: "execute", challengeId: staleConfirmation.challengeId,
        question: stale.question, clientKey: stale.clientKey,
      }, owner, db), (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_QA_CONFIRMATION_STALE");
      assert.equal(requests, sentBeforeStale, "route price changes invalidate confirmation before provider dispatch");
      assert.equal(await db.platformTokenReservation.count({ where: { callKey: `personal-qa:${staleConfirmation.challengeId}` } }), 0);

      const unconsumed = { question: "发布前检查包括什么？", clientKey: randomUUID() };
      const unconsumedConfirmation = await preparePersonalKnowledgeQa(page.id, unconsumed, owner, db);
      const otherOwnerConfirmation = await preparePersonalKnowledgeQa(
        otherPage.id, { question: "发布前检查包括什么？", clientKey: randomUUID() }, otherOwner, db,
      );
      const platform = await readPersonalKnowledgeQaPlatformProvider(db);
      assert.ok(platform?.billingRoute);
      const balanceBeforeForgery = await db.platformTokenGrant.aggregate({ where: { userId: owner.id }, _sum: { remainingTokens: true } });
      for (const challengeId of [unconsumedConfirmation.challengeId, otherOwnerConfirmation.challengeId]) {
        await assert.rejects(reservePlatformTokens({
        userId: owner.id,
        providerConnectionId: provider.id,
        callKey: `personal-qa:${challengeId}`,
        operation: "generateWithContext",
        modelId: "gpt-4.1-mini",
        rawEstimatedTokens: 100,
        routeSnapshot: platform.billingRoute,
        }, db));
      }
      assert.deepEqual(await db.platformTokenGrant.aggregate({ where: { userId: owner.id }, _sum: { remainingTokens: true } }), balanceBeforeForgery);

      const preDispatch = { question: "发布前检查包括什么？", clientKey: randomUUID() };
      const preDispatchConfirmation = await preparePersonalKnowledgeQa(page.id, preDispatch, owner, db);
      let routeChanged = false;
      const routeDriftDb = new Proxy(db, {
        get(target, property, receiver) {
          if (property !== "$transaction") return Reflect.get(target, property, receiver);
          return ((...args: unknown[]) => Reflect.apply(target.$transaction, target, args).then(async (value: unknown) => {
            if (!routeChanged && typeof value === "object" && value !== null && "reservationId" in value
              && (value as { created?: unknown }).created === true) {
              routeChanged = true;
              await configure(20_000);
            }
            return value;
          })) as PrismaClient["$transaction"];
        },
      }) as PrismaClient;
      const sendsBeforeRelease = requests;
      await assert.rejects(() => executePersonalKnowledgeQa(page.id, {
        phase: "execute", challengeId: preDispatchConfirmation.challengeId,
        question: preDispatch.question, clientKey: preDispatch.clientKey,
      }, owner, routeDriftDb), (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_QA_PROVIDER_UNAVAILABLE");
      assert.equal(routeChanged, true);
      assert.equal(requests, sendsBeforeRelease, "a route change after reserve but before dispatch must block the request");
      const released = await db.platformTokenReservation.findUniqueOrThrow({
        where: { userId_callKey: { userId: owner.id, callKey: `personal-qa:${preDispatchConfirmation.challengeId}` } },
      });
      assert.equal(released.status, "released");

      const crashQuestion = { question: "发布前检查包括什么？", clientKey: randomUUID() };
      const crashConfirmation = await preparePersonalKnowledgeQa(page.id, crashQuestion, owner, db);
      let interrupted = false;
      const crashDb = new Proxy(db, {
        get(target, property, receiver) {
          if (property !== "$transaction") return Reflect.get(target, property, receiver);
          return ((...args: unknown[]) => Reflect.apply(target.$transaction, target, args).then((value: unknown) => {
            if (!interrupted && typeof value === "object" && value !== null && "reservationId" in value
              && (value as { created?: unknown }).created === true) {
              interrupted = true;
              throw new Error("synthetic process interruption after reservation");
            }
            return value;
          })) as PrismaClient["$transaction"];
        },
      }) as PrismaClient;
      const sendsBeforeCrash = requests;
      await assert.rejects(() => executePersonalKnowledgeQa(page.id, {
        phase: "execute", challengeId: crashConfirmation.challengeId,
        question: crashQuestion.question, clientKey: crashQuestion.clientKey,
      }, owner, crashDb));
      assert.equal(requests, sendsBeforeCrash, "the simulated crash occurs before provider dispatch");
      const recovered = await recoverExpiredPlatformTokenReservations({ userId: owner.id, now: new Date(Date.now() + 3_600_001) }, db);
      assert.equal(recovered.held, 1);
      assert.equal(recovered.released, 0, "consumed QA consent is held for reconciliation after an interrupted transaction");
      const crashReservation = await db.platformTokenReservation.findUniqueOrThrow({
        where: { userId_callKey: { userId: owner.id, callKey: `personal-qa:${crashConfirmation.challengeId}` } },
      });
      assert.equal(crashReservation.personalKnowledgeQaChallengeId, crashConfirmation.challengeId);
      assert.equal(crashReservation.status, "held");
    } finally {
      globalThis.fetch = originalFetch;
      await db.$disconnect();
      if (fixtureDb !== db) await fixtureDb.$disconnect();
    }
  },
);

test(
  "personal page QA rejects writer-first revision and account disable races before provider dispatch",
  { skip: !shouldRun ? "PERSONAL_KNOWLEDGE_QA_POSTGRES_GATE=1 is required" : false },
  async () => {
    if (typeof process.env.DATABASE_URL !== "string" || process.env.DATABASE_URL.length === 0) {
      throw new Error("PERSONAL_KNOWLEDGE_QA_POSTGRES_DATABASE_URL_REQUIRED");
    }
    const db = getDb();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const ownerId = randomUUID();
    const adminId = randomUUID();
    const owner = { id: ownerId, role: "user" as const, accountAccessVersion: 1 };
    let fetchCount = 0;
    const originalFetch = globalThis.fetch;

    try {
      await db.appUser.createMany({
        data: [
          { id: ownerId, username: `personal_qa_race_owner_${suffix}`, role: "user" },
          { id: adminId, username: `personal_qa_race_admin_${suffix}`, role: "admin" },
        ],
      });
      const page = await createPersonalKnowledgeDocument(
        { title: "发布竞态检查", content: "发布前检查包括确认回滚方案、检查迁移状态，并记录初始审批人。" },
        owner,
        db,
      );
      const pageId = typeof page.id === "string" ? page.id : assert.fail("PERSONAL_KNOWLEDGE_QA_PAGE_ID_REQUIRED");
      const credential = await createCredential("aiProvider", "qa-race-secret-123456", db);
      const provider = await db.aiProviderConnection.create({
        data: {
          name: "QA race provider",
          kind: "openai",
          scope: "user",
          ownerUserId: ownerId,
          protocol: "chatCompletions",
          baseUrl: getProviderDefinition("openai").baseUrl,
          credentialId: credential.id,
          defaultGenerationModelId: "gpt-race",
          ownerAccountAccessVersion: 1,
          status: "verified",
          lastTestedAt: new Date(),
        },
      });
      globalThis.fetch = async () => {
        fetchCount += 1;
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ answer: "不应到达 provider", citations: ["p1"] }) } }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      };

      const revisionClientKey = randomUUID();
      const revisionConfirmation = await preparePersonalKnowledgeQa(
        page.id,
        { question: "发布前检查包括什么？", clientKey: revisionClientKey, providerId: provider.id },
        owner,
        db,
      );
      const revisionAdmissionReady = deferred();
      const revisionResume = deferred();
      const revisionExecution = executePersonalKnowledgeQa(
        page.id,
        { phase: "execute", challengeId: revisionConfirmation.challengeId, question: "发布前检查包括什么？", clientKey: revisionClientKey, providerId: provider.id },
        owner,
        pauseAfterAdmission(db, revisionAdmissionReady, revisionResume),
      );
      await revisionAdmissionReady.promise;

      const revisionWriterReady = deferred();
      const revisionRelease = deferred();
      const revisionWriter = revisePersonalKnowledgeDocument(
        page.id,
        { expectedVersion: 1, content: "发布前检查包括确认回滚方案、检查迁移状态，并记录并发修订人。" },
        owner,
        holdTransactionAfterWork(db, revisionWriterReady, revisionRelease),
      );
      try {
        await revisionWriterReady.promise;
        revisionResume.resolve();
        await waitForActorAdvisoryLockWait(db);
        revisionRelease.resolve();
        await revisionWriter;
        await assert.rejects(
          () => revisionExecution,
          (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_QA_PROVIDER_UNAVAILABLE",
        );
      } finally {
        revisionResume.resolve();
        revisionRelease.resolve();
        await Promise.allSettled([revisionWriter, revisionExecution]);
      }
      assert.equal(fetchCount, 0);
      const revisedPage = await db.personalKnowledgeDocument.findUniqueOrThrow({
        where: { id: pageId },
        select: { version: true, currentRevision: { select: { content: true } } },
      });
      assert.equal(revisedPage.version, 2);
      assert.equal(revisedPage.currentRevision?.content, "发布前检查包括确认回滚方案、检查迁移状态，并记录并发修订人。");
      const revisionAudit = await db.personalKnowledgeQaAudit.findUniqueOrThrow({
        where: { challengeId: revisionConfirmation.challengeId },
        select: { status: true, safeErrorCode: true, completedAt: true },
      });
      assert.equal(revisionAudit.status, "failed");
      assert.equal(revisionAudit.safeErrorCode, "AI_PROVIDER_UNAVAILABLE");
      assert.ok(revisionAudit.completedAt);

      const accessPreview = await previewAccountAccess({
        adminUserId: adminId,
        adminAccountAccessVersion: 1,
        userId: ownerId,
        action: "disable",
        reason: "QA writer-first disable race",
        expectedVersion: 1,
      }, db);
      const accountClientKey = randomUUID();
      const accountConfirmation = await preparePersonalKnowledgeQa(
        page.id,
        { question: "发布前检查包括什么？", clientKey: accountClientKey, providerId: provider.id },
        owner,
        db,
      );
      const accountAdmissionReady = deferred();
      const accountResume = deferred();
      const accountExecution = executePersonalKnowledgeQa(
        page.id,
        { phase: "execute", challengeId: accountConfirmation.challengeId, question: "发布前检查包括什么？", clientKey: accountClientKey, providerId: provider.id },
        owner,
        pauseAfterAdmission(db, accountAdmissionReady, accountResume),
      );
      await accountAdmissionReady.promise;

      const accountWriterReady = deferred();
      const accountRelease = deferred();
      const accountWriter = executeAccountAccess({
        adminUserId: adminId,
        adminAccountAccessVersion: 1,
        userId: ownerId,
        action: "disable",
        reason: "QA writer-first disable race",
        expectedVersion: accessPreview.current.accountAccessVersion,
        expectedImpactFingerprint: accessPreview.impactFingerprint,
        requestKey: randomUUID(),
        requestFingerprint: accessPreview.requestFingerprint,
        previewId: accessPreview.previewId,
        previewIssuedAt: accessPreview.issuedAt,
        previewExpiresAt: accessPreview.expiresAt,
        confirmation: true,
        confirmationUsername: `personal_qa_race_owner_${suffix}`,
      }, holdTransactionAfterWork(db, accountWriterReady, accountRelease));
      try {
        await accountWriterReady.promise;
        accountResume.resolve();
        await waitForActorAdvisoryLockWait(db);
        accountRelease.resolve();
        await accountWriter;
        await assert.rejects(
          () => accountExecution,
          (error: unknown) => serviceCode(error) === "PERSONAL_KNOWLEDGE_QA_PROVIDER_UNAVAILABLE",
        );
      } finally {
        accountResume.resolve();
        accountRelease.resolve();
        await Promise.allSettled([accountWriter, accountExecution]);
      }
      assert.equal(fetchCount, 0);
      const disabledOwner = await db.appUser.findUniqueOrThrow({ where: { id: ownerId }, select: { disabledAt: true, accountAccessVersion: true } });
      assert.ok(disabledOwner.disabledAt);
      assert.equal(disabledOwner.accountAccessVersion, 2);
      const accountAudit = await db.personalKnowledgeQaAudit.findUniqueOrThrow({
        where: { challengeId: accountConfirmation.challengeId },
        select: { status: true, safeErrorCode: true, completedAt: true },
      });
      assert.equal(accountAudit.status, "failed");
      assert.equal(accountAudit.safeErrorCode, "AI_PROVIDER_UNAVAILABLE");
      assert.ok(accountAudit.completedAt);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
