import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import test from "node:test";
import { Prisma, ProjectItemRevisionAction } from "@prisma/client";
import { createProviderConnection } from "../src/lib/ai-providers/service";
import { getDb } from "../src/lib/db";
import { upsertProjectAiRoute } from "../src/lib/project-ai-routes";
import { appendProjectItemRevision, createPrimaryProjectItemEvidence } from "../src/lib/project-item-history";
import { WEB_AI_TRANSFER_CONSENT_VERSION } from "../src/lib/web-ai-contract";
import { runProjectMemoryIndexJob } from "../src/lib/web-memory-index";
import { claimProjectJob, reconcileProjectJob } from "../src/lib/project-workflow";
import {
  listProjectIntelligence,
  PROJECT_AGENT_TOOLS,
  runProjectAgentJob,
  runProjectBriefJob,
} from "../src/lib/web-project-intelligence";

const shouldRun = process.env.PROJECT_INTELLIGENCE_POSTGRES_GATE === "1";
const consent = { acknowledged: true, version: WEB_AI_TRANSFER_CONSENT_VERSION } as const;

function vector(text: string): number[] {
  const seed = [...text].reduce((sum, character) => sum + character.codePointAt(0)!, 0);
  return Array.from({ length: 8 }, (_, index) => ((seed + index * 19) % 31) / 31 + 0.1);
}

