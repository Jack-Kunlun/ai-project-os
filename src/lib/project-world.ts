import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  ProjectItemRevisionAction,
  type AppUser,
  type PrismaClient,
  type ProjectFactRelationKind,
} from "@prisma/client";
import { z } from "zod";
import { assertProjectAccess, type AccessUser, type ProjectPermission } from "@/lib/access-control";
import { getDb } from "@/lib/db";
import { appendProjectItemRevision } from "@/lib/project-item-history";
import { getProjectOperationsSummary, type ProjectPlanHealth } from "@/lib/project-operations";
import { assertProjectActive } from "@/lib/project-lifecycle";

const idSchema = z.string().uuid();
const timestampSchema = z.string().datetime({ offset: true });
const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const relationKindSchema = z.enum([
  "supports",
  "contradicts",
  "dependsOn",
  "blocks",
  "causedBy",
  "resolves",
  "relatesTo",
]);
const createRelationSchema = z.object({
  operation: z.literal("createRelation"),
  sourceItemId: idSchema,
  targetItemId: idSchema,
  kind: relationKindSchema,
  rationale: z.string().trim().min(1).max(2_000),
}).strict();
const retireRelationSchema = z.object({
  operation: z.literal("retireRelation"),
  relationId: idSchema,
  expectedFingerprint: fingerprintSchema,
  reason: z.string().trim().min(1).max(1_000),
}).strict();
const supersedeFactSchema = z.object({
  operation: z.literal("supersedeFact"),
  predecessorItemId: idSchema,
  successorItemId: idSchema,
  predecessorUpdatedAt: timestampSchema,
  successorUpdatedAt: timestampSchema,
  reason: z.string().trim().min(1).max(1_000),
}).strict();
const captureStateSchema = z.object({ operation: z.literal("captureState") }).strict();
export const projectWorldMutationSchema = z.discriminatedUnion("operation", [
  createRelationSchema,
  retireRelationSchema,
  supersedeFactSchema,
  captureStateSchema,
]);

export type ProjectWorldStatus = "on_track" | "needs_attention" | "at_risk" | "insufficient_data";
export type ProjectFactLifecycle = "active" | "scheduled" | "expired" | "superseded" | "source_retired";
export type ProjectWorldMutation = z.infer<typeof projectWorldMutationSchema>;
export type ProjectWorldActor = Pick<AppUser, "id" | "username" | "role">;
type WorldDb = PrismaClient | Prisma.TransactionClient;

export type ProjectWorldErrorCode =
  | "PROJECT_WORLD_INVALID_INPUT"
  | "PROJECT_WORLD_PROJECT_NOT_FOUND"
  | "PROJECT_WORLD_TOO_MANY_FACTS"
  | "PROJECT_WORLD_FACT_NOT_FOUND"
  | "PROJECT_WORLD_CONFIRMED_FACTS_REQUIRED"
  | "PROJECT_WORLD_RELATION_NOT_FOUND"
  | "PROJECT_WORLD_RELATION_CONFLICT"
  | "PROJECT_WORLD_RELATION_CHANGED"
  | "PROJECT_WORLD_SUPERSESSION_INVALID"
  | "PROJECT_WORLD_SUPERSESSION_CONFLICT"
  | "PROJECT_WORLD_SUPERSESSION_CYCLE"
  | "PROJECT_WORLD_SNAPSHOT_TOO_LARGE";

export class ProjectWorldError extends Error {
  constructor(readonly code: ProjectWorldErrorCode) {
    super(code);
    this.name = "ProjectWorldError";
  }
}

const worldFactSelect = {
  id: true,
  type: true,
  reviewStatus: true,
  title: true,
  content: true,
  sourceExcerpt: true,
  occurredAt: true,
  confirmedAt: true,
  confidence: true,
  importance: true,
  validFrom: true,
  validUntil: true,
  pinned: true,
  lastVerifiedAt: true,
  sourceId: true,
  supersedesItemId: true,
  createdAt: true,
  updatedAt: true,
  source: {
    select: {
      id: true,
      kind: true,
      externalRef: true,
      contentHash: true,
      capturedAt: true,
      ingestedAt: true,
      retiredAt: true,
    },
  },
  revisions: {
    orderBy: { revisionNumber: "desc" as const },
    take: 1,
    select: {
      id: true,
      revisionNumber: true,
      evidenceManifestFingerprint: true,
      createdAt: true,
    },
  },
  projectPlanEvidenceLinks: {
    where: { removedAt: null },
    orderBy: { createdAt: "asc" as const },
    select: {
      workItem: {
        select: { id: true, title: true, status: true, targetDate: true, assigneeId: true },
      },
    },
  },
} satisfies Prisma.ProjectItemSelect;

