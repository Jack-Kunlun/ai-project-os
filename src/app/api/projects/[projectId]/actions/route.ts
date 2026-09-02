import { NextResponse } from "next/server";
import { z } from "zod";
import { getProjectActionCenter, requestProjectAction } from "@/lib/action-engine";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE } from "@/lib/list-pagination";
import { assertProjectActive } from "@/lib/project-lifecycle";

export const dynamic = "force-dynamic";
const idSchema = z.string().uuid();
const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(DEFAULT_LIST_PAGE_SIZE),
  search: z.string().trim().max(120).optional(),
  capability: z.enum(["all", "project.repository.sync", "project.web-source.sync", "project.memory-quality.scan", "project.mcp.read-tool.invoke"]).default("all"),
  status: z.enum(["all", "waitingApproval", "queued", "running", "succeeded", "failed", "rejected", "cancelled", "expired"]).default("all"),
}).strict();

async function projectId(params: Promise<{ projectId: string }>) {
  return idSchema.parse((await params).projectId);
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const user = await requireApiSession(request);
    const searchParams = new URL(request.url).searchParams;
    const query = listSchema.parse(Object.fromEntries(searchParams));
    return NextResponse.json(await getProjectActionCenter(await projectId(context.params), user, {
      page: query.page,
      pageSize: query.pageSize,
      search: query.search,
      capability: query.capability === "all" ? undefined : query.capability,
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
    const id = await projectId(context.params);
    await assertProjectActive(id);
    const action = await requestProjectAction(id, await readJsonBody(request), user);
    return NextResponse.json({ action }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
