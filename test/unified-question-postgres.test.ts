import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { activateCanonicalSignupGrant } from "./account-entitlement-test-helper";
import { createVerifiedProviderFixture } from "./platform-provider-fixture";
import { createSecureMasterKeyFixture } from "./secure-master-key-fixture";
import { getDb } from "../src/lib/db";
import { grantProjectMembership, grantWorkspaceMembership, revokeProjectMembership } from "../src/lib/membership-governance";
import { createBootstrapSignupOfferPolicy } from "../src/lib/platform-grant-offer-policy-service";
import { readSystemOverviewAnalytics } from "../src/lib/system-overview";
import {
  activatePlatformDefaultAiRoute,
  createPlatformDefaultAiRoute,
  validatePlatformDefaultAiRoute,
} from "../src/lib/platform-default-ai-routes";
import { createPersonalKnowledgeDocument, revisePersonalKnowledgeDocument } from "../src/lib/personal-knowledge-service";
import {
  executeUnifiedQuestion,
  getUnifiedQuestionConversation,
  listUnifiedQuestionConversations,
  prepareUnifiedQuestion,
  UnifiedQuestionError,
} from "../src/lib/unified-question-service";

const shouldRun = process.env.UNIFIED_QUESTION_POSTGRES_GATE === "1";

function unifiedCode(error: unknown): string | null {
  return error instanceof UnifiedQuestionError ? error.code : null;
}

function totalAnalyticsValue(
  analytics: Awaited<ReturnType<typeof readSystemOverviewAnalytics>>,
  key: "platformTokens" | "unknownCalls",
): number {
  return analytics.trends.days30.reduce((total, row) => {
    const value = row[key];
    if (value === null) throw new Error(`30-day ${key} aggregate must be available; null is not a zero result`);
    return total + value;
  }, 0);
}