type LoadedWorldFact = Prisma.ProjectItemGetPayload<{ select: typeof worldFactSelect }>;

function fail(code: ProjectWorldErrorCode): never {
  throw new ProjectWorldError(code);
}

function canonicalValue(value: unknown, depth = 0): unknown {
  if (depth > 16) return fail("PROJECT_WORLD_INVALID_INPUT");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry, depth + 1));
  if (typeof value !== "object") return fail("PROJECT_WORLD_INVALID_INPUT");
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    output[key] = canonicalValue((value as Record<string, unknown>)[key], depth + 1);
  }
  return output;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  return canonicalValue(value) as Prisma.InputJsonValue;
}

function isKnownPrismaError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function normalizeRationale(value: string): string {
  return value.trim().replace(/\r\n?/gu, "\n");
}

function isSymmetricRelation(kind: ProjectFactRelationKind | z.infer<typeof relationKindSchema>): boolean {
  return kind === "contradicts" || kind === "relatesTo";
}

export function canonicalRelationEndpoints(input: Readonly<{
  sourceItemId: string;
  targetItemId: string;
  kind: z.infer<typeof relationKindSchema>;
}>): Readonly<{ sourceItemId: string; targetItemId: string }> {
  if (input.sourceItemId === input.targetItemId) return fail("PROJECT_WORLD_INVALID_INPUT");
  if (isSymmetricRelation(input.kind) && input.sourceItemId > input.targetItemId) {
    return Object.freeze({ sourceItemId: input.targetItemId, targetItemId: input.sourceItemId });
  }
  return Object.freeze({ sourceItemId: input.sourceItemId, targetItemId: input.targetItemId });
}

export function classifyProjectFactLifecycle(
  fact: Readonly<{
    reviewStatus: string;
    validFrom: Date | null;
    validUntil: Date | null;
    sourceRetiredAt: Date | null;
  }>,
  asOf: Date,
): ProjectFactLifecycle {
  if (fact.reviewStatus === "superseded") return "superseded";
  if (fact.sourceRetiredAt !== null) return "source_retired";
  if (fact.validFrom !== null && fact.validFrom.getTime() > asOf.getTime()) return "scheduled";
  if (fact.validUntil !== null && fact.validUntil.getTime() <= asOf.getTime()) return "expired";
  return "active";
}

function latestRevision(fact: LoadedWorldFact) {
  const revision = fact.revisions[0];
  if (revision === undefined || revision.evidenceManifestFingerprint === null) {
    return fail("PROJECT_WORLD_INVALID_INPUT");
  }
  return revision;
}

function publicFact(fact: LoadedWorldFact, asOf: Date) {
  const revision = latestRevision(fact);
  return Object.freeze({
    id: fact.id,
    type: fact.type,
    reviewStatus: fact.reviewStatus,
    lifecycle: classifyProjectFactLifecycle({
      reviewStatus: fact.reviewStatus,
      validFrom: fact.validFrom,
      validUntil: fact.validUntil,
      sourceRetiredAt: fact.source.retiredAt,
    }, asOf),
    title: fact.title,
    content: fact.content,
    sourceExcerpt: fact.sourceExcerpt,
    occurredAt: fact.occurredAt,
    confirmedAt: fact.confirmedAt,
    confidence: fact.confidence,
    importance: fact.importance,
    validFrom: fact.validFrom,
    validUntil: fact.validUntil,
    pinned: fact.pinned,
    lastVerifiedAt: fact.lastVerifiedAt,
    supersedesItemId: fact.supersedesItemId,
    createdAt: fact.createdAt,
    updatedAt: fact.updatedAt,
    revision: Object.freeze({
      id: revision.id,
      number: revision.revisionNumber,
      evidenceManifestFingerprint: revision.evidenceManifestFingerprint,
      createdAt: revision.createdAt,
    }),
    source: Object.freeze({
      id: fact.source.id,
      kind: fact.source.kind,
      externalRef: fact.source.externalRef,
      contentHash: fact.source.contentHash,
      capturedAt: fact.source.capturedAt,
      ingestedAt: fact.source.ingestedAt,
      retiredAt: fact.source.retiredAt,
    }),
    workItems: Object.freeze(fact.projectPlanEvidenceLinks.map((link) => Object.freeze(link.workItem))),
  });
}

