import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { acknowledgeProjectDelegatedGitManualRun } from "@/lib/project-delegated-git-runtime-service";
import { z } from "zod";

export const dynamic = "force-dynamic";
const uuidSchema = z.string().uuid();

function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string; delegationId: string; runId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const params = await context.params;
    const result = await acknowledgeProjectDelegatedGitManualRun(
      uuidSchema.parse(params.projectId),
      uuidSchema.parse(params.delegationId),
      uuidSchema.parse(params.runId),
      await readJsonBody(request),
      actor,
    );
    return noStore(NextResponse.json(result));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
