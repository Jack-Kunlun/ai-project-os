import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getDb } from "@/lib/db";
import { isSafeExternalRef } from "@/lib/source";
import {
  loadProjectAiPublicVisibility,
  projectAiModelProjection,
  projectAiProviderProjection,
} from "@/lib/project-ai-public-projection";
import {
  loadQuarantinedProjectLineage,
  nonLegacyMcpMemoryGenerationWhere,
  nonLegacyMcpProjectAssetSegmentWhere,
  nonLegacyMcpProjectItemWhere,
  nonLegacyMcpProjectSourceLineageWhere,
  nonLegacyMcpProjectWorkItemWhere,
  referencesQuarantinedProjectLineage,
} from "@/lib/legacy-mcp-source-quarantine";
import { withWebAiProjectAccessTransaction, type WebAiActor } from "@/lib/access-linearization";
import { isSerializationConflict } from "@/lib/project-snapshot-errors";

export const PROJECT_EXPORT_SCHEMA_VERSION = "ai-project-os.project-export.v3";
export const PROJECT_EXPORT_MAX_BYTES = 20 * 1024 * 1024;
const PROJECT_EXPORT_TRANSACTION_RETRY_LIMIT = 3;

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

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

const PRIVATE_EXPORT_METADATA_KEYS = new Set([
  "providerconnectionid",
  "credentialid",
  "delegationid",
  "grantid",
  "secretfingerprint",
  "credentialsecretfingerprint",
  "routefencefingerprint",
  "ciphertext",
  "nonce",
  "authtag",
  "apikey",
  "secret",
  "providerrequestid",
  "idempotencykey",
  "leasetoken",
  "leasetokenhash",
]);

export function sanitizeProjectExportMetadata(value: Prisma.JsonValue): Prisma.JsonValue {
  if (Array.isArray(value)) return value.map((entry) => sanitizeProjectExportMetadata(entry));
  if (value !== null && typeof value === "object") {
    const result: Prisma.JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      if (PRIVATE_EXPORT_METADATA_KEYS.has(key.toLowerCase())) continue;
      result[key] = sanitizeProjectExportMetadata(entry as Prisma.JsonValue);
    }
    return result;
  }
  return value;
}

