import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-errors";
import { handleApiError } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { withWebAiProjectAccessTransaction } from "@/lib/access-linearization";
import { getDb } from "@/lib/db";
import { projectIdSchema } from "@/lib/validation";
import { z } from "zod";
import { nonLegacyMcpProjectSourceWhere } from "@/lib/legacy-mcp-source-quarantine";

export const dynamic = "force-dynamic";

const sourceIdSchema = z.string().uuid("sourceId must be a valid UUID");

function isKnownError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

function isForeignKeyViolation(error: unknown): boolean {
  if (isKnownError(error, "P2003")) return true;
  if (typeof error !== "object" || error === null || !("cause" in error)) return false;
  const cause = error.cause;
  return typeof cause === "object"
    && cause !== null
    && "originalCode" in cause
    && cause.originalCode === "23503"
    && "kind" in cause
    && cause.kind === "ForeignKeyConstraintViolation";
}

async function parseParams(params: Promise<{ projectId: string; sourceId: string }>) {
  const { projectId, sourceId } = await params;
  return {
    projectId: projectIdSchema.parse(projectId),
    sourceId: sourceIdSchema.parse(sourceId),
  };
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string; sourceId: string }> }) {
  try {
    await requireApiSession(request);
    const { projectId, sourceId } = await parseParams(context.params);
    const source = await getDb().projectSource.findFirst({
      where: { projectId, id: sourceId, ...nonLegacyMcpProjectSourceWhere },
      select: {
        id: true,
        kind: true,
        externalRef: true,
        contentText: true,
        contentHash: true,
        capturedAt: true,
        ingestedAt: true,
      },
    });
    if (!source) throw new ApiError(404, "SOURCE_NOT_FOUND", "Source not found");
    return NextResponse.json({ source }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ projectId: string; sourceId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const { projectId, sourceId } = await parseParams(context.params);
    const db = getDb();
    await withWebAiProjectAccessTransaction(db, {
      actor: user,
      projectId,
      required: "edit",
    }, async (tx) => {
      const source = await tx.projectSource.findFirst({
        where: { projectId, id: sourceId, ...nonLegacyMcpProjectSourceWhere },
        select: { id: true },
      });

      if (!source) {
        throw new ApiError(404, "SOURCE_NOT_FOUND", "Source not found");
      }

      await tx.projectSource.delete({ where: { projectId_id: { projectId, id: sourceId } } });
    });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    // A deferred PostgreSQL foreign key is evaluated when the interactive
    // transaction commits. Prisma's pg adapter surfaces that commit failure as
    // a DriverAdapterError instead of P2003, so recognize only the exact 23503
    // shape and preserve the existing bounded API error.
    if (isForeignKeyViolation(error)) {
      return handleApiError(new ApiError(409, "SOURCE_IN_USE", "Source is referenced by project records"));
    }

    if (isKnownError(error, "P2025")) {
      return handleApiError(new ApiError(404, "SOURCE_NOT_FOUND", "Source not found"));
    }

    return handleApiError(error);
  }
}
