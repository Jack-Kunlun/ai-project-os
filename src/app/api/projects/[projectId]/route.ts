import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { withWebAiProjectAccessTransaction } from "@/lib/access-linearization";
import { getDb } from "@/lib/db";
import { deleteArchivedProject } from "@/lib/project-lifecycle";
import { projectIdSchema, updateProjectSchema } from "@/lib/validation";
import {
  nonLegacyMcpProjectItemWhere,
  nonLegacyMcpProjectSourceWhere,
} from "@/lib/legacy-mcp-source-quarantine";

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
      sources: { where: nonLegacyMcpProjectSourceWhere },
      assets: { where: { status: { not: "deleted" } } },
      items: { where: nonLegacyMcpProjectItemWhere },
      scans: true,
      snapshots: true,
    },
  },
} as const;

const deleteProjectSchema = z.object({
  confirmationName: z.string().min(1).max(120),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
}).strict();

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
    const user = await requireApiSession(request);
    const db = getDb();
    const projectId = await parseProjectId(context.params);
    const input = updateProjectSchema.parse(await readJsonBody(request));
    const project = await withWebAiProjectAccessTransaction(
      db,
      { actor: user, projectId, required: "edit" },
      (tx) => tx.project.update({
        where: { id: projectId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        },
        select: projectDetailSelect,
      }),
    );

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

export async function DELETE(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const projectId = await parseProjectId(context.params);
    const input = deleteProjectSchema.parse(await readJsonBody(request));
    const deleted = await deleteArchivedProject({
      projectId,
      actor: user,
      confirmationName: input.confirmationName,
      expectedUpdatedAt: new Date(input.expectedUpdatedAt),
    });
    return NextResponse.json({ deleted });
  } catch (error) {
    return handleApiError(error);
  }
}
