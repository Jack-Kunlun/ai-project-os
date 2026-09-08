import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import test from "node:test";
import { issueVerifiedSignupGrant } from "../src/lib/ai-entitlements";
import { createProviderConnection } from "../src/lib/ai-providers/service";
import { getDb } from "../src/lib/db";
import { grantProjectMembership, grantWorkspaceMembership } from "../src/lib/membership-governance";
import {
  activatePlatformDefaultAiRoute,
  createPlatformDefaultAiRoute,
  validatePlatformDefaultAiRoute,
} from "../src/lib/platform-default-ai-routes";
import { reviewWebAiCandidate, runAutoExtractJob } from "../src/lib/web-auto-extract";
import { WEB_AI_TRANSFER_CONSENT_VERSION } from "../src/lib/web-ai-contract";
import { runProjectMemoryIndexJob } from "../src/lib/web-memory-index";
import { hashSourceContent } from "../src/lib/source";
import { runRagAnswerJob, runSemanticSearchJob } from "../src/lib/web-rag";
import { createControlledMembership } from "./membership-fixture";

const shouldRun = process.env.WEB_AI_POSTGRES_GATE === "1";
const consent = { acknowledged: true, version: WEB_AI_TRANSFER_CONSENT_VERSION } as const;

async function activateDefaultRoute(
  db: ReturnType<typeof getDb>,
  actor: Readonly<{ id: string; role: string }>,
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
    const masterKeyPath = `/tmp/ai-project-os-v2-workflow-${process.pid}.key`;
    const previousKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    const previousFetch = globalThis.fetch;

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
        const content = system.includes("extract project-memory candidates")
          ? JSON.stringify({
              candidates: [{
                type: "decision",
                title: "采用统一项目记忆索引",
                content: "项目决定采用统一记忆索引，并保留引用证据。",
                sourceExcerpt: "项目决定采用统一记忆索引。",
              }],
            })
          : JSON.stringify({
              answer: "项目采用统一记忆索引，并要求回答保留证据引用。",
              citations: [(user.contexts as Array<{ citationId: string }>)[0]!.citationId],
            });
        return new Response(JSON.stringify({
          choices: [{ message: { content } }],
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
      const workspaceId = randomUUID();
      await db.workspace.create({
        data: { id: workspaceId, name: `V2 workflow workspace ${suffix}`, slug: `v2-workflow-workspace-${suffix}`, createdById: user.id },
      });
      await db.$transaction((tx) => grantWorkspaceMembership(tx, {
        workspaceId,
        userId: user.id,
        role: "owner",
        actorId: user.id,
        reason: "web_ai_workflow_fixture",
      }));
      const membershipNow = new Date();
      await createControlledMembership(db, {
        adminId: platformAdmin.id,
        userId: user.id,
        startsAt: new Date(membershipNow.getTime() - 60_000),
        expiresAt: new Date(membershipNow.getTime() + 86_400_000),
      });
      await issueVerifiedSignupGrant(user.id, { issuedById: platformAdmin.id }, db);

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
      const provider = await createProviderConnection({
        name: `V2 mock ${suffix}`,
        kind: "glm",
        apiKey: "sk-v2-workflow-secret",
        generationModelId: "glm-4-flash",
        embeddingModelId: "embedding-3",
        embeddingDimensions: 8,
        visionModelId: null,
      }, { id: platformAdmin.id, role: platformAdmin.role }, db);
      await db.aiProviderConnection.update({
        where: { id: provider.id },
        data: { status: "verified", lastTestedAt: new Date() },
      });

      const defaultEmbeddingRoute = await activateDefaultRoute(db, { id: platformAdmin.id, role: platformAdmin.role }, {
        operation: "embedding",
        providerConnectionId: provider.id,
        modelId: "embedding-3",
        embeddingDimensions: 8,
      });
      assert.equal(defaultEmbeddingRoute.status, "active");
      const defaultAutoExtractRoute = await activateDefaultRoute(db, { id: platformAdmin.id, role: platformAdmin.role }, {
        operation: "autoExtract",
        providerConnectionId: provider.id,
        modelId: "glm-4-flash",
        maxOutputTokens: 1024,
      });
      assert.equal(defaultAutoExtractRoute.status, "active");
      const defaultGenerationRoute = await activateDefaultRoute(db, { id: platformAdmin.id, role: platformAdmin.role }, {
        operation: "generateWithContext",
        providerConnectionId: provider.id,
        modelId: "glm-4-flash",
        maxOutputTokens: 1024,
      });
      assert.equal(defaultGenerationRoute.status, "active");

      const indexJob = await runProjectMemoryIndexJob({
        projectId,
        requestedBy: user,
        clientKey: `index-${suffix}`,
        consent,
      }, db);
      assert.equal(indexJob.status, "succeeded");
      const pointer = await db.memoryIndexPointer.findUnique({
        where: { projectId },
        include: { generation: true },
      });
      assert.equal(pointer?.generation.status, "complete");
      assert.equal(pointer?.generation.recordCount, 1);
      assert.equal(pointer?.generation.dimensions, 8);

      const extractJob = await runAutoExtractJob({
        projectId,
        requestedBy: user,
        clientKey: `extract-${suffix}`,
        consent,
        request: { sourceIds: [source.id] },
      }, db);
      assert.equal(extractJob.status, "succeeded");
      const candidate = await db.webAiCandidate.findFirstOrThrow({
        where: { projectId },
        include: { projectItem: true },
      });
      assert.equal(candidate.projectItem.reviewStatus, "candidate");
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

      const searchJob = await runSemanticSearchJob({
        projectId,
        requestedBy: user,
        clientKey: `search-${suffix}`,
        consent,
        question: "项目采用了什么记忆方案？",
      }, db);
      assert.equal(searchJob.status, "succeeded");
      const searchResult = searchJob.result as { results: Array<{ contentText: string; score: number }> };
      assert.equal(searchResult.results.length, 1);
      assert.match(searchResult.results[0]!.contentText, /统一记忆索引/);
      assert.equal(Number.isFinite(searchResult.results[0]!.score), true);

      const ragJob = await runRagAnswerJob({
        projectId,
        requestedBy: user,
        clientKey: `rag-${suffix}`,
        consent,
        question: "项目采用了什么记忆方案？",
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
    } finally {
      globalThis.fetch = previousFetch;
      // Platform default route/audit rows are immutable evidence. The
      // disposable gate runner drops this database after the test, so row
      // deletion here would violate the audit contract.
      await unlink(masterKeyPath).catch(() => undefined);
      if (previousKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
      else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyPath;
    }
  },
);
