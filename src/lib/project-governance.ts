import { Prisma, type AiOperation, type BackgroundJobKind, type BackgroundJobStatus, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { toPublicProjectJob } from "@/lib/project-workflow";
import { getProjectMemoryIndexStatus } from "@/lib/web-memory-index";

export const GOVERNANCE_DEFAULT_LIMIT = 20;
export const GOVERNANCE_MAX_LIMIT = 50;

export type ProjectGovernanceErrorCode = "GOVERNANCE_CURSOR_INVALID" | "GOVERNANCE_LIMIT_INVALID";

export class ProjectGovernanceError extends Error {
  constructor(readonly code: ProjectGovernanceErrorCode) {
    super(code);
    this.name = "ProjectGovernanceError";
  }
}

const reviewSources = ["verified", "web"] as const;
export type GovernanceReviewSource = (typeof reviewSources)[number];

const reviewCursorSchema = z.object({
  v: z.literal(1),
  kind: z.literal("reviews"),
  createdAt: z.string().datetime({ offset: true }),
  source: z.enum(reviewSources),
  id: z.string().uuid(),
}).strict();

const listCursorSchema = z.object({
  v: z.literal(1),
  kind: z.enum(["operations", "routes"]),
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
}).strict();

export type GovernanceReviewCursor = z.infer<typeof reviewCursorSchema>;
export type GovernanceListCursor = z.infer<typeof listCursorSchema>;

export type GovernanceJobCapability = Readonly<{
  action: "reconcile" | "cancel" | null;
  reason: "available" | "specializedReconciliationRequired" | "terminal" | "running";
}>;

export type GovernanceReview = Readonly<{
  source: GovernanceReviewSource;
  id: string;
  createdAt: string;
  model: Readonly<{
    providerName: string | null;
    providerKind: string | null;
    modelId: string;
  }>;
  evidence: Readonly<{
    sourceId: string;
    sourceKind: string;
    contentHash: string;
    excerpt: string;
  }>;
  item: Readonly<{
    id: string;
    type: "decision" | "progress" | "issue" | "risk";
    title: string;
    content: string;
    occurredAt: string | null;
    updatedAt: string;
  }>;
}>;

type ReviewCursorFilter = {
  OR?: Array<{
    createdAt: Date | { lt?: Date; equals?: Date };
    id?: { gt: string };
  }>;
  createdAt?: { lt: Date };
};

const sourceRank: Readonly<Record<GovernanceReviewSource, number>> = Object.freeze({ verified: 0, web: 1 });

function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursorText(value: string): unknown {
  if (value.length < 1 || value.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ProjectGovernanceError("GOVERNANCE_CURSOR_INVALID");
  }
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) throw new Error("non-canonical");
    return JSON.parse(decoded) as unknown;
  } catch {
    throw new ProjectGovernanceError("GOVERNANCE_CURSOR_INVALID");
  }
}

export function encodeGovernanceReviewCursor(input: Omit<GovernanceReviewCursor, "v" | "kind">): string {
  return encodeCursor({ v: 1, kind: "reviews", ...input });
}

export function decodeGovernanceReviewCursor(value: string): GovernanceReviewCursor {
  const parsed = reviewCursorSchema.safeParse(decodeCursorText(value));
  if (!parsed.success) throw new ProjectGovernanceError("GOVERNANCE_CURSOR_INVALID");
  return parsed.data;
}

export function encodeGovernanceListCursor(
  kind: GovernanceListCursor["kind"],
  input: Pick<GovernanceListCursor, "createdAt" | "id">,
): string {
  return encodeCursor({ v: 1, kind, ...input });
}

export function decodeGovernanceListCursor(
  kind: GovernanceListCursor["kind"],
  value: string,
): GovernanceListCursor {
  const parsed = listCursorSchema.safeParse(decodeCursorText(value));
  if (!parsed.success || parsed.data.kind !== kind) throw new ProjectGovernanceError("GOVERNANCE_CURSOR_INVALID");
  return parsed.data;
}

function reviewCursorFilter(source: GovernanceReviewSource, cursor: GovernanceReviewCursor | null): ReviewCursorFilter {
  if (cursor === null) return {};
  const createdAt = new Date(cursor.createdAt);
  if (sourceRank[source] < sourceRank[cursor.source]) return { createdAt: { lt: createdAt } };
  if (sourceRank[source] > sourceRank[cursor.source]) {
    return { OR: [{ createdAt: { lt: createdAt } }, { createdAt }] };
  }
  return {
    OR: [
      { createdAt: { lt: createdAt } },
      { createdAt: { equals: createdAt }, id: { gt: cursor.id } },
    ],
  };
}

