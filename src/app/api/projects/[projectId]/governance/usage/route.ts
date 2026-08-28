import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError } from "@/lib/api-errors";
import { handleApiError } from "@/lib/api-response";
import { requireApiSession } from "@/lib/auth";
import { getProjectUsageSummary, PROJECT_USAGE_PERIODS } from "@/lib/project-usage";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const querySchema = z.object({
  days: z.enum(["7", "30", "90"])
    .default("30")
    .transform((value) => Number(value) as (typeof PROJECT_USAGE_PERIODS)[number]),
}).strict();

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  try {
    await requireApiSession(request);
    const { projectId: rawProjectId } = await context.params;
    const projectId = idSchema.parse(rawProjectId);
    const searchParams = new URL(request.url).searchParams;
    for (const key of new Set(searchParams.keys())) {
      if (searchParams.getAll(key).length !== 1) throw new ApiError(400, "INVALID_QUERY", `Query parameter ${key} must be unique`);
    }
    const query = querySchema.parse(Object.fromEntries(searchParams));
    const usage = await getProjectUsageSummary(projectId, query.days);
    if (usage === null) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
    return NextResponse.json({ usage }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
