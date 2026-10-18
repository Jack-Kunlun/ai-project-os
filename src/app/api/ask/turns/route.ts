import { NextResponse } from "next/server";
import { assertSameOrigin, requireApiSession } from "@/lib/auth";
import { handleApiError, readJsonBody } from "@/lib/api-response";
import {
  executeUnifiedQuestion,
  prepareUnifiedQuestion,
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

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireApiSession(request);
    const input = await readJsonBody(request);
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      const code = "UNIFIED_QUESTION_INVALID_INPUT" as const;
      return noStore(NextResponse.json({ error: { code, message: UNIFIED_QUESTION_ERROR_PRESENTATION[code].message } }, { status: 400 }));
    }
    const record = input as Record<string, unknown>;
    const result = record.phase === "prepare"
      ? await prepareUnifiedQuestion(record, actor)
      : record.phase === "execute"
        ? await executeUnifiedQuestion(record, actor)
        : (() => { throw new UnifiedQuestionError("UNIFIED_QUESTION_INVALID_INPUT"); })();
    return noStore(NextResponse.json(result));
  } catch (error) {
    return errorResponse(error);
  }
}