function listCursorFilter(cursor: GovernanceListCursor | null) {
  if (cursor === null) return {};
  const createdAt = new Date(cursor.createdAt);
  return {
    OR: [
      { createdAt: { lt: createdAt } },
      { createdAt: { equals: createdAt }, id: { gt: cursor.id } },
    ],
  };
}

export function compareGovernanceReviews(left: GovernanceReview, right: GovernanceReview): number {
  const time = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (time !== 0) return time;
  const source = sourceRank[left.source] - sourceRank[right.source];
  if (source !== 0) return source;
  return left.id.localeCompare(right.id);
}

export function governanceJobCapability(input: Readonly<{
  kind: BackgroundJobKind;
  status: BackgroundJobStatus;
  reconciliationRequired: boolean;
}>): GovernanceJobCapability {
  if (input.status === "queued" || input.status === "waitingConsent") {
    return Object.freeze({ action: "cancel", reason: "available" });
  }
  if (input.status === "unknown" && input.reconciliationRequired) {
    if (input.kind === "githubScan" || input.kind === "githubMaterialSync") {
      return Object.freeze({ action: null, reason: "specializedReconciliationRequired" });
    }
    return Object.freeze({ action: "reconcile", reason: "available" });
  }
  if (input.status === "running") return Object.freeze({ action: null, reason: "running" });
  return Object.freeze({ action: null, reason: "terminal" });
}

type WebReviewRow = Readonly<{
  id: string;
  modelId: string;
  createdAt: Date;
  providerConnection: Readonly<{ name: string; kind: string }>;
  source: Readonly<{ id: string; kind: string; contentHash: string }>;
  projectItem: Readonly<{
    id: string;
    type: "decision" | "progress" | "issue" | "risk";
    title: string;
    content: string;
    sourceExcerpt: string | null;
    occurredAt: Date | null;
    updatedAt: Date;
  }>;
}>;

type VerifiedReviewRow = Readonly<{
  id: string;
  modelId: string;
  createdAt: Date;
  sourceExcerpt: string;
  source: Readonly<{ id: string; kind: string; contentHash: string }>;
  projectItem: Readonly<{
    id: string;
    type: "decision" | "progress" | "issue" | "risk";
    title: string;
    content: string;
    occurredAt: Date | null;
    updatedAt: Date;
  }>;
}>;

export function toGovernanceWebReview(row: WebReviewRow): GovernanceReview {
  return Object.freeze({
    source: "web",
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    model: Object.freeze({
      providerName: row.providerConnection.name,
      providerKind: row.providerConnection.kind,
      modelId: row.modelId,
    }),
    evidence: Object.freeze({
      sourceId: row.source.id,
      sourceKind: row.source.kind,
      contentHash: row.source.contentHash,
      excerpt: row.projectItem.sourceExcerpt ?? "",
    }),
    item: Object.freeze({
      id: row.projectItem.id,
      type: row.projectItem.type,
      title: row.projectItem.title,
      content: row.projectItem.content,
      occurredAt: row.projectItem.occurredAt?.toISOString() ?? null,
      updatedAt: row.projectItem.updatedAt.toISOString(),
    }),
  });
}

export function toGovernanceVerifiedReview(row: VerifiedReviewRow): GovernanceReview {
  return Object.freeze({
    source: "verified",
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    model: Object.freeze({ providerName: null, providerKind: null, modelId: row.modelId }),
    evidence: Object.freeze({
      sourceId: row.source.id,
      sourceKind: row.source.kind,
      contentHash: row.source.contentHash,
      excerpt: row.sourceExcerpt,
    }),
    item: Object.freeze({
      id: row.projectItem.id,
      type: row.projectItem.type,
      title: row.projectItem.title,
      content: row.projectItem.content,
      occurredAt: row.projectItem.occurredAt?.toISOString() ?? null,
      updatedAt: row.projectItem.updatedAt.toISOString(),
    }),
  });
}

async function projectExists(projectId: string, db: PrismaClient): Promise<boolean> {
  return (await db.project.findUnique({ where: { id: projectId }, select: { id: true } })) !== null;
}