test("unified question migration installs guards and hides entire histories after source-project revocation", { skip: !shouldRun }, async () => {
  const db = getDb();
  try {
    const triggers = await db.$queryRaw<Array<{ triggerName: string }>>(Prisma.sql`
      SELECT t.tgname AS "triggerName"
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgname = ANY(${[
        "UnifiedQuestionConversation_head_guard",
        "UnifiedQuestionTurn_insert_guard",
        "UnifiedQuestionTurn_head_evidence_guard",
        "UnifiedQuestionTurn_immutable_guard",
        "UnifiedQuestionConfirmation_transition_guard",
        "UnifiedQuestionAudit_transition_guard",
        "PlatformTokenReservation_unified_question_guard",
        "PlatformTokenReservation_unified_runtime_evidence_guard",
      ]}::text[])
      ORDER BY t.tgname
    `);
    assert.deepEqual(triggers.map((row) => row.triggerName), [
      "PlatformTokenReservation_unified_question_guard",
      "PlatformTokenReservation_unified_runtime_evidence_guard",
      "UnifiedQuestionAudit_transition_guard",
      "UnifiedQuestionConfirmation_transition_guard",
      "UnifiedQuestionConversation_head_guard",
      "UnifiedQuestionTurn_head_evidence_guard",
      "UnifiedQuestionTurn_immutable_guard",
      "UnifiedQuestionTurn_insert_guard",
    ]);

    const reservationChecks = await db.$queryRaw<Array<{ definition: string }>>(Prisma.sql`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = '"PlatformTokenReservation"'::regclass
        AND conname = 'PlatformTokenReservation_raw_billing_check'
    `);
    assert.equal(reservationChecks.length, 1);
    assert.match(reservationChecks[0]!.definition, /unifiedQuestionConfirmationId/u);
    assert.match(reservationChecks[0]!.definition, /unified-question:/u);

    const confirmationForeignKey = await db.$queryRaw<Array<{ definition: string }>>(Prisma.sql`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = '"PlatformTokenReservation"'::regclass
        AND conname = 'PlatformTokenReservation_unified_question_confirmation_fkey'
    `);
    assert.equal(confirmationForeignKey.length, 1);
    assert.match(confirmationForeignKey[0]!.definition, /FOREIGN KEY \("userId", "unifiedQuestionConfirmationId"\)/u);
    assert.match(confirmationForeignKey[0]!.definition, /REFERENCES "UnifiedQuestionConfirmation"\("ownerUserId", id\)/u);

    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const adminId = randomUUID();
    const ownerId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const conversationId = randomUUID();
    const firstTurnId = randomUUID();
    const secondTurnId = randomUUID();
    const admin = { id: adminId, role: "admin" as const, accountAccessVersion: 1 };
    const owner = { id: ownerId, role: "user" as const, accountAccessVersion: 1 };
    await db.appUser.createMany({ data: [
      { id: adminId, username: `uq_admin_${suffix}`, role: "admin" },
      { id: ownerId, username: `uq_owner_${suffix}`, role: "user" },
    ] });
    await db.$transaction(async (tx) => {
      await tx.workspace.create({ data: { id: workspaceId, name: `Unified Q&A ${suffix}`, slug: `unified-qa-${suffix}`, createdById: adminId } });
      await grantWorkspaceMembership(tx, { workspaceId, userId: adminId, role: "owner", actorId: adminId, reason: "unified_question_postgres_gate" });
      await grantWorkspaceMembership(tx, { workspaceId, userId: ownerId, role: "member", actorId: adminId, reason: "unified_question_postgres_gate" });
      await tx.project.create({ data: { id: projectId, workspaceId, name: `Unquoted source ${suffix}`, slug: `unquoted-source-${suffix}` } });
    });
    await db.$transaction(async (tx) => {
      await grantProjectMembership(tx, { projectId, workspaceId, userId: adminId, role: "owner", actorId: adminId, reason: "unified_question_postgres_gate" });
      await grantProjectMembership(tx, { projectId, workspaceId, userId: ownerId, role: "viewer", actorId: adminId, reason: "unified_question_postgres_gate" });
    });
    const provider = await createVerifiedProviderFixture({
      name: `Unified Q&A gate ${suffix}`, kind: "deepseek", apiKey: `unified-question-gate-${suffix}`,
      generationModelId: "deepseek-v4-flash", visionModelId: null, embeddingModelId: null, embeddingDimensions: null,
    }, admin, db);

    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.unified_question_mutation_context', 'service-v1', true)`;
      await tx.unifiedQuestionConversation.create({ data: { id: conversationId, ownerUserId: ownerId, title: null } });
      await tx.unifiedQuestionTurn.create({ data: {
        id: firstTurnId, ownerUserId: ownerId, conversationId, sequence: 1, scope: "all", projectId: null,
        contextName: "全量可访问内容", question: "项目资料是否参与本轮？", answer: "unquoted-source-answer-marker",
        modelId: provider.defaultGenerationModelId!, providerName: provider.name, providerConnectionId: provider.id,
        citations: [], projectIds: [projectId],
      } });
      await tx.unifiedQuestionConversation.update({ where: { id: conversationId }, data: {
        headTurnId: firstTurnId, headSequence: 1, version: 1, title: "项目资料是否参与本轮？",
      } });
    });
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.unified_question_mutation_context', 'service-v1', true)`;
      await tx.unifiedQuestionTurn.create({ data: {
        id: secondTurnId, ownerUserId: ownerId, conversationId, sequence: 2, scope: "personal", projectId: null,
        contextName: "个人空间", question: "切换个人范围后继续。", answer: "second-personal-turn-marker",
        modelId: provider.defaultGenerationModelId!, providerName: provider.name, providerConnectionId: provider.id,
        citations: [], projectIds: [],
      } });
      await tx.unifiedQuestionConversation.update({ where: { id: conversationId }, data: {
        headTurnId: secondTurnId, headSequence: 2, version: 2,
      } });
    });

    const beforeRevocation = await getUnifiedQuestionConversation(conversationId, owner, db) as {
      conversation: { turns: Array<{ scope: string; citations: unknown }> };
    };
    assert.deepEqual(beforeRevocation.conversation.turns.map((turn) => turn.scope), ["all", "personal"]);
    assert.deepEqual(beforeRevocation.conversation.turns[0]!.citations, []);
    const visibleSearch = await listUnifiedQuestionConversations({ search: "unquoted-source-answer-marker" }, owner, db) as {
      conversations: Array<{ id: string }>;
      pagination: { total: number };
    };
    assert.equal(visibleSearch.pagination.total, 1);
    assert.equal(visibleSearch.conversations[0]?.id, conversationId);

    await db.$transaction((tx) => revokeProjectMembership(tx, projectId, ownerId, workspaceId, {
      actorId: adminId, reason: "unified_question_postgres_gate_revocation",
    }));

    const hiddenSearch = await listUnifiedQuestionConversations({ search: "unquoted-source-answer-marker" }, owner, db) as {
      conversations: Array<{ id: string }>;
      pagination: { total: number };
    };
    assert.equal(hiddenSearch.pagination.total, 0);
    assert.deepEqual(hiddenSearch.conversations, []);
    const hiddenList = await listUnifiedQuestionConversations({}, owner, db) as {
      conversations: Array<{ id: string }>;
      pagination: { total: number };
    };
    assert.equal(hiddenList.pagination.total, 0);
    assert.deepEqual(hiddenList.conversations, []);
    await assert.rejects(() => getUnifiedQuestionConversation(conversationId, owner, db), (error: unknown) =>
      error instanceof UnifiedQuestionError && error.code === "UNIFIED_QUESTION_HISTORY_UNAVAILABLE");
    await assert.rejects(() => prepareUnifiedQuestion({
      phase: "prepare", conversationId, expectedLastTurnId: secondTurnId, scope: "personal",
      question: "撤权后的后续请求应失败", clientKey: `uq-postgres-gate-${suffix}`,
    }, owner, db), (error: unknown) =>
      error instanceof UnifiedQuestionError && error.code === "UNIFIED_QUESTION_HISTORY_UNAVAILABLE");
  } finally {
    await db.$disconnect();
  }
});

