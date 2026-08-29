import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { assertProjectActive } from "@/lib/project-lifecycle";
import { projectIdSchema, updateProjectSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

const projectDetailSelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  _count: {
    select: {
      sources: { where: { retiredAt: null } },
      assets: { where: { status: { not: "deleted" } } },
      items: true,
      scans: true,
      snapshots: true,
    },
  },
} as const;

function isKnownError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

async function parseProjectId(params: Promise<{ projectId: string }>): Promise<string> {
  const { projectId } = await params;
  return projectIdSchema.parse(projectId);
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    await requireApiSession(request);
    const db = getDb();
    const projectId = await parseProjectId(context.params);
    const project = await db.project.findUnique({ where: { id: projectId }, select: projectDetailSelect });

    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
    }

    return NextResponse.json({ project });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    const db = getDb();
    const projectId = await parseProjectId(context.params);
    await assertProjectActive(projectId, db);
    const input = updateProjectSchema.parse(await readJsonBody(request));
    const project = await db.project.update({
      where: { id: projectId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
      select: projectDetailSelect,
    });

    return NextResponse.json({ project });
  } catch (error) {
    if (isKnownError(error, "P2025")) {
      return handleApiError(new ApiError(404, "PROJECT_NOT_FOUND", "Project not found"));
    }

    if (isKnownError(error, "P2002")) {
      return handleApiError(new ApiError(400, "PROJECT_SLUG_CONFLICT", "A project with this slug already exists"));
    }

    return handleApiError(error);
  }
}
