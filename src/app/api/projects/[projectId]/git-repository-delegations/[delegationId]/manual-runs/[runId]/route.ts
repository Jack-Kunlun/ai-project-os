import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { getProjectDelegatedGitManualRunDetail } from "@/lib/project-delegated-git-runtime-service";

export const dynamic = "force-dynamic";
const uuidSchema = z.string().uuid();

function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string; delegationId: string; runId: string }> }) {
  try {
    const actor = await requireApiSession(request);
    const params = await context.params;
    const result = await getProjectDelegatedGitManualRunDetail(
      uuidSchema.parse(params.projectId),
      uuidSchema.parse(params.delegationId),
      uuidSchema.parse(params.runId),
      actor,
    );
    return noStore(NextResponse.json(result));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