export async function getProjectGovernanceSummary(projectId: string, db: PrismaClient = getDb()) {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } });
  if (project === null) return null;
  const [
    webPending,
    verifiedPending,
    unknownJobs,
    failedJobs,
    githubPartial,
    githubRateLimited,
    githubUnknown,
    latestInvalidation,
    memory,
  ] = await Promise.all([
    db.webAiCandidate.count({ where: { projectId, reviewStatus: "candidate" } }),
    db.aiCandidateClaim.count({ where: { projectId, reviewStatus: "candidate" } }),
    db.backgroundJob.count({ where: { projectId, status: "unknown", reconciliationRequired: true } }),
    db.backgroundJob.count({ where: { projectId, status: "failed" } }),
    db.projectGitHubSyncRun.count({ where: { projectId, status: "partial" } }),
    db.projectGitHubSyncRun.count({ where: { projectId, status: "rateLimited" } }),
    db.projectGitHubSyncRun.count({ where: { projectId, status: "unknown" } }),
    db.projectAiRouteRevision.findFirst({
      where: { projectId, indexInvalidated: true },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      select: { id: true, operation: true, createdAt: true },
    }),
    getProjectMemoryIndexStatus(projectId, db),
  ]);
  const indexRisk = memory.readiness === "ready" ? 0 : 1;
  return Object.freeze({
    project,
    pendingReviews: Object.freeze({ web: webPending, verified: verifiedPending, total: webPending + verifiedPending }),
    jobs: Object.freeze({ reconciliationRequired: unknownJobs, failed: failedJobs }),
    github: Object.freeze({ partial: githubPartial, rateLimited: githubRateLimited, unknown: githubUnknown }),
    index: Object.freeze({
      readiness: memory.readiness,
      compatible: memory.compatible,
      activeRecordCount: memory.activeIndex?.generation.recordCount ?? 0,
      publishedAt: memory.activeIndex?.publishedAt.toISOString() ?? null,
    }),
    latestIndexInvalidation: latestInvalidation === null ? null : Object.freeze({
      id: latestInvalidation.id,
      operation: latestInvalidation.operation,
      createdAt: latestInvalidation.createdAt.toISOString(),
    }),
    attentionTotal: webPending + verifiedPending + unknownJobs + failedJobs + githubPartial + githubRateLimited + githubUnknown + indexRisk,
  });
}

export async function listGovernanceReviews(
  projectId: string,
  input: Readonly<{ cursor?: string; limit?: number; search?: string; itemType?: "decision" | "progress" | "issue" | "risk" }> = {},
  db: PrismaClient = getDb(),
) {
  if (!(await projectExists(projectId, db))) return null;
  const limit = input.limit ?? GOVERNANCE_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > GOVERNANCE_MAX_LIMIT) throw new ProjectGovernanceError("GOVERNANCE_LIMIT_INVALID");
  const cursor = input.cursor === undefined ? null : decodeGovernanceReviewCursor(input.cursor);
  const projectItemFilter: Prisma.ProjectItemWhereInput = {
    ...(input.itemType ? { type: input.itemType } : {}),
    ...(input.search ? {
      OR: [
        { title: { contains: input.search, mode: "insensitive" } },
        { content: { contains: input.search, mode: "insensitive" } },
        { sourceExcerpt: { contains: input.search, mode: "insensitive" } },
      ],
    } : {}),
  };
  const hasProjectItemFilter = input.itemType !== undefined || Boolean(input.search);
  const [webRows, verifiedRows] = await Promise.all([
    db.webAiCandidate.findMany({
      where: { projectId, reviewStatus: "candidate", ...(hasProjectItemFilter ? { projectItem: projectItemFilter } : {}), ...reviewCursorFilter("web", cursor) },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: limit + 1,
      select: {
        id: true,
        modelId: true,
        createdAt: true,
        providerConnection: { select: { name: true, kind: true } },
        source: { select: { id: true, kind: true, contentHash: true } },
        projectItem: {
          select: { id: true, type: true, title: true, content: true, sourceExcerpt: true, occurredAt: true, updatedAt: true },
        },
      },
    }),
    db.aiCandidateClaim.findMany({
      where: { projectId, reviewStatus: "candidate", ...(hasProjectItemFilter ? { projectItem: projectItemFilter } : {}), ...reviewCursorFilter("verified", cursor) },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: limit + 1,
      select: {
        id: true,
        createdAt: true,
        sourceExcerpt: true,
        source: { select: { id: true, kind: true, contentHash: true } },
        projectItem: { select: { id: true, type: true, title: true, content: true, occurredAt: true, updatedAt: true } },
        batch: { select: { aiRun: { select: { modelId: true } } } },
      },
    }),
  ]);
  const merged = [
    ...webRows.map((row) => toGovernanceWebReview(row)),
    ...verifiedRows.map((row) => toGovernanceVerifiedReview({ ...row, modelId: row.batch.aiRun.modelId })),
  ].sort(compareGovernanceReviews);
  const items = merged.slice(0, limit);
  const last = items.at(-1);
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: merged.length > limit && last !== undefined
      ? encodeGovernanceReviewCursor({ createdAt: last.createdAt, source: last.source, id: last.id })
      : null,
  });
}

function sanitizeWarnings(value: Prisma.JsonValue): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.filter((entry): entry is string => typeof entry === "string").slice(0, 20).map((entry) => entry.slice(0, 256)));
}

