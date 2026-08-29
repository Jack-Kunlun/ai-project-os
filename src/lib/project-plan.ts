import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type PrismaClient,
  type ProjectObjectiveStatus,
  type ProjectWorkItemStatus,
} from "@prisma/client";
import { z } from "zod";
import { assertProjectAccess, type AccessUser } from "@/lib/access-control";
import { getDb } from "@/lib/db";
import { assertProjectActive } from "@/lib/project-lifecycle";

const idSchema = z.string().uuid();
const titleSchema = z.string().trim().min(1).max(160);
const descriptionSchema = z.string().trim().max(20_000).nullable().optional();
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable().optional();
const timestampSchema = z.string().datetime({ offset: true });
const objectiveStatusSchema = z.enum(["draft", "active", "completed", "cancelled"]);
const workItemStatusSchema = z.enum(["proposed", "planned", "inProgress", "blocked", "completed", "cancelled"]);
const prioritySchema = z.enum(["low", "medium", "high", "urgent"]);
const recommendationSchema = z.object({
  text: z.string().trim().min(1).max(4_000),
  citations: z.array(z.string().uuid()).min(1).max(8),
}).strict();
const citationSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["project", "item", "memory", "repository"]),
  label: z.string(),
  excerpt: z.string(),
  path: z.string().nullable(),
  externalRef: z.string().nullable(),
  frozenCommitSha: z.string().nullable(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();

const createSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("createObjective"), title: titleSchema, description: descriptionSchema, targetDate: dateSchema }).strict(),
  z.object({
    operation: z.literal("createWorkItem"),
    title: titleSchema,
    description: descriptionSchema,
    objectiveId: idSchema.nullable().optional(),
    priority: prioritySchema.optional(),
    targetDate: dateSchema,
  }).strict(),
  z.object({ operation: z.literal("promoteRecommendation"), agentRunId: idSchema, recommendationIndex: z.number().int().min(0).max(7) }).strict(),
  z.object({ operation: z.literal("addDependency"), workItemId: idSchema, dependsOnId: idSchema, expectedUpdatedAt: timestampSchema }).strict(),
  z.object({ operation: z.literal("removeDependency"), dependencyId: idSchema, expectedUpdatedAt: timestampSchema }).strict(),
]);

const objectivePatchSchema = z.object({
  entity: z.literal("objective"),
  id: idSchema,
  expectedUpdatedAt: timestampSchema,
  title: titleSchema.optional(),
  description: descriptionSchema,
  status: objectiveStatusSchema.optional(),
  targetDate: dateSchema,
}).strict().refine((value) => value.title !== undefined || value.description !== undefined || value.status !== undefined || value.targetDate !== undefined);
const workItemPatchSchema = z.object({
  entity: z.literal("workItem"),
  id: idSchema,
  expectedUpdatedAt: timestampSchema,
  title: titleSchema.optional(),
  description: descriptionSchema,
  status: workItemStatusSchema.optional(),
  priority: prioritySchema.optional(),
  objectiveId: idSchema.nullable().optional(),
  targetDate: dateSchema,
}).strict().refine((value) => value.title !== undefined || value.description !== undefined || value.status !== undefined || value.priority !== undefined || value.objectiveId !== undefined || value.targetDate !== undefined);
const updateSchema = z.union([objectivePatchSchema, workItemPatchSchema]);

export type ProjectPlanErrorCode =
  | "PROJECT_PLAN_INVALID_INPUT"
  | "PROJECT_PLAN_PROJECT_NOT_FOUND"
  | "PROJECT_PLAN_OBJECTIVE_NOT_FOUND"
  | "PROJECT_PLAN_WORK_ITEM_NOT_FOUND"
  | "PROJECT_PLAN_DEPENDENCY_NOT_FOUND"
  | "PROJECT_PLAN_RECOMMENDATION_NOT_FOUND"
  | "PROJECT_PLAN_EVIDENCE_INVALID"
  | "PROJECT_PLAN_VERSION_CONFLICT"
  | "PROJECT_PLAN_STATUS_CONFLICT"
  | "PROJECT_PLAN_DEPENDENCY_CONFLICT"
  | "PROJECT_PLAN_DEPENDENCY_CYCLE";

