import { createHash } from "node:crypto";
import {
  Prisma,
  ProjectItemRevisionAction,
  type AppUser,
  type MemoryQualityIssueKind,
  type PrismaClient,
  type ProjectItemType,
} from "@prisma/client";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { appendProjectItemRevision } from "@/lib/project-item-history";

const STALE_AFTER_MS = 180 * 24 * 60 * 60 * 1_000;
const MAX_ANALYZED_ITEMS = 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type MemoryQualityErrorCode =
  | "MEMORY_QUALITY_INVALID_INPUT"
  | "MEMORY_QUALITY_PROJECT_NOT_FOUND"
  | "MEMORY_QUALITY_ITEM_NOT_FOUND"
  | "MEMORY_QUALITY_ISSUE_NOT_FOUND"
  | "MEMORY_QUALITY_VERSION_CONFLICT"
  | "MEMORY_QUALITY_TOO_MANY_ITEMS";

export class MemoryQualityError extends Error {
  constructor(readonly code: MemoryQualityErrorCode) {
    super(code);
    this.name = "MemoryQualityError";
  }
}

const itemMetadataSchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  confidence: z.number().min(0).max(1).nullable().optional(),
  importance: z.number().int().min(0).max(100).optional(),
  validFrom: z.string().datetime({ offset: true }).nullable().optional(),
  validUntil: z.string().datetime({ offset: true }).nullable().optional(),
  pinned: z.boolean().optional(),
  verifyNow: z.boolean().optional(),
}).strict();

const issueResolutionSchema = z.object({
  status: z.enum(["resolved", "dismissed"]),
  note: z.string().trim().min(1).max(2_000),
}).strict();

const issueSelect = {
  id: true,
  kind: true,
  status: true,
  score: true,
  explanation: true,
  detectedAt: true,
  resolvedAt: true,
  resolutionNote: true,
  primaryItem: {
    select: { id: true, type: true, title: true, content: true, reviewStatus: true, confidence: true, importance: true, validUntil: true, pinned: true, lastVerifiedAt: true, updatedAt: true },
  },
  relatedItem: {
    select: { id: true, type: true, title: true, content: true, reviewStatus: true, confidence: true, importance: true, validUntil: true, pinned: true, lastVerifiedAt: true, updatedAt: true },
  },
} satisfies Prisma.MemoryQualityIssueSelect;

type QualityItem = Prisma.ProjectItemGetPayload<{
  select: {
    id: true;
    type: true;
    reviewStatus: true;
    title: true;
    content: true;
    sourceExcerpt: true;
    occurredAt: true;
    confidence: true;
    importance: true;
    validFrom: true;
    validUntil: true;
    pinned: true;
    lastVerifiedAt: true;
    createdAt: true;
    updatedAt: true;
    evidences: { where: { evidenceState: "active"; isActive: true }; select: { id: true } };
  };
}>;

type DetectedIssue = Readonly<{
  kind: MemoryQualityIssueKind;
  primaryItemId: string;
  relatedItemId: string | null;
  score: number;
  fingerprint: string;
  explanation: string;
}>;

function fail(code: MemoryQualityErrorCode): never {
  throw new MemoryQualityError(code);
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return fail("MEMORY_QUALITY_INVALID_INPUT");
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizeMemoryText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .slice(0, 20_000);
}

function ngrams(value: string): Set<string> {
  const normalized = normalizeMemoryText(value);
  if (normalized.length <= 3) return new Set(normalized.length === 0 ? [] : [normalized]);
  const result = new Set<string>();
  for (let index = 0; index <= normalized.length - 3; index += 1) result.add(normalized.slice(index, index + 3));
  return result;
}

export function memoryTextSimilarity(left: string, right: string): number {
  const leftSet = ngrams(left);
  const rightSet = ngrams(right);
  if (leftSet.size === 0 || rightSet.size === 0) return leftSet.size === rightSet.size ? 1 : 0;
  let intersection = 0;
  for (const value of leftSet) if (rightSet.has(value)) intersection += 1;
  return intersection / (leftSet.size + rightSet.size - intersection);
}

