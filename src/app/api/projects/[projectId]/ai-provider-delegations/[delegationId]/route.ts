import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import { getProjectAiProviderDelegation } from "@/lib/project-ai-provider-delegation-service";

export const dynamic = "force-dynamic";

const uuidSchema = z.string().uuid();

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; delegationId: string }> },
) {
  try {
    const actor = await requireApiSession(request);
    const params = await context.params;
    const result = await getProjectAiProviderDelegation(
      uuidSchema.parse(params.projectId),
      uuidSchema.parse(params.delegationId),
      actor,
    );
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
