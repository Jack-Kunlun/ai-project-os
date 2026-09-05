import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { runProjectDelegatedGitManualSync } from "@/lib/project-delegated-git-runtime-service";

export const dynamic = "force-dynamic";
const uuidSchema = z.string().uuid();

export async function POST(request: Request, context: { params: Promise<{ projectId: string; delegationId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const params = await context.params;
    const result = await runProjectDelegatedGitManualSync({
      projectId: uuidSchema.parse(params.projectId),
      delegationId: uuidSchema.parse(params.delegationId),
      request: await readJsonBody(request),
      actor,
    });
    return NextResponse.json(result, { status: result.status === "succeeded" ? 200 : 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
