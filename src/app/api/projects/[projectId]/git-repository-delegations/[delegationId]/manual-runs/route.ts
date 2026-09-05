import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { ApiError } from "@/lib/api-errors";
import { listProjectDelegatedGitManualRuns } from "@/lib/project-delegated-git-runtime-service";

export const dynamic = "force-dynamic";

const uuidSchema = z.string().uuid();
const querySchema = z.object({
  cursor: z.string().trim().min(1).max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string; delegationId: string }> }) {
  try {
    const actor = await requireApiSession(request);
    const params = await context.params;
    const url = new URL(request.url);
    for (const key of new Set(url.searchParams.keys())) {
      if (url.searchParams.getAll(key).length !== 1) throw new ApiError(400, "INVALID_QUERY", `Query parameter ${key} must be unique`);
    }
    const query = querySchema.parse(Object.fromEntries(url.searchParams));
    const result = await listProjectDelegatedGitManualRuns(
      uuidSchema.parse(params.projectId),
      uuidSchema.parse(params.delegationId),
      query,
      actor,
    );
    return noStore(NextResponse.json(result));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
