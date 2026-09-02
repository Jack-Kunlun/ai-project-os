import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE } from "@/lib/list-pagination";
import { assertProjectActive } from "@/lib/project-lifecycle";
import { createProjectWebSource, listProjectWebSources } from "@/lib/web-sources";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();
const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(DEFAULT_LIST_PAGE_SIZE),
  search: z.string().trim().max(160).optional(),
  status: z.enum(["all", "active", "disabled", "error"]).default("all"),
});

async function projectId(params: Promise<{ projectId: string }>) {
  return idSchema.parse((await params).projectId);
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    await requireApiSession(request);
    const url = new URL(request.url);
    const query = listSchema.parse(Object.fromEntries(url.searchParams));
    return NextResponse.json(await listProjectWebSources(await projectId(context.params), {
      page: query.page,
      pageSize: query.pageSize,
      search: query.search,
      status: query.status === "all" ? undefined : query.status,
    }));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireApiSession(request);
    const resolvedProjectId = await projectId(context.params);
    await assertProjectActive(resolvedProjectId);
    const source = await createProjectWebSource(resolvedProjectId, await readJsonBody(request), user);
    return NextResponse.json({ source }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
