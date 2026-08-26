import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { getDb } from "@/lib/db";
import { isExactSourceExcerpt, projectItemSelect } from "@/lib/project-item";
import { createProjectItemSchema, projectIdSchema } from "@/lib/validation";

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

export async function GET(_request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const projectId = await parseProjectId(context.params);
    const db = getDb();
    await assertProjectExists(db, projectId);

    const items = await db.projectItem.findMany({
      where: { projectId },
      orderBy: { updatedAt: "desc" },
      select: projectItemSelect,
    });

    return NextResponse.json({ items });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  let parsedProjectId: string | undefined;

  try {
    const projectId = await parseProjectId(context.params);
    parsedProjectId = projectId;
    const db = getDb();
    await assertProjectExists(db, projectId);
    const input = createProjectItemSchema.parse(await readJsonBody(request));
    const source = await db.projectSource.findUnique({
      where: { projectId_id: { projectId, id: input.sourceId } },
      select: { id: true, contentText: true },
    });

    if (!source) {
      // Re-check the parent after a miss so a concurrent project deletion is
      // reported as PROJECT_NOT_FOUND rather than SOURCE_NOT_FOUND.
      await assertProjectExists(db, projectId);
      throw new ApiError(404, "SOURCE_NOT_FOUND", "Source not found");
    }

    if (!isExactSourceExcerpt(source.contentText, input.sourceExcerpt)) {
      throw new ApiError(422, "SOURCE_EXCERPT_MISMATCH", "sourceExcerpt must be an exact non-empty part of the source content");
    }

    const item = await db.projectItem.create({
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
      select: projectItemSelect,
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
