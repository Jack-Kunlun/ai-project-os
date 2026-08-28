import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { getProjectGitHubSync } from "@/lib/github";
import { PROJECT_GITHUB_SYNC_CHANGE_PAGE_MAX, PROJECT_GITHUB_SYNC_CHANGE_PAGE_SIZE } from "@/lib/github";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const pageSchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(PROJECT_GITHUB_SYNC_CHANGE_PAGE_MAX).default(PROJECT_GITHUB_SYNC_CHANGE_PAGE_SIZE),
}).strict();

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; syncRunId: string }> },
) {
  try {
    await requireApiSession(request);
    const params = await context.params;
    const projectId = idSchema.parse(params.projectId);
    const syncRunId = idSchema.parse(params.syncRunId);
    const url = new URL(request.url);
    const page = pageSchema.parse({
      offset: url.searchParams.get("offset") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    return NextResponse.json(await getProjectGitHubSync({ projectId, syncRunId }, undefined, page), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