function statusFromState(input: Readonly<{
  activeFacts: readonly Readonly<{ type: string }>[];
  activeConflictCount: number;
  staleRelationCount: number;
  planHealth: ProjectPlanHealth;
}>): ProjectWorldStatus {
  if (input.activeFacts.length === 0) return "insufficient_data";
  const issues = input.activeFacts.filter((fact) => fact.type === "issue").length;
  const risks = input.activeFacts.filter((fact) => fact.type === "risk").length;
  if (issues > 0 || input.activeConflictCount > 0 || input.planHealth.status === "atRisk") return "at_risk";
  if (risks > 0 || input.staleRelationCount > 0 || input.planHealth.status === "attention") return "needs_attention";
  return "on_track";
}

function snapshotFact(fact: ReturnType<typeof publicFact>) {
  return {
    id: fact.id,
    revisionId: fact.revision.id,
    revisionNumber: fact.revision.number,
    evidenceManifestFingerprint: fact.revision.evidenceManifestFingerprint,
    type: fact.type,
    title: fact.title,
    importance: fact.importance,
    pinned: fact.pinned,
    occurredAt: fact.occurredAt?.toISOString() ?? null,
    validFrom: fact.validFrom?.toISOString() ?? null,
    validUntil: fact.validUntil?.toISOString() ?? null,
    sourceId: fact.source.id,
    sourceContentHash: fact.source.contentHash,
    workItemIds: fact.workItems.map((item) => item.id).sort(),
  };
}

