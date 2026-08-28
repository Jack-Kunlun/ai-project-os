import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getDb } from "@/lib/db";
import { isSafeExternalRef } from "@/lib/source";

export const PROJECT_EXPORT_SCHEMA_VERSION = "ai-project-os.project-export.v1";
export const PROJECT_EXPORT_MAX_BYTES = 20 * 1024 * 1024;

export type ProjectExportErrorCode =
  | "PROJECT_EXPORT_NOT_FOUND"
  | "PROJECT_EXPORT_STALE"
  | "PROJECT_EXPORT_TOO_LARGE"
  | "PROJECT_EXPORT_CONFLICT";

export class ProjectExportError extends Error {
  constructor(readonly code: ProjectExportErrorCode) {
    super(code);
    this.name = "ProjectExportError";
  }
}

function isSerializationConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

export async function exportProjectData(
  input: Readonly<{ projectId: string; requestedById: string; expectedUpdatedAt: Date }>,
  db: PrismaClient = getDb(),
) {
  try {
    return await db.$transaction(async (tx) => {
      const project = await tx.project.findUnique({
        where: { id: input.projectId },
        select: { id: true, name: true, slug: true, description: true, archivedAt: true, createdAt: true, updatedAt: true },
      });
      if (project === null) throw new ProjectExportError("PROJECT_EXPORT_NOT_FOUND");
      if (project.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
        throw new ProjectExportError("PROJECT_EXPORT_STALE");
      }

      const [sources, items, repositories, routes, routeRevisions, lifecycle, jobs, answers, reports, agentRuns] = await Promise.all([
        tx.projectSource.findMany({
          where: { projectId: input.projectId },
          orderBy: [{ ingestedAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            kind: true,
            originScope: true,
            projectRepositoryLinkId: true,
            sourceIdentity: true,
            revisionKey: true,
            externalRef: true,
            contentText: true,
            contentHash: true,
            capturedAt: true,
            ingestedAt: true,
          },
        }),
        tx.projectItem.findMany({
          where: { projectId: input.projectId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            type: true,
            reviewStatus: true,
            sourceId: true,
            title: true,
            content: true,
            sourceExcerpt: true,
            occurredAt: true,
            confirmedAt: true,
            supersedesItemId: true,
            metadata: true,
            createdAt: true,
            updatedAt: true,
            evidences: {
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              select: {
                id: true,
                role: true,
                evidenceState: true,
                originScope: true,
                projectRepositoryLinkId: true,
                projectSourceId: true,
                sourceExcerpt: true,
                sourceExcerptFingerprint: true,
                rangeUnit: true,
                rangeStart: true,
                rangeEnd: true,
                isActive: true,
                createdAt: true,
                supersededAt: true,
                purgedAt: true,
              },
            },
            revisions: {
              orderBy: [{ revisionNumber: "asc" }, { id: "asc" }],
              select: {
                id: true,
                revisionNumber: true,
                action: true,
                actorId: true,
                reason: true,
                itemType: true,
                reviewStatus: true,
                title: true,
                content: true,
                sourceId: true,
                sourceExcerpt: true,
                occurredAt: true,
                confirmedAt: true,
                supersedesItemId: true,
                metadata: true,
                evidenceManifestFingerprint: true,
                integrityState: true,
                createdAt: true,
              },
            },
          },
        }),
        tx.projectRepositoryLink.findMany({
          where: { projectId: input.projectId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            status: true,
            effectivePolicyVersion: true,
            createdAt: true,
            updatedAt: true,
            disabledAt: true,
            unlinkedAt: true,
            githubRepository: {
              select: {
                githubRepositoryId: true,
                currentOwner: true,
                currentName: true,
                currentFullName: true,
                isPrivate: true,
                isArchived: true,
                isDisabled: true,
                defaultBranch: true,
                lastVerifiedAt: true,
              },
            },
          },
        }),
        tx.projectAiRoute.findMany({
          where: { projectId: input.projectId },
          orderBy: [{ operation: "asc" }],
          select: {
            operation: true,
            modelId: true,
            embeddingDimensions: true,
            maxOutputTokens: true,
            createdAt: true,
            updatedAt: true,
            providerConnection: { select: { name: true, kind: true, status: true } },
          },
        }),
        tx.projectAiRouteRevision.findMany({
          where: { projectId: input.projectId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            operation: true,
            oldModelId: true,
            newModelId: true,
            oldEmbeddingDimensions: true,
            newEmbeddingDimensions: true,
            oldMaxOutputTokens: true,
            newMaxOutputTokens: true,
            onlyFutureRuns: true,
            indexInvalidated: true,
            activeIndexGenerationId: true,
            createdAt: true,
            oldProviderConnection: { select: { name: true, kind: true } },
            newProviderConnection: { select: { name: true, kind: true } },
            actor: { select: { username: true } },
          },
        }),
        tx.projectLifecycleRevision.findMany({
          where: { projectId: input.projectId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            action: true,
            previousArchivedAt: true,
            currentArchivedAt: true,
            projectUpdatedAt: true,
            createdAt: true,
            actor: { select: { username: true } },
          },
        }),
        tx.backgroundJob.findMany({
          where: { projectId: input.projectId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            kind: true,
            status: true,
            stage: true,
            progressCurrent: true,
            progressTotal: true,
            failureCode: true,
            reconciliationRequired: true,
            createdAt: true,
            startedAt: true,
            completedAt: true,
            requestedBy: { select: { username: true } },
          },
        }),
        tx.ragAnswer.findMany({
          where: { projectId: input.projectId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, modelId: true, question: true, answer: true, citations: true, inputTokens: true, outputTokens: true, createdAt: true },
        }),
        tx.projectIntelligenceReport.findMany({
          where: { projectId: input.projectId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, modelId: true, report: true, citations: true, inputTokens: true, outputTokens: true, createdAt: true },
        }),
        tx.projectAgentRun.findMany({
          where: { projectId: input.projectId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            modelId: true,
            question: true,
            plan: true,
            trace: true,
            answer: true,
            recommendations: true,
            uncertainties: true,
            citations: true,
            inputTokens: true,
            outputTokens: true,
            createdAt: true,
          },
        }),
      ]);

      const exportedAt = new Date();
      const document = {
        schemaVersion: PROJECT_EXPORT_SCHEMA_VERSION,
        exportedAt: exportedAt.toISOString(),
        project: {
          ...project,
          archivedAt: iso(project.archivedAt),
          createdAt: project.createdAt.toISOString(),
          updatedAt: project.updatedAt.toISOString(),
        },
        sources: sources.map((source) => ({
          ...source,
          externalRef: source.externalRef === null || isSafeExternalRef(source.externalRef) ? source.externalRef : null,
          capturedAt: iso(source.capturedAt),
          ingestedAt: source.ingestedAt.toISOString(),
        })),
        items: items.map((item) => ({
          ...item,
          occurredAt: iso(item.occurredAt),
          confirmedAt: iso(item.confirmedAt),
          createdAt: item.createdAt.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
          evidences: item.evidences.map((evidence) => ({
            ...evidence,
            createdAt: evidence.createdAt.toISOString(),
            supersededAt: iso(evidence.supersededAt),
            purgedAt: iso(evidence.purgedAt),
          })),
          revisions: item.revisions.map((revision) => ({
            ...revision,
            occurredAt: iso(revision.occurredAt),
            confirmedAt: iso(revision.confirmedAt),
            createdAt: revision.createdAt.toISOString(),
          })),
        })),
        repositories: repositories.map((link) => ({
          ...link,
          createdAt: link.createdAt.toISOString(),
          updatedAt: link.updatedAt.toISOString(),
          disabledAt: iso(link.disabledAt),
          unlinkedAt: iso(link.unlinkedAt),
          githubRepository: {
            ...link.githubRepository,
            githubRepositoryId: link.githubRepository.githubRepositoryId.toString(),
            lastVerifiedAt: link.githubRepository.lastVerifiedAt.toISOString(),
          },
        })),
        aiRoutes: routes.map((route) => ({ ...route, createdAt: route.createdAt.toISOString(), updatedAt: route.updatedAt.toISOString() })),
        aiRouteRevisions: routeRevisions.map((revision) => ({ ...revision, createdAt: revision.createdAt.toISOString() })),
        lifecycle: lifecycle.map((revision) => ({
          ...revision,
          previousArchivedAt: iso(revision.previousArchivedAt),
          currentArchivedAt: iso(revision.currentArchivedAt),
          projectUpdatedAt: revision.projectUpdatedAt.toISOString(),
          createdAt: revision.createdAt.toISOString(),
        })),
        jobs: jobs.map((job) => ({
          ...job,
          createdAt: job.createdAt.toISOString(),
          startedAt: iso(job.startedAt),
          completedAt: iso(job.completedAt),
        })),
        ragAnswers: answers.map((answer) => ({ ...answer, createdAt: answer.createdAt.toISOString() })),
        intelligenceReports: reports.map((report) => ({ ...report, createdAt: report.createdAt.toISOString() })),
        agentRuns: agentRuns.map((run) => ({ ...run, createdAt: run.createdAt.toISOString() })),
        exclusions: [
          "系统凭据库中的 API Key、GitHub PAT 及加密密钥材料",
          "向量与索引内部记录",
          "原始任务 payload/result、幂等键、租约令牌和供应商请求 ID",
          "仓库代码文件正文、扫描中间账本和完整数据库备份数据",
        ],
      } as const;
      const json = `${JSON.stringify(document, null, 2)}\n`;
      const byteCount = Buffer.byteLength(json, "utf8");
      if (byteCount > PROJECT_EXPORT_MAX_BYTES) throw new ProjectExportError("PROJECT_EXPORT_TOO_LARGE");
      const contentHash = createHash("sha256").update(json, "utf8").digest("hex");
      const audit = await tx.projectDataExportAudit.create({
        data: {
          projectId: input.projectId,
          requestedById: input.requestedById,
          schemaVersion: PROJECT_EXPORT_SCHEMA_VERSION,
          contentHash,
          byteCount,
        },
        select: { id: true, schemaVersion: true, contentHash: true, byteCount: true, createdAt: true },
      });
      return Object.freeze({ json, audit });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  } catch (error) {
    if (isSerializationConflict(error)) throw new ProjectExportError("PROJECT_EXPORT_CONFLICT");
    throw error;
  }
}
