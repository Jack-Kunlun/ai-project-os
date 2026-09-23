import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getProviderDefinition } from "../src/lib/ai-providers/registry";
import { createCredential } from "../src/lib/credential-vault";
import { getDb } from "../src/lib/db";
import { rotateCredential } from "../src/lib/credential-vault";
import { executeAccountAccess, previewAccountAccess } from "../src/lib/account-access-service";
import {
  executePersonalKnowledgeQa,
  PersonalKnowledgeQaError,
  preparePersonalKnowledgeQa,
} from "../src/lib/personal-knowledge-qa-service";
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
