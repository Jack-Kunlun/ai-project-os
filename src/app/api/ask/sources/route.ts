import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/auth";
import { handleApiError } from "@/lib/api-response";
import {
  getUnifiedQuestionSources,
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

export async function GET(request: Request) {
  try {
    const actor = await requireApiSession(request);
    const query = new URL(request.url).searchParams;
    return noStore(NextResponse.json(await getUnifiedQuestionSources({
      scope: query.get("scope"),
      ...(query.has("projectId") ? { projectId: query.get("projectId") } : {}),
      ...(query.has("focusDocumentId") ? { focusDocumentId: query.get("focusDocumentId") } : {}),
    }, actor)));
  } catch (error) {
    return errorResponse(error);
  }
}
