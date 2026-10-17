import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { createSecureMasterKeyFixture } from "./secure-master-key-fixture";
import test from "node:test";
import { getDb } from "../src/lib/db";
import { activateCanonicalSignupGrant } from "./account-entitlement-test-helper";
import { createVerifiedProviderFixture } from "./platform-provider-fixture";
import { grantProjectMembership, grantWorkspaceMembership } from "../src/lib/membership-governance";
import {
  activatePlatformDefaultAiRoute,
  createPlatformDefaultAiRoute,
  validatePlatformDefaultAiRoute,
} from "../src/lib/platform-default-ai-routes";
import { listWebAiCandidates, prepareAutoExtractConfirmation, reviewWebAiCandidate, runAutoExtractJob } from "../src/lib/web-auto-extract";
import { prepareProjectMemoryIndexConfirmation, runProjectMemoryIndexJob } from "../src/lib/web-memory-index";
import { hashSourceContent } from "../src/lib/source";
import {
  prepareRagAnswerConfirmation,
  prepareSemanticSearchConfirmation,
  runRagAnswerJob,
  runSemanticSearchJob,
} from "../src/lib/web-rag";
import { createControlledMembership } from "./membership-fixture";
import { createSignupOfferFixture } from "./platform-grant-offer-policy-fixture";

const shouldRun = process.env.WEB_AI_POSTGRES_GATE === "1";

async function activateDefaultRoute(
  db: ReturnType<typeof getDb>,
  actor: Readonly<{ id: string; role: string; accountAccessVersion: number }>,
  input: Readonly<{
    operation: "embedding" | "autoExtract" | "generateWithContext";
    providerConnectionId: string;
    modelId: string;
    embeddingDimensions?: number;
    maxOutputTokens?: number;
  }>,
) {
  const draft = await createPlatformDefaultAiRoute(input, actor, db);
  const verified = await validatePlatformDefaultAiRoute(draft.id, actor, db, draft.updatedAt);
  return activatePlatformDefaultAiRoute(verified.id, actor, db, verified.updatedAt);
}

function vector(text: string): number[] {
  const seed = [...text].reduce((sum, character) => sum + character.codePointAt(0)!, 0);
  return Array.from({ length: 8 }, (_, index) => ((seed + index * 17) % 29) / 29 + 0.1);
}

