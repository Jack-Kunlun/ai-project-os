import { createHash } from "node:crypto";
import { type Prisma, type PrismaClient } from "@prisma/client";
import { getDb } from "@/lib/db";

const ACTIVE_STATUSES = new Set(["planned", "inProgress", "blocked"]);

type HealthWorkItem = Readonly<{
  id: string;
  title: string;
  status: string;
  targetDate: Date | null;
  assigneeId: string | null;
  acceptanceCriteria: string | null;
  origin: string;
}>;

type HealthDependency = Readonly<{ workItemId: string; dependsOnId: string }>;
type HealthEvidence = Readonly<{ workItemId: string; stale: boolean }>;
type HealthImpact = Readonly<{ status: string }>;
type HealthAction = Readonly<{ status: string }>;

export type ProjectPlanHealthSignal = Readonly<{
  kind: "overdue" | "dueSoon" | "blocked" | "dependencyBlocked" | "unassigned" | "missingAcceptance" | "missingEvidence";
  severity: "warning" | "error";
  workItemId: string;
  title: string;
  targetDate: string | null;
  assigneeId: string | null;
}>;

export type ProjectPlanHealth = Readonly<{
  status: "healthy" | "attention" | "atRisk";
  dueSoonDays: number;
  counts: Readonly<{
    active: number;
    overdue: number;
    dueSoon: number;
    blocked: number;
    dependencyBlocked: number;
    unassigned: number;
    missingAcceptance: number;
    missingEvidence: number;
    staleEvidence: number;
    pendingRecommendations: number;
    openImpacts: number;
    pendingApprovals: number;
  }>;
  signals: readonly ProjectPlanHealthSignal[];
}>;

function canonicalValue(value: unknown, depth = 0): unknown {
  if (depth > 12) throw new Error("PROJECT_OPERATIONS_EVIDENCE_INVALID");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry, depth + 1));
  if (typeof value !== "object") throw new Error("PROJECT_OPERATIONS_EVIDENCE_INVALID");
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    output[key] = canonicalValue((value as Record<string, unknown>)[key], depth + 1);
  }
  return output;
}

function evidence(input: Record<string, unknown>) {
  const snapshot = canonicalValue(input) as Prisma.InputJsonObject;
  return Object.freeze({ snapshot, fingerprint: createHash("sha256").update(JSON.stringify(snapshot), "utf8").digest("hex") });
}

function compactLabel(value: string, fallback: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0) return fallback;
  return normalized.length <= 200 ? normalized : `${normalized.slice(0, 197)}…`;
}

export function buildProjectItemPlanEvidence(input: Readonly<{
  projectId: string;
  workItemId: string;
  item: Readonly<{
    id: string;
    type: string;
    reviewStatus: string;
    title: string;
    content: string;
    sourceExcerpt: string | null;
    updatedAt: Date;
    lastVerifiedAt: Date | null;
    sourceId: string;
    sourceContentHash: string;
  }>;
}>) {
  const result = evidence({
    schemaVersion: "ai-project-os/project-plan-evidence/v1",
    kind: "projectItem",
    projectId: input.projectId,
    workItemId: input.workItemId,
    item: {
      id: input.item.id,
      type: input.item.type,
      reviewStatus: input.item.reviewStatus,
      title: input.item.title,
      content: input.item.content,
      sourceExcerpt: input.item.sourceExcerpt,
      updatedAt: input.item.updatedAt.toISOString(),
      lastVerifiedAt: input.item.lastVerifiedAt?.toISOString() ?? null,
      sourceId: input.item.sourceId,
      sourceContentHash: input.item.sourceContentHash,
    },
  });
  return Object.freeze({ ...result, label: compactLabel(input.item.title, "已确认项目事实") });
}

export function buildProjectSourcePlanEvidence(input: Readonly<{
  projectId: string;
  workItemId: string;
  source: Readonly<{
    id: string;
    kind: string;
    externalRef: string | null;
    contentText: string;
    contentHash: string;
    capturedAt: Date | null;
    ingestedAt: Date;
  }>;
}>) {
  const excerpt = input.source.contentText.trim().replace(/\s+/gu, " ").slice(0, 1_000);
  const result = evidence({
    schemaVersion: "ai-project-os/project-plan-evidence/v1",
    kind: "projectSource",
    projectId: input.projectId,
    workItemId: input.workItemId,
    source: {
      id: input.source.id,
      kind: input.source.kind,
      externalRef: input.source.externalRef,
      contentHash: input.source.contentHash,
      capturedAt: input.source.capturedAt?.toISOString() ?? null,
      ingestedAt: input.source.ingestedAt.toISOString(),
      excerpt,
    },
  });
  return Object.freeze({ ...result, label: compactLabel(input.source.externalRef ?? excerpt, "项目资料来源") });
}