export async function buildProjectWorldState(
  projectIdInput: unknown,
  db: WorldDb = getDb(),
  asOf = new Date(),
  options: Readonly<{ planHealth?: ProjectPlanHealth }> = {},
) {
  const projectId = idSchema.parse(projectIdInput);
  if (!Number.isFinite(asOf.getTime())) return fail("PROJECT_WORLD_INVALID_INPUT");
  const planHealthPromise: Promise<ProjectPlanHealth> = options.planHealth === undefined
    ? getProjectOperationsSummary(projectId, 3, db)
    : Promise.resolve(options.planHealth);
  const [project, loadedFacts, loadedRelations, qualityIssues, planHealth] = await Promise.all([
    db.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, slug: true, description: true, archivedAt: true, updatedAt: true },
    }),
    db.projectItem.findMany({
      where: { projectId, reviewStatus: { in: ["confirmed", "superseded"] } },
      orderBy: [{ pinned: "desc" }, { importance: "desc" }, { updatedAt: "desc" }, { id: "asc" }],
      take: 5_001,
      select: worldFactSelect,
    }),
    db.projectFactRelation.findMany({
      where: { projectId, retiredAt: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        kind: true,
        sourceItemId: true,
        targetItemId: true,
        sourceRevisionId: true,
        targetRevisionId: true,
        rationale: true,
        fingerprint: true,
        createdAt: true,
        createdBy: { select: { id: true, username: true, displayName: true } },
      },
    }),
    db.memoryQualityIssue.findMany({
      where: { projectId, status: "open" },
      orderBy: [{ detectedAt: "desc" }, { id: "asc" }],
      take: 2_001,
      select: {
        id: true,
        kind: true,
        score: true,
        fingerprint: true,
        explanation: true,
        primaryItemId: true,
        relatedItemId: true,
        detectedAt: true,
      },
    }),
    planHealthPromise,
  ]);
  if (project === null) return fail("PROJECT_WORLD_PROJECT_NOT_FOUND");
  if (loadedFacts.length > 5_000 || qualityIssues.length > 2_000) return fail("PROJECT_WORLD_TOO_MANY_FACTS");

  const facts = Object.freeze(loadedFacts.map((fact) => publicFact(fact, asOf)));
  const factById = new Map(facts.map((fact) => [fact.id, fact]));
  const activeFacts = Object.freeze(facts.filter((fact) => fact.lifecycle === "active"));
  const activeIds = new Set(activeFacts.map((fact) => fact.id));
  const relations = Object.freeze(loadedRelations.map((relation) => {
    const source = factById.get(relation.sourceItemId);
    const target = factById.get(relation.targetItemId);
    const stale = source === undefined
      || target === undefined
      || source.lifecycle !== "active"
      || target.lifecycle !== "active"
      || source.revision.id !== relation.sourceRevisionId
      || target.revision.id !== relation.targetRevisionId;
    return Object.freeze({ ...relation, stale });
  }));
  const activeConflicts = qualityIssues.filter((issue) =>
    issue.kind === "conflict"
    && activeIds.has(issue.primaryItemId)
    && issue.relatedItemId !== null
    && activeIds.has(issue.relatedItemId));
  const status = statusFromState({
    activeFacts,
    activeConflictCount: activeConflicts.length,
    staleRelationCount: relations.filter((relation) => relation.stale).length,
    planHealth,
  });
  const counts = Object.freeze({
    activeFacts: activeFacts.length,
    decisions: activeFacts.filter((fact) => fact.type === "decision").length,
    progress: activeFacts.filter((fact) => fact.type === "progress").length,
    issues: activeFacts.filter((fact) => fact.type === "issue").length,
    risks: activeFacts.filter((fact) => fact.type === "risk").length,
    scheduled: facts.filter((fact) => fact.lifecycle === "scheduled").length,
    expired: facts.filter((fact) => fact.lifecycle === "expired").length,
    superseded: facts.filter((fact) => fact.lifecycle === "superseded").length,
    sourceRetired: facts.filter((fact) => fact.lifecycle === "source_retired").length,
    activeRelations: relations.filter((relation) => !relation.stale).length,
    staleRelations: relations.filter((relation) => relation.stale).length,
    openQualityIssues: qualityIssues.length,
    activeConflicts: activeConflicts.length,
    linkedWorkItems: new Set(activeFacts.flatMap((fact) => fact.workItems.map((item) => item.id))).size,
  });
  const inputManifest = {
    schemaVersion: "ai-project-os/project-world-input/v1",
    project: { id: project.id, updatedAt: project.updatedAt.toISOString(), archivedAt: project.archivedAt?.toISOString() ?? null },
    facts: facts.map((fact) => ({
      id: fact.id,
      revisionId: fact.revision.id,
      lifecycle: fact.lifecycle,
      reviewStatus: fact.reviewStatus,
      sourceId: fact.source.id,
      sourceContentHash: fact.source.contentHash,
      sourceRetiredAt: fact.source.retiredAt?.toISOString() ?? null,
      workItems: fact.workItems.map((item) => ({ id: item.id, status: item.status, targetDate: item.targetDate?.toISOString() ?? null })).sort((left, right) => left.id.localeCompare(right.id)),
    })),
    relations: relations.map((relation) => ({ id: relation.id, fingerprint: relation.fingerprint, stale: relation.stale })),
    qualityIssues: qualityIssues.map((issue) => ({ id: issue.id, kind: issue.kind, fingerprint: issue.fingerprint })),
    planHealth,
  };
  const snapshotState = {
    schemaVersion: "ai-project-os/project-world-state/v1",
    project: { id: project.id, name: project.name, slug: project.slug, description: project.description },
    status,
    counts,
    facts: activeFacts.map(snapshotFact),
    relations: relations.filter((relation) => !relation.stale).map((relation) => ({
      id: relation.id,
      kind: relation.kind,
      sourceItemId: relation.sourceItemId,
      targetItemId: relation.targetItemId,
      sourceRevisionId: relation.sourceRevisionId,
      targetRevisionId: relation.targetRevisionId,
      rationale: relation.rationale,
      fingerprint: relation.fingerprint,
    })),
    quality: {
      openIssueCount: qualityIssues.length,
      activeConflictCount: activeConflicts.length,
      issueFingerprints: qualityIssues.map((issue) => issue.fingerprint).sort(),
    },
    planHealth,
  };
  const inputManifestFingerprint = fingerprint(inputManifest);
  const snapshotFingerprint = fingerprint(snapshotState);
  const payload = Object.freeze({
    ...snapshotState,
    asOf: asOf.toISOString(),
    inputManifestFingerprint,
    snapshotFingerprint,
  });

  return Object.freeze({
    project,
    asOf,
    status,
    counts,
    facts,
    activeFacts,
    relations,
    qualityIssues: Object.freeze(qualityIssues),
    planHealth,
    inputManifestFingerprint,
    snapshotFingerprint,
    payload,
  });
}