test(
  "unified question persists real multi-scope turns once, fences stale confirmations, and holds uncertain dispatches",
  { skip: !shouldRun ? "UNIFIED_QUESTION_POSTGRES_GATE=1 is required" : false },
  async () => {
    if (typeof process.env.DATABASE_URL !== "string" || process.env.DATABASE_URL.length === 0) {
      throw new Error("UNIFIED_QUESTION_POSTGRES_DATABASE_URL_REQUIRED");
    }
    const db = getDb();
    await db.$connect();
    const fixtureDb = process.env.MIGRATOR_DATABASE_URL
      ? new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.MIGRATOR_DATABASE_URL }) })
      : db;
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const admin = { id: randomUUID(), role: "admin" as const, accountAccessVersion: 1 };
    const owner = { id: randomUUID(), role: "user" as const, accountAccessVersion: 1 };
    const workspaceId = randomUUID();
    const firstProjectId = randomUUID();
    const secondProjectId = randomUUID();
    const originalFetch = globalThis.fetch;
    const originalMasterKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    const keyFixture = await createSecureMasterKeyFixture();
    let dispatches = 0;
    let providerOutcome: "success" | "unknown" = "success";
    const personalOriginal = "青松迁移方案：先核对备份，再验证切换并保留回滚窗口。";
    const personalRevisionOne = "青松迁移方案更新：核对备份、验证切换，保留完整回滚窗口。";
    const personalRevisionTwo = "青松迁移方案再次更新：确认备份、演练切换并保留审批记录。";
    const firstQuestion = "请说明青松迁移方案的回滚步骤";
    const projectQuestion = "请说明银杏交付计划";
    const headQuestion = "青松迁移方案之后如何验证";
    const staleSourceQuestion = "青松迁移方案的审批要点是什么";
    // Put a distinct keyword for each fixture in the bounded lexical query;
    // this gate verifies dispatch provenance, not semantic query expansion.
    const allQuestion = "青松、银杏、紫藤的迁移交付评审如何协作";
    const unknownQuestion = "请说明青松迁移方案的验证步骤";
    process.env.AI_PROJECT_OS_MASTER_KEY_FILE = keyFixture.path;

    async function createProjectSource(projectId: string, externalRef: string, contentText: string): Promise<string> {
      const contentHash = createHash("sha256").update(contentText, "utf8").digest("hex");
      const source = await fixtureDb.projectSource.create({
        data: {
          projectId,
          kind: "document",
          originScope: "project",
          projectRepositoryLinkId: null,
          sourceIdentity: randomUUID(),
          revisionKey: randomUUID(),
          externalRef,
          contentText,
          contentHash,
          manualContentDedupeKey: null,
        },
        select: { id: true },
      });
      return source.id;
    }

    type Prepared = {
      confirmation: {
        confirmationId: string;
        conversationId: string;
        expectedLastTurnId: string | null;
        billing: { estimatedChargedTokens: number };
        sources: Array<{ id: string; scope: string; projectId?: string; content: string }>;
      };
    };
    type Conversation = {
      conversation: {
        id: string;
        lastTurnId: string | null;
        turns: Array<{
          id: string;
          sequence: number;
          scope: string;
          projectId: string | null;
          question: string;
          answer: string;
          citations: unknown;
        }>;
      };
    };

    try {
      const shanghaiBoundaryEnd = new Date("2026-09-03T01:00:00.000Z");
      const boundaryBefore = await readSystemOverviewAnalytics(db, shanghaiBoundaryEnd);
      await fixtureDb.appUser.createMany({ data: [
        { id: randomUUID(), username: `uq_boundary_before_${suffix}`, role: "user", createdAt: new Date("2026-09-02T15:59:59.999Z") },
        { id: randomUUID(), username: `uq_boundary_after_${suffix}`, role: "user", createdAt: new Date("2026-09-02T16:00:00.000Z") },
      ] });
      const boundaryAfter = await readSystemOverviewAnalytics(db, shanghaiBoundaryEnd);
      assert.equal(boundaryAfter.today.date, "2026-09-03");
      assert.ok(boundaryBefore.today.newUsers !== null && boundaryAfter.today.newUsers !== null);
      assert.equal(boundaryAfter.today.newUsers - boundaryBefore.today.newUsers, 1,
        "UTC 16:00 belongs to the next Shanghai calendar day");
      const previousDayBefore = boundaryBefore.trends.days30.find((row) => row.date === "2026-09-02")?.newUsers;
      const previousDayAfter = boundaryAfter.trends.days30.find((row) => row.date === "2026-09-02")?.newUsers;
      assert.ok(typeof previousDayBefore === "number" && typeof previousDayAfter === "number");
      assert.equal(
        previousDayAfter - previousDayBefore,
        1,
        "the millisecond before UTC 16:00 remains on the prior Shanghai calendar day",
      );
      await fixtureDb.appUser.createMany({ data: [
        { id: admin.id, username: `uq_service_admin_${suffix}`, role: "admin" },
        { id: owner.id, username: `uq_service_owner_${suffix}`, role: "user" },
      ] });
      if (await fixtureDb.platformGrantOfferPolicy.count() === 0) {
        await fixtureDb.$transaction((tx) => createBootstrapSignupOfferPolicy(tx, admin.id));
      }
      const provider = await createVerifiedProviderFixture({
        name: `Unified question service ${suffix}`,
        kind: "openai",
        apiKey: `synthetic-unified-question-${suffix}`,
        generationModelId: "gpt-4.1-mini",
        visionModelId: null,
        embeddingModelId: null,
        embeddingDimensions: null,
      }, admin, fixtureDb);
      const routeDraft = await createPlatformDefaultAiRoute({
        operation: "generateWithContext",
        providerConnectionId: provider.id,
        modelId: "gpt-4.1-mini",
        maxOutputTokens: 256,
        quotaMultiplierBps: 10_000,
      }, admin, fixtureDb);
      const validatedRoute = await validatePlatformDefaultAiRoute(routeDraft.id, admin, fixtureDb, routeDraft.updatedAt);
      await activatePlatformDefaultAiRoute(validatedRoute.id, admin, fixtureDb, validatedRoute.updatedAt);
      await activateCanonicalSignupGrant(fixtureDb, { userId: owner.id, actorId: owner.id });

      await db.$transaction(async (tx) => {
        await tx.workspace.create({
          data: { id: workspaceId, name: `Unified question ${suffix}`, slug: `uq-service-${suffix}`, createdById: admin.id },
        });
        await grantWorkspaceMembership(tx, {
          workspaceId, userId: admin.id, role: "owner", actorId: admin.id, reason: "unified_question_service_gate",
        });
        await grantWorkspaceMembership(tx, {
          workspaceId, userId: owner.id, role: "member", actorId: admin.id, reason: "unified_question_service_gate",
        });
        await tx.project.create({
          data: { id: firstProjectId, workspaceId, name: `银杏交付 ${suffix}`, slug: `uq-first-${suffix}` },
        });
        await tx.project.create({
          data: { id: secondProjectId, workspaceId, name: `紫藤评审 ${suffix}`, slug: `uq-second-${suffix}` },
        });
      });
      await db.$transaction(async (tx) => {
        for (const projectId of [firstProjectId, secondProjectId]) {
          await grantProjectMembership(tx, {
            projectId, workspaceId, userId: admin.id, role: "owner", actorId: admin.id,
            reason: "unified_question_service_gate",
          });
          await grantProjectMembership(tx, {
            projectId, workspaceId, userId: owner.id, role: "editor", actorId: admin.id,
            reason: "unified_question_service_gate",
          });
        }
      });
      await createProjectSource(firstProjectId, "银杏交付计划", "银杏交付计划：核对里程碑、验收清单和交接责任人。");
      await createProjectSource(secondProjectId, "紫藤风险评审", "紫藤风险评审：记录风险结论、缓解措施和发布决策。");
      const personalDocument = await createPersonalKnowledgeDocument({
        title: "青松迁移方案", content: personalOriginal,
      }, owner, db);

      globalThis.fetch = async (input, init) => {
        dispatches += 1;
        const url = String(input);
        assert.match(url, /\/chat\/completions$/u, "only the isolated fake provider endpoint is used");
        if (providerOutcome === "unknown") throw new Error("synthetic network loss after dispatch");
        const request = JSON.parse(String(init?.body)) as {
          model: string;
          messages: Array<{ role: string; content: string }>;
        };
        assert.equal(request.model, "gpt-4.1-mini");
        const userMessage = request.messages.find((message) => message.role === "user");
        assert.ok(userMessage);
        const payload = JSON.parse(userMessage.content) as {
          currentQuestion: string;
          completeHistory: Array<{ question: string; answer: string }>;
          currentTurnEvidence: Array<{ id: string; scope: string; projectId: string | null; content: string }>;
        };
        let citationId: string | undefined = payload.currentTurnEvidence[0]?.id;
        if (payload.currentQuestion === allQuestion) {
          const sentProjectIds = [...new Set(payload.currentTurnEvidence
            .flatMap((source) => source.scope === "project" && source.projectId !== null ? [source.projectId] : []))].sort();
          assert.deepEqual(sentProjectIds, [firstProjectId, secondProjectId].sort());
          assert.ok(payload.currentTurnEvidence.some((source) => source.projectId === firstProjectId
            && source.content.includes("银杏交付计划")));
          assert.ok(payload.currentTurnEvidence.some((source) => source.projectId === secondProjectId
            && source.content.includes("紫藤风险评审")));
          assert.ok(payload.currentTurnEvidence.some((source) => source.scope === "personal"));
          const firstProjectEvidence = payload.currentTurnEvidence.find((source) => source.projectId === firstProjectId);
          assert.ok(firstProjectEvidence);
          citationId = firstProjectEvidence.id;
          assert.ok(payload.completeHistory.length >= 3, "the request carries the complete prior conversation");
          assert.equal(payload.completeHistory[0]?.question, firstQuestion);
          assert.equal(payload.completeHistory[0]?.answer, "统一问答模型答案-1");
        }
        if (citationId === undefined) throw new Error("UNIFIED_QUESTION_TEST_CITATION_REQUIRED");
        return new Response(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            answer: `统一问答模型答案-${dispatches}`,
            citations: [citationId],
          }) } }],
          usage: { prompt_tokens: 32, completion_tokens: 12 },
        }), { status: 200, headers: { "content-type": "application/json", "x-request-id": `uq-${dispatches}` } });
      };

      const firstInput = {
        phase: "prepare" as const,
        expectedLastTurnId: null,
        scope: "personal" as const,
        focusDocumentId: personalDocument.id,
        question: firstQuestion,
        clientKey: `uq-first-${randomUUID()}`,
      };
      const firstPrepared = await prepareUnifiedQuestion(firstInput, owner, db) as Prepared;
      const firstReplay = await prepareUnifiedQuestion(firstInput, owner, db) as Prepared;
      const firstConfirmation = firstPrepared.confirmation;
      assert.equal(firstReplay.confirmation.confirmationId, firstConfirmation.confirmationId);
      assert.equal(firstReplay.confirmation.conversationId, firstConfirmation.conversationId);
      assert.equal(firstConfirmation.sources.length, 1);
      assert.equal(firstConfirmation.sources[0]?.scope, "personal");
      const personalSnapshotContent = `青松迁移方案\n${personalOriginal}`;
      assert.equal(firstConfirmation.sources[0]?.content, personalSnapshotContent);
      assert.equal(dispatches, 0, "prepare and client-key replay never dispatch");

      const firstExecute = {
        phase: "execute" as const,
        conversationId: firstConfirmation.conversationId,
        expectedLastTurnId: null,
        scope: "personal" as const,
        focusDocumentId: personalDocument.id,
        question: firstQuestion,
        clientKey: firstInput.clientKey,
        confirmationId: firstConfirmation.confirmationId,
      };
      const analyticsWindowEnd = new Date(Date.now() + 60 * 60 * 1_000);
      const analyticsBeforeFirstDispatch = await readSystemOverviewAnalytics(db, analyticsWindowEnd);
      const duplicateExecutions = await Promise.allSettled([
        executeUnifiedQuestion(firstExecute, owner, db),
        executeUnifiedQuestion(firstExecute, owner, db),
      ]);
      const firstSuccesses = duplicateExecutions.filter((result) => result.status === "fulfilled");
      const firstFailures = duplicateExecutions.filter((result) => result.status === "rejected");
      assert.equal(firstSuccesses.length, 1, "same-head duplicate execution appends one turn");
      assert.equal(firstFailures.length, 1);
      const duplicateFailureCode = firstFailures[0]?.status === "rejected" ? unifiedCode(firstFailures[0].reason) : null;
      assert.ok(duplicateFailureCode === "UNIFIED_QUESTION_CONFIRMATION_CONSUMED"
        || duplicateFailureCode === "UNIFIED_QUESTION_CONFLICT", "duplicate admission returns a stable conflict code");
      assert.equal(dispatches, 1, "duplicate execute results in one provider dispatch");
      const firstSuccessAudit = await db.unifiedQuestionAudit.findFirstOrThrow({
        where: { ownerUserId: owner.id, confirmationId: firstConfirmation.confirmationId },
        select: { status: true, inputTokens: true, outputTokens: true, usageKnown: true, completedAt: true },
      });
      assert.equal(firstSuccessAudit.status, "succeeded");
      assert.equal(firstSuccessAudit.inputTokens, 32);
      assert.equal(firstSuccessAudit.outputTokens, 12);
      assert.equal(firstSuccessAudit.usageKnown, true);
      assert.ok(firstSuccessAudit.completedAt);
      assert.ok(firstSuccessAudit.completedAt < analyticsWindowEnd, "audit completion is inside the queried end boundary");
      assert.ok(firstSuccessAudit.completedAt >= new Date(analyticsWindowEnd.getTime() - 30 * 24 * 60 * 60 * 1_000),
        "audit completion is inside the 30-day analytics window");
      const analyticsAfterFirstDispatch = await readSystemOverviewAnalytics(db, analyticsWindowEnd);
      assert.equal(
        totalAnalyticsValue(analyticsAfterFirstDispatch, "platformTokens")
          - totalAnalyticsValue(analyticsBeforeFirstDispatch, "platformTokens"),
        44,
        "the successful unified-question audit contributes its real known provider usage to platform analytics",
      );
      assert.equal(
        totalAnalyticsValue(analyticsAfterFirstDispatch, "unknownCalls")
          - totalAnalyticsValue(analyticsBeforeFirstDispatch, "unknownCalls"),
        0,
        "a known successful response does not enter unknown-call analytics",
      );
      assert.equal(await db.platformTokenReservation.count({
        where: { userId: owner.id, unifiedQuestionConfirmationId: firstConfirmation.confirmationId },
      }), 1, "duplicate execute creates one reservation");
      const firstReservation = await db.platformTokenReservation.findFirstOrThrow({
        where: { userId: owner.id, unifiedQuestionConfirmationId: firstConfirmation.confirmationId },
      });
      assert.equal(firstReservation.status, "settled");
      assert.equal(firstReservation.reservedTokens, firstConfirmation.billing.estimatedChargedTokens);
      const firstLedger = await db.platformTokenLedgerEntry.findMany({
        where: { reservationId: firstReservation.id }, orderBy: { entryKind: "asc" },
        select: { entryKind: true, amount: true, usageTokens: true },
      });
      assert.deepEqual(firstLedger.map((entry) => entry.entryKind).sort(), ["release", "reserve", "settle"]);
      assert.equal(firstLedger.find((entry) => entry.entryKind === "reserve")?.amount, -firstReservation.reservedTokens);
      assert.equal(firstLedger.find((entry) => entry.entryKind === "release")?.amount,
        firstReservation.reservedTokens - firstReservation.settledTokens!);
      assert.equal(firstLedger.find((entry) => entry.entryKind === "settle")?.usageTokens, firstReservation.rawSettledTokens);
      assert.equal(firstLedger.reduce((net, entry) => net + entry.amount, 0), -firstReservation.settledTokens!,
        "one dispatch charges its actual usage and returns the unused reservation");
      const firstConversationId = firstConfirmation.conversationId;
      let conversation = (await getUnifiedQuestionConversation(firstConversationId, owner, db)) as Conversation;
      assert.equal(conversation.conversation.turns.length, 1);
      const immutableFirstCitation = conversation.conversation.turns[0]?.citations;
      assert.ok(Array.isArray(immutableFirstCitation));
      assert.equal((immutableFirstCitation[0] as { content?: string }).content, personalSnapshotContent);

      await revisePersonalKnowledgeDocument(personalDocument.id, {
        expectedVersion: 1,
        content: personalRevisionOne,
      }, owner, db);
      conversation = (await getUnifiedQuestionConversation(firstConversationId, owner, db)) as Conversation;
      assert.deepEqual(conversation.conversation.turns[0]?.citations, immutableFirstCitation,
        "revising the current personal source never rewrites the old citation snapshot");

      const projectInput = {
        phase: "prepare" as const,
        conversationId: firstConversationId,
        expectedLastTurnId: conversation.conversation.lastTurnId,
        scope: "project" as const,
        projectId: firstProjectId,
        question: projectQuestion,
        clientKey: `uq-project-${randomUUID()}`,
      };
      const projectPrepared = await prepareUnifiedQuestion(projectInput, owner, db) as Prepared;
      const projectResult = await executeUnifiedQuestion({
        phase: "execute",
        conversationId: projectPrepared.confirmation.conversationId,
        expectedLastTurnId: projectInput.expectedLastTurnId,
        scope: "project",
        projectId: firstProjectId,
        question: projectQuestion,
        clientKey: projectInput.clientKey,
        confirmationId: projectPrepared.confirmation.confirmationId,
      }, owner, db) as Conversation;
      assert.equal(projectResult.conversation.turns.length, 2);
      assert.equal(projectResult.conversation.turns[0]?.scope, "personal");
      assert.equal(projectResult.conversation.turns[1]?.scope, "project");
      assert.equal(projectResult.conversation.turns[1]?.projectId, firstProjectId);
      assert.deepEqual(projectResult.conversation.turns[0]?.citations, immutableFirstCitation);
      assert.equal((projectResult.conversation.turns[1]?.citations as Array<{ projectId?: string }>)[0]?.projectId, firstProjectId);

      const headBeforeRace = projectResult.conversation.lastTurnId;
      const headWinnerInput = {
        phase: "prepare" as const, conversationId: firstConversationId, expectedLastTurnId: headBeforeRace,
        scope: "personal" as const, focusDocumentId: personalDocument.id, question: headQuestion,
        clientKey: `uq-head-winner-${randomUUID()}`,
      };
      const headStaleInput = {
        ...headWinnerInput,
        clientKey: `uq-head-stale-${randomUUID()}`,
      };
      const headWinner = (await prepareUnifiedQuestion(headWinnerInput, owner, db) as Prepared).confirmation;
      const headStale = (await prepareUnifiedQuestion(headStaleInput, owner, db) as Prepared).confirmation;
      const headWinnerResult = await executeUnifiedQuestion({
        phase: "execute", conversationId: firstConversationId, expectedLastTurnId: headBeforeRace,
        scope: "personal", focusDocumentId: personalDocument.id, question: headQuestion,
        clientKey: headWinnerInput.clientKey, confirmationId: headWinner.confirmationId,
      }, owner, db) as Conversation;
      assert.equal(headWinnerResult.conversation.turns.length, 3);
      const dispatchesBeforeStaleHead = dispatches;
      await assert.rejects(() => executeUnifiedQuestion({
        phase: "execute", conversationId: firstConversationId, expectedLastTurnId: headBeforeRace,
        scope: "personal", focusDocumentId: personalDocument.id, question: headQuestion,
        clientKey: headStaleInput.clientKey, confirmationId: headStale.confirmationId,
      }, owner, db), (error: unknown) => error instanceof UnifiedQuestionError
        && error.code === "UNIFIED_QUESTION_CONFIRMATION_STALE");
      assert.equal(dispatches, dispatchesBeforeStaleHead, "a changed conversation head is rejected before provider dispatch");
      assert.equal(await db.platformTokenReservation.count({
        where: { userId: owner.id, unifiedQuestionConfirmationId: headStale.confirmationId },
      }), 0);

      const beforeSourceChange = headWinnerResult.conversation.lastTurnId;
      const staleSourceInput = {
        phase: "prepare" as const, conversationId: firstConversationId, expectedLastTurnId: beforeSourceChange,
        scope: "personal" as const, focusDocumentId: personalDocument.id, question: staleSourceQuestion,
        clientKey: `uq-source-stale-${randomUUID()}`,
      };
      const staleSource = (await prepareUnifiedQuestion(staleSourceInput, owner, db) as Prepared).confirmation;
      await revisePersonalKnowledgeDocument(personalDocument.id, {
        expectedVersion: 2,
        content: personalRevisionTwo,
      }, owner, db);
      const dispatchesBeforeStaleSource = dispatches;
      await assert.rejects(() => executeUnifiedQuestion({
        phase: "execute", conversationId: firstConversationId, expectedLastTurnId: beforeSourceChange,
        scope: "personal", focusDocumentId: personalDocument.id, question: staleSourceQuestion,
        clientKey: staleSourceInput.clientKey, confirmationId: staleSource.confirmationId,
      }, owner, db), (error: unknown) => error instanceof UnifiedQuestionError
        && error.code === "UNIFIED_QUESTION_CONFIRMATION_STALE");
      assert.equal(dispatches, dispatchesBeforeStaleSource, "a changed source revision is rejected before provider dispatch");
      assert.equal(await db.platformTokenReservation.count({
        where: { userId: owner.id, unifiedQuestionConfirmationId: staleSource.confirmationId },
      }), 0);

      const allInput = {
        phase: "prepare" as const, conversationId: firstConversationId,
        expectedLastTurnId: beforeSourceChange,
        scope: "all" as const, question: allQuestion, clientKey: `uq-all-${randomUUID()}`,
      };
      const allPrepared = (await prepareUnifiedQuestion(allInput, owner, db) as Prepared).confirmation;
      const allResult = await executeUnifiedQuestion({
        phase: "execute", conversationId: firstConversationId, expectedLastTurnId: beforeSourceChange,
        scope: "all", question: allQuestion, clientKey: allInput.clientKey,
        confirmationId: allPrepared.confirmationId,
      }, owner, db) as Conversation;
      assert.equal(allResult.conversation.turns.length, 4);
      assert.equal(allResult.conversation.turns[3]?.scope, "all");
      const allCitations = allResult.conversation.turns[3]?.citations as Array<{ projectId?: string }>;
      assert.deepEqual(allCitations.map((citation) => citation.projectId), [firstProjectId],
        "the fake model cites only project A although evidence from both projects was sent");
      const allPersisted = await db.unifiedQuestionTurn.findUniqueOrThrow({
        where: { ownerUserId_id: { ownerUserId: owner.id, id: allResult.conversation.turns[3]!.id } },
        select: { projectIds: true },
      });
      assert.deepEqual(allPersisted.projectIds, [firstProjectId, secondProjectId].sort(),
        "history access retains every project actually sent, including uncited evidence");

      const pendingAfterProjectUseInput = {
        phase: "prepare" as const, conversationId: firstConversationId,
        expectedLastTurnId: allResult.conversation.lastTurnId,
        scope: "personal" as const, focusDocumentId: personalDocument.id,
        question: "青松迁移方案还有哪些验证记录", clientKey: `uq-revoke-pending-${randomUUID()}`,
      };
      const pendingAfterProjectUse = (await prepareUnifiedQuestion(pendingAfterProjectUseInput, owner, db) as Prepared).confirmation;
      await db.$transaction((tx) => grantProjectMembership(tx, {
        projectId: secondProjectId, workspaceId, userId: owner.id, role: "viewer", actorId: admin.id,
        reason: "unified_question_history_model_use_demotion_gate",
      }));
      const beforeDemotedHistory = dispatches;
      const visibleAsViewer = await getUnifiedQuestionConversation(firstConversationId, owner, db) as Conversation;
      assert.equal(visibleAsViewer.conversation.turns.length, 4, "view access still permits reading the complete retained history");
      await assert.rejects(() => executeUnifiedQuestion({
        phase: "execute", conversationId: firstConversationId, expectedLastTurnId: allResult.conversation.lastTurnId,
        scope: "personal", focusDocumentId: personalDocument.id, question: pendingAfterProjectUseInput.question,
        clientKey: pendingAfterProjectUseInput.clientKey, confirmationId: pendingAfterProjectUse.confirmationId,
      }, owner, db), (error: unknown) => error instanceof UnifiedQuestionError
        && error.code === "UNIFIED_QUESTION_SCOPE_REQUIRES_EDIT");
      await assert.rejects(() => prepareUnifiedQuestion({
        ...pendingAfterProjectUseInput, clientKey: `uq-demoted-history-${randomUUID()}`,
      }, owner, db), (error: unknown) => error instanceof UnifiedQuestionError
        && error.code === "UNIFIED_QUESTION_SCOPE_REQUIRES_EDIT");
      assert.equal(dispatches, beforeDemotedHistory, "view-only history is never forwarded after changing to personal scope");
      assert.equal(await db.platformTokenReservation.count({
        where: { userId: owner.id, unifiedQuestionConfirmationId: pendingAfterProjectUse.confirmationId },
      }), 0);
      await db.$transaction((tx) => grantProjectMembership(tx, {
        projectId: secondProjectId, workspaceId, userId: owner.id, role: "editor", actorId: admin.id,
        reason: "unified_question_history_model_use_restore_gate",
      }));
      await fixtureDb.project.update({ where: { id: secondProjectId }, data: { archivedAt: new Date() } });
      await assert.rejects(() => prepareUnifiedQuestion({
        ...pendingAfterProjectUseInput, clientKey: `uq-archived-history-${randomUUID()}`,
      }, owner, db), (error: unknown) => error instanceof UnifiedQuestionError
        && error.code === "UNIFIED_QUESTION_SCOPE_REQUIRES_EDIT");
      assert.equal(dispatches, beforeDemotedHistory, "archived project history is not forwarded to a model");
      await fixtureDb.project.update({ where: { id: secondProjectId }, data: { archivedAt: null } });
      await prepareUnifiedQuestion({
        ...pendingAfterProjectUseInput, clientKey: `uq-restored-history-${randomUUID()}`,
      }, owner, db);
      await db.$transaction((tx) => revokeProjectMembership(tx, secondProjectId, owner.id, workspaceId, {
        actorId: admin.id, reason: "unified_question_uncited_project_revocation_gate",
      }));
      const dispatchesBeforeRevokedHistory = dispatches;
      await assert.rejects(() => executeUnifiedQuestion({
        phase: "execute", conversationId: firstConversationId,
        expectedLastTurnId: allResult.conversation.lastTurnId,
        scope: "personal", focusDocumentId: personalDocument.id,
        question: pendingAfterProjectUseInput.question, clientKey: pendingAfterProjectUseInput.clientKey,
        confirmationId: pendingAfterProjectUse.confirmationId,
      }, owner, db), (error: unknown) => error instanceof UnifiedQuestionError
        && error.code === "UNIFIED_QUESTION_HISTORY_UNAVAILABLE");
      assert.equal(dispatches, dispatchesBeforeRevokedHistory, "revoked prior-source project blocks continuation before dispatch");
      assert.equal(await db.platformTokenReservation.count({
        where: { userId: owner.id, unifiedQuestionConfirmationId: pendingAfterProjectUse.confirmationId },
      }), 0);
      const hiddenList = await listUnifiedQuestionConversations({}, owner, db) as {
        conversations: Array<{ id: string }>;
        pagination: { total: number };
      };
      const hiddenSearch = await listUnifiedQuestionConversations({ search: "紫藤风险评审" }, owner, db) as {
        conversations: Array<{ id: string }>;
        pagination: { total: number };
      };
      assert.deepEqual(hiddenList.conversations, []);
      assert.equal(hiddenList.pagination.total, 0);
      assert.deepEqual(hiddenSearch.conversations, []);
      assert.equal(hiddenSearch.pagination.total, 0);
      await assert.rejects(() => getUnifiedQuestionConversation(firstConversationId, owner, db), (error: unknown) =>
        error instanceof UnifiedQuestionError && error.code === "UNIFIED_QUESTION_HISTORY_UNAVAILABLE");
      await assert.rejects(() => prepareUnifiedQuestion({
        phase: "prepare", conversationId: firstConversationId,
        expectedLastTurnId: allResult.conversation.lastTurnId,
        scope: "personal", focusDocumentId: personalDocument.id,
        question: "撤权后的历史不得继续", clientKey: `uq-revoked-continue-${randomUUID()}`,
      }, owner, db), (error: unknown) => error instanceof UnifiedQuestionError
        && error.code === "UNIFIED_QUESTION_HISTORY_UNAVAILABLE");

      providerOutcome = "unknown";
      const analyticsBeforeUnknownDispatch = await readSystemOverviewAnalytics(db, analyticsWindowEnd);
      const unknownClientKey = `uq-unknown-${randomUUID()}`;
      const unknownPrepared = (await prepareUnifiedQuestion({
        phase: "prepare", expectedLastTurnId: null,
        scope: "personal", focusDocumentId: personalDocument.id,
        question: unknownQuestion, clientKey: unknownClientKey,
      }, owner, db) as Prepared).confirmation;
      const preissuedClientKey = `uq-unknown-preissued-${randomUUID()}`;
      const preissuedPrepared = (await prepareUnifiedQuestion({
        phase: "prepare", conversationId: unknownPrepared.conversationId, expectedLastTurnId: null,
        scope: "personal", focusDocumentId: personalDocument.id,
        question: unknownQuestion, clientKey: preissuedClientKey,
      }, owner, db) as Prepared).confirmation;
      const unknownExecute = {
        phase: "execute" as const,
        conversationId: unknownPrepared.conversationId,
        expectedLastTurnId: null,
        scope: "personal" as const,
        focusDocumentId: personalDocument.id,
        question: unknownQuestion,
        clientKey: unknownClientKey,
        confirmationId: unknownPrepared.confirmationId,
      };
      const preissuedExecute = {
        phase: "execute" as const,
        conversationId: preissuedPrepared.conversationId,
        expectedLastTurnId: null,
        scope: "personal" as const,
        focusDocumentId: personalDocument.id,
        question: unknownQuestion,
        clientKey: preissuedClientKey,
        confirmationId: preissuedPrepared.confirmationId,
      };
      await assert.rejects(() => executeUnifiedQuestion(unknownExecute, owner, db), (error: unknown) =>
        error instanceof UnifiedQuestionError && error.code === "UNIFIED_QUESTION_PROVIDER_UNCERTAIN");
      const dispatchesAfterUnknown = dispatches;
      const unknownReservation = await db.platformTokenReservation.findFirstOrThrow({
        where: { userId: owner.id, unifiedQuestionConfirmationId: unknownPrepared.confirmationId },
      });
      const unknownAudit = await db.unifiedQuestionAudit.findFirstOrThrow({
        where: { ownerUserId: owner.id, confirmationId: unknownPrepared.confirmationId },
        select: { status: true, safeErrorCode: true },
      });
      assert.equal(unknownReservation.status, "held");
      assert.equal(unknownReservation.reconciliationRequired, true);
      assert.equal(unknownAudit.status, "unknown");
      const analyticsAfterUnknownDispatch = await readSystemOverviewAnalytics(db, analyticsWindowEnd);
      assert.equal(
        totalAnalyticsValue(analyticsAfterUnknownDispatch, "unknownCalls")
          - totalAnalyticsValue(analyticsBeforeUnknownDispatch, "unknownCalls"),
        1,
        "one dispatched unknown outcome contributes one unknown call to platform analytics",
      );
      const reservationsBeforeFenceChecks = await db.platformTokenReservation.count({ where: { userId: owner.id } });
      await assert.rejects(() => executeUnifiedQuestion(preissuedExecute, owner, db), (error: unknown) =>
        error instanceof UnifiedQuestionError && error.code === "UNIFIED_QUESTION_OUTCOME_UNRESOLVED");
      await assert.rejects(() => prepareUnifiedQuestion({
        phase: "prepare", conversationId: unknownPrepared.conversationId, expectedLastTurnId: null,
        scope: "personal", focusDocumentId: personalDocument.id,
        question: "同一会话新的clientKey不得绕过未决结果", clientKey: `uq-unknown-fresh-${randomUUID()}`,
      }, owner, db), (error: unknown) => error instanceof UnifiedQuestionError
        && error.code === "UNIFIED_QUESTION_OUTCOME_UNRESOLVED");
      await assert.rejects(() => executeUnifiedQuestion(unknownExecute, owner, db), (error: unknown) =>
        error instanceof UnifiedQuestionError && error.code === "UNIFIED_QUESTION_CONFIRMATION_CONSUMED");
      assert.equal(dispatches, dispatchesAfterUnknown, "unknown provider outcome is never automatically retried");
      assert.equal(await db.platformTokenReservation.count({ where: { userId: owner.id } }), reservationsBeforeFenceChecks,
        "blocked same-head requests create no additional reservations");
      assert.equal(await db.platformTokenReservation.count({
        where: { userId: owner.id, unifiedQuestionConfirmationId: preissuedPrepared.confirmationId },
      }), 0);
      assert.equal(await db.platformTokenReservation.count({
        where: { userId: owner.id, unifiedQuestionConfirmationId: unknownPrepared.confirmationId },
      }), 1);
      const newConversation = (await prepareUnifiedQuestion({
        phase: "prepare", expectedLastTurnId: null,
        scope: "personal", focusDocumentId: personalDocument.id,
        question: unknownQuestion, clientKey: `uq-after-unknown-new-${randomUUID()}`,
      }, owner, db) as Prepared).confirmation;
      assert.notEqual(newConversation.conversationId, unknownPrepared.conversationId);
      assert.equal(newConversation.expectedLastTurnId, null);
      assert.equal(dispatches, dispatchesAfterUnknown, "preparing a new conversation does not dispatch");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalMasterKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
      else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = originalMasterKeyPath;
      await keyFixture.cleanup();
      if (fixtureDb !== db) await fixtureDb.$disconnect();
      await db.$disconnect();
    }
  },
);