export class ProjectPlanError extends Error {
  constructor(readonly code: ProjectPlanErrorCode) {
    super(code);
    this.name = "ProjectPlanError";
  }
}

function fail(code: ProjectPlanErrorCode): never {
  throw new ProjectPlanError(code);
}

function parseDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined || value === null) return value;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return fail("PROJECT_PLAN_INVALID_INPUT");
  return date;
}

function nullableText(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  return value.length === 0 ? null : value;
}

function canonicalValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return fail("PROJECT_PLAN_EVIDENCE_INVALID");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry, depth + 1));
  if (typeof value !== "object") return fail("PROJECT_PLAN_EVIDENCE_INVALID");
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) output[key] = canonicalValue((value as Record<string, unknown>)[key], depth + 1);
  return output;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function isProjectObjectiveStatusTransitionAllowed(from: ProjectObjectiveStatus | string, to: ProjectObjectiveStatus | string): boolean {
  if (from === to) return true;
  const transitions: Readonly<Record<string, readonly string[]>> = Object.freeze({ draft: ["active", "cancelled"], active: ["completed", "cancelled"], completed: [], cancelled: [] });
  return transitions[from]?.includes(to) ?? false;
}

export function isProjectWorkItemStatusTransitionAllowed(from: ProjectWorkItemStatus | string, to: ProjectWorkItemStatus | string): boolean {
  if (from === to) return true;
  const transitions: Readonly<Record<string, readonly string[]>> = Object.freeze({
    proposed: ["planned", "cancelled"],
    planned: ["inProgress", "blocked", "cancelled"],
    inProgress: ["blocked", "completed", "cancelled"],
    blocked: ["planned", "inProgress", "cancelled"],
    completed: [],
    cancelled: [],
  });
  return transitions[from]?.includes(to) ?? false;
}

export function wouldCreateProjectWorkItemDependencyCycle(
  workItemId: string,
  dependsOnId: string,
  edges: readonly Readonly<{ workItemId: string; dependsOnId: string }>[],
): boolean {
  if (workItemId === dependsOnId) return true;
  const graph = new Map<string, string[]>();
  for (const edge of edges) graph.set(edge.workItemId, [...(graph.get(edge.workItemId) ?? []), edge.dependsOnId]);
  const pending = [dependsOnId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === workItemId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(graph.get(current) ?? []));
  }
  return false;
}

export function canonicalAgentRecommendationEvidence(input: Readonly<{
  projectId: string;
  agentRunId: string;
  recommendationIndex: number;
  recommendation: unknown;
  citations: unknown;
  inputManifestFingerprint: string;
  createdAt: Date;
}>) {
  const projectId = idSchema.safeParse(input.projectId);
  const runId = idSchema.safeParse(input.agentRunId);
  const recommendation = recommendationSchema.safeParse(input.recommendation);
  const citations = z.array(citationSchema).safeParse(input.citations);
  if (!projectId.success || !runId.success || !recommendation.success || !citations.success || !Number.isInteger(input.recommendationIndex) || input.recommendationIndex < 0 || !/^[0-9a-f]{64}$/u.test(input.inputManifestFingerprint) || !Number.isFinite(input.createdAt.getTime())) {
    return fail("PROJECT_PLAN_EVIDENCE_INVALID");
  }
  const citationById = new Map(citations.data.map((citation) => [citation.id, citation]));
  const selected = recommendation.data.citations.map((id) => citationById.get(id) ?? fail("PROJECT_PLAN_EVIDENCE_INVALID"));
  const snapshot = canonicalValue({
    schemaVersion: "ai-project-os/agent-recommendation/v1",
    projectId: projectId.data,
    agentRunId: runId.data,
    recommendationIndex: input.recommendationIndex,
    recommendation: recommendation.data,
    citations: selected,
    inputManifestFingerprint: input.inputManifestFingerprint,
    generatedAt: input.createdAt.toISOString(),
  }) as Prisma.InputJsonObject;
  return Object.freeze({ snapshot, fingerprint: sha256(JSON.stringify(snapshot)), recommendation: recommendation.data });
}

