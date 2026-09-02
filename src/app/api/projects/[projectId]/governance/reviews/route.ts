import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth";
import { ApiError } from "@/lib/api-errors";
import { handleApiError } from "@/lib/api-response";
import { listGovernanceReviews } from "@/lib/project-governance";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();
const querySchema = z.object({
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  search: z.string().trim().max(120).optional(),
  itemType: z.enum(["decision", "progress", "issue", "risk"]).optional(),
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
    const page = await listGovernanceReviews(projectId, query);
    if (page === null) throw new ApiError(404, "PROJECT_NOT_FOUND", "Project not found");
    return NextResponse.json(page, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