export async function exportProjectData(
  input: Readonly<{ projectId: string; actor: WebAiActor; expectedUpdatedAt: Date }>,
  db: PrismaClient = getDb(),
) {
  for (let attempt = 1; attempt <= PROJECT_EXPORT_TRANSACTION_RETRY_LIMIT; attempt += 1) {
    try {
      // Keep the whole export, including its audit, inside one snapshot. A
      // serialization failure from the row-locked admission must restart the
      // complete transaction so no cross-table mix can escape to the caller.
      return await withWebAiProjectAccessTransaction(
        db,
        {
          actor: input.actor,
          projectId: input.projectId,
          required: "owner",
          allowArchived: true,
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        },
        async (tx, admission) => {
      const project = await tx.project.findUnique({
        where: { id: input.projectId },
        select: { id: true, name: true, slug: true, description: true, archivedAt: true, createdAt: true, updatedAt: true },
      });
      if (project === null) throw new ProjectExportError("PROJECT_EXPORT_NOT_FOUND");
      if (project.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
        throw new ProjectExportError("PROJECT_EXPORT_STALE");
      }
      const visibility = await loadProjectAiPublicVisibility(tx, input.projectId, admission.actor.id);

      const [sources, assets, items, repositories, lifecycle, jobs, answers, reports, agentRuns, actionResultImports, objectives, workItems, dependencies, planAudits, quarantinedLineage] = await Promise.all([
        tx.projectSource.findMany({
          where: { projectId: input.projectId, ...nonLegacyMcpProjectSourceLineageWhere },
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
            retiredAt: true,
          },
        }),
        tx.projectAsset.findMany({
          where: { projectId: input.projectId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            displayName: true,
            kind: true,
            status: true,
            deletedAt: true,
            createdAt: true,
            updatedAt: true,
            uploadedBy: { select: { username: true } },
            versions: {
              orderBy: { version: "asc" },
              select: {
                id: true,
                version: true,
                originalFileName: true,
                mimeType: true,
                sizeBytes: true,
                contentHash: true,
                status: true,
                parserVersion: true,
                failureCode: true,
                processingStartedAt: true,
                completedAt: true,
                createdAt: true,
                segments: {
                  where: nonLegacyMcpProjectAssetSegmentWhere,
                  orderBy: { ordinal: "asc" },
                  select: {
                    id: true,
                    ordinal: true,
                    locatorKind: true,
                    locatorLabel: true,
                    pageNumber: true,
                    slideNumber: true,
                    sheetName: true,
                    cellRange: true,
                    extractionMethod: true,
                    contentText: true,
                    contentHash: true,
                    reviewedText: true,
                    reviewStatus: true,
                    reviewedAt: true,
                    modelId: true,
                    projectSourceId: true,
                    providerConnection: { select: { name: true, kind: true, scope: true, ownerUserId: true, status: true } },
                    reviewedBy: { select: { username: true } },
                  },
                },
              },
            },
          },
        }),
        tx.projectItem.findMany({
          where: { projectId: input.projectId, ...nonLegacyMcpProjectItemWhere },
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
          where: {
            projectId: input.projectId,
            indexGeneration: { is: nonLegacyMcpMemoryGenerationWhere },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            modelId: true,
            question: true,
            answer: true,
            citations: true,
            inputTokens: true,
            outputTokens: true,
            createdAt: true,
            providerConnection: { select: { name: true, kind: true, scope: true, ownerUserId: true, status: true } },
          },
        }),
        tx.projectIntelligenceReport.findMany({
          where: {
            projectId: input.projectId,
            indexGeneration: { is: nonLegacyMcpMemoryGenerationWhere },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            modelId: true,
            report: true,
            citations: true,
            inputTokens: true,
            outputTokens: true,
            createdAt: true,
            providerConnection: { select: { name: true, kind: true, scope: true, ownerUserId: true, status: true } },
          },
        }),
        tx.projectAgentRun.findMany({
          where: {
            projectId: input.projectId,
            indexGeneration: { is: nonLegacyMcpMemoryGenerationWhere },
          },
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
            providerConnection: { select: { name: true, kind: true, scope: true, ownerUserId: true, status: true } },
          },
        }),
        tx.projectActionResultImport.findMany({
          where: {
            projectId: input.projectId,
            projectSource: { is: nonLegacyMcpProjectSourceLineageWhere },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, actionId: true, projectSourceId: true, actionInputFingerprint: true, resultFingerprint: true, contentFingerprint: true, createdAt: true, importedBy: { select: { username: true } } },
        }),
        tx.projectObjective.findMany({
          where: { projectId: input.projectId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, title: true, description: true, status: true, targetDate: true, createdAt: true, updatedAt: true, completedAt: true, createdBy: { select: { username: true } } },
        }),
        tx.projectWorkItem.findMany({
          where: { projectId: input.projectId, ...nonLegacyMcpProjectWorkItemWhere },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, objectiveId: true, title: true, description: true, status: true, priority: true, targetDate: true, origin: true, agentRunId: true, recommendationIndex: true, evidenceSnapshot: true, evidenceFingerprint: true, createdAt: true, updatedAt: true, completedAt: true, createdBy: { select: { username: true } } },
        }),
        tx.projectWorkItemDependency.findMany({
          where: {
            projectId: input.projectId,
            workItem: { is: nonLegacyMcpProjectWorkItemWhere },
            dependsOn: { is: nonLegacyMcpProjectWorkItemWhere },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, workItemId: true, dependsOnId: true, createdAt: true, removedAt: true, createdBy: { select: { username: true } }, removedBy: { select: { username: true } } },
        }),
        tx.projectPlanAudit.findMany({
          where: { projectId: input.projectId },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true, entityType: true, entityId: true, event: true, details: true, createdAt: true, actor: { select: { username: true } } },
        }),
        loadQuarantinedProjectLineage(input.projectId, tx),
      ]);

      const publicPlanAudits = planAudits.filter((audit) =>
        !(audit.entityType === "workItem" && quarantinedLineage.workItemIds.has(audit.entityId))
        && !(audit.entityType === "evidenceLink" && quarantinedLineage.evidenceLinkIds.has(audit.entityId))
        && !referencesQuarantinedProjectLineage(audit.details, quarantinedLineage));

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
          retiredAt: iso(source.retiredAt),
        })),
        assets: assets.map((asset) => ({
          ...asset,
          deletedAt: iso(asset.deletedAt),
          createdAt: asset.createdAt.toISOString(),
          updatedAt: asset.updatedAt.toISOString(),
          versions: asset.versions.map((version) => ({
            ...version,
            sizeBytes: version.sizeBytes.toString(),
            processingStartedAt: iso(version.processingStartedAt),
            completedAt: iso(version.completedAt),
            createdAt: version.createdAt.toISOString(),
            segments: version.segments.map((segment) => {
              const provider = segment.providerConnection;
              return {
                ...segment,
                modelId: provider === null || segment.modelId === null
                  ? null
                  : projectAiModelProjection(segment.modelId, provider, visibility),
                providerConnection: provider === null ? null : projectAiProviderProjection(provider, visibility),
                reviewedAt: iso(segment.reviewedAt),
              };
            }),
          })),
        })),
        items: items.map((item) => ({
          ...item,
          metadata: sanitizeProjectExportMetadata(item.metadata),
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
            metadata: sanitizeProjectExportMetadata(revision.metadata),
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
        ragAnswers: answers.map((answer) => ({
          ...answer,
          modelId: projectAiModelProjection(answer.modelId, answer.providerConnection, visibility),
          providerConnection: projectAiProviderProjection(answer.providerConnection, visibility),
          citations: sanitizeProjectExportMetadata(answer.citations),
          createdAt: answer.createdAt.toISOString(),
        })),
        intelligenceReports: reports.map((report) => ({
          ...report,
          modelId: projectAiModelProjection(report.modelId, report.providerConnection, visibility),
          providerConnection: projectAiProviderProjection(report.providerConnection, visibility),
          report: sanitizeProjectExportMetadata(report.report),
          citations: sanitizeProjectExportMetadata(report.citations),
          createdAt: report.createdAt.toISOString(),
        })),
        agentRuns: agentRuns.map((run) => ({
          ...run,
          modelId: projectAiModelProjection(run.modelId, run.providerConnection, visibility),
          providerConnection: projectAiProviderProjection(run.providerConnection, visibility),
          plan: sanitizeProjectExportMetadata(run.plan),
          trace: sanitizeProjectExportMetadata(run.trace),
          recommendations: sanitizeProjectExportMetadata(run.recommendations),
          uncertainties: sanitizeProjectExportMetadata(run.uncertainties),
          citations: sanitizeProjectExportMetadata(run.citations),
          createdAt: run.createdAt.toISOString(),
        })),
        actionResultImports: actionResultImports.map((entry) => ({ ...entry, createdAt: entry.createdAt.toISOString() })),
        projectPlan: {
          objectives: objectives.map((objective) => ({ ...objective, targetDate: iso(objective.targetDate), createdAt: objective.createdAt.toISOString(), updatedAt: objective.updatedAt.toISOString(), completedAt: iso(objective.completedAt) })),
          workItems: workItems.map((workItem) => ({
            ...workItem,
            evidenceSnapshot: sanitizeProjectExportMetadata(workItem.evidenceSnapshot),
            targetDate: iso(workItem.targetDate),
            createdAt: workItem.createdAt.toISOString(),
            updatedAt: workItem.updatedAt.toISOString(),
            completedAt: iso(workItem.completedAt),
          })),
          dependencies: dependencies.map((dependency) => ({ ...dependency, createdAt: dependency.createdAt.toISOString(), removedAt: iso(dependency.removedAt) })),
          audits: publicPlanAudits.map((audit) => ({ ...audit, details: sanitizeProjectExportMetadata(audit.details), createdAt: audit.createdAt.toISOString() })),
        },
        exclusions: [
          "系统凭据库中的 API Key、GitHub PAT 及加密密钥材料",
          "向量与索引内部记录",
          "原始任务 payload/result、幂等键、租约令牌和供应商请求 ID",
          "仓库代码文件正文、扫描中间账本和完整数据库备份数据",
          "上传文件的原始二进制内容与服务端存储路径；请同时备份 ai-project-os-uploads 卷",
        ],
      } as const;
      const json = `${JSON.stringify(document, null, 2)}\n`;
      const byteCount = Buffer.byteLength(json, "utf8");
      if (byteCount > PROJECT_EXPORT_MAX_BYTES) throw new ProjectExportError("PROJECT_EXPORT_TOO_LARGE");
      const contentHash = createHash("sha256").update(json, "utf8").digest("hex");
      const audit = await tx.projectDataExportAudit.create({
        data: {
          projectId: input.projectId,
          requestedById: admission.actor.id,
          schemaVersion: PROJECT_EXPORT_SCHEMA_VERSION,
          contentHash,
          byteCount,
        },
        select: { id: true, schemaVersion: true, contentHash: true, byteCount: true, createdAt: true },
      });
      return Object.freeze({ json, audit });
        },
      );
    } catch (error) {
      if (isSerializationConflict(error) && attempt < PROJECT_EXPORT_TRANSACTION_RETRY_LIMIT) continue;
      if (isSerializationConflict(error)) throw new ProjectExportError("PROJECT_EXPORT_CONFLICT");
      throw error;
    }
  }
  throw new ProjectExportError("PROJECT_EXPORT_CONFLICT");
}
