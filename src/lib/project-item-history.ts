import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  ProjectItemEvidenceRole,
  ProjectItemRevisionAction,
  type ProjectItemReviewStatus,
  type ProjectItemType,
} from "@prisma/client";
import { locateExactSourceExcerpt } from "@/lib/project-item";

const ACTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

export type ProjectItemHistorySnapshot = {
  id: string;
  projectId: string;
  type: ProjectItemType;
  reviewStatus: ProjectItemReviewStatus;
  sourceId: string;
  title: string;
  content: string;
  sourceExcerpt: string | null;
  occurredAt: Date | null;
  confirmedAt: Date | null;
  supersedesItemId: string | null;
  metadata: Prisma.JsonValue;
};

export type ProjectItemEvidenceReference = {
  id: string;
  role: ProjectItemEvidenceRole;
  projectSourceId: string | null;
  sourceExcerpt: string | null;
  sourceExcerptFingerprint: string | null;
  rangeStart: number | null;
  rangeEnd: number | null;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function evidenceIdentity(evidence: ProjectItemEvidenceReference): string {
  if (
    evidence.projectSourceId === null ||
    evidence.sourceExcerptFingerprint === null ||
    evidence.rangeStart === null ||
    evidence.rangeEnd === null
  ) {
    throw new Error("PROJECT_ITEM_ACTIVE_EVIDENCE_REQUIRED");
  }

  return [
    evidence.projectSourceId,
    evidence.sourceExcerptFingerprint,
    evidence.rangeStart,
    evidence.rangeEnd,
  ].join(":");
}

export function buildEvidenceManifestFingerprint(
  evidences: readonly ProjectItemEvidenceReference[],
): string {
  if (evidences.length === 0) {
    throw new Error("PROJECT_ITEM_ACTIVE_EVIDENCE_REQUIRED");
  }

  return sha256(evidences.map(evidenceIdentity).sort().join("\n"));
}

export async function createPrimaryProjectItemEvidence(
  tx: Prisma.TransactionClient,
  input: {
    projectId: string;
    projectItemId: string;
    projectSourceId: string;
    sourceText: string;
    sourceExcerpt: string;
    createdAt?: Date;
  },
): Promise<ProjectItemEvidenceReference> {
  const range = locateExactSourceExcerpt(input.sourceText, input.sourceExcerpt);
  if (range === null) {
    throw new Error("PROJECT_ITEM_SOURCE_EXCERPT_MISMATCH");
  }

  return tx.projectItemEvidence.create({
    data: {
      id: randomUUID(),
      projectId: input.projectId,
      projectItemId: input.projectItemId,
      role: ProjectItemEvidenceRole.primary,
      evidenceState: "active",
      originScope: "project",
      projectRepositoryLinkId: null,
      projectSourceId: input.projectSourceId,
      sourceExcerpt: input.sourceExcerpt,
      sourceExcerptFingerprint: sha256(input.sourceExcerpt),
      rangeUnit: "utf8_byte",
      rangeStart: range.rangeStart,
      rangeEnd: range.rangeEnd,
      isActive: true,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    },
    select: {
      id: true,
      role: true,
      projectSourceId: true,
      sourceExcerpt: true,
      sourceExcerptFingerprint: true,
      rangeStart: true,
      rangeEnd: true,
    },
  });
}

export async function supersedeProjectItemEvidence(
  tx: Prisma.TransactionClient,
  input: {
    projectId: string;
    projectItemId: string;
    evidenceId: string;
    supersededAt: Date;
  },
): Promise<void> {
  const result = await tx.projectItemEvidence.updateMany({
    where: {
      id: input.evidenceId,
      projectId: input.projectId,
      projectItemId: input.projectItemId,
      evidenceState: "active",
      isActive: true,
    },
    data: {
      isActive: false,
      supersededAt: input.supersededAt,
    },
  });

  if (result.count !== 1) {
    throw new Error("PROJECT_ITEM_ACTIVE_EVIDENCE_REQUIRED");
  }
}

export async function appendProjectItemRevision(
  tx: Prisma.TransactionClient,
  input: {
    item: ProjectItemHistorySnapshot;
    action: ProjectItemRevisionAction;
    actorId: string;
    reason?: string | null;
    evidences: readonly ProjectItemEvidenceReference[];
    createdAt?: Date;
  },
): Promise<{ id: string; revisionNumber: number }> {
  if (!ACTOR_ID_PATTERN.test(input.actorId)) {
    throw new Error("PROJECT_ITEM_REVISION_ACTOR_INVALID");
  }

  const primaryEvidence = input.evidences.filter(
    (evidence) => evidence.role === ProjectItemEvidenceRole.primary,
  );
  if (
    primaryEvidence.length !== 1 ||
    input.item.sourceId !== primaryEvidence[0]?.projectSourceId ||
    input.item.sourceExcerpt !== primaryEvidence[0]?.sourceExcerpt
  ) {
    throw new Error("PROJECT_ITEM_PRIMARY_EVIDENCE_MISMATCH");
  }

  const latest = await tx.projectItemRevision.findFirst({
    where: {
      projectId: input.item.projectId,
      projectItemId: input.item.id,
    },
    orderBy: { revisionNumber: "desc" },
    select: { revisionNumber: true },
  });
  const revisionNumber = (latest?.revisionNumber ?? 0) + 1;
  const revisionId = randomUUID();

  await tx.projectItemRevision.create({
    data: {
      id: revisionId,
      projectId: input.item.projectId,
      projectItemId: input.item.id,
      revisionNumber,
      action: input.action,
      actorId: input.actorId,
      reason: input.reason ?? null,
      itemType: input.item.type,
      reviewStatus: input.item.reviewStatus,
      title: input.item.title,
      content: input.item.content,
      sourceId: input.item.sourceId,
      sourceExcerpt: input.item.sourceExcerpt,
      occurredAt: input.item.occurredAt,
      confirmedAt: input.item.confirmedAt,
      supersedesItemId: input.item.supersedesItemId,
      metadata: input.item.metadata as Prisma.InputJsonValue,
      evidenceManifestFingerprint: buildEvidenceManifestFingerprint(input.evidences),
      integrityState: "active",
      deletionReceipt: null,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    },
  });

  await tx.projectItemRevisionEvidence.createMany({
    data: input.evidences.map((evidence) => ({
      id: randomUUID(),
      projectId: input.item.projectId,
      projectItemId: input.item.id,
      revisionId,
      evidenceId: evidence.id,
      role: evidence.role,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    })),
  });

  return { id: revisionId, revisionNumber };
}
