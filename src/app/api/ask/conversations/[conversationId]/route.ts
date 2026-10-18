import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import {
  getUnifiedQuestionConversation,
  UNIFIED_QUESTION_ERROR_PRESENTATION,
  UnifiedQuestionError,
} from "@/lib/unified-question-service";

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

export async function GET(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  try {
    const actor = await requireApiSession(request);
    const { conversationId } = await context.params;
    return noStore(NextResponse.json(await getUnifiedQuestionConversation(conversationId, actor)));
  } catch (error) {
    return errorResponse(error);
  }
}
