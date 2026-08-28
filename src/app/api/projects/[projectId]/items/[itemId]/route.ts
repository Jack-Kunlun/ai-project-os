import { Prisma, ProjectItemRevisionAction } from "@prisma/client";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  appendProjectItemRevision,
  createPrimaryProjectItemEvidence,
  supersedeProjectItemEvidence,
  type ProjectItemEvidenceReference,
} from "@/lib/project-item-history";
import {
  canApplyItemAction,
  classifyItemMutationMiss,
  isExactSourceExcerpt,
  projectItemSelect,
  type ProjectItemReviewStatus,
} from "@/lib/project-item";
import { projectIdSchema, projectItemIdSchema, updateProjectItemSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

const itemMutationSelect = {
  ...projectItemSelect,
  source: {
    select: {
      ...projectItemSelect.source.select,
      contentText: true,
    },
  },
} as const;

const itemRaceSelect = {
  id: true,
  updatedAt: true,
} as const;

function isKnownError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

async function parseParams(params: Promise<{ projectId: string; itemId: string }>) {
  const { projectId, itemId } = await params;
  return {
    projectId: projectIdSchema.parse(projectId),
    itemId: projectItemIdSchema.parse(itemId),
  };
}

function invalidTransitionError(): ApiError {
  return new ApiError(409, "ITEM_INVALID_TRANSITION", "Item review status does not allow this action");
}

function projectNotFoundError(): ApiError {
  return new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
}

function itemNotFoundError(): ApiError {
  return new ApiError(404, "ITEM_NOT_FOUND", "Item not found");
}

function versionConflictError(): ApiError {
  return new ApiError(409, "ITEM_VERSION_CONFLICT", "Item was updated by another request; refresh and retry");
}

function aiCandidateReviewRequiredError(): ApiError {
  return new ApiError(
    409,
    "AI_CANDIDATE_REVIEW_REQUIRED",
    "AI-generated items must be reviewed in the AI memory workbench",
  );
}

function itemMutationError(code: ReturnType<typeof classifyItemMutationMiss>): ApiError {
  switch (code) {
    case "PROJECT_NOT_FOUND":
      return projectNotFoundError();
    case "ITEM_NOT_FOUND":
      return itemNotFoundError();
    case "ITEM_VERSION_CONFLICT":
      return versionConflictError();
    case "ITEM_INVALID_TRANSITION":
      return invalidTransitionError();
  }
}

async function getMutationMissError(
  db: ReturnType<typeof getDb>,
  projectId: string,
  itemId: string,
  expectedUpdatedAt: Date,
): Promise<ApiError> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } });
  const item = project
    ? await db.projectItem.findUnique({
        where: { projectId_id: { projectId, id: itemId } },
        select: itemRaceSelect,
      })
    : null;

  return itemMutationError(
    classifyItemMutationMiss({
      projectExists: project !== null,
      itemExists: item !== null,
      expectedUpdatedAt,
      actualUpdatedAt: item?.updatedAt,
    }),
  );
}