function issueFingerprint(projectId: string, kind: MemoryQualityIssueKind, primaryItemId: string, relatedItemId: string | null): string {
  const ids = relatedItemId === null ? [primaryItemId] : [primaryItemId, relatedItemId].sort();
  return sha256([projectId, kind, ...ids].join(":"));
}

function detectedIssue(
  projectId: string,
  kind: MemoryQualityIssueKind,
  primaryItemId: string,
  relatedItemId: string | null,
  score: number,
  explanation: string,
): DetectedIssue {
  const [primary, related] = relatedItemId === null
    ? [primaryItemId, null]
    : [primaryItemId, relatedItemId].sort();
  return Object.freeze({
    kind,
    primaryItemId: primary!,
    relatedItemId: related,
    score: Math.max(0, Math.min(1, score)),
    fingerprint: issueFingerprint(projectId, kind, primary!, related),
    explanation,
  });
}

function analyzeItems(projectId: string, items: readonly QualityItem[], now: Date): DetectedIssue[] {
  const issues = new Map<string, DetectedIssue>();
  const add = (issue: DetectedIssue) => issues.set(issue.fingerprint, issue);

  for (const item of items) {
    if (item.evidences.length === 0 || item.sourceExcerpt?.trim().length === 0) {
      add(detectedIssue(projectId, "missingEvidence", item.id, null, 1, "该条目缺少可定位的活动证据，无法从来源复核。"));
    }
    if (item.confidence !== null && item.confidence < 0.6) {
      add(detectedIssue(projectId, "lowConfidence", item.id, null, 1 - item.confidence, `当前置信度为 ${Math.round(item.confidence * 100)}%，低于 60% 治理阈值。`));
    }
    const referenceAt = item.lastVerifiedAt ?? item.occurredAt ?? item.updatedAt;
    const expiredByValidity = item.validUntil !== null && item.validUntil.getTime() <= now.getTime();
    const agesOut = !item.pinned && (["progress", "issue", "risk"] as ProjectItemType[]).includes(item.type)
      && now.getTime() - referenceAt.getTime() >= STALE_AFTER_MS;
    if (expiredByValidity || agesOut) {
      const days = Math.max(1, Math.floor((now.getTime() - referenceAt.getTime()) / 86_400_000));
      add(detectedIssue(projectId, "stale", item.id, null, expiredByValidity ? 1 : Math.min(1, days / 365), expiredByValidity
        ? "该条目已超过有效截止时间，需要重新确认或归档。"
        : `该条目已约 ${days} 天未验证，需要确认是否仍然有效。`));
    }
  }

  const byType = new Map<ProjectItemType, QualityItem[]>();
  for (const item of items) byType.set(item.type, [...(byType.get(item.type) ?? []), item]);
  for (const group of byType.values()) {
    for (let leftIndex = 0; leftIndex < group.length; leftIndex += 1) {
      const left = group[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex += 1) {
        const right = group[rightIndex]!;
        const titleSimilarity = memoryTextSimilarity(left.title, right.title);
        if (titleSimilarity < 0.72) continue;
        const contentSimilarity = memoryTextSimilarity(left.content, right.content);
        if (titleSimilarity >= 0.82 && contentSimilarity >= 0.88) {
          add(detectedIssue(projectId, "duplicate", left.id, right.id, (titleSimilarity + contentSimilarity) / 2, "两条记忆的标题与内容高度相似，建议合并并保留证据链。"));
          continue;
        }
        if (
          normalizeMemoryText(left.title) === normalizeMemoryText(right.title)
          && left.reviewStatus === "confirmed"
          && right.reviewStatus === "confirmed"
          && contentSimilarity < 0.65
        ) {
          add(detectedIssue(projectId, "conflict", left.id, right.id, 1 - contentSimilarity, "两条已确认记忆使用相同主题但内容差异明显，需要人工判定有效版本。"));
        }
      }
    }
  }
  return [...issues.values()];
}

