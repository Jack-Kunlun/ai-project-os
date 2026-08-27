import { Prisma, ProjectItemRevisionAction } from "@prisma/client";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { getDb } from "@/lib/db";
import {
  appendProjectItemRevision,
  createPrimaryProjectItemEvidence,
} from "@/lib/project-item-history";
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
    const item = await db.$transaction(async (tx) => {
      const source = await tx.projectSource.findUnique({
        where: { projectId_id: { projectId, id: input.sourceId } },
        select: { id: true, contentText: true },
      });

      if (!source) {
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
