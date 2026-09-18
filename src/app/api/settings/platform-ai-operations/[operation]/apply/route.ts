import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { applyPlatformAiOperation, parsePlatformAiOperationApplyInput } from "@/lib/platform-ai-operation-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ operation: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const { operation } = await context.params;
    const input = parsePlatformAiOperationApplyInput({ ...(await readJsonBody(request) as Record<string, unknown>), operation });
    return NextResponse.json(await applyPlatformAiOperation(input, actor), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const response = handleApiError(error);
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