function qualityScore(issues: readonly { kind: MemoryQualityIssueKind; score: number; primaryItem: { importance: number } }[]): number {
  const weights: Record<MemoryQualityIssueKind, number> = {
    duplicate: 5,
    conflict: 16,
    stale: 4,
    missingEvidence: 12,
    lowConfidence: 8,
  };
  const penalty = issues.reduce((total, issue) => total + weights[issue.kind] * issue.score * (0.5 + issue.primaryItem.importance / 100), 0);
  return Math.max(0, Math.round(100 - Math.min(100, penalty)));
}

async function buildSummary(projectId: string, db: PrismaClient) {
  const issues = await db.memoryQualityIssue.findMany({
    where: { projectId },
    orderBy: [{ status: "asc" }, { detectedAt: "desc" }, { id: "asc" }],
    take: 300,
    select: {
      ...issueSelect,
      primaryItem: { select: issueSelect.primaryItem.select },
    },
  });
  const openIssues = issues.filter((issue) => issue.status === "open");
  const counts = Object.fromEntries(["duplicate", "conflict", "stale", "missingEvidence", "lowConfidence"].map((kind) => [kind, openIssues.filter((issue) => issue.kind === kind).length]));
  return Object.freeze({
    score: qualityScore(openIssues),
    openIssueCount: openIssues.length,
    counts,
    issues,
  });
}

export async function getProjectMemoryQuality(projectIdInput: unknown, db: PrismaClient = getDb()) {
  const projectId = uuid(projectIdInput);
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (project === null) return fail("MEMORY_QUALITY_PROJECT_NOT_FOUND");
  return buildSummary(projectId, db);
}

export async function analyzeProjectMemoryQuality(projectIdInput: unknown, db: PrismaClient = getDb()) {
  const projectId = uuid(projectIdInput);
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (project === null) return fail("MEMORY_QUALITY_PROJECT_NOT_FOUND");
  const items = await db.projectItem.findMany({
    where: { projectId, reviewStatus: { in: ["candidate", "confirmed"] } },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: MAX_ANALYZED_ITEMS + 1,
    select: {
      id: true,
      type: true,
      reviewStatus: true,
      title: true,
      content: true,
      sourceExcerpt: true,
      occurredAt: true,
      confidence: true,
      importance: true,
      validFrom: true,
      validUntil: true,
      pinned: true,
      lastVerifiedAt: true,
      createdAt: true,
      updatedAt: true,
      evidences: { where: { evidenceState: "active", isActive: true }, select: { id: true } },
    },
  });
  if (items.length > MAX_ANALYZED_ITEMS) return fail("MEMORY_QUALITY_TOO_MANY_ITEMS");
  const detected = analyzeItems(projectId, items, new Date());
  const detectedByFingerprint = new Map(detected.map((issue) => [issue.fingerprint, issue]));
  const now = new Date();

  await db.$transaction(async (tx) => {
    const current = await tx.memoryQualityIssue.findMany({ where: { projectId } });
    for (const issue of detected) {
      const existing = current.find((candidate) => candidate.fingerprint === issue.fingerprint);
      if (existing?.status === "dismissed") continue;
      await tx.memoryQualityIssue.upsert({
        where: { projectId_fingerprint: { projectId, fingerprint: issue.fingerprint } },
        create: { projectId, ...issue },
        update: {
          kind: issue.kind,
          primaryItemId: issue.primaryItemId,
          relatedItemId: issue.relatedItemId,
          score: issue.score,
          explanation: issue.explanation,
          status: "open",
          resolvedAt: null,
          resolvedById: null,
          resolutionNote: null,
          detectedAt: now,
        },
      });
    }
    const noLongerDetected = current
      .filter((issue) => issue.status === "open" && !detectedByFingerprint.has(issue.fingerprint))
      .map((issue) => issue.id);
    if (noLongerDetected.length > 0) {
      await tx.memoryQualityIssue.updateMany({
        where: { id: { in: noLongerDetected }, projectId, status: "open" },
        data: { status: "resolved", resolvedAt: now, resolutionNote: "后续检查未再复现该问题。" },
      });
    }
  });
  return buildSummary(projectId, db);
}

