import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { putProjectAiEffectiveRouteSelection } from "@/lib/project-ai-provider-delegation-service";

export const dynamic = "force-dynamic";
const uuidSchema = z.string().uuid();

export async function PUT(
  request: Request,
  context: { params: Promise<{ projectId: string; operation: string }> },
) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const params = await context.params;
    const result = await putProjectAiEffectiveRouteSelection(
      uuidSchema.parse(params.projectId),
      params.operation,
      await readJsonBody(request),
      actor,
    );
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
