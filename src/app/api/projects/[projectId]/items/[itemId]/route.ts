import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { getDb } from "@/lib/db";
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
    parsed = await parseParams(context.params);
    const input = updateProjectItemSchema.parse(await readJsonBody(request));
    expectedUpdatedAt = new Date(input.expectedUpdatedAt);
    const db = getDb();
    const project = await db.project.findUnique({ where: { id: parsed.projectId }, select: { id: true } });

    if (!project) {
      throw projectNotFoundError();
    }

    const existing = await db.projectItem.findUnique({
      where: { projectId_id: { projectId: parsed.projectId, id: parsed.itemId } },
      select: itemMutationSelect,
    });

    if (!existing) {
      throw await getMutationMissError(db, parsed.projectId, parsed.itemId, expectedUpdatedAt);
    }

    if (existing.updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
      throw versionConflictError();
    }

    const currentStatus = existing.reviewStatus as ProjectItemReviewStatus;
    if (!canApplyItemAction(currentStatus, input.action)) {
      throw invalidTransitionError();
    }

    if (input.action === "edit" && !isExactSourceExcerpt(existing.source.contentText, input.sourceExcerpt)) {
      throw new ApiError(422, "SOURCE_EXCERPT_MISMATCH", "sourceExcerpt must be an exact non-empty part of the source content");
    }

    const nextUpdatedAt = new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1));
    const mutationWhere = {
      projectId: parsed.projectId,
      id: parsed.itemId,
      reviewStatus: currentStatus,
      updatedAt: existing.updatedAt,
    };
    let updatedCount: number;

    if (input.action === "edit") {
      const result = await db.projectItem.updateMany({
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
    } else if (input.action === "confirm") {
      const result = await db.projectItem.updateMany({
        where: mutationWhere,
        data: { reviewStatus: "confirmed", confirmedAt: new Date(), updatedAt: nextUpdatedAt },
      });
      updatedCount = result.count;
    } else if (input.action === "dismiss") {
      const result = await db.projectItem.updateMany({
        where: mutationWhere,
        data: { reviewStatus: "dismissed", confirmedAt: null, updatedAt: nextUpdatedAt },
      });
      updatedCount = result.count;
    } else {
      const result = await db.projectItem.updateMany({
        where: mutationWhere,
        data: { reviewStatus: "candidate", confirmedAt: null, updatedAt: nextUpdatedAt },
      });
      updatedCount = result.count;
    }

    if (updatedCount !== 1) {
      throw await getMutationMissError(db, parsed.projectId, parsed.itemId, expectedUpdatedAt);
    }

    const item = await db.projectItem.findUnique({
      where: { projectId_id: { projectId: parsed.projectId, id: parsed.itemId } },
      select: projectItemSelect,
    });

    if (!item) {
      throw await getMutationMissError(db, parsed.projectId, parsed.itemId, expectedUpdatedAt);
    }

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