export async function PATCH(request: Request, context: { params: Promise<{ projectId: string; itemId: string }> }) {
  let parsed: { projectId: string; itemId: string } | undefined;
  let expectedUpdatedAt: Date | undefined;

  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const routeParams = await parseParams(context.params);
    parsed = routeParams;
    const input = updateProjectItemSchema.parse(await readJsonBody(request));
    const expectedVersion = new Date(input.expectedUpdatedAt);
    expectedUpdatedAt = expectedVersion;
    const db = getDb();
    const item = await db.$transaction(async (tx) => {
      const project = await tx.project.findUnique({ where: { id: routeParams.projectId }, select: { id: true } });

      if (!project) {
        throw projectNotFoundError();
      }

      const existing = await tx.projectItem.findUnique({
        where: { projectId_id: { projectId: routeParams.projectId, id: routeParams.itemId } },
        select: itemMutationSelect,
      });

      if (!existing) {
        throw itemNotFoundError();
      }

      if (existing.updatedAt.getTime() !== expectedVersion.getTime()) {
        throw versionConflictError();
      }

      if (
        existing.aiCandidateClaim !== null ||
        existing.webAiCandidate?.reviewStatus === "candidate"
      ) {
        throw aiCandidateReviewRequiredError();
      }

      const currentStatus = existing.reviewStatus as ProjectItemReviewStatus;
      if (!canApplyItemAction(currentStatus, input.action)) {
        throw invalidTransitionError();
      }

      if (input.action === "edit" && !isExactSourceExcerpt(existing.source.contentText, input.sourceExcerpt)) {
        throw new ApiError(422, "SOURCE_EXCERPT_MISMATCH", "sourceExcerpt must be an exact non-empty part of the source content");
      }

      const activeEvidence = await tx.projectItemEvidence.findMany({
        where: {
          projectId: routeParams.projectId,
          projectItemId: routeParams.itemId,
          evidenceState: "active",
          isActive: true,
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
      const currentPrimary = activeEvidence.filter((evidence) => evidence.role === "primary");
      if (currentPrimary.length !== 1 || currentPrimary[0]?.projectSourceId !== existing.sourceId) {
        throw new ApiError(409, "ITEM_EVIDENCE_INVALID", "Item does not have one valid primary evidence record");
      }

      const nextUpdatedAt = new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1));
      const mutationWhere = {
        projectId: routeParams.projectId,
        id: routeParams.itemId,
        reviewStatus: currentStatus,
        updatedAt: existing.updatedAt,
      };
      let updatedCount: number;
      let revisionAction: ProjectItemRevisionAction;
      let revisionEvidence: readonly ProjectItemEvidenceReference[] = activeEvidence;

      if (input.action === "edit") {
        const result = await tx.projectItem.updateMany({
          where: mutationWhere,
          data: {
            type: input.type,
            title: input.title,
            content: input.content,
            sourceExcerpt: input.sourceExcerpt,
            occurredAt: input.occurredAt ? new Date(input.occurredAt) : null,
            reviewStatus: "candidate",
            confirmedAt: null,
            updatedAt: nextUpdatedAt,
          },
        });
        updatedCount = result.count;
        revisionAction = ProjectItemRevisionAction.edited;
      } else if (input.action === "confirm") {
        const result = await tx.projectItem.updateMany({
          where: mutationWhere,
          data: { reviewStatus: "confirmed", confirmedAt: nextUpdatedAt, updatedAt: nextUpdatedAt },
        });
        updatedCount = result.count;
        revisionAction = ProjectItemRevisionAction.confirmed;
      } else if (input.action === "dismiss") {
        const result = await tx.projectItem.updateMany({
          where: mutationWhere,
          data: { reviewStatus: "dismissed", confirmedAt: null, updatedAt: nextUpdatedAt },
        });
        updatedCount = result.count;
        revisionAction = ProjectItemRevisionAction.dismissed;
      } else {
        const result = await tx.projectItem.updateMany({
          where: mutationWhere,
          data: { reviewStatus: "candidate", confirmedAt: null, updatedAt: nextUpdatedAt },
        });
        updatedCount = result.count;
        revisionAction = ProjectItemRevisionAction.reopened;
      }

      if (updatedCount !== 1) {
        throw versionConflictError();
      }

      if (input.action === "edit") {
        await supersedeProjectItemEvidence(tx, {
          projectId: routeParams.projectId,
          projectItemId: routeParams.itemId,
          evidenceId: currentPrimary[0]!.id,
          supersededAt: nextUpdatedAt,
        });
        const replacement = await createPrimaryProjectItemEvidence(tx, {
          projectId: routeParams.projectId,
          projectItemId: routeParams.itemId,
          projectSourceId: existing.sourceId,
          sourceText: existing.source.contentText,
          sourceExcerpt: input.sourceExcerpt,
          originScope: existing.source.originScope,
          projectRepositoryLinkId: existing.source.projectRepositoryLinkId,
          createdAt: nextUpdatedAt,
        });
        revisionEvidence = [
          replacement,
          ...activeEvidence.filter((evidence) => evidence.role === "supporting"),
        ];
      }

      const updated = await tx.projectItem.findUniqueOrThrow({
        where: { projectId_id: { projectId: routeParams.projectId, id: routeParams.itemId } },
      });
      await appendProjectItemRevision(tx, {
        item: updated,
        action: revisionAction,
        actorId: `local:${user.username}`,
        evidences: revisionEvidence,
        createdAt: nextUpdatedAt,
      });

      return tx.projectItem.findUniqueOrThrow({
        where: { projectId_id: { projectId: routeParams.projectId, id: routeParams.itemId } },
        select: projectItemSelect,
      });
    });

    return NextResponse.json({ item });
  } catch (error) {
    if (isKnownError(error, "P2025") && parsed && expectedUpdatedAt) {
      try {
        return handleApiError(await getMutationMissError(getDb(), parsed.projectId, parsed.itemId, expectedUpdatedAt));
      } catch (lookupError) {
        return handleApiError(lookupError);
      }
    }

    return handleApiError(error);
  }
}