const userSelect = { id: true, username: true, displayName: true } as const;
const objectiveSelect = { id: true, title: true, description: true, status: true, targetDate: true, createdAt: true, updatedAt: true, completedAt: true, createdBy: { select: userSelect } } satisfies Prisma.ProjectObjectiveSelect;
const workItemSelect = {
  id: true, objectiveId: true, title: true, description: true, status: true, priority: true, targetDate: true, origin: true,
  agentRunId: true, recommendationIndex: true, evidenceFingerprint: true, createdAt: true, updatedAt: true, completedAt: true,
  createdBy: { select: userSelect },
} satisfies Prisma.ProjectWorkItemSelect;
const dependencySelect = { id: true, workItemId: true, dependsOnId: true, createdAt: true, createdBy: { select: userSelect } } satisfies Prisma.ProjectWorkItemDependencySelect;

function suggestionsFromRuns(runs: readonly Readonly<{ id: string; question: string; recommendations: unknown; createdAt: Date }>[], promoted: Set<string>) {
  return runs.flatMap((run) => {
    const recommendations = z.array(recommendationSchema).safeParse(run.recommendations);
    if (!recommendations.success) return [];
    return recommendations.data.flatMap((recommendation, index) => promoted.has(`${run.id}:${index}`) ? [] : [{ agentRunId: run.id, recommendationIndex: index, text: recommendation.text, citationCount: recommendation.citations.length, question: run.question, createdAt: run.createdAt }]);
  });
}

export async function getProjectPlan(projectIdInput: unknown, actor: AccessUser, db: PrismaClient = getDb()) {
  const parsedProjectId = idSchema.safeParse(projectIdInput);
  if (!parsedProjectId.success) return fail("PROJECT_PLAN_INVALID_INPUT");
  const projectId = parsedProjectId.data;
  const permission = await assertProjectAccess(actor, projectId, "view", db);
  const [project, objectives, workItems, dependencies, audits, runs] = await Promise.all([
    db.project.findUnique({ where: { id: projectId }, select: { id: true, name: true, archivedAt: true } }),
    db.projectObjective.findMany({ where: { projectId }, orderBy: [{ status: "asc" }, { updatedAt: "desc" }], select: objectiveSelect }),
    db.projectWorkItem.findMany({ where: { projectId }, orderBy: [{ status: "asc" }, { priority: "desc" }, { updatedAt: "desc" }], select: workItemSelect }),
    db.projectWorkItemDependency.findMany({ where: { projectId, removedAt: null }, orderBy: { createdAt: "asc" }, select: dependencySelect }),
    db.projectPlanAudit.findMany({ where: { projectId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100, select: { id: true, entityType: true, entityId: true, event: true, details: true, createdAt: true, actor: { select: userSelect } } }),
    db.projectAgentRun.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, question: true, recommendations: true, createdAt: true } }),
  ]);
  if (project === null) return fail("PROJECT_PLAN_PROJECT_NOT_FOUND");
  const promoted = new Set(workItems.flatMap((item) => item.agentRunId === null || item.recommendationIndex === null ? [] : [`${item.agentRunId}:${item.recommendationIndex}`]));
  return Object.freeze({
    project,
    objectives,
    workItems,
    dependencies,
    audits,
    availableRecommendations: suggestionsFromRuns(runs, promoted),
    canEdit: project.archivedAt === null && (permission === "owner" || permission === "edit"),
  });
}

async function assertActiveTransaction(projectId: string, tx: Prisma.TransactionClient): Promise<void> {
  const project = await tx.project.findUnique({ where: { id: projectId }, select: { archivedAt: true } });
  if (project === null) return fail("PROJECT_PLAN_PROJECT_NOT_FOUND");
  if (project.archivedAt !== null) return fail("PROJECT_PLAN_STATUS_CONFLICT");
}