export async function resolveMemoryQualityIssue(
  projectIdInput: unknown,
  issueIdInput: unknown,
  input: unknown,
  actor: Pick<AppUser, "id">,
  db: PrismaClient = getDb(),
) {
  const projectId = uuid(projectIdInput);
  const issueId = uuid(issueIdInput);
  const parsed = issueResolutionSchema.parse(input);
  const updated = await db.memoryQualityIssue.updateMany({
    where: { id: issueId, projectId, status: "open" },
    data: { status: parsed.status, resolvedAt: new Date(), resolvedById: actor.id, resolutionNote: parsed.note },
  });
  if (updated.count !== 1) return fail("MEMORY_QUALITY_ISSUE_NOT_FOUND");
  return db.memoryQualityIssue.findUniqueOrThrow({ where: { id: issueId }, select: issueSelect });
}

export async function updateProjectItemMemoryMetadata(
  projectIdInput: unknown,
  itemIdInput: unknown,
  input: unknown,
  actor: Pick<AppUser, "username">,
  db: PrismaClient = getDb(),
) {
  const projectId = uuid(projectIdInput);
  const itemId = uuid(itemIdInput);
  const parsed = itemMetadataSchema.parse(input);
  const expectedUpdatedAt = new Date(parsed.expectedUpdatedAt);
  const validFrom = parsed.validFrom === undefined ? undefined : parsed.validFrom === null ? null : new Date(parsed.validFrom);
  const validUntil = parsed.validUntil === undefined ? undefined : parsed.validUntil === null ? null : new Date(parsed.validUntil);

  return db.$transaction(async (tx) => {
    const current = await tx.projectItem.findUnique({
      where: { projectId_id: { projectId, id: itemId } },
      include: { evidences: { where: { evidenceState: "active", isActive: true } } },
    });
    if (current === null) return fail("MEMORY_QUALITY_ITEM_NOT_FOUND");
    if (current.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return fail("MEMORY_QUALITY_VERSION_CONFLICT");
    const nextValidFrom = validFrom === undefined ? current.validFrom : validFrom;
    const nextValidUntil = validUntil === undefined ? current.validUntil : validUntil;
    if (nextValidFrom !== null && nextValidUntil !== null && nextValidUntil.getTime() <= nextValidFrom.getTime()) {
      return fail("MEMORY_QUALITY_INVALID_INPUT");
    }
    const updatedAt = new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1));
    const changed = await tx.projectItem.updateMany({
      where: { projectId, id: itemId, updatedAt: expectedUpdatedAt },
      data: {
        ...(parsed.confidence === undefined ? {} : { confidence: parsed.confidence }),
        ...(parsed.importance === undefined ? {} : { importance: parsed.importance }),
        ...(validFrom === undefined ? {} : { validFrom }),
        ...(validUntil === undefined ? {} : { validUntil }),
        ...(parsed.pinned === undefined ? {} : { pinned: parsed.pinned }),
        ...(parsed.verifyNow === true ? { lastVerifiedAt: updatedAt } : {}),
        updatedAt,
      },
    });
    if (changed.count !== 1) return fail("MEMORY_QUALITY_VERSION_CONFLICT");
    const updated = await tx.projectItem.findUniqueOrThrow({ where: { projectId_id: { projectId, id: itemId } } });
    await appendProjectItemRevision(tx, {
      item: updated,
      action: ProjectItemRevisionAction.metadataUpdated,
      actorId: `local:${actor.username}`,
      reason: "更新记忆生命周期与质量元数据",
      evidences: current.evidences,
      createdAt: updatedAt,
    });
    return updated;
  });
}