test(
  "project intelligence persists a cited brief and a constrained read-only agent trace",
  { skip: !shouldRun ? "PROJECT_INTELLIGENCE_POSTGRES_GATE=1 is required" : false },
  async () => {
    const db = getDb();
    const suffix = randomUUID().slice(0, 8);
    const projectId = randomUUID();
    const masterKeyPath = `/tmp/ai-project-os-v2-1-intelligence-${process.pid}.key`;
    const previousKeyPath = process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
    const previousFetch = globalThis.fetch;
    let createdUserId: string | null = null;
    let providerId: string | null = null;
    let credentialId: string | null = null;
    let alternateProviderId: string | null = null;
    let alternateCredentialId: string | null = null;
    let crossProjectId: string | null = null;
    let sameProjectGenerationId: string | null = null;
    let chatCalls = 0;

    await unlink(masterKeyPath).catch(() => undefined);
    process.env.AI_PROJECT_OS_MASTER_KEY_FILE = masterKeyPath;

    globalThis.fetch = async (input, init) => {
      const url = String(input);
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer sk-v2-1-intelligence-secret");
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.endsWith("/embeddings")) {
        const texts = request.input as string[];
        return new Response(JSON.stringify({
          data: texts.map((text, index) => ({ index, embedding: vector(text) })),
          usage: { prompt_tokens: texts.length * 5, completion_tokens: 0 },
        }), { status: 200, headers: { "content-type": "application/json", "x-request-id": `embed-${suffix}` } });
      }
      if (url.endsWith("/chat/completions")) {
        chatCalls += 1;
        const messages = request.messages as Array<{ role: string; content: string }>;
        const system = messages[0]!.content;
        const user = JSON.parse(messages[1]!.content) as Record<string, unknown>;
        let content: string;
        if (system.includes("read-only project intelligence analyst")) {
          const citationId = (user.contexts as Array<{ citationId: string }>)[0]!.citationId;
          content = JSON.stringify({
            status: "needs_attention",
            headline: "项目已形成可追溯记忆，下一步需持续补全风险证据",
            summary: "项目已经采用统一记忆索引，并要求回答保留引用。",
            citations: [citationId],
            progress: [{ text: "统一记忆索引已经成为当前项目方案。", citations: [citationId] }],
            decisions: [],
            issues: [],
            risks: [],
            needsAttention: [{ text: "继续补充后续进展和风险的已确认事实。", citations: [citationId] }],
            questions: [],
          });
        } else if (system.includes("Plan a read-only project investigation")) {
          content = JSON.stringify({
            objective: "核验项目当前方案、事实与风险",
            calls: [
              { tool: "project_overview", arguments: {} },
              { tool: "confirmed_items", arguments: { types: ["decision", "progress", "issue", "risk"], take: 10 } },
              { tool: "memory_search", arguments: { query: "项目当前方案与风险", take: 5 } },
              { tool: "repository_status", arguments: {} },
            ],
          });
        } else if (system.includes("read-only project intelligence agent answering from completed tool evidence")) {
          const citationId = (user.contexts as Array<{ citationId: string }>)[0]!.citationId;
          content = JSON.stringify({
            answer: "当前证据确认项目采用统一记忆索引，并要求所有回答保留证据引用。",
            citations: [citationId],
            recommendations: [{ text: "继续只将已确认事实纳入结论。", citations: [citationId] }],
            uncertainties: ["尚无足够仓库证据判断代码实施完整度。"],
          });
        } else {
          throw new Error(`unexpected system prompt: ${system.slice(0, 120)}`);
        }
        return new Response(JSON.stringify({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        }), { status: 200, headers: { "content-type": "application/json", "x-request-id": `chat-${suffix}-${chatCalls}` } });
      }
      throw new Error(`unexpected provider URL: ${url}`);
    };

    try {
      let user = await db.appUser.findFirst({ where: { role: "admin" } });
      if (user === null) {
        user = await db.appUser.create({
          data: {
            username: `v2_1_test_${suffix}`,
            role: "admin",
            passwordHash: "a".repeat(43),
            passwordSalt: "b".repeat(22),
            passwordVersion: 1,
          },
        });
        createdUserId = user.id;
      }

      await db.project.create({
        data: { id: projectId, name: `Intelligence ${suffix}`, slug: `intelligence-${suffix}` },
      });
      const source = await db.projectSource.create({
        data: {
          projectId,
          kind: "manual",
          originScope: "project",
          contentText: "会议结论：项目决定采用统一记忆索引。所有回答必须保留证据引用。",
          contentHash: "d".repeat(64),
          manualContentDedupeKey: "d".repeat(64),
        },
      });
      await db.$transaction(async (tx) => {
        const createdAt = new Date();
        const created = await tx.projectItem.create({
          data: {
            projectId,
            sourceId: source.id,
            type: "decision",
            reviewStatus: "candidate",
            title: "采用统一项目记忆索引",
            content: "项目采用统一记忆索引，并要求所有回答保留证据引用。",
            sourceExcerpt: "项目决定采用统一记忆索引。",
            confirmedAt: null,
            createdAt,
            updatedAt: createdAt,
          },
        });
        const evidence = await createPrimaryProjectItemEvidence(tx, {
          projectId,
          projectItemId: created.id,
          projectSourceId: source.id,
          sourceText: source.contentText,
          sourceExcerpt: "项目决定采用统一记忆索引。",
          createdAt,
        });
        await appendProjectItemRevision(tx, {
          item: created,
          action: ProjectItemRevisionAction.manualCreated,
          actorId: "local:v2-1-test",
          evidences: [evidence],
          createdAt,
        });
        const confirmedAt = new Date(createdAt.getTime() + 1);
        const confirmed = await tx.projectItem.update({
          where: { projectId_id: { projectId, id: created.id } },
          data: { reviewStatus: "confirmed", confirmedAt, updatedAt: confirmedAt },
        });
        await appendProjectItemRevision(tx, {
          item: confirmed,
          action: ProjectItemRevisionAction.confirmed,
          actorId: "local:v2-1-test",
          evidences: [evidence],
          createdAt: confirmedAt,
        });
      });

      const provider = await createProviderConnection({
        name: `V2.1 mock ${suffix}`,
        kind: "openai",
        apiKey: "sk-v2-1-intelligence-secret",
        generationModelId: "generation-test",
        embeddingModelId: "embedding-test",
        embeddingDimensions: 8,
      }, db);
      providerId = provider.id;
      const providerRow = await db.aiProviderConnection.update({
        where: { id: provider.id },
        data: { status: "verified", lastTestedAt: new Date() },
      });
      credentialId = providerRow.credentialId;

      await upsertProjectAiRoute(projectId, {
        operation: "embedding",
        providerConnectionId: provider.id,
        modelId: "embedding-test",
        embeddingDimensions: 8,
        maxOutputTokens: 128,
      }, db);
      await upsertProjectAiRoute(projectId, {
        operation: "generateWithContext",
        providerConnectionId: provider.id,
        modelId: "generation-test",
        embeddingDimensions: null,
        maxOutputTokens: 2_048,
      }, db);

      const beforeIndex = await listProjectIntelligence(projectId, db);
      assert.equal(beforeIndex.readiness.ready, false);
      assert.equal(beforeIndex.readiness.activeIndex, false);

      const indexJob = await runProjectMemoryIndexJob({
        projectId,
        requestedBy: user,
        clientKey: `index-${suffix}`,
        consent,
      }, db);
      assert.equal(indexJob.status, "succeeded");

      const indexedPointer = await db.memoryIndexPointer.findUnique({
        where: { projectId },
        include: { generation: true },
      });
      assert.notEqual(indexedPointer, null);
      crossProjectId = randomUUID();
      await db.project.create({
        data: {
          id: crossProjectId,
          name: `Intelligence cross project ${suffix}`,
          slug: `intelligence-cross-${suffix}`,
        },
      });
      await assert.rejects(
        () => db.memoryIndexGeneration.create({
          data: {
            projectId: crossProjectId!,
            providerConnectionId: provider.id,
            modelId: "embedding-test",
            dimensions: 8,
            inputManifestFingerprint: "e".repeat(64),
            expectedActiveIndexGenerationId: indexedPointer!.generation.id,
          },
        }),
        (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003",
      );
      const sameProjectGeneration = await db.memoryIndexGeneration.create({
        data: {
          projectId,
          providerConnectionId: provider.id,
          modelId: "embedding-test",
          dimensions: 8,
          inputManifestFingerprint: "f".repeat(64),
          expectedActiveIndexGenerationId: indexedPointer!.generation.id,
        },
      });
      sameProjectGenerationId = sameProjectGeneration.id;
      assert.equal(sameProjectGeneration.expectedActiveIndexGenerationId, indexedPointer!.generation.id);

      const briefJob = await runProjectBriefJob({
        projectId,
        requestedBy: user,
        clientKey: `brief-${suffix}`,
        consent,
      }, db);
      assert.equal(briefJob.status, "succeeded");
      const report = await db.projectIntelligenceReport.findFirstOrThrow({ where: { projectId } });
      const reportCitations = report.citations as Array<{ id: string; contentHash: string }>;
      assert.equal(reportCitations.length >= 1, true);
      assert.equal(reportCitations.every((citation) => /^[0-9a-f-]{36}$/u.test(citation.id)), true);
      assert.equal(reportCitations.every((citation) => citation.contentHash.length === 64), true);

      const agentJob = await runProjectAgentJob({
        projectId,
        requestedBy: user,
        clientKey: `agent-${suffix}`,
        consent,
        question: "项目目前采用了什么方案，还有哪些风险？",
      }, db);
      assert.equal(agentJob.status, "succeeded");
      const run = await db.projectAgentRun.findFirstOrThrow({ where: { projectId } });
      const plan = run.plan as { calls: Array<{ tool: string }> };
      const trace = run.trace as Array<{ tool: string; resultCount: number; evidenceIds: string[] }>;
      assert.deepEqual(plan.calls.map((call) => call.tool), [
        "project_overview",
        "confirmed_items",
        "memory_search",
        "repository_status",
      ]);
      assert.equal(trace.every((entry) => PROJECT_AGENT_TOOLS.includes(entry.tool as typeof PROJECT_AGENT_TOOLS[number])), true);
      assert.equal(trace.some((entry) => entry.tool === "memory_search" && entry.resultCount > 0), true);
      assert.equal(trace.every((entry) => entry.evidenceIds.every((id) => /^[0-9a-f-]{36}$/u.test(id))), true);
      assert.match(run.answer, /统一记忆索引/u);

      const status = await listProjectIntelligence(projectId, db);
      assert.equal(status.readiness.ready, true);
      assert.equal(status.reports.length, 1);
      assert.equal(status.agentRuns.length, 1);
      assert.deepEqual(status.tools, PROJECT_AGENT_TOOLS);

      const audits = await db.providerCallAudit.findMany({ where: { job: { projectId } } });
      assert.equal(audits.every((audit) => audit.status === "succeeded"), true);
      assert.equal(audits.length, 6);
      assert.equal(await db.webAiGrant.count({ where: { projectId } }), 5);
      assert.equal(chatCalls, 3);
      const projectAgentJobCountBeforeRouteChange = await db.backgroundJob.count({
        where: { projectId, kind: "projectAgent" },
      });
      const providerCallCountBeforeRouteChange = audits.length;
      const chatCallsBeforeRouteChange = chatCalls;
      const previousAgentJob = await db.backgroundJob.findUniqueOrThrow({
        where: { id: agentJob.id },
        select: { id: true, status: true, stage: true, failureCode: true, result: true, completedAt: true },
      });

      const alternateProvider = await createProviderConnection({
        name: `V2.1 alternate ${suffix}`,
        kind: "openai",
        apiKey: "sk-v2-1-intelligence-secret",
        generationModelId: "generation-test",
        embeddingModelId: "embedding-test",
        embeddingDimensions: 8,
      }, db);
      alternateProviderId = alternateProvider.id;
      const alternateProviderRow = await db.aiProviderConnection.update({
        where: { id: alternateProvider.id },
        data: { status: "verified", lastTestedAt: new Date() },
      });
      alternateCredentialId = alternateProviderRow.credentialId;
      const pointerBeforeRouteChange = await db.memoryIndexPointer.findUnique({
        where: { projectId },
        include: { generation: true },
      });
      assert.notEqual(pointerBeforeRouteChange, null);
      await upsertProjectAiRoute(projectId, {
        operation: "embedding",
        providerConnectionId: alternateProvider.id,
        modelId: "embedding-test",
        embeddingDimensions: 8,
        maxOutputTokens: 128,
        acknowledgeIndexRebuild: true,
      }, db);
      const pointerAfterRouteChange = await db.memoryIndexPointer.findUnique({
        where: { projectId },
        include: { generation: true },
      });
      assert.equal(pointerAfterRouteChange?.indexGenerationId, pointerBeforeRouteChange?.indexGenerationId);
      assert.equal(pointerAfterRouteChange?.generation.status, "complete");
      const incompatible = await listProjectIntelligence(projectId, db);
      assert.equal(incompatible.readiness.activeIndex, true);
      assert.equal(incompatible.readiness.indexCompatible, false);
      assert.equal(incompatible.readiness.ready, false);
      await assert.rejects(
        () => runProjectAgentJob({
          projectId,
          requestedBy: user,
          clientKey: `agent-incompatible-${suffix}`,
          consent,
          question: "当前状态如何？",
        }, db),
        (error: unknown) => error instanceof Error && error.message === "SEMANTIC_INDEX_NOT_READY",
      );
      assert.equal(await db.backgroundJob.count({
        where: { projectId, kind: "projectAgent" },
      }), projectAgentJobCountBeforeRouteChange);
      const agentJobAfterRejectedPreflight = await db.backgroundJob.findUniqueOrThrow({
        where: { id: agentJob.id },
        select: { id: true, status: true, stage: true, failureCode: true, result: true, completedAt: true },
      });
      assert.deepEqual(agentJobAfterRejectedPreflight, previousAgentJob);
      assert.equal(await db.providerCallAudit.count({ where: { job: { projectId } } }), providerCallCountBeforeRouteChange);
      assert.equal(chatCalls, chatCallsBeforeRouteChange);

      const interruptedWorkflowJob = await db.backgroundJob.create({
        data: {
          id: randomUUID(),
          projectId,
          kind: "projectAgent",
          requestedById: user.id,
          idempotencyKey: (`audit-${suffix}`).padEnd(64, "a"),
          payload: {},
        },
      });
      const interruptedWorkflowClaim = await claimProjectJob(interruptedWorkflowJob.id, db);
      assert.notEqual(interruptedWorkflowClaim, false);
      if (interruptedWorkflowClaim === false) return;
      const runningAudit = await db.providerCallAudit.create({
        data: {
          jobId: interruptedWorkflowJob.id,
          providerConnectionId: provider.id,
          operation: "projectAnalysis",
          modelId: "generation-test",
          status: "running",
        },
      });
      await db.backgroundJobAttempt.update({
        where: { id: interruptedWorkflowClaim.attemptId },
        data: { leaseExpiresAt: new Date(Date.now() - 1) },
      });
      const reconciledWorkflowJob = await reconcileProjectJob(projectId, interruptedWorkflowJob.id, user.id, db);
      assert.equal(reconciledWorkflowJob.status, "unknown");
      const reconciledAudit = await db.providerCallAudit.findUniqueOrThrow({ where: { id: runningAudit.id } });
      assert.equal(reconciledAudit.status, "unknown");
      assert.equal(reconciledAudit.safeErrorCode, "RECONCILIATION_REQUIRED");
      assert.notEqual(reconciledAudit.completedAt, null);
    } finally {
      globalThis.fetch = previousFetch;
      if (sameProjectGenerationId !== null) await db.memoryIndexGeneration.deleteMany({ where: { id: sameProjectGenerationId } });
      await db.project.deleteMany({ where: { id: projectId } });
      if (crossProjectId !== null) await db.project.deleteMany({ where: { id: crossProjectId } });
      if (alternateProviderId !== null) await db.aiProviderConnection.deleteMany({ where: { id: alternateProviderId } });
      if (alternateCredentialId !== null) await db.externalCredential.deleteMany({ where: { id: alternateCredentialId } });
      if (providerId !== null) await db.aiProviderConnection.deleteMany({ where: { id: providerId } });
      if (credentialId !== null) await db.externalCredential.deleteMany({ where: { id: credentialId } });
      if (createdUserId !== null) await db.appUser.deleteMany({ where: { id: createdUserId } });
      await unlink(masterKeyPath).catch(() => undefined);
      if (previousKeyPath === undefined) delete process.env.AI_PROJECT_OS_MASTER_KEY_FILE;
      else process.env.AI_PROJECT_OS_MASTER_KEY_FILE = previousKeyPath;
    }
  },
);
