import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import { getUnifiedQuestionRequest, stopUnifiedQuestionRequest, UNIFIED_QUESTION_ERROR_PRESENTATION, UnifiedQuestionError } from "@/lib/unified-question-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof UnifiedQuestionError) {
    const presentation = UNIFIED_QUESTION_ERROR_PRESENTATION[error.code];
    return noStore(NextResponse.json({ error: { code: error.code, message: presentation.message } }, { status: presentation.status }));
  }
  return noStore(handleApiError(error));
}

export async function GET(request: Request, context: { params: Promise<{ confirmationId: string }> }) {
  try {
    const actor = await requireApiSession(request);
    const { confirmationId } = await context.params;
    return noStore(NextResponse.json(await getUnifiedQuestionRequest(confirmationId, actor)));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request, context: { params: Promise<{ confirmationId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const input = await readJsonBody(request);
    if (typeof input !== "object" || input === null || Array.isArray(input)
      || Object.keys(input).length !== 1 || (input as Record<string, unknown>).action !== "stop") {
      throw new UnifiedQuestionError("UNIFIED_QUESTION_INVALID_INPUT");
    }
    const { confirmationId } = await context.params;
    return noStore(NextResponse.json(await stopUnifiedQuestionRequest(confirmationId, actor)));
  } catch (error) { return errorResponse(error); }
}