export async function listGovernanceOperations(
  projectId: string,
  input: Readonly<{ cursor?: string; limit?: number; search?: string; kind?: BackgroundJobKind; status?: BackgroundJobStatus }> = {},
  db: PrismaClient = getDb(),
) {
  if (!(await projectExists(projectId, db))) return null;
  const limit = input.limit ?? GOVERNANCE_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > GOVERNANCE_MAX_LIMIT) throw new ProjectGovernanceError("GOVERNANCE_LIMIT_INVALID");
  const cursor = input.cursor === undefined ? null : decodeGovernanceListCursor("operations", input.cursor);
  const rows = await db.backgroundJob.findMany({
    where: {
      projectId,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.status ? { status: input.status } : {}),
      AND: [
        listCursorFilter(cursor),
        ...(input.search ? [{
          OR: [
            { stage: { contains: input.search, mode: "insensitive" as const } },
            { failureCode: { contains: input.search, mode: "insensitive" as const } },
          ],
        }] : []),
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: limit + 1,
    select: {
      id: true,
      projectId: true,
      kind: true,
      status: true,
      stage: true,
      result: true,
      progressCurrent: true,
      progressTotal: true,
      failureCode: true,
      reconciliationRequired: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
      githubSyncRun: {
        select: {
          id: true,
          status: true,
          warnings: true,
          failureCode: true,
          addedCount: true,
          updatedCount: true,
          deletedCount: true,
          withheldCount: true,
        },
      },
    },
  });
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map((row) => {
    const publicJob = toPublicProjectJob(row);
    return Object.freeze({
      ...publicJob,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      capability: governanceJobCapability(row),
      destination: `/projects/${projectId}/jobs/${row.id}`,
      githubSync: row.githubSyncRun === null ? null : Object.freeze({
        id: row.githubSyncRun.id,
        status: row.githubSyncRun.status,
        warnings: sanitizeWarnings(row.githubSyncRun.warnings),
        failureCode: row.githubSyncRun.failureCode,
        counts: Object.freeze({
          added: row.githubSyncRun.addedCount,
          updated: row.githubSyncRun.updatedCount,
          deleted: row.githubSyncRun.deletedCount,
          withheld: row.githubSyncRun.withheldCount,
        }),
      }),
    });
  });
  const last = pageRows.at(-1);
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: rows.length > limit && last !== undefined
      ? encodeGovernanceListCursor("operations", { createdAt: last.createdAt.toISOString(), id: last.id })
      : null,
  });
}

export async function listGovernanceRouteRevisions(
  projectId: string,
  input: Readonly<{ cursor?: string; limit?: number; search?: string; operation?: AiOperation }> = {},
  db: PrismaClient = getDb(),
) {
  if (!(await projectExists(projectId, db))) return null;
  const limit = input.limit ?? GOVERNANCE_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > GOVERNANCE_MAX_LIMIT) throw new ProjectGovernanceError("GOVERNANCE_LIMIT_INVALID");
  const cursor = input.cursor === undefined ? null : decodeGovernanceListCursor("routes", input.cursor);
  const rows = await db.projectAiRouteRevision.findMany({
    where: {
      projectId,
      ...(input.operation ? { operation: input.operation } : {}),
      AND: [
        listCursorFilter(cursor),
        ...(input.search ? [{
          OR: [
            { oldModelId: { contains: input.search, mode: "insensitive" as const } },
            { newModelId: { contains: input.search, mode: "insensitive" as const } },
            { oldProviderConnection: { is: { name: { contains: input.search, mode: "insensitive" as const } } } },
            { newProviderConnection: { is: { name: { contains: input.search, mode: "insensitive" as const } } } },
          ],
        }] : []),
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: limit + 1,
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
  });
  const pageRows = rows.slice(0, limit);
  const items = pageRows.map((row) => Object.freeze({
    id: row.id,
    operation: row.operation,
    previous: row.oldModelId === null ? null : Object.freeze({
      providerName: row.oldProviderConnection?.name ?? null,
      providerKind: row.oldProviderConnection?.kind ?? null,
      modelId: row.oldModelId,
      embeddingDimensions: row.oldEmbeddingDimensions,
      maxOutputTokens: row.oldMaxOutputTokens,
    }),
    current: Object.freeze({
      providerName: row.newProviderConnection.name,
      providerKind: row.newProviderConnection.kind,
      modelId: row.newModelId,
      embeddingDimensions: row.newEmbeddingDimensions,
      maxOutputTokens: row.newMaxOutputTokens,
    }),
    onlyFutureRuns: row.onlyFutureRuns,
    indexInvalidated: row.indexInvalidated,
    activeIndexGenerationId: row.activeIndexGenerationId,
    actor: row.actor?.username ?? "system",
    createdAt: row.createdAt.toISOString(),
  }));
  const last = pageRows.at(-1);
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: rows.length > limit && last !== undefined
      ? encodeGovernanceListCursor("routes", { createdAt: last.createdAt.toISOString(), id: last.id })
      : null,
  });
}
