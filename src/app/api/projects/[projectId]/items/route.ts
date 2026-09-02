import { Prisma, ProjectItemRevisionAction } from "@prisma/client";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  appendProjectItemRevision,
  createPrimaryProjectItemEvidence,
} from "@/lib/project-item-history";
import { isExactSourceExcerpt, projectItemSelect } from "@/lib/project-item";
import { createProjectItemSchema, listProjectItemsQuerySchema, projectIdSchema } from "@/lib/validation";
import { assertProjectActive } from "@/lib/project-lifecycle";
import { listPagination } from "@/lib/list-pagination";

export const dynamic = "force-dynamic";

function isKnownError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

async function parseProjectId(params: Promise<{ projectId: string }>): Promise<string> {
  const { projectId } = await params;
  return projectIdSchema.parse(projectId);
}

async function assertProjectExists(db: ReturnType<typeof getDb>, projectId: string): Promise<void> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true } });

  if (!project) {
    throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
  }
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    await requireApiSession(request);
    const projectId = await parseProjectId(context.params);
    const db = getDb();
    await assertProjectExists(db, projectId);
    const searchParams = new URL(request.url).searchParams;
    for (const key of new Set(searchParams.keys())) {
      if (searchParams.getAll(key).length !== 1) throw new ApiError(400, "INVALID_QUERY", `Query parameter ${key} must be unique`);
    }
    const query = listProjectItemsQuerySchema.parse(Object.fromEntries(searchParams));
    const where: Prisma.ProjectItemWhereInput = {
      projectId,
      ...(query.type === "all" ? {} : { type: query.type }),
      ...(query.reviewStatus === "all" ? {} : { reviewStatus: query.reviewStatus }),
      ...(query.search ? {
        OR: [
          { title: { contains: query.search, mode: "insensitive" } },
          { content: { contains: query.search, mode: "insensitive" } },
          { sourceExcerpt: { contains: query.search, mode: "insensitive" } },
        ],
      } : {}),
    };

    const [items, total, statusCounts] = await Promise.all([
      db.projectItem.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: projectItemSelect,
      }),
      db.projectItem.count({ where }),
      db.projectItem.groupBy({
        by: ["reviewStatus"],
        where: { projectId },
        _count: { _all: true },
      }),
    ]);
    const counts = { candidate: 0, confirmed: 0, dismissed: 0, superseded: 0 };
    for (const entry of statusCounts) counts[entry.reviewStatus] = entry._count._all;

    return NextResponse.json({ items, counts, pagination: listPagination(query.page, query.pageSize, total) });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  let parsedProjectId: string | undefined;

  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    const projectId = await parseProjectId(context.params);
    parsedProjectId = projectId;
    const db = getDb();
    await assertProjectActive(projectId, db);
    const input = createProjectItemSchema.parse(await readJsonBody(request));
    const item = await db.$transaction(async (tx) => {
      const source = await tx.projectSource.findUnique({
        where: { projectId_id: { projectId, id: input.sourceId } },
        select: { id: true, contentText: true, retiredAt: true },
      });

      if (!source || source.retiredAt !== null) {
        const project = await tx.project.findUnique({
          where: { id: projectId },
          select: { id: true },
        });
        if (!project) {
          throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
        }
        throw new ApiError(404, "SOURCE_NOT_FOUND", "Source not found");
      }

      if (!isExactSourceExcerpt(source.contentText, input.sourceExcerpt)) {
        throw new ApiError(422, "SOURCE_EXCERPT_MISMATCH", "sourceExcerpt must be an exact non-empty part of the source content");
      }

      const created = await tx.projectItem.create({
        data: {
          projectId,
          type: input.type,
          reviewStatus: "candidate",
          sourceId: input.sourceId,
          title: input.title,
          content: input.content,
          sourceExcerpt: input.sourceExcerpt,
          occurredAt: input.occurredAt ? new Date(input.occurredAt) : null,
          confirmedAt: null,
          supersedesItemId: null,
          metadata: {},
        },
      });
      const evidence = await createPrimaryProjectItemEvidence(tx, {
        projectId,
        projectItemId: created.id,
        projectSourceId: source.id,
        sourceText: source.contentText,
        sourceExcerpt: input.sourceExcerpt,
        createdAt: created.createdAt,
      });
      await appendProjectItemRevision(tx, {
        item: created,
        action: ProjectItemRevisionAction.manualCreated,
        actorId: "local:user",
        evidences: [evidence],
        createdAt: created.createdAt,
      });

      return tx.projectItem.findUniqueOrThrow({
        where: { projectId_id: { projectId, id: created.id } },
        select: projectItemSelect,
      });
    });

    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    if (isKnownError(error, "P2003")) {
      try {
        if (!parsedProjectId) {
          return handleApiError(error);
        }
        const db = getDb();
        const project = await db.project.findUnique({ where: { id: parsedProjectId }, select: { id: true } });
        if (!project) {
          return handleApiError(new ApiError(404, "PROJECT_NOT_FOUND", "Project not found"));
        }
      } catch (lookupError) {
        return handleApiError(lookupError);
      }

      return handleApiError(new ApiError(404, "SOURCE_NOT_FOUND", "Source not found"));
    }

    return handleApiError(error);
  }
}
