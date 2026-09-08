import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-errors";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { withWebAiProjectAccessTransaction } from "@/lib/access-linearization";
import { getDb } from "@/lib/db";
import { hashSourceContent } from "@/lib/source";
import { createProjectSourceSchema, listProjectSourcesQuerySchema, projectIdSchema } from "@/lib/validation";
import { listPagination } from "@/lib/list-pagination";
import { nonLegacyMcpProjectSourceWhere } from "@/lib/legacy-mcp-source-quarantine";

export const dynamic = "force-dynamic";

const sourceSummarySelect = {
  id: true,
  kind: true,
  capturedAt: true,
  ingestedAt: true,
} as const;

// Select the body only inside the server-side projection. The list response
// below deliberately removes it and exposes a bounded preview instead.
const sourceListRecordSelect = {
  ...sourceSummarySelect,
  contentText: true,
} as const;

const sourceDetailSelect = {
  ...sourceSummarySelect,
  contentText: true,
  contentHash: true,
} as const;

function sourcePreview(contentText: string): string {
  const compact = contentText.replace(/\s+/g, " ").trim();
  return compact.length > 180 ? `${compact.slice(0, 180)}…` : compact;
}

function toSourceSummary(source: Prisma.ProjectSourceGetPayload<{ select: typeof sourceListRecordSelect }>) {
  const { contentText, ...summary } = source;
  return { ...summary, preview: sourcePreview(contentText) };
}

function isKnownError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

async function parseProjectId(params: Promise<{ projectId: string }>): Promise<string> {
  const { projectId } = await params;
  return projectIdSchema.parse(projectId);
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const user = await requireApiSession(request);
    const projectId = await parseProjectId(context.params);
    const db = getDb();
    const searchParams = new URL(request.url).searchParams;
    for (const key of new Set(searchParams.keys())) {
      if (searchParams.getAll(key).length !== 1) throw new ApiError(400, "INVALID_QUERY", `Query parameter ${key} must be unique`);
    }
    const query = listProjectSourcesQuerySchema.parse(Object.fromEntries(searchParams));
    const where: Prisma.ProjectSourceWhereInput = {
      projectId,
      ...nonLegacyMcpProjectSourceWhere,
      ...(query.kind === "all" ? {} : { kind: query.kind }),
      ...(query.search ? {
        OR: [
          { externalRef: { contains: query.search, mode: "insensitive" } },
          { contentText: { contains: query.search, mode: "insensitive" } },
          { contentHash: { contains: query.search, mode: "insensitive" } },
        ],
      } : {}),
    };

    const { sources, total } = await withWebAiProjectAccessTransaction(
      db,
      { actor: user, projectId, required: "view", allowArchived: true },
      async (tx) => {
        const [sources, total] = await Promise.all([
          tx.projectSource.findMany({
            where,
            orderBy: [{ ingestedAt: "desc" }, { id: "desc" }],
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize,
            select: sourceListRecordSelect,
          }),
          tx.projectSource.count({ where }),
        ]);
        return { sources, total };
      },
    );

    return NextResponse.json({ sources: sources.map(toSourceSummary), pagination: listPagination(query.page, query.pageSize, total) }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const projectId = await parseProjectId(context.params);
    const input = createProjectSourceSchema.parse(await readJsonBody(request));
    const db = getDb();
    const contentHash = hashSourceContent(input.contentText);

    const source = await withWebAiProjectAccessTransaction(db, {
      actor: user,
      projectId,
      required: "edit",
    }, (tx) => tx.projectSource.create({
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
        select: sourceDetailSelect,
      }));

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