export async function createProjectPlanEntry(projectIdInput: unknown, input: unknown, actor: AccessUser, db: PrismaClient = getDb()) {
  const projectId = idSchema.safeParse(projectIdInput);
  const parsed = createSchema.safeParse(input);
  if (!projectId.success || !parsed.success) return fail("PROJECT_PLAN_INVALID_INPUT");
  await assertProjectAccess(actor, projectId.data, "edit", db);
  await assertProjectActive(projectId.data, db);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${projectId.data}:project-plan`}::text, 30082002))`);
    await assertActiveTransaction(projectId.data, tx);
    const operation = parsed.data;
    if (operation.operation === "createObjective") {
      const objective = await tx.projectObjective.create({ data: { id: randomUUID(), projectId: projectId.data, title: operation.title, description: nullableText(operation.description), targetDate: parseDate(operation.targetDate), createdById: actor.id }, select: objectiveSelect });
      await tx.projectPlanAudit.create({ data: { id: randomUUID(), projectId: projectId.data, entityType: "objective", entityId: objective.id, event: "created", details: { status: objective.status }, actorId: actor.id } });
      await tx.project.update({ where: { id: projectId.data }, data: { updatedAt: new Date() } });
      return { objective };
    }
    if (operation.operation === "createWorkItem") {
      if (operation.objectiveId !== undefined && operation.objectiveId !== null && await tx.projectObjective.count({ where: { projectId: projectId.data, id: operation.objectiveId } }) !== 1) return fail("PROJECT_PLAN_OBJECTIVE_NOT_FOUND");
      const workItem = await tx.projectWorkItem.create({ data: { id: randomUUID(), projectId: projectId.data, objectiveId: operation.objectiveId ?? null, title: operation.title, description: nullableText(operation.description), priority: operation.priority ?? "medium", targetDate: parseDate(operation.targetDate), createdById: actor.id }, select: workItemSelect });
      await tx.projectPlanAudit.create({ data: { id: randomUUID(), projectId: projectId.data, entityType: "workItem", entityId: workItem.id, event: "created", details: { status: workItem.status, origin: workItem.origin }, actorId: actor.id } });
      await tx.project.update({ where: { id: projectId.data }, data: { updatedAt: new Date() } });
      return { workItem };
    }
    if (operation.operation === "promoteRecommendation") {
      const existing = await tx.projectWorkItem.findFirst({ where: { projectId: projectId.data, agentRunId: operation.agentRunId, recommendationIndex: operation.recommendationIndex }, select: workItemSelect });
      if (existing !== null) return { workItem: existing };
      const run = await tx.projectAgentRun.findUnique({ where: { projectId_id: { projectId: projectId.data, id: operation.agentRunId } }, select: { id: true, recommendations: true, citations: true, inputManifestFingerprint: true, createdAt: true } });
      if (run === null) return fail("PROJECT_PLAN_RECOMMENDATION_NOT_FOUND");
      const recommendations = z.array(recommendationSchema).safeParse(run.recommendations);
      if (!recommendations.success || recommendations.data[operation.recommendationIndex] === undefined) return fail("PROJECT_PLAN_RECOMMENDATION_NOT_FOUND");
      const evidence = canonicalAgentRecommendationEvidence({ projectId: projectId.data, agentRunId: run.id, recommendationIndex: operation.recommendationIndex, recommendation: recommendations.data[operation.recommendationIndex], citations: run.citations, inputManifestFingerprint: run.inputManifestFingerprint, createdAt: run.createdAt });
      const text = evidence.recommendation.text;
      const workItem = await tx.projectWorkItem.create({ data: { id: randomUUID(), projectId: projectId.data, title: text.length <= 160 ? text : `${text.slice(0, 157)}…`, description: text, status: "proposed", origin: "agentRecommendation", agentRunId: run.id, recommendationIndex: operation.recommendationIndex, evidenceSnapshot: evidence.snapshot, evidenceFingerprint: evidence.fingerprint, createdById: actor.id }, select: workItemSelect });
      await tx.projectPlanAudit.create({ data: { id: randomUUID(), projectId: projectId.data, entityType: "workItem", entityId: workItem.id, event: "recommendationPromoted", details: { agentRunId: run.id, recommendationIndex: operation.recommendationIndex, evidenceFingerprint: evidence.fingerprint }, actorId: actor.id } });
      await tx.project.update({ where: { id: projectId.data }, data: { updatedAt: new Date() } });
      return { workItem };
    }
    if (operation.operation === "addDependency") return addDependency(projectId.data, operation, actor, tx);
    return removeDependency(projectId.data, operation, actor, tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function addDependency(projectId: string, input: Extract<z.infer<typeof createSchema>, { operation: "addDependency" }>, actor: AccessUser, tx: Prisma.TransactionClient) {
  if (input.workItemId === input.dependsOnId) return fail("PROJECT_PLAN_DEPENDENCY_CYCLE");
  const [workItem, dependsOn, edges] = await Promise.all([
    tx.projectWorkItem.findUnique({ where: { projectId_id: { projectId, id: input.workItemId } }, select: { id: true, updatedAt: true } }),
    tx.projectWorkItem.findUnique({ where: { projectId_id: { projectId, id: input.dependsOnId } }, select: { id: true } }),
    tx.projectWorkItemDependency.findMany({ where: { projectId, removedAt: null }, select: { workItemId: true, dependsOnId: true } }),
  ]);
  if (workItem === null || dependsOn === null) return fail("PROJECT_PLAN_WORK_ITEM_NOT_FOUND");
  if (workItem.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime()) return fail("PROJECT_PLAN_VERSION_CONFLICT");
  if (edges.some((edge) => edge.workItemId === input.workItemId && edge.dependsOnId === input.dependsOnId)) return fail("PROJECT_PLAN_DEPENDENCY_CONFLICT");
  if (wouldCreateProjectWorkItemDependencyCycle(input.workItemId, input.dependsOnId, edges)) return fail("PROJECT_PLAN_DEPENDENCY_CYCLE");
  const now = new Date();
  const dependency = await tx.projectWorkItemDependency.create({ data: { id: randomUUID(), projectId, workItemId: input.workItemId, dependsOnId: input.dependsOnId, createdById: actor.id }, select: dependencySelect });
  if ((await tx.projectWorkItem.updateMany({ where: { projectId, id: workItem.id, updatedAt: workItem.updatedAt }, data: { updatedAt: now } })).count !== 1) return fail("PROJECT_PLAN_VERSION_CONFLICT");
  await tx.projectPlanAudit.create({ data: { id: randomUUID(), projectId, entityType: "dependency", entityId: dependency.id, event: "dependencyAdded", details: { workItemId: input.workItemId, dependsOnId: input.dependsOnId }, actorId: actor.id } });
  await tx.project.update({ where: { id: projectId }, data: { updatedAt: now } });
  return { dependency };
}

async function removeDependency(projectId: string, input: Extract<z.infer<typeof createSchema>, { operation: "removeDependency" }>, actor: AccessUser, tx: Prisma.TransactionClient) {
  const dependency = await tx.projectWorkItemDependency.findUnique({ where: { projectId_id: { projectId, id: input.dependencyId } }, select: { id: true, workItemId: true, dependsOnId: true, removedAt: true, workItem: { select: { updatedAt: true } } } });
  if (dependency === null || dependency.removedAt !== null) return fail("PROJECT_PLAN_DEPENDENCY_NOT_FOUND");
  if (dependency.workItem.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime()) return fail("PROJECT_PLAN_VERSION_CONFLICT");
  const now = new Date();
  await tx.projectWorkItemDependency.update({ where: { id: dependency.id }, data: { removedAt: now, removedById: actor.id } });
  if ((await tx.projectWorkItem.updateMany({ where: { projectId, id: dependency.workItemId, updatedAt: dependency.workItem.updatedAt }, data: { updatedAt: now } })).count !== 1) return fail("PROJECT_PLAN_VERSION_CONFLICT");
  await tx.projectPlanAudit.create({ data: { id: randomUUID(), projectId, entityType: "dependency", entityId: dependency.id, event: "dependencyRemoved", details: { workItemId: dependency.workItemId, dependsOnId: dependency.dependsOnId }, actorId: actor.id } });
  await tx.project.update({ where: { id: projectId }, data: { updatedAt: now } });
  return { removedDependencyId: dependency.id };
}

export async function updateProjectPlanEntry(projectIdInput: unknown, input: unknown, actor: AccessUser, db: PrismaClient = getDb()) {
  const projectId = idSchema.safeParse(projectIdInput);
  const parsed = updateSchema.safeParse(input);
  if (!projectId.success || !parsed.success) return fail("PROJECT_PLAN_INVALID_INPUT");
  await assertProjectAccess(actor, projectId.data, "edit", db);
  await assertProjectActive(projectId.data, db);
  return db.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${projectId.data}:project-plan`}::text, 30082002))`);
    await assertActiveTransaction(projectId.data, tx);
    const patch = parsed.data;
    const expectedUpdatedAt = new Date(patch.expectedUpdatedAt);
    const now = new Date();
    if (patch.entity === "objective") {
      const current = await tx.projectObjective.findUnique({ where: { projectId_id: { projectId: projectId.data, id: patch.id } }, select: objectiveSelect });
      if (current === null) return fail("PROJECT_PLAN_OBJECTIVE_NOT_FOUND");
      if (current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return fail("PROJECT_PLAN_VERSION_CONFLICT");
      if (patch.status !== undefined && !isProjectObjectiveStatusTransitionAllowed(current.status, patch.status)) return fail("PROJECT_PLAN_STATUS_CONFLICT");
      const data: Prisma.ProjectObjectiveUpdateManyMutationInput = {
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.description === undefined ? {} : { description: nullableText(patch.description) }),
        ...(patch.targetDate === undefined ? {} : { targetDate: parseDate(patch.targetDate) }),
        ...(patch.status === undefined ? {} : { status: patch.status, completedAt: patch.status === "completed" ? now : null }),
        updatedAt: now,
      };
      if ((await tx.projectObjective.updateMany({ where: { projectId: projectId.data, id: current.id, updatedAt: current.updatedAt }, data })).count !== 1) return fail("PROJECT_PLAN_VERSION_CONFLICT");
      const objective = await tx.projectObjective.findUniqueOrThrow({ where: { projectId_id: { projectId: projectId.data, id: current.id } }, select: objectiveSelect });
      await tx.projectPlanAudit.create({ data: { id: randomUUID(), projectId: projectId.data, entityType: "objective", entityId: current.id, event: patch.status !== undefined && patch.status !== current.status ? "statusChanged" : "updated", details: patch.status !== undefined ? { from: current.status, to: patch.status } : {}, actorId: actor.id } });
      await tx.project.update({ where: { id: projectId.data }, data: { updatedAt: now } });
      return { objective };
    }
    const current = await tx.projectWorkItem.findUnique({ where: { projectId_id: { projectId: projectId.data, id: patch.id } }, select: workItemSelect });
    if (current === null) return fail("PROJECT_PLAN_WORK_ITEM_NOT_FOUND");
    if (current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return fail("PROJECT_PLAN_VERSION_CONFLICT");
    if (patch.status !== undefined && !isProjectWorkItemStatusTransitionAllowed(current.status, patch.status)) return fail("PROJECT_PLAN_STATUS_CONFLICT");
    if (patch.objectiveId !== undefined && patch.objectiveId !== null && await tx.projectObjective.count({ where: { projectId: projectId.data, id: patch.objectiveId } }) !== 1) return fail("PROJECT_PLAN_OBJECTIVE_NOT_FOUND");
    const data: Prisma.ProjectWorkItemUpdateManyMutationInput = {
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.description === undefined ? {} : { description: nullableText(patch.description) }),
      ...(patch.targetDate === undefined ? {} : { targetDate: parseDate(patch.targetDate) }),
      ...(patch.objectiveId === undefined ? {} : { objectiveId: patch.objectiveId }),
      ...(patch.priority === undefined ? {} : { priority: patch.priority }),
      ...(patch.status === undefined ? {} : { status: patch.status, completedAt: patch.status === "completed" ? now : null }),
      updatedAt: now,
    };
    if ((await tx.projectWorkItem.updateMany({ where: { projectId: projectId.data, id: current.id, updatedAt: current.updatedAt }, data })).count !== 1) return fail("PROJECT_PLAN_VERSION_CONFLICT");
    const workItem = await tx.projectWorkItem.findUniqueOrThrow({ where: { projectId_id: { projectId: projectId.data, id: current.id } }, select: workItemSelect });
    await tx.projectPlanAudit.create({ data: { id: randomUUID(), projectId: projectId.data, entityType: "workItem", entityId: current.id, event: patch.status !== undefined && patch.status !== current.status ? "statusChanged" : "updated", details: patch.status !== undefined ? { from: current.status, to: patch.status } : {}, actorId: actor.id } });
    await tx.project.update({ where: { id: projectId.data }, data: { updatedAt: now } });
    return { workItem };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
