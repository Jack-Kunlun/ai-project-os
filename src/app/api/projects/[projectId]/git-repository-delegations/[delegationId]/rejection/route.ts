import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { rejectProjectGitRepositoryDelegation } from "@/lib/project-git-repository-delegation-service";

export const dynamic = "force-dynamic";
const uuidSchema = z.string().uuid();

function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string; delegationId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const params = await context.params;
    const result = await rejectProjectGitRepositoryDelegation(
      uuidSchema.parse(params.projectId),
      uuidSchema.parse(params.delegationId),
      await readJsonBody(request),
      actor,
    );
    return noStore(NextResponse.json(result));
  } catch (error) {
    return noStore(handleApiError(error));
  }
}