async function withProjectLock<T>(
  projectId: string,
  db: PrismaClient,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${projectId}::text, 50001337))
        `);
        return work(tx);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isKnownPrismaError(error, "P2034") && attempt < 3) continue;
      throw error;
    }
  }
  return fail("PROJECT_WORLD_INVALID_INPUT");
}

async function createFactRelation(
  projectId: string,
  input: z.infer<typeof createRelationSchema>,
  actor: ProjectWorldActor,
  db: PrismaClient,
) {
  const endpoints = canonicalRelationEndpoints(input);
  const rationale = normalizeRationale(input.rationale);
  try {
    return await withProjectLock(projectId, db, async (tx) => {
      const facts = await tx.projectItem.findMany({
        where: { projectId, id: { in: [endpoints.sourceItemId, endpoints.targetItemId] } },
        select: {
          id: true,
          reviewStatus: true,
          revisions: { orderBy: { revisionNumber: "desc" }, take: 1, select: { id: true } },
        },
      });
      if (facts.length !== 2) return fail("PROJECT_WORLD_FACT_NOT_FOUND");
      const source = facts.find((fact) => fact.id === endpoints.sourceItemId)!;
      const target = facts.find((fact) => fact.id === endpoints.targetItemId)!;
      if (source.reviewStatus !== "confirmed" || target.reviewStatus !== "confirmed") {
        return fail("PROJECT_WORLD_CONFIRMED_FACTS_REQUIRED");
      }
      const sourceRevisionId = source.revisions[0]?.id;
      const targetRevisionId = target.revisions[0]?.id;
      if (!sourceRevisionId || !targetRevisionId) return fail("PROJECT_WORLD_INVALID_INPUT");
      const relationFingerprint = fingerprint({
        schemaVersion: "ai-project-os/project-fact-relation/v1",
        projectId,
        sourceItemId: source.id,
        sourceRevisionId,
        targetItemId: target.id,
        targetRevisionId,
        kind: input.kind,
        rationale,
      });
      const relation = await tx.projectFactRelation.create({
        data: {
          id: randomUUID(),
          projectId,
          sourceItemId: source.id,
          sourceRevisionId,
          targetItemId: target.id,
          targetRevisionId,
          kind: input.kind,
          rationale,
          fingerprint: relationFingerprint,
          createdById: actor.id,
        },
      });
      await tx.projectWorldAudit.create({
        data: {
          projectId,
          event: "relationCreated",
          actorId: actor.id,
          relationId: relation.id,
          sourceItemId: source.id,
          targetItemId: target.id,
          details: inputJson({ kind: input.kind, rationale, sourceRevisionId, targetRevisionId, fingerprint: relationFingerprint }),
        },
      });
      return relation;
    });
  } catch (error) {
    if (isKnownPrismaError(error, "P2002")) return fail("PROJECT_WORLD_RELATION_CONFLICT");
    throw error;
  }
}

async function retireFactRelation(
  projectId: string,
  input: z.infer<typeof retireRelationSchema>,
  actor: ProjectWorldActor,
  db: PrismaClient,
) {
  return withProjectLock(projectId, db, async (tx) => {
    const current = await tx.projectFactRelation.findUnique({
      where: { projectId_id: { projectId, id: input.relationId } },
    });
    if (current === null) return fail("PROJECT_WORLD_RELATION_NOT_FOUND");
    if (current.retiredAt !== null) return fail("PROJECT_WORLD_RELATION_CHANGED");
    if (current.fingerprint !== input.expectedFingerprint) return fail("PROJECT_WORLD_RELATION_CHANGED");
    const retiredAt = new Date();
    const changed = await tx.projectFactRelation.updateMany({
      where: { projectId, id: current.id, fingerprint: input.expectedFingerprint, retiredAt: null },
      data: { retiredAt, retiredById: actor.id, retirementReason: input.reason },
    });
    if (changed.count !== 1) return fail("PROJECT_WORLD_RELATION_CHANGED");
    await tx.projectWorldAudit.create({
      data: {
        projectId,
        event: "relationRetired",
        actorId: actor.id,
        relationId: current.id,
        sourceItemId: current.sourceItemId,
        targetItemId: current.targetItemId,
        details: inputJson({ fingerprint: current.fingerprint, reason: input.reason }),
        createdAt: retiredAt,
      },
    });
    return tx.projectFactRelation.findUniqueOrThrow({ where: { projectId_id: { projectId, id: current.id } } });
  });
}

async function supersedeFact(
  projectId: string,
  input: z.infer<typeof supersedeFactSchema>,
  actor: ProjectWorldActor,
  db: PrismaClient,
) {
  if (input.predecessorItemId === input.successorItemId) return fail("PROJECT_WORLD_SUPERSESSION_INVALID");
  try {
    return await withProjectLock(projectId, db, async (tx) => {
      const facts = await tx.projectItem.findMany({
        where: { projectId, id: { in: [input.predecessorItemId, input.successorItemId] } },
        include: { evidences: { where: { evidenceState: "active", isActive: true } } },
      });
      if (facts.length !== 2) return fail("PROJECT_WORLD_FACT_NOT_FOUND");
      const predecessor = facts.find((fact) => fact.id === input.predecessorItemId)!;
      const successor = facts.find((fact) => fact.id === input.successorItemId)!;
      if (
        predecessor.reviewStatus !== "confirmed"
        || successor.reviewStatus !== "confirmed"
        || predecessor.type !== successor.type
        || successor.supersedesItemId !== null
        || predecessor.updatedAt.getTime() !== new Date(input.predecessorUpdatedAt).getTime()
        || successor.updatedAt.getTime() !== new Date(input.successorUpdatedAt).getTime()
      ) {
        return fail("PROJECT_WORLD_SUPERSESSION_CONFLICT");
      }
      const existingSuccessor = await tx.projectItem.count({
        where: { projectId, supersedesItemId: predecessor.id },
      });
      if (existingSuccessor !== 0) return fail("PROJECT_WORLD_SUPERSESSION_CONFLICT");
      const ancestors = new Set<string>();
      let cursor: string | null = predecessor.supersedesItemId;
      while (cursor !== null) {
        if (cursor === successor.id || ancestors.has(cursor)) return fail("PROJECT_WORLD_SUPERSESSION_CYCLE");
        ancestors.add(cursor);
        const ancestor = await tx.projectItem.findUnique({
          where: { projectId_id: { projectId, id: cursor } },
          select: { supersedesItemId: true },
        });
        cursor = ancestor?.supersedesItemId ?? null;
      }
      const changedAt = new Date(Math.max(Date.now(), predecessor.updatedAt.getTime() + 1, successor.updatedAt.getTime() + 1));
      const predecessorChanged = await tx.projectItem.updateMany({
        where: { projectId, id: predecessor.id, reviewStatus: "confirmed", updatedAt: predecessor.updatedAt },
        data: { reviewStatus: "superseded", updatedAt: changedAt },
      });
      const successorChanged = await tx.projectItem.updateMany({
        where: { projectId, id: successor.id, reviewStatus: "confirmed", updatedAt: successor.updatedAt, supersedesItemId: null },
        data: { supersedesItemId: predecessor.id, updatedAt: changedAt },
      });
      if (predecessorChanged.count !== 1 || successorChanged.count !== 1) return fail("PROJECT_WORLD_SUPERSESSION_CONFLICT");
      const [updatedPredecessor, updatedSuccessor] = await Promise.all([
        tx.projectItem.findUniqueOrThrow({ where: { projectId_id: { projectId, id: predecessor.id } } }),
        tx.projectItem.findUniqueOrThrow({ where: { projectId_id: { projectId, id: successor.id } } }),
      ]);
      await appendProjectItemRevision(tx, {
        item: updatedPredecessor,
        action: ProjectItemRevisionAction.superseded,
        actorId: `local:${actor.username}`,
        reason: input.reason,
        evidences: predecessor.evidences,
        createdAt: changedAt,
      });
      await appendProjectItemRevision(tx, {
        item: updatedSuccessor,
        action: ProjectItemRevisionAction.supersessionLinked,
        actorId: `local:${actor.username}`,
        reason: input.reason,
        evidences: successor.evidences,
        createdAt: changedAt,
      });
      await tx.projectWorldAudit.create({
        data: {
          projectId,
          event: "factSuperseded",
          actorId: actor.id,
          sourceItemId: successor.id,
          targetItemId: predecessor.id,
          details: inputJson({ reason: input.reason, predecessorUpdatedAt: predecessor.updatedAt, successorUpdatedAt: successor.updatedAt }),
          createdAt: changedAt,
        },
      });
      return Object.freeze({ predecessor: updatedPredecessor, successor: updatedSuccessor });
    });
  } catch (error) {
    if (isKnownPrismaError(error, "P2002") || isKnownPrismaError(error, "P2034")) {
      return fail("PROJECT_WORLD_SUPERSESSION_CONFLICT");
    }
    throw error;
  }
}

async function captureWorldState(projectId: string, actor: ProjectWorldActor, db: PrismaClient) {
  try {
    return await withProjectLock(projectId, db, async (tx) => {
      const state = await buildProjectWorldState(projectId, tx, new Date());
      const serialized = JSON.stringify(state.payload);
      if (Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024) return fail("PROJECT_WORLD_SNAPSHOT_TOO_LARGE");
      const existing = await tx.projectWorldSnapshot.findUnique({
        where: { projectId_snapshotFingerprint: { projectId, snapshotFingerprint: state.snapshotFingerprint } },
      });
      if (existing !== null) return Object.freeze({ snapshot: existing, created: false });
      const snapshot = await tx.projectWorldSnapshot.create({
        data: {
          id: randomUUID(),
          projectId,
          schemaVersion: 1,
          asOf: state.asOf,
          status: state.status,
          inputManifestFingerprint: state.inputManifestFingerprint,
          snapshotFingerprint: state.snapshotFingerprint,
          payload: inputJson(state.payload),
          capturedById: actor.id,
        },
      });
      await tx.projectWorldAudit.create({
        data: {
          projectId,
          event: "stateCaptured",
          actorId: actor.id,
          snapshotId: snapshot.id,
          details: inputJson({ status: state.status, counts: state.counts, inputManifestFingerprint: state.inputManifestFingerprint, snapshotFingerprint: state.snapshotFingerprint }),
          createdAt: snapshot.createdAt,
        },
      });
      return Object.freeze({ snapshot, created: true });
    });
  } catch (error) {
    if (isKnownPrismaError(error, "P2002")) {
      const state = await buildProjectWorldState(projectId, db);
      const existing = await db.projectWorldSnapshot.findUnique({
        where: { projectId_snapshotFingerprint: { projectId, snapshotFingerprint: state.snapshotFingerprint } },
      });
      if (existing !== null) return Object.freeze({ snapshot: existing, created: false });
    }
    throw error;
  }
}

export async function mutateProjectWorld(
  projectIdInput: unknown,
  inputValue: unknown,
  actor: ProjectWorldActor,
  db: PrismaClient = getDb(),
) {
  const projectId = idSchema.parse(projectIdInput);
  const parsed = projectWorldMutationSchema.safeParse(inputValue);
  if (!parsed.success) return fail("PROJECT_WORLD_INVALID_INPUT");
  await assertProjectAccess(actor, projectId, "edit", db);
  await assertProjectActive(projectId, db);
  if (parsed.data.operation === "createRelation") return createFactRelation(projectId, parsed.data, actor, db);
  if (parsed.data.operation === "retireRelation") return retireFactRelation(projectId, parsed.data, actor, db);
  if (parsed.data.operation === "supersedeFact") return supersedeFact(projectId, parsed.data, actor, db);
  return captureWorldState(projectId, actor, db);
}

export async function getProjectWorld(
  projectIdInput: unknown,
  actor: AccessUser,
  db: PrismaClient = getDb(),
) {
  const projectId = idSchema.parse(projectIdInput);
  const permission: ProjectPermission = await assertProjectAccess(actor, projectId, "view", db);
  const [state, snapshots, audits] = await Promise.all([
    buildProjectWorldState(projectId, db),
    db.projectWorldSnapshot.findMany({
      where: { projectId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20,
      select: {
        id: true,
        schemaVersion: true,
        asOf: true,
        status: true,
        inputManifestFingerprint: true,
        snapshotFingerprint: true,
        payload: true,
        createdAt: true,
        capturedBy: { select: { id: true, username: true, displayName: true } },
      },
    }),
    db.projectWorldAudit.findMany({
      where: { projectId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 80,
      select: {
        id: true,
        event: true,
        relationId: true,
        snapshotId: true,
        sourceItemId: true,
        targetItemId: true,
        details: true,
        createdAt: true,
        actor: { select: { id: true, username: true, displayName: true } },
      },
    }),
  ]);
  return Object.freeze({
    permission,
    project: state.project,
    state: Object.freeze({
      asOf: state.asOf,
      status: state.status,
      counts: state.counts,
      inputManifestFingerprint: state.inputManifestFingerprint,
      snapshotFingerprint: state.snapshotFingerprint,
      planHealth: state.planHealth,
    }),
    facts: state.facts,
    relations: state.relations,
    qualityIssues: state.qualityIssues,
    snapshots: Object.freeze(snapshots),
    audits: Object.freeze(audits),
  });
}

export async function getProjectWorldSummaries(
  projectIds: readonly string[],
  db: PrismaClient = getDb(),
  planHealthByProject?: ReadonlyMap<string, ProjectPlanHealth>,
) {
  const asOf = new Date();
  const entries = await Promise.all(projectIds.map(async (projectId) => {
    const planHealth = planHealthByProject?.get(projectId) ?? await getProjectOperationsSummary(projectId, 3, db);
    const [facts, storedRelations, qualityIssues] = await Promise.all([
      db.projectItem.findMany({
        where: { projectId, reviewStatus: { in: ["confirmed", "superseded"] } },
        orderBy: { id: "asc" },
        take: 5_001,
        select: {
          id: true,
          type: true,
          reviewStatus: true,
          validFrom: true,
          validUntil: true,
          source: { select: { retiredAt: true } },
          revisions: { orderBy: { revisionNumber: "desc" }, take: 1, select: { id: true } },
          projectPlanEvidenceLinks: { where: { removedAt: null }, select: { workItemId: true } },
        },
      }),
      db.projectFactRelation.findMany({
        where: { projectId, retiredAt: null },
        orderBy: { id: "asc" },
        select: { sourceItemId: true, targetItemId: true, sourceRevisionId: true, targetRevisionId: true },
      }),
      db.memoryQualityIssue.findMany({
        where: { projectId, status: "open" },
        orderBy: { id: "asc" },
        take: 2_001,
        select: { kind: true, primaryItemId: true, relatedItemId: true },
      }),
    ]);
    if (facts.length > 5_000 || qualityIssues.length > 2_000) return fail("PROJECT_WORLD_TOO_MANY_FACTS");
    const factStates = facts.map((fact) => ({
      ...fact,
      currentRevisionId: fact.revisions[0]?.id ?? null,
      lifecycle: classifyProjectFactLifecycle({
        reviewStatus: fact.reviewStatus,
        validFrom: fact.validFrom,
        validUntil: fact.validUntil,
        sourceRetiredAt: fact.source.retiredAt,
      }, asOf),
    }));
    const factById = new Map(factStates.map((fact) => [fact.id, fact]));
    const activeFacts = factStates.filter((fact) => fact.lifecycle === "active");
    const activeIds = new Set(activeFacts.map((fact) => fact.id));
    const relations = storedRelations.map((relation) => {
      const source = factById.get(relation.sourceItemId);
      const target = factById.get(relation.targetItemId);
      return {
        stale: source === undefined
          || target === undefined
          || source.lifecycle !== "active"
          || target.lifecycle !== "active"
          || source.currentRevisionId !== relation.sourceRevisionId
          || target.currentRevisionId !== relation.targetRevisionId,
      };
    });
    const activeConflictCount = qualityIssues.filter((issue) => issue.kind === "conflict"
      && activeIds.has(issue.primaryItemId)
      && issue.relatedItemId !== null
      && activeIds.has(issue.relatedItemId)).length;
    const counts = Object.freeze({
      activeFacts: activeFacts.length,
      decisions: activeFacts.filter((fact) => fact.type === "decision").length,
      progress: activeFacts.filter((fact) => fact.type === "progress").length,
      issues: activeFacts.filter((fact) => fact.type === "issue").length,
      risks: activeFacts.filter((fact) => fact.type === "risk").length,
      scheduled: factStates.filter((fact) => fact.lifecycle === "scheduled").length,
      expired: factStates.filter((fact) => fact.lifecycle === "expired").length,
      superseded: factStates.filter((fact) => fact.lifecycle === "superseded").length,
      sourceRetired: factStates.filter((fact) => fact.lifecycle === "source_retired").length,
      activeRelations: relations.filter((relation) => !relation.stale).length,
      staleRelations: relations.filter((relation) => relation.stale).length,
      openQualityIssues: qualityIssues.length,
      activeConflicts: activeConflictCount,
      linkedWorkItems: new Set(activeFacts.flatMap((fact) => fact.projectPlanEvidenceLinks.map((link) => link.workItemId))).size,
    });
    const status = statusFromState({
      activeFacts,
      activeConflictCount,
      staleRelationCount: counts.staleRelations,
      planHealth,
    });
    return [projectId, Object.freeze({
      status,
      counts,
      planHealth,
    })] as const;
  }));
  return new Map(entries);
}
