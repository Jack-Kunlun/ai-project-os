import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { hashSourceContent } from "@/lib/source";
import { createProjectSourceSchema, projectIdSchema } from "@/lib/validation";
import { assertProjectActive } from "@/lib/project-lifecycle";

export const dynamic = "force-dynamic";

const sourceSelect = {
  id: true,
  kind: true,
  externalRef: true,
  contentText: true,
  contentHash: true,
  capturedAt: true,
  ingestedAt: true,
} as const;

function isKnownError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

async function parseProjectId(params: Promise<{ projectId: string }>): Promise<string> {
  const { projectId } = await params;
  return projectIdSchema.parse(projectId);
}

async function assertProjectExists(projectId: string): Promise<void> {
  const db = getDb();
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
    await assertProjectExists(projectId);

    const sources = await db.projectSource.findMany({
      where: { projectId },
      orderBy: { ingestedAt: "desc" },
      select: sourceSelect,
    });

    return NextResponse.json({ sources });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    const projectId = await parseProjectId(context.params);
    const input = createProjectSourceSchema.parse(await readJsonBody(request));
    const db = getDb();
    await assertProjectActive(projectId, db);
    const contentHash = hashSourceContent(input.contentText);

    const source = await db.projectSource.create({
      data: {
        projectId,
        kind: "manual",
        originScope: "project",
        projectRepositoryLinkId: null,
        externalRef: input.externalRef ?? null,
        contentText: input.contentText,
        contentHash,
        manualContentDedupeKey: contentHash,
        capturedAt: input.capturedAt ? new Date(input.capturedAt) : null,
      },
      select: sourceSelect,
    });

    return NextResponse.json({ source }, { status: 201 });
  } catch (error) {
    if (isKnownError(error, "P2002")) {
      return handleApiError(new ApiError(409, "SOURCE_CONTENT_DUPLICATE", "This source content already exists in the project"));
    }

    if (isKnownError(error, "P2003")) {
      return handleApiError(new ApiError(404, "PROJECT_NOT_FOUND", "Project not found"));
    }

    return handleApiError(error);
  }
}