test(
  "web AI workflow persists extraction, atomic vector memory, semantic search and cited RAG",
  { skip: !shouldRun ? "WEB_AI_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const projectId = randomUUID();
    const keyFixture = await createSecureMasterKeyFixture();
    const masterKeyPath = keyFixture.path;
    const previousKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    const previousFetch = globalThis.fetch;
    const longAutoExtractRequests: Array<{
      sourceId: string;
      sourceHash: string;
      sourceRange: { start: number; end: number; totalCharacters: number };
      evidenceBlocks: Array<{ id: string; text: string }>;
    }> = [];
    let longSourceId: string | null = null;
    let longFact = "";
    let retireDuringLongExtraction = false;
    let truncatedSourceId: string | null = null;
    let truncatedDispatchCount = 0;
    let partialSourceId: string | null = null;
    const partialDispatchRanges: Array<{ start: number; end: number }> = [];

    await unlink(masterKeyPath).catch(() => undefined);
    process.env.AI_PROJECT_OS_MASTER_KEY_FILE = masterKeyPath;

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer sk-v2-workflow-secret");
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.endsWith("/embeddings")) {
        const texts = request.input as string[];
        return new Response(JSON.stringify({
          data: texts.map((text, index) => ({ index, embedding: vector(text) })),
          usage: { prompt_tokens: texts.length * 5, completion_tokens: 0 },
        }), { status: 200, headers: { "content-type": "application/json", "x-request-id": `embed-${suffix}` } });
      }
      if (url.endsWith("/chat/completions")) {
        const messages = request.messages as Array<{ role: string; content: string }>;
        const system = messages[0]!.content;
        const user = JSON.parse(messages[1]!.content) as Record<string, unknown>;
        let content: string;
        let finishReason: string | undefined;
        if (system.includes("extract project-memory candidates")) {
          if (user.sourceId === partialSourceId && partialSourceId !== null) {
            const sourceRange = user.sourceRange as { start: number; end: number };
            const evidenceBlocks = user.evidenceBlocks as Array<{ id: string; text: string }>;
            partialDispatchRanges.push({ start: sourceRange.start, end: sourceRange.end });
            const excerpt = sourceRange.start === 0
              ? "前段事实：项目编号为青禾-2026。"
              : "后段事实：验收日期为2026年10月20日。";
            assert.equal(evidenceBlocks.some((block) => block.text.includes(excerpt)), true);
            content = JSON.stringify({ candidates: [{
              type: "decision",
              title: sourceRange.start === 0 ? "前段编号" : "后段验收日期",
              content: excerpt,
              sourceExcerpt: excerpt,
            }] });
            if (sourceRange.start !== 0) finishReason = "length";
          } else if (user.sourceId === truncatedSourceId && truncatedSourceId !== null) {
            truncatedDispatchCount += 1;
            const excerpt = "本次验收确认使用统一归档规范。";
            content = JSON.stringify({ candidates: [{
              type: "decision",
              title: "归档规范",
              content: excerpt,
              sourceExcerpt: excerpt,
            }] });
            finishReason = "length";
          } else if (user.sourceId === longSourceId && longSourceId !== null) {
            const longRequest = user as unknown as typeof longAutoExtractRequests[number];
            longAutoExtractRequests.push(longRequest);
            if (retireDuringLongExtraction) {
              await db.projectSource.update({ where: { id: longSourceId }, data: { retiredAt: new Date() } });
            }
            const evidence = longRequest.evidenceBlocks.find((block) => block.text.includes(longFact));
            content = JSON.stringify({
              candidates: retireDuringLongExtraction || evidence === undefined ? [] : [{
                type: "decision",
                title: "数据库存储方式",
                content: longFact,
                evidenceId: evidence.id,
                sourceExcerpt: longFact,
              }],
            });
          } else {
            content = JSON.stringify({
              candidates: [
                {
                  type: "decision",
                  title: "采用统一项目记忆索引",
                  content: "项目决定采用统一记忆索引。",
                  sourceExcerpt: "项目决定采用统一记忆索引。",
                },
                {
                  type: "progress",
                  title: "项目知识问答引用要求",
                  content: "每个回答都要包含来源引用。",
                  sourceExcerpt: "所有回答必须保留证据引用。",
                },
                {
                  type: "decision",
                  title: "采用统一项目记忆索引",
                  content: "所有回答必须保留证据引用。",
                  sourceExcerpt: "所有回答必须保留证据引用。",
                },
              ],
            });
          }
        } else {
          content = JSON.stringify({
              answer: "项目采用统一记忆索引，并要求回答保留证据引用。",
              citations: [(user.contexts as Array<{ citationId: string }>)[0]!.citationId],
          });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content }, ...(finishReason === undefined ? {} : { finish_reason: finishReason }) }],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        }), { status: 200, headers: { "content-type": "application/json", "x-request-id": `chat-${suffix}` } });
      }
      throw new Error(`unexpected provider URL: ${url}`);
    };

    try {
      const user = await db.appUser.create({
        data: { id: randomUUID(), username: `v2_test_${suffix}`, role: "user" },
      });
      const platformAdmin = await db.appUser.create({
        data: { id: randomUUID(), username: `v2_platform_admin_${suffix}`, role: "admin" },
      });
      await createSignupOfferFixture(db, platformAdmin.id);
      const workspaceId = randomUUID();
      await db.$transaction(async (tx) => {
        await tx.workspace.create({
          data: { id: workspaceId, name: `V2 workflow workspace ${suffix}`, slug: `v2-workflow-workspace-${suffix}`, createdById: user.id },
        });
        await grantWorkspaceMembership(tx, {
          workspaceId,
          userId: user.id,
          role: "owner",
          actorId: user.id,
          reason: "web_ai_workflow_fixture",
        });
      });
      const membershipNow = new Date();
      await createControlledMembership(db, {
        adminId: platformAdmin.id,
        userId: user.id,
        startsAt: new Date(membershipNow.getTime() - 60_000),
        expiresAt: new Date(membershipNow.getTime() + 86_400_000),
      });
      await activateCanonicalSignupGrant(db, { userId: user.id, actorId: platformAdmin.id });

      await db.project.create({
        data: { id: projectId, workspaceId, name: `V2 workflow ${suffix}`, slug: `v2-workflow-${suffix}` },
      });
      await db.$transaction((tx) => grantProjectMembership(tx, {
        projectId,
        workspaceId,
        userId: user.id,
        role: "owner",
        actorId: user.id,
        reason: "web_ai_workflow_fixture",
      }));
      const sourceText = "会议结论：项目决定采用统一记忆索引。所有回答必须保留证据引用。";
      const sourceHash = hashSourceContent(sourceText);
      const source = await db.projectSource.create({
        data: {
          projectId,
          kind: "manual",
          originScope: "project",
          contentText: sourceText,
          contentHash: sourceHash,
          manualContentDedupeKey: sourceHash,
        },
      });
      const provider = await createVerifiedProviderFixture({
        name: `V2 mock ${suffix}`,
        kind: "glm",
        apiKey: "sk-v2-workflow-secret",
        generationModelId: "glm-4-flash",
        embeddingModelId: "embedding-3",
        embeddingDimensions: 8,
        visionModelId: null,
      }, { id: platformAdmin.id, role: platformAdmin.role, accountAccessVersion: platformAdmin.accountAccessVersion }, db);
      await db.aiProviderConnection.update({
        where: { id: provider.id },
        data: { status: "verified", lastTestedAt: new Date() },
      });

      const defaultEmbeddingRoute = await activateDefaultRoute(db, { id: platformAdmin.id, role: platformAdmin.role, accountAccessVersion: platformAdmin.accountAccessVersion }, {
        operation: "embedding",
        providerConnectionId: provider.id,
        modelId: "embedding-3",
        embeddingDimensions: 8,
      });
      assert.equal(defaultEmbeddingRoute.status, "active");
      const defaultAutoExtractRoute = await activateDefaultRoute(db, { id: platformAdmin.id, role: platformAdmin.role, accountAccessVersion: platformAdmin.accountAccessVersion }, {
        operation: "autoExtract",
        providerConnectionId: provider.id,
        modelId: "glm-4-flash",
        maxOutputTokens: 1024,
      });
      assert.equal(defaultAutoExtractRoute.status, "active");
      const defaultGenerationRoute = await activateDefaultRoute(db, { id: platformAdmin.id, role: platformAdmin.role, accountAccessVersion: platformAdmin.accountAccessVersion }, {
        operation: "generateWithContext",
        providerConnectionId: provider.id,
        modelId: "glm-4-flash",
        maxOutputTokens: 1024,
      });
      assert.equal(defaultGenerationRoute.status, "active");

      const indexClientKey = `index-${suffix}`;
      const indexConfirmation = await prepareProjectMemoryIndexConfirmation({
        projectId,
        requestedBy: user,
        clientKey: indexClientKey,
        mode: "full",
        db,
      });
      const indexJob = await runProjectMemoryIndexJob({
        projectId,
        requestedBy: user,
        clientKey: indexClientKey,
        challengeId: indexConfirmation.challengeId,
        mode: "full",
      }, db);
      assert.equal(indexJob.status, "succeeded");
      const pointer = await db.memoryIndexPointer.findUnique({
        where: { projectId },
        include: { generation: true },
      });
      assert.equal(pointer?.generation.status, "complete");
      assert.equal(pointer?.generation.recordCount, 1);
      assert.equal(pointer?.generation.dimensions, 8);

      const extractClientKey = `extract-${suffix}`;
      const extractConfirmation = await prepareAutoExtractConfirmation({
        projectId,
        requestedBy: user,
        clientKey: extractClientKey,
        sourceIds: [source.id],
        db,
      });
      const extractJob = await runAutoExtractJob({
        projectId,
        requestedBy: user,
        clientKey: extractClientKey,
        challengeId: extractConfirmation.challengeId,
        request: { sourceIds: [source.id] },
      }, db);
      assert.equal(extractJob.status, "succeeded");
      const extractResult = extractJob.result as Record<string, unknown>;
      assert.deepEqual({
        sourceCount: extractResult.sourceCount,
        candidateCount: extractResult.candidateCount,
        confirmedCount: extractResult.confirmedCount,
        reviewRequiredCount: extractResult.reviewRequiredCount,
        duplicateCount: extractResult.duplicateCount,
        returnedCandidateCount: extractResult.returnedCandidateCount,
        rejectedCandidateCount: extractResult.rejectedCandidateCount,
        recoveredExcerptCount: extractResult.recoveredExcerptCount,
        anchoredExcerptCount: extractResult.anchoredExcerptCount,
      }, {
        sourceCount: 1,
        candidateCount: 3,
        confirmedCount: 1,
        reviewRequiredCount: 2,
        duplicateCount: 0,
        returnedCandidateCount: 3,
        rejectedCandidateCount: 0,
        recoveredExcerptCount: 0,
        anchoredExcerptCount: 0,
      });
      assert.match(String(extractResult.manifest), /^[a-f0-9]{64}$/u);
      const autoAccepted = await db.webAiCandidate.findFirstOrThrow({
        where: { projectId, reviewStatus: "accepted" },
        include: { projectItem: true },
      });
      assert.equal(autoAccepted.projectItem.reviewStatus, "confirmed");
      assert.ok(autoAccepted.projectItem.confirmedAt);
      assert.equal(autoAccepted.reviewedBy, "system:source-grounded:v1");
      assert.equal(autoAccepted.projectItem.title, autoAccepted.projectItem.content);
      const admissionMetadata = autoAccepted.projectItem.metadata as unknown as { admission?: { policy?: string; reason?: string; suggestedTitle?: string } };
      assert.equal(admissionMetadata.admission?.policy, "source-grounded:v1");
      assert.equal(admissionMetadata.admission?.reason, "exact_source_text");
      assert.equal(admissionMetadata.admission && "mode" in admissionMetadata.admission, true);
      assert.equal(admissionMetadata.admission?.suggestedTitle, "采用统一项目记忆索引");
      const candidateViews = await listWebAiCandidates(projectId, user, db);
      const autoAcceptedView = candidateViews.find((view) => view.id === autoAccepted.id);
      assert.equal(autoAcceptedView?.projectItem.admission?.mode, "automatic");
      assert.equal(autoAcceptedView?.projectItem.admission?.reason, "exact_source_text");
      assert.equal("metadata" in (autoAcceptedView?.projectItem ?? {}), false);
      const autoRevisions = await db.projectItemRevision.findMany({
        where: { projectId, projectItemId: autoAccepted.projectItemId },
        orderBy: { revisionNumber: "asc" },
        select: { action: true, actorId: true, reviewStatus: true },
      });
      assert.deepEqual(autoRevisions.map((revision) => [revision.action, revision.reviewStatus]), [
        ["aiCreated", "candidate"],
        ["confirmed", "confirmed"],
      ]);
      assert.equal(autoRevisions[1]?.actorId, "system:source-grounded:v1");

      const candidate = await db.webAiCandidate.findFirstOrThrow({
        where: { projectId, reviewStatus: "candidate", projectItem: { is: { type: "progress" } } },
        include: { projectItem: true },
      });
      assert.equal(candidate.projectItem.reviewStatus, "candidate");
      const conflictCandidate = await db.webAiCandidate.findFirstOrThrow({
        where: { projectId, reviewStatus: "candidate", projectItem: { is: { content: "所有回答必须保留证据引用。" } } },
        include: { projectItem: true },
      });
      const conflictAdmission = conflictCandidate.projectItem.metadata as unknown as { admission?: { reason?: string; mode?: string } };
      assert.equal(conflictAdmission.admission?.reason, "conflicting_confirmed_fact");
      assert.equal(conflictAdmission.admission?.mode, "review_required");
      const reviewed = await reviewWebAiCandidate({
        projectId,
        candidateId: candidate.id,
        action: "accept",
        expectedItemUpdatedAt: candidate.projectItem.updatedAt,
        actor: user,
      }, db);
      assert.equal(reviewed.reviewStatus, "accepted");
      assert.equal(reviewed.projectItem.reviewStatus, "confirmed");
      const reviewRevision = await db.projectItemRevision.findFirstOrThrow({
        where: { projectId, projectItemId: candidate.projectItemId },
        orderBy: [{ revisionNumber: "desc" }, { createdAt: "desc" }],
        select: { actorId: true },
      });
      const reviewedRow = await db.webAiCandidate.findUniqueOrThrow({
        where: { id: candidate.id },
        select: { reviewedBy: true },
      });
      assert.equal(reviewedRow.reviewedBy, user.id);
      assert.equal(reviewRevision.actorId, user.id);

      const repeatClientKey = `extract-repeat-${suffix}`;
      const repeatConfirmation = await prepareAutoExtractConfirmation({
        projectId,
        requestedBy: user,
        clientKey: repeatClientKey,
        sourceIds: [source.id],
        db,
      });
      const legacyFingerprint = createHash("sha256")
        .update(JSON.stringify({
          sourceId: source.id,
          sourceHash: source.contentHash,
          candidate: {
            type: autoAccepted.projectItem.type,
            title: admissionMetadata.admission?.suggestedTitle,
            content: autoAccepted.projectItem.content,
            sourceExcerpt: autoAccepted.projectItem.sourceExcerpt,
          },
        }), "utf8")
        .digest("hex");
      await db.webAiCandidate.update({
        where: { id: autoAccepted.id },
        data: { candidateFingerprint: legacyFingerprint },
      });
      const repeatedExtractJob = await runAutoExtractJob({
        projectId,
        requestedBy: user,
        clientKey: repeatClientKey,
        challengeId: repeatConfirmation.challengeId,
        request: { sourceIds: [source.id] },
      }, db);
      assert.equal(repeatedExtractJob.status, "succeeded");
      const repeatedResult = repeatedExtractJob.result as Record<string, unknown>;
      assert.deepEqual({
        sourceCount: repeatedResult.sourceCount,
        candidateCount: repeatedResult.candidateCount,
        confirmedCount: repeatedResult.confirmedCount,
        reviewRequiredCount: repeatedResult.reviewRequiredCount,
        duplicateCount: repeatedResult.duplicateCount,
        returnedCandidateCount: repeatedResult.returnedCandidateCount,
        rejectedCandidateCount: repeatedResult.rejectedCandidateCount,
        recoveredExcerptCount: repeatedResult.recoveredExcerptCount,
        anchoredExcerptCount: repeatedResult.anchoredExcerptCount,
      }, {
        sourceCount: 1,
        candidateCount: 0,
        confirmedCount: 0,
        reviewRequiredCount: 0,
        duplicateCount: 3,
        returnedCandidateCount: 3,
        rejectedCandidateCount: 0,
        recoveredExcerptCount: 0,
        anchoredExcerptCount: 0,
      });
      assert.match(String(repeatedResult.manifest), /^[a-f0-9]{64}$/u);
      assert.equal(await db.webAiCandidate.count({ where: { projectId } }), 3);

      const searchQuestion = "项目采用了什么记忆方案？";
      const searchClientKey = `search-${suffix}`;
      const searchConfirmation = await prepareSemanticSearchConfirmation({
        projectId,
        requestedBy: user,
        clientKey: searchClientKey,
        question: searchQuestion,
        db,
      });
      const searchJob = await runSemanticSearchJob({
        projectId,
        requestedBy: user,
        clientKey: searchClientKey,
        challengeId: searchConfirmation.challengeId,
        question: searchQuestion,
      }, db);
      assert.equal(searchJob.status, "succeeded");
      const searchResult = searchJob.result as { results: Array<{ contentText: string; score: number }> };
      assert.equal(searchResult.results.length, 1);
      assert.match(searchResult.results[0]!.contentText, /统一记忆索引/);
      assert.equal(Number.isFinite(searchResult.results[0]!.score), true);

      const ragQuestion = "项目采用了什么记忆方案？";
      const ragClientKey = `rag-${suffix}`;
      const ragConfirmation = await prepareRagAnswerConfirmation({
        projectId,
        requestedBy: user,
        clientKey: ragClientKey,
        question: ragQuestion,
        db,
      });
      const ragJob = await runRagAnswerJob({
        projectId,
        requestedBy: user,
        clientKey: ragClientKey,
        challengeId: ragConfirmation.challengeId,
        question: ragQuestion,
      }, db);
      assert.equal(ragJob.status, "succeeded");
      const answer = await db.ragAnswer.findFirstOrThrow({ where: { projectId } });
      assert.match(answer.answer, /统一记忆索引/);
      assert.equal(Array.isArray(answer.citations), true);
      assert.equal((answer.citations as Array<unknown>).length, 1);

      const audits = await db.providerCallAudit.findMany({
        where: { job: { projectId } },
      });
      assert.equal(audits.every((audit) => audit.status === "succeeded"), true);
      assert.equal(audits.length >= 5, true);
      assert.equal(await db.webAiGrant.count({ where: { projectId } }) >= 4, true);

      const truncatedSourceText = "本次验收确认使用统一归档规范。";
      const truncatedSource = await db.projectSource.create({ data: {
        projectId,
        kind: "manual",
        originScope: "project",
        contentText: truncatedSourceText,
        contentHash: hashSourceContent(truncatedSourceText),
        manualContentDedupeKey: null,
      } });
      truncatedSourceId = truncatedSource.id;
      const truncatedClientKey = `extract-truncated-${suffix}`;
      const truncatedConfirmation = await prepareAutoExtractConfirmation({
        projectId, requestedBy: user, clientKey: truncatedClientKey, sourceIds: [truncatedSource.id], db,
      });
      await assert.rejects(runAutoExtractJob({
        projectId,
        requestedBy: user,
        clientKey: truncatedClientKey,
        challengeId: truncatedConfirmation.challengeId,
        request: { sourceIds: [truncatedSource.id] },
      }, db), (error: unknown) => error instanceof Error && "code" in error && error.code === "AUTO_EXTRACT_OUTPUT_TRUNCATED");
      assert.equal(truncatedDispatchCount, 1, "truncated provider output is not automatically retried");
      assert.equal(await db.projectItem.count({ where: { projectId, sourceId: truncatedSource.id } }), 0);
      assert.equal(await db.webAiCandidate.count({ where: { projectId, sourceId: truncatedSource.id } }), 0);

      const truncatedChallenge = await db.webAiConfirmationChallenge.findUniqueOrThrow({
        where: { id: truncatedConfirmation.challengeId },
        select: { consumedJobId: true },
      });
      assert.ok(truncatedChallenge.consumedJobId);
      const truncatedJob = await db.backgroundJob.findUniqueOrThrow({
        where: { id: truncatedChallenge.consumedJobId },
        select: { status: true, failureCode: true },
      });
      assert.equal(truncatedJob.status, "failed");
      assert.equal(truncatedJob.failureCode, "AUTO_EXTRACT_OUTPUT_TRUNCATED");
      const truncatedAudits = await db.providerCallAudit.findMany({
        where: { jobId: truncatedChallenge.consumedJobId, operation: "autoExtract" },
        select: { status: true, safeErrorCode: true, inputTokens: true, outputTokens: true, usageKnown: true, providerRequestId: true },
      });
      assert.equal(truncatedAudits.length, 1);
      assert.deepEqual(truncatedAudits[0], {
        status: "succeeded",
        safeErrorCode: null,
        inputTokens: 20,
        outputTokens: 10,
        usageKnown: true,
        providerRequestId: `chat-${suffix}`,
      });

      const partialFirstExcerpt = "前段事实：项目编号为青禾-2026。";
      const partialSecondExcerpt = "后段事实：验收日期为2026年10月20日。";
      const partialSourceText = `${"a".repeat(10_000)}${partialFirstExcerpt}${"b".repeat(30_000 - partialFirstExcerpt.length)}${"c".repeat(20_000)}${partialSecondExcerpt}${"d".repeat(100_000 - 60_000 - partialSecondExcerpt.length)}`;
      assert.equal(partialSourceText.length, 100_000);
      const partialSource = await db.projectSource.create({ data: {
        projectId,
        kind: "manual",
        originScope: "project",
        contentText: partialSourceText,
        contentHash: hashSourceContent(partialSourceText),
        manualContentDedupeKey: null,
      } });
      partialSourceId = partialSource.id;
      const partialClientKey = `extract-partial-truncated-${suffix}`;
      const partialConfirmation = await prepareAutoExtractConfirmation({
        projectId, requestedBy: user, clientKey: partialClientKey, sourceIds: [partialSource.id], db,
      });
      await assert.rejects(runAutoExtractJob({
        projectId,
        requestedBy: user,
        clientKey: partialClientKey,
        challengeId: partialConfirmation.challengeId,
        request: { sourceIds: [partialSource.id] },
      }, db), (error: unknown) => error instanceof Error && "code" in error && error.code === "AUTO_EXTRACT_OUTPUT_TRUNCATED");
      assert.deepEqual(partialDispatchRanges.map((range) => range.start), [0, 48_800]);
      assert.equal(partialDispatchRanges.length, 2, "later chunks are not dispatched after a truncated response");
      const partialItems = await db.projectItem.findMany({
        where: { projectId, sourceId: partialSource.id },
        select: { content: true, sourceExcerpt: true },
      });
      assert.deepEqual(partialItems, [{ content: partialFirstExcerpt, sourceExcerpt: partialFirstExcerpt }]);

      const partialChallenge = await db.webAiConfirmationChallenge.findUniqueOrThrow({
        where: { id: partialConfirmation.challengeId },
        select: { consumedJobId: true },
      });
      assert.ok(partialChallenge.consumedJobId);
      const partialJob = await db.backgroundJob.findUniqueOrThrow({
        where: { id: partialChallenge.consumedJobId },
        select: { status: true, failureCode: true },
      });
      assert.equal(partialJob.status, "failed");
      assert.equal(partialJob.failureCode, "AUTO_EXTRACT_OUTPUT_TRUNCATED");
      const partialAudits = await db.providerCallAudit.findMany({
        where: { jobId: partialChallenge.consumedJobId, operation: "autoExtract" },
        orderBy: { createdAt: "asc" },
        select: { status: true, inputTokens: true, outputTokens: true, usageKnown: true },
      });
      assert.deepEqual(partialAudits, [
        { status: "succeeded", inputTokens: 20, outputTokens: 10, usageKnown: true },
        { status: "succeeded", inputTokens: 20, outputTokens: 10, usageKnown: true },
      ]);

      // A selected excerpt cannot omit the server-owned section context, and
      // automatic import admission must not widen external-source policies.
      for (const fixture of [
        { kind: "manual" as const, text: `## 待确认\n${sourceText}`, expectedReason: "source_contains_uncertainty" },
        { kind: "web" as const, text: sourceText, expectedReason: "source_requires_manual_review" },
      ]) {
        const scopedSource = await db.projectSource.create({ data: {
          projectId, kind: fixture.kind, originScope: "project", contentText: fixture.text,
          contentHash: hashSourceContent(fixture.text), manualContentDedupeKey: null,
        } });
        const scopedKey = `scope-${fixture.kind}-${suffix}`;
        const scopedConfirmation = await prepareAutoExtractConfirmation({ projectId, requestedBy: user, clientKey: scopedKey, sourceIds: [scopedSource.id], db });
        const scopedJob = await runAutoExtractJob({ projectId, requestedBy: user, clientKey: scopedKey, challengeId: scopedConfirmation.challengeId, request: { sourceIds: [scopedSource.id] } }, db);
        assert.equal(scopedJob.status, "succeeded");
        const scopedResult = scopedJob.result as { confirmedCount?: number; reviewRequiredCount?: number };
        assert.equal(scopedResult.confirmedCount, 0);
        assert.equal(scopedResult.reviewRequiredCount, 3);
        const exactRow = await db.projectItem.findFirstOrThrow({ where: { projectId, sourceId: scopedSource.id, content: "项目决定采用统一记忆索引。" } });
        assert.equal(exactRow.reviewStatus, "candidate");
        assert.equal((exactRow.metadata as { admission?: { reason?: string } }).admission?.reason, fixture.expectedReason);
      }

      const retiredSource = await db.projectSource.create({ data: { projectId, kind: "document", originScope: "project", contentText: sourceText, contentHash: sourceHash, retiredAt: new Date() } });
      const confirmedBefore = await db.projectItem.count({ where: { projectId, reviewStatus: "confirmed" } });
      await assert.rejects(prepareAutoExtractConfirmation({ projectId, requestedBy: user, clientKey: `retired-${suffix}`, sourceIds: [retiredSource.id], db }), (error: unknown) => error instanceof Error && "code" in error && error.code === "AUTO_EXTRACT_SOURCE_NOT_FOUND");
      assert.equal(await db.projectItem.count({ where: { projectId, reviewStatus: "confirmed" } }), confirmedBefore);

      longFact = "项目当前使用 PostgreSQL 存储项目记忆。";
      const longSourceText = `${"a".repeat(10_000)}${longFact}${"b".repeat(70_000 - 10_000 - longFact.length)}${longFact}${"c".repeat(100_000 - 70_000 - longFact.length)}`;
      assert.equal(longSourceText.length, 100_000);
      const longSourceHash = hashSourceContent(longSourceText);
      const longSource = await db.projectSource.create({ data: {
        projectId,
        kind: "manual",
        originScope: "project",
        contentText: longSourceText,
        contentHash: longSourceHash,
        manualContentDedupeKey: null,
      } });
      longSourceId = longSource.id;
      const longClientKey = `extract-long-${suffix}`;
      const longConfirmation = await prepareAutoExtractConfirmation({ projectId, requestedBy: user, clientKey: longClientKey, sourceIds: [longSource.id], db });
      const longJob = await runAutoExtractJob({
        projectId,
        requestedBy: user,
        clientKey: longClientKey,
        challengeId: longConfirmation.challengeId,
        request: { sourceIds: [longSource.id] },
      }, db);
      assert.equal(longJob.status, "succeeded");
      const longResult = longJob.result as Record<string, unknown>;
      assert.deepEqual({
        candidateCount: longResult.candidateCount,
        confirmedCount: longResult.confirmedCount,
        reviewRequiredCount: longResult.reviewRequiredCount,
        duplicateCount: longResult.duplicateCount,
        returnedCandidateCount: longResult.returnedCandidateCount,
      }, {
        candidateCount: 1,
        confirmedCount: 1,
        reviewRequiredCount: 0,
        duplicateCount: 1,
        returnedCandidateCount: 2,
      });
      assert.equal(longAutoExtractRequests.length, 3);
      assert.equal(longAutoExtractRequests.every((call) => call.sourceId === longSource.id && call.sourceHash === longSource.contentHash), true);
      assert.equal(longAutoExtractRequests.every((call) => call.sourceRange.totalCharacters === 100_000 && call.sourceRange.end - call.sourceRange.start <= 50_000), true);
      assert.equal(longAutoExtractRequests[0]?.sourceRange.start, 0);
      assert.equal(longAutoExtractRequests.at(-1)?.sourceRange.end, 100_000);
      for (let index = 1; index < longAutoExtractRequests.length; index += 1) {
        const previous = longAutoExtractRequests[index - 1]!.sourceRange;
        const current = longAutoExtractRequests[index]!.sourceRange;
        assert.ok(current.start < previous.end);
      }
      const longCallAudits = await db.providerCallAudit.findMany({
        where: { jobId: longJob.id, operation: "autoExtract" },
        select: { callKey: true },
      });
      assert.equal(longCallAudits.length, 3);
      assert.equal(new Set(longCallAudits.map((audit) => audit.callKey)).size, 3);
      const longFactRows = await db.projectItem.findMany({ where: { projectId, sourceId: longSource.id, content: longFact } });
      assert.equal(longFactRows.length, 1);
      assert.equal(longFactRows[0]?.reviewStatus, "confirmed");

      const changingSource = await db.projectSource.create({ data: {
        projectId, kind: "document", originScope: "project", contentText: longSourceText,
        contentHash: longSourceHash, manualContentDedupeKey: null,
      } });
      const changingKey = `extract-retired-between-chunks-${suffix}`;
      const changingConfirmation = await prepareAutoExtractConfirmation({ projectId, requestedBy: user, clientKey: changingKey, sourceIds: [changingSource.id], db });
      longSourceId = changingSource.id;
      longAutoExtractRequests.length = 0;
      retireDuringLongExtraction = true;
      await assert.rejects(runAutoExtractJob({
        projectId, requestedBy: user, clientKey: changingKey,
        challengeId: changingConfirmation.challengeId, request: { sourceIds: [changingSource.id] },
      }, db), (error: unknown) => error instanceof Error && "code" in error && error.code === "AUTO_EXTRACT_SOURCE_NOT_FOUND");
      assert.equal(longAutoExtractRequests.length, 1, "retirement after the first chunk stops all later model dispatches");
      assert.equal(await db.projectItem.count({ where: { projectId, sourceId: changingSource.id } }), 0);
      retireDuringLongExtraction = false;

      const oversizedText = "o".repeat(100_001);
      const oversizedSource = await db.projectSource.create({ data: {
        projectId,
        kind: "manual",
        originScope: "project",
        contentText: oversizedText,
        contentHash: hashSourceContent(oversizedText),
        manualContentDedupeKey: null,
      } });
      await assert.rejects(
        prepareAutoExtractConfirmation({ projectId, requestedBy: user, clientKey: `extract-oversized-${suffix}`, sourceIds: [oversizedSource.id], db }),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "AUTO_EXTRACT_SOURCE_TOO_LARGE",
      );

      const totalLimitSources = await Promise.all(["1", "2", "3"].map(async (filler, index) => {
        const contentText = filler.repeat(index < 2 ? 100_000 : 1);
        return db.projectSource.create({ data: {
          projectId,
          kind: "manual",
          originScope: "project",
          contentText,
          contentHash: hashSourceContent(contentText),
          manualContentDedupeKey: null,
        } });
      }));
      await assert.rejects(
        prepareAutoExtractConfirmation({ projectId, requestedBy: user, clientKey: `extract-total-limit-${suffix}`, sourceIds: totalLimitSources.map((source) => source.id), db }),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "AUTO_EXTRACT_SOURCE_TOO_LARGE",
      );

    } finally {
      globalThis.fetch = previousFetch;
      // Platform default route/audit rows are immutable evidence. The
      // disposable gate runner drops this database after the test, so row
      // deletion here would violate the audit contract.
      await unlink(masterKeyPath).catch(() => undefined);
      await keyFixture.cleanup();
      if (previousKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
      else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyPath;
    }
  },
);
