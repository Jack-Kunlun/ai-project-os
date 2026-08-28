import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-errors";
import { handleApiError } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { projectIdSchema } from "@/lib/validation";
import { z } from "zod";

export const dynamic = "force-dynamic";

const sourceIdSchema = z.string().uuid("sourceId must be a valid UUID");

function isKnownError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

async function parseParams(params: Promise<{ projectId: string; sourceId: string }>) {
  const { projectId, sourceId } = await params;
  return {
    projectId: projectIdSchema.parse(projectId),
    sourceId: sourceIdSchema.parse(sourceId),
  };
}

export async function DELETE(request: Request, context: { params: Promise<{ projectId: string; sourceId: string }> }) {
  try {
    assertSameOrigin(request);
    await requireApiSession(request);
    const { projectId, sourceId } = await parseParams(context.params);
    const db = getDb();
    const source = await db.projectSource.findUnique({
      where: { projectId_id: { projectId, id: sourceId } },
      select: { id: true },
    });

    if (!source) {
      throw new ApiError(404, "SOURCE_NOT_FOUND", "Source not found");
    }

    await db.projectSource.delete({ where: { projectId_id: { projectId, id: sourceId } } });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (isKnownError(error, "P2003")) {
      return handleApiError(new ApiError(409, "SOURCE_IN_USE", "Source is referenced by project records"));
    }

    if (isKnownError(error, "P2025")) {
      return handleApiError(new ApiError(404, "SOURCE_NOT_FOUND", "Source not found"));
    }

    return handleApiError(error);
  }
}