type RepositoryChange = Readonly<{
  identity: string;
  changeType: string;
  targetKind: string;
  normalizedPath: string | null;
  remoteIdentity: string | null;
  beforeContentHash: string | null;
  afterContentHash: string | null;
}>;

type RepositoryRun = Readonly<{
  id: string;
  manifestFingerprint: string;
  completedAt: Date;
  addedCount: number;
  updatedCount: number;
  deletedCount: number;
  withheldCount: number;
}>;

export function buildRepositoryImpactEvidence(input: Readonly<{
  projectId: string;
  run: RepositoryRun;
  changes: readonly RepositoryChange[];
}>) {
  const actionableChanges = input.changes
    .filter((change) => change.changeType === "added" || change.changeType === "updated" || change.changeType === "deleted")
    .sort((left, right) => left.identity.localeCompare(right.identity));
  const counts = { added: input.run.addedCount, updated: input.run.updatedCount, deleted: input.run.deletedCount };
  const totalChanges = counts.added + counts.updated + counts.deleted;
  const sampledChanges = actionableChanges.slice(0, 500).map((change) => ({
    identity: change.identity,
    changeType: change.changeType,
    targetKind: change.targetKind,
    normalizedPath: change.normalizedPath,
    remoteIdentity: change.remoteIdentity,
    beforeContentHash: change.beforeContentHash,
    afterContentHash: change.afterContentHash,
  }));
  const result = evidence({
    schemaVersion: "ai-project-os/repository-impact-signal/v1",
    projectId: input.projectId,
    repositorySyncRunId: input.run.id,
    manifestFingerprint: input.run.manifestFingerprint,
    completedAt: input.run.completedAt.toISOString(),
    counts,
    totalChanges,
    sampledChanges,
    truncated: totalChanges > sampledChanges.length,
  });
  const title = `仓库同步产生 ${totalChanges} 项待评估变更`;
  const summary = `新增 ${counts.added} 项、更新 ${counts.updated} 项、删除 ${counts.deleted} 项。系统仅固定变更证据，不推断它必然影响任何工作项。`;
  return Object.freeze({ ...result, title, summary, counts, totalChanges });
}

export function buildRepositorySyncPlanEvidence(input: Readonly<{
  projectId: string;
  workItemId: string;
  impact: Readonly<{
    repositorySyncRunId: string;
    title: string;
    evidenceSnapshot: unknown;
    evidenceFingerprint: string;
  }>;
}>) {
  const result = evidence({
    schemaVersion: "ai-project-os/project-plan-evidence/v1",
    kind: "repositorySync",
    projectId: input.projectId,
    workItemId: input.workItemId,
    repositorySyncRunId: input.impact.repositorySyncRunId,
    impactEvidenceFingerprint: input.impact.evidenceFingerprint,
    impactEvidenceSnapshot: input.impact.evidenceSnapshot,
  });
  return Object.freeze({ ...result, label: compactLabel(input.impact.title, "仓库同步变更") });
}

