import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import {
  getUnifiedQuestionConversation,
  updateUnifiedQuestionPresentation,
  UNIFIED_QUESTION_ERROR_PRESENTATION,
  UnifiedQuestionError,
} from "@/lib/unified-question-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "private, no-store");
  return response;
}

export async function PATCH(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const { conversationId } = await context.params;
    return noStore(NextResponse.json(await updateUnifiedQuestionPresentation(conversationId, await readJsonBody(request), actor)));
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof UnifiedQuestionError) {
    const presentation = UNIFIED_QUESTION_ERROR_PRESENTATION[error.code];
    return noStore(NextResponse.json({ error: { code: error.code, message: presentation.message } }, { status: presentation.status }));
  }
  return noStore(handleApiError(error));
}

export async function GET(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  try {
    const actor = await requireApiSession(request);
    const { conversationId } = await context.params;
    return noStore(NextResponse.json(await getUnifiedQuestionConversation(conversationId, actor)));
  } catch (error) {
    return errorResponse(error);
  }
}
