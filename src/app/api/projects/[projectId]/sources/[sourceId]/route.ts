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
import { isCurrentProjectSourceCitation } from "@/lib/project-source-citation";

export const dynamic = "force-dynamic";

const sourceIdSchema = z.string().uuid("sourceId must be a valid UUID");
const contentHashSchema = z.string().regex(/^[0-9a-f]{64}$/iu, "contentHash must be a SHA-256 fingerprint");

function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

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
    const user = await requireApiSession(request);
    const { projectId, sourceId } = await parseParams(context.params);
    const contentHashes = new URL(request.url).searchParams.getAll("contentHash");
    if (contentHashes.length > 1) {
      throw new ApiError(400, "SOURCE_CITATION_INVALID", "来源引用无效");
    }
    const parsedContentHash = contentHashes[0] === undefined
      ? null
      : contentHashSchema.safeParse(contentHashes[0]);
    if (parsedContentHash !== null && !parsedContentHash.success) {
      throw new ApiError(400, "SOURCE_CITATION_INVALID", "来源引用无效");
    }
    const expectedContentHash = parsedContentHash?.data ?? null;
    const db = getDb();
    const isCitationRequest = expectedContentHash !== null;
    const payload = await withWebAiProjectAccessTransaction(
      db,
      { actor: user, projectId, required: "view", allowArchived: true },
      async (tx) => {
        // FOR SHARE holds the source version against retirement/content edits
        // until the citation is checked and its response is assembled.
        const source = isCitationRequest
          ? (await tx.$queryRaw<Array<{
            id: string;
            kind: string;
            externalRef: string | null;
            contentText: string;
            contentHash: string;
            capturedAt: Date | null;
            ingestedAt: Date;
            retiredAt: Date | null;
          }>>(Prisma.sql`
            SELECT "id"::text AS "id", "kind"::text AS "kind", "externalRef",
                   "contentText", "contentHash", "capturedAt", "ingestedAt", "retiredAt"
              FROM "ProjectSource"
             WHERE "projectId" = ${projectId}::uuid
               AND "id" = ${sourceId}::uuid
               AND "kind"::text <> 'mcp'
             FOR SHARE
          `))[0] ?? null
          : await tx.projectSource.findFirst({
            where: { projectId, id: sourceId, ...nonLegacyMcpProjectSourceWhere },
            select: {
              id: true, kind: true, externalRef: true, contentText: true,
              contentHash: true, capturedAt: true, ingestedAt: true, retiredAt: true,
            },
          });
        if (isCitationRequest && (source === null || !isCurrentProjectSourceCitation({
          expectedContentHash,
          currentContentHash: source.contentHash,
          retiredAt: source.retiredAt,
        }))) {
          throw new ApiError(409, "SOURCE_CITATION_STALE", "搜索引用的资料已更新、退役或不存在，请重新搜索");
        }
        if (!source) throw new ApiError(404, "SOURCE_NOT_FOUND", "Source not found");
        return {
          source: {
            id: source.id,
            kind: source.kind,
            externalRef: source.externalRef,
            contentText: source.contentText,
            contentHash: source.contentHash,
            capturedAt: source.capturedAt,
            ingestedAt: source.ingestedAt,
          },
        };
      },
    );
    return noStore(NextResponse.json(payload));
  } catch (error) {
    return noStore(handleApiError(error));
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