function utcDayStart(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function signal(kind: ProjectPlanHealthSignal["kind"], severity: ProjectPlanHealthSignal["severity"], item: HealthWorkItem): ProjectPlanHealthSignal {
  return Object.freeze({ kind, severity, workItemId: item.id, title: item.title, targetDate: item.targetDate?.toISOString().slice(0, 10) ?? null, assigneeId: item.assigneeId });
}

export function buildProjectPlanHealth(input: Readonly<{
  workItems: readonly HealthWorkItem[];
  dependencies: readonly HealthDependency[];
  evidenceLinks: readonly HealthEvidence[];
  impacts: readonly HealthImpact[];
  actions: readonly HealthAction[];
  now?: Date;
  dueSoonDays?: number;
}>): ProjectPlanHealth {
  const now = input.now ?? new Date();
  const dueSoonDays = input.dueSoonDays ?? 3;
  if (!Number.isInteger(dueSoonDays) || dueSoonDays < 1 || dueSoonDays > 14) throw new Error("PROJECT_OPERATIONS_INVALID_DUE_WINDOW");
  const today = utcDayStart(now);
  const dueSoonEnd = today + dueSoonDays * 86_400_000;
  const itemById = new Map(input.workItems.map((item) => [item.id, item]));
  const evidenceByItem = new Map<string, HealthEvidence[]>();
  for (const link of input.evidenceLinks) evidenceByItem.set(link.workItemId, [...(evidenceByItem.get(link.workItemId) ?? []), link]);
  const dependencyBlockedIds = new Set(input.dependencies.flatMap((dependency) => {
    const predecessor = itemById.get(dependency.dependsOnId);
    return predecessor !== undefined && predecessor.status !== "completed" ? [dependency.workItemId] : [];
  }));
  const active = input.workItems.filter((item) => ACTIVE_STATUSES.has(item.status));
  const overdue = active.filter((item) => item.targetDate !== null && utcDayStart(item.targetDate) < today);
  const dueSoon = active.filter((item) => item.targetDate !== null && utcDayStart(item.targetDate) >= today && utcDayStart(item.targetDate) <= dueSoonEnd);
  const blocked = active.filter((item) => item.status === "blocked");
  const dependencyBlocked = active.filter((item) => dependencyBlockedIds.has(item.id));
  const unassigned = active.filter((item) => item.assigneeId === null);
  const missingAcceptance = active.filter((item) => item.acceptanceCriteria === null || item.acceptanceCriteria.trim().length === 0);
  const missingEvidence = active.filter((item) => (evidenceByItem.get(item.id)?.length ?? 0) === 0);
  const staleEvidence = input.evidenceLinks.filter((link) => link.stale);
  const pendingRecommendations = input.workItems.filter((item) => item.status === "proposed");
  const openImpacts = input.impacts.filter((impact) => impact.status === "proposed");
  const pendingApprovals = input.actions.filter((action) => action.status === "waitingApproval");
  const signals = [
    ...overdue.map((item) => signal("overdue", "error", item)),
    ...blocked.map((item) => signal("blocked", "error", item)),
    ...dependencyBlocked.map((item) => signal("dependencyBlocked", "warning", item)),
    ...dueSoon.map((item) => signal("dueSoon", "warning", item)),
    ...unassigned.map((item) => signal("unassigned", "warning", item)),
    ...missingAcceptance.map((item) => signal("missingAcceptance", "warning", item)),
    ...missingEvidence.map((item) => signal("missingEvidence", "warning", item)),
  ];
  const atRisk = overdue.length > 0 || blocked.length > 0;
  const attention = dependencyBlocked.length + dueSoon.length + unassigned.length + missingAcceptance.length + missingEvidence.length + staleEvidence.length + pendingRecommendations.length + openImpacts.length + pendingApprovals.length > 0;
  return Object.freeze({
    status: atRisk ? "atRisk" : attention ? "attention" : "healthy",
    dueSoonDays,
    counts: Object.freeze({
      active: active.length,
      overdue: overdue.length,
      dueSoon: dueSoon.length,
      blocked: blocked.length,
      dependencyBlocked: dependencyBlocked.length,
      unassigned: unassigned.length,
      missingAcceptance: missingAcceptance.length,
      missingEvidence: missingEvidence.length,
      staleEvidence: staleEvidence.length,
      pendingRecommendations: pendingRecommendations.length,
      openImpacts: openImpacts.length,
      pendingApprovals: pendingApprovals.length,
    }),
    signals: Object.freeze(signals),
  });
}

type LoadedEvidenceLink = Readonly<{
  workItemId: string;
  kind: string;
  evidenceSnapshot: unknown;
  projectItem: { reviewStatus: string; updatedAt: Date } | null;
  projectSource: { retiredAt: Date | null; contentHash: string } | null;
  repositorySyncRun: { status: string; reconciliationRequired: boolean; manifestFingerprint: string | null } | null;
}>;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function isProjectPlanEvidenceStale(link: LoadedEvidenceLink): boolean {
  const snapshot = object(link.evidenceSnapshot);
  if (snapshot === null) return true;
  if (link.kind === "projectItem") {
    const itemSnapshot = object(snapshot.item);
    return link.projectItem === null || link.projectItem.reviewStatus !== "confirmed" || itemSnapshot?.updatedAt !== link.projectItem.updatedAt.toISOString();
  }
  if (link.kind === "projectSource") {
    const sourceSnapshot = object(snapshot.source);
    return link.projectSource === null || link.projectSource.retiredAt !== null || sourceSnapshot?.contentHash !== link.projectSource.contentHash;
  }
  const impactSnapshot = object(snapshot.impactEvidenceSnapshot);
  return link.repositorySyncRun === null || link.repositorySyncRun.status !== "succeeded" || link.repositorySyncRun.reconciliationRequired || impactSnapshot?.manifestFingerprint !== link.repositorySyncRun.manifestFingerprint;
}

const operationsEvidenceSelect = {
  workItemId: true,
  kind: true,
  evidenceSnapshot: true,
  projectItem: { select: { reviewStatus: true, updatedAt: true } },
  projectSource: { select: { retiredAt: true, contentHash: true } },
  repositorySyncRun: { select: { status: true, reconciliationRequired: true, manifestFingerprint: true } },
} satisfies Prisma.ProjectWorkItemEvidenceLinkSelect;

export async function getProjectOperationsSummaries(projectIds: readonly string[], dueSoonDays = 3, db: PrismaClient = getDb()) {
  if (projectIds.length === 0) return new Map<string, ProjectPlanHealth>();
  const where = { projectId: { in: [...projectIds] } };
  const [projects, workItems, dependencies, evidenceLinks, impacts, actions, projectMembers, workspaceMembers] = await Promise.all([
    db.project.findMany({ where: { id: { in: [...projectIds] } }, select: { id: true, workspaceId: true } }),
    db.projectWorkItem.findMany({ where, select: { projectId: true, id: true, title: true, status: true, targetDate: true, assigneeId: true, acceptanceCriteria: true, origin: true } }),
    db.projectWorkItemDependency.findMany({ where: { ...where, removedAt: null }, select: { projectId: true, workItemId: true, dependsOnId: true } }),
    db.projectWorkItemEvidenceLink.findMany({ where: { ...where, removedAt: null }, select: { projectId: true, ...operationsEvidenceSelect } }),
    db.projectPlanImpactSuggestion.findMany({ where, select: { projectId: true, status: true } }),
    db.projectAction.findMany({ where: { ...where, status: "waitingApproval" }, select: { projectId: true, status: true } }),
    db.projectMembership.findMany({ where: { ...where, role: { in: ["owner", "editor"] }, user: { disabledAt: null } }, select: { projectId: true, userId: true } }),
    db.workspaceMembership.findMany({
      where: { role: { in: ["owner", "admin"] }, user: { disabledAt: null }, workspace: { projects: { some: { id: { in: [...projectIds] } } } } },
      select: { workspaceId: true, userId: true },
    }),
  ]);
  const eligibleAssignees = new Set(projectMembers.map((membership) => `${membership.projectId}:${membership.userId}`));
  for (const project of projects) {
    for (const membership of workspaceMembers) {
      if (project.workspaceId === membership.workspaceId) eligibleAssignees.add(`${project.id}:${membership.userId}`);
    }
  }
  const summaries = new Map<string, ProjectPlanHealth>();
  for (const projectId of projectIds) {
    const projectEvidence = evidenceLinks.filter((entry) => entry.projectId === projectId);
    summaries.set(projectId, buildProjectPlanHealth({
      workItems: workItems.filter((entry) => entry.projectId === projectId).map((entry) => ({
        ...entry,
        assigneeId: entry.assigneeId !== null && eligibleAssignees.has(`${projectId}:${entry.assigneeId}`) ? entry.assigneeId : null,
      })),
      dependencies: dependencies.filter((entry) => entry.projectId === projectId),
      evidenceLinks: projectEvidence.map((entry) => ({ workItemId: entry.workItemId, stale: isProjectPlanEvidenceStale(entry) })),
      impacts: impacts.filter((entry) => entry.projectId === projectId),
      actions: actions.filter((entry) => entry.projectId === projectId),
      dueSoonDays,
    }));
  }
  return summaries;
}

export async function getProjectOperationsSummary(projectId: string, dueSoonDays = 3, db: PrismaClient = getDb()): Promise<ProjectPlanHealth> {
  return (await getProjectOperationsSummaries([projectId], dueSoonDays, db)).get(projectId)!;
}
