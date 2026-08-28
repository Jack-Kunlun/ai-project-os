import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth";
import { ApiError } from "@/lib/api-errors";
import { handleApiError } from "@/lib/api-response";
import { getProjectGovernanceSummary } from "@/lib/project-governance";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    await requireApiSession(request);
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].length > 0) throw new ApiError(400, "INVALID_QUERY", "Query parameters are not supported");
    const { projectId: rawProjectId } = await context.params;
    const projectId = idSchema.parse(rawProjectId);
    const summary = await getProjectGovernanceSummary(projectId);
    if (summary === null) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
    return NextResponse.json({ summary }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
